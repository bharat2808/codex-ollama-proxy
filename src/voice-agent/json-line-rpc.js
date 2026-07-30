'use strict';

const { EventEmitter } = require('node:events');
const { StringDecoder } = require('node:string_decoder');

class JsonLineRpcClient extends EventEmitter {
  constructor({ input, output }) {
    super();
    if (!input || !output) throw new Error('input and output streams are required');
    this.input = input;
    this.output = output;
    this.decoder = new StringDecoder('utf8');
    this.buffer = '';
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    this.closeError = null;
    this.onData = (chunk) => this.receive(this.decoder.write(chunk));
    this.onEnd = (error) => this.close(
      error instanceof Error ? error : new Error('Codex app-server connection closed'),
    );
    input.on('data', this.onData);
    input.once('end', this.onEnd);
    input.once('error', this.onEnd);
  }

  request(method, params) {
    if (this.closed) {
      return Promise.reject(this.closeError || new Error('JSON-RPC client closed'));
    }
    const id = this.nextId++;
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.write({ jsonrpc: '2.0', id, method, params });
    return promise;
  }

  notify(method, params) {
    this.write({ jsonrpc: '2.0', method, params });
  }

  write(message) {
    this.output.write(`${JSON.stringify(message)}\n`);
  }

  receive(text) {
    this.buffer += text;
    while (true) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        this.emit('protocolError', new Error(`invalid app-server JSON: ${error.message}`));
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(message, 'id')
        && (Object.prototype.hasOwnProperty.call(message, 'result')
          || Object.prototype.hasOwnProperty.call(message, 'error'))) {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        if (message.error) {
          pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
        } else {
          pending.resolve(message.result);
        }
        continue;
      }
      if (message.method && !Object.prototype.hasOwnProperty.call(message, 'id')) {
        this.emit('notification', message);
        continue;
      }
      if (message.method) this.emit('request', message);
    }
  }

  respond(id, result) {
    this.write({ jsonrpc: '2.0', id, result });
  }

  close(error = new Error('JSON-RPC client closed')) {
    if (this.closed) return;
    this.closed = true;
    this.closeError = error;
    this.input.off('data', this.onData);
    this.input.off('end', this.onEnd);
    this.input.off('error', this.onEnd);
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
    this.emit('close', error);
  }
}

module.exports = { JsonLineRpcClient };
