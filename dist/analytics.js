/**
 * SymSearch Phase 2 — Search Analytics
 * Lightweight Supabase write for per-query search events.
 * Never throws — all errors are silently swallowed.
 *
 * Table: sym_search_analytics
 * Checked at startup with a SELECT; if absent, DB writes are skipped.
 */
// ─── Supabase Config ──────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL ?? null;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY ?? null;
const TABLE = 'sym_search_analytics';
// ─── Table availability (checked once at startup) ─────────────────────────────
let tableAvailable = null; // null = not yet checked
async function checkTableExists() {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
        console.warn('[analytics] SUPABASE_URL or SUPABASE_ANON_KEY not set — DB writes disabled');
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
            console.log(`[analytics] Table '${TABLE}' found — analytics enabled`);
            return true;
        }
        // 404 or 42P01 (relation not found) means table doesn't exist
        const body = await res.text().catch(() => '');
        console.warn(`[analytics] Table '${TABLE}' not found (HTTP ${res.status}): ${body.substring(0, 120)} — DB writes disabled`);
        return false;
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[analytics] Table check failed: ${msg} — DB writes disabled`);
        return false;
    }
}
async function ensureTableChecked() {
    if (tableAvailable === null) {
        tableAvailable = await checkTableExists();
    }
    return tableAvailable;
}
// ─── Main export ──────────────────────────────────────────────────────────────
/**
 * Track a search event. Never throws.
 * Silently skips if Supabase is not configured or table doesn't exist.
 */
export async function trackSearch(event) {
    try {
        const available = await ensureTableChecked();
        if (!available)
            return;
        // SUPABASE_URL and SUPABASE_ANON_KEY are confirmed non-null at this point
        const url = SUPABASE_URL;
        const key = SUPABASE_ANON_KEY;
        const payload = {
            query: event.query.substring(0, 500), // guard against oversized strings
            intent: event.intent,
            result_count: event.result_count,
            latency_ms: event.latency_ms,
            cache_hit: event.cache_hit,
            created_at: new Date().toISOString(),
        };
        const res = await fetch(`${url}/rest/v1/${TABLE}`, {
            method: 'POST',
            headers: {
                apikey: key,
                Authorization: `Bearer ${key}`,
                'Content-Type': 'application/json',
                Prefer: 'return=minimal',
            },
            body: JSON.stringify(payload),
        });
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            console.warn(`[analytics] Insert failed (${res.status}): ${text.substring(0, 120)}`);
        }
    }
    catch (err) {
        // Never throw — analytics must not break search
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[analytics] trackSearch error (swallowed): ${msg}`);
    }
}
