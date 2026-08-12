/**
 * In-process event bus for live status push (SSE).
 *
 * The old UX polled `/status/:jobId` every 2s; that's idle DB load and laggy
 * updates. The worker, processor, and HTTP layer all run in ONE process here
 * (the documented single-instance design), so an EventEmitter is the right
 * primitive: status changes are emitted as they happen and the SSE endpoint
 * forwards them — true push, zero polling. For a multi-instance deployment this
 * bus is the seam to replace with Postgres LISTEN/NOTIFY or Redis pub/sub; the
 * emit/subscribe surface stays the same.
 */

import { EventEmitter } from 'events';

export interface JobEvent {
  type: 'job';
  jobId: string;
  status: string;
  paperId?: string | null;
  progress?: string | null;
  error?: string | null;
  at: string;
}

export interface PaperProgressEvent {
  type: 'paper';
  paperId: string;
  status: string;
  progress: number;
  at: string;
}

export type FieldEvent = JobEvent | PaperProgressEvent;

const emitter = new EventEmitter();
emitter.setMaxListeners(0); // one listener per open SSE connection; don't warn

export function emitJob(e: Omit<JobEvent, 'type' | 'at'>): void {
  emitter.emit('event', { type: 'job', at: new Date().toISOString(), ...e } satisfies JobEvent);
}

export function emitPaperProgress(e: Omit<PaperProgressEvent, 'type' | 'at'>): void {
  emitter.emit('event', { type: 'paper', at: new Date().toISOString(), ...e } satisfies PaperProgressEvent);
}

/** Subscribe to all status events; returns an unsubscribe function. */
export function onEvent(cb: (e: FieldEvent) => void): () => void {
  emitter.on('event', cb);
  return () => emitter.off('event', cb);
}
