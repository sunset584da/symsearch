import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  canFetchPathFromRobots,
  chunkDocument,
  loadSourceSeeds,
  normalizeDocument,
  planCrawl,
  robotsUrlFor,
  validateSourceSeeds,
} from '../lib/private-hvac-crawler.js';

describe('private HVAC crawler phase 1', () => {
  it('ships a valid 20+ public source seed catalog with safety labels', () => {
    const sources = loadSourceSeeds();
    const validation = validateSourceSeeds(sources);

    assert.equal(validation.ok, true, validation.errors.join('\n'));
    assert.ok(sources.length >= 20);
    assert.ok(sources.some((source) => source.authority === 'official'));
    assert.ok(sources.some((source) => source.authority === 'manufacturer'));
    assert.ok(sources.some((source) => source.safetyLabel.includes('anecdotal')));
  });

  it('builds a deterministic crawl plan with robots URL and per-source delay', () => {
    const plan = planCrawl(loadSourceSeeds(), { limitPerSource: 1 });

    assert.ok(plan.length >= 20);
    assert.equal(plan[0].sourceId, 'epa-section-608');
    assert.equal(plan[0].robotsUrl, 'https://www.epa.gov/robots.txt');
    assert.ok(plan[0].minDelayMs >= 1000);
  });

  it('evaluates simple robots.txt disallow and allow rules', () => {
    const robots = `User-agent: *\nDisallow: /private\nAllow: /private/manuals\n`;

    assert.equal(robotsUrlFor('https://example.com/docs'), 'https://example.com/robots.txt');
    assert.equal(canFetchPathFromRobots(robots, '/public/manual.pdf'), true);
    assert.equal(canFetchPathFromRobots(robots, '/private/account'), false);
    assert.equal(canFetchPathFromRobots(robots, '/private/manuals/install.pdf'), true);
  });

  it('normalizes documents and creates citation-ready chunks', () => {
    const document = normalizeDocument({
      sourceId: 'goodman-literature-library',
      url: 'https://www.goodmanmfg.com/support/product-literature',
      title: '  Goodman  Install Manual  ',
      text: 'Install manual '.repeat(240),
      safetyLabel: 'manufacturer_reference',
    });
    const chunks = chunkDocument(document, { chunkSize: 500, overlap: 50 });

    assert.equal(document.sourceId, 'goodman-literature-library');
    assert.equal(document.wordCount, 480);
    assert.match(document.contentHash, /^[a-f0-9]{64}$/);
    assert.ok(chunks.length > 1);
    assert.equal(chunks[0].url, document.url);
    assert.equal(chunks[0].safetyLabel, 'manufacturer_reference');
  });
});
