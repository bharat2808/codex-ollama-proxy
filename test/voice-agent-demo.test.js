'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const test = require('node:test');

const { JsonLineRpcClient } = require('../src/voice-agent/json-line-rpc');
const {
  KokoroSpeaker,
  recordMicrophoneAudio,
  renderKokoroAudio,
  streamKokoroAudio,
  transcribeAudio,
} = require('../src/voice-agent/local-speech');
const {
  SpeakableAgentMessages,
  VoiceAgentSession,
  buildVoiceTurnParams,
} = require('../src/voice-agent/voice-agent-session');
const {
  appServerArgs,
  parseVoiceArgs,
  resolveVoiceOptions,
  runVoiceDemo,
  startAppServer,
} = require('../src/voice-agent/voice-demo');

test('voice demo uses saved Whisper and Kokoro settings while explicit options win', () => {
  assert.equal(typeof resolveVoiceOptions, 'function');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-voice-demo-config-'));
  const configFile = path.join(root, 'voice.toml');
  fs.writeFileSync(configFile, [
    'voice_enabled = true',
    'whisper_command = "/opt/whisper"',
    'whisper_model = "/models/whisper.bin"',
    'kokoro_model = "local/kokoro"',
    'kokoro_voice = "bf_emma"',
    'kokoro_dtype = "fp32"',
    'kokoro_device = "cpu"',
    'kokoro_speed = 1.2',
    '',
  ].join('\n'), 'utf8');

  try {
    assert.deepEqual(resolveVoiceOptions({
      voice: 'af_heart',
    }, { configFile }), {
      whisperCommand: '/opt/whisper',
      whisperModel: '/models/whisper.bin',
      kokoroModel: 'local/kokoro',
      voice: 'af_heart',
      kokoroDtype: 'fp32',
      kokoroDevice: 'cpu',
      kokoroSpeed: 1.2,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('voice turns add spoken-behavior guidance without replacing the user transcript', () => {
  const params = buildVoiceTurnParams('thread-123', 'Check the build and fix it.');

  assert.equal(params.threadId, 'thread-123');
  assert.deepEqual(params.input, [{
    type: 'text',
    text: 'Check the build and fix it.',
    text_elements: [],
  }]);
  assert.deepEqual(Object.keys(params.additionalContext), ['voice-agent-demo']);
  assert.equal(params.additionalContext['voice-agent-demo'].kind, 'application');
  assert.match(params.additionalContext['voice-agent-demo'].value, /Before calling any tool/u);
  assert.match(params.additionalContext['voice-agent-demo'].value, /After tool execution/u);
  assert.match(params.additionalContext['voice-agent-demo'].value, /Never end a turn with only a tool call/u);
});

test('voice session submits the transcript through turn/start on the selected Codex thread', async () => {
  const rpc = new FakeRpc();
  const session = new VoiceAgentSession({ rpc });

  const result = await session.runTurn({
    threadId: 'thread-123',
    transcript: 'Inspect the failing tests.',
  });

  assert.deepEqual(rpc.requests.map(({ method }) => method), [
    'initialize',
    'thread/resume',
    'turn/start',
  ]);
  assert.equal(rpc.notifications[0].method, 'initialized');
  assert.deepEqual(rpc.requests[1].params, {
    threadId: 'thread-123',
    excludeTurns: true,
  });
  assert.equal(rpc.requests[2].params.threadId, 'thread-123');
  assert.equal(rpc.requests[2].params.input[0].text, 'Inspect the failing tests.');
  assert.equal(result.threadId, 'thread-123');
  assert.equal(result.turn.status, 'completed');
});

test('voice session can create a Codex thread before submitting turn/start', async () => {
  const rpc = new FakeRpc();
  const session = new VoiceAgentSession({ rpc });

  const result = await session.runTurn({
    cwd: '/workspace',
    transcript: 'Inspect this workspace.',
  });

  assert.deepEqual(rpc.requests.map(({ method }) => method), [
    'initialize',
    'thread/start',
    'turn/start',
  ]);
  assert.deepEqual(rpc.requests[1].params, { cwd: '/workspace' });
  assert.equal(rpc.requests[2].params.threadId, 'thread-created');
  assert.equal(result.threadId, 'thread-created');
  assert.equal(result.turn.status, 'completed');
});

test('voice session rejects when the app-server disconnects during a turn', async () => {
  const rpc = new FakeRpc({ disconnectDuringTurn: true });
  const session = new VoiceAgentSession({ rpc });

  await assert.rejects(
    session.runTurn({
      threadId: 'thread-123',
      transcript: 'Run the tests.',
    }),
    /app-server disconnected/u,
  );
  assert.equal(rpc.listenerCount('notification'), 0);
  assert.equal(rpc.listenerCount('close'), 0);
});

test('JSON-line RPC resolves responses and emits app-server notifications from fragmented input', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = '';
  output.on('data', (chunk) => { written += chunk.toString('utf8'); });
  const rpc = new JsonLineRpcClient({ input, output });
  const seen = [];
  rpc.on('notification', (notification) => seen.push(notification));

  const pending = rpc.request('initialize', { clientInfo: { name: 'demo', version: '1' } });
  await new Promise((resolve) => setImmediate(resolve));
  const request = JSON.parse(written.trim());
  input.write('{"jsonrpc":"2.0","method":"thread/started","par');
  input.write('ams":{"thread":{"id":"thread-1"}}}\n');
  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { userAgent: 'codex' } })}\n`);

  assert.deepEqual(await pending, { userAgent: 'codex' });
  assert.equal(seen[0].method, 'thread/started');
  rpc.close();
});

test('local transcription invokes whisper-cli with the selected model and returns clean text', async () => {
  const calls = [];
  const transcript = await transcribeAudio({
    audioPath: '/tmp/input.wav',
    modelPath: '/models/ggml-base.en.bin',
    run: async (command, args) => {
      calls.push({ command, args });
      return { stdout: '  check the build please  \n', stderr: '' };
    },
  });

  assert.deepEqual(calls, [{
    command: 'whisper-cli',
    args: [
      '--model', '/models/ggml-base.en.bin',
      '--file', '/tmp/input.wav',
      '--no-timestamps',
      '--no-prints',
    ],
  }]);
  assert.equal(transcript, 'check the build please');
});

test('microphone recording captures mono 16 kHz audio and stops cleanly', async () => {
  const events = [];
  const child = new EventEmitter();
  child.stdin = {
    write(value) {
      events.push(`stdin:${value}`);
      queueMicrotask(() => child.emit('exit', 0, null));
    },
  };

  const outputPath = await recordMicrophoneAudio({
    outputPath: '/tmp/microphone.wav',
    device: ':2',
    spawnProcess(command, args) {
      events.push({ command, args });
      return child;
    },
    waitForStop: async () => {
      events.push('prompt');
    },
  });

  assert.equal(outputPath, '/tmp/microphone.wav');
  assert.deepEqual(events, [
    {
      command: 'ffmpeg',
      args: [
        '-hide_banner', '-loglevel', 'error',
        '-f', 'avfoundation',
        '-i', ':2',
        '-ac', '1',
        '-ar', '16000',
        '-y', '/tmp/microphone.wav',
      ],
    },
    'prompt',
    'stdin:q\n',
  ]);
});

test('microphone recording stops ffmpeg when the terminal prompt fails', async () => {
  const events = [];
  const child = new EventEmitter();
  child.stdin = {
    write(value) {
      events.push(`stdin:${value}`);
      queueMicrotask(() => child.emit('exit', 0, null));
    },
  };

  await assert.rejects(
    recordMicrophoneAudio({
      outputPath: '/tmp/microphone.wav',
      spawnProcess() {
        return child;
      },
      waitForStop: async () => {
        throw new Error('stdin closed');
      },
    }),
    /stdin closed/u,
  );
  assert.deepEqual(events, ['stdin:q\n']);
});

test('microphone recording reports an immediate ffmpeg failure without waiting for Enter', async () => {
  const child = new EventEmitter();
  child.stdin = { writable: true, write() {} };
  let promptAborted = false;

  await assert.rejects(
    recordMicrophoneAudio({
      outputPath: '/tmp/microphone.wav',
      spawnProcess() {
        queueMicrotask(() => child.emit('error', new Error('ffmpeg missing')));
        return child;
      },
      waitForStop: ({ signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          promptAborted = true;
          reject(signal.reason);
        }, { once: true });
      }),
    }),
    /ffmpeg missing/u,
  );
  assert.equal(promptAborted, true);
});

test('Kokoro rendering uses the local Node model and selected voice', async () => {
  const events = [];
  await renderKokoroAudio({
    text: 'The build is fixed.',
    outputPath: '/tmp/spoken.wav',
    voice: 'af_heart',
    speed: 1.1,
    loadModel: async (modelId, options) => {
      events.push({ modelId, options });
      return {
        generate: async (text, generationOptions) => {
          events.push({ text, generationOptions });
          return {
            save(outputPath) {
              events.push({ outputPath });
            },
          };
        },
      };
    },
  });

  assert.deepEqual(events, [
    {
      modelId: 'onnx-community/Kokoro-82M-v1.0-ONNX',
      options: { dtype: 'q8', device: 'cpu' },
    },
    {
      text: 'The build is fixed.',
      generationOptions: { voice: 'af_heart', speed: 1.1 },
    },
    { outputPath: '/tmp/spoken.wav' },
  ]);
});

test('Kokoro streaming yields sentence PCM chunks before the complete text finishes', async () => {
  const calls = [];
  const chunks = [];
  const secondSentence = {};
  secondSentence.ready = new Promise((resolve) => {
    secondSentence.release = resolve;
  });
  const stream = streamKokoroAudio({
    text: 'First sentence. Second sentence.',
    voice: 'af_heart',
    speed: 1.1,
    loadModel: async (modelId, options) => {
      calls.push({ modelId, options });
      return {
        async *stream(sentences, generationOptions) {
          calls.push({ generationOptions });
          let index = 0;
          for await (const sentence of sentences) {
            if (index === 1) await secondSentence.ready;
            yield {
              text: sentence,
              audio: {
                audio: new Float32Array([index + 0.25]),
                sampling_rate: 24000,
              },
            };
            index += 1;
          }
        },
      };
    },
  });

  const first = await stream.next();
  chunks.push(first.value);
  assert.equal(first.done, false);
  assert.equal(first.value.text, 'First sentence.');
  assert.equal(first.value.sampleRate, 24000);
  assert.equal(first.value.pcm.readFloatLE(0), 0.25);

  secondSentence.release();
  for await (const chunk of stream) chunks.push(chunk);

  assert.deepEqual(chunks.map((chunk) => chunk.text), [
    'First sentence.',
    'Second sentence.',
  ]);
  assert.equal(chunks[1].pcm.readFloatLE(0), 1.25);
  assert.deepEqual(calls, [
    {
      modelId: 'onnx-community/Kokoro-82M-v1.0-ONNX',
      options: { dtype: 'q8', device: 'cpu' },
    },
    {
      generationOptions: { voice: 'af_heart', speed: 1.1 },
    },
  ]);
});

test('Kokoro speaker renders and plays agent messages sequentially', async () => {
  const events = [];
  const speaker = new KokoroSpeaker({
    render: async ({ text, outputPath }) => {
      events.push(`render:${text}:${outputPath}`);
    },
    play: async (outputPath) => {
      events.push(`play:${outputPath}`);
    },
    allocateOutputPath: (() => {
      let next = 0;
      return () => `/tmp/kokoro-${++next}.wav`;
    })(),
    remove: async (outputPath) => {
      events.push(`remove:${outputPath}`);
    },
  });

  await Promise.all([
    speaker.speak('First message.'),
    speaker.speak('Second message.'),
  ]);

  assert.deepEqual(events, [
    'render:First message.:/tmp/kokoro-1.wav',
    'play:/tmp/kokoro-1.wav',
    'remove:/tmp/kokoro-1.wav',
    'render:Second message.:/tmp/kokoro-2.wav',
    'play:/tmp/kokoro-2.wav',
    'remove:/tmp/kokoro-2.wav',
  ]);
});

test('voice demo transcribes audio, runs a Codex turn, and speaks agent messages', async () => {
  const rpc = new FakeRpc({ emitAgentMessages: true });
  const spoken = [];
  const result = await runVoiceDemo({
    audioPath: '/tmp/request.wav',
    whisperModel: '/models/whisper.bin',
    threadId: 'thread-123',
  }, {
    rpc,
    transcribe: async (options) => {
      assert.equal(options.audioPath, '/tmp/request.wav');
      assert.equal(options.modelPath, '/models/whisper.bin');
      return 'Run the tests.';
    },
    speaker: {
      async speak(text) {
        spoken.push(text);
      },
    },
    log() {},
  });

  assert.equal(rpc.requests.at(-1).method, 'turn/start');
  assert.equal(rpc.requests.at(-1).params.input[0].text, 'Run the tests.');
  assert.deepEqual(spoken, ['I’ll run the tests.', 'All tests pass.']);
  assert.equal(result.threadId, 'thread-123');
});

test('voice demo CLI parses the source thread, Whisper model, and Kokoro voice', () => {
  assert.deepEqual(parseVoiceArgs([
    '--thread', 'thread-123',
    '--audio', '/tmp/request.wav',
    '--whisper-model', '/models/whisper.bin',
    '--voice', 'bf_emma',
    '--kokoro-dtype', 'q4',
  ]), {
    threadId: 'thread-123',
    audioPath: '/tmp/request.wav',
    whisperModel: '/models/whisper.bin',
    voice: 'bf_emma',
    kokoroDtype: 'q4',
  });
});

test('voice demo app-server is pinned to the active local Responses proxy', () => {
  assert.deepEqual(appServerArgs({
    proxyPort: 11436,
    modelCatalogPath: '/codex/models.json',
  }), [
    'app-server',
    '--stdio',
    '-c', 'model_provider="codex-universal-proxy"',
    '-c', 'model_catalog_json="/codex/models.json"',
    '-c', 'model_providers.codex-universal-proxy.name="Codex Universal Proxy"',
    '-c', 'model_providers.codex-universal-proxy.base_url="http://127.0.0.1:11436/v1/"',
    '-c', 'model_providers.codex-universal-proxy.wire_api="responses"',
    '-c', 'model_providers.codex-universal-proxy.requires_openai_auth=true',
  ]);
});

test('app-server spawn errors reject pending RPC work instead of crashing', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stdin = new PassThrough();
  child.killed = false;
  child.kill = () => { child.killed = true; };
  const appServer = startAppServer('missing-codex', {
    proxyPort: 11436,
    spawnProcess() {
      return child;
    },
  });

  const pending = appServer.rpc.request('initialize', {});
  child.emit('error', new Error('spawn missing-codex ENOENT'));

  await assert.rejects(pending, /spawn missing-codex ENOENT/u);
  appServer.close();
});

test('RPC requests made after an app-server spawn error reject immediately', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stdin = new PassThrough();
  child.killed = false;
  child.kill = () => { child.killed = true; };
  const appServer = startAppServer('missing-codex', {
    proxyPort: 11436,
    spawnProcess() {
      return child;
    },
  });

  child.emit('error', new Error('spawn failed before initialize'));

  await assert.rejects(
    appServer.rpc.request('initialize', {}),
    /spawn failed before initialize/u,
  );
  appServer.close();
});

test('speakable message collector emits commentary, unknown-phase, and final messages once', () => {
  const collector = new SpeakableAgentMessages();
  const notifications = [
    completedAgentMessage('one', 'I’ll inspect that first.', 'commentary'),
    completedAgentMessage('two', 'The command is still running.', null),
    completedAgentMessage('three', 'The build is fixed.', 'final_answer'),
    completedAgentMessage('three', 'The build is fixed.', 'final_answer'),
    {
      method: 'item/completed',
      params: { item: { id: 'tool', type: 'commandExecution', status: 'completed' } },
    },
  ];

  assert.deepEqual(
    notifications.flatMap((notification) => collector.accept(notification)),
    ['I’ll inspect that first.', 'The command is still running.', 'The build is fixed.'],
  );
});

function completedAgentMessage(id, text, phase) {
  return {
    method: 'item/completed',
    params: {
      threadId: 'thread-123',
      turnId: 'turn-123',
      item: { id, type: 'agentMessage', text, phase },
    },
  };
}

class FakeRpc extends EventEmitter {
  constructor({ emitAgentMessages = false, disconnectDuringTurn = false } = {}) {
    super();
    this.requests = [];
    this.notifications = [];
    this.emitAgentMessages = emitAgentMessages;
    this.disconnectDuringTurn = disconnectDuringTurn;
  }

  async request(method, params) {
    this.requests.push({ method, params });
    if (method === 'turn/start') {
      queueMicrotask(() => {
        if (this.disconnectDuringTurn) {
          this.emit('close', new Error('app-server disconnected'));
          return;
        }
        if (this.emitAgentMessages) {
          this.emit('notification', completedAgentMessage(
            'commentary',
            'I’ll run the tests.',
            'commentary',
          ));
          this.emit('notification', completedAgentMessage(
            'final',
            'All tests pass.',
            'final_answer',
          ));
        }
        this.emit('notification', {
          method: 'turn/completed',
          params: {
            threadId: params.threadId,
            turn: { id: 'turn-123', status: 'completed', items: [] },
          },
        });
      });
      return { turn: { id: 'turn-123', status: 'inProgress', items: [] } };
    }
    if (method === 'thread/resume') {
      return { thread: { id: params.threadId, turns: [] } };
    }
    if (method === 'thread/start') {
      return { thread: { id: 'thread-created', turns: [] } };
    }
    return { userAgent: 'test' };
  }

  notify(method, params) {
    this.notifications.push({ method, params });
  }
}
