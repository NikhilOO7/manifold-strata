/**
 * Rate limiting — a piece of code that looked like protection while providing
 * none, in two opposite directions at once.
 *
 * Credential handling moved to a principal model and is covered by auth.test.ts
 * (parsing, hashing, scopes, grants) and db/authorization.test.ts (end-to-end
 * enforcement through the real app).
 */

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { rateLimit } from '../middleware/rate-limit';

const originalHops = process.env.TRUSTED_PROXY_HOPS;
afterEach(() => {
  if (originalHops === undefined) delete process.env.TRUSTED_PROXY_HOPS;
  else process.env.TRUSTED_PROXY_HOPS = originalHops;
});

describe('rateLimit', () => {
  function limitedApp(limit = 3) {
    const app = new Hono();
    app.use('*', rateLimit({ windowMs: 60_000, limit }));
    app.get('/', (c) => c.json({ ok: true }));
    return app;
  }

  test('allows requests up to the limit, then returns 429 with Retry-After', async () => {
    const app = limitedApp(3);
    for (let i = 0; i < 3; i++) {
      assert.equal((await app.request('/')).status, 200, `request ${i + 1} should pass`);
    }
    const blocked = await app.request('/');
    assert.equal(blocked.status, 429);
    assert.ok(blocked.headers.get('retry-after'));
  });

  test('exposes remaining budget in headers', async () => {
    const res = await limitedApp(5).request('/');
    assert.equal(res.headers.get('x-ratelimit-limit'), '5');
    assert.equal(res.headers.get('x-ratelimit-remaining'), '4');
  });

  test('a spoofed X-Forwarded-For cannot mint fresh buckets by default', async () => {
    // The original limiter keyed on X-Forwarded-For unconditionally, so any client
    // could rotate the header per request and never be limited at all — the
    // protection on the LLM-backed routes was decorative.
    delete process.env.TRUSTED_PROXY_HOPS;
    const app = limitedApp(2);

    assert.equal((await app.request('/', { headers: { 'x-forwarded-for': '1.1.1.1' } })).status, 200);
    assert.equal((await app.request('/', { headers: { 'x-forwarded-for': '2.2.2.2' } })).status, 200);
    const third = await app.request('/', { headers: { 'x-forwarded-for': '3.3.3.3' } });
    assert.equal(third.status, 429, 'rotating the header must not reset the budget');
  });

  test('honours X-Forwarded-For only when a proxy hop count is declared', async () => {
    process.env.TRUSTED_PROXY_HOPS = '1';
    const app = limitedApp(1);

    assert.equal((await app.request('/', { headers: { 'x-forwarded-for': '1.1.1.1' } })).status, 200);
    // Same client again → limited.
    assert.equal((await app.request('/', { headers: { 'x-forwarded-for': '1.1.1.1' } })).status, 429);
    // A genuinely different client behind the same proxy → own budget.
    assert.equal((await app.request('/', { headers: { 'x-forwarded-for': '9.9.9.9' } })).status, 200);
  });

  test('with one trusted hop, a client-injected entry cannot impersonate another client', async () => {
    process.env.TRUSTED_PROXY_HOPS = '1';
    const app = limitedApp(1);

    // The proxy appends the real peer last; anything to its left came from the client.
    assert.equal(
      (await app.request('/', { headers: { 'x-forwarded-for': 'fake, 5.5.5.5' } })).status,
      200
    );
    assert.equal(
      (await app.request('/', { headers: { 'x-forwarded-for': 'other-fake, 5.5.5.5' } })).status,
      429,
      'the trusted right-most entry must decide identity'
    );
  });

  test('a custom key function is honoured', async () => {
    const app = new Hono();
    app.use('*', rateLimit({ windowMs: 60_000, limit: 1, key: (c) => c.req.header('x-tenant') ?? 'a' }));
    app.get('/', (c) => c.json({ ok: true }));

    assert.equal((await app.request('/', { headers: { 'x-tenant': 't1' } })).status, 200);
    assert.equal((await app.request('/', { headers: { 'x-tenant': 't1' } })).status, 429);
    assert.equal((await app.request('/', { headers: { 'x-tenant': 't2' } })).status, 200);
  });
});

describe('rate limits are budgeted by cost, not by path prefix', () => {
  test('reading job status is not throttled by the ingest write budget', async () => {
    // The bug this locks in: `/api/ingest/*` carried one strict limit, so the UI
    // polling `GET /api/ingest/status/:jobId` after starting a few ingests
    // exhausted it and got 429 for the status of jobs it had just created. A
    // limit that stops you observing work you already started protects nothing —
    // the expensive part has already happened.
    const app = new Hono();
    app.on(['POST'], '/api/ingest/*', rateLimit({ windowMs: 60_000, limit: 2 }));
    app.on('GET', '/api/ingest/*', rateLimit({ windowMs: 60_000, limit: 50 }));
    app.post('/api/ingest/arxiv', (c) => c.json({ ok: true }));
    app.get('/api/ingest/status/:id', (c) => c.json({ ok: true }));

    // Spend the entire write budget.
    assert.equal((await app.request('/api/ingest/arxiv', { method: 'POST' })).status, 200);
    assert.equal((await app.request('/api/ingest/arxiv', { method: 'POST' })).status, 200);
    assert.equal((await app.request('/api/ingest/arxiv', { method: 'POST' })).status, 429);

    // Polling must still work — that is the whole point of having started them.
    for (let i = 0; i < 20; i++) {
      const res = await app.request('/api/ingest/status/job-1');
      assert.equal(res.status, 200, `poll ${i + 1} should not be throttled`);
    }
  });

  test('writes are still limited independently of reads', async () => {
    const app = new Hono();
    app.on(['POST'], '/api/ingest/*', rateLimit({ windowMs: 60_000, limit: 1 }));
    app.on('GET', '/api/ingest/*', rateLimit({ windowMs: 60_000, limit: 50 }));
    app.post('/api/ingest/arxiv', (c) => c.json({ ok: true }));
    app.get('/api/ingest/status/:id', (c) => c.json({ ok: true }));

    await app.request('/api/ingest/status/job-1');
    await app.request('/api/ingest/status/job-2');
    // Reads did not consume the write budget.
    assert.equal((await app.request('/api/ingest/arxiv', { method: 'POST' })).status, 200);
    assert.equal((await app.request('/api/ingest/arxiv', { method: 'POST' })).status, 429);
  });
});
