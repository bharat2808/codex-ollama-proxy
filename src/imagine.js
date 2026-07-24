'use strict';

// imagine.js
//
// Self-fulfillment loop for the synthetic `generate_image` tool, mirroring the
// pattern used by web_search.js and skill-find.js: the proxy injects a plain
// `function` tool so the model can emit function_call{name:"generate_image"};
// this loop fulfills those calls locally (via Gemini, OpenAI, or Ollama) and
// feeds the results back as function_call_output, then re-runs the model so it
// can act on the saved image path. Prompt enhancement is done by sending the
// prompt to the configured upstream text model with a Subject-Context-Style
// system prompt. Reference images (image-to-image editing) are supported via
// the inputImagePath parameter.

const fs = require('fs');
const path = require('path');
const os = require('os');
const inlineImageCache = require('./inline-image-cache');
const upstreamLib = require('./upstream');

const GENERATE_IMAGE = 'generate_image';
const MAX_LOOPS = 4;
const SUPPORTED_IMAGE_SERVICES = Object.freeze(['gemini', 'openai', 'ollama']);
const DEFAULT_OLLAMA_IMAGE_BASE_URL = 'http://127.0.0.1:11434';

// ── Synthetic function-tool definition ──────────────────────────────────────
// Injected into body.tools exactly like WEB_SEARCH_FN and FIND_SKILL_FN.
const GENERATE_IMAGE_FN = {
  type: 'function',
  name: GENERATE_IMAGE,
  description: 'Generate a new image from a text prompt, or edit an existing ' +
    'image. For text-to-image, provide only the prompt. For image editing ' +
    '(image-to-image), provide both prompt and inputImagePath. The prompt ' +
    'should describe what you want to create or what changes to make. After ' +
    'this tool returns a saved image path, do not call view_image unless the ' +
    'user explicitly asks you to inspect it; respond with the saved path or a ' +
    'markdown image link.',
  parameters: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'The text prompt. Add enough related context so that the generator can create the desired image. For image editing, describe what to ' +
          'change (e.g. "make the background blue", "add a sunset").',
      },
      inputImagePath: {
        type: 'string',
        description: 'Absolute path to a source image for image-to-image ' +
          'editing. The image will be modified according to the prompt. ' +
          'Must be an absolute path to an image file (.png, .jpg, .webp, ' +
          '.gif, .bmp). Omit for text-to-image generation.',
      },
      aspectRatio: {
        type: 'string',
        enum: ['1:1', '16:9', '9:16', '4:3', '3:4'],
        description: 'Aspect ratio of the generated image. Defaults to 1:1.',
      },
      quality: {
        type: 'string',
        enum: ['fast', 'balanced', 'quality'],
        description: 'Quality preset. "fast" for quick drafts, "quality" for ' +
          'best results. Defaults to "fast".',
      },
    },
    required: ['prompt'],
  },
};

// ── Prompt enhancement system prompts ──────────────────────────────────────
// Based on the Subject-Context-Style framework from mcp-image (MIT licensed).
const ENHANCE_SYSTEM_PROMPT = `You are an expert at crafting prompts for image generation models. Your role is to transform user requests into rich, detailed prompts that maximize image generation quality.

Structure your enhancement around three core elements:

1. SUBJECT (What): The main focus of the image
   - Physical characteristics: textures, materials, colors, scale
   - Actions, poses, expressions if applicable
   - Distinctive features that define the subject

2. CONTEXT (Where/When): The environment and conditions
   - Setting, background, spatial relationships (foreground, midground, background)
   - Time of day, weather, atmospheric conditions
   - Mood and emotional tone of the scene

3. STYLE (How): The visual treatment
   - Artistic or photographic approach: reference specific artists, movements, or styles
   - Lighting design: direction, quality, color temperature, shadows
   - Camera/lens choices: specify focal length, aperture, and shooting angle when photographic

Core principles:
- Add visual details only in areas the user left unspecified; keep all user-specified elements unchanged
- Focus on what should be present rather than what should be absent
- Include photographic or artistic terminology when appropriate
- Maintain clarity while adding richness and specificity

Your output should weave these elements into a single, natural flowing description - not a structured list. Make it vivid, engaging, and unambiguous.`;

const ENHANCE_SYSTEM_PROMPT_EDIT = ENHANCE_SYSTEM_PROMPT + `

IMPORTANT: An input image has been provided. Your task is to:
1. Analyze the visual context, style, and atmosphere of the input image
2. Preserve the original image's core characteristics (color palette, lighting style, composition) while applying the requested changes
3. Focus on maintaining visual consistency - describe modifications relative to the existing image
4. Be specific about what to keep unchanged vs what to modify
5. Use phrases like "maintain the existing...", "preserve the original...", "keep the same..." to ensure fidelity to source`;

// ── Security: validate input image path ──────────────────────────────────────
const ALLOWED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);
const EXTENSION_TO_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
};
const MAX_INPUT_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB

function validateInputImagePath(inputPath) {
  if (!inputPath || typeof inputPath !== 'string') {
    return { ok: false, error: 'inputImagePath is required' };
  }
  if (!path.isAbsolute(inputPath)) {
    return { ok: false, error: 'inputImagePath must be an absolute path, got: ' + inputPath };
  }
  if (inputPath.includes('..')) {
    return { ok: false, error: 'inputImagePath must not contain ".."' };
  }
  const ext = path.extname(inputPath).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return { ok: false, error: 'Unsupported image type: ' + ext + '. Allowed: ' + [...ALLOWED_EXTENSIONS].join(', ') };
  }
  let stat;
  try {
    stat = fs.statSync(inputPath);
  } catch (e) {
    return { ok: false, error: 'Cannot read input image: ' + e.message };
  }
  if (!stat.isFile()) {
    return { ok: false, error: 'inputImagePath is not a file: ' + inputPath };
  }
  if (stat.size > MAX_INPUT_IMAGE_SIZE) {
    return { ok: false, error: 'Input image too large: ' + (stat.size / 1024 / 1024).toFixed(1) + 'MB (max 10MB)' };
  }
  return { ok: true, mimeType: EXTENSION_TO_MIME[ext] };
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function parseArgs(v) {
  if (v == null) return {};
  if (typeof v === 'object') return v;
  try { return JSON.parse(String(v)); } catch { return {}; }
}

function postResponses(upstream, body) {
  return upstreamLib.requestJson(upstream, body);
}

function httpRequest(url, options, bodyBuf) {
  return new Promise((resolve, reject) => {
    const u = url instanceof URL ? url : new URL(url);
    const reqOpts = {
      hostname: u.hostname,
      port: u.port || undefined,
      path: u.pathname + u.search,
      method: options.method || 'POST',
      headers: options.headers || {},
    };
    const req = upstreamLib.transport(u).request(reqOpts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let parsed = null;
        try { parsed = JSON.parse(buf.toString('utf8')); } catch {}
        resolve({ statusCode: res.statusCode, headers: res.headers, body: buf, json: parsed });
      });
    });
    req.on('error', reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

function extractTextFromResponse(response) {
  if (!response || !Array.isArray(response.output)) return null;
  for (const item of response.output) {
    if (item && item.type === 'message' && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (part && (part.type === 'output_text' || part.type === 'text') && part.text) {
          return part.text.trim();
        }
      }
    }
  }
  return null;
}

// ── Prompt enhancement via the configured upstream text model ──────────────
async function enhancePrompt(upstream, userPrompt, config, systemPrompt, inputImageBase64, inputImageMime) {
  try {
    const body = {
      model: config.text_model,
      input: inputImageBase64
        ? [
            {
              type: 'message',
              role: 'user',
              content: [
                { type: 'input_image', image_url: 'data:' + inputImageMime + ';base64,' + inputImageBase64 },
                { type: 'input_text', text: userPrompt },
              ],
            },
          ]
        : userPrompt,
      instructions: systemPrompt,
      stream: false,
      max_output_tokens: 1000,
      temperature: 0.7,
    };

    const response = await postResponses(upstream, body);
    const text = extractTextFromResponse(response);
    if (text && text.trim().length > 0) {
      return text.trim();
    }
  } catch (e) {
    // Enhancement is best-effort; fall back to original prompt.
  }
  return userPrompt;
}

// ── Image backends ──────────────────────────────────────────────────────────

function buildGeminiGenerationConfig(options) {
  const generationConfig = {
    responseModalities: ['IMAGE'],
  };
  const imageConfig = {};
  if (options && options.aspectRatio) imageConfig.aspectRatio = options.aspectRatio;
  if (options && options.imageSize) imageConfig.imageSize = options.imageSize;
  if (Object.keys(imageConfig).length > 0) {
    generationConfig.imageConfig = imageConfig;
  }
  return generationConfig;
}

// Gemini image generation (text-to-image and image-to-image)
async function generateGeminiImage(prompt, options, log) {
  const model = options.model || (options.quality === 'quality'
    ? 'gemini-3-pro-image'
    : 'gemini-3.1-flash-image');
  const apiKey = options.apiKey || process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set (configure imagine_api_key or set GEMINI_API_KEY env)');

  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent';

  // Build contents
  let contents;
  if (options.inputImage) {
    // Image editing: image first, then text
    contents = [{
      parts: [
        { inlineData: { data: options.inputImage, mimeType: options.inputImageMimeType || 'image/png' } },
        { text: prompt },
      ],
    }];
  } else {
    // Text-to-image
    contents = [{ parts: [{ text: prompt }] }];
  }

  const generationConfig = buildGeminiGenerationConfig(options);

  const body = JSON.stringify({ contents, generationConfig });
  const res = await httpRequest(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': apiKey,
      'content-length': Buffer.byteLength(body),
    },
  }, Buffer.from(body));

  if (res.statusCode !== 200) {
    const errMsg = res.json && res.json.error ? res.json.error.message : res.body.toString('utf8').slice(0, 500);
    throw new Error('Gemini API error (' + res.statusCode + '): ' + errMsg);
  }

  // Extract image from response
  const data = res.json;
  if (!data || !data.candidates || !data.candidates[0]) {
    throw new Error('Gemini API: no candidates in response');
  }
  const parts = data.candidates[0].content && data.candidates[0].content.parts;
  if (!parts) throw new Error('Gemini API: no content parts in response');

  const imagePart = parts.find((p) => p.inlineData && p.inlineData.data);
  if (!imagePart) {
    const textPart = parts.find((p) => p.text);
    const reason = textPart ? textPart.text : 'no image data returned';
    throw new Error('Gemini API: image generation failed - ' + reason);
  }

  const imageBuffer = Buffer.from(imagePart.inlineData.data, 'base64');
  const mimeType = imagePart.inlineData.mimeType || 'image/png';

  log('gemini: generated ' + imageBuffer.length + ' bytes (' + mimeType + ') with model ' + model);

  return {
    imageData: imageBuffer,
    metadata: {
      model: model,
      prompt: prompt,
      mimeType: mimeType,
      timestamp: new Date(),
      inputImageProvided: !!options.inputImage,
    },
  };
}

// OpenAI image generation (text-to-image and image-to-image)
async function generateOpenAIImage(prompt, options, log) {
  const model = options.model || 'gpt-image-2';
  const apiKey = options.apiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set (configure imagine_api_key or set OPENAI_API_KEY env)');

  const qualityMap = { fast: 'low', balanced: 'medium', quality: 'high' };
  const quality = qualityMap[options.quality || 'fast'] || 'low';

  // Determine size from aspectRatio
  let size = '1024x1024';
  if (options.aspectRatio) {
    const [w, h] = options.aspectRatio.split(':').map(Number);
    if (w > h) size = '1536x1024';
    else if (h > w) size = '1024x1536';
  }

  if (options.inputImage) {
    // Image editing: POST /v1/images/edits with multipart form
    const mime = options.inputImageMimeType || 'image/png';
    const ext = mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png';
    const imageBuffer = Buffer.from(options.inputImage, 'base64');

    // Build multipart form data
    const boundary = '----proxy-imagine-' + Date.now();
    const parts = [];

    // model field
    parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="model"\r\n\r\n' + model + '\r\n'));
    // prompt field
    parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="prompt"\r\n\r\n' + prompt + '\r\n'));
    // n field
    parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="n"\r\n\r\n1\r\n'));
    // size field
    parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="size"\r\n\r\n' + size + '\r\n'));
    // quality field
    parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="quality"\r\n\r\n' + quality + '\r\n'));
    // image file
    parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="image"; filename="input.' + ext + '"\r\nContent-Type: ' + mime + '\r\n\r\n'));
    parts.push(imageBuffer);
    parts.push(Buffer.from('\r\n'));
    // close boundary
    parts.push(Buffer.from('--' + boundary + '--\r\n'));

    const bodyBuf = Buffer.concat(parts);
    const res = await httpRequest('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: {
        'authorization': 'Bearer ' + apiKey,
        'content-type': 'multipart/form-data; boundary=' + boundary,
        'content-length': bodyBuf.length,
      },
    }, bodyBuf);

    return parseOpenAIImageResponse(res, model, prompt, !!options.inputImage, log);
  } else {
    // Text-to-image: POST /v1/images/generations with JSON
    const body = JSON.stringify({
      model: model,
      prompt: prompt,
      n: 1,
      size: size,
      quality: quality,
    });
    const res = await httpRequest('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'authorization': 'Bearer ' + apiKey,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    }, Buffer.from(body));

    return parseOpenAIImageResponse(res, model, prompt, false, log);
  }
}

async function parseOpenAIImageResponse(res, model, prompt, inputImageProvided, log) {
  if (res.statusCode !== 200) {
    const errMsg = res.json && res.json.error ? res.json.error.message : res.body.toString('utf8').slice(0, 500);
    throw new Error('OpenAI API error (' + res.statusCode + '): ' + errMsg);
  }

  const data = res.json;
  if (!data || !data.data || !data.data[0]) {
    throw new Error('OpenAI API: no image data in response');
  }

  const firstImage = data.data[0];
  let imageBuffer;
  if (firstImage.b64_json) {
    imageBuffer = Buffer.from(firstImage.b64_json, 'base64');
  } else if (firstImage.url) {
    // Download the image from the URL
    const downloadRes = await httpRequest(firstImage.url, { method: 'GET' });
    if (downloadRes.statusCode !== 200) {
      throw new Error('OpenAI API: failed to download image from URL (' + downloadRes.statusCode + ')');
    }
    imageBuffer = downloadRes.body;
  } else {
    throw new Error('OpenAI API: no b64_json or url in response');
  }

  log('openai: generated ' + imageBuffer.length + ' bytes (png) with model ' + model);

  return {
    imageData: imageBuffer,
    metadata: {
      model: model,
      prompt: prompt,
      mimeType: 'image/png',
      timestamp: new Date(),
      inputImageProvided: inputImageProvided,
      ...(firstImage.revised_prompt && { revisedPrompt: firstImage.revised_prompt }),
    },
  };
}

function aspectRatioDimensions(aspectRatio) {
  switch (aspectRatio) {
    case '16:9': return { width: 1344, height: 768 };
    case '9:16': return { width: 768, height: 1344 };
    case '4:3': return { width: 1024, height: 768 };
    case '3:4': return { width: 768, height: 1024 };
    default: return { width: 1024, height: 1024 };
  }
}

function ollamaApiUrl(baseUrl, apiPath) {
  const url = new URL(String(baseUrl || DEFAULT_OLLAMA_IMAGE_BASE_URL));
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('imagine_base_url must use http or https');
  }
  const basePath = url.pathname.replace(/\/+$/u, '');
  const prefix = /\/v1$/u.test(basePath) ? basePath.slice(0, -3) : basePath;
  url.pathname = prefix + '/' + String(apiPath || '').replace(/^\/+/, '');
  url.search = '';
  url.hash = '';
  return url;
}

// Ollama image generation through its native, experimental /api/generate API.
async function generateOllamaImage(prompt, options, log) {
  const model = String(options.model || '').trim();
  if (!model) throw new Error('imagine_model is required for the Ollama image backend');

  const dimensions = aspectRatioDimensions(options.aspectRatio);
  const payload = {
    model,
    prompt,
    width: dimensions.width,
    height: dimensions.height,
    stream: false,
  };
  if (options.inputImage) payload.images = [options.inputImage];

  const body = Buffer.from(JSON.stringify(payload));
  const headers = {
    'content-type': 'application/json',
    'content-length': body.length,
  };
  if (options.apiKey) headers.authorization = 'Bearer ' + options.apiKey;
  const res = await httpRequest(ollamaApiUrl(options.baseUrl, '/api/generate'), {
    method: 'POST',
    headers,
  }, body);

  if (res.statusCode !== 200) {
    const error = res.json && res.json.error ? res.json.error : res.body.toString('utf8').slice(0, 500);
    throw new Error('Ollama API error (' + res.statusCode + '): ' + error);
  }
  const encoded = res.json && (res.json.image || (Array.isArray(res.json.images) && res.json.images[0]));
  if (!encoded) throw new Error('Ollama API: no image data in response');
  const imageBuffer = Buffer.from(encoded, 'base64');
  if (imageBuffer.length === 0) throw new Error('Ollama API: returned empty image data');

  log('ollama: generated ' + imageBuffer.length + ' bytes (png) with model ' + model);
  return {
    imageData: imageBuffer,
    metadata: {
      model,
      prompt,
      mimeType: 'image/png',
      timestamp: new Date(),
      inputImageProvided: !!options.inputImage,
    },
  };
}

// ── Backend dispatcher ───────────────────────────────────────────────────────
async function callImageBackend(prompt, options, log) {
  const service = options.service || 'gemini';
  switch (service) {
    case 'gemini': return generateGeminiImage(prompt, options, log);
    case 'openai': return generateOpenAIImage(prompt, options, log);
    case 'ollama': return generateOllamaImage(prompt, options, log);
    default:
      throw new Error('Unsupported imagine_service "' + service + '" (expected ' +
        SUPPORTED_IMAGE_SERVICES.join(', ') + ')');
  }
}

// ── Fulfill one generate_image call ─────────────────────────────────────────
async function fulfillGenerateImage(call, upstream, config, log, options = {}) {
  const args = parseArgs(call.arguments);
  const prompt = String(args.prompt || '').trim();
  if (!prompt) {
    return { call_id: call.call_id, output: '[generate_image error] prompt is required' };
  }

  // ── Handle reference image (image-to-image editing) ──
  let inputImageBase64 = null;
  let inputImageMime = null;
  let inputImagePath = null;

  if (args.inputImagePath) {
    const validation = validateInputImagePath(args.inputImagePath);
    if (!validation.ok) {
      return { call_id: call.call_id, output: '[generate_image error] ' + validation.error };
    }
    try {
      const buf = fs.readFileSync(args.inputImagePath);
      inputImageBase64 = buf.toString('base64');
      inputImageMime = validation.mimeType;
      inputImagePath = args.inputImagePath;
      log('input image: ' + args.inputImagePath + ' (' + (buf.length / 1024).toFixed(0) + 'KB, ' + validation.mimeType + ')');
    } catch (e) {
      return { call_id: call.call_id, output: '[generate_image error] Cannot read input image: ' + e.message };
    }
  }

  // ── Step 1: Enhance prompt (if enabled) ──
  let enhancedPrompt = prompt;
  if (config.imagine_enhance) {
    const systemPrompt = inputImageBase64
      ? ENHANCE_SYSTEM_PROMPT_EDIT
      : ENHANCE_SYSTEM_PROMPT;
    enhancedPrompt = await enhancePrompt(upstream, prompt, config, systemPrompt, inputImageBase64, inputImageMime);
    if (enhancedPrompt !== prompt) {
      log('prompt enhanced: "' + prompt.slice(0, 50) + '..." -> "' + enhancedPrompt.slice(0, 50) + '..."');
    }
  }

  // ── Step 2: Generate image ──
  let result;
  try {
    result = await callImageBackend(enhancedPrompt, {
      service: config.imagine_service || 'gemini',
      model: config.imagine_model || '',
      baseUrl: config.imagine_base_url || '',
      apiKey: config.imagine_api_key || '',
      quality: args.quality || config.imagine_quality || 'fast',
      aspectRatio: args.aspectRatio || config.imagine_aspect_ratio || '1:1',
      inputImage: inputImageBase64,
      inputImageMimeType: inputImageMime,
    }, log);
  } catch (e) {
    log('generate_image backend error: ' + e.message);
    return { call_id: call.call_id, output: '[generate_image error] ' + e.message };
  }

  // ── Step 3: Save generated image ──
  const ext = result.metadata.mimeType === 'image/jpeg' ? '.jpg'
    : result.metadata.mimeType === 'image/webp' ? '.webp' : '.png';
  const filename = 'imagine-' + (inputImageBase64 ? 'edit-' : '') + Date.now() + ext;
  let filepath;
  try {
    if (options.outputDirectory) {
      filepath = inlineImageCache.persistImageBytes(
        options.outputDirectory,
        result.imageData,
        result.metadata.mimeType
      );
    } else {
      filepath = path.join(os.tmpdir(), filename);
      fs.writeFileSync(filepath, result.imageData, { mode: 0o600 });
    }
    log('generate_image: saved ' + result.imageData.length + ' bytes to ' + filepath);
  } catch (e) {
    return { call_id: call.call_id, output: '[generate_image error] Failed to save image: ' + e.message };
  }

  // ── Step 4: Return metadata as tool output ──
  const output = {
    path: filepath,
    mode: inputImageBase64 ? 'image-edit' : 'text-to-image',
    model: result.metadata.model,
    mimeType: result.metadata.mimeType,
    bytes: result.imageData.length,
    originalPrompt: prompt,
  };
  if (inputImagePath) output.inputImagePath = inputImagePath;
  if (enhancedPrompt !== prompt) {
    output.enhancedPrompt = enhancedPrompt;
  }
  if (result.metadata.revisedPrompt) output.revisedPrompt = result.metadata.revisedPrompt;

  return { call_id: call.call_id, output: JSON.stringify(output) };
}

// ── Detection: does this request have the generate_image tool? ──────────────
function hasGenerateImageTool(body) {
  return !!(body && Array.isArray(body.tools) && body.tools.some((t) =>
    t && t.type === 'function' && t.name === GENERATE_IMAGE
  ));
}

// ── Find generate_image calls in model response ─────────────────────────────
function findImageCalls(response) {
  const output = response && Array.isArray(response.output) ? response.output : [];
  return output.filter((item) =>
    item && item.type === 'function_call' && item.name === GENERATE_IMAGE
  );
}

// ── The loop — mirrors runFindSkillLoop / runResponsesLoop ──────────────────
async function runGenerateImageLoop(upstream, originalBody, config, options) {
  const log = options.log || (() => {});
  let body = JSON.parse(JSON.stringify(originalBody));
  body.stream = false;
  let fulfilled = false;

  for (let loop = 0; loop < MAX_LOOPS; loop += 1) {
    const response = await postResponses(upstream, body);
    const imageCalls = findImageCalls(response);
    const statusCalls = findProxyStatusCalls(response);
    if (imageCalls.length === 0 && statusCalls.length === 0) return { response, fulfilled };

    fulfilled = true;
    log('imagine loop: ' + imageCalls.length + ' image call(s), ' + statusCalls.length + ' status call(s)');
    const outputs = [];
    for (const call of imageCalls) {
      const r = await fulfillGenerateImage(call, upstream, config, log, {
        outputDirectory: options.outputDirectory,
      });
      outputs.push({ type: 'function_call_output', call_id: r.call_id, output: r.output });
    }
    for (const call of statusCalls) {
      const r = fulfillProxyStatus(call, config, log);
      outputs.push({ type: 'function_call_output', call_id: r.call_id, output: r.output });
    }

    body = Object.assign({}, body, {
      input: [
        ...(Array.isArray(response.output) ? response.output : []),
        ...outputs,
      ],
      stream: false,
    });
  }

  throw new Error('generate_image loop exceeded ' + MAX_LOOPS + ' iterations');
}

// ── Health check for doctor command ─────────────────────────────────────────
async function checkHealth(config) {
  const results = {};
  const service = config.imagine_service || 'gemini';
  const apiKey = config.imagine_api_key || '';

  if (service === 'gemini') {
    const key = apiKey || process.env.GEMINI_API_KEY;
    if (!key) {
      results.gemini = { ready: false, error: 'GEMINI_API_KEY not set' };
    } else {
      try {
        const url = 'https://generativelanguage.googleapis.com/v1beta/models?key=' + key;
        const res = await httpRequest(url, { method: 'GET' });
        if (res.statusCode === 200) {
          results.gemini = { ready: true, models: (res.json.models || []).length };
        } else {
          results.gemini = { ready: false, error: 'HTTP ' + res.statusCode };
        }
      } catch (e) {
        results.gemini = { ready: false, error: e.message };
      }
    }
  } else if (service === 'openai') {
    const key = apiKey || process.env.OPENAI_API_KEY;
    if (!key) {
      results.openai = { ready: false, error: 'OPENAI_API_KEY not set' };
    } else {
      try {
        const res = await httpRequest('https://api.openai.com/v1/models', {
          method: 'GET',
          headers: { 'authorization': 'Bearer ' + key },
        });
        if (res.statusCode === 200) {
          results.openai = { ready: true, models: (res.json.data || []).length };
        } else {
          results.openai = { ready: false, error: 'HTTP ' + res.statusCode };
        }
      } catch (e) {
        results.openai = { ready: false, error: e.message };
      }
    }
  } else if (service === 'ollama') {
    const model = String(config.imagine_model || '').trim();
    if (!model) {
      results.ollama = { ready: false, error: 'imagine_model is not configured' };
    } else {
      try {
        const headers = apiKey ? { authorization: 'Bearer ' + apiKey } : {};
        const res = await httpRequest(ollamaApiUrl(config.imagine_base_url, '/api/tags'), {
          method: 'GET',
          headers,
        });
        if (res.statusCode !== 200) {
          results.ollama = { ready: false, error: 'HTTP ' + res.statusCode };
        } else {
          const models = res.json && Array.isArray(res.json.models) ? res.json.models : [];
          const available = models.map((entry) => String(entry && (entry.name || entry.model) || ''));
          const matches = available.some((name) =>
            name === model || name === model + ':latest' || name + ':latest' === model
          );
          results.ollama = matches
            ? { ready: true, models: available.length }
            : { ready: false, error: 'model not found: ' + model };
        }
      } catch (e) {
        results.ollama = { ready: false, error: e.message };
      }
    }
  } else {
    results[service] = { ready: false, error: 'unsupported image service' };
  }

  return results;
}

// ── ollama_proxy_status synthetic tool ──────────────────────────────────────
// Lets the model query current image generation config at runtime.
const PROXY_STATUS = 'ollama_proxy_status';

const PROXY_STATUS_FN = {
  type: 'function',
  name: PROXY_STATUS,
  description: 'Check the current configuration and available commands of ' +
    'the ollama-shape-proxy. Returns all current settings (text model, image ' +
    'model, auto-routing, find_skill, streaming, image generation config) ' +
    'and all available CLI commands (init, serve, status, switch, route, ' +
    'logs, install, uninstall, restart, imagine). Call this when the user ' +
    'asks about the proxy setup, wants to change settings, or before ' +
    'generating images to confirm the configuration. Changes require a ' +
    'proxy restart to take effect.',
  parameters: {
    type: 'object',
    properties: {},
  },
};

function hasProxyStatusTool(body) {
  return !!(body && Array.isArray(body.tools) && body.tools.some((t) =>
    t && t.type === 'function' && t.name === PROXY_STATUS
  ));
}

function findProxyStatusCalls(response) {
  const output = response && Array.isArray(response.output) ? response.output : [];
  return output.filter((item) =>
    item && item.type === 'function_call' && item.name === PROXY_STATUS
  );
}

function fulfillProxyStatus(call, config, log) {
  const imagineService = config.imagine_service || 'gemini';
  const maskedKey = config.imagine_api_key
    ? 'set (' + config.imagine_api_key.slice(0, 4) + '...)'
    : (imagineService === 'ollama' ? 'not set' : 'not set (will use env var if available)');

  const status = {
    current_config: {
      text_model: config.text_model || null,
      image_model: config.image_model || null,
      auto_route_image: config.auto_route_image || false,
      dedupe_large_input: config.dedupe_large_input !== false,
      duplicate_input_min_chars: config.duplicate_input_min_chars || 512,
      verbose_tools: config.verbose_tools || false,
      log_upstream_body: config.log_upstream_body || false,
      enable_find_skill: config.enable_find_skill || false,
      stream_proxy_loop: config.stream_proxy_loop !== false,
      imagine_enabled: config.imagine_enabled || false,
      imagine_service: imagineService,
      imagine_model: config.imagine_model || (imagineService === 'ollama' ? '(required)' : '(provider default)'),
      imagine_base_url: config.imagine_base_url || (imagineService === 'ollama'
        ? DEFAULT_OLLAMA_IMAGE_BASE_URL : null),
      imagine_api_key: maskedKey,
      imagine_quality: config.imagine_quality || 'fast',
      imagine_enhance: config.imagine_enhance || false,
      imagine_aspect_ratio: config.imagine_aspect_ratio || '1:1',
    },
    available_commands: {
      init: 'codex-ollama-proxy init [--force]',
      serve: 'codex-ollama-proxy serve',
      status: 'codex-ollama-proxy status',
      switch_openai: 'codex-ollama-proxy switch openai',
      switch_ollama: 'codex-ollama-proxy switch ollama [--model MODEL]',
      route: 'codex-ollama-proxy route --text-model MODEL --image-model MODEL [--auto-image|--no-auto-image]',
      logs: 'codex-ollama-proxy logs [--tail N]',
      install: 'codex-ollama-proxy install',
      uninstall: 'codex-ollama-proxy uninstall',
      restart: 'codex-ollama-proxy restart',
      imagine_enable: 'codex-ollama-proxy imagine --enable --service gemini|openai|ollama --model MODEL [--base-url URL] [--api-key "KEY"]',
      imagine_disable: 'codex-ollama-proxy imagine --disable',
      imagine_quality: 'codex-ollama-proxy imagine --quality fast|balanced|quality',
      imagine_enhance: 'codex-ollama-proxy imagine --enhance',
      imagine_no_enhance: 'codex-ollama-proxy imagine --no-enhance',
      imagine_aspect_ratio: 'codex-ollama-proxy imagine --aspect-ratio 1:1|16:9|9:16|4:3|3:4',
      imagine_status: 'codex-ollama-proxy imagine --status',
      imagine_doctor: 'codex-ollama-proxy imagine --doctor',
    },
    hint: 'Changes to proxy-models.toml require a proxy restart to take effect: codex-ollama-proxy restart. After switching providers (switch openai/ollama), tell the user to restart Codex or open a fresh thread so provider discovery reloads.',
  };

  log('ollama_proxy_status: returning full proxy config + commands');

  return {
    call_id: call.call_id,
    output: JSON.stringify(status, null, 2),
  };
}

module.exports = {
  SUPPORTED_IMAGE_SERVICES,
  GENERATE_IMAGE,
  GENERATE_IMAGE_FN,
  hasGenerateImageTool,
  findImageCalls,
  fulfillGenerateImage,
  runGenerateImageLoop,
  checkHealth,
  validateInputImagePath,
  buildGeminiGenerationConfig,
  aspectRatioDimensions,
  generateOllamaImage,
  ollamaApiUrl,
  PROXY_STATUS,
  PROXY_STATUS_FN,
  hasProxyStatusTool,
  findProxyStatusCalls,
  fulfillProxyStatus,
};
