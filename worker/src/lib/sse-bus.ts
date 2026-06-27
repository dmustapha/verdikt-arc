import { EventEmitter } from 'node:events';
import type { SSEEvent, SSEType } from '../types.js';

class SSEBus {
  private emitter = new EventEmitter();
  private history = new Map<string, SSEEvent[]>(); // replay for late subscribers

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  publish(workId: `0x${string}`, type: SSEType, data: unknown): void {
    const ev: SSEEvent = { type, workId, data, ts: Date.now() };
    const list = this.history.get(workId) ?? [];
    list.push(ev);
    this.history.set(workId, list);
    this.emitter.emit(workId, ev);
  }

  subscribe(workId: `0x${string}`, fn: (ev: SSEEvent) => void): () => void {
    // Replay anything already emitted so a late-connecting dashboard sees the full run.
    for (const ev of this.history.get(workId) ?? []) fn(ev);
    this.emitter.on(workId, fn);
    return () => this.emitter.off(workId, fn);
  }
}

export const sseBus = new SSEBus();
