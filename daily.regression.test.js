'use strict';

// Synthetic fixtures exercise actual IndexedDB transactions and the v1 schema.
// No personal reports, local browser profiles, network, or running server needed.
const assert = require('node:assert/strict');
const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');
const A = require('./daily-agg');
const DailyStore = require('./daily-store');
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

test('overlapping uploads add unseen amounts instead of replacing a partial day', async () => {
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
  assert.equal((await store.knownRowHashes(account.id, 'affiliate')).size, 2);
  store.close();
});

test('same order spanning uploads and multiple products counts as one order', async () => {
  const { store, account } = await context();
  await save(store, account, 'affiliate', [affiliate()]);
  await save(store, account, 'affiliate', [affiliate('order-1', '2026-08-01', { 'ID Produk': 'different-product' })]);
  const [day] = await store.range(account.id, 'affiliate');
  assert.equal(day.comm, 400);
  assert.equal(day.rows, 2);
  assert.equal(day.orders, 1);
  assert.deepEqual(day.order_keys, [A.hashRow({ orderId: 'order-1' })]);
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
  assert.equal((await one.knownRowHashes(account.id, 'affiliate')).size, 2);
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
  assert.equal((await store.knownRowHashes(account.id, 'affiliate')).size, 1);
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
  assert.equal(store.db.version, 2);
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
  assert.equal(day.merge_version, 1);
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
  assert.equal((await store.knownRowHashes(account.id, 'affiliate')).size, 1);
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
  const dump = Object.fromEntries(await Promise.all(['affiliate', 'rowhashes'].map(async kind => [kind, await contents(store, kind)])));
  const serialized = JSON.stringify(dump);
  assert.doesNotMatch(serialized, /private-order|Private Person|Nama Pelanggan|rawRows|ID Pemesanan/);
  assert.equal(dump.rowhashes[0].date, '2026-08-01');
  const exported = await store.exportAccount(account.id);
  assert.equal(exported.account.id, account.id);
  assert.equal(exported.affiliate.length, 1);
  assert.equal(exported.uploads.length, 1);
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
