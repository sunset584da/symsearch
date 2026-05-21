#!/usr/bin/env node
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import {
  chunkDocument,
  extractHtmlText,
  fetchPage,
  fetchRobots,
  loadSourceSeeds,
  normalizeDocument,
  planCrawl,
  shouldFetchUrl,
  validateSourceSeeds,
} from '../lib/private-hvac-crawler.js';
import {
  findExistingDocumentByUrl,
  recordSkippedFetch,
  replaceChunks,
  upsertDocument,
  upsertSources,
} from '../lib/private-crawl-store.js';

export function parseArgs(argv = process.argv.slice(2)) {
  const args = new Set(argv);
  const value = (name, fallback = null) => argv.find((arg) => arg.startsWith(`${name}=`))?.split('=').slice(1).join('=') ?? fallback;
  return {
    dryRun: args.has('--dry-run') || !args.has('--live'),
    live: args.has('--live'),
    allowAll: args.has('--allow-all'),
    json: args.has('--json'),
    store: value('--store', 'true') !== 'false',
    source: value('--source'),
    limit: Number(value('--limit', '25')),
  };
}

function getSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required when store=true');
  return createClient(url, key, { auth: { persistSession: false } });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runCrawler(options = parseArgs()) {
  if (options.live && !options.source && !options.allowAll) {
    throw new Error('Live crawling requires --source=<id> or --allow-all');
  }

  const sources = loadSourceSeeds().filter((source) => !options.source || source.id === options.source);
  const validation = validateSourceSeeds(loadSourceSeeds());
  if (!validation.ok) throw new Error(`Invalid private HVAC source catalog:\n${validation.errors.join('\n')}`);
  if (options.source && sources.length === 0) throw new Error(`Unknown source: ${options.source}`);

  const plan = planCrawl(sources).slice(0, options.limit);
  const summary = {
    mode: options.dryRun ? 'dry-run' : 'live',
    sourceCount: sources.length,
    planned: plan.length,
    fetched: 0,
    skippedRobots: 0,
    unchangedHash: 0,
    storedDocuments: 0,
    storedChunks: 0,
    errors: [],
    firstFetches: plan.slice(0, 5),
  };

  if (options.dryRun) return summary;

  const supabase = options.store ? getSupabaseClient() : null;
  if (supabase) await upsertSources(supabase, sources);

  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const robotsCache = new Map();
  const lastFetchBySource = new Map();
  for (const item of plan) {
    const source = sourceById.get(item.sourceId);
    try {
      if (!robotsCache.has(source.id)) robotsCache.set(source.id, await fetchRobots(source.baseUrl));
      const robotsText = robotsCache.get(source.id);
      const allowed = shouldFetchUrl(source, item.url, robotsText);
      if (!allowed.ok) {
        if (allowed.reason === 'robots_denied') summary.skippedRobots++;
        if (supabase) await recordSkippedFetch(supabase, { sourceId: source.id, url: item.url, reason: allowed.reason });
        continue;
      }

      const lastFetchAt = lastFetchBySource.get(source.id) || 0;
      const waitMs = Math.max(0, item.minDelayMs - (Date.now() - lastFetchAt));
      if (waitMs > 0) await sleep(waitMs);

      const page = await fetchPage(item.url);
      lastFetchBySource.set(source.id, Date.now());
      const extracted = extractHtmlText(page.body, page.url);
      const document = normalizeDocument({
        sourceId: source.id,
        url: page.url,
        title: extracted.title,
        text: extracted.text,
        contentType: page.contentType,
        safetyLabel: source.safetyLabel,
      });
      summary.fetched++;

      if (!supabase) continue;
      const existing = await findExistingDocumentByUrl(supabase, document.url);
      if (existing?.content_hash === document.contentHash) {
        summary.unchangedHash++;
        continue;
      }
      const stored = await upsertDocument(supabase, document);
      const chunks = chunkDocument(document).map((chunk) => ({ ...chunk, authority: source.authority }));
      summary.storedChunks += await replaceChunks(supabase, stored.id, chunks, { authority: source.authority });
      summary.storedDocuments++;
    } catch (error) {
      summary.errors.push({ sourceId: item.sourceId, url: item.url, error: error.message });
    }
  }

  return summary;
}

try {
  const summary = await runCrawler();
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  console.error(error.message);
  process.exit(2);
}
