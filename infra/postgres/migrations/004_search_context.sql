begin;

create extension if not exists pg_trgm;

alter table query.chunk_projection
  add column if not exists payload_digest text,
  add column if not exists payload_name text,
  add column if not exists start_offset bigint,
  add column if not exists end_offset bigint,
  add column if not exists chunker_fingerprint text not null default 'legacy-v1',
  add column if not exists indexed_at timestamptz not null default clock_timestamp(),
  add column if not exists search_normalized text generated always as
    (lower(regexp_replace(content, '\s+', '', 'g'))) stored;

alter table query.chunk_projection
  drop constraint if exists chunk_projection_payload_digest_check,
  drop constraint if exists chunk_projection_payload_name_check,
  drop constraint if exists chunk_projection_text_offset_check;

alter table query.chunk_projection
  add constraint chunk_projection_payload_digest_check
    check (payload_digest is null or payload_digest ~ '^sha256:[a-f0-9]{64}$'),
  add constraint chunk_projection_payload_name_check
    check (payload_name is null or payload_name ~ '^[a-z][a-z0-9._-]{0,63}$'),
  add constraint chunk_projection_text_offset_check
    check (
      (start_offset is null and end_offset is null)
      or (start_offset >= 0 and end_offset > start_offset)
    );

create index if not exists chunk_projection_lookup_idx
  on query.chunk_projection
    (tenant_id, space_id, revision_id, chunker_fingerprint, ordinal);

create index if not exists chunk_projection_normalized_trgm_idx
  on query.chunk_projection using gin (search_normalized gin_trgm_ops);

comment on column query.chunk_projection.start_offset is
  'Inclusive UTF-8 byte offset in the immutable payload representation.';

comment on column query.chunk_projection.end_offset is
  'Exclusive UTF-8 byte offset in the immutable payload representation.';

comment on column query.chunk_projection.chunker_fingerprint is
  'Versioned deterministic chunker identity; query cursors bind its projection generation.';

commit;
