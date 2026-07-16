begin;

-- Repair any historical split-brain projection by retaining the authoritative
-- governance.channel head where it exists, then falling back to the newest
-- projection for legacy rows that predate the channel table.
update query.knowledge_projection projection
   set status = 'superseded'
 where projection.status = 'published'
   and exists (
     select 1
       from governance.channel channel
      where channel.tenant_id = projection.tenant_id
        and channel.space_id = projection.space_id
        and channel.record_id = projection.record_id
        and channel.channel_name = 'published'
        and channel.revision_id <> projection.revision_id
   );

with ranked as (
  select tenant_id, space_id, record_id, revision_id,
         row_number() over (
           partition by tenant_id, space_id, record_id
           order by indexed_at desc, revision_id desc
         ) as ordinal
    from query.knowledge_projection
   where status = 'published'
)
update query.knowledge_projection projection
   set status = 'superseded'
  from ranked
 where ranked.ordinal > 1
   and projection.tenant_id = ranked.tenant_id
   and projection.space_id = ranked.space_id
   and projection.record_id = ranked.record_id
   and projection.revision_id = ranked.revision_id;

create unique index if not exists knowledge_projection_one_published_record_idx
  on query.knowledge_projection (tenant_id, space_id, record_id)
  where status = 'published';

commit;
