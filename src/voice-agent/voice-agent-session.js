'use strict';

const VOICE_TURN_INSTRUCTIONS = [
  'This is a spoken voice interaction.',
  'Before calling any tool, give one short natural spoken acknowledgement describing what you are about to do. Do not claim the work is complete.',
  'After tool execution, always provide a concise user-facing spoken result.',
  'Never end a turn with only a tool call or tool output.',
  'Avoid markdown, code blocks, raw URLs, and long lists unless the user asks for them.',
].join('\n');

function buildVoiceTurnParams(threadId, transcript) {
  if (!threadId || typeof threadId !== 'string') throw new Error('threadId is required');
  if (!transcript || typeof transcript !== 'string') throw new Error('transcript is required');
  return {
    threadId,
    input: [{ type: 'text', text: transcript, text_elements: [] }],
    additionalContext: {
      'voice-agent-demo': {
        kind: 'application',
        value: VOICE_TURN_INSTRUCTIONS,
      },
    },
  };
}

class SpeakableAgentMessages {
  constructor() {
    this.seen = new Set();
  }

  accept(notification) {
    if (!notification || notification.method !== 'item/completed') return [];
    const item = notification.params && notification.params.item;
    if (!item || item.type !== 'agentMessage' || !String(item.text || '').trim()) return [];
    if (this.seen.has(item.id)) return [];
    this.seen.add(item.id);
    return [String(item.text).trim()];
  }
}

class VoiceAgentSession {
  constructor({ rpc }) {
    if (!rpc) throw new Error('rpc is required');
    this.rpc = rpc;
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return;
    await this.rpc.request('initialize', {
      clientInfo: {
        name: 'codex-universal-proxy-voice-demo',
        title: 'Codex Voice Agent Demo',
        version: '0.1.0',
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    this.rpc.notify('initialized', {});
    this.initialized = true;
  }

  async runTurn({ threadId, cwd, transcript, onNotification = () => {} }) {
    await this.initialize();
    let activeThreadId = threadId;
    if (activeThreadId) {
      await this.rpc.request('thread/resume', {
        threadId: activeThreadId,
        excludeTurns: true,
      });
    } else {
      const startedThread = await this.rpc.request('thread/start', { cwd: cwd || process.cwd() });
      activeThreadId = startedThread && startedThread.thread && startedThread.thread.id;
      if (!activeThreadId) throw new Error('Codex app-server did not return a thread id');
    }
    let notificationListener;
    let closeListener;
    const cleanup = () => {
      if (notificationListener) this.rpc.off('notification', notificationListener);
      if (closeListener) this.rpc.off('close', closeListener);
    };
    const completed = new Promise((resolve, reject) => {
      notificationListener = (notification) => {
        try {
          onNotification(notification);
        } catch (error) {
          cleanup();
          reject(error);
          return;
        }
        if (notification.method !== 'turn/completed') return;
        if (notification.params && notification.params.threadId !== activeThreadId) return;
        cleanup();
        const turn = notification.params.turn;
        if (turn && turn.status === 'failed') {
          reject(new Error(turn.error && turn.error.message ? turn.error.message : 'Codex turn failed'));
          return;
        }
        resolve(turn);
      };
      closeListener = (error) => {
        cleanup();
        reject(error instanceof Error ? error : new Error('Codex app-server connection closed'));
      };
      this.rpc.on('notification', notificationListener);
      this.rpc.on('close', closeListener);
    });
    try {
      const started = await this.rpc.request(
        'turn/start',
        buildVoiceTurnParams(activeThreadId, transcript),
      );
      const turnId = started && started.turn && started.turn.id;
      const turn = await completed;
      if (turnId && turn && turn.id !== turnId) {
        throw new Error(`received completion for unexpected turn ${turn.id}`);
      }
      return { threadId: activeThreadId, turn };
    } catch (error) {
      cleanup();
      throw error;
    }
  }
}

module.exports = {
  SpeakableAgentMessages,
  VOICE_TURN_INSTRUCTIONS,
  VoiceAgentSession,
  buildVoiceTurnParams,
};
