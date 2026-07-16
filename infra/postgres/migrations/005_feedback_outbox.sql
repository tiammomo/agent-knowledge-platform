begin;

create or replace function query.enqueue_usage_evidence()
returns trigger
language plpgsql
as $$
begin
  insert into platform.outbox_event
    (owner_module, event_type, aggregate_id, payload)
  values
    ('query', 'usage.recorded', new.usage_id,
     jsonb_build_object(
       'usageId', new.usage_id,
       'clientUsageId', new.client_usage_id,
       'exposureReceiptId', new.exposure_receipt_id,
       'occurredAt', new.created_at
     ));
  return new;
end;
$$;

drop trigger if exists usage_evidence_outbox on query.usage_receipt;
create trigger usage_evidence_outbox
after insert on query.usage_receipt
for each row execute function query.enqueue_usage_evidence();

create or replace function evaluation.enqueue_feedback_evidence()
returns trigger
language plpgsql
as $$
begin
  insert into platform.outbox_event
    (owner_module, event_type, aggregate_id, payload)
  values
    ('evaluation',
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

drop trigger if exists feedback_evidence_outbox on evaluation.feedback_evidence;
create trigger feedback_evidence_outbox
after insert on evaluation.feedback_evidence
for each row execute function evaluation.enqueue_feedback_evidence();

commit;
