const assert = require('assert');
const E = require('./engine.js');

/* ── File detection ─────────────────────────────────────────────────────── */
assert.equal(E.detectFileType(['Klik ID','Waktu Klik','Wilayah Klik','Tag_link','Perujuk']), 'clicks');
assert.equal(E.detectFileType(['ID Pemesanan','Status Pesanan','Waktu Pemesanan','Tag_link1']), 'affiliate');
assert.equal(E.detectFileType(['Reporting starts','Ad name','Amount spent (IDR)']), 'ads');

/* ── Matching ───────────────────────────────────────────────────────────── */
// "solid" alone must never be TRUSTED as HelmRsixSolid. It may surface as a
// candidate, but only flagged Lemah/Tidak cocok so the UI sends it for review.
const m = E.matchAdToTag('produk baru solid', ['HelmRsixSolid','produk lama'], {});
assert.ok(m.method === 'Lemah' || m.method === 'Tidak cocok', 'weak match must be flagged, got ' + m.method);
assert.ok(m.confidence < 0.5, 'weak match must carry low confidence, got ' + m.confidence);

const m2 = E.matchAdToTag('Helm Rsix Solid', ['HelmRsixSolid','produk lama'], {});
assert.equal(m2.tag, 'HelmRsixSolid');
assert.ok(m2.confidence >= 0.9, 'expected strong match, got ' + m2.confidence);

const m3 = E.matchAdToTag('Telesin video 2', ['TelesinGripvideo2'], { 'telesinvideo2':'TelesinGripvideo2' });
assert.equal(m3.tag, 'TelesinGripvideo2');
assert.equal(m3.method, 'Manual');

/* ── Fixture ────────────────────────────────────────────────────────────── */
const data = {
  affiliate: [
    { 'ID Pemesanan':'1', 'Status Pesanan':'Selesai', 'Waktu Pemesanan':'2026-08-01 10:00:00', 'Waktu Klik':'2026-08-01 09:00:00', 'Total Komisi per Pesanan(Rp)':'180', 'Tag_link1':'A', 'Jumlah':'1', 'Nilai Pembelian(Rp)':'1000', 'Platform':'Facebook', 'Nama Toko':'Toko X', 'L1 Kategori Global':'Elektronik', 'Nama Barange':'Produk A' },
    { 'ID Pemesanan':'2', 'Status Pesanan':'Tertunda', 'Waktu Pemesanan':'2026-08-01 12:00:00', 'Waktu Klik':'2026-08-01 09:00:00', 'Total Komisi per Pesanan(Rp)':'100', 'Tag_link1':'A', 'Jumlah':'1', 'Nilai Pembelian(Rp)':'1000', 'Platform':'Instagram', 'Nama Toko':'Toko X', 'L1 Kategori Global':'Elektronik', 'Nama Barange':'Produk A' },
    { 'ID Pemesanan':'3', 'Status Pesanan':'Dibatalkan', 'Waktu Pemesanan':'2026-08-01 13:00:00', 'Waktu Klik':'2026-08-01 09:00:00', 'Total Komisi per Pesanan(Rp)':'500', 'Tag_link1':'A', 'Jumlah':'1', 'Nilai Pembelian(Rp)':'5000' },
  ],
  ads: [
    { 'Reporting starts':'2026-08-01', 'Ad name':'A', 'Amount spent (IDR)':'100', 'Link clicks':'10', 'Impressions':'1000', 'Reach':'800', 'Landing page views':'8', 'Ad delivery':'active', 'Quality ranking':'Average' },
    { 'Reporting starts':'2026-08-02', 'Ad name':'A', 'Amount spent (IDR)':'100', 'Link clicks':'10', 'Impressions':'1000', 'Reach':'800', 'Landing page views':'8', 'Ad delivery':'active' },
    { 'Reporting starts':'2026-08-03', 'Ad name':'A', 'Amount spent (IDR)':'100', 'Link clicks':'10', 'Impressions':'1000', 'Reach':'800', 'Landing page views':'8', 'Ad delivery':'active' },
    { 'Reporting starts':'2026-08-04', 'Ad name':'A', 'Amount spent (IDR)':'100', 'Link clicks':'10', 'Impressions':'1000', 'Reach':'800', 'Landing page views':'8', 'Ad delivery':'active' },
  ],
  clicks: [
    { 'Waktu Klik':'2026-08-01 09:00:00', 'Tag_link':'A----', 'Perujuk':'Websites', 'Wilayah Klik':'Indonesia' },
    { 'Waktu Klik':'2026-08-02 09:00:00', 'Tag_link':'A----', 'Perujuk':'Websites', 'Wilayah Klik':'Indonesia' },
  ],
  tagMap: {},
};

const r = E.analyze(data, { ppn:0, minSpend:0, minDays:1, lagDays:3, streakDays:3 });
const a = r.tags.find(x => x.tag === 'A');

/* Pending weighting + cancelled exclusion */
assert.equal(a.commEff, 275);                 // 180 + 100*0.95
assert.equal(a.comm, 280);                    // cancelled 500 excluded
assert.equal(r.kpi.excluded.cancelled, 1);
assert.equal(a.orders, 2);

/* Full Meta metric surface */
assert.equal(a.impr, 4000);
assert.equal(a.reach, 3200);
assert.equal(a.lpv, 32);
assert.equal(a.clicks, 40);
assert.equal(a.cpm, 100);                     // 400 spend / 4000 impr * 1000
assert.equal(a.ctr, 1);                       // 40/4000
assert.equal(a.freq, 1.25);                   // 4000/3200
assert.equal(a.lpvRate, 80);
assert.equal(a.delivery, 'active');

/* Leakage measured only on the click-report overlap (Aug 1-2) */
assert.equal(a.leak.metaClicks, 20);
assert.equal(a.leak.shopeeClicks, 2);
assert.equal(a.leak.failed, 18);
assert.equal(a.leak.severity, 'bad');

/* Verdict: aggregate ROAS 275/400 = 0.69x -> STOP, but NOT via a streak built
   on immature days. Aug 2-4 sit inside the 3-day lag window. */
assert.equal(a.status, 'stop');
assert.ok(a.streak < 3, 'immature days must not feed the streak, got ' + a.streak);
assert.equal(r.range.matureUntil, '2026-08-01');
assert.ok(/cek link/.test(a.reason), 'severe leak should redirect the reason: ' + a.reason);

/* Same data, lag disabled: late days count and the streak fires */
const r2 = E.analyze(data, { ppn:0, minSpend:0, minDays:1, lagDays:0, streakDays:3 });
const a2 = r2.tags.find(x => x.tag === 'A');
assert.ok(a2.streak >= 3, 'without lag the streak should fire, got ' + a2.streak);

/* Ad-unit grain */
assert.equal(r.adUnits.length, 1);
assert.equal(r.adUnits[0].adName, 'A');
assert.equal(r.adUnits[0].active, true);

/* Breakdowns actually populated */
assert.ok(r.breakdown.platform.length >= 2, 'platform split expected');
assert.ok(r.breakdown.shop.length >= 1, 'shop split expected');
assert.ok(r.breakdown.clickSource.length >= 1, 'click source expected');
assert.ok(r.breakdown.hourly.some(h => h.comm > 0), 'hourly split expected');
assert.ok(r.lagProfile.length >= 1, 'lag profile expected');

/* PPN actually applied */
const r3 = E.analyze(data, { ppn:11, minSpend:0, minDays:1 });
const a3 = r3.tags.find(x => x.tag === 'A');
assert.ok(Math.abs(a3.spend - 444) < 0.01, 'PPN 11% should give 444, got ' + a3.spend);

/* ── Snapshot + per-account trend ───────────────────────────────────────── */
const s1 = E.toSnapshot(r, { account:'akun-a', saved:'2026-08-05 08:00:00' });
assert.equal(s1.account, 'akun-a');
assert.ok(s1.tags.length >= 1);

const s2 = JSON.parse(JSON.stringify(s1));
s2.id = 2; s2.saved = '2026-08-12 08:00:00';
s2.range = { start:'2026-08-05', end:'2026-08-11' };
s2.kpi.netEff = s1.kpi.netEff + 1000;
s2.kpi.roasEff = 2.4;
s2.tags[0].roasEff = 2.4; s2.tags[0].status = 'scale';

const other = JSON.parse(JSON.stringify(s1));
other.id = 3; other.account = 'akun-b';

const tr = E.buildTrend([s1, s2, other], 'akun-a');
assert.equal(tr.series.length, 2, 'other account must be excluded, got ' + tr.series.length);
assert.equal(tr.delta.netEff, 1000);
assert.ok(tr.movers.length >= 1);
assert.equal(tr.movers[0].changed, true, 'status change should be detected');
assert.equal(tr.movers[0].toStatus, 'scale');

/* Re-saving the same period must not double-plot */
const dupe = JSON.parse(JSON.stringify(s2));
dupe.id = 4; dupe.saved = '2026-08-12 20:00:00';
assert.equal(E.buildTrend([s1, s2, dupe], 'akun-a').series.length, 2, 'same period must dedupe');

/* ── Lag calibration: derived from data, not from the default ───────────── */
assert.ok(r.lagCal, 'lagCal must exist');
assert.equal(r.lagCal.current, 3);
assert.ok(r.lagCal.suggested >= 0, 'suggested lag must be a day index');
assert.equal(typeof r.lagCal.matches, 'boolean');
assert.ok(r.lagCal.sampleSize > 0, 'calibration needs a sample');

/* ── Actions: verdicts converted into money ─────────────────────────────── */
assert.ok(r.actions, 'actions must exist');
assert.equal(typeof r.actions.bidSaving, 'number');
assert.ok(r.actions.reclaimable >= 0);
assert.ok(Array.isArray(r.actions.organicCandidates));
// The fixture's only tag is paid, so there is no organic candidate.
assert.equal(r.actions.organicCandidates.length, 0);
assert.ok(r.actions.concentration, 'concentration must be computed when paid tags exist');
assert.equal(r.actions.concentration.topTag, 'A');
assert.equal(Math.round(r.actions.concentration.topShare), 100);

/* An organic tag should surface as an ad candidate with a max bid */
const withOrganic = JSON.parse(JSON.stringify(data));
withOrganic.affiliate.push({
  'ID Pemesanan':'9', 'Status Pesanan':'Selesai', 'Waktu Pemesanan':'2026-08-01 11:00:00',
  'Waktu Klik':'2026-08-01 09:00:00', 'Total Komisi per Pesanan(Rp)':'900',
  'Tag_link1':'ORG', 'Jumlah':'1', 'Nilai Pembelian(Rp)':'9000', 'Platform':'Instagram',
});
const rOrg = E.analyze(withOrganic, { ppn:0, minSpend:0, minDays:1, targetROI:80 });
const cand = rOrg.actions.organicCandidates.find(c => c.tag === 'ORG');
assert.ok(cand, 'organic tag must become a candidate');
assert.equal(Math.round(cand.maxCpc), 500); // 900 per order / 1.8

/* ── Stability: which verdicts survive every plausible lag ──────────────── */
const st = E.stability(data, { ppn:0, minSpend:0, minDays:1 }, [0, 3, 7]);
assert.equal(st.probes.length, 3);
assert.equal(st.total, 1, 'one paid tag in the fixture');
const sTag = st.tags[0];
assert.equal(sTag.tag, 'A');
assert.ok(sTag.confidence > 0 && sTag.confidence <= 1);
assert.ok(typeof sTag.stable === 'boolean');
assert.equal(sTag.byLag.length, 3, 'one entry per probe');
assert.equal(st.counts.length, 3);

console.log('engine tests: PASS');
