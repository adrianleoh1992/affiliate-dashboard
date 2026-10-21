'use strict';

// Synthetic fixtures exercise actual IndexedDB transactions and the v1 schema.
// No personal reports, local browser profiles, network, or running server needed.
const assert = require('node:assert/strict');
const { IDBFactory, IDBKeyRange, IDBObjectStore } = require('fake-indexeddb');
const A = require('./daily-agg');
const DailyStore = require('./daily-store');
const DashboardImport = require('./import-pipeline');
const Papa = require('papaparse');
global.IDBKeyRange = IDBKeyRange;

const cases = [];
const test = (name, fn) => cases.push({ name, fn });
const req = request => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
const affiliate = (id = 'order-1', date = '2026-08-01', extra = {}) => ({
  'ID Pemesanan': id, 'ID Produk': 'product-' + id, 'Status Pesanan': 'Selesai',
  'Waktu Pemesanan': date + ' 10:00:00', 'Tag_link1': 'Alpha--- ',
  'Total Komisi per Produk(Rp)': '200', 'Nilai Pembelian(Rp)': '1000',
  'Jumlah': '1', ...extra,
});
const ad = (id = 'ad-1', date = '2026-08-01', extra = {}) => ({
  'Ad ID': id, 'Ad name': 'Alpha', 'Reporting starts': date,
  'Amount spent (IDR)': '100', 'Impressions': '1000', 'Reach': '800',
  'Link clicks': '10', 'Landing page views': '8', ...extra,
});
const click = (time = '10:00:00', date = '2026-08-01', extra = {}) => ({
  'Waktu Klik': date + ' ' + time, 'Tag_link': 'Alpha',
  'Wilayah Klik': 'Jakarta', 'Perujuk': 'Facebook', ...extra,
});
const save = (store, account, kind, rows, extra = {}) => store.saveDaily(account.id, kind, [], {
  rawRows: rows, sourceRows: rows.length, fileHash: A.hashRows(rows), fileName: kind + '.csv', ...extra,
});
async function context() {
  const store = await DailyStore.open();
  const account = await store.ensureAccount('shopee', 'Synthetic Account');
  return { store, account };
}
async function contents(store, name) {
  return store.transaction(name, 'readonly', tx => req(tx.objectStore(name).getAll()));
}

async function seedV1() {
  const opening = indexedDB.open(DailyStore.DB_NAME, 1);
  opening.onupgradeneeded = () => {
    const db = opening.result;
    const accounts = db.createObjectStore('accounts', { keyPath: 'id', autoIncrement: true });
    accounts.createIndex('kind_name', ['kind', 'name'], { unique: true });
    accounts.add({ id: 1, kind: 'shopee', name: 'Legacy Account' });
    for (const kind of ['affiliate', 'ads', 'clicks']) {
      const s = db.createObjectStore(kind, { keyPath: 'id', autoIncrement: true });
      s.createIndex(kind === 'ads' ? 'acct_date_unit' : 'acct_date_tag',
        ['account_id', 'date', kind === 'ads' ? 'ad_unit' : 'tag'], { unique: true });
      s.createIndex('acct_date', ['account_id', 'date']);
      if (kind === 'affiliate') {
        const record = A.aggregateAffiliate([affiliate()])[0];
        delete record.order_keys; // v1 kept the count, but not order identities.
        delete record.order_parts;
        s.add({ ...record, account_id: 1, created_at: '2026-08-01T12:00:00Z' });
      }
    }
    const uploads = db.createObjectStore('uploads', { keyPath: 'id', autoIncrement: true });
    uploads.createIndex('acct_hash', ['account_id', 'file_hash'], { unique: true });
    uploads.createIndex('acct', 'account_id');
    uploads.add({ account_id: 1, kind: 'affiliate', file_hash: A.hashRows([affiliate()]),
      file_name: 'legacy.csv', rows: 1, period_start: '2026-08-01', period_end: '2026-08-01' });
    const hashes = db.createObjectStore('rowhashes', { keyPath: 'id', autoIncrement: true });
    hashes.createIndex('acct_kind_hash', ['account_id', 'kind', 'hash'], { unique: true });
    hashes.createIndex('acct_kind', ['account_id', 'kind']);
    hashes.add({ account_id: 1, kind: 'affiliate', hash: A.hashRow(affiliate()) });
  };
  (await req(opening)).close();
}

test('localized amounts, aliases, genuine dates and normalized tags agree', () => {
  assert.equal(A.num('Rp 1.234.567,89'), 1234567.89);
  assert.equal(A.num('1,234.56'), 1234.56);
  assert.equal(A.num('(Rp 1.234,50)'), -1234.5);
  assert.equal(A.num('1e3'), 1000);
  assert.equal(A.num('2.5e-2'), 0.025);
  assert.equal(A.isDate('2026-02-30'), false);
  assert.equal(A.isDate('2024-02-29'), true);
  assert.equal(A.isDate('2026-02-29'), false);
  const row = affiliate();
  delete row['Total Komisi per Produk(Rp)'];
  row['Total Komisi per Pesanan(Rp)'] = '200,50';
  const result = A.aggregateAffiliate([row, affiliate('invalid', '2026-02-30')]);
  assert.equal(result.length, 1);
  assert.equal(result[0].comm, 200.5);
  assert.equal(result[0].tag, 'Alpha');
  assert.equal(A.aggregateAds([{ 'Reporting starts': '2026-08-01', 'Campaign name': 'Campaign', 'Amount spent': '1,250' }])[0].spend, 1250);
});

test('fingerprints are deterministic across key order and suppress same-batch duplicates', () => {
  const row = affiliate(), reordered = Object.fromEntries(Object.entries(row).reverse());
  assert.equal(A.hashRow(row), A.hashRow(reordered));
  const dedup = A.dedupe([row, reordered, affiliate('order-2')]);
  assert.equal(dedup.kept.length, 2);
  assert.equal(dedup.duplicates, 1);
});

test('overlapping uploads add unseen orders instead of replacing a partial day', async () => {
  const { store, account } = await context();
  const first = affiliate(), second = affiliate('order-2');
  await save(store, account, 'affiliate', [first]);
  const result = await save(store, account, 'affiliate', [first, second]);
  assert.deepEqual(result, { added: 0, updated: 1, duplicates: 1 });
  const [day] = await store.range(account.id, 'affiliate');
  assert.equal(day.comm, 400);
  assert.equal(day.gmv, 2000);
  assert.equal(day.rows, 2);
  assert.equal(day.orders, 2);
  assert.equal(day.merge_version, 2);
  // Order parts replace fingerprints for commission reports.
  assert.equal((await store.knownRowHashes(account.id, 'affiliate')).size, 0);
  store.close();
});

test('a revised report replaces order statuses instead of adding them again', async () => {
  const { store, account } = await context();
  const pending = { 'Status Pesanan': 'Tertunda' };
  await save(store, account, 'affiliate', [affiliate('order-1', '2026-08-01', pending), affiliate('order-2', '2026-08-01', pending),
    affiliate('order-3'), affiliate('order-4', '2026-08-01', { 'Status Pesanan': 'Belum Dibayar' })]);
  // Same report a week later: one order completed (commission revised), one cancelled, one paid.
  const result = await save(store, account, 'affiliate', [affiliate('order-1', '2026-08-01', { 'Total Komisi per Produk(Rp)': '180' }),
    affiliate('order-2', '2026-08-01', { 'Status Pesanan': 'Dibatalkan' }), affiliate('order-3'), affiliate('order-4', '2026-08-01', pending)]);
  assert.deepEqual(result, { added: 0, updated: 1, duplicates: 1 });
  const [day] = await store.range(account.id, 'affiliate');
  assert.equal(day.rows, 4);
  assert.equal(day.excluded, 1);
  assert.equal(day.orders, 3);
  assert.equal(day.comm, 180 + 200 + 200);
  assert.equal(day.comm_done, 380);
  assert.equal(day.comm_pending, 200);
  assert.equal(day.gmv, 3000);
  // Saving the revision again changes nothing.
  const again = await save(store, account, 'affiliate', [affiliate('order-1', '2026-08-01', { 'Total Komisi per Produk(Rp)': '180' }),
    affiliate('order-2', '2026-08-01', { 'Status Pesanan': 'Dibatalkan' }), affiliate('order-3'), affiliate('order-4', '2026-08-01', pending)],
    { fileHash: 'same rows, new export' });
  assert.deepEqual(again, { added: 0, updated: 0, duplicates: 4 });
  store.close();
});

test('a file with only some orders of a saved day keeps the other orders', async () => {
  const { store, account } = await context();
  await save(store, account, 'affiliate', [affiliate('order-1'), affiliate('order-2', '2026-08-01', { 'Status Pesanan': 'Tertunda' })]);
  await save(store, account, 'affiliate', [affiliate('order-2')]);
  const [day] = await store.range(account.id, 'affiliate');
  assert.equal(day.orders, 2);
  assert.equal(day.comm, 400);
  assert.equal(day.comm_done, 400);
  assert.equal(day.comm_pending, 0);
  store.close();
});

test('ad rows with an Ad ID replace the saved day, and two ads sharing a name stay separate', async () => {
  const { store, account } = await context();
  const first = ad('120212345678901234'), second = ad('120212345678905678', '2026-08-01', { 'Amount spent (IDR)': '50' });
  assert.deepEqual(await save(store, account, 'ads', [first, second]), { added: 2, updated: 0, duplicates: 0 });
  // A re-pull with Meta's corrected spend for one of them.
  const result = await save(store, account, 'ads', [ad('120212345678901234', '2026-08-01', { 'Amount spent (IDR)': '110' }), second]);
  assert.deepEqual(result, { added: 0, updated: 1, duplicates: 1 });
  const days = await store.range(account.id, 'ads');
  assert.deepEqual(days.map(r => [r.ad_key, r.ad_unit, r.spend, r.merge_version]).sort(),
    [['id:120212345678901234', 'Alpha', 110, 2], ['id:120212345678905678', 'Alpha', 50, 2]]);
  assert.equal((await store.knownRowHashes(account.id, 'ads')).size, 0);
  // A spreadsheet-rounded ID is not trusted as an identity.
  assert.equal(A.adIdOf(ad('120212345678901000')), '');
  store.close();
});

test('one ad saved once without an Ad ID and once with it on the same day is refused', async () => {
  const { store, account } = await context();
  await save(store, account, 'ads', [ad('', '2026-08-01')]);
  await assert.rejects(save(store, account, 'ads', [ad('120212345678901234', '2026-08-01')]), /tanpa Ad ID[\s\S]*2026-08-01/);
  await save(store, account, 'ads', [ad('120212345678901234', '2026-08-02')]);
  await assert.rejects(save(store, account, 'ads', [ad('', '2026-08-02', { 'Impressions': '5' })]), /2026-08-02/);
  // Meta exports the current name for past days: a renamed ad is still the same spend.
  await save(store, account, 'ads', [ad('', '2026-08-03')]);
  await assert.rejects(save(store, account, 'ads', [ad('120212345678901234', '2026-08-03', { 'Ad name': 'Alpha v2' })]), /2026-08-03/);
  assert.equal((await store.range(account.id, 'ads')).length, 3);
  store.close();
});

test('fingerprint-format days convert to order parts only when the file holds all their orders', async () => {
  const { store, account } = await context();
  const keys = ['order-1', 'order-2'].map(orderId => A.hashRow({ orderId })).sort();
  const v1 = {
    format: DailyStore.BACKUP_FORMAT, version: DailyStore.BACKUP_VERSION, database_version: 2,
    exported_at: '2026-09-07T00:00:00Z', account: { id: 7, kind: 'shopee', name: 'v1' }, ads: [], clicks: [], uploads: [],
    affiliate: [{ account_id: 7, date: '2026-08-01', tag: 'Alpha', comm: 400, comm_done: 400, comm_pending: 0, gmv: 2000, qty: 2,
      refund: 0, orders: 2, order_keys: keys, excluded: 0, rows: 2, merge_version: 1 },
      { account_id: 7, date: '2026-08-01', tag: 'Beta', comm: 200, comm_done: 200, comm_pending: 0, gmv: 1000, qty: 1,
        refund: 0, orders: 1, order_keys: [A.hashRow({ orderId: 'order-9' })], excluded: 0, rows: 1, merge_version: 1 }],
    rowhashes: ['a', 'b', 'c'].map(h => ({ account_id: 7, kind: 'affiliate', hash: h.repeat(16), date: '2026-08-01' })),
  };
  await store.importAccount(account.id, v1, { replace: true });
  await assert.rejects(save(store, account, 'affiliate', [affiliate('order-1')]), /format lama[\s\S]*Alpha/);
  await assert.rejects(save(store, account, 'affiliate', [affiliate('order-1'), affiliate('order-2')]), /format lama[\s\S]*Beta/);
  await save(store, account, 'affiliate', [affiliate('order-1'), affiliate('order-2'), affiliate('order-9', '2026-08-01', { 'Tag_link1': 'Beta' })]);
  const days = await store.range(account.id, 'affiliate');
  assert.deepEqual(days.map(r => [r.tag, r.merge_version, r.comm, r.orders]).sort(), [['Alpha', 2, 400, 2], ['Beta', 2, 200, 1]]);
  assert.equal((await store.knownRowHashes(account.id, 'affiliate')).size, 0);
  DailyStore.validateBackup(await store.exportAccount(account.id));
  store.close();
});

test('version 2 databases move ads to ad keys in place', async () => {
  const opening = indexedDB.open(DailyStore.DB_NAME, 2);
  opening.onupgradeneeded = () => {
    const db = opening.result;
    db.createObjectStore('accounts', { keyPath: 'id', autoIncrement: true }).createIndex('kind_name', ['kind', 'name'], { unique: true });
    for (const kind of ['affiliate', 'ads', 'clicks']) {
      const s = db.createObjectStore(kind, { keyPath: 'id', autoIncrement: true });
      s.createIndex(kind === 'ads' ? 'acct_date_unit' : 'acct_date_tag', ['account_id', 'date', kind === 'ads' ? 'ad_unit' : 'tag'], { unique: true });
      s.createIndex('acct_date', ['account_id', 'date']);
    }
    const uploads = db.createObjectStore('uploads', { keyPath: 'id', autoIncrement: true });
    uploads.createIndex('acct', 'account_id');
    uploads.createIndex('acct_hash', ['account_id', 'file_hash']);
    uploads.createIndex('acct_kind_hash', ['account_id', 'kind', 'file_hash'], { unique: true });
    const hashes = db.createObjectStore('rowhashes', { keyPath: 'id', autoIncrement: true });
    hashes.createIndex('acct_kind_hash', ['account_id', 'kind', 'hash'], { unique: true });
    hashes.createIndex('acct_kind', ['account_id', 'kind']);
    hashes.createIndex('acct_kind_date', ['account_id', 'kind', 'date']);
    opening.transaction.objectStore('accounts').add({ id: 1, kind: 'shopee', name: 'v2' });
    const [record] = A.aggregateAds([ad('', '2026-08-01')]);
    delete record.ad_id; delete record.ad_key;
    opening.transaction.objectStore('ads').add({ ...record, account_id: 1, merge_version: 1 });
    opening.transaction.objectStore('rowhashes').add({ account_id: 1, kind: 'ads', hash: A.hashRow(ad('', '2026-08-01')), date: '2026-08-01' });
  };
  (await req(opening)).close();
  const store = await DailyStore.open();
  assert.equal(store.db.version, 3);
  const [row] = await store.range(1, 'ads');
  assert.equal(row.ad_key, 'name:Alpha');
  assert.equal(row.ad_id, '');
  assert.deepEqual(await save(store, { id: 1 }, 'ads', [ad('', '2026-08-01'), ad('', '2026-08-01', { 'Impressions': '7' })]),
    { added: 0, updated: 1, duplicates: 1 });
  assert.equal((await store.range(1, 'ads'))[0].impressions, 1007);
  DailyStore.validateBackup(await store.exportAccount(1));
  store.close();
});

test('validated imports preserve old string-row dedup for repeated, overlapping and restored uploads', async () => {
  const { store, account } = await context();
  const fixtures = {
    affiliate: [affiliate(), affiliate('order-2')],
    ads: [ad(), ad('ad-2')],
    clicks: [click('10:00:00', '2026-08-01', { Tag_link: ' Alpha ' }), click('11:00:00')],
  };
  const parsed = {};
  for (const [kind, rows] of Object.entries(fixtures)) {
    await save(store, account, kind, rows.slice(0, 1));
    const repeated = DashboardImport.parseText(Papa.unparse(rows.slice(0, 1)));
    assert.equal(repeated.ok, true);
    const repeat = await save(store, account, kind, repeated.rows);
    assert.equal(repeat.added, 0);
    assert.equal(repeat.updated, 0);
    parsed[kind] = DashboardImport.parseText(Papa.unparse(rows)).rows;
    assert.deepEqual(await save(store, account, kind, parsed[kind]), { added: 0, updated: 1, duplicates: 1 });
    const [day] = await store.range(account.id, kind);
    assert.equal(kind === 'clicks' ? day.clicks : day.rows, 2);
    assert.equal((await store.knownRowHashes(account.id, kind)).size, kind === 'affiliate' ? 0 : 2);
  }
  const backup = await store.exportAccount(account.id);
  DailyStore.validateBackup(backup);
  const target = await store.ensureAccount('shopee', 'Validated Restore');
  await store.importAccount(target.id, backup, { replace: true });
  for (const [kind, rows] of Object.entries(parsed)) {
    assert.equal((await save(store, target, kind, rows)).skipped, true);
    const revisedFormatting = DashboardImport.parseText(Papa.unparse(fixtures[kind].slice(1))).rows;
    const repeat = await save(store, target, kind, revisedFormatting, { fileHash: '' });
    assert.equal(repeat.updated, 0);
    assert.equal(repeat.duplicates, 1);
  }
  store.close();
});

test('an order with several products counts once; a later file replaces its lines but may not drop any', async () => {
  const { store, account } = await context();
  await save(store, account, 'affiliate', [affiliate()]);
  await save(store, account, 'affiliate', [affiliate(), affiliate('order-1', '2026-08-01', { 'ID Produk': 'different-product' })]);
  let [day] = await store.range(account.id, 'affiliate');
  assert.equal(day.comm, 400);
  assert.equal(day.rows, 2);
  assert.equal(day.orders, 1);
  assert.deepEqual(Object.keys(day.order_parts), [A.hashRow({ orderId: 'order-1' })]);
  assert.equal(day.order_keys, undefined);
  // A later report lists every line of the order again: both are replaced.
  await save(store, account, 'affiliate', [affiliate('order-1', '2026-08-01', { 'Status Pesanan': 'Tertunda' }),
    affiliate('order-1', '2026-08-01', { 'ID Produk': 'different-product', 'Status Pesanan': 'Tertunda' })]);
  [day] = await store.range(account.id, 'affiliate');
  assert.equal(day.comm, 400);
  assert.equal(day.comm_pending, 400);
  assert.equal(day.rows, 2);
  // Only one of its lines (the reader rejected the other, or a filtered
  // export) would delete the other product: refused, nothing changes.
  await assert.rejects(save(store, account, 'affiliate', [affiliate('order-1', '2026-08-01', { 'ID Produk': 'different-product' })]),
    /sebagian baris produk[\s\S]*2026-08-01 \(Alpha\)/);
  [day] = await store.range(account.id, 'affiliate');
  assert.equal(day.comm, 400);
  assert.equal(day.rows, 2);
  store.close();
});

test('a replacing file without an optional metric column keeps the saved values', async () => {
  const { store, account } = await context();
  const id = '120212345678901234';
  await save(store, account, 'ads', [ad(id, '2026-08-01', { 'Results': '5' })]);
  // A Meta pull has no Results column; this preset also leaves out Reach.
  const pulled = ad(id, '2026-08-01', { 'Amount spent (IDR)': '150' });
  delete pulled['Reach'];
  assert.deepEqual(await save(store, account, 'ads', [pulled]), { added: 0, updated: 1, duplicates: 0 });
  const [row] = await store.range(account.id, 'ads');
  assert.equal(row.spend, 150);
  assert.equal(row.results, 5);
  assert.equal(row.reach, 800);
  assert.equal(row.cpm, 150);
  assert.equal(row.keep, undefined);
  // Nothing new in it beyond the kept columns: a duplicate, not an update.
  const again = ad(id, '2026-08-01', { 'Amount spent (IDR)': '150' });
  delete again['Reach'];
  delete again['Link clicks'];
  assert.deepEqual(await save(store, account, 'ads', [again], { fileHash: 'again' }), { added: 0, updated: 0, duplicates: 1 });

  await save(store, account, 'affiliate', [affiliate('order-1', '2026-08-01', { 'Status Pesanan': 'Tertunda' })]);
  const revised = [affiliate('order-1'), affiliate('order-2')];
  revised.forEach(r => delete r['Nilai Pembelian(Rp)']);
  await save(store, account, 'affiliate', revised);
  const [day] = await store.range(account.id, 'affiliate');
  assert.equal(day.comm_done, 400);
  assert.equal(day.gmv, 1000, 'order-1 keeps its saved purchase value; order-2 has none to keep');
  assert.equal(day.qty, 2);
  assert.equal(Object.values(day.order_parts).find(p => p[3] === 1000)[1], 200);
  store.close();
});

test('a fingerprint-format day converts only with at least as many rows as it saved', () => {
  const [record] = A.aggregateAffiliate([affiliate()]);
  const v1 = { ...record, order_parts: undefined, order_keys: Object.keys(record.order_parts), rows: 2, merge_version: 1 };
  assert.throws(() => A.checkDays('affiliate', [record], new Map([['2026-08-01', [v1]]])), /format lama/);
  assert.deepEqual(A.checkDays('affiliate', [record], new Map([['2026-08-01', [{ ...v1, rows: 1 }]]])), ['2026-08-01']);
  // A column the file lacks may not zero a saved total that cannot be split per order.
  const lacking = { ...record, keep: ['gmv'] };
  assert.throws(() => A.checkDays('affiliate', [lacking], new Map([['2026-08-01', [{ ...v1, rows: 1 }]]])), /Nilai Pembelian/);
  assert.deepEqual(A.checkDays('affiliate', [lacking], new Map([['2026-08-01', [{ ...v1, rows: 1, gmv: 0 }]]])), ['2026-08-01']);
});

test('a save plan refuses history from before mergeable aggregates, like the store', () => {
  const [record] = A.aggregateAffiliate([affiliate()]);
  const legacy = { ...record, order_parts: undefined, order_keys: undefined, merge_version: undefined };
  assert.throws(() => A.checkDays('affiliate', [record], new Map([['2026-08-01', [legacy]]])), /Riwayat lama 2026-08-01/);
  assert.deepEqual(A.checkDays('affiliate', [record], new Map([['2026-08-01', [{ ...legacy, tag: 'Other' }]]])), []);
});

test('a synced commission day converted on the server drops its cached fingerprints', async () => {
  const { store, account } = await context();
  const backup = {
    format: DailyStore.BACKUP_FORMAT, version: DailyStore.BACKUP_VERSION, database_version: 3,
    exported_at: '2026-09-07T00:00:00Z', account: { id: 7, kind: 'shopee', name: 'v1' }, ads: [], clicks: [], uploads: [],
    affiliate: [{ account_id: 7, date: '2026-08-01', tag: 'Alpha', comm: 200, comm_done: 200, comm_pending: 0, gmv: 1000, qty: 1,
      refund: 0, orders: 1, order_keys: [A.hashRow({ orderId: 'order-1' })], excluded: 0, rows: 1, merge_version: 1 },
      { account_id: 7, date: '2026-08-02', tag: 'Alpha', comm: 200, comm_done: 200, comm_pending: 0, gmv: 1000, qty: 1,
        refund: 0, orders: 1, order_keys: [A.hashRow({ orderId: 'order-2' })], excluded: 0, rows: 1, merge_version: 1 }],
    rowhashes: ['a', 'b'].map((h, i) => ({ account_id: 7, kind: 'affiliate', hash: h.repeat(16), date: '2026-08-0' + (i + 1) })),
  };
  await store.importAccount(account.id, backup, { replace: true });
  const [converted] = A.aggregateAffiliate([affiliate()]);
  await store.applyChanges(account.id, { format: DailyStore.BACKUP_FORMAT, version: DailyStore.BACKUP_VERSION, database_version: 3,
    exported_at: '2026-09-08T00:00:00Z', account: { id: 7, kind: 'shopee', name: 'v1' }, ads: [], clicks: [], uploads: [], rowhashes: [],
    affiliate: [{ ...converted, account_id: 7, merge_version: 2 }] });
  assert.deepEqual((await contents(store, 'rowhashes')).map(h => h.date), ['2026-08-02']);
  DailyStore.validateBackup(await store.exportAccount(account.id));
  store.close();
});

test('excluded rows cannot add commission or order identities', async () => {
  const { store, account } = await context();
  await save(store, account, 'affiliate', [affiliate(), affiliate('cancelled', '2026-08-01', { 'Status Pesanan': 'Dibatalkan' }),
    affiliate('unpaid', '2026-08-01', { 'Status Pesanan': 'Belum Dibayar' })]);
  const [day] = await store.range(account.id, 'affiliate');
  assert.equal(day.comm, 200);
  assert.equal(day.orders, 1);
  assert.equal(day.excluded, 2);
  assert.equal(day.rows, 3);
  store.close();
});

test('duplicate files in a batch are a completed no-op with one upload log', async () => {
  const { store, account } = await context();
  const rows = [affiliate(), affiliate()];
  const results = await Promise.all([save(store, account, 'affiliate', rows), save(store, account, 'affiliate', rows)]);
  assert.equal(results.filter(r => r.skipped).length, 1);
  assert.equal(results[0].duplicates, 1);
  assert.equal((await store.range(account.id, 'affiliate'))[0].comm, 200);
  assert.equal((await store.uploadHistory(account.id)).length, 1);
  store.close();
});

test('two independent connections serialize overlap and account creation', async () => {
  const one = await DailyStore.open(), two = await DailyStore.open();
  const [account, sameAccount] = await Promise.all([one.ensureAccount('shopee', 'Shared'), two.ensureAccount('shopee', 'Shared')]);
  assert.equal(account.id, sameAccount.id);
  const rows = [affiliate(), affiliate('order-2')];
  await Promise.all([save(one, account, 'affiliate', [rows[0]]), save(two, account, 'affiliate', rows)]);
  assert.equal((await one.range(account.id, 'affiliate'))[0].comm, 400);
  assert.equal((await one.range(account.id, 'affiliate'))[0].orders, 2);
  await Promise.all([save(one, account, 'ads', [ad()]), save(two, account, 'ads', [ad()])]);
  assert.equal((await two.range(account.id, 'ads'))[0].spend, 100);
  assert.equal((await one.uploadHistory(account.id)).length, 3);
  one.close(); two.close();
});

test('incremental ad aggregates derive rates from combined amounts and counts', async () => {
  const { store, account } = await context();
  await save(store, account, 'ads', [ad()]);
  await save(store, account, 'ads', [ad('ad-2', '2026-08-01', { 'Amount spent (IDR)': '300', 'Link clicks': '30', 'Impressions': '1000' })]);
  const [day] = await store.range(account.id, 'ads');
  assert.equal(day.spend, 400);
  assert.equal(day.impressions, 2000);
  assert.equal(day.clicks, 40);
  assert.equal(day.cpm, 200);
  assert.equal(day.cpc, 10);
  assert.equal(day.ctr, 2);
  store.close();
});

test('click breakdowns retain literal reserved keys without prototype pollution', async () => {
  const { store, account } = await context();
  await save(store, account, 'clicks', [click('10:00:00', '2026-08-01', { 'Wilayah Klik': '__proto__', 'Perujuk': 'constructor' })]);
  await save(store, account, 'clicks', [click('10:01:00', '2026-08-01', { 'Wilayah Klik': '__proto__', 'Perujuk': 'constructor' })]);
  const [day] = await store.range(account.id, 'clicks');
  assert.equal(day.clicks, 2);
  assert.equal(day.by_region.__proto__, 2);
  assert.equal(day.by_source.constructor, 2);
  assert.equal({}.polluted, undefined);
  store.close();
});

test('account and report-kind guards are isolated even with identical fingerprints', async () => {
  const { store, account } = await context();
  const other = await store.ensureAccount('shopee', 'Other Account');
  await save(store, account, 'affiliate', [affiliate()], { fileHash: 'same' });
  await save(store, other, 'affiliate', [affiliate()], { fileHash: 'same' });
  await save(store, account, 'ads', [ad()], { fileHash: 'same' });
  assert.equal((await store.range(account.id, 'affiliate'))[0].comm, 200);
  assert.equal((await store.range(other.id, 'affiliate'))[0].comm, 200);
  assert.equal((await store.range(account.id, 'ads'))[0].spend, 100);
  assert.equal((await store.range(other.id, 'ads')).length, 0);
  assert.equal((await store.uploadHistory(account.id)).length, 2);
  assert.equal((await store.seenFile(account.id, 'same', 'ads')).kind, 'ads');
  assert.equal(await store.seenFile(other.id, 'same', 'ads'), null);
  store.close();
});

test('deleting one day permits full-file reupload without doubling retained days', async () => {
  const { store, account } = await context();
  const rows = [affiliate(), affiliate('order-2', '2026-08-02')];
  await save(store, account, 'affiliate', rows);
  await save(store, account, 'ads', [ad()]);
  assert.equal(await store.deleteDay(account.id, 'affiliate', '2026-08-01'), 1);
  assert.equal(await store.seenFile(account.id, A.hashRows(rows), 'affiliate'), null);
  assert.equal((await store.range(account.id, 'affiliate')).length, 1);
  const result = await save(store, account, 'affiliate', rows);
  assert.deepEqual(result, { added: 1, updated: 0, duplicates: 1 });
  assert.deepEqual((await store.range(account.id, 'affiliate')).map(r => [r.date, r.comm]), [['2026-08-01', 200], ['2026-08-02', 200]]);
  assert.equal((await store.range(account.id, 'ads'))[0].spend, 100);
  store.close();
});

test('revised statuses are corrected by deleting and reimporting the complete day', async () => {
  const { store, account } = await context();
  await save(store, account, 'affiliate', [affiliate('order-1', '2026-08-01', { 'Status Pesanan': 'Tertunda' })]);
  await store.deleteDay(account.id, 'affiliate', '2026-08-01');
  await save(store, account, 'affiliate', [affiliate()]);
  const [day] = await store.range(account.id, 'affiliate');
  assert.equal(day.comm, 200);
  assert.equal(day.comm_pending, 0);
  assert.equal(day.comm_done, 200);
  assert.equal(day.orders, 1);
  store.close();
});

test('forgetting an upload does not remove row dedup protection', async () => {
  const { store, account } = await context();
  await save(store, account, 'affiliate', [affiliate()]);
  const [log] = await store.uploadHistory(account.id);
  await store.forgetUpload(log.id);
  const result = await save(store, account, 'affiliate', [affiliate()]);
  assert.deepEqual(result, { added: 0, updated: 0, duplicates: 1 });
  assert.equal((await store.range(account.id, 'affiliate'))[0].comm, 200);
  store.close();
});

test('failed writes roll back daily totals, fingerprints and upload guards together', async () => {
  const { store, account } = await context();
  // A legacy API batch fails after one valid add request has already succeeded.
  const valid = A.aggregateAffiliate([affiliate()])[0];
  await assert.rejects(store.saveDaily(account.id, 'affiliate', [valid, { ...valid, date: '2026-02-30' }], {
    rowHashes: [A.hashRow(affiliate())], fileHash: 'rollback', sourceRows: 2,
  }), /Record harian tidak valid/);
  assert.equal((await store.range(account.id, 'affiliate')).length, 0);
  assert.equal((await store.knownRowHashes(account.id, 'affiliate')).size, 0);
  assert.equal(await store.seenFile(account.id, 'rollback', 'affiliate'), null);
  // The connection remains usable after abort.
  assert.equal((await save(store, account, 'affiliate', [affiliate()])).added, 1);
  store.close();
});

test('v1 migration preserves history and rejects unidentified legacy overlap atomically', async () => {
  await seedV1();
  const store = await DailyStore.open(), account = { id: 1 };
  assert.equal(store.db.version, 3);
  assert.equal((await store.range(1, 'affiliate'))[0].comm, 200);
  assert.equal((await store.range(1, 'affiliate'))[0].orders, 1);
  assert.ok(await store.seenFile(1, A.hashRows([affiliate()]), 'affiliate'));
  assert.equal((await save(store, account, 'affiliate', [affiliate()])).skipped, true);
  const overlapping = [affiliate('new-early', '2026-07-31'), affiliate('new-overlap')];
  await assert.rejects(save(store, account, 'affiliate', overlapping), /Riwayat lama.*dihapus.*diunggah ulang/);
  assert.equal((await store.range(1, 'affiliate')).length, 1);
  assert.equal((await store.knownRowHashes(1, 'affiliate')).size, 1);
  assert.equal((await store.uploadHistory(1)).length, 1);
  await store.deleteDay(1, 'affiliate', '2026-08-01');
  await save(store, account, 'affiliate', [affiliate(), affiliate('new-overlap')]);
  const [day] = await store.range(1, 'affiliate');
  assert.equal(day.comm, 400);
  assert.equal(day.orders, 2);
  assert.equal(day.merge_version, 2);
  store.close();
});

test('v1 migration allows new dates without requiring unrelated history deletion', async () => {
  await seedV1();
  const store = await DailyStore.open();
  await save(store, { id: 1 }, 'affiliate', [affiliate('new-day', '2026-08-02')]);
  assert.deepEqual((await store.range(1, 'affiliate')).map(r => r.comm), [200, 200]);
  store.close();
});

test('invalid dates are excluded from stored figures and fingerprints', async () => {
  const { store, account } = await context();
  await save(store, account, 'affiliate', [affiliate(), affiliate('bad-date', '2026-02-30')]);
  assert.equal((await store.range(account.id, 'affiliate')).length, 1);
  await save(store, account, 'clicks', [click(), click('10:00:00', '2026-02-30')]);
  assert.equal((await store.knownRowHashes(account.id, 'clicks')).size, 1);
  const [log] = await store.uploadHistory(account.id);
  assert.equal(log.period_start, '2026-08-01');
  assert.equal(log.period_end, '2026-08-01');
  await assert.rejects(store.range(account.id, 'affiliate', '2026-08-02', '2026-08-01'), /Tanggal mulai/);
  await assert.rejects(store.deleteDay(account.id, 'affiliate', '2026-02-30'), /Tanggal tidak valid/);
  store.close();
});

test('storage retains aggregates and fingerprints without raw rows or clear order IDs', async () => {
  const { store, account } = await context();
  await save(store, account, 'affiliate', [affiliate('private-order', '2026-08-01', { 'Nama Pelanggan': 'Private Person' })]);
  await save(store, account, 'clicks', [click('10:00:00', '2026-08-01', { 'Nama Pelanggan': 'Private Person' })]);
  const dump = Object.fromEntries(await Promise.all(['affiliate', 'rowhashes'].map(async kind => [kind, await contents(store, kind)])));
  const serialized = JSON.stringify(dump);
  assert.doesNotMatch(serialized, /private-order|Private Person|Nama Pelanggan|rawRows|ID Pemesanan/);
  assert.equal(dump.rowhashes[0].date, '2026-08-01');
  const exported = await store.exportAccount(account.id);
  assert.equal(exported.account.id, account.id);
  assert.equal(exported.affiliate.length, 1);
  assert.equal(exported.uploads.length, 2);
  store.close();
});

test('deleting an account removes all of its data and preserves other accounts', async () => {
  const { store, account } = await context();
  const other = await store.ensureAccount('shopee', 'Other');
  for (const [kind, rows] of [['affiliate', [affiliate()]], ['ads', [ad()]], ['clicks', [click()]]]) {
    await save(store, account, kind, rows);
    await save(store, other, kind, rows);
  }
  await store.deleteAccount(account.id);
  assert.equal((await store.listAccounts()).length, 1);
  for (const kind of ['affiliate', 'ads', 'clicks']) {
    assert.equal((await store.range(account.id, kind)).length, 0);
    assert.equal((await store.knownRowHashes(account.id, kind)).size, 0);
    assert.equal((await store.range(other.id, kind)).length, 1);
  }
  assert.equal((await store.uploadHistory(account.id)).length, 0);
  assert.equal((await store.uploadHistory(other.id)).length, 3);
  await assert.rejects(save(store, account, 'affiliate', [affiliate()]), /Akun tidak ditemukan/);
  store.close();
});

test('account rename conflicts abort without changing account identities', async () => {
  const { store, account } = await context();
  const other = await store.ensureAccount('shopee', 'Other');
  await assert.rejects(store.renameAccount(account.id, other.name), { name: 'ConstraintError' });
  assert.equal((await store.ensureAccount('shopee', account.name)).id, account.id);
  await assert.rejects(store.renameAccount(account.id, '  '), /Nama akun kosong/);
  assert.equal((await store.listAccounts()).length, 2);
  store.close();
});

const clone = value => JSON.parse(JSON.stringify(value));
const backupRecords = backup => Object.fromEntries(['affiliate', 'ads', 'clicks', 'rowhashes', 'uploads'].map(kind =>
  [kind, backup[kind].map(({ id, account_id, ...row }) => row)]));
async function seedBackup(store, account) {
  await save(store, account, 'affiliate', [affiliate(), affiliate('order-1', '2026-08-01', { 'ID Produk': 'second-product' }), affiliate('order-2', '2026-08-02')]);
  await save(store, account, 'ads', [ad(), ad('ad-2', '2026-08-02')]);
  await save(store, account, 'clicks', [click(), click('11:00:00', '2026-08-02', { 'Wilayah Klik': '__proto__', 'Perujuk': 'constructor' })]);
  return store.exportAccount(account.id, { ppn: 11, pendingFactor: 0.95, dateStart: '', dateEnd: '' });
}

test('versioned backup restores every aggregate, order key, fingerprint and upload into the chosen account', async () => {
  const { store, account } = await context();
  const target = await store.ensureAccount('shopee', 'Restore Target');
  const other = await store.ensureAccount('shopee', 'Untouched Account');
  const backup = await seedBackup(store, account);
  await save(store, target, 'affiliate', [affiliate('old-target', '2026-07-01')]);
  await save(store, other, 'affiliate', [affiliate('other')]);
  const otherBefore = backupRecords(await store.exportAccount(other.id));
  assert.equal(backup.format, DailyStore.BACKUP_FORMAT);
  assert.equal(backup.version, DailyStore.BACKUP_VERSION);
  assert.equal(backup.database_version, 3);
  assert.equal(backup.rowhashes.length, 4);
  const validated = DailyStore.validateBackup(clone(backup));
  assert.equal(validated.summary.days, 2);
  assert.deepEqual(validated.data.parameters, backup.parameters);
  await store.importAccount(target.id, validated.data, { replace: true });
  const restored = await store.exportAccount(target.id);
  assert.equal(restored.account.id, target.id);
  assert.equal(restored.account.name, target.name);
  assert.deepEqual(backupRecords(restored), backupRecords(backup));
  assert.deepEqual(backupRecords(await store.exportAccount(other.id)), otherBefore);
  assert.deepEqual(backupRecords(await store.exportAccount(account.id)), backupRecords(backup));
  for (const kind of ['affiliate', 'ads', 'clicks', 'rowhashes', 'uploads']) {
    assert.ok(restored[kind].every(row => row.account_id === target.id));
    assert.ok(restored[kind].every(row => !backup[kind].some(source => source.id === row.id)));
  }
  assert.equal((await save(store, target, 'affiliate', [affiliate(), affiliate('order-1', '2026-08-01', { 'ID Produk': 'second-product' }), affiliate('order-2', '2026-08-02')])).skipped, true);
  const next = await save(store, target, 'affiliate', [affiliate(), affiliate('order-1', '2026-08-01', { 'ID Produk': 'second-product' }), affiliate('order-3')]);
  assert.deepEqual(next, { added: 0, updated: 1, duplicates: 2 });
  assert.equal((await store.range(target.id, 'affiliate'))[0].orders, 2);
  assert.equal((await store.range(target.id, 'affiliate'))[0].comm, 600);
  assert.equal({}.polluted, undefined);
  store.close();
});

test('restoration requires explicit replacement and an existing target account', async () => {
  const { store, account } = await context();
  const backup = await seedBackup(store, account);
  await assert.rejects(store.importAccount(account.id, backup), /Konfirmasi/);
  await assert.rejects(store.importAccount(999, backup, { replace: true }), /Akun tujuan/);
  assert.deepEqual(backupRecords(await store.exportAccount(account.id)), backupRecords(backup));
  store.close();
});

test('compact serialized backups roundtrip supported records and pass restore validation', async () => {
  const { store, account } = await context();
  const target = await store.ensureAccount('shopee', 'Serialized Restore');
  const backup = await seedBackup(store, account);
  const text = DailyStore.serializeBackup(backup), parsed = JSON.parse(text);
  assert.equal(text, JSON.stringify(parsed));
  assert.ok(Buffer.byteLength(text, 'utf8') <= DailyStore.MAX_BACKUP_BYTES);
  assert.deepEqual(backupRecords(parsed), backupRecords(backup));
  assert.deepEqual(parsed.parameters, backup.parameters);
  await store.importAccount(target.id, parsed, { replace: true });
  assert.deepEqual(backupRecords(await store.exportAccount(target.id)), backupRecords(backup));
  assert.throws(() => DailyStore.serializeBackup({ ...backup, version: 999 }), /Cadangan tidak valid/);
  store.close();
});

test('backup export rejects actual UTF-8 bytes over the same limit used by restore', () => {
  // A few thousand valid breakdown labels exercise the real 50 MiB limit
  // without creating hundreds of thousands of IndexedDB source rows.
  const count = 8500;
  const source = Object.fromEntries(Array.from({ length: count }, (_, i) => ['界'.repeat(2040) + i, 1]));
  const backup = {
    format: DailyStore.BACKUP_FORMAT, version: DailyStore.BACKUP_VERSION, database_version: 2,
    exported_at: '2026-09-07T00:00:00Z', account: { id: 1, kind: 'shopee', name: 'Unicode labels' },
    affiliate: [], ads: [], uploads: [],
    clicks: [{ account_id: 1, date: '2026-08-01', tag: 'sample', clicks: count,
      by_region: { Jakarta: count }, by_source: source, merge_version: 1 }],
    rowhashes: Array.from({ length: count }, (_, i) => ({ account_id: 1, kind: 'clicks',
      hash: i.toString(16).padStart(16, '0'), date: '2026-08-01' })),
  };
  const text = JSON.stringify(DailyStore.validateBackup(backup).data);
  assert.ok(text.length < DailyStore.MAX_BACKUP_BYTES, 'character count alone would wrongly permit this export');
  assert.ok(Buffer.byteLength(text, 'utf8') > DailyStore.MAX_BACKUP_BYTES);
  assert.throws(() => DailyStore.serializeBackup(backup), /melebihi batas 50 MiB/);
});

test('backup roundtrips quoted multiline ad names and click breakdown labels', async () => {
  const { store, account } = await context();
  const target = await store.ensureAccount('shopee', 'Multiline Restore');
  const ads = DashboardImport.parseText(Papa.unparse([ad('ad-1', '2026-08-01', { 'Ad name': 'Alpha\nPromotion\tOne' })]));
  const clicks = DashboardImport.parseText(Papa.unparse([{
    'Click Time': '2026-08-01 10:00:00', Tag_link: 'Alpha\nPromotion', Referrer: 'Facebook\nApp', 'Wilayah Klik': 'Jakarta\nTimur',
  }]));
  assert.equal(ads.ok, true);
  assert.equal(clicks.ok, true);
  await save(store, account, 'ads', ads.rows);
  await save(store, account, 'clicks', clicks.rows);
  const backup = await store.exportAccount(account.id);
  await store.importAccount(target.id, clone(backup), { replace: true });
  assert.deepEqual(backupRecords(await store.exportAccount(target.id)), backupRecords(backup));
  assert.equal((await store.range(target.id, 'clicks'))[0].by_source['Facebook\nApp'], 1);
  store.close();
});

test('corrupt schema, dates, numbers, revisions and mixed account rows never replace existing history', async () => {
  const { store, account } = await context();
  const backup = await seedBackup(store, account);
  const alterations = [
    data => { data.version = 999; },
    data => { delete data.format; },
    data => { data.database_version = 99; },
    data => { delete data.rowhashes; },
    data => { data.rowhashes.splice(0, 1); },
    data => { data.affiliate[0].comm = Infinity; },
    data => { data.ads[0].spend = null; },
    data => { data.clicks[0].clicks = '1'; },
    data => { data.affiliate[0].date = '2026-02-30'; },
    data => { data.exported_at = '2026-09-06T24:00:00Z'; },
    data => { data.affiliate[0].account_id = account.id + 1; },
    data => { data.uploads[0].account_id = account.id + 1; },
    data => { data.rowhashes[0].account_id = account.id + 1; },
    data => { data.rowhashes[0].date = '2026-08-30'; },
    data => { data.affiliate[0].order_keys = ['clear-private-order']; },
    data => { data.affiliate[0].merge_version = 9; },
    data => { data.affiliate[0].comm += 1; },
    data => { Object.values(data.affiliate[0].order_parts)[0][0] += 1; },
    data => { Object.values(data.affiliate[0].order_parts)[0][6] = 5; },
    data => { data.affiliate[0].order_parts = {}; },
    data => { data.affiliate[0].order_parts = { ['clear-order-id'.padEnd(16, 'x')]: [1, 1, 0, 1, 1, 0, 0, 1] }; },
    data => { data.affiliate[0].merge_version = 1; },
    data => { data.ads[0].ad_key = 'name:Other'; },
    data => { data.ads[0].ad_id = '123456789'; },
    data => { data.clicks[0].merge_version = 2; },
    data => { data.clicks[0].by_region.Jakarta = 999; },
    data => { data.uploads[0].period_end = '2026-07-01'; },
    data => { data.parameters.ppn = NaN; },
    data => { data.affiliate[0].polluted = true; },
    data => { data.account = JSON.parse('{"id":1,"name":"Unsafe","kind":"shopee","__proto__":{"polluted":true}}'); },
    data => { data.clicks[0].by_source = JSON.parse('{"__proto__":{"polluted":true}}'); },
  ];
  for (const alter of alterations) {
    const damaged = clone(backup);
    alter(damaged);
    await assert.rejects(store.importAccount(account.id, damaged, { replace: true }), /Cadangan tidak valid/);
    assert.deepEqual(backupRecords(await store.exportAccount(account.id)), backupRecords(backup));
  }
  assert.equal({}.polluted, undefined);
  store.close();
});

test('restore rejects duplicate IDs and conflicting logical keys while coalescing identical keys', async () => {
  const { store, account } = await context();
  const backup = await seedBackup(store, account);
  const ids = clone(backup);
  ids.affiliate[1].id = ids.affiliate[0].id;
  await assert.rejects(store.importAccount(account.id, ids, { replace: true }), /ID affiliate.*duplikat/);
  const conflict = clone(backup);
  conflict.ads.push({ ...conflict.ads[0], id: 999, spend: 456 });
  await assert.rejects(store.importAccount(account.id, conflict, { replace: true }), /kunci ads duplikat/);
  const same = clone(backup);
  same.ads.push({ ...same.ads[0], id: 999 });
  same.rowhashes.push({ ...same.rowhashes[0], id: 999 });
  assert.equal(DailyStore.validateBackup(same).summary.duplicates, 2);
  await store.importAccount(account.id, same, { replace: true });
  assert.deepEqual(backupRecords(await store.exportAccount(account.id)), backupRecords(backup));
  store.close();
});

test('storage failure after restore deletes and writes aborts the entire replacement', async () => {
  const { store, account } = await context();
  const target = await store.ensureAccount('shopee', 'Existing History');
  const backup = await seedBackup(store, account);
  await save(store, target, 'affiliate', [affiliate('prior', '2026-07-01')]);
  await save(store, target, 'clicks', [click('09:00:00', '2026-07-01')]);
  const before = backupRecords(await store.exportAccount(target.id));
  const originalAdd = IDBObjectStore.prototype.add;
  let failed = false;
  IDBObjectStore.prototype.add = function (value, ...args) {
    if (this.name === 'ads' && value.account_id === target.id) {
      failed = true;
      throw new Error('Synthetic quota failure');
    }
    return originalAdd.call(this, value, ...args);
  };
  try {
    await assert.rejects(store.importAccount(target.id, backup, { replace: true }), /Synthetic quota failure/);
  } finally { IDBObjectStore.prototype.add = originalAdd; }
  assert.equal(failed, true);
  assert.deepEqual(backupRecords(await store.exportAccount(target.id)), before);
  assert.deepEqual(backupRecords(await store.exportAccount(account.id)), backupRecords(backup));
  store.close();
});

test('new backups preserve migrated legacy history without enabling unsafe incremental merges', async () => {
  await seedV1();
  const store = await DailyStore.open(), target = await store.ensureAccount('shopee', 'Restored Legacy');
  const backup = await store.exportAccount(1);
  await store.importAccount(target.id, backup, { replace: true });
  assert.equal((await store.range(target.id, 'affiliate'))[0].orders, 1);
  assert.equal((await store.knownRowHashes(target.id, 'affiliate')).size, 1);
  await assert.rejects(save(store, target, 'affiliate', [affiliate('new-overlap')]), /Riwayat lama/);
  store.close();
});

test('direct and indirect commission is kept per order, and backups carry it', async () => {
  const E = require('./engine');
  for (const v of ['Pesanan Produk dari Toko yang Dipromosikan', 'Pesanan dari Toko yang tidak Dipromosikan',
    'Pesanan Langsung', 'Pesanan Tidak Langsung', 'Ordered in Same Shop', 'Different shop', 'Lainnya', '', null]) {
    assert.equal(A.attrKind(v), E.attrKind(v), 'daily store and engine agree on ' + v);
  }
  const T = 'Tipe Pesanan', direct = 'Pesanan Produk dari Toko yang Dipromosikan', indirect = 'Pesanan dari Toko yang tidak Dipromosikan';
  const [rec] = A.aggregateAffiliate([
    affiliate('o1', '2026-08-01', { [T]: direct }), affiliate('o1', '2026-08-01', { [T]: direct, 'ID Produk': 'x' }),
    affiliate('o2', '2026-08-01', { [T]: indirect }), affiliate('o3', '2026-08-01', { [T]: '?' }),
    affiliate('o4', '2026-08-01', { [T]: direct, 'Status Pesanan': 'Dibatalkan' })]);
  const byBits = Object.values(rec.order_parts).map(p => A.partAttr(p)).sort((x, y) => x.bits - y.bits);
  assert.deepEqual(byBits, [{ direct: 0, indirect: 0, unknown: 0, bits: 0 }, { direct: 400, indirect: 0, unknown: 0, bits: 1 },
    { direct: 0, indirect: 200, unknown: 0, bits: 2 }, { direct: 0, indirect: 0, unknown: 200, bits: 4 }]);
  assert.equal(rec.comm, 800, 'totals ignore the split');
  const [old] = A.aggregateAffiliate([affiliate('o1')]);
  assert.equal(A.partAttr(Object.values(old.order_parts)[0]), null, 'no column, no split');

  const { store, account } = await context();
  await save(store, account, 'affiliate', [affiliate('o1', '2026-08-01', { [T]: direct }), affiliate('o2', '2026-08-01', { [T]: indirect })]);
  const backup = await store.exportAccount(account.id);
  const other = await store.ensureAccount('shopee', 'Restored');
  await store.importAccount(other.id, backup, { replace: true });
  const [day] = await store.range(other.id, 'affiliate');
  assert.deepEqual(Object.values(day.order_parts).map(p => A.partAttr(p).bits).sort(), [1, 2]);
});

(async () => {
  let failures = 0;
  for (const { name, fn } of cases) {
    global.indexedDB = new IDBFactory();
    let timer;
    try {
      await Promise.race([Promise.resolve().then(fn), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('IndexedDB operation failed to settle within 5 seconds')), 5000);
      })]);
      console.log('PASS ' + name);
    } catch (error) {
      failures++;
      console.error('FAIL ' + name + '\n' + error.stack);
    } finally { clearTimeout(timer); }
  }
  console.log(`${cases.length - failures}/${cases.length} daily regressions passed`);
  if (failures) process.exitCode = 1;
})();
