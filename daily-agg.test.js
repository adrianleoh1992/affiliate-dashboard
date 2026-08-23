/* Verify daily aggregation against the real CSVs, with the duplicate scenarios
   that silently doubled ROAS in the current dashboard. */
const fs = require('fs');
const assert = require('assert');
const A = require('./daily-agg.js');

function parseCSV(t) {
  const rows = []; let row = [], cell = '', q = false;
  if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i+1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const h = rows.shift().map(x => x.trim());
  return rows.filter(r => r.length > 1).map(r => { const o = {}; h.forEach((k, i) => o[k] = (r[i] || '').trim()); return o; });
}

const D = '/Users/hadipradata/Downloads/';
const aff = parseCSV(fs.readFileSync(D + 'AffiliateCommissionReport_202608222201.csv', 'utf8'));
const ads = parseCSV(fs.readFileSync(D + 'AW-Adrian-Ads-Jul-23-2026-Aug-21-2026.csv', 'utf8'));
const clk = parseCSV(fs.readFileSync(D + 'WebsiteClickReport202608222201.csv', 'utf8'));
const rp = n => 'Rp' + Math.round(n).toLocaleString('id-ID');

console.log('=== SUMBER ===');
console.log(`  affiliate ${aff.length.toLocaleString('id-ID')} baris · ads ${ads.length} · klik ${clk.length.toLocaleString('id-ID')}`);

/* 1. Dedup must not touch legitimate rows */
const d1 = A.dedupe(aff);
console.log('\n=== DEDUP FILE ASLI ===');
console.log(`  ${d1.total.toLocaleString('id-ID')} baris → ${d1.kept.length.toLocaleString('id-ID')} unik, ${d1.duplicates} duplikat`);
assert.equal(d1.duplicates, 0, 'file asli tidak boleh punya duplikat sejati');
assert.equal(d1.kept.length, aff.length, 'tidak boleh ada baris sah yang hilang');

/* 2. Same file twice → every extra row rejected */
const d2 = A.dedupe(aff.concat(aff));
console.log('\n=== FILE SAMA DIUNGGAH 2x ===');
console.log(`  ${(aff.length * 2).toLocaleString('id-ID')} baris masuk → ${d2.kept.length.toLocaleString('id-ID')} diterima, ${d2.duplicates.toLocaleString('id-ID')} ditolak`);
assert.equal(d2.kept.length, aff.length, 'unggah ganda harus disaring habis');
assert.equal(d2.duplicates, aff.length);

/* 3. Partial overlap — the realistic daily case */
const overlap = aff.concat(aff.slice(Math.floor(aff.length * 0.7)));
const d3 = A.dedupe(overlap);
const expectedNew = aff.length;
console.log('\n=== TUMPANG TINDIH 30% ===');
console.log(`  ${overlap.length.toLocaleString('id-ID')} baris masuk → ${d3.kept.length.toLocaleString('id-ID')} diterima, ${d3.duplicates.toLocaleString('id-ID')} ditolak`);
assert.equal(d3.kept.length, expectedNew, 'hanya baris benar-benar baru yang lolos');

/* 4. Money must be identical before and after a duplicate upload */
const agg1 = A.aggregateAffiliate(d1.kept);
const agg2 = A.aggregateAffiliate(d2.kept);
const sum = (a, f) => a.reduce((s, r) => s + r[f], 0);
console.log('\n=== NILAI SETELAH DEDUP ===');
console.log(`  komisi bersih   ${rp(sum(agg1, 'comm'))}`);
console.log(`  komisi 2x file  ${rp(sum(agg2, 'comm'))}`);
assert.equal(Math.round(sum(agg1, 'comm')), Math.round(sum(agg2, 'comm')), 'komisi tidak boleh menggandakan');
assert.equal(sum(agg1, 'orders'), sum(agg2, 'orders'), 'order tidak boleh menggandakan');

/* 5. Aggregation must preserve the totals the dashboard already reports */
const EXCLUDED = new Set(['Dibatalkan', 'Belum Dibayar']);
const totalComm = aff.filter(r => !EXCLUDED.has(r['Status Pesanan']))
  .reduce((s, r) => s + A.num(r['Total Komisi per Produk(Rp)']), 0);
console.log('\n=== AGREGASI HARIAN (affiliate) ===');
console.log(`  ${agg1.length} baris (tanggal x tag) dari ${aff.length.toLocaleString('id-ID')} transaksi`);
console.log(`  komisi agregat ${rp(sum(agg1, 'comm'))} vs hitung langsung ${rp(totalComm)}`);
assert.ok(Math.abs(sum(agg1, 'comm') - totalComm) < 1, 'agregasi harus mempertahankan total komisi');
const days = new Set(agg1.map(r => r.date));
console.log(`  ${days.size} hari · ${new Set(agg1.map(r => r.tag)).size} tag`);
console.log(`  kompresi: ${(aff.length / agg1.length).toFixed(1)}x lebih sedikit baris`);

/* 5b. The daily store must agree with the dashboard engine, or the decision
   screen and the stored history will quietly diverge. */
const E = require('./engine.js');
const eng = E.analyze({ affiliate: aff, ads, clicks: clk, tagMap: {} }, { ppn: 11 });
const storedOrders = sum(agg1, 'orders');
const storedComm = Math.round(sum(agg1, 'comm'));
console.log('\n=== KECOCOKAN DENGAN ENGINE DASHBOARD ===');
console.log(`  komisi  engine ${rp(eng.kpi.comm)} · store ${rp(storedComm)}`);
console.log(`  order   engine ${eng.kpi.orders.toLocaleString('id-ID')} · store ${storedOrders.toLocaleString('id-ID')}`);
assert.equal(storedComm, Math.round(eng.kpi.comm), 'komisi store harus sama dengan engine');
assert.equal(storedOrders, eng.kpi.orders, 'jumlah order store harus sama dengan engine');
console.log('  cocok: YA');

/* 6. Ads */
const aggAds = A.aggregateAds(ads);
const adSpend = ads.reduce((s, r) => s + A.num(r['Amount spent (IDR)']), 0);
console.log('\n=== AGREGASI HARIAN (ads) ===');
console.log(`  ${aggAds.length} baris (tanggal x ad unit) dari ${ads.length}`);
console.log(`  spend agregat ${rp(sum(aggAds, 'spend'))} vs langsung ${rp(adSpend)}`);
assert.ok(Math.abs(sum(aggAds, 'spend') - adSpend) < 1, 'spend harus terjaga');
const dupAds = A.dedupe(ads.concat(ads));
assert.equal(dupAds.kept.length, ads.length, 'ads ganda harus disaring');
console.log(`  ads diunggah 2x → ${dupAds.duplicates} ditolak, spend tetap`);

/* 7. Clicks */
const aggClk = A.aggregateClicks(clk);
console.log('\n=== AGREGASI HARIAN (klik) ===');
console.log(`  ${aggClk.length} baris (tanggal x tag) dari ${clk.length.toLocaleString('id-ID')} klik`);
assert.equal(sum(aggClk, 'clicks'), clk.filter(r => A.isDate(A.day(r['Waktu Klik']))).length, 'jumlah klik harus terjaga');
console.log(`  kompresi: ${(clk.length / aggClk.length).toFixed(1)}x lebih sedikit baris`);

/* 8. Ingest plan — what the user is told before anything is written */
const keys = new Set(agg1.slice(0, 200).map(r => `${r.date}|${r.tag}`));
const plan = A.planIngest(agg1, keys, ['date', 'tag']);
console.log('\n=== RENCANA SIMPAN ===');
console.log(`  ${plan.newCount} baris baru · ${plan.updateCount} diperbarui · ${plan.days} hari`);
console.log(`  periode ${plan.period.start} — ${plan.period.end}`);
assert.equal(plan.updateCount, 200, 'baris yang sudah ada harus dikenali');
assert.equal(plan.newCount, agg1.length - 200);

/* 9. Storage footprint */
const bytes = JSON.stringify({ affiliate: agg1, ads: aggAds, clicks: aggClk }).length;
console.log('\n=== UKURAN SIMPAN ===');
console.log(`  ${(bytes / 1024).toFixed(1)}KB untuk 30 hari`);
console.log(`  proyeksi 1 tahun ≈ ${(bytes / 1024 * 12 / 1024).toFixed(1)}MB per akun`);
const raw = JSON.stringify({ aff, ads, clk }).length;
console.log(`  CSV mentah ${(raw / 1024 / 1024).toFixed(1)}MB → agregat ${(raw / bytes).toFixed(0)}x lebih kecil`);

/* 10. Hash stability — key order must not matter */
const r1 = { a: '1', b: '2', c: '3' };
const r2 = { c: '3', a: '1', b: '2' };
assert.equal(A.hashRow(r1), A.hashRow(r2), 'urutan kolom tidak boleh mengubah hash');
assert.notEqual(A.hashRow(r1), A.hashRow({ a: '1', b: '2', c: '4' }), 'nilai beda harus beda hash');

console.log('\ndaily-agg tests: PASS');
