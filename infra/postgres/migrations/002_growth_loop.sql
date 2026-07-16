begin;

create schema if not exists contribution;
create schema if not exists governance;
create schema if not exists evaluation;

create table if not exists contribution.workflow (
  contribution_id text primary key,
  subject_digest text not null,
  idempotency_key text not null,
  request_digest text not null,
  client_submission_id text not null,
  space_id text not null,
  kind text not null,
  subject_revision_id text not null,
  status text not null,
  workflow_version integer not null default 1,
  request_document jsonb not null,
  payloads jsonb not null default '[]'::jsonb,
  receipt_document jsonb not null,
  review_decision jsonb,
  amendments jsonb not null default '[]'::jsonb,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (subject_digest, idempotency_key),
  unique (subject_digest, client_submission_id),
  check (subject_digest ~ '^sha256:[a-f0-9]{64}$'),
  check (request_digest ~ '^sha256:[a-f0-9]{64}$'),
  check (kind in ('create', 'revise', 'deprecate', 'revoke', 'erase')),
  check (status in (
    'candidate', 'validating', 'needs_evidence', 'verified', 'accepted',
    'rejected', 'quarantined', 'withdrawn'
  )),
  check (workflow_version > 0),
  check (jsonb_typeof(request_document) = 'object'),
  check (jsonb_typeof(payloads) = 'array'),
  check (jsonb_typeof(receipt_document) = 'object'),
  check (jsonb_typeof(amendments) = 'array')
);

create table if not exists governance.lifecycle_event (
  event_id text primary key,
  event_type text not null,
  space_id text not null,
  record_id text not null,
  revision_id text not null,
  policy_epoch text not null,
  document jsonb not null,
  occurred_at timestamptz not null,
  check (event_type in ('channel.updated', 'status.asserted', 'status.cleared')),
  check (jsonb_typeof(document) = 'object')
);

create table if not exists governance.channel (
  tenant_id text not null,
  space_id text not null,
  record_id text not null,
  trust_domain text not null,
  channel_name text not null,
  revision_id text not null,
  event_id text not null references governance.lifecycle_event (event_id),
  updated_at timestamptz not null,
  primary key (tenant_id, space_id, record_id, trust_domain, channel_name),
  check (channel_name in ('candidate', 'verified', 'published'))
);

create table if not exists governance.revision_status (
  tenant_id text not null,
  space_id text not null,
  revision_id text not null,
  trust_domain text not null,
  status_name text not null,
  event_id text not null references governance.lifecycle_event (event_id),
  reason text not null,
  asserted_at timestamptz not null,
  primary key (tenant_id, space_id, revision_id, trust_domain, status_name),
  check (status_name in ('deprecated', 'revoked', 'quarantined', 'erased'))
);

create table if not exists query.knowledge_projection (
  tenant_id text not null,
  space_id text not null,
  record_id text not null,
  revision_id text not null,
  source_contribution_id text not null,
  publication_event_id text not null,
  manifest jsonb not null,
  payloads jsonb not null,
  search_content text not null,
  search_document tsvector generated always as
    (to_tsvector('simple', search_content)) stored,
  quality_decision text not null,
  quality_reasons jsonb not null,
  quality_attestation_refs jsonb not null,
  obligations jsonb not null,
  status text not null default 'published',
  indexed_at timestamptz not null,
  primary key (tenant_id, space_id, revision_id),
  unique (tenant_id, space_id, record_id, revision_id),
  check (jsonb_typeof(manifest) = 'object'),
  check (jsonb_typeof(payloads) = 'array'),
  check (quality_decision in ('suitable', 'suitable_with_warning')),
  check (jsonb_typeof(quality_reasons) = 'array'),
  check (jsonb_typeof(quality_attestation_refs) = 'array'),
  check (jsonb_typeof(obligations) = 'array'),
  check (status in ('published', 'superseded', 'deprecated', 'revoked', 'erased'))
);

create index if not exists knowledge_projection_fts_idx
  on query.knowledge_projection using gin (search_document);

create index if not exists knowledge_projection_record_idx
  on query.knowledge_projection (tenant_id, space_id, record_id, status);

create table if not exists query.usage_receipt (
  usage_id text primary key,
  subject_digest text not null,
  idempotency_key text not null,
  request_digest text not null,
  client_usage_id text not null,
  exposure_receipt_id text not null,
  feedback_until timestamptz not null,
  request_document jsonb not null,
  receipt_document jsonb not null,
  created_at timestamptz not null,
  unique (subject_digest, idempotency_key),
  unique (subject_digest, client_usage_id),
  check (jsonb_typeof(request_document) = 'object'),
  check (jsonb_typeof(receipt_document) = 'object')
);

create table if not exists evaluation.feedback_evidence (
  feedback_id text not null,
  subject_digest text not null,
  idempotency_key text not null,
  request_digest text not null,
  usage_id text not null,
  request_document jsonb not null,
  receipt_document jsonb not null,
  received_at timestamptz not null,
  primary key (subject_digest, feedback_id),
  unique (subject_digest, idempotency_key),
  check (jsonb_typeof(request_document) = 'object'),
  check (jsonb_typeof(receipt_document) = 'object')
);

commit;
