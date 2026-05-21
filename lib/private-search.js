const SAFETY_CRITICAL_TERMS = new Set(['electrical', 'refrigerant', 'pressure', 'combustion', 'code', 'install', 'installation', 'wiring', 'gas', 'venting']);

export function tokenizeQuery(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .filter((token) => token.length >= 3);
}

export function scorePrivateChunk(chunk, queryTokens, { mode = 'tech', sourceBias = [] } = {}) {
  const title = String(chunk.title || '').toLowerCase();
  const content = String(chunk.content || '').toLowerCase();
  let score = 0;
  for (const token of queryTokens) {
    if (title.includes(token)) score += 3;
    if (content.includes(token)) score += 1;
  }

  const authority = String(chunk.authority || '').toLowerCase();
  const safetyLabel = String(chunk.safety_label || chunk.safetyLabel || '').toLowerCase();
  const safetyCritical = queryTokens.some((token) => SAFETY_CRITICAL_TERMS.has(token));

  if (sourceBias.includes(authority)) score += 4;
  if (mode === 'tech' && ['official', 'manufacturer'].includes(authority)) score += 2;
  if (mode === 'owner' && authority === 'official') score += 1;
  if (safetyCritical && ['official', 'manufacturer'].includes(authority)) score += 5;
  if (safetyCritical && safetyLabel.includes('anecdotal')) score -= 6;

  return score;
}

export function formatPrivateSearchResult(chunk, score, queryTokens) {
  const content = String(chunk.content || '');
  const lower = content.toLowerCase();
  const firstHit = queryTokens.map((token) => lower.indexOf(token)).filter((index) => index >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, firstHit - 80);
  const snippet = content.slice(start, start + 280).replace(/\s+/g, ' ').trim();
  return {
    url: chunk.url,
    title: chunk.title || chunk.url,
    snippet,
    sourceId: chunk.source_id || chunk.sourceId,
    authority: chunk.authority,
    safetyLabel: chunk.safety_label || chunk.safetyLabel,
    score: Number(score.toFixed(3)),
  };
}

export function rankPrivateChunks(chunks, { query, mode = 'tech', limit = 5, sourceBias = [] } = {}) {
  const queryTokens = tokenizeQuery(query);
  return chunks
    .map((chunk) => ({ chunk, score: scorePrivateChunk(chunk, queryTokens, { mode, sourceBias }) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || String(a.chunk.url).localeCompare(String(b.chunk.url)))
    .slice(0, limit)
    .map((entry) => formatPrivateSearchResult(entry.chunk, entry.score, queryTokens));
}
