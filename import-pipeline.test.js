'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Papa = require('papaparse');
const E = require('./engine');
const I = require('./import-pipeline');
const A = require('./daily-agg');

const aff = (changes = {}) => ({
  'ID Pemesanan': '001', 'Status Pesanan': 'Selesai', 'Waktu Pemesanan': '2026-08-01 12:34:56',
  'Waktu Klik': '2026-07-31 10:00:00', 'Total Komisi per Produk(Rp)': '1200.50',
  'Nilai Pembelian(Rp)': '20000', 'Jumlah Pengembalian Dana(Rp)': '0', 'Jumlah': '1', 'Tag_link1': 'sample',
  ...changes,
});
const ads = (changes = {}) => ({
  'Reporting starts': '2026-08-01', 'Reporting ends': '2026-08-01', 'Ad name': 'sample',
  'Amount spent (IDR)': '1000', 'Link clicks': '5', 'Impressions': '100', 'Reach': '90', 'Landing page views': '4', ...changes,
});
const csv = (rows, config = {}) => Papa.unparse(rows, { newline: '\n', ...config });
const parse = (rows, config) => I.parseText(csv(rows, config));
const hasIssue = (result, code) => result.issues.some(issue => issue.code === code);

test('normal affiliate report produces usable numbers, original IDs and period', () => {
  const r = parse([aff()]);
  assert.equal(r.ok, true);
  assert.equal(r.type, 'affiliate');
  assert.deepEqual(r.period, { start: '2026-08-01', end: '2026-08-01' });
  assert.equal(r.rows[0]['ID Pemesanan'], '001');
  assert.equal(r.rows[0]['Total Komisi per Produk(Rp)'], 1200.5);
  assert.equal(r.stats.warnings, 0);
});

test('normalized rows recognize exact prior-reader fingerprints without serializing raw source metadata', () => {
  const input = csv([aff({ 'Total Komisi per Produk(Rp)': ' 1200.50 ', 'Tag_link1': ' sample ' })]);
  const previous = Papa.parse(input, { header: true, skipEmptyLines: 'greedy', transformHeader: h => h.replace(/^\uFEFF/, '').trim() }).data[0];
  const row = I.parseText(input).rows[0];
  assert.notEqual(A.hashRow(row), A.hashRow(previous));
  assert.equal(A.dedupe([row], new Set([A.hashRow(previous)])).duplicates, 1);
  const variant = I.parseText(csv([aff()])).rows[0];
  assert.equal(A.dedupe([row, variant]).kept.length, 1);
  assert.equal(A.dedupe([row, variant], new Set([A.hashRow(previous)])).duplicates, 2);
  assert.equal(Object.getOwnPropertySymbols(row).length, 1);
  assert.equal(JSON.stringify(row).includes(' 1200.50 '), false);
  assert.deepEqual(JSON.parse(JSON.stringify(row)), { ...row });
});

test('BOM, case, whitespace and punctuation spacing in headers normalize', () => {
  const content = '\uFEFF\n  id   pemesanan , STATUS PESANAN , Waktu Pemesanan , Total Komisi per Produk (Rp) \n001,Selesai,2026-08-01,0';
  const r = I.parseText(content);
  assert.equal(r.ok, true);
  assert.equal(r.rows[0]['Total Komisi per Produk(Rp)'], 0);
  assert.equal(r.rows[0]['ID Pemesanan'], '001');
});

test('semicolon local decimals, currency groups and quoted multiline text', () => {
  const r = parse([aff({ 'Total Komisi per Produk(Rp)': 'Rp 1.234,50', 'Nilai Pembelian(Rp)': '20.000,25', 'Nama Barang': 'Produk; "utama"\nVarian kedua' })], { delimiter: ';' });
  assert.equal(r.ok, true);
  assert.equal(r.delimiter, ';');
  assert.equal(r.rows[0]['Total Komisi per Produk(Rp)'], 1234.5);
  assert.equal(r.rows[0]['Nilai Pembelian(Rp)'], 20000.25);
  assert.equal(r.rows[0]['Nama Barang'], 'Produk; "utama"\nVarian kedua');
});

test('tab reports and Click Time alias are accepted and date made canonical', () => {
  const r = parse([{ 'Click Time': '2026-08-02 01:02:03', 'Tag_link1': 'sample', Referrer: 'Facebook' }], { delimiter: '\t' });
  assert.equal(r.type, 'clicks');
  assert.equal(r.delimiter, '\t');
  assert.equal(r.rows[0]['Waktu Klik'], '2026-08-02 01:02:03');
  assert.equal(r.rows[0].Perujuk, 'Facebook');
  assert.equal(A.aggregateClicks(r.rows)[0].by_source.Facebook, 1);
});

test('Excel sep directive is parsed before header detection', () => {
  const r = I.parseText('sep=;\r\n' + csv([ads()], { delimiter: ';' }));
  assert.equal(r.ok, true);
  assert.equal(r.delimiter, ';');
});

test('click timestamps in an affiliate report never change its type', () => {
  const r = parse([aff({ 'Wilayah Klik': 'Indonesia', Tag_link: 'sample' })]);
  assert.equal(r.type, 'affiliate');
});

test('structural field count mismatch rejects the whole file atomically', () => {
  const r = I.parseText(csv([ads()]) + '\n2026-08-02,2026-08-02,broken');
  assert.equal(r.fatal, true);
  assert.equal(r.ok, false);
  assert.equal(r.rows.length, 0);
  assert.equal(r.stats.rejected, 2);
  assert.ok(hasIssue(r, 'column_count'));
});

test('unclosed quotes reject the entire file', () => {
  const r = I.parseText('Reporting starts,Ad name,Amount spent (IDR)\n2026-08-01,"broken,2');
  assert.equal(r.fatal, true);
  assert.ok(hasIssue(r, 'csv_structure'));
});

test('duplicate normalized headers cannot overwrite monetary cells', () => {
  const r = I.parseText('Reporting starts,Ad name,Amount spent (IDR), amount spent (idr)\n2026-08-01,one,100,200');
  assert.equal(r.fatal, true);
  assert.ok(hasIssue(r, 'duplicate_header'));
});

test('empty headers are structural errors', () => {
  const r = I.parseText('Reporting starts,Ad name,Amount spent (IDR),\n2026-08-01,one,100,');
  assert.equal(r.fatal, true);
  assert.ok(hasIssue(r, 'empty_header'));
});

test('missing essential columns and unsupported currency headers reject', () => {
  const missingStatus = aff(); delete missingStatus['Status Pesanan'];
  assert.ok(hasIssue(parse([missingStatus]), 'missing_column'));
  const usd = ads(); delete usd['Amount spent (IDR)']; usd['Amount spent (USD)'] = '100';
  assert.equal(parse([usd]).fatal, true);
});

test('unknown files and headers-only exports return actionable errors', () => {
  assert.ok(hasIssue(I.parseText('one,two\na,b'), 'unknown_report'));
  assert.ok(hasIssue(I.parseText(Object.keys(ads()).join(',')), 'no_rows'));
  assert.ok(hasIssue(I.parseText('  '), 'empty_file'));
});

test('invalid byte decoding and binary masquerading as CSV fail safely', () => {
  for (const content of ['abc\0def', 'abc\uFFFDdef']) {
    assert.ok(hasIssue(I.parseText(content), 'invalid_encoding'));
  }
});

test('malformed money rejects only the affected row with row/column/value evidence', () => {
  const r = parse([aff(), aff({ 'ID Pemesanan': '002', 'Total Komisi per Produk(Rp)': 'Rp 1oops' })]);
  assert.equal(r.ok, true);
  assert.equal(r.fatal, false);
  assert.equal(r.stats.accepted, 1);
  assert.equal(r.stats.rejected, 1);
  const problem = r.issues.find(issue => issue.code === 'invalid_number');
  assert.equal(problem.row, 3);
  assert.equal(problem.column, 'Total Komisi per Produk(Rp)');
  assert.equal(problem.value, 'Rp 1oops');
});

test('blank commission in an active order cannot silently become zero', () => {
  const r = parse([aff({ 'Total Komisi per Produk(Rp)': '' })]);
  assert.equal(r.stats.accepted, 0);
  assert.ok(hasIssue(r, 'missing_commission'));
});

test('zero commission and zero ad spend remain legitimate numeric zero', () => {
  const a = parse([aff({ 'Total Komisi per Produk(Rp)': '0,00' })]);
  const b = parse([ads({ 'Amount spent (IDR)': '0' })]);
  assert.equal(a.ok, true);
  assert.equal(a.rows[0]['Total Komisi per Produk(Rp)'], 0);
  assert.equal(b.rows[0]['Amount spent (IDR)'], 0);
});

test('cancelled and unpaid rows with missing amounts preserve exclusion semantics', () => {
  const r = parse([aff(), ...[' dibatalkan ', 'belum   dibayar'].map((status, i) => aff({ 'ID Pemesanan': String(i + 2), 'Status Pesanan': status, 'Total Komisi per Produk(Rp)': '-', 'Nilai Pembelian(Rp)': '' }))]);
  assert.equal(r.stats.accepted, 3);
  assert.equal(r.rows[1]['Status Pesanan'], 'Dibatalkan');
  assert.equal(r.rows[2]['Status Pesanan'], 'Belum Dibayar');
  const analyzed = E.analyze({ affiliate: r.rows, ads: [], clicks: [] });
  assert.equal(analyzed.kpi.orders, 1);
  assert.equal(analyzed.kpi.excluded.cancelled, 1);
  assert.equal(analyzed.kpi.excluded.unpaid, 1);
});

test('unknown order statuses fail rather than becoming paid commission', () => {
  const r = parse([aff({ 'Status Pesanan': 'Menunggu Pemeriksaan' })]);
  assert.equal(r.stats.accepted, 0);
  assert.ok(hasIssue(r, 'invalid_status'));
});

test('invalid dates, leap dates, and invalid timestamp hours are rejected', () => {
  for (const value of ['2026-02-29', '2026-13-01', '01/08/2026', '2026-08-01 24:00:00', '2026-08-01 10:60:00']) {
    assert.equal(parse([aff({ 'Waktu Pemesanan': value })]).stats.accepted, 0, value);
  }
  assert.equal(parse([aff({ 'Waktu Pemesanan': '2024-02-29 23:59:59' })]).stats.accepted, 1);
});

test('invalid attribution timestamp is surfaced instead of silently dropping lag evidence', () => {
  assert.ok(hasIssue(parse([aff({ 'Waktu Klik': 'bad date' })]), 'invalid_date'));
});

test('multi-day Meta export rejects all rows with a daily export instruction', () => {
  const r = parse([ads(), ads({ 'Reporting starts': '2026-08-02', 'Reporting ends': '2026-08-31' })]);
  assert.equal(r.fatal, true);
  assert.equal(r.stats.accepted, 0);
  assert.equal(r.stats.rejected, 2);
  assert.equal(r.period, null);
  assert.match(r.issues.find(issue => issue.code === 'non_daily_ads').message, /Time → Day/);
});

test('blank Meta end dates reject rows; absent end column warns about unverified grain', () => {
  assert.ok(hasIssue(parse([ads({ 'Reporting ends': '' })]), 'invalid_date'));
  const row = ads(); delete row['Reporting ends'];
  const r = parse([row]);
  assert.equal(r.ok, true);
  assert.ok(hasIssue(r, 'daily_grain_unverified'));
});

test('reported non-IDR currency rejects the affected ad row', () => {
  assert.ok(hasIssue(parse([ads({ Currency: 'USD' })]), 'unsupported_currency'));
});

test('negative spend, fractional clicks and non-numeric optional cells fail', () => {
  for (const changes of [{ 'Amount spent (IDR)': '-100' }, { 'Link clicks': '1.5' }, { Reach: 'unknown' }, { Impressions: '=SUM(A1:A2)' }]) {
    assert.equal(parse([ads(changes)]).stats.accepted, 0);
  }
});

test('missing optional counters are visible warnings', () => {
  const r = parse([ads({ 'Link clicks': '—' })]);
  assert.equal(r.ok, true);
  assert.ok(hasIssue(r, 'empty_optional_number'));
});

test('numeric validation rejects junk, infinity, unsafe and badly grouped values', () => {
  for (const input of ['12O00', 'NaN', 'Infinity', '1e999', '9007199254740992', '1,23,456', '1.2.3', '--2', '12 USD', 'Rp 12foo', '=100', '1 23']) assert.equal(I.strictNumber(input).valid, false, input);
});

test('valid decimal/local/grouped/scientific/negative money is preserved', () => {
  for (const [input, expected] of [['0', 0], ['0.001', 0.001], ['0,05', 0.05], ['1,234.56', 1234.56], ['1.234,56', 1234.56], ['Rp1.234', 1234], ['1.234.567', 1234567], ['1 234,50', 1234.5], ['(Rp 1.000,50)', -1000.5], ['1e3', 1000]]) {
    const r = I.strictNumber(input);
    assert.equal(r.valid, true, input);
    assert.equal(r.value, expected, input);
  }
});

test('ambiguous single numeric grouping produces a warning with interpreted value', () => {
  const r = parse([aff({ 'Total Komisi per Produk(Rp)': '1,234' })]);
  assert.equal(r.rows[0]['Total Komisi per Produk(Rp)'], 1234);
  assert.ok(hasIssue(r, 'ambiguous_number'));
});

test('prototype-like extra headers remain plain row data', () => {
  const row = aff(); Object.defineProperty(row, '__proto__', { value: 'source', enumerable: true });
  const r = parse([row]);
  assert.equal(r.ok, true);
  assert.equal(Object.getPrototypeOf(r.rows[0]), Object.prototype);
  assert.equal(r.rows[0].__proto__, 'source');
});

test('period covers accepted rows only and large diagnostics stay bounded', () => {
  const r = parse([aff(), ...Array.from({ length: 250 }, (_, i) => aff({ 'ID Pemesanan': String(i + 2), 'Waktu Pemesanan': '2026-08-31', 'Total Komisi per Produk(Rp)': 'oops' }))]);
  assert.equal(r.stats.accepted, 1);
  assert.equal(r.stats.rejected, 250);
  assert.equal(r.period.end, '2026-08-01');
  assert.ok(r.issues.length <= 201);
  assert.ok(hasIssue(r, 'issues_truncated'));
});
