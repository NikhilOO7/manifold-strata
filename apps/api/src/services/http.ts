/**
 * Outbound HTTP with mandatory deadlines and size caps.
 *
 * Every external call this service makes (arXiv metadata, PDF download, LLM
 * completion, embeddings) happens inside a background worker slot. A socket that
 * hangs open therefore does not just slow one request down — it permanently
 * consumes one of `JOB_CONCURRENCY` slots, and a job left mid-flight stays in a
 * non-terminal state forever. Two hung sockets on the default config are a dead
 * ingestion pipeline with no error anywhere.
 *
 * `fetch` has no default timeout, so every call site must pass one. This module
 * is the single place that guarantees it, and it turns aborts into a labelled,
 * actionable error instead of the opaque `TypeError: fetch failed`.
 */

/** Raised when a request exceeds its deadline. Distinguishable from a transport error. */
export class HttpTimeoutError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`${label} timed out after ${timeoutMs}ms`);
    this.name = 'HttpTimeoutError';
  }
}

/** Raised when a response body exceeds its declared cap. */
export class HttpTooLargeError extends Error {
  constructor(label: string, maxBytes: number) {
    super(`${label} response exceeded the ${(maxBytes / 1024 / 1024).toFixed(1)} MB limit`);
    this.name = 'HttpTooLargeError';
  }
}

function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Per-dependency deadlines. Local LLM inference is legitimately slow (a 1b model
 * on CPU can take a minute for a long chunk), so it gets the widest budget;
 * metadata lookups get the tightest.
 */
export const TIMEOUTS = {
  get llm() {
    return envMs('LLM_TIMEOUT_MS', 120_000);
  },
  get embed() {
    return envMs('EMBED_TIMEOUT_MS', 60_000);
  },
  get pdf() {
    return envMs('PDF_TIMEOUT_MS', 60_000);
  },
  /**
   * arXiv's export API is genuinely slow — measured at ~12s for a single-id
   * query on an ordinary connection, and it asks clients to rate-limit
   * themselves. A tighter budget turns normal upstream latency into spurious
   * ingestion failures, so this is deliberately generous while still bounded.
   */
  get metadata() {
    return envMs('METADATA_TIMEOUT_MS', 45_000);
  },
  get healthcheck() {
    return envMs('HEALTHCHECK_TIMEOUT_MS', 5_000);
  },
};

/** Max bytes we will pull into memory for a downloaded PDF. */
export function maxPdfBytes(): number {
  const raw = Number(process.env.MAX_PDF_MB);
  const mb = Number.isFinite(raw) && raw > 0 ? raw : 50;
  return mb * 1024 * 1024;
}

function isAbort(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'AbortError' || err.name === 'TimeoutError' || err.name === 'HttpTimeoutError')
  );
}

export interface FetchOptions {
  /** Hard deadline for headers + connection. Required — there is no safe default. */
  timeoutMs: number;
  /** Human-readable dependency name used in error messages, e.g. "arXiv API". */
  label: string;
}

/**
 * `fetch` with a deadline. The signal covers connection, TLS, and time-to-headers;
 * body reads are bounded separately by {@link readBodyWithLimit}.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  { timeoutMs, label }: FetchOptions
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (isAbort(err)) throw new HttpTimeoutError(label, timeoutMs);
    throw new Error(
      `${label} request failed: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    );
  }
}

/**
 * Read a response body into a Buffer, refusing to buffer more than `maxBytes`.
 *
 * `response.arrayBuffer()` will happily allocate however many bytes the remote
 * sends; an attacker-controlled or merely broken URL can OOM the process. This
 * streams and bails the moment the cap is crossed, so the ceiling is real rather
 * than advisory.
 */
export async function readBodyWithLimit(
  response: Response,
  maxBytes: number,
  label: string
): Promise<Buffer> {
  // Trust a declared Content-Length only to fail *early* — never to skip the
  // streaming check, since it is remote-controlled and may be absent or a lie.
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new HttpTooLargeError(label, maxBytes);
  }

  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new HttpTooLargeError(label, maxBytes);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    // Release the socket whether we finished or bailed out early.
    await reader.cancel().catch(() => {});
  }

  return Buffer.concat(chunks, total);
}
