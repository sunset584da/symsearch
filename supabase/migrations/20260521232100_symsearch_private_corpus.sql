create table if not exists symsearch_private_sources (
  id text primary key,
  name text not null,
  type text not null,
  authority text not null,
  base_url text not null,
  seed_urls jsonb not null default '[]'::jsonb,
  rate_limit_rps numeric not null default 0.5,
  safety_label text not null,
  priority int not null default 50,
  enabled boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists symsearch_private_documents (
  id uuid primary key default gen_random_uuid(),
  source_id text not null references symsearch_private_sources(id),
  url text not null unique,
  canonical_url text,
  title text,
  content_type text,
  content_hash text not null,
  word_count int not null default 0,
  status text not null default 'fetched',
  error text,
  fetched_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists symsearch_private_chunks (
  id text primary key,
  document_id uuid not null references symsearch_private_documents(id) on delete cascade,
  source_id text not null references symsearch_private_sources(id),
  url text not null,
  title text,
  chunk_index int not null,
  content text not null,
  token_count int,
  authority text not null,
  safety_label text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists symsearch_private_chunks_source_idx on symsearch_private_chunks(source_id);
create index if not exists symsearch_private_chunks_safety_idx on symsearch_private_chunks(safety_label);
create index if not exists symsearch_private_chunks_authority_idx on symsearch_private_chunks(authority);
create index if not exists symsearch_private_documents_source_idx on symsearch_private_documents(source_id);
