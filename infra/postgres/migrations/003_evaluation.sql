begin;

create schema if not exists evaluation;

create table if not exists evaluation.attestation (
  tenant_id text not null,
  space_id text not null,
  attestation_id text not null,
  subject_revision_id text not null,
  subject_payload_digest text,
  issuer text not null,
  issuer_subject_digest text not null,
  idempotency_key text not null,
  attestation_type text not null,
  outcome text not null,
  expires_at timestamptz not null,
  method_digest text not null,
  document jsonb not null,
  document_digest text not null,
  created_at timestamptz not null,
  primary key (tenant_id, attestation_id),
  unique (tenant_id, issuer_subject_digest, idempotency_key),
  check (length(space_id) between 1 and 2048),
  check (length(attestation_id) between 1 and 2048),
  check (subject_revision_id ~ '^urn:akep:sha256:[a-f0-9]{64}$'),
  check (
    subject_payload_digest is null
    or subject_payload_digest ~ '^sha256:[a-f0-9]{64}$'
  ),
  check (issuer_subject_digest ~ '^sha256:[a-f0-9]{64}$'),
  check (outcome in ('pass', 'fail', 'warning', 'informational')),
  check (method_digest ~ '^sha256:[a-f0-9]{64}$'),
  check (document_digest ~ '^sha256:[a-f0-9]{64}$'),
  check (jsonb_typeof(document) = 'object')
);

create index if not exists attestation_subject_idx
  on evaluation.attestation
    (tenant_id, space_id, subject_revision_id, expires_at);

create table if not exists evaluation.evaluation_run (
  tenant_id text not null,
  space_id text not null,
  run_id text not null,
  client_run_id text not null,
  subject_revision_id text not null,
  issuer_subject_digest text not null,
  idempotency_key text not null,
  request_digest text not null,
  evaluator_digest text not null,
  dataset_digest text not null,
  started_at timestamptz not null,
  completed_at timestamptz not null,
  gate_outcome text not null,
  attestation_id text not null,
  document jsonb not null,
  document_digest text not null,
  created_at timestamptz not null,
  primary key (tenant_id, run_id),
  unique (tenant_id, issuer_subject_digest, idempotency_key),
  unique (tenant_id, issuer_subject_digest, client_run_id),
  unique (tenant_id, attestation_id),
  foreign key (tenant_id, attestation_id)
    references evaluation.attestation (tenant_id, attestation_id),
  check (length(space_id) between 1 and 2048),
  check (length(client_run_id) between 1 and 2048),
  check (subject_revision_id ~ '^urn:akep:sha256:[a-f0-9]{64}$'),
  check (issuer_subject_digest ~ '^sha256:[a-f0-9]{64}$'),
  check (request_digest ~ '^sha256:[a-f0-9]{64}$'),
  check (evaluator_digest ~ '^sha256:[a-f0-9]{64}$'),
  check (dataset_digest ~ '^sha256:[a-f0-9]{64}$'),
  check (completed_at >= started_at),
  check (gate_outcome in ('pass', 'warning', 'fail')),
  check (document_digest ~ '^sha256:[a-f0-9]{64}$'),
  check (jsonb_typeof(document) = 'object')
);

create index if not exists evaluation_run_subject_idx
  on evaluation.evaluation_run
    (tenant_id, space_id, subject_revision_id, completed_at desc);

create or replace function evaluation.reject_immutable_evidence_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'AKEP evaluation evidence is immutable; issue a new statement instead';
end;
$$;

drop trigger if exists attestation_is_immutable on evaluation.attestation;
create trigger attestation_is_immutable
before update or delete on evaluation.attestation
for each row execute function evaluation.reject_immutable_evidence_mutation();

drop trigger if exists evaluation_run_is_immutable on evaluation.evaluation_run;
create trigger evaluation_run_is_immutable
before update or delete on evaluation.evaluation_run
for each row execute function evaluation.reject_immutable_evidence_mutation();

commit;
