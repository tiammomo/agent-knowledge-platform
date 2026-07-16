begin;

create or replace function platform.current_tenant_id()
returns text
language sql
stable
parallel safe
as $$
  select nullif(current_setting('akep.tenant_id', true), '')
$$;

comment on function platform.current_tenant_id() is
  'Tenant bound to the current database session. RLS denies access when it is absent.';

alter table contribution.workflow
  add column if not exists tenant_id text;
alter table governance.lifecycle_event
  add column if not exists tenant_id text;
alter table query.exposure_receipt
  add column if not exists tenant_id text;
alter table query.usage_receipt
  add column if not exists tenant_id text;
alter table evaluation.feedback_evidence
  add column if not exists tenant_id text;
alter table platform.outbox_event
  add column if not exists tenant_id text;

do $$
declare
  configured_tenant text := platform.current_tenant_id();
  has_unscoped_rows boolean;
begin
  if exists (
    select reference.event_id
      from (
        select tenant_id, event_id from governance.channel
        union all
        select tenant_id, event_id from governance.revision_status
        union all
        select tenant_id, publication_event_id as event_id
          from query.knowledge_projection
      ) reference
     group by reference.event_id
    having count(distinct reference.tenant_id) > 1
  ) then
    raise exception
      'Cannot infer lifecycle event tenant because existing references disagree';
  end if;

  if exists (
    select source_contribution_id
      from query.knowledge_projection
     group by source_contribution_id
    having count(distinct tenant_id) > 1
  ) then
    raise exception
      'Cannot infer contribution tenant because existing projections disagree';
  end if;

  update governance.lifecycle_event event
     set tenant_id = reference.tenant_id
    from (
      select event_id, min(tenant_id) as tenant_id
        from (
          select tenant_id, event_id from governance.channel
          union all
          select tenant_id, event_id from governance.revision_status
          union all
          select tenant_id, publication_event_id as event_id
            from query.knowledge_projection
        ) tenant_reference
       group by event_id
      having count(distinct tenant_id) = 1
    ) reference
   where event.event_id = reference.event_id
     and event.tenant_id is null;

  update contribution.workflow workflow
     set tenant_id = reference.tenant_id
    from (
      select source_contribution_id, min(tenant_id) as tenant_id
        from query.knowledge_projection
       group by source_contribution_id
      having count(distinct tenant_id) = 1
    ) reference
   where workflow.contribution_id = reference.source_contribution_id
     and workflow.tenant_id is null;

  update query.exposure_receipt receipt
     set tenant_id = reference.tenant_id
    from (
      select receipt.exposure_receipt_id, min(projection.tenant_id) as tenant_id
        from query.exposure_receipt receipt
        cross join lateral jsonb_array_elements(receipt.document->'citations') citation
        join query.knowledge_projection projection
          on projection.space_id = citation->>'spaceId'
         and projection.revision_id = citation->>'revisionId'
       group by receipt.exposure_receipt_id
      having count(distinct projection.tenant_id) = 1
    ) reference
   where receipt.exposure_receipt_id = reference.exposure_receipt_id
     and receipt.tenant_id is null;

  update query.usage_receipt usage
     set tenant_id = receipt.tenant_id
    from query.exposure_receipt receipt
   where usage.exposure_receipt_id = receipt.exposure_receipt_id
     and usage.tenant_id is null
     and receipt.tenant_id is not null;

  update evaluation.feedback_evidence feedback
     set tenant_id = usage.tenant_id
    from query.usage_receipt usage
   where feedback.usage_id = usage.usage_id
     and feedback.tenant_id is null
     and usage.tenant_id is not null;

  update platform.outbox_event event
     set tenant_id = lifecycle.tenant_id
    from governance.lifecycle_event lifecycle
   where event.owner_module = 'governance'
     and event.payload->>'eventId' = lifecycle.event_id
     and event.tenant_id is null;

  update platform.outbox_event event
     set tenant_id = usage.tenant_id
    from query.usage_receipt usage
   where event.owner_module = 'query'
     and event.aggregate_id = usage.usage_id
     and event.tenant_id is null;

  update platform.outbox_event event
     set tenant_id = feedback.tenant_id
    from evaluation.feedback_evidence feedback
   where event.owner_module = 'evaluation'
     and event.aggregate_id = feedback.feedback_id
     and event.tenant_id is null;

  select
    exists (select 1 from contribution.workflow where tenant_id is null)
    or exists (select 1 from governance.lifecycle_event where tenant_id is null)
    or exists (select 1 from query.exposure_receipt where tenant_id is null)
    or exists (select 1 from query.usage_receipt where tenant_id is null)
    or exists (select 1 from evaluation.feedback_evidence where tenant_id is null)
    or exists (select 1 from platform.outbox_event where tenant_id is null)
    into has_unscoped_rows;

  if has_unscoped_rows and configured_tenant is null then
    raise exception
      'AKEP tenant context is required to backfill existing single-tenant rows';
  end if;

  if configured_tenant is not null then
    update contribution.workflow
       set tenant_id = configured_tenant where tenant_id is null;
    update governance.lifecycle_event
       set tenant_id = configured_tenant where tenant_id is null;
    update query.exposure_receipt
       set tenant_id = configured_tenant where tenant_id is null;
    update query.usage_receipt
       set tenant_id = configured_tenant where tenant_id is null;
    update evaluation.feedback_evidence
       set tenant_id = configured_tenant where tenant_id is null;
    update platform.outbox_event
       set tenant_id = configured_tenant where tenant_id is null;
  end if;
end;
$$;

alter table contribution.workflow alter column tenant_id set not null;
alter table governance.lifecycle_event alter column tenant_id set not null;
alter table query.exposure_receipt alter column tenant_id set not null;
alter table query.usage_receipt alter column tenant_id set not null;
alter table evaluation.feedback_evidence alter column tenant_id set not null;
alter table platform.outbox_event alter column tenant_id set not null;

alter table platform.outbox_event
  drop constraint if exists outbox_event_pkey;
alter table platform.outbox_event
  add primary key (tenant_id, event_id);

alter table contribution.workflow
  drop constraint if exists workflow_pkey,
  drop constraint if exists workflow_subject_digest_idempotency_key_key,
  drop constraint if exists workflow_subject_digest_client_submission_id_key;
alter table contribution.workflow
  add primary key (tenant_id, contribution_id),
  add unique (tenant_id, subject_digest, idempotency_key),
  add unique (tenant_id, subject_digest, client_submission_id);

alter table governance.channel
  drop constraint if exists channel_event_id_fkey;
alter table governance.revision_status
  drop constraint if exists revision_status_event_id_fkey;
alter table governance.lifecycle_event
  drop constraint if exists lifecycle_event_pkey;
alter table governance.lifecycle_event
  add primary key (tenant_id, event_id);
alter table governance.channel
  add foreign key (tenant_id, event_id)
    references governance.lifecycle_event (tenant_id, event_id);
alter table governance.revision_status
  add foreign key (tenant_id, event_id)
    references governance.lifecycle_event (tenant_id, event_id);

alter table query.exposure_receipt
  drop constraint if exists exposure_receipt_pkey;
alter table query.exposure_receipt
  add primary key (tenant_id, exposure_receipt_id);

alter table query.usage_receipt
  drop constraint if exists usage_receipt_pkey,
  drop constraint if exists usage_receipt_subject_digest_idempotency_key_key,
  drop constraint if exists usage_receipt_subject_digest_client_usage_id_key;
alter table query.usage_receipt
  add primary key (tenant_id, usage_id),
  add unique (tenant_id, subject_digest, idempotency_key),
  add unique (tenant_id, subject_digest, client_usage_id),
  add foreign key (tenant_id, exposure_receipt_id)
    references query.exposure_receipt (tenant_id, exposure_receipt_id);

drop index if exists evaluation.feedback_evidence_one_per_usage;
alter table evaluation.feedback_evidence
  drop constraint if exists feedback_evidence_pkey,
  drop constraint if exists feedback_evidence_subject_digest_idempotency_key_key;
alter table evaluation.feedback_evidence
  add primary key (tenant_id, subject_digest, feedback_id),
  add unique (tenant_id, subject_digest, idempotency_key),
  add foreign key (tenant_id, usage_id)
    references query.usage_receipt (tenant_id, usage_id);
create unique index feedback_evidence_one_per_usage
  on evaluation.feedback_evidence (tenant_id, usage_id);

alter table query.knowledge_projection
  add foreign key (tenant_id, source_contribution_id)
    references contribution.workflow (tenant_id, contribution_id),
  add foreign key (tenant_id, publication_event_id)
    references governance.lifecycle_event (tenant_id, event_id);

drop index if exists query.exposure_receipt_expiry_idx;
create index exposure_receipt_expiry_idx
  on query.exposure_receipt (tenant_id, expires_at);
drop index if exists platform.outbox_pending_idx;
create index outbox_pending_idx
  on platform.outbox_event (tenant_id, available_at, occurred_at)
  where published_at is null;
drop index if exists contribution.mutation_idempotency_expiry_idx;
create index mutation_idempotency_expiry_idx
  on contribution.mutation_idempotency (tenant_id, expires_at);

create or replace function query.enqueue_usage_evidence()
returns trigger
language plpgsql
as $$
begin
  insert into platform.outbox_event
    (tenant_id, owner_module, event_type, aggregate_id, payload)
  values
    (new.tenant_id, 'query', 'usage.recorded', new.usage_id,
     jsonb_build_object(
       'usageId', new.usage_id,
       'clientUsageId', new.client_usage_id,
       'exposureReceiptId', new.exposure_receipt_id,
       'occurredAt', new.created_at
     ));
  return new;
end;
$$;

create or replace function evaluation.enqueue_feedback_evidence()
returns trigger
language plpgsql
as $$
begin
  insert into platform.outbox_event
    (tenant_id, owner_module, event_type, aggregate_id, payload)
  values
    (new.tenant_id,
     'evaluation',
     case
       when new.request_document ->> 'outcome' = 'harmed'
       then 'feedback.harmed'
       else 'feedback.recorded'
     end,
     new.feedback_id,
     jsonb_build_object(
       'feedbackId', new.feedback_id,
       'usageId', new.usage_id,
       'outcome', new.request_document ->> 'outcome',
       'taskCategory', new.request_document ->> 'taskCategory',
       'receivedAt', new.received_at
     ));
  return new;
end;
$$;

do $$
declare
  relation_name text;
begin
  foreach relation_name in array array[
    'catalog.record',
    'catalog.revision',
    'catalog.content_blob',
    'catalog.revision_blob',
    'contribution.workflow',
    'contribution.mutation_idempotency',
    'evaluation.attestation',
    'evaluation.evaluation_run',
    'evaluation.feedback_evidence',
    'governance.lifecycle_event',
    'governance.channel',
    'governance.revision_status',
    'platform.outbox_event',
    'query.exposure_receipt',
    'query.chunk_projection',
    'query.knowledge_projection',
    'query.usage_receipt'
  ]
  loop
    execute format('alter table %s enable row level security', relation_name);
    execute format('alter table %s force row level security', relation_name);
    execute format('drop policy if exists tenant_isolation on %s', relation_name);
    execute format(
      'create policy tenant_isolation on %s using '
      || '(tenant_id = platform.current_tenant_id()) with check '
      || '(tenant_id = platform.current_tenant_id())',
      relation_name
    );
  end loop;
end;
$$;

commit;
