import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.SYMSEARCH_SKIP_LISTEN = '1';
const analyticsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'symsearch-foundation-analytics-'));
process.env.SYMSEARCH_ANALYTICS_DIR = analyticsDir;

import { buildSearchCacheKey, dedupeSearchRequest, getCachedSearchResponse, setCachedSearchResponse } from '../lib/search-cache.js';
import { getLaneConfig, getLaneSearchEngines, resolveSearchLane } from '../lib/request-lane.js';
import { rankAndDiversifyResults } from '../lib/source-policy.js';
import { classifyIntent } from '../dist/intent-classifier.js';
const { getTypedIntent } = await import('../index.js');

after(() => {
  fs.rmSync(analyticsDir, { recursive: true, force: true });
});

describe('request lanes', () => {
  it('keeps customer lane as default', () => {
    assert.equal(resolveSearchLane('free', 'bot'), 'customer');
    assert.equal(resolveSearchLane('internal', 'customer'), 'customer');
  });

  it('allows bot lane only for privileged tiers', () => {
    assert.equal(resolveSearchLane('internal', 'bot'), 'bot');
    assert.equal(resolveSearchLane('enterprise', 'bot'), 'bot');
  });

  it('uses non-Brave engine sets', () => {
    const engines = getLaneSearchEngines('customer', 'pricing');
    assert.ok(!engines.includes('brave'));
    assert.ok(getLaneConfig('bot').resultLimit > getLaneConfig('customer').resultLimit);
  });
});

describe('search cache', () => {
  it('stores and returns cached responses by normalized key', () => {
    const key = buildSearchCacheKey({
      lane: 'customer',
      query: '  Carrier Error Code 33 ',
      role: 'tech',
      mode: 'technical',
      intent: 'troubleshooting',
    });

    setCachedSearchResponse(key, { ok: true }, 5000);
    assert.deepEqual(getCachedSearchResponse(key), { ok: true });
  });

  it('dedupes inflight work for identical requests', async () => {
    let runs = 0;
    const work = async () => {
      runs += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { ok: true };
    };

    const first = dedupeSearchRequest('same-key', work);
    const second = dedupeSearchRequest('same-key', work);
    const [a, b] = await Promise.all([first, second]);

    assert.equal(runs, 1);
    assert.equal(a.value.ok, true);
    assert.equal(b.value.ok, true);
    assert.equal(b.deduped, true);
  });
});

describe('source policy', () => {
  it('dedupes urls and limits domain concentration', () => {
    const ranked = rankAndDiversifyResults([
      { title: 'Carrier Code 33', url: 'https://www.carrier.com/support/error-33', snippet: 'Limit switch trip' },
      { title: 'Carrier Code 33 duplicate', url: 'https://carrier.com/support/error-33#section', snippet: 'Duplicate url' },
      { title: 'Carrier forum', url: 'https://carrier.com/forum/33', snippet: 'Second same domain result' },
      { title: 'Reddit thread', url: 'https://reddit.com/r/hvac/comments/abc', snippet: 'Field fixes' },
      { title: 'Manual', url: 'https://manualslib.com/carrier-59tp6.html', snippet: 'Install manual' },
    ], {
      intent: 'troubleshooting',
      query: 'carrier 59tp6 error code 33',
      limit: 10,
      maxPerDomain: 2,
    });

    const carrierCount = ranked.filter((item) => item.hostname === 'carrier.com').length;
    assert.equal(carrierCount, 2);
    assert.ok(ranked.length >= 3);
  });
});

describe('intent classifier', () => {
  it('routes permit and license queries into compliance', () => {
    const result = classifyIntent('HVAC permit Houston Texas license requirements');
    assert.equal(result.intent, 'compliance');
  });

  it('trusts explicit compliance mode when provided by the caller', () => {
    const result = getTypedIntent('totally ambiguous query', 'compliance');
    assert.equal(result.intent, 'compliance');
  });
});
