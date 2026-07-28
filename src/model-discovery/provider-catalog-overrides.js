'use strict';

const GOOGLE_GEMMA4_REASONING = Object.freeze({
  reasoning: true,
  reasoningLevels: Object.freeze(['minimal', 'high']),
  reasoningDefaultEnabled: false,
  reasoningSupportsMaxTokens: false,
  reasoningMandatory: false,
});

const OLLAMA_GEMMA4_REASONING = Object.freeze({
  reasoning: true,
  reasoningLevels: Object.freeze(['none', 'low', 'medium', 'high', 'max']),
});

function openAiReasoningEntries(ids, levels, defaultReasoningLevel = 'medium') {
  const reasoningLevels = Object.freeze([...levels]);
  const override = Object.freeze({
    reasoning: true,
    reasoningLevels,
    defaultReasoningLevel,
    reasoningDefaultEnabled: defaultReasoningLevel !== 'none',
    reasoningMandatory: !reasoningLevels.includes('none'),
  });
  return ids.map((id) => [id, override]);
}

const OPENAI_DEFAULT_REASONING = Object.freeze({
  reasoning: false,
  reasoningDefaultEnabled: false,
  reasoningMandatory: false,
});

const OPENAI_REASONING_OVERRIDES = Object.freeze(Object.fromEntries([
  ...openAiReasoningEntries([
    'o1-2024-12-17',
    'o1',
    'o3-mini',
    'o3-mini-2025-01-31',
    'o1-pro-2025-03-19',
    'o1-pro',
    'o3-2025-04-16',
    'o4-mini-2025-04-16',
    'o3',
    'o4-mini',
    'o3-pro',
    'o3-pro-2025-06-10',
  ], ['low', 'medium', 'high']),
  ...openAiReasoningEntries([
    'gpt-5-2025-08-07',
    'gpt-5',
    'gpt-5-mini-2025-08-07',
    'gpt-5-mini',
    'gpt-5-nano-2025-08-07',
    'gpt-5-nano',
  ], ['minimal', 'low', 'medium', 'high']),
  ...openAiReasoningEntries([
    'gpt-5-pro-2025-10-06',
    'gpt-5-pro',
  ], ['high'], 'high'),
  ...openAiReasoningEntries([
    'gpt-5.1-2025-11-13',
    'gpt-5.1',
  ], ['none', 'low', 'medium', 'high']),
  ...openAiReasoningEntries([
    'gpt-5.2-2025-12-11',
    'gpt-5.2',
    'gpt-5.3-codex',
    'gpt-5.4-2026-03-05',
    'gpt-5.4',
    'gpt-5.4-nano-2026-03-17',
    'gpt-5.4-nano',
    'gpt-5.4-mini-2026-03-17',
    'gpt-5.4-mini',
    'gpt-5.5',
    'gpt-5.5-2026-04-23',
  ], ['none', 'low', 'medium', 'high', 'xhigh']),
  ...openAiReasoningEntries([
    'gpt-5.2-pro-2025-12-11',
    'gpt-5.2-pro',
    'gpt-5.4-pro',
    'gpt-5.4-pro-2026-03-05',
    'gpt-5.5-pro',
    'gpt-5.5-pro-2026-04-23',
  ], ['medium', 'high', 'xhigh']),
  ...openAiReasoningEntries([
    'gpt-5.2-chat-latest',
    'gpt-5.3-chat-latest',
    'chat-latest',
    'o4-mini-deep-research',
    'o4-mini-deep-research-2025-06-26',
  ], ['medium']),
  ...openAiReasoningEntries([
    'gpt-5.6-sol',
  ], ['none', 'low', 'medium', 'high', 'xhigh', 'max'], 'low'),
  ...openAiReasoningEntries([
    'gpt-5.6-terra',
    'gpt-5.6-luna',
  ], ['none', 'low', 'medium', 'high', 'xhigh', 'max']),
]));

const CODEX_CATALOG_OVERRIDES = Object.freeze({
  openai: Object.freeze({
    default_reasoning_summary: 'auto',
    use_responses_lite: false,
  }),
});

const DOCUMENTED_MODALITIES = Object.freeze({
  cohere: Object.freeze({
    'command-a-03-2025': Object.freeze({
      inputModalities: Object.freeze(['text']),
      outputModalities: Object.freeze(['text']),
    }),
    'command-a-plus-05-2026': Object.freeze({
      inputModalities: Object.freeze(['text', 'image']),
      outputModalities: Object.freeze(['text']),
      reasoning: true,
      reasoningDefaultEnabled: true,
      reasoningSupportsMaxTokens: true,
      reasoningMandatory: false,
      toolCalling: true,
    }),
    'command-a-reasoning-08-2025': Object.freeze({
      inputModalities: Object.freeze(['text']),
      outputModalities: Object.freeze(['text']),
      reasoning: true,
      reasoningDefaultEnabled: true,
      reasoningSupportsMaxTokens: true,
      reasoningMandatory: false,
    }),
    'command-a-vision-07-2025': Object.freeze({
      inputModalities: Object.freeze(['text', 'image']),
      outputModalities: Object.freeze(['text']),
      toolCalling: false,
    }),
    'north-mini-code-1-0': Object.freeze({
      inputModalities: Object.freeze(['text', 'image']),
      outputModalities: Object.freeze(['text']),
      reasoning: true,
      reasoningDefaultEnabled: true,
      reasoningSupportsMaxTokens: true,
      reasoningMandatory: false,
    }),
  }),
  google: Object.freeze({
    'gemma-4-26b-a4b-it': Object.freeze({
      ...GOOGLE_GEMMA4_REASONING,
    }),
    'gemma-4-31b-it': Object.freeze({
      ...GOOGLE_GEMMA4_REASONING,
    }),
    'gemini-2.5-flash': Object.freeze({
      reasoning: true,
      reasoningLevels: Object.freeze(['none', 'minimal', 'low', 'medium', 'high']),
      reasoningDefaultEnabled: true,
      reasoningSupportsMaxTokens: true,
      reasoningMandatory: false,
    }),
    'gemini-2.5-flash-lite': Object.freeze({
      reasoning: true,
      reasoningLevels: Object.freeze(['none', 'minimal', 'low', 'medium', 'high']),
      defaultReasoningLevel: 'none',
      reasoningDefaultEnabled: false,
      reasoningSupportsMaxTokens: true,
      reasoningMandatory: false,
    }),
    'gemini-2.5-pro': Object.freeze({
      reasoning: true,
      reasoningLevels: Object.freeze(['minimal', 'low', 'medium', 'high']),
      reasoningDefaultEnabled: true,
      reasoningSupportsMaxTokens: true,
      reasoningMandatory: true,
    }),
    'gemini-3-pro-preview': Object.freeze({
      reasoning: true,
      reasoningLevels: Object.freeze(['low', 'high']),
      defaultReasoningLevel: 'high',
      reasoningDefaultEnabled: true,
      reasoningSupportsMaxTokens: false,
      reasoningMandatory: true,
    }),
    'gemini-pro-latest': Object.freeze({
      reasoning: true,
      reasoningLevels: Object.freeze(['low', 'medium', 'high']),
      defaultReasoningLevel: 'high',
      reasoningDefaultEnabled: true,
      reasoningSupportsMaxTokens: false,
      reasoningMandatory: true,
    }),
  }),
  nvidia: Object.freeze({
    'deepseek-ai/deepseek-v4-pro': Object.freeze({
      inputModalities: Object.freeze(['text']),
      outputModalities: Object.freeze(['text']),
      reasoning: true,
      reasoningLevels: Object.freeze(['none', 'high', 'max']),
      defaultReasoningLevel: 'high',
      reasoningDefaultEnabled: true,
      reasoningSupportsMaxTokens: false,
      reasoningMandatory: false,
      toolCalling: true,
    }),
    'minimaxai/minimax-m3': Object.freeze({
      inputModalities: Object.freeze(['text', 'image', 'video']),
      outputModalities: Object.freeze(['text']),
      reasoning: true,
      toolCalling: true,
    }),
  }),
  openai: OPENAI_REASONING_OVERRIDES,
  'ollama-cloud': Object.freeze(Object.fromEntries([
    'gemma4:31b-cloud',
    'glm-5.2:cloud',
    'kimi-k2.7-code:cloud',
    'minimax-m2.7:cloud',
    'nemotron-3-ultra:cloud',
  ].map((id) => [id, Object.freeze({
    reasoning: true,
    reasoningLevels: Object.freeze(['none', 'low', 'medium', 'high', 'max']),
  })]))),
  xai: Object.freeze({
    'grok-4.5': Object.freeze({
      reasoningLevels: Object.freeze(['low', 'medium', 'high']),
      defaultReasoningLevel: 'high',
    }),
    'grok-4.20-0309-non-reasoning': Object.freeze({
      inputModalities: Object.freeze(['text', 'image']),
      outputModalities: Object.freeze(['text']),
      reasoning: false,
      reasoningDefaultEnabled: false,
      reasoningSupportsMaxTokens: false,
      reasoningMandatory: false,
    }),
    'grok-4.20-0309-reasoning': Object.freeze({
      inputModalities: Object.freeze(['text', 'image']),
      outputModalities: Object.freeze(['text']),
      reasoning: true,
      reasoningDefaultEnabled: true,
      reasoningSupportsMaxTokens: false,
      reasoningMandatory: true,
    }),
    'grok-build-0.1': Object.freeze({
      inputModalities: Object.freeze(['text', 'image']),
      outputModalities: Object.freeze(['text']),
      reasoning: true,
      reasoningDefaultEnabled: true,
      reasoningSupportsMaxTokens: false,
      reasoningMandatory: true,
      toolCalling: true,
    }),
    'grok-imagine-image': Object.freeze({
      inputModalities: Object.freeze(['text', 'image']),
      outputModalities: Object.freeze(['image']),
    }),
    'grok-imagine-image-quality': Object.freeze({
      inputModalities: Object.freeze(['text', 'image']),
      outputModalities: Object.freeze(['image']),
    }),
    'grok-imagine-video': Object.freeze({
      inputModalities: Object.freeze(['text', 'image', 'video']),
      outputModalities: Object.freeze(['video']),
    }),
    'grok-imagine-video-1.5': Object.freeze({
      inputModalities: Object.freeze(['image']),
      outputModalities: Object.freeze(['video']),
    }),
  }),
});

function applyDocumentedModalities(provider, model) {
  let familyOverride = null;
  if (provider === 'openai') {
    familyOverride = OPENAI_DEFAULT_REASONING;
  } else if (provider === 'google' && /^gemma-4-/u.test(model.id)) {
    familyOverride = GOOGLE_GEMMA4_REASONING;
  } else if ((provider === 'ollama' || provider === 'ollama-cloud')
    && /^gemma4(?::|$)/u.test(model.id)) {
    familyOverride = OLLAMA_GEMMA4_REASONING;
  }
  const documented = DOCUMENTED_MODALITIES[provider]?.[model.id] || familyOverride;
  if (!documented) return model;
  const enriched = { ...model, metadataSources: { ...model.metadataSources } };
  for (const field of [
    'inputModalities',
    'outputModalities',
    'reasoning',
    'reasoningLevels',
    'defaultReasoningLevel',
    'reasoningDefaultEnabled',
    'reasoningSupportsMaxTokens',
    'reasoningMandatory',
    'toolCalling',
  ]) {
    if (!(field in documented)) continue;
    enriched[field] = Array.isArray(documented[field])
      ? [...documented[field]]
      : documented[field];
    enriched.metadataSources[field] = 'provider-catalog';
  }
  return enriched;
}

function applyCodexCatalogOverrides(provider, model) {
  const overrides = CODEX_CATALOG_OVERRIDES[provider];
  return overrides ? Object.assign(model, overrides) : model;
}

module.exports = {
  applyCodexCatalogOverrides,
  applyDocumentedModalities,
};
