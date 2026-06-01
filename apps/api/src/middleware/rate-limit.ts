import type { Context, MiddlewareHandler } from 'hono';

interface Bucket {
  count: number;
  resetAt: number;
}

interface RateLimitOptions {
  windowMs: number;
  limit: number;
  /** Derive the client key. Defaults to forwarded IP, falling back to "global". */
  key?: (c: Context) => string;
}

/**
 * Lightweight in-memory fixed-window rate limiter — no Redis dependency, fine for
 * a single API instance. Protects expensive endpoints (LLM-backed ingestion and
 * processing) from being spammed and burning the inference budget. For a
 * multi-instance deployment, back this with a shared store (e.g. Redis).
 */
export function rateLimit(opts: RateLimitOptions): MiddlewareHandler {
  const buckets = new Map<string, Bucket>();
  const keyOf =
    opts.key ??
    ((c: Context) =>
      c.req.header('x-forwarded-for')?.split(',')[0].trim() ||
      c.req.header('x-real-ip') ||
      'global');

  return async (c, next) => {
    const now = Date.now();
    const k = keyOf(c);

    // Opportunistic cleanup so the Map doesn't grow unbounded across many clients.
    if (buckets.size > 10_000) {
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
