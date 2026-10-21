-- Direct/indirect orders (Shopee "Tipe Pesanan"). A commission report with
-- that column stores 11 entries per order part instead of 8:
--   [comm, comm_done, comm_pending, gmv, qty, refund, excluded, rows,
--    comm_direct, comm_indirect, attr]
-- attr is a bit set of the kept rows: 1 direct, 2 indirect, 4 unlabelled.
-- Parts with 8 entries stay valid (reports without the column, and every
-- record saved before this migration). Totals still come from entries 0-7
-- only, so _parts_totals and every saved record are unchanged.
-- Only this check function changes; no table, row or grant is touched.
create or replace function dashboard._parts_ok(parts jsonb) returns boolean
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case when parts is null or jsonb_typeof(parts) <> 'object' or parts = '{}'::jsonb then false
    when exists (select 1 from jsonb_each(parts) e where e.key !~ '^(r:)?[0-9a-f]{16}$'
      or jsonb_typeof(e.value) <> 'array' or jsonb_array_length(e.value) not in (8, 11)) then false
    else not exists (select 1 from jsonb_each(parts) e, jsonb_array_elements(e.value) with ordinality x(v, i)
      where jsonb_typeof(x.v) <> 'number'
        or (x.i in (1, 2, 3, 4, 5, 6, 9, 10) and not dashboard._num_ok((x.v #>> '{}')::float8))
        or (x.i in (7, 8, 11) and ((x.v #>> '{}')::numeric < 0 or (x.v #>> '{}')::numeric <> trunc((x.v #>> '{}')::numeric)
          or (x.v #>> '{}')::numeric > 9007199254740991)))
      and not exists (select 1 from jsonb_each(parts) e
        where (e.value ->> 7)::numeric < 1 or (e.value ->> 6)::numeric > (e.value ->> 7)::numeric
          or (jsonb_array_length(e.value) = 11 and (e.value ->> 10)::numeric > 7)) end
$$;
