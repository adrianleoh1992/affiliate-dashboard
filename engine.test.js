const assert = require('assert');
const E = require('./engine.js');

// File detection must distinguish the click report from the affiliate report.
assert.equal(E.detectFileType(['Klik ID','Waktu Klik','Wilayah Klik','Tag_link','Perujuk']), 'clicks');
assert.equal(E.detectFileType(['ID Pemesanan','Status Pesanan','Waktu Pemesanan','Tag_link1']), 'affiliate');
assert.equal(E.detectFileType(['Reporting starts','Ad name','Amount spent (IDR)']), 'ads');

// Unknown names must not be silently attached through arbitrary 5-char overlap.
// "solid" alone must never be TRUSTED as HelmRsixSolid. It may surface as a
// candidate, but only flagged Lemah/Tidak cocok so the UI sends it for review.
const m = E.matchAdToTag('produk baru solid', ['HelmRsixSolid','produk lama'], {});
assert.ok(m.method === 'Lemah' || m.method === 'Tidak cocok', 'weak match must be flagged, got ' + m.method);
assert.ok(m.confidence < 0.5, 'weak match must carry low confidence, got ' + m.confidence);

// A genuine name must still resolve cleanly.
const m2 = E.matchAdToTag('Helm Rsix Solid', ['HelmRsixSolid','produk lama'], {});
assert.equal(m2.tag, 'HelmRsixSolid');
assert.ok(m2.confidence >= 0.9, 'expected strong match, got ' + m2.confidence);

// Manual map always wins.
const m3 = E.matchAdToTag('Telesin video 2', ['TelesinGripvideo2'], { 'telesinvideo2':'TelesinGripvideo2' });
assert.equal(m3.tag, 'TelesinGripvideo2');
assert.equal(m3.method, 'Manual');

const data = {
  affiliate: [
    { 'ID Pemesanan':'1', 'Status Pesanan':'Selesai', 'Waktu Pemesanan':'2026-08-01 10:00:00', 'Waktu Klik':'2026-08-01 09:00:00', 'Total Komisi per Pesanan(Rp)':'180', 'Tag_link1':'A', 'Jumlah':'1', 'Nilai Pembelian(Rp)':'1000' },
    { 'ID Pemesanan':'2', 'Status Pesanan':'Tertunda', 'Waktu Pemesanan':'2026-08-01 12:00:00', 'Waktu Klik':'2026-08-01 09:00:00', 'Total Komisi per Pesanan(Rp)':'100', 'Tag_link1':'A', 'Jumlah':'1', 'Nilai Pembelian(Rp)':'1000' },
  ],
  ads: [
    { 'Reporting starts':'2026-08-01', 'Ad name':'A', 'Amount spent (IDR)':'100', 'Link clicks':'10', 'Impressions':'1000' },
    { 'Reporting starts':'2026-08-02', 'Ad name':'A', 'Amount spent (IDR)':'100', 'Link clicks':'10', 'Impressions':'1000' },
    { 'Reporting starts':'2026-08-03', 'Ad name':'A', 'Amount spent (IDR)':'100', 'Link clicks':'10', 'Impressions':'1000' },
    { 'Reporting starts':'2026-08-04', 'Ad name':'A', 'Amount spent (IDR)':'100', 'Link clicks':'10', 'Impressions':'1000' },
  ],
  clicks: [
    { 'Waktu Klik':'2026-08-01 09:00:00', 'Tag_link':'A----' },
    { 'Waktu Klik':'2026-08-02 09:00:00', 'Tag_link':'A----' },
  ],
  tagMap: {},
};
const r = E.analyze(data, { ppn:0, minSpend:0, minDays:1, lagDays:3, streakDays:3 });
const a = r.tags.find(x => x.tag === 'A');
assert.equal(a.commEff, 275); // 180 + 100*0.95
assert.equal(a.leak.shopeeClicks, 2);
assert.equal(a.leak.metaClicks, 20); // click-report overlap is Aug 1-2
assert.equal(a.leak.failed, 18);
// Aggregate ROAS is 275/400 = 0.69x, so STOP is correct here.
assert.equal(a.status, 'stop');
// But it must come from the aggregate, NOT from a streak built on immature days:
// Aug 3-4 sit inside the 3-day lag window and must be excluded from the streak.
assert.ok(a.streak < 3, 'immature days must not feed the streak, got ' + a.streak);
assert.ok(!/berturut/.test(a.reason), 'verdict must not cite a streak: ' + a.reason);
assert.equal(r.range.matureUntil, '2026-08-01');
assert.equal(r.kpi.orders, 2);

// Same data, lag disabled: now the late days count and the streak fires.
const r2 = E.analyze(data, { ppn:0, minSpend:0, minDays:1, lagDays:0, streakDays:3 });
const a2 = r2.tags.find(x => x.tag === 'A');
assert.ok(a2.streak >= 3, 'without lag the streak should fire, got ' + a2.streak);
assert.equal(a2.status, 'stop');
// Leakage is severe here, so the reason is overridden to point at the link
// rather than the creative — that override must win over the streak text.
assert.ok(/cek link/.test(a2.reason), 'expected leak override, got ' + a2.reason);
console.log('engine tests: PASS');
