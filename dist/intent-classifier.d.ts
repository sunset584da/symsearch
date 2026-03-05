/**
 * SymSearch Phase 2 — Query Intent Classifier
 * Keyword matching + heuristics, no external API calls.
 * HVAC-domain aware.
 */
export type IntentType = 'troubleshooting' | 'competitor_intel' | 'pricing' | 'code_docs';
export interface IntentResult {
    intent: IntentType;
    confidence: number;
}
/**
 * Classify the intent of a search query.
 * Returns the best-matching intent and a confidence score [0–1].
 */
export declare function classifyIntent(query: string): IntentResult;
