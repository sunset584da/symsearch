/**
 * Sym Research API — Integration Tests
 * Uses Node.js built-in test runner + supertest
 * Run: npm test
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.RESEARCH_INTERNAL_KEY = 'test-internal-key';
process.env.SEARCH_INTERNAL_KEY = 'test-internal-key';
process.env.GROQ_API_KEY = '';
process.env.SUPABASE_URL = '';
process.env.SUPABASE_ANON_KEY = '';
process.env.STRIPE_SECRET_KEY = '';
process.env.SYMSEARCH_SKIP_LISTEN = '1';

const { app } = await import('../index.js');

const INTERNAL_KEY = 'test-internal-key';
let server;
let baseUrl;

before(async () => {
  server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (!server) return;
  await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

// ─── Health ──────────────────────────────────────────────────────────────────

describe('Health', () => {
  it('GET /health returns ok', async () => {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
  });
});

// ─── Auth ─────────────────────────────────────────────────────────────────────

describe('Auth middleware', () => {
  it('POST /api/research without key returns 403', async () => {
    const res = await fetch(`${baseUrl}/api/research`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'test' }),
    });
    assert.equal(res.status, 403);
  });

  it('POST /api/research with unknown key still reaches query validation', async () => {
    const res = await fetch(`${baseUrl}/api/research`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Research-Key': 'unknown-key' },
      body: JSON.stringify({ query: '' }),
    });
    assert.equal(res.status, 400);
  });
});

// ─── Rate Limiting ────────────────────────────────────────────────────────────

describe('Rate limiting', () => {
  it('GET /api/analytics requires auth', async () => {
    const res = await fetch(`${baseUrl}/api/analytics`);
    assert.equal(res.status, 403);
  });

  it('GET /api/analytics with internal key returns stats', async () => {
    const res = await fetch(`${baseUrl}/api/analytics`, {
      headers: { 'X-Research-Key': INTERNAL_KEY },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok('analytics' in body, 'should have analytics field');
    assert.ok('telemetry' in body, 'should have telemetry field');
  });
});

// ─── Key Management ──────────────────────────────────────────────────────────

describe('Key Management', () => {
  it('GET /api/keys without email returns 400', async () => {
    const res = await fetch(`${baseUrl}/api/keys`);
    assert.equal(res.status, 400);
  });

  it('GET /api/keys with email returns array', async () => {
    const res = await fetch(`${baseUrl}/api/keys?email=test@example.com`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body), 'should return an array');
  });

  it('POST /api/keys/generate with missing fields returns 400', async () => {
    const res = await fetch(`${baseUrl}/api/keys/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  });
});

// ─── Feedback ─────────────────────────────────────────────────────────────────

describe('Feedback', () => {
  it('POST /api/research/feedback with invalid signal returns 400', async () => {
    const res = await fetch(`${baseUrl}/api/research/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Research-Key': INTERNAL_KEY },
      body: JSON.stringify({ query_hash: 'abc', result_url: 'https://x.com', signal: 'invalid' }),
    });
    assert.equal(res.status, 400);
  });

  it('POST /api/research/feedback with valid payload returns ok', async () => {
    const res = await fetch(`${baseUrl}/api/research/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Research-Key': INTERNAL_KEY },
      body: JSON.stringify({
        query_hash: 'test_hash_' + Date.now(),
        result_url: 'https://example.com',
        signal: 'up',
        role: 'owner',
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
  });
});

// ─── Stripe ───────────────────────────────────────────────────────────────────

describe('Stripe', () => {
  it('POST /api/stripe/checkout without price_id returns 400 or 503', async () => {
    const res = await fetch(`${baseUrl}/api/stripe/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'test@co.com' }),
    });
    assert.ok([400, 503].includes(res.status), `expected 400 or 503, got ${res.status}`);
  });
});
