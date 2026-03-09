import { getCacheSnapshot } from './search-cache.js';

const recentRequests = [];

export function recordSearchTelemetry(event) {
  recentRequests.push({
    at: Date.now(),
    lane: event.lane,
    intent: event.intent,
    cacheHit: Boolean(event.cacheHit),
    deduped: Boolean(event.deduped),
    chained: Boolean(event.chained),
    latencyMs: event.latencyMs,
    resultCount: event.resultCount,
    status: event.status || 'ok',
  });

  if (recentRequests.length > 250) {
    recentRequests.shift();
  }
}

export function attachSearchHeaders(res, event) {
  res.setHeader('X-SymSearch-Lane', event.lane);
  res.setHeader('X-SymSearch-Intent', event.intent);
  res.setHeader('X-SymSearch-Cache', event.cacheHit ? 'hit' : 'miss');
  res.setHeader('X-SymSearch-Deduped', event.deduped ? '1' : '0');
  res.setHeader('X-SymSearch-Chained', event.chained ? '1' : '0');
}

export function getTelemetrySnapshot() {
  const total = recentRequests.length;
  const avgLatencyMs = total
    ? Math.round(recentRequests.reduce((sum, item) => sum + item.latencyMs, 0) / total)
    : 0;

  const counts = recentRequests.reduce((acc, item) => {
    acc.byLane[item.lane] = (acc.byLane[item.lane] || 0) + 1;
    acc.byIntent[item.intent] = (acc.byIntent[item.intent] || 0) + 1;
    if (item.cacheHit) acc.cacheHits += 1;
    if (item.deduped) acc.deduped += 1;
    if (item.chained) acc.chained += 1;
    if (item.status !== 'ok') acc.errors += 1;
    return acc;
  }, {
    byLane: {},
    byIntent: {},
    cacheHits: 0,
    deduped: 0,
    chained: 0,
    errors: 0,
  });

  return {
    total,
    avgLatencyMs,
    cacheHitRate: total ? Number((counts.cacheHits / total).toFixed(2)) : 0,
    dedupeRate: total ? Number((counts.deduped / total).toFixed(2)) : 0,
    chainedRate: total ? Number((counts.chained / total).toFixed(2)) : 0,
    errorRate: total ? Number((counts.errors / total).toFixed(2)) : 0,
    byLane: counts.byLane,
    byIntent: counts.byIntent,
    cache: getCacheSnapshot(),
  };
}
