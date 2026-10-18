-- Shared daily history for every dashboard account.
--
-- Mirrors the browser store (daily-store.js, database version 3): daily
-- aggregates per (account, date, tag | ad key), dated row fingerprints for
-- dedup, and the upload log. Raw CSV rows, buyer data, product names and
-- clear order IDs never reach this database; order identities are the same
-- 16-hex hashes the browser already keeps.
--
-- How a later upload meets saved history (DailyAgg, "merge_version"):
--   2  revisions replace: a commission record holds one part per order, and
--      an order in a new file replaces its saved part (Tertunda → Selesai
--      updates instead of adding); an ad row with a Meta Ad ID replaces the
--      saved (date, Ad ID) row.
--   1  unseen rows add: clicks and Meta exports without IDs are deduplicated
--      by whole-row fingerprints and only unseen rows are added.
--
-- Access model: the anon key is public. Tables live in the private schema
-- "dashboard", which the Data API does not expose, so neither anon nor
-- signed-in users can touch them directly (RLS is on as a second guard).
-- The only entry points are the public.daily_* SECURITY DEFINER functions:
-- they check dashboard.team_members, lock the account row, compare the
-- caller's expected revision, and merge exactly like DailyAgg.mergeDaily.
-- A stale browser cache is refused instead of guessed.
--
-- Everything stored here must pass DailyStore.validateBackup when a browser
-- pulls it, so the column checks below mirror that validator: finite numbers
-- within JavaScript's safe range, labels without control characters, order
-- parts whose sums are the record's totals, and one dated fingerprint per
-- aggregated source row of a merge_version 1 record.
--
-- Every written row carries the account revision that wrote it ("rev"), and
-- deleted days leave a marker, so browsers fetch only what changed since the
-- revision they hold (daily_changes) instead of the whole account.

create schema if not exists dashboard;
revoke all on schema dashboard from public, anon, authenticated;

-- ── Value checks (mirror DailyStore.validateBackup) ────────────────────────
-- A label as validateBackup's string(): at most max UTF-16 units, no control
-- characters other than tab/LF/CR, and not only whitespace unless allowed.
create or replace function dashboard._label_ok(t text, max_units int, allow_empty boolean default false) returns boolean
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select t is not null
    and char_length(t) + char_length(t) - char_length(regexp_replace(t, '[\U00010000-\U0010FFFF]', '', 'g')) <= max_units
    and t !~ '[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]'
    and (allow_empty or t ~ '[^\t\n\u000b\f\r    -     　﻿]')
$$;

-- abs() of NaN and ±Infinity is never <= the bound, so this also rejects them.
create or replace function dashboard._num_ok(x double precision) returns boolean
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select x is not null and abs(x) <= 9007199254740991
$$;

create or replace function dashboard._valid_order_keys(keys text[]) returns boolean
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select coalesce(bool_and(k ~ '^[a-f0-9]{16}$'), true)
     and cardinality(keys) = (select count(distinct k) from unnest(keys) k)
  from unnest(keys) k
$$;

-- Sum of a {label: count} map, or -1 when it is not a map of valid labels to
-- non-negative integers. A click row's maps must each sum to its clicks.
create or replace function dashboard._count_map_total(counts jsonb) returns bigint
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case
    when counts is null or jsonb_typeof(counts) <> 'object' then -1
    when exists (select 1 from jsonb_each(counts) e where not dashboard._label_ok(e.key, 2048)
      or jsonb_typeof(e.value) <> 'number' or (e.value #>> '{}')::numeric < 0
      or (e.value #>> '{}')::numeric <> trunc((e.value #>> '{}')::numeric)
      or (e.value #>> '{}')::numeric > 9007199254740991) then -1
    else coalesce((select sum((value #>> '{}')::numeric)::bigint from jsonb_each(counts)), 0) end
$$;

-- Order parts of a merge_version 2 commission record: {key: [comm, comm_done,
-- comm_pending, gmv, qty, refund, excluded, rows]}, key = 16-hex order hash
-- or "r:" + row fingerprint for a row without an order ID.
create or replace function dashboard._parts_ok(parts jsonb) returns boolean
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select case when parts is null or jsonb_typeof(parts) <> 'object' or parts = '{}'::jsonb then false
    when exists (select 1 from jsonb_each(parts) e where e.key !~ '^(r:)?[0-9a-f]{16}$'
      or jsonb_typeof(e.value) <> 'array' or jsonb_array_length(e.value) <> 8) then false
    else not exists (select 1 from jsonb_each(parts) e, jsonb_array_elements(e.value) with ordinality x(v, i)
      where jsonb_typeof(x.v) <> 'number'
        or (x.i <= 6 and not dashboard._num_ok((x.v #>> '{}')::float8))
        or (x.i > 6 and ((x.v #>> '{}')::numeric < 0 or (x.v #>> '{}')::numeric <> trunc((x.v #>> '{}')::numeric)
          or (x.v #>> '{}')::numeric > 9007199254740991)))
      and not exists (select 1 from jsonb_each(parts) e
        where (e.value ->> 7)::numeric < 1 or (e.value ->> 6)::numeric > (e.value ->> 7)::numeric) end
$$;

-- Totals of order parts exactly as DailyAgg.partsTotals sums them: one
-- addition at a time in key order, so both sides get the same doubles.
create or replace function dashboard._parts_totals(parts jsonb) returns double precision[]
language sql immutable set search_path = pg_catalog, pg_temp as $$
  select array[
    coalesce(sum((value ->> 0)::float8 order by key collate "C"), 0)::float8,
    coalesce(sum((value ->> 1)::float8 order by key collate "C"), 0)::float8,
    coalesce(sum((value ->> 2)::float8 order by key collate "C"), 0)::float8,
    coalesce(sum((value ->> 3)::float8 order by key collate "C"), 0)::float8,
    coalesce(sum((value ->> 4)::float8 order by key collate "C"), 0)::float8,
    coalesce(sum((value ->> 5)::float8 order by key collate "C"), 0)::float8,
    (count(*) filter (where key ~ '^[0-9a-f]{16}$' and (value ->> 7)::numeric > (value ->> 6)::numeric))::float8,
    coalesce(sum((value ->> 6)::numeric), 0)::float8,
    coalesce(sum((value ->> 7)::numeric), 0)::float8]
  from jsonb_each(parts)
$$;

create domain dashboard.day as date check (value between date '0001-01-01' and date '9999-12-31');
create domain dashboard.amount as double precision check (dashboard._num_ok(value));

create table dashboard.team_members (
  user_id uuid primary key references auth.users (id) on delete cascade,
  added_at timestamptz not null default now()
);

create table dashboard.accounts (
  id bigint generated always as identity primary key,
  kind text not null default 'shopee' check (kind = 'shopee'),
  name text not null check (dashboard._label_ok(name, 2048) and name = btrim(name)),
  -- Bumped by every write. Browsers cache one revision and must match it.
  revision bigint not null default 0,
  -- Revision of the last whole-account replacement; caches older than it reload fully.
  reset_revision bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (kind, name)
);

create table dashboard.daily_affiliate (
  account_id bigint not null references dashboard.accounts (id) on delete cascade,
  date dashboard.day not null,
  tag text not null check (dashboard._label_ok(tag, 2048)),
  comm dashboard.amount not null,
  comm_done dashboard.amount not null,
  comm_pending dashboard.amount not null,
  gmv dashboard.amount not null,
  qty dashboard.amount not null,
  refund dashboard.amount not null,
  orders integer not null check (orders >= 0),
  -- merge_version 1: order identities only (the day is fingerprinted).
  order_keys text[],
  -- merge_version 2: one part per order; totals are their sums.
  order_parts jsonb,
  merge_version smallint not null default 1 check (merge_version in (1, 2)),
  excluded integer not null check (excluded >= 0),
  rows integer not null check (rows >= 0),
  rev bigint not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  primary key (account_id, date, tag),
  check (coalesce(case when merge_version = 1
    then order_parts is null and order_keys is not null and orders = cardinality(order_keys) and dashboard._valid_order_keys(order_keys)
    else order_keys is null and dashboard._parts_ok(order_parts)
      and array[comm, comm_done, comm_pending, gmv, qty, refund, orders, excluded, rows]::float8[] = dashboard._parts_totals(order_parts) end, false)),
  check (excluded <= rows and orders <= rows - excluded)
);

create table dashboard.daily_ads (
  account_id bigint not null references dashboard.accounts (id) on delete cascade,
  date dashboard.day not null,
  -- Meta ad name (a label; several ads can share one).
  ad_unit text not null check (dashboard._label_ok(ad_unit, 2048)),
  -- Meta Ad ID of a merge_version 2 row; '' for exports without IDs.
  ad_id text not null default '',
  -- "id:<ad_id>" or "name:<ad_unit>": the row's identity within a day.
  ad_key text not null,
  merge_version smallint not null default 1 check (merge_version in (1, 2)),
  spend dashboard.amount not null,
  impressions dashboard.amount not null,
  reach dashboard.amount not null,
  clicks dashboard.amount not null,
  shop_clicks dashboard.amount not null,
  lpv dashboard.amount not null,
  results dashboard.amount not null,
  rows integer not null check (rows >= 0),
  cpm dashboard.amount not null,
  cpc dashboard.amount not null,
  ctr dashboard.amount not null,
  delivery text not null default '' check (dashboard._label_ok(delivery, 256, true)),
  rev bigint not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  primary key (account_id, date, ad_key),
  check (case when merge_version = 2 then ad_id ~ '^[0-9]{6,20}$' and ad_key = 'id:' || ad_id
    else ad_id = '' and ad_key = 'name:' || ad_unit end)
);

create table dashboard.daily_clicks (
  account_id bigint not null references dashboard.accounts (id) on delete cascade,
  date dashboard.day not null,
  tag text not null check (dashboard._label_ok(tag, 2048)),
  clicks integer not null check (clicks >= 0),
  by_region jsonb not null default '{}',
  by_source jsonb not null default '{}',
  rev bigint not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  primary key (account_id, date, tag),
  check (dashboard._count_map_total(by_region) = clicks and dashboard._count_map_total(by_source) = clicks)
);

-- One fingerprint per aggregated source row; keeps re-uploads from double counting.
create table dashboard.row_hashes (
  account_id bigint not null references dashboard.accounts (id) on delete cascade,
  kind text not null check (kind in ('affiliate', 'ads', 'clicks')),
  hash text not null check (dashboard._label_ok(hash, 256)),
  date dashboard.day not null,
  rev bigint not null,
  primary key (account_id, kind, hash)
);
create index row_hashes_day on dashboard.row_hashes (account_id, kind, date);
create index row_hashes_rev on dashboard.row_hashes (account_id, rev);

create table dashboard.uploads (
  id bigint generated always as identity primary key,
  account_id bigint not null references dashboard.accounts (id) on delete cascade,
  kind text not null check (kind in ('affiliate', 'ads', 'clicks')),
  file_hash text not null check (dashboard._label_ok(file_hash, 256)),
  file_name text not null default '' check (dashboard._label_ok(file_name, 1024, true)),
  rows integer not null default 0 check (rows >= 0),
  added integer not null default 0 check (added >= 0),
  updated integer not null default 0 check (updated >= 0),
  duplicates integer not null default 0 check (duplicates >= 0),
  period_start dashboard.day,
  period_end dashboard.day,
  uploaded_at timestamptz not null default now(),
  uploaded_by uuid references auth.users (id) on delete set null,
  rev bigint not null,
  unique (account_id, kind, file_hash),
  check ((period_start is null) = (period_end is null) and (period_start is null or period_start <= period_end))
);
create index uploads_account on dashboard.uploads (account_id, uploaded_at desc);

-- Days removed by daily_delete_day, so caches can remove them too.
create table dashboard.day_deletions (
  account_id bigint not null references dashboard.accounts (id) on delete cascade,
  kind text not null check (kind in ('affiliate', 'ads', 'clicks')),
  date dashboard.day not null,
  rev bigint not null,
  primary key (account_id, kind, date)
);

create index daily_affiliate_rev on dashboard.daily_affiliate (account_id, rev);
create index daily_ads_rev on dashboard.daily_ads (account_id, rev);
create index daily_clicks_rev on dashboard.daily_clicks (account_id, rev);

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
alter table dashboard.day_deletions enable row level security;

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
    select key, sum((value #>> '{}')::numeric)::bigint total
    from (select * from jsonb_each(a) union all select * from jsonb_each(b)) e group by key) s
$$;

create or replace function dashboard._require_member() returns void
language plpgsql stable security definer set search_path = dashboard, pg_temp as $$
begin
  if not dashboard.is_member() then
    raise exception 'Akun Anda belum terdaftar sebagai anggota tim' using errcode = 'PT403';
  end if;
end $$;

-- Lock the account, refuse a browser cache that is behind the database, and
-- return the revision this write will carry.
create or replace function dashboard._lock_account(p_account_id bigint, p_expected_revision bigint) returns bigint
language plpgsql security definer set search_path = dashboard, pg_temp as $$
declare current_revision bigint;
begin
  select revision into current_revision from dashboard.accounts where id = p_account_id for update;
  if not found then raise exception 'Akun tidak ditemukan' using errcode = 'PT404'; end if;
  if p_expected_revision is not null and p_expected_revision is distinct from current_revision then
    raise exception 'STALE_REVISION' using errcode = 'PT409',
      detail = format('expected %s, current %s', p_expected_revision, current_revision);
  end if;
  return current_revision + 1;
end $$;

create or replace function dashboard._commit(p_account_id bigint, p_revision bigint) returns bigint
language sql security definer set search_path = dashboard, pg_temp as $$
  update dashboard.accounts set revision = p_revision, updated_at = now() where id = p_account_id returning revision
$$;

-- The day-level invariants validateBackup checks: every fingerprint's date has
-- merge_version 1 aggregates of its kind, and each such day has one
-- fingerprint per source row. p_dates limits the check to those days.
create or replace function dashboard._assert_consistent(p_account_id bigint, p_dates date[] default null) returns void
language plpgsql stable security definer set search_path = dashboard, pg_temp as $$
declare bad record;
begin
  with sums as (
    select 'affiliate' kind, date, sum(rows)::bigint n from dashboard.daily_affiliate
      where account_id = p_account_id and merge_version = 1 and (p_dates is null or date = any(p_dates)) group by date
    union all select 'ads', date, sum(rows)::bigint from dashboard.daily_ads
      where account_id = p_account_id and merge_version = 1 and (p_dates is null or date = any(p_dates)) group by date
    union all select 'clicks', date, sum(clicks)::bigint from dashboard.daily_clicks
      where account_id = p_account_id and (p_dates is null or date = any(p_dates)) group by date),
  hashes as (select kind, date, count(*) n from dashboard.row_hashes
    where account_id = p_account_id and (p_dates is null or date = any(p_dates)) group by kind, date)
  select coalesce(s.kind, h.kind) kind, coalesce(s.date, h.date) date into bad
  from sums s full join hashes h on s.kind = h.kind and s.date = h.date
  where s.n is distinct from h.n limit 1;
  if found then
    raise exception 'Jumlah fingerprint % tanggal % tidak sesuai baris agregat', bad.kind, bad.date using errcode = 'PT400';
  end if;
end $$;

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

-- Rows of one account written after p_since (all rows when p_since is null),
-- in the browser backup shape. One statement, so one consistent snapshot:
-- "revision" always describes exactly the rows returned.
create or replace function dashboard._snapshot(p_account_id bigint, p_since bigint) returns jsonb
language sql stable security definer set search_path = dashboard, pg_temp as $$
  select jsonb_build_object(
    'format', 'affiliate-daily-backup', 'version', 1, 'database_version', 3,
    'exported_at', dashboard._iso(now()), 'revision', a.revision, 'reset_revision', a.reset_revision,
    'account', jsonb_build_object('id', a.id, 'kind', a.kind, 'name', a.name, 'created', dashboard._iso(a.created_at)),
    'affiliate', coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'account_id', x.account_id, 'date', x.date, 'tag', x.tag, 'comm', x.comm, 'comm_done', x.comm_done,
        'comm_pending', x.comm_pending, 'gmv', x.gmv, 'qty', x.qty, 'refund', x.refund, 'orders', x.orders,
        'order_keys', to_jsonb(x.order_keys), 'order_parts', x.order_parts, 'excluded', x.excluded, 'rows', x.rows,
        'merge_version', x.merge_version,
        'created_at', dashboard._iso(x.created_at), 'updated_at', dashboard._iso(x.updated_at))) order by x.date, x.tag)
      from dashboard.daily_affiliate x where x.account_id = a.id and (p_since is null or x.rev > p_since)), '[]'),
    'ads', coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'account_id', x.account_id, 'date', x.date, 'ad_unit', x.ad_unit, 'ad_id', x.ad_id, 'ad_key', x.ad_key, 'spend', x.spend,
        'impressions', x.impressions, 'reach', x.reach, 'clicks', x.clicks, 'shop_clicks', x.shop_clicks,
        'lpv', x.lpv, 'results', x.results, 'rows', x.rows, 'cpm', x.cpm, 'cpc', x.cpc, 'ctr', x.ctr,
        'delivery', x.delivery, 'merge_version', x.merge_version,
        'created_at', dashboard._iso(x.created_at), 'updated_at', dashboard._iso(x.updated_at))) order by x.date, x.ad_key)
      from dashboard.daily_ads x where x.account_id = a.id and (p_since is null or x.rev > p_since)), '[]'),
    'clicks', coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'account_id', x.account_id, 'date', x.date, 'tag', x.tag, 'clicks', x.clicks,
        'by_region', x.by_region, 'by_source', x.by_source, 'merge_version', 1,
        'created_at', dashboard._iso(x.created_at), 'updated_at', dashboard._iso(x.updated_at))) order by x.date, x.tag)
      from dashboard.daily_clicks x where x.account_id = a.id and (p_since is null or x.rev > p_since)), '[]'),
    'uploads', coalesce((select jsonb_agg(jsonb_build_object(
        'account_id', x.account_id, 'kind', x.kind, 'file_hash', x.file_hash, 'file_name', x.file_name,
        'rows', x.rows, 'added', x.added, 'updated', x.updated, 'duplicates', x.duplicates,
        'period_start', x.period_start, 'period_end', x.period_end, 'uploaded_at', dashboard._iso(x.uploaded_at)) order by x.id)
      from dashboard.uploads x where x.account_id = a.id and (p_since is null or x.rev > p_since)), '[]'),
    'rowhashes', coalesce((select jsonb_agg(jsonb_build_object(
        'account_id', x.account_id, 'kind', x.kind, 'hash', x.hash, 'date', x.date) order by x.kind, x.hash)
      from dashboard.row_hashes x where x.account_id = a.id and (p_since is null or x.rev > p_since)), '[]'),
    'deletions', case when p_since is null then '[]'::jsonb else coalesce((select jsonb_agg(jsonb_build_object(
        'kind', x.kind, 'date', x.date) order by x.kind, x.date)
      from dashboard.day_deletions x where x.account_id = a.id and x.rev > p_since), '[]') end,
    'totals', jsonb_build_object(
      'affiliate', (select count(*) from dashboard.daily_affiliate x where x.account_id = a.id),
      'ads', (select count(*) from dashboard.daily_ads x where x.account_id = a.id),
      'clicks', (select count(*) from dashboard.daily_clicks x where x.account_id = a.id),
      'uploads', (select count(*) from dashboard.uploads x where x.account_id = a.id),
      'rowhashes', (select count(*) from dashboard.row_hashes x where x.account_id = a.id)))
  from dashboard.accounts a where a.id = p_account_id
$$;

-- Whole account (first download, or after a replacement).
create or replace function public.daily_export_account(p_account_id bigint) returns jsonb
language plpgsql stable security definer set search_path = dashboard, pg_temp as $$
declare result jsonb;
begin
  perform dashboard._require_member();
  result := dashboard._snapshot(p_account_id, null);
  if result is null then raise exception 'Akun tidak ditemukan' using errcode = 'PT404'; end if;
  return result - 'deletions';
end $$;

-- What changed after p_since. "reset" means the cache predates a whole-account
-- replacement (or is ahead of the database) and must download everything.
create or replace function public.daily_changes(p_account_id bigint, p_since bigint) returns jsonb
language plpgsql stable security definer set search_path = dashboard, pg_temp as $$
declare result jsonb;
begin
  perform dashboard._require_member();
  if p_since is null then raise exception 'Revisi awal diperlukan' using errcode = 'PT400'; end if;
  result := dashboard._snapshot(p_account_id, p_since);
  if result is null then raise exception 'Akun tidak ditemukan' using errcode = 'PT404'; end if;
  if p_since < (result->>'reset_revision')::bigint or p_since > (result->>'revision')::bigint then
    return jsonb_build_object('reset', true, 'revision', result->'revision');
  end if;
  return result || jsonb_build_object('reset', false);
end $$;

-- ── Writes ─────────────────────────────────────────────────────────────────
create or replace function public.daily_ensure_account(p_name text) returns jsonb
language plpgsql security definer set search_path = dashboard, pg_temp as $$
declare a dashboard.accounts;
begin
  perform dashboard._require_member();
  if not dashboard._label_ok(btrim(p_name), 2048) then raise exception 'Nama akun tidak valid' using errcode = 'PT400'; end if;
  insert into dashboard.accounts (kind, name) values ('shopee', btrim(p_name))
    on conflict (kind, name) do nothing;
  select * into a from dashboard.accounts where kind = 'shopee' and name = btrim(p_name);
  return jsonb_build_object('id', a.id, 'name', a.name, 'revision', a.revision);
end $$;

-- Apply one saved file. The browser ran DailyAgg.prepare, checkDays and
-- changes against its cache at p_expected_revision: p_records are the
-- records that change something (affiliate records carry only changed order
-- parts), p_hashes are [{hash, date}] for exactly the rows of merge_version 1
-- records, p_upload is the file log entry. Merging follows DailyAgg.mergeDaily.
create or replace function public.daily_ingest(p_account_id bigint, p_kind text, p_expected_revision bigint,
  p_records jsonb, p_hashes jsonb, p_upload jsonb) returns jsonb
language plpgsql security definer set search_path = dashboard, pg_temp as $$
declare
  added integer := 0; updated integer := 0; mismatch date; new_revision bigint; bad record;
  touched date[]; converted date[];
begin
  perform dashboard._require_member();
  if p_kind not in ('affiliate', 'ads', 'clicks') then raise exception 'Jenis laporan tidak dikenal' using errcode = 'PT400'; end if;
  if p_expected_revision is null or jsonb_typeof(p_records) <> 'array' or jsonb_typeof(p_hashes) <> 'array'
     or jsonb_typeof(p_upload) <> 'object' then
    raise exception 'Format kiriman tidak valid' using errcode = 'PT400';
  end if;
  new_revision := dashboard._lock_account(p_account_id, p_expected_revision);

  if exists (select 1 from dashboard.uploads where account_id = p_account_id and kind = p_kind
             and file_hash = p_upload->>'file_hash') then
    return jsonb_build_object('added', 0, 'updated', 0, 'duplicates', coalesce((p_upload->>'rows')::int, 0),
      'skipped', true, 'revision', p_expected_revision);
  end if;
  touched := array(select distinct (r->>'date')::date from jsonb_array_elements(p_records) r);

  -- Every source row of a merge_version 1 record carries exactly one
  -- fingerprint of its date, the invariant DailyStore.validateBackup checks on
  -- every pull. Merging two consistent days keeps the day consistent.
  with hashed as (select (h->>'date')::date d, count(*) n from jsonb_array_elements(p_hashes) h group by 1),
  counted as (
    select (r->>'date')::date d,
      sum(case when p_kind = 'clicks' then (r->>'clicks')::bigint else (r->>'rows')::bigint end) n
    from jsonb_array_elements(p_records) r
    where p_kind = 'clicks' or (p_kind = 'ads' and coalesce(r->>'ad_id', '') = '') group by 1)
  select coalesce(c.d, h.d) into mismatch from counted c full join hashed h on c.d = h.d
  where c.n is distinct from h.n limit 1;
  if found then raise exception 'Fingerprint tidak sesuai jumlah baris tanggal %', mismatch using errcode = 'PT400'; end if;

  if p_kind = 'affiliate' then
    -- A fingerprint-format record converts to order parts only with all of
    -- its orders, and only together with every such record of its day.
    select t.date, t.tag into bad
    from jsonb_to_recordset(p_records) i(date date, tag text, order_parts jsonb)
    join dashboard.daily_affiliate t on t.account_id = p_account_id and t.date = i.date and t.tag = i.tag
    where t.merge_version = 1 and (jsonb_typeof(i.order_parts) is distinct from 'object'
      or not (t.order_keys <@ array(select jsonb_object_keys(i.order_parts))))
    limit 1;
    if found then
      raise exception 'Riwayat komisi % tersimpan dalam format lama dan file ini tidak memuat semua pesanannya (%). Riwayat lama tanggal itu perlu dihapus lalu diunggah ulang dengan laporan lengkapnya.',
        bad.date, bad.tag using errcode = 'PT400';
    end if;
    converted := array(select distinct t.date from jsonb_to_recordset(p_records) i(date date, tag text)
      join dashboard.daily_affiliate t on t.account_id = p_account_id and t.date = i.date and t.tag = i.tag
      where t.merge_version = 1);

    with merged as (
      select i.date, i.tag, case when t.merge_version = 2 then t.order_parts || i.order_parts else i.order_parts end parts
      from jsonb_to_recordset(p_records) i(date date, tag text, order_parts jsonb)
      left join dashboard.daily_affiliate t on t.account_id = p_account_id and t.date = i.date and t.tag = i.tag),
    up as (
      insert into dashboard.daily_affiliate as t (account_id, date, tag, comm, comm_done, comm_pending, gmv, qty,
        refund, orders, order_keys, order_parts, merge_version, excluded, rows, rev)
      select p_account_id, m.date, m.tag, x.s[1], x.s[2], x.s[3], x.s[4], x.s[5], x.s[6], x.s[7]::int, null, m.parts, 2,
        x.s[8]::int, x.s[9]::int, new_revision
      from merged m cross join lateral (select dashboard._parts_totals(m.parts) s) x
      on conflict (account_id, date, tag) do update set
        comm = excluded.comm, comm_done = excluded.comm_done, comm_pending = excluded.comm_pending,
        gmv = excluded.gmv, qty = excluded.qty, refund = excluded.refund, orders = excluded.orders,
        order_keys = null, order_parts = excluded.order_parts, merge_version = 2,
        excluded = excluded.excluded, rows = excluded.rows, rev = excluded.rev, updated_at = now()
      returning (xmax = 0) inserted)
    select count(*) filter (where inserted), count(*) filter (where not inserted) into added, updated from up;

    select c into mismatch from unnest(converted) c where exists (select 1 from dashboard.daily_affiliate
      where account_id = p_account_id and date = c and merge_version = 1) limit 1;
    if found then
      raise exception 'Riwayat komisi % tersimpan dalam format lama dan file ini tidak memuat semua tag tanggal itu. Riwayat lama tanggal itu perlu dihapus lalu diunggah ulang dengan laporan lengkapnya.',
        mismatch using errcode = 'PT400';
    end if;
    -- Converted days keep no fingerprints: order parts replace them.
    delete from dashboard.row_hashes where account_id = p_account_id and kind = 'affiliate' and date = any(converted);
  elsif p_kind = 'ads' then
    -- Rows with an Ad ID replace; rows without one add their unseen rows.
    with up as (
      insert into dashboard.daily_ads as t (account_id, date, ad_unit, ad_id, ad_key, merge_version, spend, impressions,
        reach, clicks, shop_clicks, lpv, results, rows, cpm, cpc, ctr, delivery, rev)
      select p_account_id, r.date, r.ad_unit, coalesce(r.ad_id, ''),
        case when coalesce(r.ad_id, '') <> '' then 'id:' || r.ad_id else 'name:' || r.ad_unit end,
        case when coalesce(r.ad_id, '') <> '' then 2 else 1 end,
        r.spend, r.impressions, r.reach, r.clicks, r.shop_clicks, r.lpv, r.results, r.rows,
        case when r.impressions > 0 then r.spend / r.impressions * 1000 else 0 end,
        case when r.clicks > 0 then r.spend / r.clicks else 0 end,
        case when r.impressions > 0 then r.clicks / r.impressions * 100 else 0 end,
        coalesce(r.delivery, ''), new_revision
      from jsonb_to_recordset(p_records) r(date date, ad_unit text, ad_id text, spend float8, impressions float8,
        reach float8, clicks float8, shop_clicks float8, lpv float8, results float8, rows int, delivery text)
      on conflict (account_id, date, ad_key) do update set
        ad_unit = excluded.ad_unit,
        spend = case when excluded.merge_version = 2 then excluded.spend else t.spend + excluded.spend end,
        impressions = case when excluded.merge_version = 2 then excluded.impressions else t.impressions + excluded.impressions end,
        reach = case when excluded.merge_version = 2 then excluded.reach else t.reach + excluded.reach end,
        clicks = case when excluded.merge_version = 2 then excluded.clicks else t.clicks + excluded.clicks end,
        shop_clicks = case when excluded.merge_version = 2 then excluded.shop_clicks else t.shop_clicks + excluded.shop_clicks end,
        lpv = case when excluded.merge_version = 2 then excluded.lpv else t.lpv + excluded.lpv end,
        results = case when excluded.merge_version = 2 then excluded.results else t.results + excluded.results end,
        rows = case when excluded.merge_version = 2 then excluded.rows else t.rows + excluded.rows end,
        cpm = case when excluded.merge_version = 2 then excluded.cpm when t.impressions + excluded.impressions > 0
          then (t.spend + excluded.spend) / (t.impressions + excluded.impressions) * 1000 else 0 end,
        cpc = case when excluded.merge_version = 2 then excluded.cpc when t.clicks + excluded.clicks > 0
          then (t.spend + excluded.spend) / (t.clicks + excluded.clicks) else 0 end,
        ctr = case when excluded.merge_version = 2 then excluded.ctr when t.impressions + excluded.impressions > 0
          then (t.clicks + excluded.clicks) / (t.impressions + excluded.impressions) * 100 else 0 end,
        delivery = coalesce(nullif(excluded.delivery, ''), t.delivery), rev = excluded.rev, updated_at = now()
      returning (xmax = 0) inserted)
    select count(*) filter (where inserted), count(*) filter (where not inserted) into added, updated from up;

    -- One ad saved by name and by Ad ID on the same day is the same spend twice.
    select a.date, a.ad_unit into bad from dashboard.daily_ads a
    join dashboard.daily_ads b on b.account_id = a.account_id and b.date = a.date and b.ad_unit = a.ad_unit and b.merge_version = 2
    where a.account_id = p_account_id and a.merge_version = 1 and a.date = any(touched) limit 1;
    if found then
      raise exception 'Iklan ini sudah tersimpan dari sumber lain pada tanggal yang sama, sekali tanpa Ad ID (ekspor CSV) dan sekali dengan Ad ID: % (%). Hapus tanggal itu di Data Tersimpan lalu simpan lagi agar biaya tidak terhitung dua kali.',
        bad.date, bad.ad_unit using errcode = 'PT400';
    end if;
  else
    with up as (
      insert into dashboard.daily_clicks as t (account_id, date, tag, clicks, by_region, by_source, rev)
      select p_account_id, r.date, r.tag, r.clicks, r.by_region, r.by_source, new_revision
      from jsonb_to_recordset(p_records) r(date date, tag text, clicks int, by_region jsonb, by_source jsonb)
      on conflict (account_id, date, tag) do update set
        clicks = t.clicks + excluded.clicks,
        by_region = dashboard._jsonb_count_sum(t.by_region, excluded.by_region),
        by_source = dashboard._jsonb_count_sum(t.by_source, excluded.by_source), rev = excluded.rev, updated_at = now()
      returning (xmax = 0) inserted)
    select count(*) filter (where inserted), count(*) filter (where not inserted) into added, updated from up;
  end if;

  -- A fingerprint that already exists means the browser deduplicated against
  -- something other than this revision; the unique key aborts the whole call.
  insert into dashboard.row_hashes (account_id, kind, hash, date, rev)
  select p_account_id, p_kind, h->>'hash', (h->>'date')::date, new_revision from jsonb_array_elements(p_hashes) h;

  insert into dashboard.uploads (account_id, kind, file_hash, file_name, rows, added, updated, duplicates,
    period_start, period_end, uploaded_by, rev)
  values (p_account_id, p_kind, p_upload->>'file_hash', coalesce(p_upload->>'file_name', ''),
    coalesce((p_upload->>'rows')::int, 0), added, updated, coalesce((p_upload->>'duplicates')::int, 0),
    (p_upload->>'period_start')::date, (p_upload->>'period_end')::date, auth.uid(), new_revision);

  perform dashboard._assert_consistent(p_account_id, touched);
  perform dashboard._commit(p_account_id, new_revision);
  return jsonb_build_object('added', added, 'updated', updated,
    'duplicates', coalesce((p_upload->>'duplicates')::int, 0), 'skipped', false, 'revision', new_revision);
end $$;

-- Same correction workflow as the browser: clear one report's day, its
-- fingerprints and the uploads covering it, and leave a marker for caches.
create or replace function public.daily_delete_day(p_account_id bigint, p_kind text, p_date date) returns jsonb
language plpgsql security definer set search_path = dashboard, pg_temp as $$
declare removed integer; new_revision bigint;
begin
  perform dashboard._require_member();
  if p_kind not in ('affiliate', 'ads', 'clicks') or p_date is null then
    raise exception 'Jenis laporan atau tanggal tidak valid' using errcode = 'PT400';
  end if;
  new_revision := dashboard._lock_account(p_account_id, null);
  if p_kind = 'affiliate' then delete from dashboard.daily_affiliate where account_id = p_account_id and date = p_date;
  elsif p_kind = 'ads' then delete from dashboard.daily_ads where account_id = p_account_id and date = p_date;
  else delete from dashboard.daily_clicks where account_id = p_account_id and date = p_date; end if;
  get diagnostics removed = row_count;
  delete from dashboard.row_hashes where account_id = p_account_id and kind = p_kind and date = p_date;
  delete from dashboard.uploads where account_id = p_account_id and kind = p_kind
    and (period_start is null or (period_start <= p_date and period_end >= p_date));
  insert into dashboard.day_deletions (account_id, kind, date, rev) values (p_account_id, p_kind, p_date, new_revision)
    on conflict (account_id, kind, date) do update set rev = excluded.rev;
  return jsonb_build_object('deleted', removed, 'revision', dashboard._commit(p_account_id, new_revision));
end $$;

-- Replace one account's whole history with a backup the browser validated
-- (first upload of local history, or "Pulihkan backup" while signed in).
-- p_expected_revision is the revision the user saw when choosing to replace.
create or replace function public.daily_replace_account(p_account_id bigint, p_expected_revision bigint, p_backup jsonb) returns jsonb
language plpgsql security definer set search_path = dashboard, pg_temp as $$
declare new_revision bigint;
begin
  perform dashboard._require_member();
  if p_backup->>'format' is distinct from 'affiliate-daily-backup' or (p_backup->>'version')::int is distinct from 1
     or p_expected_revision is null then
    raise exception 'Format cadangan tidak didukung' using errcode = 'PT400';
  end if;
  new_revision := dashboard._lock_account(p_account_id, p_expected_revision);
  delete from dashboard.daily_affiliate where account_id = p_account_id;
  delete from dashboard.daily_ads where account_id = p_account_id;
  delete from dashboard.daily_clicks where account_id = p_account_id;
  delete from dashboard.row_hashes where account_id = p_account_id;
  delete from dashboard.uploads where account_id = p_account_id;
  delete from dashboard.day_deletions where account_id = p_account_id;

  insert into dashboard.daily_affiliate (account_id, date, tag, comm, comm_done, comm_pending, gmv, qty, refund,
    orders, order_keys, order_parts, merge_version, excluded, rows, rev, created_at, updated_at)
  select p_account_id, r.date, r.tag, r.comm, r.comm_done, r.comm_pending, r.gmv, r.qty, r.refund, r.orders,
    case when coalesce(r.merge_version, 1) = 1 then coalesce(r.order_keys, '{}') else r.order_keys end, r.order_parts, coalesce(r.merge_version, 1),
    r.excluded, r.rows, new_revision, coalesce(r.created_at, now()), r.updated_at
  from jsonb_to_recordset(coalesce(p_backup->'affiliate', '[]')) r(date date, tag text, comm float8, comm_done float8,
    comm_pending float8, gmv float8, qty float8, refund float8, orders int, order_keys text[], order_parts jsonb,
    merge_version smallint, excluded int, rows int, created_at timestamptz, updated_at timestamptz);
  insert into dashboard.daily_ads (account_id, date, ad_unit, ad_id, ad_key, merge_version, spend, impressions, reach,
    clicks, shop_clicks, lpv, results, rows, cpm, cpc, ctr, delivery, rev, created_at, updated_at)
  select p_account_id, r.date, r.ad_unit, coalesce(r.ad_id, ''),
    case when coalesce(r.ad_id, '') <> '' then 'id:' || r.ad_id else 'name:' || r.ad_unit end, coalesce(r.merge_version, 1),
    r.spend, r.impressions, r.reach, r.clicks, r.shop_clicks, r.lpv,
    r.results, r.rows, r.cpm, r.cpc, r.ctr, coalesce(r.delivery, ''), new_revision, coalesce(r.created_at, now()), r.updated_at
  from jsonb_to_recordset(coalesce(p_backup->'ads', '[]')) r(date date, ad_unit text, ad_id text, merge_version smallint,
    spend float8, impressions float8, reach float8, clicks float8, shop_clicks float8, lpv float8, results float8, rows int,
    cpm float8, cpc float8, ctr float8, delivery text, created_at timestamptz, updated_at timestamptz);
  insert into dashboard.daily_clicks (account_id, date, tag, clicks, by_region, by_source, rev, created_at, updated_at)
  select p_account_id, r.date, r.tag, r.clicks, r.by_region, r.by_source, new_revision, coalesce(r.created_at, now()), r.updated_at
  from jsonb_to_recordset(coalesce(p_backup->'clicks', '[]')) r(date date, tag text, clicks int, by_region jsonb,
    by_source jsonb, created_at timestamptz, updated_at timestamptz);
  insert into dashboard.row_hashes (account_id, kind, hash, date, rev)
  select p_account_id, r.kind, r.hash, r.date, new_revision
  from jsonb_to_recordset(coalesce(p_backup->'rowhashes', '[]')) r(kind text, hash text, date date);
  insert into dashboard.uploads (account_id, kind, file_hash, file_name, rows, added, updated, duplicates,
    period_start, period_end, uploaded_at, uploaded_by, rev)
  select p_account_id, r.kind, r.file_hash, coalesce(r.file_name, ''), coalesce(r.rows, 0), coalesce(r.added, 0),
    coalesce(r.updated, 0), coalesce(r.duplicates, 0), r.period_start, r.period_end, coalesce(r.uploaded_at, now()),
    auth.uid(), new_revision
  from jsonb_to_recordset(coalesce(p_backup->'uploads', '[]')) r(kind text, file_hash text, file_name text, rows int,
    added int, updated int, duplicates int, period_start date, period_end date, uploaded_at timestamptz);

  -- Undated fingerprints and orphan or missing ones are what makes a pull fail.
  perform dashboard._assert_consistent(p_account_id);
  update dashboard.accounts set reset_revision = new_revision where id = p_account_id;
  return jsonb_build_object('revision', dashboard._commit(p_account_id, new_revision));
end $$;

-- Only the entry points are callable over the API. Supabase grants execute
-- on new public functions to anon and authenticated by default.
revoke execute on all functions in schema dashboard from public, anon, authenticated;
revoke execute on function public.daily_list_accounts(), public.daily_export_account(bigint),
  public.daily_changes(bigint, bigint), public.daily_ensure_account(text),
  public.daily_ingest(bigint, text, bigint, jsonb, jsonb, jsonb), public.daily_delete_day(bigint, text, date),
  public.daily_replace_account(bigint, bigint, jsonb) from public, anon;
grant execute on function public.daily_list_accounts(), public.daily_export_account(bigint),
  public.daily_changes(bigint, bigint), public.daily_ensure_account(text),
  public.daily_ingest(bigint, text, bigint, jsonb, jsonb, jsonb), public.daily_delete_day(bigint, text, date),
  public.daily_replace_account(bigint, bigint, jsonb) to authenticated;
