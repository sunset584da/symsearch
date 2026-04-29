import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const REQUIRED_SOURCE_FIELDS = ['id', 'name', 'type', 'authority', 'baseUrl', 'seedUrls', 'rateLimitRps', 'safetyLabel', 'priority'];
const DEFAULT_CHUNK_SIZE = 1200;
const DEFAULT_CHUNK_OVERLAP = 180;

export function loadSourceSeeds(filePath = path.join(process.cwd(), 'data/private-hvac-source-seeds.json')) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export function validateSourceSeeds(sources) {
  if (!Array.isArray(sources)) throw new Error('source seed catalog must be an array');
  if (sources.length < 20) throw new Error(`expected at least 20 source seeds, got ${sources.length}`);

  const ids = new Set();
  const errors = [];
  for (const [index, source] of sources.entries()) {
    for (const field of REQUIRED_SOURCE_FIELDS) {
      if (source[field] === undefined || source[field] === null || source[field] === '') {
        errors.push(`${index}:${source.id || 'missing-id'} missing ${field}`);
      }
    }
    if (ids.has(source.id)) errors.push(`${source.id} duplicate id`);
    ids.add(source.id);

    try {
      const base = new URL(source.baseUrl);
      for (const seedUrl of source.seedUrls || []) {
        const seed = new URL(seedUrl);
        if (seed.hostname !== base.hostname) {
          errors.push(`${source.id} seed host ${seed.hostname} does not match base host ${base.hostname}`);
        }
      }
    } catch (error) {
      errors.push(`${source.id || index} invalid URL: ${error.message}`);
    }

    if (!Array.isArray(source.seedUrls) || source.seedUrls.length === 0) errors.push(`${source.id} needs seedUrls`);
    if (!(Number(source.rateLimitRps) > 0 && Number(source.rateLimitRps) <= 1)) errors.push(`${source.id} rateLimitRps must be >0 and <=1`);
    if (!(Number(source.priority) >= 0 && Number(source.priority) <= 100)) errors.push(`${source.id} priority must be 0-100`);
    if (source.type === 'forum' && !String(source.safetyLabel).includes('anecdotal')) errors.push(`${source.id} forum sources must be anecdotal-labeled`);
  }

  return { ok: errors.length === 0, errors };
}

export function robotsUrlFor(baseUrl) {
  const url = new URL(baseUrl);
  return `${url.origin}/robots.txt`;
}

export function canFetchPathFromRobots(robotsText, targetPath, userAgent = 'SymsearchBot') {
  const lines = String(robotsText || '').split(/\r?\n/);
  const groups = [];
  let current = null;
  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*/, '').trim();
    if (!line) continue;
    const [rawKey, ...rest] = line.split(':');
    const key = rawKey.trim().toLowerCase();
    const value = rest.join(':').trim();
    if (key === 'user-agent') {
      current = { agents: [value.toLowerCase()], rules: [] };
      groups.push(current);
    } else if (current && (key === 'allow' || key === 'disallow')) {
      current.rules.push({ type: key, path: value });
    }
  }

  const normalizedAgent = userAgent.toLowerCase();
  const matching = groups.filter((group) => group.agents.includes('*') || group.agents.some((agent) => normalizedAgent.includes(agent)));
  const rules = matching.flatMap((group) => group.rules).filter((rule) => rule.path !== '');
  if (rules.length === 0) return true;

  const matched = rules
    .filter((rule) => targetPath.startsWith(rule.path))
    .sort((a, b) => b.path.length - a.path.length)[0];
  return matched ? matched.type === 'allow' : true;
}

export function normalizeDocument({ sourceId, url, title, text, fetchedAt = new Date().toISOString(), contentType = 'text/html', safetyLabel }) {
  const normalizedText = String(text || '').replace(/\s+/g, ' ').trim();
  const canonicalUrl = new URL(url).toString();
  const contentHash = crypto.createHash('sha256').update(normalizedText).digest('hex');
  return {
    sourceId,
    url: canonicalUrl,
    title: String(title || canonicalUrl).replace(/\s+/g, ' ').trim().slice(0, 240),
    text: normalizedText,
    contentType,
    safetyLabel,
    fetchedAt,
    contentHash,
    wordCount: normalizedText ? normalizedText.split(/\s+/).length : 0,
  };
}

export function chunkDocument(document, { chunkSize = DEFAULT_CHUNK_SIZE, overlap = DEFAULT_CHUNK_OVERLAP } = {}) {
  const text = document.text || '';
  if (!text) return [];
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(text.length, start + chunkSize);
    const chunkText = text.slice(start, end).trim();
    if (chunkText) {
      chunks.push({
        id: `${document.contentHash}:${chunks.length}`,
        sourceId: document.sourceId,
        url: document.url,
        title: document.title,
        safetyLabel: document.safetyLabel,
        text: chunkText,
        start,
        end,
      });
    }
    if (end === text.length) break;
    start = Math.max(0, end - overlap);
  }
  return chunks;
}

export function planCrawl(sources, { limitPerSource = 5 } = {}) {
  return sources
    .slice()
    .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))
    .flatMap((source) => source.seedUrls.slice(0, limitPerSource).map((url) => ({
      sourceId: source.id,
      url,
      robotsUrl: robotsUrlFor(source.baseUrl),
      minDelayMs: Math.ceil(1000 / source.rateLimitRps),
      safetyLabel: source.safetyLabel,
      authority: source.authority,
    })));
}
