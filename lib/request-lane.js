const LANE_CONFIG = {
  customer: {
    cacheTtlMs: 15 * 60 * 1000,
    maxSources: 6,
    resultLimit: 10,
    enableRelatedQueries: true,
    synthesisMaxTokens: 1024,
    enginesByIntent: {
      troubleshooting: 'google,duckduckgo,startpage',
      competitor_intel: 'google,duckduckgo,startpage,qwant',
      pricing: 'google,startpage,qwant',
      code_docs: 'google,duckduckgo,startpage',
      compliance: 'google,duckduckgo,startpage,qwant',
    },
  },
  bot: {
    cacheTtlMs: 5 * 60 * 1000,
    maxSources: 8,
    resultLimit: 12,
    enableRelatedQueries: false,
    synthesisMaxTokens: 1400,
    enginesByIntent: {
      troubleshooting: 'google,duckduckgo,startpage,qwant',
      competitor_intel: 'google,duckduckgo,startpage,qwant',
      pricing: 'google,duckduckgo,startpage,qwant',
      code_docs: 'google,duckduckgo,startpage',
      compliance: 'google,duckduckgo,startpage,qwant',
    },
  },
};

const BOT_ALLOWED_TIERS = new Set(['internal', 'enterprise', 'unlimited']);

export function resolveSearchLane(apiTier, requestedLane) {
  const normalized = typeof requestedLane === 'string' ? requestedLane.trim().toLowerCase() : '';
  if (normalized === 'bot' && BOT_ALLOWED_TIERS.has(String(apiTier || '').toLowerCase())) {
    return 'bot';
  }
  return 'customer';
}

export function getLaneConfig(lane) {
  return LANE_CONFIG[lane] || LANE_CONFIG.customer;
}

export function getLaneSearchEngines(lane, intent) {
  const config = getLaneConfig(lane);
  return config.enginesByIntent[intent] || config.enginesByIntent.troubleshooting;
}
