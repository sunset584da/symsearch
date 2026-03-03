/**
 * SymSearch Phase 2 — Follow-up Query Chaining
 * If primary search is weak (< 3 results OR avg relevance < 0.4),
 * auto-generate 2 refined follow-up queries and silently merge results.
 */
export interface SearchResult {
    title: string;
    url: string;
    content?: string;
    snippet?: string;
    score?: number;
    [key: string]: unknown;
}
/**
 * Main export: maybe run follow-up query chaining.
 *
 * Triggers if:
 *   - primary results < 3, OR
 *   - average relevance of primary results < 0.4
 *
 * Runs 2 refined queries silently (fire-and-forget style — awaited internally
 * but never throws to the caller). Deduplicates merged results by URL.
 */
export declare function maybeChain(query: string, results: SearchResult[], runSearch: (q: string) => Promise<SearchResult[]>): Promise<SearchResult[]>;
