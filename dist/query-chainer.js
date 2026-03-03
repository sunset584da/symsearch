/**
 * SymSearch Phase 2 — Follow-up Query Chaining
 * If primary search is weak (< 3 results OR avg relevance < 0.4),
 * auto-generate 2 refined follow-up queries and silently merge results.
 */
// Heuristic suffixes to generate follow-up queries based on content patterns
const REFINEMENT_SUFFIXES = [
    'HVAC guide',
    'technical specification',
    'how to fix',
    'troubleshooting steps',
    'pricing guide',
    'installation manual',
    'best practices',
    'explained',
    'common problems',
    'repair guide',
];
/**
 * Generate 2 refined follow-up queries based on the original query.
 * Uses keyword-based heuristics — no LLM call.
 */
function generateFollowUpQueries(query) {
    const q = query.trim();
    // Pick two contextually appropriate suffixes based on keywords
    const isTroubleshooting = /\b(error|fault|not work|broken|fail|issue|problem|diagnos)\b/i.test(q);
    const isPricing = /\b(cost|price|rate|charge|quote|how much)\b/i.test(q);
    const isInstall = /\b(install|setup|configur|replace|wire|connect)\b/i.test(q);
    const isTech = /\b(spec|seer|btu|cfm|tonnage|capacity|rating|efficiency)\b/i.test(q);
    let suffix1;
    let suffix2;
    if (isTroubleshooting) {
        suffix1 = 'troubleshooting steps HVAC';
        suffix2 = 'repair guide HVAC technician';
    }
    else if (isPricing) {
        suffix1 = 'pricing guide HVAC contractor';
        suffix2 = 'cost breakdown installation';
    }
    else if (isInstall) {
        suffix1 = 'installation guide step by step';
        suffix2 = 'wiring diagram setup instructions';
    }
    else if (isTech) {
        suffix1 = 'technical specifications datasheet';
        suffix2 = 'AHRI certification performance data';
    }
    else {
        // Generic fallback: pick two from the suffixes list based on query length
        const idx = q.length % REFINEMENT_SUFFIXES.length;
        suffix1 = REFINEMENT_SUFFIXES[idx] ?? 'HVAC guide';
        suffix2 = REFINEMENT_SUFFIXES[(idx + 3) % REFINEMENT_SUFFIXES.length] ?? 'explained';
    }
    return [`${q} ${suffix1}`, `${q} ${suffix2}`];
}
/**
 * Compute average relevance score from results.
 * Falls back to positional heuristic if no .score field.
 */
function avgRelevance(results) {
    if (results.length === 0)
        return 0;
    const total = results.reduce((sum, r, i) => {
        const score = typeof r.score === 'number' ? r.score : Math.max(0.1, 1 - i * 0.12);
        return sum + score;
    }, 0);
    return total / results.length;
}
/**
 * Deduplicate results by URL, keeping original ordering.
 */
function deduplicateByUrl(results) {
    const seen = new Set();
    return results.filter(r => {
        if (seen.has(r.url))
            return false;
        seen.add(r.url);
        return true;
    });
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
export async function maybeChain(query, results, runSearch) {
    const needsChaining = results.length < 3 || avgRelevance(results) < 0.4;
    if (!needsChaining) {
        return results;
    }
    const [followUp1, followUp2] = generateFollowUpQueries(query);
    // Run both follow-ups, catching all errors individually
    const settled = await Promise.allSettled([
        runSearch(followUp1),
        runSearch(followUp2),
    ]);
    const extra = [];
    for (const result of settled) {
        if (result.status === 'fulfilled') {
            extra.push(...result.value);
        }
        // silently ignore rejections
    }
    if (extra.length === 0) {
        return results; // chaining returned nothing useful — return original
    }
    // Merge: originals first (they have higher relevance), then extras
    const merged = deduplicateByUrl([...results, ...extra]);
    return merged;
}
