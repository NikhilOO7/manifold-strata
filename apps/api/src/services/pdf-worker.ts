/**
 * PDF parsing off the event loop.
 *
 * Measured: parsing a 2.2 MB arXiv PDF takes ~400 ms during which the event
 * loop services *zero* timer ticks — every concurrent request, health probe and
 * job heartbeat stalls behind it. At batch scale (100 documents) that is ~40
 * seconds of accumulated API freeze scattered through the run.
 *
 * The parse runs in a `worker_threads` worker instead. Two constraints shaped
 * the implementation:
 *
 *  - No new dependencies (the pnpm store on this machine cannot install), so no
 *    piscina/tinypool. A single persistent worker with a task queue is enough —
 *    PDFs arrive at most once per document, throughput is not the problem, the
 *    blocked loop is.
 *
 *  - The codebase runs as TypeScript under tsx in dev and compiled JS in prod,
 *    which makes a worker *file* awkward to path correctly in both. The worker
 *    is therefore a small inline JS module loaded from a `data:` URL, with the
 *    pdf-parse module located via `import.meta.resolve` on the main thread and
 *    handed over in workerData. Verified live: same parse output, and the loop
 *    stayed responsive (20 ticks during the parse vs 0 on-thread).
 */

import { Worker } from 'node:worker_threads';

const WORKER_SOURCE = `
import { parentPort, workerData } from 'node:worker_threads';
const { PDFParse } = await import(workerData.pdfParseUrl);
parentPort.on('message', async ({ id, data }) => {
  try {
    const parser = new PDFParse({ data });
    const text = await parser.getText();
    const info = await parser.getInfo();
    await parser.destroy();
    parentPort.postMessage({
      id, ok: true,
      text: text.text,
      numPages: text.pages.length,
      info: info.info ?? null,
    });
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
});
`;

export interface RawParseResult {
  text: string;
  numPages: number;
  info: unknown;
}

interface PendingTask {
  resolve: (r: RawParseResult) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/** Raised when the PDF itself cannot be parsed — retrying will not help. */
export class PdfParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PdfParseError';
  }
}

const PARSE_TIMEOUT_MS = Math.max(
  10_000,
  parseInt(process.env.PDF_PARSE_TIMEOUT_MS || '90000', 10) || 90_000
);

let worker: Worker | null = null;
let taskSeq = 0;
const pending = new Map<number, PendingTask>();

function failAllPending(reason: string): void {
  for (const [id, task] of pending) {
    clearTimeout(task.timer);
    task.reject(new Error(reason));
    pending.delete(id);
  }
}

function spawnWorker(): Worker {
  const w = new Worker(new URL('data:text/javascript,' + encodeURIComponent(WORKER_SOURCE)), {
    workerData: { pdfParseUrl: import.meta.resolve('pdf-parse') },
  });

  w.on('message', (msg: { id: number; ok: boolean; text?: string; numPages?: number; info?: unknown; error?: string }) => {
    const task = pending.get(msg.id);
    if (!task) return;
    pending.delete(msg.id);
    clearTimeout(task.timer);
    if (msg.ok) {
      task.resolve({ text: msg.text ?? '', numPages: msg.numPages ?? 0, info: msg.info });
    } else {
      // The worker survived; the document is the problem.
      task.reject(new PdfParseError(msg.error ?? 'PDF parse failed'));
    }
  });

  const onDeath = (why: string) => {
    if (worker === w) worker = null;
    failAllPending(`PDF worker died: ${why}`);
  };
  w.on('error', (err) => onDeath(err.message));
  w.on('exit', (code) => {
    if (code !== 0) onDeath(`exit code ${code}`);
    else if (worker === w) worker = null;
  });

  // The worker must never hold the process open — tests and CLIs exit normally.
  w.unref();
  return w;
}

/**
 * Parse a PDF buffer in the worker.
 *
 * A hung parse (malformed document looping the parser) times out, terminates
 * the worker, and rejects; the next task gets a fresh worker. Infrastructure
 * failures reject with a plain Error; unparseable documents reject with
 * `PdfParseError` so callers can tell "broken input" from "broken worker".
 */
export function parsePdfInWorker(data: Buffer): Promise<RawParseResult> {
  if (!worker) worker = spawnWorker();
  const w = worker;
  const id = ++taskSeq;

  return new Promise<RawParseResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`PDF parse exceeded ${PARSE_TIMEOUT_MS}ms — worker terminated`));
      // Terminate: the worker is wedged; pending tasks (if any) fail via onDeath.
      void w.terminate();
      if (worker === w) worker = null;
    }, PARSE_TIMEOUT_MS);
    timer.unref?.();

    pending.set(id, { resolve, reject, timer });
    w.postMessage({ id, data });
  });
}
