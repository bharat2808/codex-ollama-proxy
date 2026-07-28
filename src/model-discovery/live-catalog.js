'use strict';

const { discoveryError } = require('./errors');

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const MAX_REDIRECTS = 5;

function linkedAbortSignal(callerSignal, controller) {
  if (!callerSignal) return { signal: controller.signal, cleanup() {} };
  if (callerSignal.aborted) controller.abort(callerSignal.reason);
  const onAbort = () => controller.abort(callerSignal.reason);
  callerSignal.addEventListener('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    cleanup() { callerSignal.removeEventListener('abort', onAbort); },
  };
}

async function readLimitedText(response, maxBytes, provider) {
  const lengthHeader = response.headers && response.headers.get
    ? response.headers.get('content-length')
    : null;
  const declaredLength = lengthHeader === null ? NaN : Number(lengthHeader);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw discoveryError('RESPONSE_TOO_LARGE', provider, 'Provider catalog response exceeded the size limit.');
  }

  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel();
          throw discoveryError('RESPONSE_TOO_LARGE', provider, 'Provider catalog response exceeded the size limit.');
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks, size).toString('utf8');
  }

  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw discoveryError('RESPONSE_TOO_LARGE', provider, 'Provider catalog response exceeded the size limit.');
  }
  return text;
}

function validateFetchUrl(rawUrl, options) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch (error) {
    throw discoveryError('INVALID_URL', options.provider, 'Provider catalog URL is invalid.', error);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw discoveryError('INVALID_URL', options.provider, 'Provider catalog URL must use HTTP or HTTPS.');
  }
  if (options.requireHttps && url.protocol !== 'https:') {
    throw discoveryError('INVALID_URL', options.provider, 'Provider catalog URL must use HTTPS.');
  }
  if (options.allowedHostname && url.hostname !== options.allowedHostname) {
    throw discoveryError('INVALID_URL', options.provider, 'Provider catalog hostname is not allowed.');
  }
  return url;
}

async function fetchJson(options) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw discoveryError('FETCH_UNAVAILABLE', options.provider, 'No fetch implementation is available.');
  }
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_TIMEOUT_MS;
  const maxBytes = Number.isInteger(options.maxBytes) && options.maxBytes > 0
    ? options.maxBytes
    : DEFAULT_MAX_BYTES;
  const controller = new AbortController();
  const linked = linkedAbortSignal(options.signal, controller);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let url = validateFetchUrl(options.url, options);
  let includeAuthorization = Boolean(options.apiKey);
  let includeAuthHeaders = Boolean(options.authHeaders);

  try {
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      const headers = {
        Accept: 'application/json',
        ...(options.headers || {}),
        ...(includeAuthHeaders ? options.authHeaders : {}),
      };
      if (includeAuthorization) headers.Authorization = `Bearer ${options.apiKey}`;
      let response;
      try {
        response = await fetchImpl(url.href, {
          method: options.method || 'GET',
          headers,
          body: options.body,
          redirect: 'manual',
          signal: linked.signal,
        });
      } catch (error) {
        if (options.signal && options.signal.aborted) {
          throw discoveryError('CANCELLED', options.provider, 'Provider catalog request was cancelled.', error);
        }
        if (controller.signal.aborted) {
          throw discoveryError('TIMEOUT', options.provider, 'Provider catalog request timed out.', error);
        }
        throw discoveryError('NETWORK', options.provider, 'Provider catalog request failed.', error);
      }

      if (response.status >= 300 && response.status < 400) {
        if (redirects === MAX_REDIRECTS) {
          throw discoveryError('REDIRECT_LIMIT', options.provider, 'Provider catalog redirected too many times.');
        }
        const location = response.headers && response.headers.get
          ? response.headers.get('location')
          : null;
        if (!location) throw discoveryError('HTTP', options.provider, 'Provider catalog returned an invalid redirect.');
        const nextUrl = validateFetchUrl(new URL(location, url).href, options);
        if (nextUrl.origin !== url.origin) {
          includeAuthorization = false;
          includeAuthHeaders = false;
        }
        url = nextUrl;
        continue;
      }

      if (!response.ok) {
        throw discoveryError('HTTP', options.provider, `Provider catalog returned HTTP ${response.status}.`);
      }
      const text = await readLimitedText(response, maxBytes, options.provider);
      try {
        return JSON.parse(text);
      } catch (error) {
        throw discoveryError('INVALID_JSON', options.provider, 'Provider catalog returned invalid JSON.', error);
      }
    }
    throw discoveryError('REDIRECT_LIMIT', options.provider, 'Provider catalog redirected too many times.');
  } catch (error) {
    if (error && error.code) throw error;
    if (options.signal && options.signal.aborted) {
      throw discoveryError('CANCELLED', options.provider, 'Provider catalog request was cancelled.', error);
    }
    if (controller.signal.aborted) {
      throw discoveryError('TIMEOUT', options.provider, 'Provider catalog request timed out.', error);
    }
    throw discoveryError('NETWORK', options.provider, 'Provider catalog request failed.', error);
  } finally {
    clearTimeout(timer);
    linked.cleanup();
  }
}

module.exports = {
  DEFAULT_MAX_BYTES,
  DEFAULT_TIMEOUT_MS,
  fetchJson,
};
