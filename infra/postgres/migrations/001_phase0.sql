begin;

create extension if not exists pgcrypto;
create extension if not exists vector;

create schema if not exists platform;
create schema if not exists catalog;
create schema if not exists query;

create table if not exists catalog.record (
  tenant_id text not null,
  space_id text not null,
  record_id text not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (tenant_id, space_id, record_id),
  check (length(tenant_id) between 1 and 255),
  check (length(space_id) between 1 and 2048),
  check (length(record_id) between 1 and 2048)
);

create table if not exists catalog.revision (
  tenant_id text not null,
  space_id text not null,
  record_id text not null,
  revision_id text not null,
  manifest jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (tenant_id, space_id, revision_id),
  foreign key (tenant_id, space_id, record_id)
    references catalog.record (tenant_id, space_id, record_id),
  check (revision_id ~ '^urn:akep:sha256:[a-f0-9]{64}$'),
  check (jsonb_typeof(manifest) = 'object')
);

create table if not exists catalog.content_blob (
  tenant_id text not null,
  digest text not null,
  media_type text not null,
  size_bytes bigint not null,
  storage_key text not null,
  verification_status text not null default 'pending',
  created_at timestamptz not null default clock_timestamp(),
  primary key (tenant_id, digest),
  unique (tenant_id, storage_key),
  check (digest ~ '^sha256:[a-f0-9]{64}$'),
  check (size_bytes between 0 and 9007199254740991),
  check (verification_status in ('pending', 'verified', 'quarantined'))
);

create table if not exists catalog.revision_blob (
  tenant_id text not null,
  space_id text not null,
  revision_id text not null,
  name text not null,
  digest text not null,
  primary key (tenant_id, space_id, revision_id, name),
  foreign key (tenant_id, space_id, revision_id)
    references catalog.revision (tenant_id, space_id, revision_id),
  foreign key (tenant_id, digest)
    references catalog.content_blob (tenant_id, digest),
  check (name ~ '^[a-z][a-z0-9._-]{0,63}$')
);

create table if not exists query.exposure_receipt (
  exposure_receipt_id text primary key,
  subject_digest text not null,
  policy_epoch text not null,
  expires_at timestamptz not null,
  document jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  check (exposure_receipt_id ~ '^urn:uuid:[0-9a-f-]{36}$'),
  check (subject_digest ~ '^sha256:[a-f0-9]{64}$'),
  check (jsonb_typeof(document) = 'object')
);

create index if not exists exposure_receipt_expiry_idx
  on query.exposure_receipt (expires_at);

create table if not exists query.chunk_projection (
  tenant_id text not null,
  space_id text not null,
  revision_id text not null,
  chunk_id text not null,
  ordinal integer not null,
  content text not null,
  search_document tsvector generated always as
    (to_tsvector('simple', content)) stored,
  embedding vector,
  embedding_model_fingerprint text,
  projection_schema_version text not null,
  policy_epoch text not null,
  primary key (tenant_id, space_id, revision_id, chunk_id),
  check (ordinal >= 0),
  check (
    (embedding is null and embedding_model_fingerprint is null)
    or (embedding is not null and embedding_model_fingerprint is not null)
  )
);

create index if not exists chunk_projection_fts_idx
  on query.chunk_projection using gin (search_document);

create table if not exists platform.outbox_event (
  event_id uuid primary key default gen_random_uuid(),
  owner_module text not null,
  event_type text not null,
  aggregate_id text not null,
  payload jsonb not null,
  occurred_at timestamptz not null default clock_timestamp(),
  available_at timestamptz not null default clock_timestamp(),
  published_at timestamptz,
  attempts integer not null default 0,
  check (owner_module ~ '^[a-z][a-z0-9._-]{0,63}$'),
  check (event_type ~ '^[a-zA-Z][a-zA-Z0-9._-]{0,127}$'),
  check (jsonb_typeof(payload) = 'object'),
  check (attempts >= 0)
);

create index if not exists outbox_pending_idx
  on platform.outbox_event (available_at, occurred_at)
  where published_at is null;

create or replace function catalog.reject_revision_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'AKEP revisions are immutable; create a new revision instead';
end;
$$;

drop trigger if exists revision_is_immutable on catalog.revision;
create trigger revision_is_immutable
before update or delete on catalog.revision
for each row execute function catalog.reject_revision_mutation();

commit;
