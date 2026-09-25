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

/* Verdict: mature ROAS is 275/100 = 2.75x. Aug 2-4 sit inside the
   3-day lag window and must not turn this profitable mature tag into STOP. */
assert.equal(a.status, 'scale');
assert.equal(a.matureRoasEff, 2.75);
assert.ok(a.streak < 3, 'immature days must not feed the streak, got ' + a.streak);
assert.equal(r.range.matureUntil, '2026-08-01');

/* Same data, lag disabled: late days count and the streak fires */
const r2 = E.analyze(data, { ppn:0, minSpend:0, minDays:1, lagDays:0, streakDays:3 });
const a2 = r2.tags.find(x => x.tag === 'A');
assert.ok(a2.streak >= 3, 'without lag the streak should fire, got ' + a2.streak);
assert.ok(/cek link/.test(a2.reason), 'severe leak should redirect the STOP reason: ' + a2.reason);

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
s2.tags[0].roasEff = 2.4; s2.tags[0].status = 'pantau';

const other = JSON.parse(JSON.stringify(s1));
other.id = 3; other.account = 'akun-b';

const tr = E.buildTrend([s1, s2, other], 'akun-a');
assert.equal(tr.series.length, 2, 'other account must be excluded, got ' + tr.series.length);
assert.equal(tr.delta.netEff, 1000);
assert.ok(tr.movers.length >= 1);
assert.equal(tr.movers[0].changed, true, 'status change should be detected');
assert.equal(tr.movers[0].toStatus, 'pantau');

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

/* An organic tag should surface with a cost-per-order ceiling */
const withOrganic = JSON.parse(JSON.stringify(data));
withOrganic.affiliate.push({
  'ID Pemesanan':'9', 'Status Pesanan':'Selesai', 'Waktu Pemesanan':'2026-08-01 11:00:00',
  'Waktu Klik':'2026-08-01 09:00:00', 'Total Komisi per Pesanan(Rp)':'900',
  'Tag_link1':'ORG', 'Jumlah':'1', 'Nilai Pembelian(Rp)':'9000', 'Platform':'Instagram',
});
const rOrg = E.analyze(withOrganic, { ppn:0, minSpend:0, minDays:1, targetROI:80 });
const cand = rOrg.actions.organicCandidates.find(c => c.tag === 'ORG');
assert.ok(cand, 'organic tag must become a candidate');
assert.equal(Math.round(cand.maxCpa), 500); // 900 per order / 1.8

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

/* ── Ad name → tag: the number is the identity ──────────────────────────────
   Three creatives named "Telesin Video 1/2/3" all tokenised to the same two
   words, because the tokenizer drops anything under three characters. Every
   one of them then matched TelesinGripvideo2 at full confidence, merging three
   ads' spend onto one tag. These lock the number rule in place. */
const TAGS = ['TelesinGripvideo2', 'OlymplastLemari', 'HelmRsixSolid',
  'Spinningreelokuma', 'minilayarportable', 'seeouokacamatapolarized'];

const v2 = E.matchAdToTag('Telesin video 2', TAGS, {});
assert.equal(v2.tag, 'TelesinGripvideo2', 'matching number still connects');
assert.ok(v2.confidence < 1, 'a forgiving match is shown as such, never as certain');
for (const n of ['Telesin Video 1', 'Telesin Video 3']) {
  const m = E.matchAdToTag(n, TAGS, {});
  assert.notEqual(m.tag, 'TelesinGripvideo2', n + ' must not land on video 2');
  assert.notEqual(m.candidateTag, 'TelesinGripvideo2', n + ' must not even be suggested for video 2');
  assert.equal(m.confidence, 0, n + ' has no tag here, and must say so');
}
// A number on one side only carries no information, so it must not block.
assert.equal(E.matchAdToTag('Mini Layar portable', TAGS, {}).tag, 'minilayarportable');
assert.equal(E.matchAdToTag('HelmRsixSolid', TAGS, {}).confidence, 1);

// A manual mapping is authoritative on an exact key, and only on that key:
// a near key for a different creative number must not leak onto it.
assert.equal(E.matchAdToTag('Telesin Video 1', TAGS,
  { 'telesinvideo1': 'TelesinGripvideo2' }).tag, 'TelesinGripvideo2',
  'an exact manual key wins outright');
assert.notEqual(E.matchAdToTag('Telesin Video 3', TAGS,
  { 'telesinvideo1': 'TelesinGripvideo2' }).tag, 'TelesinGripvideo2',
  'a manual key must not leak onto another creative number');

/* ── Pipe segments run through the same matcher ─────────────────────────── */
const p1 = E.matchAdToTag('1204 | Pantau | OlymplastLemari', TAGS, {});
assert.equal(p1.tag, 'OlymplastLemari');
assert.equal(p1.confidence, 1, 'segment naming a real tag is certain');

const p2 = E.matchAdToTag('1604 | Mentok | Telesin Grip', TAGS, {});
assert.equal(p2.tag, 'TelesinGripvideo2', 'segment resolves through fuzzy matching');
assert.ok(p2.confidence < 1, 'two steps removed is never a certainty');

const p3 = E.matchAdToTag('1604 | Mentok | Barang Yang Tak Ada', TAGS, {});
assert.ok(p3.confidence <= 0.5, 'a segment matching nothing must read as a guess');

assert.equal(E.variantOf('TelesinGripvideo2'), '2');
assert.equal(E.variantOf('seeouokacamatapolarized'), '');
assert.ok(E.variantClash('Telesin Video 1', 'TelesinGripvideo2'));
assert.ok(!E.variantClash('Mini Layar portable', 'minilayarportable'));

/* ── Kolom Tag_link laporan klik memuat lima slot ───────────────────────────
   Shopee joins all five sub-id slots into one column with dashes. Stripping
   only the trailing dashes left a second slot glued on, so the clicks landed
   on a tag the commission report had never heard of: the real tag showed 0
   clicks and 0% arriving — a STOP verdict on a healthy ad — while a phantom
   tag held every click and no spend. */
const known = new Map([['telesingripvideo2', 'TelesinGripvideo2'], ['dydlabel', 'DYDlabel']]);
const rct = raw => E.resolveClickTag(raw, known);

assert.equal(rct('TelesinGripvideo2----'), 'TelesinGripvideo2', 'satu tag, empat slot kosong');
assert.equal(rct('TelesinGripvideo2-promo---'), 'TelesinGripvideo2', 'slot kedua terisi');
assert.equal(rct('TelesinGripvideo2-promo-agustus--'), 'TelesinGripvideo2', 'slot kedua dan ketiga');
// Different capitalisation between the two reports must still join, and join
// under the spelling the commission report uses.
assert.equal(rct('TELESINGRIPVIDEO2-promo---'), 'TelesinGripvideo2', 'beda huruf tetap menyatu');
assert.equal(rct('telesingripvideo2----'), 'TelesinGripvideo2', 'ejaan kanonis dari laporan komisi');
// A tag nobody knows stays whole rather than being chopped at its first dash.
assert.equal(rct('kampanyelain-promo---'), 'kampanyelain-promo', 'tag asing tidak dipotong');
assert.equal(rct('----'), '', 'semua slot kosong');
assert.equal(rct('-promo---'), '-promo', 'slot pertama kosong bukan tag kita');

/* Attribution must survive a second slot appearing mid-period. */
const twoSlot = {
  affiliate: [
    { 'ID Pemesanan':'1', 'Status Pesanan':'Selesai', 'Waktu Pemesanan':'2026-08-01 10:00:00',
      'Waktu Klik':'2026-08-01 09:00:00', 'Total Komisi per Pesanan(Rp)':'5000',
      'Tag_link1':'TAGA', 'Jumlah':'1', 'Nilai Pembelian(Rp)':'50000' },
  ],
  ads: [
    { 'Reporting starts':'2026-08-01', 'Ad name':'TAGA', 'Amount spent (IDR)':'1000',
      'Link clicks':'10', 'Impressions':'1000' },
  ],
  clicks: [
    { 'Waktu Klik':'2026-08-01 09:00:00', 'Tag_link':'TAGA----' },
    { 'Waktu Klik':'2026-08-01 09:05:00', 'Tag_link':'TAGA-promo---' },
  ],
  tagMap: {},
};
const rTwo = E.analyze(twoSlot, { ppn:0, minSpend:0, minDays:1 });
const tagA = rTwo.tags.find(t => t.tag === 'TAGA');
assert.equal(tagA.shopeeClicks, 2, 'kedua klik menyatu ke tag yang sama');
assert.ok(!rTwo.tags.some(t => /^TAGA-/.test(t.tag)), 'tidak ada tag hantu');

/* ── Forgiving match: names typed a little differently still connect ──────
   Skipping setup is the point of the matcher, so near names must land without
   a manual mapping — while one shared fragment still never takes a tag. */
const near = (n, tags) => E.matchAdToTag(n, tags || TAGS, {});
assert.equal(near('Lemari Olympic').tag, 'OlymplastLemari', 'words reordered and shortened');
assert.equal(near('Telesin vidio 2').tag, 'TelesinGripvideo2', 'a typo in one word');
assert.equal(near('Lemari Olympic').method, 'Mirip');
for (const n of ['solid', 'video', 'Blender video']) {
  assert.notEqual(near(n).tag, 'HelmRsixSolid', n + ' must not take HelmRsixSolid');
  assert.notEqual(near(n).tag, 'TelesinGripvideo2', n + ' must not take TelesinGripvideo2');
}
// Two tags equally close is a question for the user, not a coin toss.
const tie = near('Kaffa Outer', ['OuterKaffaA', 'OuterKaffaB']);
assert.equal(tie.method, 'Lemah');
assert.ok(tie.candidateTag, 'a tie still offers a suggestion');
// Each creative number goes to its own tag.
const trio = ['TelesinGripvideo1', 'TelesinGripvideo2', 'TelesinGripvideo3'];
for (const k of ['1', '2', '3']) assert.equal(near('Telesin Video ' + k, trio).tag, 'TelesinGripvideo' + k);

console.log('engine tests: PASS');
