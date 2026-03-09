const responseCache = new Map();
const inflightRequests = new Map();

export function buildSearchCacheKey({ lane, query, role, mode, intent }) {
  return JSON.stringify({
    lane: lane || 'customer',
    query: String(query || '').trim().toLowerCase(),
    role: role || 'owner',
    mode: mode || 'general',
    intent: intent || 'troubleshooting',
  });
}

export function getCachedSearchResponse(key) {
  const cached = responseCache.get(key);
  if (!cached) return null;

  if (cached.expiresAt <= Date.now()) {
    responseCache.delete(key);
    return null;
  }

  return cached.value;
}

export function setCachedSearchResponse(key, value, ttlMs) {
  responseCache.set(key, {
    value,
    expiresAt: Date.now() + ttlMs,
  });
}

export async function dedupeSearchRequest(key, createValue) {
  if (inflightRequests.has(key)) {
    return {
      value: await inflightRequests.get(key),
      deduped: true,
    };
  }

  const promise = Promise.resolve()
    .then(createValue)
    .finally(() => {
      inflightRequests.delete(key);
    });

  inflightRequests.set(key, promise);

  return {
    value: await promise,
    deduped: false,
  };
}

export function getCacheSnapshot() {
  return {
    entries: responseCache.size,
    inflight: inflightRequests.size,
  };
}
