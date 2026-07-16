'use strict';

const IMAGE_BLOCK_TYPES = new Set(['input_image', 'output_image', 'image']);

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && typeof block === 'object' &&
      (block.type === 'input_text' || block.type === 'text'))
    .map((block) => String(block.text || ''))
    .filter(Boolean)
    .join('\n');
}

function itemText(item) {
  if (!item || typeof item !== 'object') return '';
  return contentText(item.content);
}

function userMessages(body) {
  if (!body || typeof body !== 'object') return [];
  if (typeof body.input === 'string') {
    return [{ index: -1, text: body.input }];
  }
  if (!Array.isArray(body.input)) return [];
  const messages = [];
  body.input.forEach((item, index) => {
    if (item && item.type === 'message' && item.role === 'user') {
      const text = itemText(item);
      if (text.trim()) messages.push({ index, text });
    }
  });
  return messages;
}

function requestHasImage(body) {
  if (!body || !Array.isArray(body.input)) return false;
  for (const item of body.input) {
    if (!item || typeof item !== 'object') continue;
    for (const value of [item.content, item.output]) {
      if (!Array.isArray(value)) continue;
      for (const block of value) {
        if (block && typeof block === 'object' && (
          IMAGE_BLOCK_TYPES.has(block.type) ||
          block.image_url ||
          block.file_id
        )) return true;
      }
    }
  }
  return false;
}

function normalizeRequestText(text) {
  let value = String(text || '');
  value = value.replace(/```[\s\S]*?```/g, ' ');
  value = value.replace(/`[^`\n]*`/g, ' ');
  value = value.replace(/^\s*>.*$/gm, ' ');
  value = value.replace(/^\s*(?:\{|\[|[A-Z][A-Z0-9_ -]*:|\d{4}-\d{2}-\d{2}T).*$/gm, ' ');
  value = value.replace(/(["']).*?\1/g, ' ');
  value = value.replace(/\b[\w./-]*(?:generate|draw|image)[\w./-]*\.(?:js|ts|json|log|txt)\b/gi, ' ');
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

const GENERATION_ACTION = '(?:create|generate|draw|render|illustrate|paint|design|produce)';
const IMAGE_NOUN = '(?:image|picture|illustration|artwork|poster|graphic|painting|photo)';

function isNegatedGeneration(text) {
  return [
    /\b(?:do not|don't|dont|never)\s+(?:create|generate|draw|render|illustrate|paint|design|make|produce)\b/,
    /\b(?:without|instead of)\s+(?:creating|generating|drawing|rendering|illustrating|painting|designing|making|producing)\b/,
    /\b(?:text only|use only text|no image|no picture)\b/,
    /\bnot asking (?:you )?to\s+(?:create|generate|draw|render|illustrate|paint|design|make|produce)\b/,
    /\b(?:do not|don't|dont)\s+make\s+(?:an?\s+)?(?:image|picture)\b/,
  ].some((pattern) => pattern.test(text));
}

function isImageUnderstandingRequest(text, hasImage) {
  if (/\b(?:describe|inspect|analy[sz]e|read|ocr|compare|summari[sz]e|identify|explain)\b.{0,50}\b(?:image|picture|photo|screenshot|diagram|visible ui)\b/.test(text)) {
    return true;
  }
  if (/\b(?:what is|what's|what do you see|what does).{0,50}\b(?:image|picture|photo|screenshot|diagram)\b/.test(text)) {
    return true;
  }
  if (/\b(?:extract|read)\s+(?:the\s+)?text\b/.test(text) && /\b(?:image|photo|screenshot|picture)\b/.test(text)) {
    return true;
  }
  return hasImage && (
    /^(?:what|which)\s+(?:folder|app|application|window|file|page)\b.*\b(?:open|visible|shown)\b/.test(text) ||
    /^(?:describe|inspect|analy[sz]e|read|compare|summari[sz]e|identify|explain)\b/.test(text) ||
    /^(?:what is this|what's this|what do you see)\??$/.test(text)
  );
}

function isExplicitGenerationRequest(text) {
  if (!text) return false;
  const requestPrefix = '^(?:please\\s+)?(?:(?:can|could|would|will)\\s+you\\s+(?:please\\s+)?)?';
  if (new RegExp(requestPrefix + '(?:draw|render|illustrate|paint)\\b').test(text)) return true;
  if (new RegExp(requestPrefix + 'design\\b.{0,60}\\b' + IMAGE_NOUN + '\\b').test(text)) return true;
  if (new RegExp(requestPrefix + '(?:create|generate|produce)\\b.{0,80}\\b' + IMAGE_NOUN + '\\b').test(text)) return true;
  if (new RegExp('^(?:please\\s+)?make\\s+(?:me\\s+)?(?:an?\\s+)?' + IMAGE_NOUN + '\\b').test(text)) return true;
  if (new RegExp('^i\\s+(?:want|need|would like)\\s+(?:you\\s+to\\s+)?(?:an?\\s+)?' + IMAGE_NOUN + '\\b').test(text)) return true;
  if (/^i\s+(?:want|need|would like)\s+(?:you\s+to\s+)?(?:draw|render|illustrate|paint)\b/.test(text)) return true;
  if (new RegExp('^i\\s+(?:want|need|would like)\\s+(?:you\\s+to\\s+)?' + GENERATION_ACTION + '\\b.{0,80}\\b' + IMAGE_NOUN + '\\b').test(text)) return true;
  if (new RegExp('^(?:show|give)\\s+me\\s+(?:an?\\s+)?(?:generated\\s+)?' + IMAGE_NOUN + '\\b').test(text)) return true;
  if (/^(?:turn|transform|convert)\b.{0,80}\binto\s+(?:an?\s+)?(?:image|picture|illustration)\b/.test(text)) return true;
  return /^(?:please\s+)?create\s+(?:a\s+)?variation\b.{0,80}\b(?:image|picture|illustration|one just generated)\b/.test(text);
}

function isGenerationFollowup(text) {
  return [
    /^(?:please\s+)?(?:make|create|generate)\s+(?:me\s+)?(?:another|a second|one more)\s+(?:one|image|picture|version)?\b/,
    /^(?:please\s+)?(?:make|create|generate)\s+(?:it\s+)?(?:a\s+)?(?:square|portrait|landscape|wide|vertical|horizontal)\s+version\b/,
    /^(?:please\s+)?(?:change|replace|remove|add|adjust)\s+(?:the\s+)?(?:background|foreground|color|lighting|style|subject|text)\b/,
    /^make\s+it\s+(?:more|less|darker|lighter|brighter|cinematic|photorealistic|realistic|colorful|square|wide|tall)\b/,
  ].some((pattern) => pattern.test(text));
}

function previousGenerationContext(body, latestUser) {
  if (!body || !Array.isArray(body.input) || !latestUser || latestUser.index < 0) return null;
  const messages = userMessages(body);
  const previousUser = [...messages].reverse().find((message) => message.index < latestUser.index);
  const start = previousUser ? previousUser.index : -1;
  const segment = body.input.slice(start + 1, latestUser.index);
  const generatedItem = [...segment].reverse().find((item) =>
    item && item.type === 'image_generation_call' && item.status !== 'failed'
  );
  if (generatedItem) {
    return generatedItem.revised_prompt || generatedItem.prompt || null;
  }
  if (previousUser) {
    const normalized = normalizeRequestText(previousUser.text);
    if (!isNegatedGeneration(normalized) && isExplicitGenerationRequest(normalized)) {
      return previousUser.text.trim();
    }
  }
  return null;
}

function hasPostUserContinuation(body, latestUser) {
  if (!body || !Array.isArray(body.input) || !latestUser || latestUser.index < 0) return false;
  return body.input.slice(latestUser.index + 1).some((item) =>
    item && typeof item === 'object' &&
    item.type !== 'additional_tools' &&
    !(item.type === 'message' && item.role === 'developer')
  );
}

function classifyImageRouting(body) {
  const hasImage = requestHasImage(body);
  const messages = userMessages(body);
  const latestUser = messages.at(-1) || null;
  const userText = latestUser ? latestUser.text.trim() : '';
  const normalized = normalizeRequestText(userText);
  const previousPrompt = previousGenerationContext(body, latestUser);
  const continuation = hasPostUserContinuation(body, latestUser);

  if (isNegatedGeneration(normalized)) {
    return { route: 'text', reason: 'negated_generation', userText, prompt: null };
  }
  if (isImageUnderstandingRequest(normalized, hasImage)) {
    return { route: 'text', reason: 'image_understanding_request', userText, prompt: null };
  }
  if (!continuation && isExplicitGenerationRequest(normalized)) {
    return { route: 'image_generation', reason: 'explicit_generation_request', userText, prompt: userText };
  }
  if (!continuation && previousPrompt && isGenerationFollowup(normalized)) {
    return {
      route: 'image_generation',
      reason: 'generation_followup',
      userText,
      prompt: previousPrompt + '\n\nFollow-up request: ' + userText,
    };
  }
  if (hasImage) {
    return { route: 'text', reason: 'image_present_without_generation_intent', userText, prompt: null };
  }
  return { route: 'text', reason: 'default_text', userText, prompt: null };
}

module.exports = {
  classifyImageRouting,
  isExplicitGenerationRequest,
  isGenerationFollowup,
  hasPostUserContinuation,
  normalizeRequestText,
  requestHasImage,
  userMessages,
};
