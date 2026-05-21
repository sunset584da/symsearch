import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import {
  extractHtmlText,
  fetchPage,
  fetchRobots,
  shouldFetchUrl,
} from '../lib/private-hvac-crawler.js';
import { rankPrivateChunks } from '../lib/private-search.js';

function fakeResponse(body, { ok = true, status = 200, url = 'https://example.com/page', contentType = 'text/html' } = {}) {
  return {
    ok,
    status,
    url,
    headers: { get: (name) => (name.toLowerCase() === 'content-type' ? contentType : null) },
    text: async () => body,
  };
}

describe('private HVAC crawler live safety slice', () => {
  it('live fetch primitives use injected fetch and extract conservative text', async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      if (url.endsWith('/robots.txt')) return fakeResponse('User-agent: *\nAllow: /');
      return fakeResponse('<html><head><title>R-454B Manual</title><script>bad()</script></head><body><h1>Install safety</h1><p>Refrigerant pressure wiring code.</p></body></html>');
    };

    const robots = await fetchRobots('https://example.com/docs', { fetchImpl });
    const page = await fetchPage('https://example.com/docs/manual', { fetchImpl });
    const extracted = extractHtmlText(page.body, page.url);

    assert.equal(robots.includes('Allow'), true);
    assert.equal(calls.length, 2);
    assert.equal(extracted.title, 'R-454B Manual');
    assert.match(extracted.text, /Install safety/);
    assert.doesNotMatch(extracted.text, /bad\(\)/);
  });

  it('robots denied URL is skipped with an explicit reason', () => {
    const source = { baseUrl: 'https://example.com', id: 'official-source' };
    const decision = shouldFetchUrl(source, 'https://example.com/private/manual', 'User-agent: *\nDisallow: /private');
    assert.deepEqual(decision, { ok: false, reason: 'robots_denied' });
  });

  it('live CLI refuses to run without --source or --allow-all', () => {
    const result = spawnSync(process.execPath, ['scripts/private-hvac-crawler.js', '--live', '--json'], {
      cwd: new URL('..', import.meta.url),
      encoding: 'utf8',
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /requires --source=<id> or --allow-all/);
  });

  it('private search returns citation-ready chunks and ranks official/manufacturer above anecdotal for safety-critical queries', () => {
    const results = rankPrivateChunks([
      {
        source_id: 'forum-thread',
        url: 'https://forum.example.com/r454b',
        title: 'Forum R-454B install tip',
        content: 'R-454B install wiring pressure code advice from a homeowner thread.',
        authority: 'community',
        safety_label: 'anecdotal_forum_reference',
      },
      {
        source_id: 'epa-section-608',
        url: 'https://epa.gov/section608',
        title: 'EPA refrigerant handling code',
        content: 'Official R-454B refrigerant pressure install code and safety requirements.',
        authority: 'official',
        safety_label: 'official_compliance_reference',
      },
    ], { query: 'R-454B install pressure code', mode: 'tech', limit: 2 });

    assert.equal(results[0].sourceId, 'epa-section-608');
    assert.equal(results[0].authority, 'official');
    assert.equal(results[0].safetyLabel, 'official_compliance_reference');
    assert.match(results[0].url, /^https:/);
  });
});
