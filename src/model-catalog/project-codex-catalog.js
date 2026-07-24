'use strict';

const TOOL_CAPABILITY_FIELDS = [
  'apply_patch_tool_type',
  'supports_parallel_tool_calls',
  'supports_search_tool',
  'shell_type',
  'web_search_tool_type',
  'use_responses_lite',
];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function applyDiscoveredMetadata(catalogModels, discoveredModels) {
  const discovered = new Map((Array.isArray(discoveredModels) ? discoveredModels : [])
    .filter((model) => model && typeof model.id === 'string')
    .map((model) => [model.id, model]));
  for (const entry of Array.isArray(catalogModels) ? catalogModels : []) {
    if (!entry) continue;
    const metadata = discovered.get(entry.slug) || discovered.get(entry.display_name);
    if (!metadata) continue;
    if (Array.isArray(metadata.inputModalities) && metadata.inputModalities.length > 0) {
      entry.input_modalities = [...metadata.inputModalities];
      entry.supports_image_detail_original = metadata.inputModalities.includes('image');
    }
    if (Array.isArray(metadata.outputModalities) && metadata.outputModalities.length > 0) {
      entry.output_modalities = [...metadata.outputModalities];
    }
    if (Array.isArray(metadata.reasoningLevels) && metadata.reasoningLevels.length > 0) {
      entry.supported_reasoning_levels = [...metadata.reasoningLevels];
      if (!metadata.reasoningLevels.includes(entry.default_reasoning_level)) {
        entry.default_reasoning_level = null;
      }
    }
    if (Number.isSafeInteger(metadata.contextWindow) && metadata.contextWindow > 0) {
      entry.context_window = metadata.contextWindow;
      entry.max_context_window = metadata.contextWindow;
    }
  }
  return catalogModels;
}

function nativeCapabilitiesFromDiscovery(discovery, imageModel) {
  const models = discovery && Array.isArray(discovery.models) ? discovery.models : [];
  const isOllama = Boolean(discovery && discovery.provider === 'ollama');
  const visionCapable = new Set();
  const imageOutputCapable = new Set();
  const toolCalling = new Map();
  for (const model of models) {
    if (!model || typeof model.id !== 'string') continue;
    if (Array.isArray(model.inputModalities) && model.inputModalities.includes('image')) {
      visionCapable.add(model.id);
    }
    if (Array.isArray(model.outputModalities) && model.outputModalities.includes('image')) {
      imageOutputCapable.add(model.id);
    }
    if (typeof model.toolCalling === 'boolean') toolCalling.set(model.id, model.toolCalling);
  }
  if (imageModel) visionCapable.add(imageModel);
  return { isOllama, visionCapable, imageOutputCapable, toolCalling };
}

function applyCapabilities(model, options) {
  const lookupIds = [model.slug, model.display_name].filter(Boolean);
  const nativeToolCalling = lookupIds
    .map((id) => options.toolCalling.get(id))
    .find((value) => typeof value === 'boolean');
  model.apply_patch_tool_type = options.canonical.apply_patch_tool_type;
  model.supports_parallel_tool_calls = typeof nativeToolCalling === 'boolean'
    ? nativeToolCalling
    : options.canonical.supports_parallel_tool_calls;
  model.supports_search_tool = options.canonical.supports_search_tool;
  model.shell_type = options.canonical.shell_type;
  model.web_search_tool_type = options.canonical.web_search_tool_type;
  model.use_responses_lite = options.canonical.use_responses_lite;

  const hasVision = lookupIds.some((id) => options.visionCapable.has(id));
  model.input_modalities = hasVision ? ['text', 'image'] : ['text'];
  model.supports_image_detail_original = hasVision;
  model.supports_reasoning_summary_parameter = true;
  model.default_reasoning_summary = 'auto';
}

function toolCapabilitySnapshot(model) {
  return Object.fromEntries(TOOL_CAPABILITY_FIELDS.map((key) => [key, model[key]]));
}

function projectCodexCatalog(options) {
  const discovery = options.discovery || null;
  const discoveredModels = discovery && Array.isArray(discovery.models) ? discovery.models : [];
  const knownIds = options.knownIds instanceof Set ? options.knownIds : new Set(options.knownIds || []);
  const original = Array.isArray(options.existingModels) ? options.existingModels : [];
  const template = original.length ? clone(original[0]) : {};
  const native = nativeCapabilitiesFromDiscovery(discovery, options.imageModel);
  const capabilityOptions = {
    ...native,
    canonical: options.canonical,
    imageModel: options.imageModel,
  };
  let pruned = 0;
  let changed = 0;
  const models = clone(original).filter((model) => {
    if (!model || !model.slug) return false;
    if (knownIds.has(model.slug) || knownIds.has(model.display_name)) return true;
    pruned += 1;
    return false;
  });

  for (const model of models) {
    const before = toolCapabilitySnapshot(model);
    applyCapabilities(model, capabilityOptions);
    if (JSON.stringify(before) !== JSON.stringify(toolCapabilitySnapshot(model))) changed += 1;
  }

  const existingSlugs = new Set(models.map((model) => model && model.slug).filter(Boolean));
  const added = [];
  for (const id of knownIds) {
    if (existingSlugs.has(id)) continue;
    const model = clone(template);
    model.slug = id;
    model.display_name = id;
    model.description = native.isOllama ? 'Ollama local model' : 'Upstream model';
    applyCapabilities(model, capabilityOptions);
    models.push(model);
    added.push(id);
    existingSlugs.add(id);
  }

  applyDiscoveredMetadata(models, discoveredModels);
  const defaultIndex = models.findIndex((model) => model
    && (model.slug === options.defaultModel || model.display_name === options.defaultModel));
  if (defaultIndex > 0) models.unshift(models.splice(defaultIndex, 1)[0]);
  models.forEach((model, index) => { model.priority = index + 1; });
  const localModelIds = native.isOllama
    ? discoveredModels
      .filter((model) => model.source === 'ollama-show' || model.source === 'ollama-tags')
      .map((model) => model.id)
      .sort()
    : [];

  return {
    models,
    isOllama: native.isOllama,
    visionCapable: native.visionCapable,
    imageOutputCapable: native.imageOutputCapable,
    toolCalling: native.toolCalling,
    localModelIds,
    added,
    changed,
    pruned,
  };
}

module.exports = {
  applyDiscoveredMetadata,
  nativeCapabilitiesFromDiscovery,
  projectCodexCatalog,
};
