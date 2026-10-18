-- Shared daily history for every dashboard account.
--
-- Mirrors the browser store (daily-store.js, database version 2): daily
-- aggregates per (account, date, tag | ad unit), dated row fingerprints for
-- dedup, and the upload log. Raw CSV rows, buyer data, product names and
-- clear order IDs never reach this database; order identities are the same
-- 16-hex hashes the browser already keeps.
--
-- Access model: the anon key is public. Tables live in the private schema
-- "dashboard", which the Data API does not expose, so neither anon nor
-- signed-in users can touch them directly (RLS is on as a second guard).
-- The only entry points are the public.daily_* SECURITY DEFINER functions:
-- they check dashboard.team_members, lock the account row, compare the
-- caller's expected revision, and merge exactly like DailyAgg.mergeDaily.
-- A stale browser cache is refused instead of guessed.

create schema if not exists dashboard;
revoke all on schema dashboard from public, anon, authenticated;

create table dashboard.team_members (
  user_id uuid primary key references auth.users (id) on delete cascade,
  added_at timestamptz not null default now()
);

create table dashboard.accounts (
  id bigint generated always as identity primary key,
  kind text not null default 'shopee' check (kind = 'shopee'),
  name text not null check (length(btrim(name)) between 1 and 2048 and name = btrim(name)),
  -- Bumped by every write. Browsers cache one revision and must match it.
  revision bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (kind, name)
);

create or replace function dashboard._valid_order_keys(keys text[]) returns boolean
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select coalesce(bool_and(k ~ '^[a-f0-9]{16}$'), true)
     and cardinality(keys) = (select count(distinct k) from unnest(keys) k)
  from unnest(keys) k
$$;

create or replace function dashboard._jsonb_count_total(counts jsonb) returns bigint
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case when jsonb_typeof(counts) <> 'object' then null
    else coalesce((select sum((value #>> '{}')::bigint) from jsonb_each(counts)), 0) end
$$;

create table dashboard.daily_affiliate (
  account_id bigint not null references dashboard.accounts (id) on delete cascade,
  date date not null,
  tag text not null check (length(tag) between 1 and 2048),
  comm double precision not null,
  comm_done double precision not null,
  comm_pending double precision not null,
  gmv double precision not null,
  qty double precision not null,
  refund double precision not null,
  orders integer not null check (orders >= 0),
  order_keys text[] not null default '{}',
  excluded integer not null check (excluded >= 0),
  rows integer not null check (rows >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  primary key (account_id, date, tag),
  check (orders = cardinality(order_keys) and dashboard._valid_order_keys(order_keys)),
  check (excluded <= rows and orders <= rows - excluded)
);

create table dashboard.daily_ads (
  account_id bigint not null references dashboard.accounts (id) on delete cascade,
  date date not null,
  -- Meta ad name as the browser store keys it today (not ad_id).
  ad_unit text not null check (length(ad_unit) between 1 and 2048),
  spend double precision not null,
  impressions double precision not null,
  reach double precision not null,
  clicks double precision not null,
  shop_clicks double precision not null,
  lpv double precision not null,
  results double precision not null,
  rows integer not null check (rows >= 0),
  cpm double precision not null,
  cpc double precision not null,
  ctr double precision not null,
  delivery text not null default '' check (length(delivery) <= 256),
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  primary key (account_id, date, ad_unit)
);

create table dashboard.daily_clicks (
  account_id bigint not null references dashboard.accounts (id) on delete cascade,
  date date not null,
  tag text not null check (length(tag) between 1 and 2048),
  clicks integer not null check (clicks >= 0),
  by_region jsonb not null default '{}',
  by_source jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  primary key (account_id, date, tag),
  check (dashboard._jsonb_count_total(by_region) = clicks and dashboard._jsonb_count_total(by_source) = clicks)
);

-- One fingerprint per aggregated source row; keeps re-uploads from double counting.
create table dashboard.row_hashes (
  account_id bigint not null references dashboard.accounts (id) on delete cascade,
  kind text not null check (kind in ('affiliate', 'ads', 'clicks')),
  hash text not null check (length(hash) between 1 and 256),
  date date,
  primary key (account_id, kind, hash)
);
create index row_hashes_day on dashboard.row_hashes (account_id, kind, date);

create table dashboard.uploads (
  id bigint generated always as identity primary key,
  account_id bigint not null references dashboard.accounts (id) on delete cascade,
  kind text not null check (kind in ('affiliate', 'ads', 'clicks')),
  file_hash text not null check (length(file_hash) between 1 and 256),
  file_name text not null default '' check (length(file_name) <= 1024),
  rows integer not null default 0 check (rows >= 0),
  added integer not null default 0 check (added >= 0),
  updated integer not null default 0 check (updated >= 0),
  duplicates integer not null default 0 check (duplicates >= 0),
  period_start date,
  period_end date,
  uploaded_at timestamptz not null default now(),
  uploaded_by uuid references auth.users (id) on delete set null,
  unique (account_id, kind, file_hash),
  check ((period_start is null) = (period_end is null) and (period_start is null or period_start <= period_end))
);
create index uploads_account on dashboard.uploads (account_id, uploaded_at desc);

-- ── Access ─────────────────────────────────────────────────────────────────
create or replace function dashboard.is_member() returns boolean
language sql stable security definer set search_path = dashboard, pg_temp as $$
  select exists (select 1 from dashboard.team_members where user_id = auth.uid())
$$;

alter table dashboard.team_members enable row level security;
alter table dashboard.accounts enable row level security;
alter table dashboard.daily_affiliate enable row level security;
alter table dashboard.daily_ads enable row level security;
alter table dashboard.daily_clicks enable row level security;
alter table dashboard.row_hashes enable row level security;
alter table dashboard.uploads enable row level security;

-- No policies: with RLS on and no grants, direct table access is denied.
revoke all on all tables in schema dashboard from public, anon, authenticated;

-- ── Helpers ────────────────────────────────────────────────────────────────
create or replace function dashboard._iso(ts timestamptz) returns text
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select to_char(ts at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$$;

create or replace function dashboard._text_union(a text[], b text[]) returns text[]
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select coalesce(array_agg(k order by k), '{}') from (select distinct unnest(a || b) k) s
$$;

create or replace function dashboard._jsonb_count_sum(a jsonb, b jsonb) returns jsonb
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select coalesce(jsonb_object_agg(key, total), '{}') from (
    select key, sum((value #>> '{}')::bigint) total
    from (select * from jsonb_each(a) union all select * from jsonb_each(b)) e group by key) s
$$;

create or replace function dashboard._require_member() returns void
language plpgsql stable security definer set search_path = dashboard, pg_temp as $$
begin
  if not dashboard.is_member() then
    raise exception 'Akun Anda belum terdaftar sebagai anggota tim' using errcode = 'PT403';
  end if;
end $$;

-- Lock the account and refuse a browser cache that is behind the database.
create or replace function dashboard._lock_account(p_account_id bigint, p_expected_revision bigint) returns bigint
language plpgsql security definer set search_path = dashboard, pg_temp as $$
declare current_revision bigint;
begin
  select revision into current_revision from dashboard.accounts where id = p_account_id for update;
  if not found then raise exception 'Akun tidak ditemukan' using errcode = 'PT404'; end if;
  if p_expected_revision is distinct from current_revision then
    raise exception 'STALE_REVISION' using errcode = 'PT409',
      detail = format('expected %s, current %s', p_expected_revision, current_revision);
  end if;
  return current_revision;
end $$;

create or replace function dashboard._bump(p_account_id bigint) returns bigint
language sql security definer set search_path = dashboard, pg_temp as $$
  update dashboard.accounts set revision = revision + 1, updated_at = now() where id = p_account_id returning revision
$$;

-- ── Reads ──────────────────────────────────────────────────────────────────
-- Account list with enough to decide whether a browser cache is current.
create or replace function public.daily_list_accounts()
returns table (id bigint, kind text, name text, revision bigint, aggregates bigint, created_at text)
language plpgsql stable security definer set search_path = dashboard, pg_temp as $$
begin
  perform dashboard._require_member();
  return query select a.id, a.kind, a.name, a.revision,
    (select count(*) from dashboard.daily_affiliate x where x.account_id = a.id)
    + (select count(*) from dashboard.daily_ads x where x.account_id = a.id)
    + (select count(*) from dashboard.daily_clicks x where x.account_id = a.id),
    dashboard._iso(a.created_at)
  from dashboard.accounts a order by a.name;
end $$;

-- One consistent snapshot in the browser backup shape (affiliate-daily-backup v1),
-- so the browser validates it with DailyStore.validateBackup before caching it.
create or replace function public.daily_export_account(p_account_id bigint) returns jsonb
language plpgsql stable security definer set search_path = dashboard, pg_temp as $$
declare a dashboard.accounts;
begin
  perform dashboard._require_member();
  select * into a from dashboard.accounts where id = p_account_id;
  if not found then raise exception 'Akun tidak ditemukan' using errcode = 'PT404'; end if;
  return jsonb_build_object(
    'format', 'affiliate-daily-backup', 'version', 1, 'database_version', 2,
    'exported_at', dashboard._iso(now()), 'revision', a.revision,
    'account', jsonb_build_object('id', a.id, 'kind', a.kind, 'name', a.name, 'created', dashboard._iso(a.created_at)),
    'affiliate', coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'account_id', x.account_id, 'date', x.date, 'tag', x.tag, 'comm', x.comm, 'comm_done', x.comm_done,
        'comm_pending', x.comm_pending, 'gmv', x.gmv, 'qty', x.qty, 'refund', x.refund, 'orders', x.orders,
        'order_keys', to_jsonb(x.order_keys), 'excluded', x.excluded, 'rows', x.rows, 'merge_version', 1,
        'created_at', dashboard._iso(x.created_at), 'updated_at', dashboard._iso(x.updated_at))) order by x.date, x.tag)
      from dashboard.daily_affiliate x where x.account_id = a.id), '[]'),
    'ads', coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'account_id', x.account_id, 'date', x.date, 'ad_unit', x.ad_unit, 'spend', x.spend,
        'impressions', x.impressions, 'reach', x.reach, 'clicks', x.clicks, 'shop_clicks', x.shop_clicks,
        'lpv', x.lpv, 'results', x.results, 'rows', x.rows, 'cpm', x.cpm, 'cpc', x.cpc, 'ctr', x.ctr,
        'delivery', x.delivery, 'merge_version', 1,
        'created_at', dashboard._iso(x.created_at), 'updated_at', dashboard._iso(x.updated_at))) order by x.date, x.ad_unit)
      from dashboard.daily_ads x where x.account_id = a.id), '[]'),
    'clicks', coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'account_id', x.account_id, 'date', x.date, 'tag', x.tag, 'clicks', x.clicks,
        'by_region', x.by_region, 'by_source', x.by_source, 'merge_version', 1,
        'created_at', dashboard._iso(x.created_at), 'updated_at', dashboard._iso(x.updated_at))) order by x.date, x.tag)
      from dashboard.daily_clicks x where x.account_id = a.id), '[]'),
    'uploads', coalesce((select jsonb_agg(jsonb_build_object(
        'account_id', x.account_id, 'kind', x.kind, 'file_hash', x.file_hash, 'file_name', x.file_name,
        'rows', x.rows, 'added', x.added, 'updated', x.updated, 'duplicates', x.duplicates,
        'period_start', x.period_start, 'period_end', x.period_end, 'uploaded_at', dashboard._iso(x.uploaded_at)) order by x.id)
      from dashboard.uploads x where x.account_id = a.id), '[]'),
    'rowhashes', coalesce((select jsonb_agg(jsonb_build_object(
        'account_id', x.account_id, 'kind', x.kind, 'hash', x.hash, 'date', x.date) order by x.kind, x.hash)
      from dashboard.row_hashes x where x.account_id = a.id), '[]'));
end $$;

-- ── Writes ─────────────────────────────────────────────────────────────────
create or replace function public.daily_ensure_account(p_name text) returns jsonb
language plpgsql security definer set search_path = dashboard, pg_temp as $$
declare a dashboard.accounts;
begin
  perform dashboard._require_member();
  insert into dashboard.accounts (kind, name) values ('shopee', btrim(p_name))
    on conflict (kind, name) do nothing;
  select * into a from dashboard.accounts where kind = 'shopee' and name = btrim(p_name);
  return jsonb_build_object('id', a.id, 'name', a.name, 'revision', a.revision);
end $$;

-- Add the contribution of rows the browser deduplicated against the cache at
-- p_expected_revision. p_records come from DailyAgg.aggregate, p_hashes are
-- [{hash, date}] for exactly those rows, p_upload is the file log entry.
create or replace function public.daily_ingest(p_account_id bigint, p_kind text, p_expected_revision bigint,
  p_records jsonb, p_hashes jsonb, p_upload jsonb) returns jsonb
language plpgsql security definer set search_path = dashboard, pg_temp as $$
declare
  added integer := 0; updated integer := 0; mismatch date; new_revision bigint;
begin
  perform dashboard._require_member();
  if p_kind not in ('affiliate', 'ads', 'clicks') then raise exception 'Jenis laporan tidak dikenal' using errcode = 'PT400'; end if;
  if jsonb_typeof(p_records) <> 'array' or jsonb_typeof(p_hashes) <> 'array' or jsonb_typeof(p_upload) <> 'object' then
    raise exception 'Format kiriman tidak valid' using errcode = 'PT400';
  end if;
  perform dashboard._lock_account(p_account_id, p_expected_revision);

  if exists (select 1 from dashboard.uploads where account_id = p_account_id and kind = p_kind
             and file_hash = p_upload->>'file_hash') then
    return jsonb_build_object('added', 0, 'updated', 0, 'duplicates', coalesce((p_upload->>'rows')::int, 0),
      'skipped', true, 'revision', p_expected_revision);
  end if;

  -- Every aggregated source row carries exactly one fingerprint of its date,
  -- the invariant DailyStore.validateBackup checks on every pull.
  with hashed as (select (h->>'date')::date d, count(*) n from jsonb_array_elements(p_hashes) h group by 1),
  counted as (
    select (r->>'date')::date d,
      sum(case when p_kind = 'clicks' then (r->>'clicks')::bigint else (r->>'rows')::bigint end) n
    from jsonb_array_elements(p_records) r group by 1)
  select coalesce(c.d, h.d) into mismatch from counted c full join hashed h on c.d = h.d
  where c.n is distinct from h.n limit 1;
  if found then raise exception 'Fingerprint tidak sesuai jumlah baris tanggal %', mismatch using errcode = 'PT400'; end if;

  if p_kind = 'affiliate' then
    with up as (
      insert into dashboard.daily_affiliate as t (account_id, date, tag, comm, comm_done, comm_pending, gmv, qty,
        refund, orders, order_keys, excluded, rows)
      select p_account_id, r.date, r.tag, r.comm, r.comm_done, r.comm_pending, r.gmv, r.qty, r.refund,
        cardinality(dashboard._text_union(r.order_keys, '{}')), dashboard._text_union(r.order_keys, '{}'), r.excluded, r.rows
      from jsonb_to_recordset(p_records) r(date date, tag text, comm float8, comm_done float8, comm_pending float8,
        gmv float8, qty float8, refund float8, order_keys text[], excluded int, rows int)
      on conflict (account_id, date, tag) do update set
        comm = t.comm + excluded.comm, comm_done = t.comm_done + excluded.comm_done,
        comm_pending = t.comm_pending + excluded.comm_pending, gmv = t.gmv + excluded.gmv,
        qty = t.qty + excluded.qty, refund = t.refund + excluded.refund,
        order_keys = dashboard._text_union(t.order_keys, excluded.order_keys),
        orders = cardinality(dashboard._text_union(t.order_keys, excluded.order_keys)),
        excluded = t.excluded + excluded.excluded, rows = t.rows + excluded.rows, updated_at = now()
      returning (xmax = 0) inserted)
    select count(*) filter (where inserted), count(*) filter (where not inserted) into added, updated from up;
  elsif p_kind = 'ads' then
    with up as (
      insert into dashboard.daily_ads as t (account_id, date, ad_unit, spend, impressions, reach, clicks, shop_clicks,
        lpv, results, rows, cpm, cpc, ctr, delivery)
      select p_account_id, r.date, r.ad_unit, r.spend, r.impressions, r.reach, r.clicks, r.shop_clicks, r.lpv,
        r.results, r.rows,
        case when r.impressions > 0 then r.spend / r.impressions * 1000 else 0 end,
        case when r.clicks > 0 then r.spend / r.clicks else 0 end,
        case when r.impressions > 0 then r.clicks / r.impressions * 100 else 0 end,
        coalesce(r.delivery, '')
      from jsonb_to_recordset(p_records) r(date date, ad_unit text, spend float8, impressions float8, reach float8,
        clicks float8, shop_clicks float8, lpv float8, results float8, rows int, delivery text)
      on conflict (account_id, date, ad_unit) do update set
        spend = t.spend + excluded.spend, impressions = t.impressions + excluded.impressions,
        reach = t.reach + excluded.reach, clicks = t.clicks + excluded.clicks,
        shop_clicks = t.shop_clicks + excluded.shop_clicks, lpv = t.lpv + excluded.lpv,
        results = t.results + excluded.results, rows = t.rows + excluded.rows,
        cpm = case when t.impressions + excluded.impressions > 0
          then (t.spend + excluded.spend) / (t.impressions + excluded.impressions) * 1000 else 0 end,
        cpc = case when t.clicks + excluded.clicks > 0 then (t.spend + excluded.spend) / (t.clicks + excluded.clicks) else 0 end,
        ctr = case when t.impressions + excluded.impressions > 0
          then (t.clicks + excluded.clicks) / (t.impressions + excluded.impressions) * 100 else 0 end,
        delivery = coalesce(nullif(excluded.delivery, ''), t.delivery), updated_at = now()
      returning (xmax = 0) inserted)
    select count(*) filter (where inserted), count(*) filter (where not inserted) into added, updated from up;
  else
    with up as (
      insert into dashboard.daily_clicks as t (account_id, date, tag, clicks, by_region, by_source)
      select p_account_id, r.date, r.tag, r.clicks, coalesce(r.by_region, '{}'), coalesce(r.by_source, '{}')
      from jsonb_to_recordset(p_records) r(date date, tag text, clicks int, by_region jsonb, by_source jsonb)
      on conflict (account_id, date, tag) do update set
        clicks = t.clicks + excluded.clicks,
        by_region = dashboard._jsonb_count_sum(t.by_region, excluded.by_region),
        by_source = dashboard._jsonb_count_sum(t.by_source, excluded.by_source), updated_at = now()
      returning (xmax = 0) inserted)
    select count(*) filter (where inserted), count(*) filter (where not inserted) into added, updated from up;
  end if;

  -- A fingerprint that already exists means the browser deduplicated against
  -- something other than this revision; the unique key aborts the whole call.
  insert into dashboard.row_hashes (account_id, kind, hash, date)
  select p_account_id, p_kind, h->>'hash', (h->>'date')::date from jsonb_array_elements(p_hashes) h;

  insert into dashboard.uploads (account_id, kind, file_hash, file_name, rows, added, updated, duplicates,
    period_start, period_end, uploaded_by)
  values (p_account_id, p_kind, p_upload->>'file_hash', coalesce(p_upload->>'file_name', ''),
    coalesce((p_upload->>'rows')::int, 0), added, updated, coalesce((p_upload->>'duplicates')::int, 0),
    (p_upload->>'period_start')::date, (p_upload->>'period_end')::date, auth.uid());

  new_revision := dashboard._bump(p_account_id);
  return jsonb_build_object('added', added, 'updated', updated,
    'duplicates', coalesce((p_upload->>'duplicates')::int, 0), 'skipped', false, 'revision', new_revision);
end $$;

-- Same correction workflow as the browser: clear one report's day, its
-- fingerprints (dated that day or undated) and the uploads covering it.
create or replace function public.daily_delete_day(p_account_id bigint, p_kind text, p_date date) returns jsonb
language plpgsql security definer set search_path = dashboard, pg_temp as $$
declare removed integer;
begin
  perform dashboard._require_member();
  if p_kind not in ('affiliate', 'ads', 'clicks') then raise exception 'Jenis laporan tidak dikenal' using errcode = 'PT400'; end if;
  perform 1 from dashboard.accounts where id = p_account_id for update;
  if not found then raise exception 'Akun tidak ditemukan' using errcode = 'PT404'; end if;
  if p_kind = 'affiliate' then delete from dashboard.daily_affiliate where account_id = p_account_id and date = p_date;
  elsif p_kind = 'ads' then delete from dashboard.daily_ads where account_id = p_account_id and date = p_date;
  else delete from dashboard.daily_clicks where account_id = p_account_id and date = p_date; end if;
  get diagnostics removed = row_count;
  delete from dashboard.row_hashes where account_id = p_account_id and kind = p_kind and (date = p_date or date is null);
  delete from dashboard.uploads where account_id = p_account_id and kind = p_kind
    and (period_start is null or (period_start <= p_date and period_end >= p_date));
  return jsonb_build_object('deleted', removed, 'revision', dashboard._bump(p_account_id));
end $$;

-- Replace one account's whole history with a backup the browser validated
-- (first upload of local history, or "Pulihkan backup" while signed in).
create or replace function public.daily_replace_account(p_account_id bigint, p_expected_revision bigint, p_backup jsonb) returns jsonb
language plpgsql security definer set search_path = dashboard, pg_temp as $$
begin
  perform dashboard._require_member();
  if p_backup->>'format' is distinct from 'affiliate-daily-backup' or (p_backup->>'version')::int is distinct from 1 then
    raise exception 'Format cadangan tidak didukung' using errcode = 'PT400';
  end if;
  perform dashboard._lock_account(p_account_id, p_expected_revision);
  delete from dashboard.daily_affiliate where account_id = p_account_id;
  delete from dashboard.daily_ads where account_id = p_account_id;
  delete from dashboard.daily_clicks where account_id = p_account_id;
  delete from dashboard.row_hashes where account_id = p_account_id;
  delete from dashboard.uploads where account_id = p_account_id;

  insert into dashboard.daily_affiliate (account_id, date, tag, comm, comm_done, comm_pending, gmv, qty, refund,
    orders, order_keys, excluded, rows, created_at, updated_at)
  select p_account_id, r.date, r.tag, r.comm, r.comm_done, r.comm_pending, r.gmv, r.qty, r.refund,
    r.orders, coalesce(r.order_keys, '{}'), r.excluded, r.rows, coalesce(r.created_at, now()), r.updated_at
  from jsonb_to_recordset(coalesce(p_backup->'affiliate', '[]')) r(date date, tag text, comm float8, comm_done float8,
    comm_pending float8, gmv float8, qty float8, refund float8, orders int, order_keys text[], excluded int, rows int,
    created_at timestamptz, updated_at timestamptz);
  insert into dashboard.daily_ads (account_id, date, ad_unit, spend, impressions, reach, clicks, shop_clicks, lpv,
    results, rows, cpm, cpc, ctr, delivery, created_at, updated_at)
  select p_account_id, r.date, r.ad_unit, r.spend, r.impressions, r.reach, r.clicks, r.shop_clicks, r.lpv,
    r.results, r.rows, r.cpm, r.cpc, r.ctr, coalesce(r.delivery, ''), coalesce(r.created_at, now()), r.updated_at
  from jsonb_to_recordset(coalesce(p_backup->'ads', '[]')) r(date date, ad_unit text, spend float8, impressions float8,
    reach float8, clicks float8, shop_clicks float8, lpv float8, results float8, rows int, cpm float8, cpc float8,
    ctr float8, delivery text, created_at timestamptz, updated_at timestamptz);
  insert into dashboard.daily_clicks (account_id, date, tag, clicks, by_region, by_source, created_at, updated_at)
  select p_account_id, r.date, r.tag, r.clicks, coalesce(r.by_region, '{}'), coalesce(r.by_source, '{}'),
    coalesce(r.created_at, now()), r.updated_at
  from jsonb_to_recordset(coalesce(p_backup->'clicks', '[]')) r(date date, tag text, clicks int, by_region jsonb,
    by_source jsonb, created_at timestamptz, updated_at timestamptz);
  insert into dashboard.row_hashes (account_id, kind, hash, date)
  select p_account_id, r.kind, r.hash, r.date
  from jsonb_to_recordset(coalesce(p_backup->'rowhashes', '[]')) r(kind text, hash text, date date);
  insert into dashboard.uploads (account_id, kind, file_hash, file_name, rows, added, updated, duplicates,
    period_start, period_end, uploaded_at, uploaded_by)
  select p_account_id, r.kind, r.file_hash, coalesce(r.file_name, ''), coalesce(r.rows, 0), coalesce(r.added, 0),
    coalesce(r.updated, 0), coalesce(r.duplicates, 0), r.period_start, r.period_end, coalesce(r.uploaded_at, now()), auth.uid()
  from jsonb_to_recordset(coalesce(p_backup->'uploads', '[]')) r(kind text, file_hash text, file_name text, rows int,
    added int, updated int, duplicates int, period_start date, period_end date, uploaded_at timestamptz);

  return jsonb_build_object('revision', dashboard._bump(p_account_id));
end $$;

-- Only the entry points are callable over the API. Supabase grants execute
-- on new public functions to anon and authenticated by default.
revoke execute on all functions in schema dashboard from public, anon, authenticated;
revoke execute on function public.daily_list_accounts(), public.daily_export_account(bigint),
  public.daily_ensure_account(text), public.daily_ingest(bigint, text, bigint, jsonb, jsonb, jsonb),
  public.daily_delete_day(bigint, text, date), public.daily_replace_account(bigint, bigint, jsonb) from public, anon;
grant execute on function public.daily_list_accounts(), public.daily_export_account(bigint),
  public.daily_ensure_account(text), public.daily_ingest(bigint, text, bigint, jsonb, jsonb, jsonb),
  public.daily_delete_day(bigint, text, date), public.daily_replace_account(bigint, bigint, jsonb) to authenticated;
