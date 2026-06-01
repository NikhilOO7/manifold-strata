import type { MiddlewareHandler } from 'hono';

/**
 * Optional API-key authentication.
 *
 * If `API_KEY` is set, protected routes require it via either
 * `Authorization: Bearer <key>` or `X-API-Key: <key>`. If `API_KEY` is unset
 * (the default for local dev), auth is a no-op so the app works out of the box —
 * the startup banner warns when this is the case.
 */
export function apiKeyAuth(): MiddlewareHandler {
  const apiKey = process.env.API_KEY;

  return async (c, next) => {
    if (!apiKey) return next();

    const header = c.req.header('authorization');
    const bearer = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
    const provided = bearer || c.req.header('x-api-key');

    if (provided !== apiKey) {
      return c.json(
        {
          error: 'Unauthorized',
          message: 'Provide a valid API key via "Authorization: Bearer <key>" or "X-API-Key: <key>".',
        },
        401
      );
    }

    return next();
  };
}

export function authEnabled(): boolean {
  return Boolean(process.env.API_KEY);
}
