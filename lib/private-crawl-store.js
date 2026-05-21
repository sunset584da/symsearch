import crypto from 'node:crypto';

export function createStoredChunkId(documentId, chunkIndex, content) {
  const hash = crypto.createHash('sha256').update(`${documentId}:${chunkIndex}:${content}`).digest('hex').slice(0, 24);
  return `${documentId}:${chunkIndex}:${hash}`;
}

function assertSupabase(supabase) {
  if (!supabase || typeof supabase.from !== 'function') {
    throw new Error('Supabase client required');
  }
}

function sourceRow(source) {
  return {
    id: source.id,
    name: source.name,
    type: source.type,
    authority: source.authority,
    base_url: source.baseUrl,
    seed_urls: source.seedUrls || [],
    rate_limit_rps: source.rateLimitRps,
    safety_label: source.safetyLabel,
    priority: source.priority,
    enabled: source.enabled !== false,
    notes: source.notes || null,
    updated_at: new Date().toISOString(),
  };
}

export async function upsertSources(supabase, sources) {
  assertSupabase(supabase);
  const rows = sources.map(sourceRow);
  const { error } = await supabase.from('symsearch_private_sources').upsert(rows, { onConflict: 'id' });
  if (error) throw new Error(`upsertSources failed: ${error.message}`);
  return rows.length;
}

export async function findExistingDocumentByUrl(supabase, url) {
  assertSupabase(supabase);
  const { data, error } = await supabase
    .from('symsearch_private_documents')
    .select('id,content_hash')
    .eq('url', url)
    .maybeSingle();
  if (error) throw new Error(`findExistingDocumentByUrl failed: ${error.message}`);
  return data || null;
}

export async function upsertDocument(supabase, document) {
  assertSupabase(supabase);
  const row = {
    source_id: document.sourceId,
    url: document.url,
    canonical_url: document.canonicalUrl || document.url,
    title: document.title,
    content_type: document.contentType,
    content_hash: document.contentHash,
    word_count: document.wordCount,
    status: document.status || 'fetched',
    error: document.error || null,
    fetched_at: document.fetchedAt,
  };
  const { data, error } = await supabase
    .from('symsearch_private_documents')
    .upsert(row, { onConflict: 'url' })
    .select('id,content_hash')
    .single();
  if (error) throw new Error(`upsertDocument failed: ${error.message}`);
  return data;
}

export async function replaceChunks(supabase, documentId, chunks, { authority } = {}) {
  assertSupabase(supabase);
  const deleted = await supabase.from('symsearch_private_chunks').delete().eq('document_id', documentId);
  if (deleted.error) throw new Error(`replaceChunks delete failed: ${deleted.error.message}`);

  const rows = chunks.map((chunk, index) => ({
    id: createStoredChunkId(documentId, index, chunk.text),
    document_id: documentId,
    source_id: chunk.sourceId,
    url: chunk.url,
    title: chunk.title,
    chunk_index: index,
    content: chunk.text,
    token_count: Math.ceil(chunk.text.length / 4),
    authority: chunk.authority || authority || 'unknown',
    safety_label: chunk.safetyLabel,
    metadata: {
      start: chunk.start,
      end: chunk.end,
    },
  }));

  if (rows.length === 0) return 0;
  const inserted = await supabase.from('symsearch_private_chunks').insert(rows);
  if (inserted.error) throw new Error(`replaceChunks insert failed: ${inserted.error.message}`);
  return rows.length;
}

export async function recordSkippedFetch(supabase, { sourceId, url, reason }) {
  assertSupabase(supabase);
  const row = {
    source_id: sourceId,
    url,
    canonical_url: url,
    title: null,
    content_type: 'text/plain',
    content_hash: crypto.createHash('sha256').update(`${url}:${reason}`).digest('hex'),
    word_count: 0,
    status: 'skipped',
    error: reason,
    fetched_at: new Date().toISOString(),
  };
  const { error } = await supabase.from('symsearch_private_documents').upsert(row, { onConflict: 'url' });
  if (error) throw new Error(`recordSkippedFetch failed: ${error.message}`);
  return row;
}
