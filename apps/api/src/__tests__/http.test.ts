/**
 * Outbound-request guards.
 *
 * Every external call happens inside a background worker slot, so a socket with
 * no deadline is a permanently-consumed slot, and an unbounded body read is an
 * OOM waiting for a large enough PDF. Both are exercised against a real local
 * server rather than a stub, because the failure mode is in the transport.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  fetchWithTimeout,
  readBodyWithLimit,
  HttpTimeoutError,
  HttpTooLargeError,
} from '../services/http';
import { normalizeArxivId } from '../routes/ingest';

let server: Server;
let base = '';

before(async () => {
  server = createServer((req, res) => {
    if (req.url === '/hang') {
      // Headers never sent; the socket simply stays open.
      return;
    }
    if (req.url === '/big') {
      res.writeHead(200, { 'content-type': 'application/pdf' });
      // 1 MB in 16 KB chunks, no Content-Length — the streaming cap must catch it.
      let sent = 0;
      const chunk = Buffer.alloc(16 * 1024, 0x41);
      const pump = () => {
        while (sent < 1024 * 1024) {
          sent += chunk.length;
          if (!res.write(chunk)) {
            res.once('drain', pump);
            return;
          }
        }
        res.end();
      };
      pump();
      return;
    }
    if (req.url === '/declared-big') {
      res.writeHead(200, { 'content-length': String(500 * 1024 * 1024) });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('hello');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
});

describe('fetchWithTimeout', () => {
  test('returns a normal response', async () => {
    const res = await fetchWithTimeout(`${base}/ok`, {}, { timeoutMs: 2000, label: 'test' });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'hello');
  });

  test('aborts a hanging request instead of waiting forever', async () => {
    const started = Date.now();
    await assert.rejects(
      () => fetchWithTimeout(`${base}/hang`, {}, { timeoutMs: 250, label: 'hanging dependency' }),
      HttpTimeoutError
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 3000, `should abort promptly, took ${elapsed}ms`);
  });

  test('the timeout error names the dependency and the budget', async () => {
    try {
      await fetchWithTimeout(`${base}/hang`, {}, { timeoutMs: 200, label: 'arXiv API' });
      assert.fail('expected a timeout');
    } catch (err) {
      assert.ok(err instanceof HttpTimeoutError);
      assert.match(err.message, /arXiv API/);
      assert.match(err.message, /200ms/);
    }
  });

  test('a connection failure is labelled, not an opaque "fetch failed"', async () => {
    await assert.rejects(
      () =>
        fetchWithTimeout(
          'http://127.0.0.1:1/nothing',
          {},
          { timeoutMs: 1000, label: 'dead service' }
        ),
      /dead service request failed/
    );
  });
});

describe('readBodyWithLimit', () => {
  test('reads a small body normally', async () => {
    const res = await fetchWithTimeout(`${base}/ok`, {}, { timeoutMs: 2000, label: 'test' });
    const buf = await readBodyWithLimit(res, 1024, 'test');
    assert.equal(buf.toString(), 'hello');
  });

  test('refuses a body that exceeds the cap while streaming', async () => {
    const res = await fetchWithTimeout(`${base}/big`, {}, { timeoutMs: 5000, label: 'PDF' });
    await assert.rejects(() => readBodyWithLimit(res, 64 * 1024, 'PDF download'), HttpTooLargeError);
  });

  test('rejects early on a declared Content-Length over the cap', async () => {
    const res = await fetchWithTimeout(`${base}/declared-big`, {}, { timeoutMs: 2000, label: 'PDF' });
    await assert.rejects(() => readBodyWithLimit(res, 1024, 'PDF download'), HttpTooLargeError);
  });

  test('allows a body exactly at the cap', async () => {
    const res = await fetchWithTimeout(`${base}/ok`, {}, { timeoutMs: 2000, label: 'test' });
    const buf = await readBodyWithLimit(res, 5, 'test');
    assert.equal(buf.length, 5);
  });
});

describe('normalizeArxivId', () => {
  test('accepts new-style ids, with and without a version', () => {
    assert.equal(normalizeArxivId('2308.04079'), '2308.04079');
    assert.equal(normalizeArxivId('2308.04079v2'), '2308.04079v2');
    assert.equal(normalizeArxivId('1706.03762'), '1706.03762');
  });

  test('accepts old-style ids', () => {
    assert.equal(normalizeArxivId('cs/0112017'), 'cs/0112017');
    assert.equal(normalizeArxivId('math.GT/0309136'), 'math.GT/0309136');
  });

  test('strips the arXiv: prefix and surrounding whitespace', () => {
    assert.equal(normalizeArxivId('  arXiv:2308.04079 '), '2308.04079');
    assert.equal(normalizeArxivId('ARXIV:2308.04079'), '2308.04079');
  });

  test('rejects values that would alter the upstream URLs', () => {
    // The id is interpolated into the arXiv query string and the PDF path.
    assert.equal(normalizeArxivId('2308.04079&max_results=9999'), null);
    assert.equal(normalizeArxivId('../../etc/passwd'), null);
    assert.equal(normalizeArxivId('2308.04079 OR 1'), null);
    assert.equal(normalizeArxivId('https://evil.example/x'), null);
  });

  test('rejects malformed and non-string input', () => {
    assert.equal(normalizeArxivId(''), null);
    assert.equal(normalizeArxivId('not-an-id'), null);
    assert.equal(normalizeArxivId('230.0407'), null);
    assert.equal(normalizeArxivId(undefined), null);
    assert.equal(normalizeArxivId(42), null);
  });
});
