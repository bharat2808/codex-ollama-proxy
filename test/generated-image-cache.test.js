'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  cacheGeneratedImages,
  isPrivateAddress,
  rehydrateGeneratedImageChain,
} = require('../src/generated-image-cache');

const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('generated-image'),
]);

function pngDataUrl(suffix) {
  return `data:image/png;base64,${Buffer.concat([PNG_BYTES, Buffer.from(suffix)]).toString('base64')}`;
}

test('rejects local and private addresses including IPv4-mapped IPv6 forms', () => {
  assert.equal(isPrivateAddress('127.0.0.1'), true);
  assert.equal(isPrivateAddress('10.20.30.40'), true);
  assert.equal(isPrivateAddress('::1'), true);
  assert.equal(isPrivateAddress('fc00::1'), true);
  assert.equal(isPrivateAddress('::ffff:127.0.0.1'), true);
  assert.equal(isPrivateAddress('::ffff:7f00:1'), true);
  assert.equal(isPrivateAddress('8.8.8.8'), false);
  assert.equal(isPrivateAddress('2606:4700:4700::1111'), false);
});

function imageResponse(result) {
  return {
    output: [{
      id: 'ig_test',
      type: 'image_generation_call',
      status: 'completed',
      result,
    }],
  };
}

test('persists generated data URLs in the existing private session cache', async () => {
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'generated-image-cache-test-'));
  try {
    const response = imageResponse(`data:image/png;base64,${PNG_BYTES.toString('base64')}`);
    await cacheGeneratedImages(response, {
      prompt_cache_key: 'generated-data-url-session',
    }, {
      cacheRoot,
      retentionDays: 30,
    });

    const savedPath = response.output[0].saved_path;
    assert.ok(savedPath.startsWith(cacheRoot + path.sep));
    assert.deepEqual(fs.readFileSync(savedPath), PNG_BYTES);
    assert.equal(fs.statSync(savedPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(savedPath)).mode & 0o777, 0o700);
  } finally {
    fs.rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test('downloads bounded HTTPS image results and persists validated bytes', async () => {
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'generated-image-cache-test-'));
  let requested = null;
  try {
    const response = imageResponse('https://images.example/generated.png');
    await cacheGeneratedImages(response, {
      metadata: { session_id: 'generated-url-session' },
    }, {
      cacheRoot,
      retentionDays: 30,
      fetchImpl: async (url, options) => {
        requested = { url, options };
        return new Response(PNG_BYTES, {
          status: 200,
          headers: {
            'content-type': 'image/png',
            'content-length': String(PNG_BYTES.length),
          },
        });
      },
      resolveHostname: async () => [{ address: '8.8.8.8', family: 4 }],
    });

    assert.equal(requested.url, 'https://images.example/generated.png');
    assert.equal(requested.options.redirect, 'manual');
    assert.deepEqual(fs.readFileSync(response.output[0].saved_path), PNG_BYTES);
  } finally {
    fs.rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test('leaves provider results usable when persistence validation fails', async () => {
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'generated-image-cache-test-'));
  const logs = [];
  try {
    const result = 'https://images.example/not-an-image';
    const response = imageResponse(result);
    await cacheGeneratedImages(response, {
      conversation: { id: 'generated-failure-session' },
    }, {
      cacheRoot,
      fetchImpl: async () => new Response('not an image', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }),
      resolveHostname: async () => [{ address: '8.8.8.8', family: 4 }],
      log: (message) => logs.push(message),
    });

    assert.equal(response.output[0].result, result);
    assert.equal(response.output[0].saved_path, undefined);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /unsupported or invalid image/u);
  } finally {
    fs.rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test('does not fetch or persist without a stable session identifier', async () => {
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'generated-image-cache-test-'));
  let fetched = false;
  try {
    const response = imageResponse('https://images.example/generated.png');
    await cacheGeneratedImages(response, {}, {
      cacheRoot,
      fetchImpl: async () => {
        fetched = true;
        return new Response(PNG_BYTES);
      },
    });

    assert.equal(fetched, false);
    assert.equal(response.output[0].saved_path, undefined);
    assert.deepEqual(fs.readdirSync(cacheRoot), []);
  } finally {
    fs.rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test('rehydrates every cached generated image into the latest user turn', async () => {
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'generated-image-chain-test-'));
  try {
    const request = { prompt_cache_key: 'generated-image-chain-session' };
    const first = imageResponse(`data:image/png;base64,${Buffer.concat([PNG_BYTES, Buffer.from('first')]).toString('base64')}`);
    const second = imageResponse(`data:image/png;base64,${Buffer.concat([PNG_BYTES, Buffer.from('second')]).toString('base64')}`);
    await cacheGeneratedImages(first, request, { cacheRoot });
    await cacheGeneratedImages(second, request, { cacheRoot });
    const body = {
      model: 'dual-image-model',
      input: [
        { ...first.output[0], id: 'ig_first' },
        { role: 'user', content: [{ type: 'input_text', text: 'Discuss something else.' }] },
        { ...second.output[0], id: 'ig_second' },
        { role: 'user', content: [{ type: 'input_text', text: 'Now update both images.' }] },
      ],
    };

    const count = rehydrateGeneratedImageChain(body, { cacheRoot });

    assert.equal(count, 2);
    assert.equal(body.input.at(-1).content[0].text, 'Now update both images.');
    assert.equal(body.input.at(-1).content[1].type, 'input_image');
    assert.equal(body.input.at(-1).content[2].type, 'input_image');
    assert.match(body.input.at(-1).content[1].image_url, /^data:image\/png;base64,/u);
    assert.match(body.input.at(-1).content[2].image_url, /^data:image\/png;base64,/u);
  } finally {
    fs.rmSync(cacheRoot, { recursive: true, force: true });
  }
});

test('keeps a new user image after historical generated images for provider reference limits', async () => {
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'generated-image-chain-order-'));
  const body = {
    prompt_cache_key: 'generated-chain-order',
    input: [
      { type: 'image_generation_call', result: pngDataUrl('historical') },
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'Use my new reference too.' },
          { type: 'input_image', image_url: pngDataUrl('active') },
        ],
      },
    ],
  };

  try {
    assert.equal(rehydrateGeneratedImageChain(body, { cacheRoot }), 1);
    assert.deepEqual(body.input[1].content, [
      { type: 'input_text', text: 'Use my new reference too.' },
      { type: 'input_image', image_url: pngDataUrl('historical') },
      { type: 'input_image', image_url: pngDataUrl('active') },
    ]);
  } finally {
    fs.rmSync(cacheRoot, { recursive: true, force: true });
  }
});
