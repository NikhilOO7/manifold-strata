/**
 * A polite client for third-party APIs that rate-limit.
 *
 * Bulk ingest runs `JOB_CONCURRENCY` papers at once, and each one opens with a
 * metadata lookup. Firing those in parallel at arXiv earns a `429`, and because
 * the fetch had no retry every one of those jobs failed outright — the user
 * queued five papers and got five failures caused entirely by our own
 * impatience. arXiv asks callers to leave roughly three seconds between
 * requests; we were not asking, we were hammering.
 *
 * Two mechanisms, addressing two different problems:
 *
 *   throttle   Serialises requests to one host and enforces a minimum gap. This
 *              prevents the 429 rather than reacting to it, which matters because
 *              a rejected request still consumed the remote's budget.
 *
 *   backoff    When a 429 or 5xx arrives anyway, wait and retry — honouring
 *              `Retry-After` when the server sends it, since a server that tells
 *              you when to come back has given you better information than any
 *              formula.
 *
 * Deliberately not retried: 4xx other than 429. A malformed id or a missing
 * document returns the same answer however many times you ask, and retrying it
 * just moves the failure later while holding a worker slot.
 */

import { fetchWithTimeout, HttpTimeoutError, type FetchOptions } from './http';

/** Per-host serialisation: a promise chain plus the last completion time. */
const hostQueues = new Map<string, Promise<unknown>>();
const lastRequestAt = new Map<string, number>();

/**
 * Host-wide cooldown after a rejection.
 *
 * Per-request backoff alone is not enough: when five queued jobs each hit the
 * same host, each one independently discovers the 429 and independently retries,
 * so the host keeps receiving traffic through the entire backoff and has no
 * chance to forgive us. Measured exactly that — five bulk ingests exhausted four
 * retry rounds each and all failed.
 *
 * A shared deadline makes one rejection pause everybody, which is what the
 * remote was asking for in the first place.
 */
const cooldownUntil = new Map<string, number>();

function envMs(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

/** Minimum gap between requests to the same host. */
function minIntervalFor(host: string): number {
  if (host.includes('arxiv.org')) return envMs('ARXIV_MIN_INTERVAL_MS', 3_000);
  return envMs('DEFAULT_MIN_INTERVAL_MS', 0);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

/**
 * Parse `Retry-After`, which may be seconds or an HTTP date.
 *
 * Clamped to a sane ceiling: a server asking us to wait an hour should not
 * silently pin a worker slot for an hour.
 */
function retryAfterMs(response: Response): number | null {
  const header = response.headers.get('retry-after');
  if (!header) return null;

  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.min(Math.max(seconds, 0) * 1000, 60_000);

  const date = Date.parse(header);
  if (Number.isFinite(date)) {
    // A past date yields a negative delay; clamping at zero avoids handing a
    // negative duration to a timer.
    return Math.min(Math.max(date - Date.now(), 0), 60_000);
  }
  return null;
}

export interface PoliteFetchOptions extends FetchOptions {
  /** Attempts including the first. */
  attempts?: number;
}

/**
 * Fetch with per-host throttling and backoff on 429/5xx.
 *
 * Returns the `Response` for any status the caller should handle itself
 * (including a final 429 after exhausting attempts), so status handling stays
 * where the semantics live.
 */
export async function politeFetch(
  url: string,
  init: RequestInit,
  opts: PoliteFetchOptions
): Promise<Response> {
  const host = new URL(url).host;
  const attempts = Math.max(1, opts.attempts ?? 4);
  // Total patience for a throttled host is roughly 15+30+45s before giving up.

  // Chain onto this host's queue so concurrent callers take turns rather than
  // arriving together.
  const previous = hostQueues.get(host) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  hostQueues.set(host, previous.then(() => mine));

  try {
    await previous.catch(() => {});

    // Respect a cooldown another request earned on this host.
    const cooldown = (cooldownUntil.get(host) ?? 0) - Date.now();
    if (cooldown > 0) {
      console.warn(`[polite-fetch] waiting ${Math.round(cooldown / 1000)}s for ${host} cooldown`);
      await sleep(cooldown);
    }

    const minInterval = minIntervalFor(host);
    const since = Date.now() - (lastRequestAt.get(host) ?? 0);
    if (minInterval > 0 && since < minInterval) {
      await sleep(minInterval - since);
    }

    let lastResponse: Response | null = null;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      let response: Response;
      try {
        response = await fetchWithTimeout(url, init, opts);
      } catch (err) {
        // A timeout on the last attempt is the caller's problem; earlier ones
        // are worth another try, since transient slowness is common.
        if (attempt === attempts || !(err instanceof HttpTimeoutError)) throw err;
        await sleep(2 ** attempt * 1000);
        continue;
      } finally {
        lastRequestAt.set(host, Date.now());
      }

      lastResponse = response;

      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === attempts) return response;

      // A 429 means "you are over a budget", which takes longer to clear than a
      // transient 5xx. Backing off in single-digit seconds — as an exponential
      // curve does for the first few attempts — keeps arriving while the remote
      // is still counting us as over. Measured: four attempts spanning ~14s all
      // rejected, because the window had not moved.
      const isThrottled = response.status === 429;
      const backoffMs = isThrottled
        ? Math.min(15_000 * attempt, 60_000)
        : 2 ** attempt * 1000;
      const wait = retryAfterMs(response) ?? backoffMs;

      // Publish the wait so concurrent callers hold off too, instead of each
      // discovering the same rejection independently.
      if (response.status === 429) {
        cooldownUntil.set(host, Math.max(cooldownUntil.get(host) ?? 0, Date.now() + wait));
      }

      console.warn(
        `[polite-fetch] ${host} returned ${response.status}; retrying in ${Math.round(wait / 1000)}s ` +
          `(attempt ${attempt}/${attempts})`
      );
      // Drain the body so the socket is released before we sleep.
      await response.text().catch(() => {});
      await sleep(wait);
    }

    return lastResponse!;
  } finally {
    release();
    // Drop the queue entry once we are the tail, so hosts do not accumulate.
    if (hostQueues.get(host) === mine) hostQueues.delete(host);
  }
}
