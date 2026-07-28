'use strict';

const EMBEDDING_MODEL_ID_PATTERN =
  /(?:^|[/_:.-])embed(?:ding)?s?(?:$|[/_:.-])/iu;

// Each base model below returned a definitive incompatibility from either the
// Responses text probe or the required strict function-tool probe. New model
// IDs remain discoverable until they produce the same evidence.
const INCOMPATIBLE_BASE_MODEL_IDS = new Set([
  'babbage-002',
  'chatgpt-image-latest',
  'codex-auto-review',
  'computer-use-preview',
  'computer-use-preview-2025-03-11',
  'davinci-002',
  'gpt-3.5-turbo-16k',
  'gpt-3.5-turbo-instruct',
  'gpt-3.5-turbo-instruct-0914',
  'gpt-4o-mini-search-preview',
  'gpt-4o-mini-search-preview-2025-03-11',
  'gpt-4o-mini-transcribe',
  'gpt-4o-mini-transcribe-2025-03-20',
  'gpt-4o-mini-transcribe-2025-12-15',
  'gpt-4o-mini-tts',
  'gpt-4o-mini-tts-2025-03-20',
  'gpt-4o-mini-tts-2025-12-15',
  'gpt-4o-search-preview',
  'gpt-4o-search-preview-2025-03-11',
  'gpt-4o-transcribe',
  'gpt-4o-transcribe-diarize',
  'gpt-5-chat-latest',
  'gpt-5-codex',
  'gpt-5-search-api',
  'gpt-5-search-api-2025-10-14',
  'gpt-5.1-chat-latest',
  'gpt-5.1-codex',
  'gpt-5.1-codex-max',
  'gpt-5.1-codex-mini',
  'gpt-5.2-codex',
  'gpt-5.3-codex-spark',
  'gpt-audio',
  'gpt-audio-1.5',
  'gpt-audio-2025-08-28',
  'gpt-audio-mini',
  'gpt-audio-mini-2025-10-06',
  'gpt-audio-mini-2025-12-15',
  'gpt-image-1',
  'gpt-image-1-mini',
  'gpt-image-1.5',
  'gpt-image-2',
  'gpt-image-2-2026-04-21',
  'gpt-realtime',
  'gpt-realtime-1.5',
  'gpt-realtime-2',
  'gpt-realtime-2.1',
  'gpt-realtime-2.1-mini',
  'gpt-realtime-2025-08-28',
  'gpt-realtime-mini',
  'gpt-realtime-mini-2025-10-06',
  'gpt-realtime-mini-2025-12-15',
  'gpt-realtime-translate',
  'gpt-realtime-whisper',
  'o3-deep-research',
  'o3-deep-research-2025-06-26',
  'o4-mini-deep-research',
  'o4-mini-deep-research-2025-06-26',
  'omni-moderation-2024-09-26',
  'omni-moderation-latest',
  'sora-2',
  'sora-2-pro',
  'tts-1',
  'tts-1-1106',
  'tts-1-hd',
  'tts-1-hd-1106',
  'whisper-1',
]);

function baseModelId(id) {
  if (typeof id !== 'string') return null;
  const fineTune = id.match(/^ft:([^:]+):/u);
  return fineTune ? fineTune[1] : id;
}

function isCodexUsableModelId(id) {
  const base = baseModelId(id);
  return base !== null
    && !EMBEDDING_MODEL_ID_PATTERN.test(base)
    && !INCOMPATIBLE_BASE_MODEL_IDS.has(base);
}

function filterCodexUsableModels(models) {
  return (Array.isArray(models) ? models : [])
    .filter((model) => model && isCodexUsableModelId(model.id));
}

module.exports = {
  filterCodexUsableModels,
  isCodexUsableModelId,
};
