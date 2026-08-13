/**
 * Job handler registry — the binding between lanes and the code they run.
 *
 * Called once at startup, before `startWorkers()`. Kept separate from the queue
 * module so the queue knows nothing about arXiv or extraction, and separate from
 * the routes so the routes know nothing about execution: routes insert rows,
 * this wires what a claimed row *does*.
 */

import { registerHandler } from '../queue';
import { runArxivIngestJob } from './arxiv-ingest';
import { runProcessJob } from './process-paper';
import { runAuditJob } from './audit-graph';

export function registerDefaultHandlers(): void {
  registerHandler('ingest', runArxivIngestJob);
  registerHandler('process', runProcessJob);
  registerHandler('audit', runAuditJob);
}
