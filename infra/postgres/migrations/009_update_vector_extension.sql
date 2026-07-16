begin;

-- Use the newest update path installed by the PostgreSQL image or managed
-- service. If the server only provides the current version, PostgreSQL keeps
-- that version and emits a notice without changing existing vector data.
alter extension vector update;

commit;
