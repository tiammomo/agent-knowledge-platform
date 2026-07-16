begin;

create table if not exists contribution.mutation_idempotency (
  tenant_id text not null,
  subject_digest text not null,
  operation text not null,
  idempotency_key text not null,
  request_digest text not null,
  response_status integer not null,
  response_document jsonb not null,
  response_headers jsonb not null,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  primary key (tenant_id, subject_digest, operation, idempotency_key),
  check (subject_digest ~ '^sha256:[a-f0-9]{64}$'),
  check (length(operation) between 1 and 4096),
  check (length(idempotency_key) between 1 and 255),
  check (request_digest ~ '^sha256:[a-f0-9]{64}$'),
  check (response_status between 100 and 599),
  check (jsonb_typeof(response_document) = 'object'),
  check (jsonb_typeof(response_headers) = 'object'),
  check (expires_at > created_at)
);

create index if not exists mutation_idempotency_expiry_idx
  on contribution.mutation_idempotency (expires_at);

commit;
