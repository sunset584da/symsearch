/**
 * SymSearch search analytics.
 * Every request is persisted locally so analytics survive restarts.
 * If the Supabase table exists, the same event is mirrored remotely.
 */
import fs from 'node:fs';
import path from 'node:path';
const SUPABASE_URL = process.env.SUPABASE_URL ?? null;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? null;
const TABLE = 'sym_search_analytics';
const ANALYTICS_DIR = (process.env.SYMSEARCH_ANALYTICS_DIR || '').trim() || path.join(process.cwd(), 'data', 'analytics');
const ANALYTICS_MEMORY_LIMIT = readPositiveInt('SYMSEARCH_ANALYTICS_MEMORY_LIMIT', 5000);
const ANALYTICS_RETENTION_DAYS = readPositiveInt('SYMSEARCH_ANALYTICS_RETENTION_DAYS', 30);
let tableAvailable = null;
let localStorageAvailable = true;
let pruneChecked = false;
let writeChain = Promise.resolve();
const persistedEvents = loadLocalEvents();
function readPositiveInt(name, fallback) {
    const raw = process.env[name];
    if (!raw)
        return fallback;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
function normalizeLabel(value, fallback) {
    if (typeof value !== 'string')
        return fallback;
    const trimmed = value.trim().toLowerCase();
    return trimmed ? trimmed.slice(0, 32) : fallback;
}
function clamp(value, min, max) {
    const numeric = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numeric))
        return undefined;
    return Math.min(max, Math.max(min, numeric));
}
function coerceNonNegativeInt(value) {
    const numeric = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numeric))
        return 0;
    return Math.max(0, Math.round(numeric));
}
function resolveDailyFile(createdAt) {
    const dayKey = createdAt.slice(0, 10) || new Date().toISOString().slice(0, 10);
    return path.join(ANALYTICS_DIR, `${dayKey}.jsonl`);
}
function ensureAnalyticsDirectory() {
    if (!localStorageAvailable)
        return;
    try {
        fs.mkdirSync(ANALYTICS_DIR, { recursive: true });
    }
    catch (err) {
        localStorageAvailable = false;
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[analytics] Local persistence disabled: ${message}`);
    }
}
function pruneOldFiles() {
    if (!localStorageAvailable)
        return;
    const cutoff = new Date(Date.now() - ANALYTICS_RETENTION_DAYS * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);
    try {
        ensureAnalyticsDirectory();
        for (const file of fs.readdirSync(ANALYTICS_DIR)) {
            if (!file.endsWith('.jsonl'))
                continue;
            if (file.slice(0, 10) >= cutoff)
                continue;
            fs.rmSync(path.join(ANALYTICS_DIR, file), { force: true });
        }
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[analytics] Failed to prune local analytics files: ${message}`);
    }
}
function trimEvents() {
    if (persistedEvents.length <= ANALYTICS_MEMORY_LIMIT)
        return;
    persistedEvents.splice(0, persistedEvents.length - ANALYTICS_MEMORY_LIMIT);
}
function sanitizeEvent(event) {
    const createdAt = typeof event.created_at === 'string' && event.created_at.trim()
        ? event.created_at.trim()
        : new Date().toISOString();
    return {
        query: String(event.query || '').trim().slice(0, 500),
        intent: event.intent,
        result_count: coerceNonNegativeInt(event.result_count),
        latency_ms: coerceNonNegativeInt(event.latency_ms),
        cache_hit: Boolean(event.cache_hit),
        created_at: createdAt,
        mode: normalizeLabel(event.mode, 'general'),
        role: normalizeLabel(event.role, 'owner'),
        lane: normalizeLabel(event.lane, 'customer'),
        confidence: clamp(event.confidence, 0, 1),
        deduped: typeof event.deduped === 'boolean' ? event.deduped : false,
        chained: typeof event.chained === 'boolean' ? event.chained : false,
    };
}
function loadLocalEvents() {
    ensureAnalyticsDirectory();
    if (!localStorageAvailable)
        return [];
    pruneOldFiles();
    const events = [];
    try {
        const files = fs.readdirSync(ANALYTICS_DIR)
            .filter((file) => file.endsWith('.jsonl'))
            .sort()
            .slice(-ANALYTICS_RETENTION_DAYS);
        for (const file of files) {
            const fullPath = path.join(ANALYTICS_DIR, file);
            const raw = fs.readFileSync(fullPath, 'utf8');
            for (const line of raw.split(/\r?\n/)) {
                if (!line.trim())
                    continue;
                try {
                    const parsed = JSON.parse(line);
                    events.push(parsed);
                }
                catch {
                    // Keep boot resilient if one line is bad.
                }
            }
        }
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[analytics] Failed to load local analytics history: ${message}`);
    }
    if (events.length > ANALYTICS_MEMORY_LIMIT) {
        return events.slice(-ANALYTICS_MEMORY_LIMIT);
    }
    return events;
}
async function persistLocally(event) {
    if (!localStorageAvailable)
        return;
    if (!pruneChecked) {
        pruneChecked = true;
        pruneOldFiles();
    }
    const payload = `${JSON.stringify(event)}\n`;
    const target = resolveDailyFile(event.created_at);
    writeChain = writeChain.then(async () => {
        ensureAnalyticsDirectory();
        if (!localStorageAvailable)
            return;
        await fs.promises.appendFile(target, payload, 'utf8');
    }).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[analytics] Local analytics append failed: ${message}`);
    });
    await writeChain;
}
function addEvent(event) {
    persistedEvents.push(event);
    trimEvents();
}
async function checkTableExists() {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
        console.warn('[analytics] Supabase analytics mirror disabled: SUPABASE_URL or SUPABASE_ANON_KEY is not set');
        return false;
    }
    try {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/${TABLE}?limit=1`, {
            headers: {
                apikey: SUPABASE_ANON_KEY,
                Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
                'Content-Type': 'application/json',
            },
        });
        if (res.status === 200 || res.status === 206) {
            console.log(`[analytics] Table '${TABLE}' found; Supabase analytics mirror enabled`);
            return true;
        }
        const body = await res.text().catch(() => '');
        console.warn(`[analytics] Table '${TABLE}' not found (HTTP ${res.status}): ${body.substring(0, 120)}; continuing with local persistence only`);
        return false;
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[analytics] Table check failed: ${message}; continuing with local persistence only`);
        return false;
    }
}
async function ensureTableChecked() {
    if (tableAvailable === null) {
        tableAvailable = await checkTableExists();
    }
    return tableAvailable;
}
export function getSearchAnalyticsSummary() {
    const total = persistedEvents.length;
    const confidenceValues = persistedEvents
        .map((event) => event.confidence)
        .filter((value) => typeof value === 'number');
    const avgConf = confidenceValues.length
        ? (confidenceValues.reduce((sum, value) => sum + value, 0) / confidenceValues.length).toFixed(2)
        : '0.00';
    const avgMs = total
        ? Math.round(persistedEvents.reduce((sum, event) => sum + event.latency_ms, 0) / total)
        : 0;
    const byMode = {};
    const byLane = {};
    const byIntent = {};
    let cacheHits = 0;
    for (const event of persistedEvents) {
        byMode[event.mode || 'general'] = (byMode[event.mode || 'general'] || 0) + 1;
        byLane[event.lane || 'customer'] = (byLane[event.lane || 'customer'] || 0) + 1;
        byIntent[event.intent] = (byIntent[event.intent] || 0) + 1;
        if (event.cache_hit)
            cacheHits += 1;
    }
    return {
        total,
        avgConf,
        avgMs,
        byMode,
        byLane,
        byIntent,
        cacheHitRate: total ? Number((cacheHits / total).toFixed(2)) : 0,
        storage: {
            local: localStorageAvailable,
            path: ANALYTICS_DIR,
            supabase: Boolean(tableAvailable),
        },
    };
}
export async function trackSearch(event) {
    try {
        const payload = sanitizeEvent(event);
        addEvent(payload);
        await persistLocally(payload);
        const available = await ensureTableChecked();
        if (!available)
            return;
        const url = SUPABASE_URL;
        const key = SUPABASE_ANON_KEY;
        const mirroredPayload = {
            query: payload.query,
            intent: payload.intent,
            result_count: payload.result_count,
            latency_ms: payload.latency_ms,
            cache_hit: payload.cache_hit,
            created_at: payload.created_at,
        };
        const res = await fetch(`${url}/rest/v1/${TABLE}`, {
            method: 'POST',
            headers: {
                apikey: key,
                Authorization: `Bearer ${key}`,
                'Content-Type': 'application/json',
                Prefer: 'return=minimal',
            },
            body: JSON.stringify(mirroredPayload),
        });
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            console.warn(`[analytics] Supabase insert failed (${res.status}): ${text.substring(0, 120)}`);
        }
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[analytics] trackSearch error (swallowed): ${message}`);
    }
}
