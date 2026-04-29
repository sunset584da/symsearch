#!/usr/bin/env node
import { loadSourceSeeds, planCrawl, validateSourceSeeds } from '../lib/private-hvac-crawler.js';

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run') || !args.has('--live');
const limitArg = process.argv.find((arg) => arg.startsWith('--limit='));
const limit = limitArg ? Number(limitArg.split('=')[1]) : 25;

const sources = loadSourceSeeds();
const validation = validateSourceSeeds(sources);
if (!validation.ok) {
  console.error('Invalid private HVAC source catalog:');
  for (const error of validation.errors) console.error(`- ${error}`);
  process.exit(1);
}

const plan = planCrawl(sources).slice(0, limit);
console.log(JSON.stringify({
  mode: dryRun ? 'dry-run' : 'live-not-implemented',
  sourceCount: sources.length,
  plannedFetches: plan.length,
  firstFetches: plan.slice(0, 5),
}, null, 2));

if (!dryRun) {
  console.error('Live crawling is intentionally not enabled in this slice. Wire fetch/store after PR review.');
  process.exit(2);
}
