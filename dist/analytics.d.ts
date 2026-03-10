/**
 * SymSearch search analytics.
 * Every request is persisted locally so analytics survive restarts.
 * If the Supabase table exists, the same event is mirrored remotely.
 */
import type { IntentType } from './intent-classifier.js';
export interface SearchAnalyticsEvent {
    query: string;
    intent: IntentType;
    result_count: number;
    latency_ms: number;
    cache_hit: boolean;
    mode?: string;
    role?: string;
    lane?: string;
    confidence?: number;
    deduped?: boolean;
    chained?: boolean;
    created_at?: string;
}
export interface SearchAnalyticsSummary {
    total: number;
    avgConf: string;
    avgMs: number;
    byMode: Record<string, number>;
    byLane: Record<string, number>;
    byIntent: Record<string, number>;
    cacheHitRate: number;
    storage: {
        local: boolean;
        path: string;
        supabase: boolean;
    };
}
export declare function getSearchAnalyticsSummary(): SearchAnalyticsSummary;
export declare function trackSearch(event: SearchAnalyticsEvent): Promise<void>;
