select extname from pg_extension where extname in ('pgcrypto', 'vector') order by extname;
select schemaname, tablename
from pg_tables
where schemaname in ('catalog', 'contribution', 'evaluation', 'governance', 'platform', 'query')
order by schemaname, tablename;
