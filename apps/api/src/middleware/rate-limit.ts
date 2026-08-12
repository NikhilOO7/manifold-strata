import type { Context, MiddlewareHandler } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';

interface Bucket {
  count: number;
  resetAt: number;
}

interface RateLimitOptions {
  windowMs: number;
  limit: number;
  /** Derive the client key. Defaults to the trusted client IP. */
  key?: (c: Context) => string;
}

/**
 * Number of reverse proxies in front of this API.
 *
 * `X-Forwarded-For` is appended to by each hop, so only the entries *added by
 * infrastructure you control* are trustworthy — anything a client sends arrives
 * as the leftmost entries. `TRUSTED_PROXY_HOPS=1` (one load balancer) means the
 * last entry is the real client; `0` (the default, direct exposure) means the
 * header is ignored entirely and the socket address is used.
 */
function trustedProxyHops(): number {
  const raw = parseInt(process.env.TRUSTED_PROXY_HOPS || '0', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

/**
 * Identify the client.
 *
 * The previous implementation read `X-Forwarded-For` unconditionally and fell
 * back to the literal string `"global"`. Both halves failed:
 *
 *  - Trusting the header made the limit opt-out. Any client could send a random
 *    `X-Forwarded-For` per request and get an unlimited number of fresh buckets,
 *    so the protection on the LLM-backed routes was decorative.
 *  - The `"global"` fallback applied on every direct connection (no proxy — the
 *    documented local setup), collapsing every caller into one shared bucket. Ten
 *    ingests from one user then locked out everyone else for a minute.
 *
 * Reading the socket address by default, and honouring `X-Forwarded-For` only
 * for the number of hops an operator declares, makes the limit both real and
 * per-client.
 */
export function clientKey(c: Context): string {
  const hops = trustedProxyHops();

  if (hops > 0) {
    const forwarded = c.req.header('x-forwarded-for');
    if (forwarded) {
      const chain = forwarded.split(',').map((p) => p.trim()).filter(Boolean);
      // Count back past the hops we control; anything further left is client-supplied.
      const candidate = chain[chain.length - hops];
      if (candidate) return candidate;
    }
  }

  try {
    const info = getConnInfo(c);
    if (info.remote.address) return info.remote.address;
  } catch {
    // Non-node adapter (or a test harness with no socket) — fall through.
  }

  // Last resort. Shared, but only reached when the runtime exposes no peer
  // address at all, which is strictly safer than handing out unlimited buckets.
  return 'unknown';
}

/**
 * Lightweight in-memory fixed-window rate limiter — no Redis dependency, fine for
 * a single API instance. Protects expensive endpoints (LLM-backed ingestion and
 * processing) from being spammed and burning the inference budget. For a
 * multi-instance deployment, back this with a shared store (e.g. Redis); note
 * that until then each instance enforces the limit independently.
 */
export function rateLimit(opts: RateLimitOptions): MiddlewareHandler {
  const buckets = new Map<string, Bucket>();
  const keyOf = opts.key ?? clientKey;
  let lastSweep = 0;

  return async (c, next) => {
    const now = Date.now();
    const k = keyOf(c);

    // Periodic sweep of expired buckets. Time-based rather than size-based: the
    // old `size > 10_000` trigger meant a burst of distinct clients could pin the
    // map at its high-water mark indefinitely, and it only ran while over the
    // threshold, so memory never came back down after the burst.
    if (now - lastSweep > opts.windowMs) {
      lastSweep = now;
      for (const [key, bucket] of buckets) {
        if (now >= bucket.resetAt) buckets.delete(key);
      }
    }

    let bucket = buckets.get(k);
    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + opts.windowMs };
      buckets.set(k, bucket);
    }
    bucket.count += 1;

    const remaining = Math.max(0, opts.limit - bucket.count);
    c.header('X-RateLimit-Limit', String(opts.limit));
    c.header('X-RateLimit-Remaining', String(remaining));
    c.header('X-RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));

    if (bucket.count > opts.limit) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      c.header('Retry-After', String(retryAfter));
      return c.json({ error: 'Too many requests. Please slow down.', retryAfter }, 429);
    }

    return next();
  };
}
