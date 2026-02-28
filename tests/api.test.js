/**
 * Sym Research API — Integration Tests
 * Uses Node.js built-in test runner (node:test)
 * Run: npm test
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

const BASE_URL = 'http://localhost:3200';
const INTERNAL_KEY = 'd16896c294bcd842c69fb59c46ddb84d9736cbb053c020124f0eb80653bd1e91';
const HEADERS = {
  'Content-Type': 'application/json',
  'X-Research-Key': INTERNAL_KEY,
};

// ─── Health ──────────────────────────────────────────────────────────────────

describe('Health', () => {
  it('GET /health returns ok', async () => {
    const res = await fetch(`${BASE_URL}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
  });
});

// ─── Auth ─────────────────────────────────────────────────────────────────────

describe('Auth middleware', () => {
  it('POST /api/research without key returns 403', async () => {
    const res = await fetch(`${BASE_URL}/api/research`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'test' }),
    });
    assert.equal(res.status, 403);
  });

  it('POST /api/research with unknown key gets free-tier access (graceful degradation)', async () => {
    // Unknown keys get free-tier rate-limited access — not rejected outright
    const res = await fetch(`${BASE_URL}/api/research`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Research-Key': 'unknown-key' },
      body: JSON.stringify({ query: 'HVAC pricing' }),
    });
    // Either 200 (allowed under free tier) or 429 (rate limited) — both valid
    assert.ok([200, 429].includes(res.status), `expected 200 or 429, got ${res.status}`);
  });
});

// ─── Rate Limiting ────────────────────────────────────────────────────────────

describe('Rate limiting', () => {
  it('GET /api/analytics requires auth', async () => {
    const res = await fetch(`${BASE_URL}/api/analytics`);
    assert.equal(res.status, 403);
  });

  it('GET /api/analytics with internal key returns stats', async () => {
    const res = await fetch(`${BASE_URL}/api/analytics`, {
      headers: { 'X-Research-Key': INTERNAL_KEY },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok('total' in body, 'should have total field');
  });
});

// ─── Key Management ──────────────────────────────────────────────────────────

describe('Key Management', () => {
  it('GET /api/keys without email returns 400', async () => {
    const res = await fetch(`${BASE_URL}/api/keys`);
    assert.equal(res.status, 400);
  });

  it('GET /api/keys with email returns array', async () => {
    const res = await fetch(`${BASE_URL}/api/keys?email=test@example.com`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body), 'should return an array');
  });

  it('POST /api/keys/generate with missing fields returns 400', async () => {
    const res = await fetch(`${BASE_URL}/api/keys/generate`, {
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
    const res = await fetch(`${BASE_URL}/api/research/feedback`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({ query_hash: 'abc', result_url: 'https://x.com', signal: 'invalid' }),
    });
    assert.equal(res.status, 400);
  });

  it('POST /api/research/feedback with valid payload returns ok', async () => {
    const res = await fetch(`${BASE_URL}/api/research/feedback`, {
      method: 'POST',
      headers: HEADERS,
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
    const res = await fetch(`${BASE_URL}/api/stripe/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'test@co.com' }),
    });
    assert.ok([400, 503].includes(res.status), `expected 400 or 503, got ${res.status}`);
  });
});
