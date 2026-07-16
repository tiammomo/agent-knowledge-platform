begin;

-- A completed task has one authoritative human/agent outcome in the P0
-- aggregation model. Alternative evaluators belong in immutable EvaluationRuns.
create unique index if not exists feedback_evidence_one_per_usage
  on evaluation.feedback_evidence (usage_id);

commit;
