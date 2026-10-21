'use strict';

// Runs the Supabase migration on a real Postgres and drives it through
// CloudStore exactly as two browsers would: separate IndexedDB caches, one
// shared database. Auth and PostgREST are replaced by a small fetch shim that
// calls the same SQL functions as the "authenticated" role with RLS on.
//
//   DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres node supabase/tests/cloud-store.db.test.js
//
// Without a reachable Postgres the suite is skipped, unless REQUIRE_DB=1.
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');
const A = require('../../daily-agg');
const DailyStore = require('../../daily-store');
const CloudStore = require('../../cloud-store');
global.IDBKeyRange = IDBKeyRange;

const BASE = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/postgres';
const DB = 'cloud_store_test_' + process.pid;
const DB_URL = BASE.replace(/\/[^/?]*(\?|$)/, '/' + DB + '$1');
const ROOT = path.join(__dirname, '..');

function psql(url, sql) {
  try {
    return execFileSync('psql', [url, '-X', '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose'],
      { input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    const stderr = String(error.stderr || error.message);
    const match = stderr.match(/ERROR:\s+([A-Z0-9]{5}):\s+([^\n]*)/);
    const failure = new Error(match ? match[2] : stderr);
    failure.code = match ? match[1] : 'PSQL';
    throw failure;
  }
}
const literal = value => { const tag = '$j' + Math.random().toString(36).slice(2) + '$'; return tag + value + tag; };

const USERS = { 'admin@example.com': '00000000-0000-0000-0000-000000000001',
  'tim@example.com': '00000000-0000-0000-0000-000000000002', 'luar@example.com': '00000000-0000-0000-0000-000000000003' };
const SIGNUPS = { 'baru@example.com': '00000000-0000-0000-0000-000000000004', 'konfirmasi@example.com': '00000000-0000-0000-0000-000000000005' };
const TYPES = { p_account_id: 'bigint', p_kind: 'text', p_expected_revision: 'bigint', p_since: 'bigint', p_date: 'date', p_name: 'text',
  p_records: 'jsonb', p_hashes: 'jsonb', p_upload: 'jsonb', p_backup: 'jsonb' };

function asUser(uid, sql) {
  return psql(DB_URL, `begin; set local role authenticated; set local request.jwt.claim.sub = '${uid}';
    ${sql}; commit;`);
}
function callRpc(uid, name, args) {
  const json = literal(JSON.stringify(args || {}));
  const params = Object.keys(args || {}).map(key => {
    if (!TYPES[key]) throw new Error('unknown arg ' + key);
    return TYPES[key] === 'jsonb' ? `${key} => (${json}::jsonb)->'${key}'` : `${key} => ((${json}::jsonb)->>'${key}')::${TYPES[key]}`;
  }).join(', ');
  const sql = name === 'daily_list_accounts'
    ? `select coalesce(jsonb_agg(to_jsonb(r)), '[]') from public.daily_list_accounts() r`
    : `select to_jsonb(public.${name}(${params}))`;
  return JSON.parse(asUser(uid, sql));
}

// fetch() stand-in for Supabase Auth + PostgREST.
function fakeFetch(log) {
  return async (url, init) => {
    const { pathname, searchParams } = new URL(url);
    const body = init.body ? JSON.parse(init.body) : {};
    const reply = (status, data) => ({ ok: status < 300, status, text: async () => JSON.stringify(data) });
    log && log.push(pathname);
    if (pathname === '/auth/v1/token' && searchParams.get('grant_type') === 'password') {
      if (body.email === 'konfirmasi@example.com') return reply(400, { code: 400, error_code: 'email_not_confirmed', msg: 'Email not confirmed' });
      const id = USERS[body.email];
      if (!id || body.password !== 'rahasia') return reply(400, { error_description: 'Invalid login credentials' });
      return reply(200, { access_token: id, refresh_token: 'r-' + id, expires_in: 3600, user: { id, email: body.email } });
    }
    if (pathname === '/auth/v1/signup') {
      if (USERS[body.email]) return reply(422, { code: 422, error_code: 'user_already_exists', msg: 'User already registered' });
      if (String(body.password).length < 6) return reply(422, { code: 422, error_code: 'weak_password', msg: 'Password should be at least 6 characters.' });
      const id = SIGNUPS[body.email];
      if (!id) return reply(400, { msg: 'unexpected test email' });
      psql(DB_URL, `insert into auth.users values ('${id}', '${body.email}') on conflict do nothing`);
      // Email confirmation on: Supabase returns the user but no session.
      if (body.email.startsWith('konfirmasi')) return reply(200, { id, email: body.email, confirmation_sent_at: new Date().toISOString() });
      return reply(200, { access_token: id, refresh_token: 'r-' + id, expires_in: 3600, user: { id, email: body.email } });
    }
    if (pathname === '/auth/v1/logout') return reply(204, null);
    const match = pathname.match(/^\/rest\/v1\/rpc\/(\w+)$/);
    if (!match) return reply(404, { message: 'not found' });
    const uid = String(init.headers.Authorization || '').replace('Bearer ', '');
    try { return reply(200, callRpc(uid, match[1], body)); }
    catch (error) { return reply(error.code === 'PT409' ? 409 : 400, { code: error.code, message: error.message }); }
  };
}

class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { this.map.set(key, String(value)); }
  removeItem(key) { this.map.delete(key); }
}

// One "browser": its own IndexedDB, localStorage and session. log lists the
// endpoints it called.
async function browser(email) {
  global.indexedDB = new IDBFactory();
  const local = await DailyStore.open();
  const storage = new MemoryStorage(), changes = [], log = [];
  const client = new CloudStore.Client({ url: 'https://test.supabase.co', anonKey: 'anon', storage, fetch: fakeFetch(log) });
  if (email) await client.signIn(email, 'rahasia');
  const store = CloudStore.attach(local, { client, storage, onChange: change => changes.push(change) });
  return { local, store, client, changes, log };
}
const remoteRows = (name, kind) => Number(psql(DB_URL, `select count(*) from dashboard.daily_${kind} x
  join dashboard.accounts a on a.id = x.account_id where a.name = '${name}'`));
const NAME = 'Beautyisus';
async function account(b, name = NAME) {
  const acct = await b.store.ensureAccount('shopee', name);
  await b.store.sync(name);
  return acct;
}
const save = (b, acct, kind, rows, name) => b.store.saveDaily(acct.id, kind, [], {
  rawRows: rows, sourceRows: rows.length, fileHash: A.hashRows(rows), fileName: name || kind + '.csv' });

const affiliate = (id, date = '2026-09-01', extra = {}) => ({
  'ID Pemesanan': id, 'ID Produk': 'p-' + id, 'Status Pesanan': 'Selesai', 'Waktu Pemesanan': date + ' 10:00:00',
  'Tag_link1': 'Serum A', 'Total Komisi per Produk(Rp)': 1234.5, 'Nilai Pembelian(Rp)': 10000, 'Jumlah': 1, ...extra });
const AD_ID = '120212345678901234', AD_ID_2 = '120212345678905678';
const ad = (date = '2026-09-01', extra = {}) => ({ 'Ad name': 'Serum A', 'Reporting starts': date,
  'Amount spent (IDR)': 1000.25, 'Impressions': 5000, 'Reach': 4000, 'Link clicks': 37, 'Landing page views': 30, ...extra });
const click = (time, date = '2026-09-01', extra = {}) => ({ 'Waktu Klik': date + ' ' + time, 'Tag_link': 'Serum A',
  'Wilayah Klik': 'Jakarta', 'Perujuk': 'Facebook', ...extra });

// Strip what legitimately differs between stores (ids, timestamps, set order).
const canon = value => JSON.stringify(value, (key, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
const shape = rows => rows.map(row => {
  const { id, account_id, created_at, updated_at, merge_version, ...rest } = row;
  if (rest.order_keys) rest.order_keys = [...rest.order_keys].sort();
  return rest;
}).sort((a, b) => canon(a).localeCompare(canon(b)));
async function snapshot(store, acct) {
  const out = {};
  for (const kind of ['affiliate', 'ads', 'clicks']) out[kind] = shape(await store.range(acct.id, kind));
  return out;
}

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

test('first save creates the shared account and the cache mirrors it', async () => {
  const a = await browser('admin@example.com');
  const acct = await account(a);
  assert.equal(a.store.status(NAME).state, 'unlinked');
  const result = await save(a, acct, 'affiliate', [affiliate('o1'), affiliate('o2'), affiliate('o2', '2026-09-01', { 'ID Produk': 'p-x' })]);
  assert.deepEqual(result, { added: 1, updated: 0, duplicates: 0 });
  assert.equal(a.store.status(NAME).state, 'synced');
  const [row] = await a.local.range(acct.id, 'affiliate');
  assert.equal(row.orders, 2);
  assert.equal(row.rows, 3);
  assert.equal(row.comm, 1234.5 * 3);
});

test('a second browser pulls the same history and both keep merging', async () => {
  const a = await browser('admin@example.com'), b = await browser('tim@example.com');
  const acctA = await account(a), acctB = await account(b);
  assert.equal(b.store.status(NAME).state, 'synced');
  assert.deepEqual(await snapshot(b.local, acctB), await snapshot(a.local, acctA));
  // B adds ads, A (cache now one revision behind) adds overlapping affiliate rows.
  await save(b, acctB, 'ads', [ad(), ad('2026-09-02')]);
  const res = await save(a, acctA, 'affiliate', [affiliate('o2'), affiliate('o2', '2026-09-01', { 'ID Produk': 'p-x' }), affiliate('o3')], 'aff-2.csv');
  assert.deepEqual(res, { added: 0, updated: 1, duplicates: 2 }, 'order o2 is recognized across browsers');
  await b.store.sync(NAME);
  assert.deepEqual(await snapshot(b.local, acctB), await snapshot(a.local, acctA));
  const [row] = await b.local.range(acctB.id, 'affiliate');
  assert.equal(row.orders, 3);
  assert.equal((await b.local.range(acctB.id, 'ads')).length, 2);
});

test('shared totals equal a local-only store fed the same files', async () => {
  const a = await browser('admin@example.com');
  const acct = await account(a, 'Parity');
  global.indexedDB = new IDBFactory();
  const plain = await DailyStore.open(), plainAcct = await plain.ensureAccount('shopee', 'Parity');
  const files = [
    ['affiliate', [affiliate('x1'), affiliate('x2', '2026-09-02', { 'Status Pesanan': 'Tertunda' }), affiliate('x3', '2026-09-02', { 'Status Pesanan': 'Dibatalkan' })]],
    ['affiliate', [affiliate('x2', '2026-09-02', { 'Status Pesanan': 'Tertunda' }), affiliate('x4', '2026-09-02', { 'Total Komisi per Produk(Rp)': 0.1 })]],
    ['ads', [ad('2026-09-01', { 'Ad delivery': 'active' }), ad('2026-09-01', { 'Amount spent (IDR)': 0.2, 'Impressions': 3 })]],
    ['ads', [ad('2026-09-01', { 'Link clicks': 1, 'Ad delivery': '' })]],
    ['clicks', [click('10:00:00'), click('10:00:01', '2026-09-01', { 'Wilayah Klik': 'Bandung' })]],
    ['clicks', [click('10:00:01', '2026-09-01', { 'Wilayah Klik': 'Bandung' }), click('11:00:00', '2026-09-01', { 'Perujuk': '__proto__' })]],
    // A revised commission report: x2 completed with a corrected commission, x4 cancelled.
    ['affiliate', [affiliate('x1'), affiliate('x2', '2026-09-02', { 'Total Komisi per Produk(Rp)': 1000.3 }),
      affiliate('x3', '2026-09-02', { 'Status Pesanan': 'Dibatalkan' }), affiliate('x4', '2026-09-02', { 'Status Pesanan': 'Dibatalkan' })]],
    // Pulled ads with IDs (two ads share a name), then a re-pull with corrected spend.
    ['ads', [ad('2026-09-03', { 'Ad ID': AD_ID, 'Ad delivery': 'Aktif' }), ad('2026-09-03', { 'Ad ID': AD_ID_2, 'Amount spent (IDR)': 77.7 })]],
    ['ads', [ad('2026-09-03', { 'Ad ID': AD_ID, 'Amount spent (IDR)': 999.95 }), ad('2026-09-03', { 'Ad ID': AD_ID_2, 'Amount spent (IDR)': 77.7 }),
      ad('2026-09-04', { 'Ad ID': AD_ID, 'Impressions': 0, 'Link clicks': 0 })]],
  ];
  for (const [kind, rows] of files) {
    const shared = await save(a, acct, kind, rows);
    const local = await plain.saveDaily(plainAcct.id, kind, [], { rawRows: rows, sourceRows: rows.length, fileHash: A.hashRows(rows) });
    assert.deepEqual(shared, local);
  }
  assert.deepEqual(await snapshot(a.local, acct), await snapshot(plain, plainAcct));
  const clicks = await a.local.range(acct.id, 'clicks');
  assert.equal(clicks[0].by_source.__proto__, 1);
  const [revised] = await a.local.range(acct.id, 'affiliate', '2026-09-02', '2026-09-02');
  assert.equal(revised.comm, 1000.3, 'revised orders replace, cancelled orders drop out');
  assert.equal(revised.comm_pending, 0);
  assert.equal(revised.orders, 1);
  assert.equal(revised.excluded, 2);
  const pulled = await a.local.range(acct.id, 'ads', '2026-09-03', '2026-09-03');
  assert.deepEqual(pulled.map(r => r.spend).sort((x, y) => x - y), [77.7, 999.95]);
  assert.equal(pulled.find(r => r.ad_id === AD_ID).delivery, 'Aktif', 'a re-pull without status keeps the saved one');
  // Same totals as the database computes itself.
  const remote = await a.client.rpc('daily_export_account', { p_account_id: a.store.state.get('Parity').remoteId });
  const { revision, reset_revision, totals, ...backup } = remote;
  assert.deepEqual(shape(DailyStore.validateBackup(backup).data.affiliate), shape(await plain.range(plainAcct.id, 'affiliate')));
});

test('a revised commission report replaces orders for the whole team', async () => {
  const a = await browser('admin@example.com'), b = await browser('tim@example.com');
  const acctA = await account(a, 'Revisi');
  const pending = { 'Status Pesanan': 'Tertunda' };
  await save(a, acctA, 'affiliate', [affiliate('r1', '2026-09-15', pending), affiliate('r2', '2026-09-15', pending), affiliate('r3', '2026-09-16')]);
  const acctB = await account(b, 'Revisi');
  const res = await save(b, acctB, 'affiliate', [affiliate('r1', '2026-09-15'), affiliate('r2', '2026-09-15', { 'Status Pesanan': 'Dibatalkan' }),
    affiliate('r3', '2026-09-16')], 'revisi.csv');
  assert.deepEqual(res, { added: 0, updated: 1, duplicates: 1 });
  await a.store.sync('Revisi');
  const [day] = await a.local.range(acctA.id, 'affiliate', '2026-09-15', '2026-09-15');
  assert.equal(day.comm, 1234.5);
  assert.equal(day.comm_done, 1234.5);
  assert.equal(day.comm_pending, 0);
  assert.equal(day.orders, 1);
  assert.equal(day.excluded, 1);
  assert.equal(Number(psql(DB_URL, `select count(*) from dashboard.row_hashes h join dashboard.accounts a on a.id = h.account_id
    where a.name = 'Revisi'`)), 0, 'commission days keep no fingerprints');
});

test('direct and indirect orders are shared, and an old-format day upgrades on re-upload', async () => {
  const a = await browser('admin@example.com'), b = await browser('tim@example.com');
  const acctA = await account(a, 'Atribusi');
  const T = 'Tipe Pesanan', direct = 'Pesanan Produk dari Toko yang Dipromosikan', indirect = 'Pesanan dari Toko yang tidak Dipromosikan';
  // Saved before the column was read: 8-entry parts, which stay valid.
  await save(a, acctA, 'affiliate', [affiliate('d1', '2026-09-20'), affiliate('d2', '2026-09-20')], 'lama.csv');
  const res = await save(a, acctA, 'affiliate', [affiliate('d1', '2026-09-20', { [T]: direct }),
    affiliate('d2', '2026-09-20', { [T]: indirect }), affiliate('d2', '2026-09-20', { [T]: indirect, 'ID Produk': 'p-y' })], 'baru.csv');
  assert.deepEqual(res, { added: 0, updated: 1, duplicates: 0 });
  const acctB = await account(b, 'Atribusi');
  const [day] = await b.local.range(acctB.id, 'affiliate', '2026-09-20', '2026-09-20');
  const parts = Object.values(day.order_parts).map(A.partAttr).sort((x, y) => x.bits - y.bits);
  assert.deepEqual(parts, [{ direct: 1234.5, indirect: 0, unknown: 0, bits: 1 }, { direct: 0, indirect: 2469, unknown: 0, bits: 2 }]);
  assert.equal(day.comm, 1234.5 * 3, 'totals are unchanged by the split');
  // The database checks the extra entries itself.
  const acctId = psql(DB_URL, `select id from dashboard.accounts where name = 'Atribusi'`);
  assert.throws(() => psql(DB_URL, `update dashboard.daily_affiliate set order_parts =
    jsonb_set(order_parts, array[(select min(k) from jsonb_object_keys(order_parts) k)], '[1234.5,1234.5,0,10000,1,0,0,1,1234.5,0,8]')
    where account_id = ${acctId}`), /check constraint/);
  assert.throws(() => psql(DB_URL, `update dashboard.daily_affiliate set order_parts =
    jsonb_set(order_parts, array[(select min(k) from jsonb_object_keys(order_parts) k)], '[1234.5,1234.5,0,10000,1,0,0,1,1234.5]')
    where account_id = ${acctId}`), /check constraint/);
  // Sanity: the same statement with a valid part is accepted.
  psql(DB_URL, `update dashboard.daily_affiliate set order_parts =
    jsonb_set(order_parts, array[(select min(k) from jsonb_object_keys(order_parts) k)], order_parts->(select min(k) from jsonb_object_keys(order_parts) k))
    where account_id = ${acctId}`);
});

test('the database itself refuses the double counts and losses a browser check would catch', async () => {
  const a = await browser('admin@example.com'), b = await browser('tim@example.com');
  const acct = await account(a, 'Penjaga');
  await save(a, acct, 'ads', [ad('2026-09-20')]);
  const link = () => a.store.state.get('Penjaga');
  const ingest = (kind, records, fileHash) => a.client.rpc('daily_ingest', { p_account_id: link().remoteId, p_kind: kind,
    p_expected_revision: link().revision, p_records: records, p_hashes: [], p_upload: { file_hash: fileHash, rows: 1 } });
  // A pulled row for a day saved from a CSV, sent around the browser check;
  // also when the ad was renamed since.
  const [pulled] = A.aggregate('ads', [ad('2026-09-20', { 'Ad ID': AD_ID })]);
  await assert.rejects(ingest('ads', [pulled], 'pull-1'), /tanpa Ad ID[\s\S]*2026-09-20/);
  await assert.rejects(ingest('ads', [{ ...pulled, ad_unit: 'Serum A v2' }], 'pull-2'), /tanpa Ad ID[\s\S]*2026-09-20/);
  await assert.rejects(save(a, acct, 'ads', [ad('2026-09-20', { 'Ad ID': AD_ID, 'Ad name': 'Serum A v2' })], 'pull.csv'), /tanpa Ad ID/);
  // An order part never shrinks.
  await save(a, acct, 'affiliate', [affiliate('m1', '2026-09-22'), affiliate('m1', '2026-09-22', { 'ID Produk': 'p-2' })]);
  const [half] = A.aggregate('affiliate', [affiliate('m1', '2026-09-22', { 'Status Pesanan': 'Tertunda' })]);
  await assert.rejects(ingest('affiliate', [half], 'half'), /sebagian baris produk[\s\S]*2026-09-22/);
  await assert.rejects(save(a, acct, 'affiliate', [affiliate('m1', '2026-09-22', { 'Status Pesanan': 'Tertunda' })]), /sebagian baris produk/);
  // A fingerprint-format commission day converts only with all of its orders.
  const backup = await a.local.exportAccount(acct.id);
  backup.affiliate = [{ account_id: acct.id, date: '2026-09-21', tag: 'Serum A', comm: 2469, comm_done: 2469, comm_pending: 0,
    gmv: 20000, qty: 2, refund: 0, orders: 2, order_keys: ['k1', 'k2'].map(orderId => A.hashRow({ orderId })).sort(),
    excluded: 0, rows: 2, merge_version: 1 }];
  backup.rowhashes.push(...['1', '2'].map(n => ({ account_id: acct.id, kind: 'affiliate', hash: n.repeat(16), date: '2026-09-21' })));
  await a.store.importAccount(acct.id, backup, { replace: true });
  const [partial] = A.aggregate('affiliate', [affiliate('k1', '2026-09-21')]);
  await assert.rejects(ingest('affiliate', [partial], 'partial'), /format lama/);
  await assert.rejects(save(a, acct, 'affiliate', [affiliate('k1', '2026-09-21')]), /format lama/);
  const acctB = await account(b, 'Penjaga');
  await save(a, acct, 'affiliate', [affiliate('k1', '2026-09-21'), affiliate('k2', '2026-09-21')]);
  const [day] = await a.local.range(acct.id, 'affiliate', '2026-09-21', '2026-09-21');
  assert.equal(day.merge_version, 2);
  assert.equal(day.comm, 2469);
  assert.equal(Number(psql(DB_URL, `select count(*) from dashboard.row_hashes h join dashboard.accounts a on a.id = h.account_id
    where a.name = 'Penjaga' and h.kind = 'affiliate'`)), 0);
  // Teammates follow the conversion incrementally, fingerprints included.
  b.log.length = 0;
  await b.store.sync('Penjaga');
  assert.ok(b.log.includes('/rest/v1/rpc/daily_changes'));
  assert.ok(!b.log.includes('/rest/v1/rpc/daily_export_account'), 'no full download after a conversion');
  assert.deepEqual(await snapshot(b.local, acctB), await snapshot(a.local, acct));
  assert.equal((await b.local.exportAccount(acctB.id)).rowhashes.filter(h => h.kind === 'affiliate').length, 0);
});

test('the same file is skipped and a stale revision is refused', async () => {
  const a = await browser('admin@example.com');
  const acct = await account(a);
  const rows = [affiliate('o1'), affiliate('o2'), affiliate('o2', '2026-09-01', { 'ID Produk': 'p-x' })];
  const res = await save(a, acct, 'affiliate', rows);
  assert.equal(res.skipped, true);
  const link = a.store.state.get(NAME);
  await assert.rejects(a.client.rpc('daily_ingest', { p_account_id: link.remoteId, p_kind: 'ads',
    p_expected_revision: link.revision - 1, p_records: [], p_hashes: [], p_upload: { file_hash: 'zz' } }), { code: 'PT409' });
  await assert.rejects(a.client.rpc('daily_ingest', { p_account_id: link.remoteId, p_kind: 'ads',
    p_expected_revision: link.revision, p_records: A.aggregate('ads', [ad('2026-09-03')]), p_hashes: [],
    p_upload: { file_hash: 'zz' } }), /Fingerprint tidak sesuai/);
});

test('a stale cache retries once after someone else saved', async () => {
  const a = await browser('admin@example.com'), b = await browser('tim@example.com');
  const acctA = await account(a), acctB = await account(b);
  await save(a, acctA, 'clicks', [click('09:00:00', '2026-09-05')]);
  // B's cache is behind; make its pre-save check believe it is current.
  const sync = b.store.sync.bind(b.store);
  b.store.sync = async () => b.store.status(NAME);
  const res = await save(b, acctB, 'clicks', [click('09:00:00', '2026-09-05'), click('09:30:00', '2026-09-05')]);
  b.store.sync = sync;
  assert.deepEqual(res, { added: 0, updated: 1, duplicates: 1 });
  const [row] = await b.local.range(acctB.id, 'clicks', '2026-09-05', '2026-09-05');
  assert.equal(row.clicks, 2);
});

test('local history saved while signed out is a conflict, never overwritten', async () => {
  const c = await browser(null);
  const acct = await account(c);
  assert.equal(c.store.status(NAME).state, 'local');
  await save(c, acct, 'ads', [ad('2026-09-09')]);
  await c.client.signIn('tim@example.com', 'rahasia');
  await c.store.sync(NAME);
  assert.equal(c.store.status(NAME).state, 'conflict');
  await assert.rejects(save(c, acct, 'ads', [ad('2026-09-10')]), /berbeda dengan database bersama/);
  assert.equal((await c.local.range(acct.id, 'ads', '2026-09-09', '2026-09-09')).length, 1, 'local data untouched');
  await c.store.usePulled(NAME);
  assert.equal(c.store.status(NAME).state, 'synced');
  assert.equal((await c.local.range(acct.id, 'ads', '2026-09-09', '2026-09-09')).length, 0);
});

test('local history uploads into an empty shared account', async () => {
  const c = await browser(null);
  const acct = await account(c, 'Rizqie');
  await save(c, acct, 'affiliate', [affiliate('r1'), affiliate('r2', '2026-09-03')]);
  await c.client.signIn('admin@example.com', 'rahasia');
  await c.store.sync('Rizqie');
  assert.equal(c.store.status('Rizqie').state, 'unlinked');
  await c.store.push('Rizqie', 0);
  const b = await browser('tim@example.com');
  const acctB = await account(b, 'Rizqie');
  assert.deepEqual(await snapshot(b.local, acctB), await snapshot(c.local, acct));
  assert.equal((await b.local.uploadHistory(acctB.id)).length, 1);
});

test('deleting a day is shared and re-upload restores it', async () => {
  const a = await browser('admin@example.com'), b = await browser('tim@example.com');
  const acctA = await account(a), acctB = await account(b);
  const removed = await a.store.deleteDay(acctA.id, 'ads', '2026-09-02');
  assert.equal(removed, 1);
  await b.store.sync(NAME);
  assert.equal((await b.local.range(acctB.id, 'ads', '2026-09-02', '2026-09-02')).length, 0);
  const res = await save(b, acctB, 'ads', [ad(), ad('2026-09-02')]);
  assert.equal(res.added, 1);
  assert.equal(res.duplicates, 1);
});

test('restoring a backup while signed in replaces the shared account', async () => {
  const a = await browser('admin@example.com'), b = await browser('tim@example.com');
  const acctA = await account(a), acctB = await account(b);
  const backup = await a.local.exportAccount(acctA.id);
  backup.ads = backup.ads.filter(row => row.date !== '2026-09-02');
  backup.rowhashes = backup.rowhashes.filter(row => !(row.kind === 'ads' && row.date === '2026-09-02'));
  backup.uploads = backup.uploads.filter(row => row.kind !== 'ads');
  await b.store.importAccount(acctB.id, backup, { replace: true });
  await a.store.sync(NAME);
  assert.deepEqual(await snapshot(a.local, acctA), await snapshot(b.local, acctB));
  assert.equal((await a.local.range(acctA.id, 'ads', '2026-09-02', '2026-09-02')).length, 0);
});

test('later syncs download only what changed', async () => {
  const a = await browser('admin@example.com'), b = await browser('tim@example.com');
  const acctA = await account(a), acctB = await account(b);
  await save(b, acctB, 'clicks', [click('08:00:00', '2026-09-07')]);
  await b.store.deleteDay(acctB.id, 'ads', '2026-09-01');
  a.log.length = 0;
  await a.store.sync(NAME);
  assert.ok(a.log.includes('/rest/v1/rpc/daily_changes'));
  assert.ok(!a.log.includes('/rest/v1/rpc/daily_export_account'), 'no full download');
  assert.deepEqual(await snapshot(a.local, acctA), await snapshot(b.local, acctB));
  assert.deepEqual(await a.local.counts(acctA.id), await b.local.counts(acctB.id));
  // A cache whose counts disagree with the database reloads everything.
  await a.local.transaction(['clicks'], 'readwrite', async tx => { tx.objectStore('clicks').clear(); });
  await b.store.deleteDay(acctB.id, 'ads', '2026-09-02');
  a.log.length = 0;
  await a.store.sync(NAME);
  assert.ok(a.log.includes('/rest/v1/rpc/daily_export_account'));
  assert.deepEqual(await snapshot(a.local, acctA), await snapshot(b.local, acctB));
});

test('an emptied shared account is never refilled from an old copy', async () => {
  const a = await browser('admin@example.com'), b = await browser('tim@example.com');
  const acctA = await account(a, 'Kosong');
  await save(a, acctA, 'ads', [ad('2026-09-11')]);
  const acctB = await account(b, 'Kosong');
  assert.equal((await b.local.range(acctB.id, 'ads')).length, 1);
  await a.store.deleteDay(acctA.id, 'ads', '2026-09-11');
  await b.store.sync('Kosong');
  assert.equal(b.store.status('Kosong').state, 'synced');
  assert.equal((await b.local.range(acctB.id, 'ads')).length, 0, 'a mirrored cache follows the deletion');
  // A copy saved while signed out is not a revision of the shared account.
  const c = await browser(null);
  const acctC = await account(c, 'Kosong');
  await save(c, acctC, 'ads', [ad('2026-09-11')]);
  await c.client.signIn('tim@example.com', 'rahasia');
  await c.store.sync('Kosong');
  const seen = c.store.status('Kosong');
  assert.equal(seen.state, 'conflict');
  await assert.rejects(save(c, acctC, 'ads', [ad('2026-09-12')]), /berbeda dengan database bersama/);
  assert.equal(remoteRows('Kosong', 'ads'), 0);
  // Replacing checks the revision the user decided on.
  await save(a, acctA, 'ads', [ad('2026-09-13')]);
  await assert.rejects(c.store.push('Kosong', seen.remote.revision), /berubah sejak diperiksa/);
  assert.equal(remoteRows('Kosong', 'ads'), 1, "the teammate's newer save is kept");
  assert.equal(c.store.status('Kosong').state, 'conflict');
  await c.store.push('Kosong', c.store.status('Kosong').remote.revision);
  await a.store.sync('Kosong');
  assert.deepEqual(await snapshot(a.local, acctA), await snapshot(c.local, acctC));
});

test('history from before mergeable aggregates is refused, not shared', async () => {
  const c = await browser(null);
  const acct = await account(c, 'Lama');
  await c.local.transaction(['ads'], 'readwrite', async tx => {
    tx.objectStore('ads').add({ account_id: acct.id, date: '2026-08-01', ad_unit: 'Lama', spend: 1, impressions: 1, reach: 1,
      clicks: 0, shop_clicks: 0, lpv: 0, results: 0, rows: 1, cpm: 0, cpc: 0, ctr: 0, delivery: '' });
  });
  await c.client.signIn('admin@example.com', 'rahasia');
  await c.store.sync('Lama');
  assert.equal(c.store.status('Lama').state, 'unlinked');
  await assert.rejects(c.store.push('Lama', 0), /format penggabungan baru: 2026-08-01/);
  await assert.rejects(save(c, acct, 'ads', [ad('2026-09-01')]), /format penggabungan baru/);
  assert.ok(!(await c.client.rpc('daily_list_accounts')).some(row => row.name === 'Lama'));
  await c.store.deleteDay(acct.id, 'ads', '2026-08-01');
  await save(c, acct, 'ads', [ad('2026-09-01')]);
  assert.equal(c.store.status('Lama').state, 'synced');
});

test('the database refuses history a browser could not load back', async () => {
  const a = await browser('admin@example.com');
  const acct = await account(a);
  const { data } = DailyStore.validateBackup(await a.local.exportAccount(acct.id));
  const link = () => a.store.state.get(NAME);
  const emoji = '\u{1F600}'.repeat(1025);
  const broken = {
    'whitespace tag': d => { d.affiliate[0].tag = ' \t '; },
    'Unicode whitespace tag': d => { d.affiliate[0].tag = '\u3000\u00a0\ufeff'; },
    'control character': d => { d.affiliate[0].tag = 'a\u0007'; },
    'label longer than 2048 UTF-16 units': d => { d.affiliate[0].tag = emoji; },
    'unsafe number': d => { d.affiliate[0].gmv = 2 ** 60; },
    'order identity': d => { d.affiliate[0].order_keys = ['nothex'.padEnd(16, 'x')]; d.affiliate[0].orders = 1; },
    'order count': d => { d.affiliate[0].orders += 1; },
    'clicks map': d => { d.clicks[0].by_region = [d.clicks[0].clicks]; },
    'fractional clicks map': d => { const [key] = Object.keys(d.clicks[0].by_source); d.clicks[0].by_source[key] += 0.5; },
    'undated fingerprint': d => { d.rowhashes[0].date = null; },
    'missing fingerprint': d => { d.rowhashes.pop(); },
    'file name control character': d => { d.uploads[0].file_name = 'x\u0001.csv'; },
    'infinite upload time': d => { d.uploads[0].uploaded_at = 'infinity'; },
    'five-digit year': d => { d.affiliate[0].created_at = '12026-01-01T00:00:00Z'; },
    'order parts that do not add up': d => { d.affiliate[0].comm += 1; },
    'order part without rows': d => { Object.values(d.affiliate[0].order_parts)[0][7] = 0; },
    'order part key': d => { const [key] = Object.keys(d.affiliate[0].order_parts); d.affiliate[0].order_parts['clear-' + key.slice(6)] = d.affiliate[0].order_parts[key]; delete d.affiliate[0].order_parts[key]; },
    'order identities on an order-part record': d => { d.affiliate[0].order_keys = Object.keys(d.affiliate[0].order_parts); },
    'order parts on a fingerprint record': d => { d.affiliate[0].merge_version = 1; d.affiliate[0].order_keys = []; d.affiliate[0].orders = 0; },
    'Ad ID on a row without merge version 2': d => {
      d.ads.push({ account_id: d.account.id, date: '2026-09-30', ad_unit: 'Y', ad_id: '123456789', spend: 1, impressions: 1, reach: 1, clicks: 0,
        shop_clicks: 0, lpv: 0, results: 0, rows: 1, cpm: 0, cpc: 0, ctr: 0, delivery: '', merge_version: 1 });
      d.rowhashes.push({ account_id: d.account.id, kind: 'ads', hash: 'h-ad-id', date: '2026-09-30' });
    },
    'malformed Ad ID': d => {
      d.ads.push({ account_id: d.account.id, date: '2026-09-30', ad_unit: 'Y', ad_id: '12ab', spend: 1, impressions: 1, reach: 1, clicks: 0,
        shop_clicks: 0, lpv: 0, results: 0, rows: 1, cpm: 0, cpc: 0, ctr: 0, delivery: '', merge_version: 2 });
    },
    'ad delivery control character': d => {
      d.ads.push({ account_id: d.account.id, date: '2026-09-30', ad_unit: 'X', spend: 1, impressions: 1, reach: 1, clicks: 0,
        shop_clicks: 0, lpv: 0, results: 0, rows: 1, cpm: 0, cpc: 0, ctr: 0, delivery: 'a\u0002', merge_version: 1 });
      d.rowhashes.push({ account_id: d.account.id, kind: 'ads', hash: 'h-ad-ctrl', date: '2026-09-30' });
    },
  };
  assert.ok(data.affiliate.length && data.clicks.length && data.uploads.length);
  for (const [label, mutate] of Object.entries(broken)) {
    const bad = JSON.parse(JSON.stringify(data));
    mutate(bad);
    assert.throws(() => DailyStore.validateBackup(bad), Error, 'browser rejects: ' + label);
    await assert.rejects(a.client.rpc('daily_replace_account', { p_account_id: link().remoteId,
      p_expected_revision: link().revision, p_backup: bad }), Error, 'database rejects: ' + label);
  }
  await assert.rejects(a.client.rpc('daily_ingest', { p_account_id: link().remoteId, p_kind: 'clicks',
    p_expected_revision: link().revision, p_records: [{ date: '2026-09-29', tag: 'x\u0003', clicks: 1, by_region: { a: 1 }, by_source: { b: 1 } }],
    p_hashes: [{ hash: 'h-ctrl', date: '2026-09-29' }], p_upload: { file_hash: 'f-ctrl', rows: 1 } }));
  const snapshot = await a.client.rpc('daily_export_account', { p_account_id: link().remoteId });
  assert.equal(snapshot.revision, link().revision, 'nothing was written');
  const { revision, reset_revision, totals, ...backup } = snapshot;
  DailyStore.validateBackup(backup);
});

test('a save that committed is reported even when the refresh after it fails', async () => {
  const a = await browser('admin@example.com');
  const acct = await account(a, 'Tarik');
  await save(a, acct, 'clicks', [click('07:00:00', '2026-09-08')]);
  const real = a.client.fetch;
  let failures = 0;
  a.client.fetch = async (url, init) => {
    if (/daily_changes|daily_export_account/.test(url)) { failures++; return { ok: false, status: 503, text: async () => '{"message":"Service Unavailable"}' }; }
    return real(url, init);
  };
  const result = await save(a, acct, 'clicks', [click('07:30:00', '2026-09-08')], 'clicks-2.csv');
  assert.deepEqual(result, { added: 0, updated: 1, duplicates: 0 });
  assert.ok(failures > 0);
  assert.equal(a.store.status('Tarik').state, 'error');
  assert.match(a.store.status('Tarik').message, /Tersimpan di database bersama/);
  await assert.rejects(save(a, acct, 'clicks', [click('08:30:00', '2026-09-08')], 'clicks-3.csv'), /Belum ada yang disimpan/);
  a.client.fetch = real;
  await a.store.sync('Tarik');
  assert.equal(a.store.status('Tarik').state, 'synced');
  const [row] = await a.local.range(acct.id, 'clicks', '2026-09-08', '2026-09-08');
  assert.equal(row.clicks, 2);
});

test('sessions survive a busy login service and follow other tabs', async () => {
  const storage = new MemoryStorage(), calls = [];
  let answer = { status: 503, body: { message: 'upstream' } };
  const client = new CloudStore.Client({ url: 'https://test.supabase.co', anonKey: 'anon', storage,
    fetch: async (url, init) => {
      calls.push(new URL(url).pathname + ' ' + (init.headers.Authorization || ''));
      await new Promise(resolve => setTimeout(resolve, 5));
      const { status, body } = typeof answer === 'function' ? answer(url, init) : answer;
      return { ok: status < 300, status, text: async () => JSON.stringify(body) };
    } });
  const now = Math.floor(Date.now() / 1000), user = { id: 'u1', email: 'tim@example.com' };
  const put = session => storage.setItem(CloudStore.SESSION_KEY, JSON.stringify(session));
  put({ access_token: 'old', refresh_token: 'r1', expires_at: now - 10, user });
  // Two requests share one refresh; a 503 keeps the session.
  const results = await Promise.allSettled([client.token(), client.token()]);
  assert.deepEqual(results.map(r => r.status), ['rejected', 'rejected']);
  assert.equal(results[0].reason.code, 'network');
  assert.equal(calls.filter(c => c.startsWith('/auth/v1/token')).length, 1);
  assert.ok(client.signedIn, 'session kept after 503');
  // Another tab rotated the tokens: use them, no refresh.
  put({ access_token: 'fresh', refresh_token: 'r2', expires_at: now + 3600, user });
  calls.length = 0;
  assert.equal(await client.token(), 'fresh');
  assert.deepEqual(calls, []);
  // A rejected token refreshes once; a revoked refresh token signs out.
  answer = url => url.includes('/auth/') ? { status: 400, body: { error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token' } }
    : { status: 401, body: { message: 'JWT expired' } };
  await assert.rejects(client.rpc('daily_list_accounts'), /Sesi berakhir/);
  assert.ok(!client.signedIn);
  assert.equal(storage.getItem(CloudStore.SESSION_KEY), null);
});

test('RLS: non-members, anon and direct writes are refused', async () => {
  const outsider = await browser('luar@example.com');
  await outsider.store.ensureAccount('shopee', NAME);
  assert.equal((await outsider.store.sync(NAME)).state, 'pending');
  await assert.rejects(outsider.client.rpc('daily_export_account', { p_account_id: 1 }), { code: 'PT403' });
  // Tables sit in the unexposed "dashboard" schema: even members read them only through functions.
  for (const sql of ['select count(*) from dashboard.daily_affiliate', `insert into dashboard.accounts (name) values ('x')`,
    'update dashboard.daily_ads set spend = 0', 'select dashboard._lock_account(1, null)', 'select dashboard.is_member()',
    'select dashboard._snapshot(1, null)'])
    assert.throws(() => asUser(USERS['tim@example.com'], sql), { code: '42501' }, sql);
  assert.throws(() => psql(DB_URL, `begin; set local role anon; select count(*) from dashboard.daily_ads; commit;`), { code: '42501' });
  assert.throws(() => psql(DB_URL, `begin; set local role anon; select public.daily_list_accounts(); commit;`), { code: '42501' });
});

test('self sign-up waits for an admin before any shared data is readable or writable', async () => {
  const fresh = await browser();
  await assert.rejects(fresh.client.signUp('tim@example.com', 'rahasia'), /sudah terdaftar/);
  await assert.rejects(fresh.client.signUp('baru@example.com', '123'), /terlalu lemah/);
  assert.deepEqual(await fresh.client.signUp('konfirmasi@example.com', 'rahasia'), { confirm: true });
  assert.ok(!fresh.client.signedIn, 'no session before the email is confirmed');
  await assert.rejects(fresh.client.signIn('konfirmasi@example.com', 'rahasia'), /belum dikonfirmasi/);

  assert.deepEqual(await fresh.client.signUp('baru@example.com', 'rahasia'), { confirm: false });
  assert.ok(fresh.client.signedIn);
  await fresh.store.ensureAccount('shopee', NAME);
  assert.deepEqual(await fresh.store.sync(NAME), { state: 'pending' });
  await assert.rejects(fresh.store.ready(NAME, { create: true }), /belum disetujui admin/);
  await assert.rejects(fresh.client.rpc('daily_list_accounts'), { code: 'PT403' });

  psql(DB_URL, `insert into dashboard.team_members (user_id) values ('${SIGNUPS['baru@example.com']}')`);
  try {
    assert.notEqual((await fresh.store.sync(NAME)).state, 'pending');
    assert.ok(Array.isArray(await fresh.client.rpc('daily_list_accounts')));
  } finally { psql(DB_URL, `delete from dashboard.team_members where user_id = '${SIGNUPS['baru@example.com']}'`); }
});

test('database stores no raw order IDs or buyer fields', async () => {
  const dump = psql(DB_URL, `select string_agg(t::text, ' ') from (
    select to_jsonb(x)::text t from dashboard.daily_affiliate x union all select to_jsonb(x)::text from dashboard.uploads x
    union all select to_jsonb(x)::text from dashboard.row_hashes x) s`);
  assert.doesNotMatch(dump, /"o1"|p-o1|ID Pemesanan|Waktu Pemesanan/);
});

// End to end in Chromium: real dashboard UI, real SQL, two browser profiles.
test('browser: sign in, save a CSV, and a teammate sees the same history', async () => {
  let harness;
  try { harness = await require('../../browser.regression.test.js').createHarness(); }
  catch (error) {
    if (process.env.REQUIRE_DB === '1') throw error;
    return console.log('  (Chromium tidak tersedia, uji browser dilewati)');
  }
  const { upload, saveDaily, storedRows, aff, ad } = require('../../browser.regression.test.js');
  const profile = async () => {
    const context = await harness.browser.newContext({ viewport: { width: 1280, height: 900 } });
    const external = [], errors = [];
    await context.route('**/*', async route => {
      const url = route.request().url();
      if (url === harness.url + '/supabase-config.js') return route.fulfill({ contentType: 'text/javascript',
        body: 'window.SUPABASE_CONFIG = { url: "https://test.supabase.co", anonKey: "sb_publishable_test" };' });
      if (url.startsWith(harness.url + '/')) return route.continue();
      if (url.startsWith('https://test.supabase.co/')) {
        const request = route.request();
        const cors = { 'Access-Control-Allow-Origin': harness.url, 'Access-Control-Allow-Headers': 'apikey, authorization, content-type, accept',
          'Access-Control-Allow-Methods': 'POST, GET, OPTIONS' };
        if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
        const headers = await request.allHeaders();
        const response = await fakeFetch()(url, { method: request.method(), body: request.postData() || undefined,
          headers: headers.authorization ? { Authorization: headers.authorization } : {} });
        return route.fulfill({ status: response.status, headers: cors, contentType: 'application/json', body: (await response.text()) || '' });
      }
      external.push(url);
      return route.abort();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(harness.url + '/index.html', { waitUntil: 'load' });
    await page.waitForFunction(() => window.__dailyStore && window.__cloudStore);
    return { context, page, external, errors };
  };
  const signIn = async page => {
    await page.locator('#btnStored').click();
    await page.fill('#cloudEmail', 'tim@example.com');
    await page.fill('#cloudPass', 'rahasia');
    await page.locator('#cloudLogin button[type=submit]').click();
    await page.waitForFunction(() => /Tersinkron|Belum ada di database/.test(document.getElementById('cloudCard').innerText))
      .catch(async error => { throw new Error(error.message + '\n' + await page.locator('#cloudCard').innerText() + '\n' + await page.locator('#toast').innerText()); });
  };
  try {
    const first = await profile();
    assert.match(await first.page.locator('#cloudCard').innerText(), /Database bersama[\s\S]*Masuk/);
    await signIn(first.page);
    await first.page.evaluate(() => { document.getElementById('ppn').value = '0'; });
    await upload(first.page, [{ name: 'affiliate.csv', rows: [aff('91', 'Gamma', '2026-09-20'), aff('92', 'Gamma', '2026-09-20')] },
      { name: 'ads.csv', rows: [ad('Gamma', 300, '2026-09-20')] }]);
    await saveDaily(first.page);
    await first.page.waitForFunction(() => /Tersinkron/.test(document.getElementById('cloudCard').innerText));
    const remote = JSON.parse(psql(DB_URL, `select coalesce(jsonb_agg(jsonb_build_object('tag', tag, 'orders', orders, 'comm', comm)), '[]')
      from dashboard.daily_affiliate a join dashboard.accounts c on c.id = a.account_id where c.name = 'default'`));
    assert.deepEqual(remote, [{ tag: 'Gamma', orders: 2, comm: 400 }]);

    const second = await profile();
    await signIn(second.page);
    await second.page.waitForFunction(async () => {
      const account = (await window.__dailyStore.listAccounts('shopee')).find(a => a.name === 'default');
      return account && (await window.__dailyStore.range(account.id, 'ads')).length === 1;
    });
    const rows = await storedRows(second.page, 'affiliate', 'default');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].orders, 2);
    assert.match(await second.page.locator('#tblDayIdx').innerText(), /2026-09-20/);
    for (const { external, errors } of [first, second]) {
      assert.deepEqual(errors, [], 'uncaught browser errors');
      assert.deepEqual(external, [], 'requests outside the dashboard and Supabase');
    }
  } finally { await harness.close(); }
});

(async () => {
  try { psql(BASE, 'select 1'); } catch (error) {
    if (process.env.REQUIRE_DB === '1') throw error;
    console.log('Lewati uji database bersama: Postgres tidak tersedia (' + error.message.split('\n')[0] + ')');
    return;
  }
  psql(BASE, `drop database if exists ${DB}; create database ${DB};`);
  let failed = 0;
  try {
    psql(DB_URL, require('node:fs').readFileSync(path.join(ROOT, 'tests/supabase-stub.sql'), 'utf8'));
    const fs = require('node:fs');
    for (const file of fs.readdirSync(path.join(ROOT, 'migrations')).filter(f => f.endsWith('.sql')).sort())
      psql(DB_URL, fs.readFileSync(path.join(ROOT, 'migrations', file), 'utf8'));
    psql(DB_URL, `insert into auth.users values ${Object.entries(USERS).map(([email, id]) => `('${id}', '${email}')`).join(', ')};
      insert into dashboard.team_members (user_id) values ('${USERS['admin@example.com']}'), ('${USERS['tim@example.com']}');`);
    for (const { name, fn } of cases) {
      try { await fn(); console.log('ok -', name); }
      catch (error) { failed++; console.error('not ok -', name, '\n', error); }
    }
  } finally {
    psql(BASE, `drop database if exists ${DB} with (force);`);
  }
  if (failed) { console.error(failed + ' gagal'); process.exit(1); }
  console.log(cases.length + ' uji database bersama lulus');
})().catch(error => { console.error(error); process.exit(1); });
