/**
 * SymSearch Phase 2 — Query Intent Classifier
 * Keyword matching + heuristics, no external API calls.
 * HVAC-domain aware.
 */
// ─── Keyword maps per intent ───────────────────────────────────────────────────
const INTENT_KEYWORDS = {
    troubleshooting: /\b(not cool|not heat|no cool|wont cool|won't cool|not working|error code|fault code|blower|capacitor|contactor|refrigerant|freon|leak|diagnostic|troubleshoot|freezing|frozen|icing|high pressure|low pressure|short cycling|tripping|compressor fail|thermostat issue|airflow|cfm|seer rating issue|coil|defrost|dirty filter|clog|drain|overflow|noise|vibration|rattl|squeal|bang|hiss|clicking|smell|burn|trip|breaker|fuse|reset)\b/i,
    competitor_intel: /\b(competitor|competition|vs\b|versus|compared to|alternative|market share|who else|other companies|other hvac|trane vs|carrier vs|lennox vs|rheem vs|goodman vs|amana vs|york vs|daikin vs|mitsubishi vs|compare brands|best brand|top brand|rated hvac|review|ranking|dealer|distributor|franchise|service area|market|\bICP\b|Weil-McLain|Bosch hvac|new company|startup hvac|local competitor)\b/i,
    pricing: /\b(price|pricing|cost|how much|rate|quote|estimate|invoice|charge|fee|labor rate|hourly rate|flat rate|service call|diagnostic fee|install cost|replacement cost|unit price|equipment price|profit margin|markup|bid|proposal|contract|financing|payment plan|subscription|monthly|annual|warranty cost|maintenance plan|agreement|tune.?up|pm price|preventive maintenance cost|budget|revenue|gross profit|net)\b/i,
    code_docs: /\b(api|sdk|code|documentation|docs|manual|spec|technical spec|data sheet|wiring diagram|install guide|setup guide|controller|thermostat manual|modbus|bacnet|lon|ecm|vfd|communicating|wifi setup|app setup|integration|protocol|register|parameter|firmware|software|configure|configuration|sequence of operations|soo|startup procedure|commissioning|engineer spec|submittal|ahri cert|seer2|energy star cert|nate cert|ahj|permit drawing|mechanical drawing|cut sheet)\b/i,
};
// Bonus weight for secondary HVAC context signals
const HVAC_CONTEXT_PATTERN = /\b(hvac|ac\b|a\/c|heat pump|furnace|boiler|chiller|air handler|ahu|rtu|rooftop unit|mini.?split|ductless|zone|vav|cooling|heating|refrigeration|condenser|evaporator|compressor|tonnage|btu|eer|cop|iaq|zoning|ductwork|damper|economizer|vrf)\b/i;
/**
 * Score a query against each intent's keyword set.
 * Returns match counts so we can pick the highest.
 */
function scoreQuery(query) {
    const scores = {
        troubleshooting: 0,
        competitor_intel: 0,
        pricing: 0,
        code_docs: 0,
    };
    const q = query.toLowerCase();
    for (const [intent, pattern] of Object.entries(INTENT_KEYWORDS)) {
        // Count all regex matches (not just first)
        const matchAll = q.match(new RegExp(pattern.source, 'gi'));
        scores[intent] = matchAll ? matchAll.length : 0;
    }
    return scores;
}
/**
 * Classify the intent of a search query.
 * Returns the best-matching intent and a confidence score [0–1].
 */
export function classifyIntent(query) {
    if (!query || query.trim().length === 0) {
        return { intent: 'troubleshooting', confidence: 0.1 };
    }
    const scores = scoreQuery(query);
    const hasHvacContext = HVAC_CONTEXT_PATTERN.test(query);
    // Find max score
    const entries = Object.entries(scores);
    const [topIntent, topScore] = entries.reduce((best, cur) => (cur[1] > best[1] ? cur : best), ['troubleshooting', 0]);
    // Compute total weight for normalisation
    const totalScore = entries.reduce((sum, [, v]) => sum + v, 0);
    // If nothing matched, return troubleshooting as default with low confidence
    if (topScore === 0 || totalScore === 0) {
        return { intent: 'troubleshooting', confidence: 0.2 };
    }
    // Base confidence: proportion of top score
    let confidence = topScore / totalScore;
    // Boost confidence if HVAC context confirmed
    if (hasHvacContext) {
        confidence = Math.min(0.98, confidence + 0.1);
    }
    // Clamp: if only 1 keyword matched we're less sure
    if (topScore === 1 && totalScore === 1) {
        confidence = Math.min(confidence, 0.6);
    }
    return { intent: topIntent, confidence: parseFloat(confidence.toFixed(2)) };
}
