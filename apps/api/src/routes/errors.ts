/**
 * One place that turns a thrown domain/transport error into the right HTTP
 * status.
 *
 * Routes here wrap their bodies in `try { … } catch { return 500 }`. That is
 * fine for genuinely unexpected failures, but it also flattened *caller* errors
 * — an unregistered `?domain=` became "500 Failed to fetch nodes" instead of a
 * 400 naming the valid domains, and an upstream timeout became a 500 that looks
 * like our bug. Mapping in one function keeps every route's catch honest without
 * duplicating the classification.
 */

import type { Context } from 'hono';
import { UnknownDomainError } from '../domains';
import { HttpTimeoutError, HttpTooLargeError } from '../services/http';
import { LLMUnavailableError, LLMStructuredOutputError } from '../services/llm';
import { AuthenticationError, AuthorizationError } from '../auth/principal';

/**
 * Postgres UUID columns reject a malformed literal with a query error, which the
 * catch blocks turned into a 500 — so `/api/graph/nodes/not-a-uuid` read as a
 * server fault rather than a bad request. Route params are validated before they
 * reach the database instead.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string | undefined | null): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

export function routeError(c: Context, error: unknown, fallbackMessage: string) {
  if (error instanceof AuthenticationError) {
    return c.json({ error: 'Unauthorized', message: error.message }, 401);
  }

  if (error instanceof AuthorizationError) {
    // 403, not 404. The domain registry is public (`GET /api/domains`), so
    // naming a domain the caller cannot use leaks nothing — and "you may not"
    // is actionable where "not found" would send an operator hunting for a
    // missing row. Node-level lookups still 404 across a boundary, because
    // there the existence of the row is itself the secret.
    return c.json(
      {
        error: 'Forbidden',
        message: error.message,
        ...(error.domain ? { domain: error.domain } : {}),
        ...(error.requiredScope ? { requiredScope: error.requiredScope } : {}),
      },
      403
    );
  }

  if (error instanceof UnknownDomainError) {
    return c.json(
      {
        error: 'Unknown domain',
        message: error.message,
        requested: error.requested,
        knownDomains: error.known,
      },
      400
    );
  }

  if (error instanceof HttpTimeoutError) {
    return c.json({ error: 'Upstream timeout', message: error.message }, 504);
  }

  if (error instanceof HttpTooLargeError) {
    return c.json({ error: 'Upstream response too large', message: error.message }, 502);
  }

  if (error instanceof LLMUnavailableError) {
    return c.json(
      {
        error: 'Language model unavailable',
        message: error.message,
        hint: 'Check /health for the configured provider and model.',
      },
      503
    );
  }

  if (error instanceof LLMStructuredOutputError) {
    return c.json(
      {
        error: 'Language model returned unusable output',
        message: error.message,
      },
      502
    );
  }

  console.error(`${fallbackMessage}:`, error);
  return c.json(
    {
      error: fallbackMessage,
      message: error instanceof Error ? error.message : String(error),
    },
    500
  );
}
