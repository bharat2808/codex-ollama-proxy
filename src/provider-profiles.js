'use strict';

const PROFILES = Object.freeze({
  aistudio: Object.freeze({
    aliases: Object.freeze(['google', 'gemini', 'google-ai-studio']),
    url: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultAdaptor: 'google',
    adaptors: Object.freeze(['google']),
  }),
  vertexai: Object.freeze({
    aliases: Object.freeze(['vertex', 'vertex-ai']),
    defaultAdaptor: 'google',
    adaptors: Object.freeze(['google']),
  }),
  nvidia: Object.freeze({
    aliases: Object.freeze([]),
    url: 'https://integrate.api.nvidia.com/v1',
    defaultAdaptor: 'chat-completion',
    adaptors: Object.freeze(['chat-completion']),
  }),
  openrouter: Object.freeze({
    aliases: Object.freeze([]),
    url: 'https://openrouter.ai/api/v1',
    defaultAdaptor: 'none',
    adaptors: Object.freeze(['none', 'chat-completion']),
  }),
  anthropic: Object.freeze({
    aliases: Object.freeze(['claude']),
    url: 'https://api.anthropic.com/v1',
    defaultAdaptor: 'chat-completion',
    adaptors: Object.freeze(['chat-completion']),
  }),
  openai: Object.freeze({
    aliases: Object.freeze([]),
    url: 'https://api.openai.com/v1',
    defaultAdaptor: 'none',
    adaptors: Object.freeze(['none']),
  }),
  cohere: Object.freeze({
    aliases: Object.freeze([]),
    url: 'https://api.cohere.ai/compatibility/v1',
    defaultAdaptor: 'chat-completion',
    adaptors: Object.freeze(['chat-completion']),
  }),
  zai: Object.freeze({
    aliases: Object.freeze(['z-ai', 'z.ai']),
    url: 'https://api.z.ai/api/paas/v4',
    defaultAdaptor: 'chat-completion',
    adaptors: Object.freeze(['chat-completion']),
  }),
  moonshot: Object.freeze({
    aliases: Object.freeze(['kimi']),
    url: 'https://api.moonshot.ai/v1',
    defaultAdaptor: 'chat-completion',
    adaptors: Object.freeze(['chat-completion']),
  }),
  deepseek: Object.freeze({
    aliases: Object.freeze([]),
    url: 'https://api.deepseek.com',
    defaultAdaptor: 'chat-completion',
    adaptors: Object.freeze(['chat-completion']),
  }),
  xai: Object.freeze({
    aliases: Object.freeze(['grok']),
    url: 'https://api.x.ai/v1',
    defaultAdaptor: 'none',
    adaptors: Object.freeze(['none', 'chat-completion']),
  }),
  ollama: Object.freeze({
    aliases: Object.freeze([]),
    url: 'http://127.0.0.1:11434/v1',
    defaultAdaptor: 'none',
    adaptors: Object.freeze(['none', 'chat-completion']),
  }),
});

const ALIASES = new Map();
for (const [name, profile] of Object.entries(PROFILES)) {
  ALIASES.set(name, name);
  for (const alias of profile.aliases) ALIASES.set(alias, name);
}

function fail(message) {
  const error = new Error(message);
  error.isCliError = true;
  throw error;
}

function validUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function vertexSegment(value, flag) {
  const normalized = String(value || '').trim();
  if (!normalized) fail(`Error: --${flag} is required for provider vertexai.`);
  if (!/^[A-Za-z0-9._~-]+$/u.test(normalized)) {
    fail(`Error: --${flag} contains characters that cannot be used in a Vertex AI endpoint.`);
  }
  return normalized;
}

function resolveProviderProfile(options = {}) {
  const requested = String(options.provider || '').trim().toLowerCase();
  const provider = requested ? ALIASES.get(requested) : null;
  if (requested && !provider) {
    fail(`Error: unknown provider "${options.provider}". Known providers: ${Object.keys(PROFILES).join(', ')}.`);
  }

  if (!provider) {
    const adaptor = options.adaptor || 'none';
    if (!options.url) fail('Error: a custom provider requires --url URL.');
    if (!validUrl(options.url)) fail('Error: --url must be an absolute http(s) URL.');
    return { provider: null, adaptor, url: options.url };
  }

  const profile = PROFILES[provider];
  const adaptor = options.adaptor || profile.defaultAdaptor;
  if (!profile.adaptors.includes(adaptor)) {
    fail(`Error: provider ${provider} does not support adaptor "${adaptor}". Supported: ${profile.adaptors.join(', ')}.`);
  }

  let url = options.url || profile.url;
  if (provider === 'vertexai') {
    const project = vertexSegment(options.project, 'project');
    const location = vertexSegment(options.location, 'location');
    if (!options.url) {
      url = `https://aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/endpoints/openapi`;
    }
  }
  if (!validUrl(url)) fail('Error: --url must be an absolute http(s) URL.');
  return { provider, adaptor, url };
}

module.exports = {
  PROFILES,
  resolveProviderProfile,
};
