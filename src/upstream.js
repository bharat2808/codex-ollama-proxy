'use strict';

const http = require('http');
const https = require('https');

const DEFAULT_UPSTREAM_URL = 'http://127.0.0.1:11434/v1';

function normalizeBaseUrl(value) {
  const raw = String(value || DEFAULT_UPSTREAM_URL).trim() || DEFAULT_UPSTREAM_URL;
  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('upstream_url must use http or https');
  }
  url.pathname = url.pathname.replace(/\/+$/u, '') || '/';
  url.search = '';
  url.hash = '';
  return url;
}

function createUpstream(url, apiKey) {
  const baseUrl = normalizeBaseUrl(url);
  return {
    baseUrl,
    apiKey: String(apiKey || '').trim(),
  };
}

function urlForClientPath(upstream, clientPath) {
  const baseUrl = upstream && upstream.baseUrl ? upstream.baseUrl : normalizeBaseUrl();
  const incoming = new URL(clientPath || '/v1/responses', 'http://127.0.0.1');
  const suffix = incoming.pathname.replace(/^\/v1\/?/u, '').replace(/^\/+/u, '');
  const out = new URL(baseUrl.href);
  const basePath = out.pathname.replace(/\/+$/u, '');
  out.pathname = suffix ? basePath + '/' + suffix : basePath;
  out.search = incoming.search;
  return out;
}

function responsesUrl(upstream) {
  return urlForClientPath(upstream, '/v1/responses');
}

function transport(url) {
  return url.protocol === 'https:' ? https : http;
}

function authHeaders(upstream) {
  return upstream && upstream.apiKey ? { authorization: 'Bearer ' + upstream.apiKey } : {};
}

function requestJson(upstream, body) {
  return new Promise((resolve, reject) => {
    const url = responsesUrl(upstream);
    const payload = JSON.stringify(body);
    const req = transport(url).request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      path: url.pathname + url.search,
      method: 'POST',
      headers: Object.assign({
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      }, authHeaders(upstream)),
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch {}
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(parsed == null ? data : parsed);
          return;
        }
        const msg = parsed && parsed.error ? parsed.error : (data || res.statusMessage);
        const error = new Error('HTTP ' + res.statusCode + ': ' + (typeof msg === 'object' ? JSON.stringify(msg) : msg));
        error.statusCode = res.statusCode;
        error.responseBody = data;
        reject(error);
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function displayUrl(upstream) {
  const url = upstream && upstream.baseUrl ? upstream.baseUrl : normalizeBaseUrl();
  return url.href.replace(/\/$/u, '');
}

module.exports = {
  DEFAULT_UPSTREAM_URL,
  authHeaders,
  createUpstream,
  displayUrl,
  requestJson,
  responsesUrl,
  transport,
  urlForClientPath,
};
