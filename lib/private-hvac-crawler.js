import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const REQUIRED_SOURCE_FIELDS = ['id', 'name', 'type', 'authority', 'baseUrl', 'seedUrls', 'rateLimitRps', 'safetyLabel', 'priority'];
const DEFAULT_CHUNK_SIZE = 1200;
const DEFAULT_CHUNK_OVERLAP = 180;
const DEFAULT_USER_AGENT = 'SymsearchBot/0.2 (+https://symsearch.pro)';

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

export async function fetchRobots(baseUrl, { fetchImpl = fetch, userAgent = DEFAULT_USER_AGENT, timeoutMs = 8000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(robotsUrlFor(baseUrl), {
      headers: { 'User-Agent': userAgent, 'Accept': 'text/plain,*/*;q=0.8' },
      signal: controller.signal,
    });
    if (!res.ok) return '';
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

export function shouldFetchUrl(source, url, robotsText, { userAgent = DEFAULT_USER_AGENT } = {}) {
  let parsed;
  let base;
  try {
    parsed = new URL(url);
    base = new URL(source.baseUrl);
  } catch (error) {
    return { ok: false, reason: `invalid_url:${error.message}` };
  }
  if (parsed.hostname !== base.hostname) return { ok: false, reason: 'cross_host_seed_denied' };
  if (!['http:', 'https:'].includes(parsed.protocol)) return { ok: false, reason: 'unsupported_protocol' };
  const blockedPatterns = [/login/i, /signin/i, /account/i, /cart/i, /checkout/i, /captcha/i, /brickseek/i, /homedepot\.com/i, /target\.com/i];
  if (blockedPatterns.some((pattern) => pattern.test(parsed.toString()))) return { ok: false, reason: 'blocked_sensitive_or_antibot_path' };
  if (!canFetchPathFromRobots(robotsText, `${parsed.pathname}${parsed.search}`, userAgent)) {
    return { ok: false, reason: 'robots_denied' };
  }
  return { ok: true, reason: 'allowed' };
}

export async function fetchPage(url, { fetchImpl = fetch, userAgent = DEFAULT_USER_AGENT, timeoutMs = 12000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      headers: {
        'User-Agent': userAgent,
        'Accept': 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
      },
      signal: controller.signal,
    });
    const contentType = res.headers?.get?.('content-type') || 'text/html';
    const body = await res.text();
    if (!res.ok) throw new Error(`fetch_failed:${res.status}`);
    return { url: res.url || url, contentType, body };
  } finally {
    clearTimeout(timer);
  }
}

export function extractHtmlText(html, url = '') {
  const raw = String(html || '');
  const title = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || url;
  const text = raw
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
  return {
    title: title.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
    text,
  };
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
