/**
 * SymSearch Phase 2 — Search Analytics
 * Lightweight Supabase write for per-query search events.
 * Never throws — all errors are silently swallowed.
 *
 * Table: sym_search_analytics
 * Checked at startup with a SELECT; if absent, DB writes are skipped.
 */
import type { IntentType } from './intent-classifier.js';
export interface SearchAnalyticsEvent {
    query: string;
    intent: IntentType;
    result_count: number;
    latency_ms: number;
    cache_hit: boolean;
}
/**
 * Track a search event. Never throws.
 * Silently skips if Supabase is not configured or table doesn't exist.
 */
export declare function trackSearch(event: SearchAnalyticsEvent): Promise<void>;
