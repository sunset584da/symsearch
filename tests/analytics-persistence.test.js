import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const tempDirs = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.SYMSEARCH_ANALYTICS_DIR;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_ANON_KEY;
});

async function importFreshAnalytics(dir) {
  process.env.SYMSEARCH_ANALYTICS_DIR = dir;
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_ANON_KEY = '';

  const moduleUrl = pathToFileURL(path.join(process.cwd(), 'dist', 'analytics.js'));
  moduleUrl.searchParams.set('t', `${Date.now()}-${Math.random()}`);
  return import(moduleUrl.href);
}

describe('analytics persistence', () => {
  it('persists events locally and restores them after a fresh import', async () => {
    const analyticsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'symsearch-persist-'));
    tempDirs.push(analyticsDir);

    const firstLoad = await importFreshAnalytics(analyticsDir);
    await firstLoad.trackSearch({
      query: 'HVAC permit Houston Texas',
      intent: 'compliance',
      result_count: 4,
      latency_ms: 187,
      cache_hit: false,
      mode: 'compliance',
      role: 'owner',
      lane: 'bot',
      confidence: 0.91,
      deduped: false,
      chained: true,
    });

    const firstSummary = firstLoad.getSearchAnalyticsSummary();
    assert.equal(firstSummary.total, 1);
    assert.equal(firstSummary.byIntent.compliance, 1);
    assert.equal(firstSummary.byLane.bot, 1);
    assert.equal(firstSummary.storage.local, true);

    const files = fs.readdirSync(analyticsDir).filter((file) => file.endsWith('.jsonl'));
    assert.equal(files.length, 1);

    const secondLoad = await importFreshAnalytics(analyticsDir);
    const secondSummary = secondLoad.getSearchAnalyticsSummary();
    assert.equal(secondSummary.total, 1);
    assert.equal(secondSummary.byMode.compliance, 1);
    assert.equal(secondSummary.avgMs, 187);
  });
});
