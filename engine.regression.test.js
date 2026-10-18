'use strict';
const assert = require('node:assert/strict');
const E = require('./engine');

const opts = { ppn: 0, minSpend: 0, minDays: 1, lagDays: 0, streakDays: 3 };
const aff = (id, comm = 100, extra = {}) => ({
  'ID Pemesanan': id, 'Status Pesanan': 'Selesai',
  'Waktu Pemesanan': '2026-08-01 10:00:00', 'Waktu Klik': '2026-08-01 09:00:00',
  'Total Komisi per Produk(Rp)': comm, 'Total Komisi per Pesanan(Rp)': 999,
  'Nilai Pembelian(Rp)': 1000, 'Jumlah': 1, 'Tag_link1': 'A', ...extra,
});
const ad = (date = '2026-08-01', spend = 100, extra = {}) => ({
  'Reporting starts': date, 'Ad name': 'A', 'Amount spent (IDR)': spend,
  'Link clicks': 10, 'Impressions': 1000, 'Ad delivery': 'active', ...extra,
});
const click = (date = '2026-08-01', extra = {}) => ({
  'Waktu Klik': date + ' 09:00:00', 'Tag_link': 'A--- ', ...extra,
});
const analyze = (data, options = {}) => E.analyze(data, { ...opts, ...options });
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

// Currency exports may use either decimal convention. Plain machine decimal
// values must retain their precision; invalid strings must not parse prefixes.
for (const [input, expected] of [
  [123.456, 123.456], ['123.456', 123.456], ['1,234.56', 1234.56],
  ['Rp 1.234,56', 1234.56], ['Rp1.234', 1234], ['1.234.567', 1234567],
  ['1,234', 1234], ['95,50', 95.5], ['(Rp 1.234,50)', -1234.5],
  [null, 0], [Infinity, 0], ['12-3', 0],
]) near(E.num(input), expected);
assert.equal(E.dayOnly('2026-08-01T10:00:00Z'), '2026-08-01');
assert.equal(E.hourOf('2026-08-01T10:00:00Z'), 10);
assert.equal(E.hourOf('2026-08-01 99:00:00'), null);
assert.equal(E.isDate('2026-02-30'), false);
assert.equal(E.isDate('2024-02-29'), true);
assert.equal(E.addDays('invalid', 1), '');
assert.equal(E.cleanTag(' A----  '), 'A');
assert.equal(E.pick({ primary: '', fallback: 5 }, ['primary', 'fallback']), 5);
assert.equal(E.pick({ primary: 0, fallback: 5 }, ['primary', 'fallback']), 0);

const settings = E.normalizeOptions({ ppn: -11, pendingFactor: 2, targetROI: -100,
  thScale: 1, thPantau: 3, lagDays: Infinity, streakDays: 0, minDays: 1.8 });
assert.equal(settings.ppn, 0);
assert.equal(settings.pendingFactor, 1);
assert.equal(settings.targetROI, 0);
assert.equal(settings.thScale, 3);
assert.equal(settings.lagDays, E.DEFAULTS.lagDays);
assert.equal(settings.streakDays, 1);
assert.equal(settings.minDays, 2);

// Tax must be applied once in every aggregate and on the click window's cost.
const taxed = analyze({ affiliate: [aff('1')], ads: [ad(), ad('2026-08-02', 900)], clicks: [click()] }, { ppn: 11 });
const taxTag = taxed.tags[0];
near(taxTag.spend, 1110);
near(taxTag.byDate['2026-08-01'].spend, 111);
near(taxTag.winSpend, 111);
near(taxTag.cpcShopee, 111);
near(taxTag.leak.wasted, 99.9); // 9 lost clicks at the window's Rp11.10 CPC
near(taxed.adUnits[0].byDate['2026-08-01'].comm, 100);
near(taxed.daily.reduce((sum, day) => sum + day.spend, 0), taxed.kpi.spend);
near(taxed.daily[1].commEff, 0);
near(taxed.daily[1].netEff, -999);
near(taxed.daily[1].roasEff, 0);
assert.equal(taxed.daily[1].hasAffiliate, false);
assert.equal(taxed.daily[1].hasAds, true);

// Chart series must use the same pending discount and tax as portfolio KPIs,
// while preserving the original gross daily fields for existing consumers.
const dailyEffectiveData = {
  affiliate: [
    aff('done', 120.25),
    aff('pending', 80.5, { 'Status Pesanan': 'Tertunda' }),
    aff('adjustment', -12.75, { 'Tag_link1': 'B', 'Waktu Pemesanan': '2026-08-02 10:00:00' }),
    aff('pending-adjustment', -20, { 'Status Pesanan': 'Tertunda', 'Waktu Pemesanan': '2026-08-02 10:00:00' }),
    aff('cancelled', 999, { 'Status Pesanan': 'Dibatalkan', 'Waktu Pemesanan': '2026-08-03 10:00:00' }),
    aff('unpaid', 888, { 'Status Pesanan': 'Belum Dibayar', 'Waktu Pemesanan': '2026-08-03 10:00:00' }),
    aff('excluded-only', 777, { 'Status Pesanan': 'Dibatalkan', 'Waktu Pemesanan': '2026-08-06 10:00:00' }),
  ],
  ads: [ad('2026-08-01', 100), ad('2026-08-03', 50), ad('2026-08-04', 0)],
  clicks: [click('2026-08-05')],
};
const effectiveDaily = analyze(dailyEffectiveData, { pendingFactor: 0.25, ppn: 11 });
const dailyByDate = Object.fromEntries(effectiveDaily.daily.map(day => [day.date, day]));
near(dailyByDate['2026-08-01'].comm, 200.75);
near(dailyByDate['2026-08-01'].commEff, 140.375);
near(dailyByDate['2026-08-01'].spend, 111);
near(dailyByDate['2026-08-01'].net, 89.75);
near(dailyByDate['2026-08-01'].netEff, 29.375);
near(dailyByDate['2026-08-01'].roasEff, 140.375 / 111);
near(dailyByDate['2026-08-02'].commEff, -17.75);
near(dailyByDate['2026-08-02'].netEff, -17.75);
assert.equal(dailyByDate['2026-08-02'].roasEff, 0);
near(dailyByDate['2026-08-03'].commEff, 0);
near(dailyByDate['2026-08-03'].netEff, -55.5);
assert.deepEqual(effectiveDaily.daily.map(day => [day.hasAffiliate, day.hasAds]), [
  [true, true], [true, false], [true, true], [false, true], [false, false],
]);
assert.equal(dailyByDate['2026-08-06'], undefined); // Excluded-only dates do not extend the existing daily series.
for (const factor of [0, 0.25, 1]) {
  const result = analyze(dailyEffectiveData, { pendingFactor: factor, ppn: 11 });
  for (const field of ['comm', 'commEff', 'spend', 'net', 'netEff']) {
    near(result.daily.reduce((sum, day) => sum + day[field], 0), result.kpi[field]);
  }
  near(result.daily[0].commEff, 120.25 + 80.5 * factor);
  for (const day of result.daily) {
    near(day.roasEff, day.spend > 0 ? day.commEff / day.spend : 0);
  }
}

// Per-product commission has precedence over the repeated per-order total.
const lineItems = analyze({ affiliate: [aff('same', 40), aff('same', 60), aff('pending', 100, { 'Status Pesanan': ' Tertunda ' })] });
assert.equal(lineItems.kpi.comm, 200);
assert.equal(lineItems.kpi.orders, 2);
assert.equal(lineItems.lagCal.sampleSize, 2);
assert.equal(lineItems.breakdown.hourly[10].orders, 2);
assert.equal(lineItems.settlement[0].n, 2);
assert.equal(lineItems.settlement[0].pendingPct, 50);
near(lineItems.kpi.organicShare, 100);
near(lineItems.kpi.organicComm, lineItems.kpi.commEff);
assert.equal(analyze({ affiliate: [aff('', 10)] }).kpi.orders, 0);
assert.equal(analyze({ affiliate: [aff('x', 0, { 'Status Pesanan': ' Dibatalkan ' })] }).counts.affiliate, 0);
assert.equal(analyze({ affiliate: [aff('x', undefined)] }).kpi.comm, 100);

// A valid H+0 recommendation must not be replaced by the maximum observed lag.
const lagRows = Array.from({ length: 9 }, (_, i) => aff(String(i)));
lagRows.push(aff('late', 100, { 'Waktu Klik': '2026-07-25 10:00:00' }));
assert.equal(analyze({ affiliate: lagRows }).lagCal.suggested, 0);
assert.equal(analyze({ affiliate: [lagRows[9]] }).lagCal.sameDayPct, 0);

// Both qualification and decisions need mature data; effective pending values
// also apply to the mature streak, not just the whole-period ROAS.
const maturity = analyze({ affiliate: [aff('1', 300)], ads: [ad(), ad('2026-08-02', 1000)] }, { lagDays: 1 });
assert.equal(maturity.tags[0].status, 'scale');
assert.equal(maturity.tags[0].matureRoasEff, 3);
assert.ok(maturity.tags[0].roasEff < 1);
assert.equal(analyze({ ads: [ad()] }, { lagDays: 3 }).tags[0].status, 'evaluasi');
assert.equal(analyze({ affiliate: [aff('1')], ads: [ad()] }, { lagDays: 3 }).tags[0].status, 'evaluasi');
const pendingStreak = analyze({
  affiliate: [aff('1', 100, { 'Status Pesanan': 'Tertunda' })], ads: [ad()],
}, { pendingFactor: 0.5, streakDays: 1 });
assert.equal(pendingStreak.tags[0].streak, 1);
assert.equal(pendingStreak.tags[0].status, 'stop');
const zeroEffective = analyze({ affiliate: [aff('1', 100, { 'Status Pesanan': 'Tertunda' })], ads: [ad()] }, { pendingFactor: 0 });
assert.ok(Number.isFinite(zeroEffective.tags[0].margin));

// Stop spend and bid saving on the same tag cannot be reclaimed twice.
const saving = analyze({ affiliate: [aff('1', 10)], ads: [ad()] });
assert.equal(saving.tags[0].status, 'stop');
assert.equal(saving.actions.bidSaving, 0);
near(saving.actions.reclaimable, 100);
assert.ok(saving.actions.reclaimable <= saving.kpi.spend);
// The STOP headline is the loss, not the gross spend: the tag still earned 10.
near(saving.actions.stopComm, 10);
near(saving.actions.stopLoss, 90);
near(saving.actions.maxGain, 90);
assert.ok(saving.actions.stopLoss <= saving.actions.stopSpend);
assert.equal(saving.actions.stopLiveCount, 1, 'the fixture ad is still delivering');
const noDelivery = analyze({ affiliate: [aff('1', 10)], ads: [ad('2026-08-01', 100, { 'Ad delivery': '' })] });
assert.equal(noDelivery.tags[0].status, 'stop');
assert.equal(noDelivery.actions.stopLiveCount, null, 'without a delivery column the live count is unknown, not zero');

// An inactive latest row must override an older active delivery state.
const inactive = analyze({ ads: [ad(), ad('2026-08-02', 100, { 'Ad delivery': 'inactive' })] });
assert.equal(inactive.adUnits[0].active, false);
assert.equal(inactive.adUnits[0].delivery, 'inactive');
assert.equal(analyze({ ads: [ad('2026-08-01', 100, { 'Ad delivery': 'tidak aktif' })] }).adUnits[0].active, false);

// Link health and click-loss totals. One order and one ads row per tag per day;
// spec values are per day, so 4 days of 160 Meta clicks make 640.
function linkFixture(spec, days) {
  const affiliate = [], ads = [], clicks = [];
  for (let i = 1; i <= days; i++) {
    const date = '2026-08-0' + i;
    for (const [tag, s] of Object.entries(spec)) {
      ads.push(ad(date, s.spend, { 'Ad name': tag, 'Link clicks': s.meta }));
      for (let c = 0; c < s.shopee; c++) clicks.push(click(date, { 'Tag_link': tag }));
      const comm = typeof s.comm === 'function' ? s.comm(i) : s.comm;
      if (comm) affiliate.push(aff(tag + i, comm, { 'Tag_link1': tag,
        'Waktu Pemesanan': date + ' 10:00:00', 'Waktu Klik': date + ' 09:00:00' }));
    }
  }
  return analyze({ affiliate, ads, clicks });
}
// A surplus on B is reported beside A's shortfall, never silently netted into it.
const netting = linkFixture({ A: { spend: 100, meta: 10, shopee: 5, comm: 300 }, B: { spend: 100, meta: 20, shopee: 25, comm: 300 } }, 1);
assert.equal(netting.kpi.lostClicks, 5);
assert.equal(netting.kpi.gainClicks, 5);
assert.equal(netting.kpi.netLostClicks, 0);
near(netting.kpi.wastedLow, 0);
near(netting.kpi.wasted, netting.tags.find(t => t.tag === 'A').leak.wasted);

const health = linkFixture({
  Broken: { spend: 1000, meta: 160, shopee: 0, comm: 100 },     // 0% of 640: STOP on its streak
  LiveLeak: { spend: 1000, meta: 100, shopee: 10, comm: 5000 }, // 10% of 400 on a SCALE tag
  Cheap: { spend: 1000, meta: 100, shopee: 38, comm: 1500 },    // 38%: amber, not a link verdict
  Outside: { spend: 1000, meta: 100, shopee: 300, comm: 5000 }, // 300% of 400: outside traffic
  Tiny: { spend: 1000, meta: 5, shopee: 1, comm: 3000 },        // 20% of 20: too few clicks
  Faded: { spend: 1000, meta: 10, shopee: 10, comm: day => day === 1 ? 10000 : 0 }, // STOP, still net positive
}, 4);
const H = Object.fromEntries(health.tags.map(t => [t.tag, t]));
assert.equal(H.Broken.status, 'stop');
assert.equal(H.Broken.leak.severity, 'bad');
assert.equal(H.Broken.leak.reliable, true);
assert.match(H.Broken.reason, /^ROAS di bawah 1 selama 4 hari produksi berturut$/, 'the link warning must not replace the STOP reason');
assert.equal(H.Broken.linkNote, 'hanya 0% klik sampai Shopee — cek link sebelum dimatikan');
assert.equal(H.LiveLeak.status, 'scale');
assert.equal(H.LiveLeak.linkNote, 'hanya 10% klik sampai Shopee — cek link');
assert.equal(H.Cheap.leak.severity, 'warn');
assert.equal(H.Cheap.linkNote, '');
assert.equal(H.Outside.leak.severity, 'over');
assert.equal(H.Outside.leak.reliable, true);
assert.equal(H.Outside.status, 'scale', 'link health must not change verdicts');
assert.match(H.Outside.linkNote, /ROAS memuat trafik lain, anggap batas atas$/);
assert.equal(H.Tiny.leak.severity, 'bad');
assert.equal(H.Tiny.leak.reliable, false);
assert.equal(H.Tiny.linkNote, '');
assert.equal(health.kpi.leakTags, 2, 'only reliable tags under 25% count as link problems');
near(health.actions.leakWaste, H.Broken.leak.wasted + H.LiveLeak.leak.wasted);
// A leaking STOP tag's spend is already in the STOP card; the link card keeps the rest.
near(health.actions.leakWasteStop, H.Broken.leak.wasted);
near(health.actions.leakWasteLive, H.LiveLeak.leak.wasted);
assert.equal(health.actions.leakStopCount, 1);
assert.equal(health.actions.leakLiveCount, 1);
near(health.actions.leakWasteLive + health.actions.leakWasteStop, health.actions.leakWaste);
// STOP money: loss, commission and spend reported apart; the tail adds profit changes only.
assert.equal(H.Faded.status, 'stop');
assert.equal(health.actions.stopCount, 2);
assert.equal(health.actions.stopProfitCount, 1);
assert.equal(health.actions.stopLiveCount, 2);
near(health.actions.stopSpend, 8000);
near(health.actions.stopComm, 10400);
near(health.actions.stopLoss, 3600);
near(health.actions.maxGain, health.actions.bidSaving + 3600);
// Snapshots keep the real reason and gain no string fields (validSnapshot rejects them).
const healthSnap = E.toSnapshot(health, { id: 1, saved: '2026-08-05 00:00:00' });
for (const t of healthSnap.tags) for (const [k, v] of Object.entries(t)) {
  assert.ok(['tag', 'label', 'reason', 'status'].includes(k) || v === null || Number.isFinite(v), 'snapshot tag field ' + k);
}
assert.ok(!healthSnap.tags.some(t => /cek link/.test(t.reason)));
assert.deepEqual(Object.keys(healthSnap.kpi).filter(k => /^(wastedLow|lostClicks|gainClicks|netLostClicks)$/.test(k)), [],
  'new click totals stay out of snapshots so older trend points do not read as zero');

// "di batas" marks only verdicts a ROAS threshold decided, on the 2-decimal
// value the reason prints. 10 days x 20.000 spend, lag 3, so 7 mature days.
const edgeDays = Array.from({ length: 10 }, (_, i) => '2026-09-' + String(i + 1).padStart(2, '0'));
const edgeAff = [], edgeAds = [];
const edgeTag = (tag, comms) => edgeDays.forEach((date, i) => {
  edgeAds.push(ad(date, 20000, { 'Ad name': tag }));
  const comm = Array.isArray(comms) ? comms[i] : comms;
  if (comm) edgeAff.push(aff(tag + date, comm, { 'Tag_link1': tag, 'Waktu Pemesanan': date + ' 10:00:00', 'Waktu Klik': date + ' 09:00:00' }));
});
edgeTag('Scale205', 41000);
edgeTag('Pantau190', 38000);
edgeTag('Pantau150', 30000);
edgeTag('Pantau110', 22000);
edgeTag('Pantau105', 21000);
// 1,105 and 1,795 print as 1,10x and 1,79x; the pill must follow the printed value.
edgeTag('Pantau1105', 22100);
edgeTag('Pantau1795', 35900);
edgeTag('RoasStop095', [0, 0, 0, 0, 44333, 44333, 44334, 0, 0, 0]);
edgeTag('StreakStop095', 19000);
edgeTag('RoasStop089', [0, 0, 0, 0, 0, 62300, 62300, 0, 0, 0]);
// Not judged: a small paid tag, an ad name matching no tag, an idle ad name
// and a click-only sub_id. Only the first two have money at stake.
edgeAds.push(ad('2026-09-01', 7500, { 'Ad name': 'SmallPaid' }), ad('2026-09-02', 7500, { 'Ad name': 'SmallPaid' }));
edgeAff.push(aff('small-1', 4000, { 'Tag_link1': 'SmallPaid', 'Waktu Pemesanan': '2026-09-01 10:00:00' }));
edgeAds.push(ad('2026-09-02', 9000, { 'Ad name': 'NoSuchTag' }));
edgeDays.forEach(date => edgeAds.push(ad(date, 0, { 'Ad name': 'IdleAd', 'Link clicks': 0, 'Impressions': 0 })));
const edgeClicks = Array.from({ length: 5 }, (_, i) => click('2026-09-03', { 'Tag_link': 'ClickOnly', 'Waktu Klik': '2026-09-03 09:0' + i + ':00' }));
const edge = E.analyze({ affiliate: edgeAff, ads: edgeAds, clicks: edgeClicks }, { ppn: 0 });
const E2 = Object.fromEntries(edge.tags.map(t => [t.tag, t]));
for (const [tag, status, borderAt] of [
  ['Scale205', 'scale', 2], ['Pantau190', 'pantau', 2], ['Pantau150', 'pantau', null],
  ['Pantau110', 'pantau', 1], // exactly 1,10x: inside the band despite floating point
  ['Pantau105', 'pantau', 1], ['RoasStop095', 'stop', 1],
  ['Pantau1105', 'pantau', 1], ['Pantau1795', 'pantau', null],
  ['StreakStop095', 'stop', null], // decided by the loss streak, not the threshold
  ['RoasStop089', 'stop', null], ['SmallPaid', 'evaluasi', null], ['NoSuchTag', 'evaluasi', null],
  ['IdleAd', 'evaluasi', null], ['ClickOnly', 'evaluasi', null],
]) {
  assert.equal(E2[tag].status, status, tag);
  assert.equal(E2[tag].borderAt, borderAt, tag + ' borderAt');
  assert.ok(!/batas/.test(E2[tag].reason), tag + ': the reason text is unchanged');
}
assert.match(E2.StreakStop095.reason, /berturut/);
const edgeHigh = E.analyze({ affiliate: edgeAff, ads: edgeAds }, { ppn: 0, thScale: 3 });
assert.equal(edgeHigh.tags.find(t => t.tag === 'Scale205').borderAt, null, 'the band follows the threshold setting');
assert.equal(edgeHigh.tags.find(t => t.tag === 'Pantau190').borderAt, null);
// Unjudged money counts paid tags only; kpi.counts keeps its old meaning.
assert.equal(edge.kpi.counts.evaluasi, 4);
assert.equal(edge.actions.evalCount, 2);
near(edge.actions.evalSpend, 24000);
near(edge.actions.evalComm, 4000);
near(edge.actions.evalNet, -20000);
near(edge.actions.evalNet, edge.tags.filter(t => t.status === 'evaluasi' && t.spend > 0).reduce((s, t) => s + t.netEff, 0));
const edgeSnap = E.toSnapshot(edge, { id: 2, saved: '2026-09-11 00:00:00' });
assert.ok(edgeSnap.tags.every(t => !('borderAt' in t)), 'borderAt stays out of snapshots');
assert.deepEqual(Object.keys(edgeSnap.kpi).filter(k => /^eval/.test(k)), []);
assert.deepEqual(edgeSnap.kpi.counts, edge.kpi.counts);

// Click-only data and dates are meaningful even without affiliate/ads rows.
const clicksOnly = analyze({ clicks: [click()] });
assert.equal(clicksOnly.range.start, '2026-08-01');
assert.equal(clicksOnly.daily.length, 1);
assert.equal(clicksOnly.daily[0].shopeeClicks, 1);
assert.equal(clicksOnly.tags[0].tag, 'A');
assert.equal(analyze({ ads: [ad('2026-02-30')] }).counts.ads, 0);
assert.doesNotThrow(() => analyze({}, { dateStart: 'invalid', dateEnd: '2026-99-99' }));
assert.equal(analyze({ ads: [ad()] }, { dateStart: '2026-08-02', dateEnd: '2026-08-01' }).counts.ads, 1);
assert.doesNotThrow(() => E.analyze());

// Imported names must never index Object.prototype or mutate shared objects.
for (const name of ['__proto__', 'constructor', 'toString']) {
  const result = analyze({
    affiliate: [aff('1', 100, { 'Tag_link1': name, 'Platform': name, 'Nama Barang': name, 'Nama Toko': name })],
    ads: [ad('2026-08-01', 100, { 'Ad name': name })],
    clicks: [click('2026-08-01', { 'Tag_link': name, 'Perujuk': name, 'Wilayah Klik': name })],
  });
  assert.equal(result.tags[0].tag, name);
  assert.equal(result.kpi.comm, 100);
  assert.equal(result.breakdown.productByComm[0].name, name);
  assert.equal(result.breakdown.clickSource[0].count, 1);
  assert.doesNotThrow(() => E.stability({ affiliate: [aff('1', 100, { 'Tag_link1': name })], ads: [ad('2026-08-01', 100, { 'Ad name': name })] }));
}
assert.equal({}.comm, undefined);

// User mappings override pipe hints but must not affect unrelated ad names.
assert.deepEqual(E.matchAdToTag('Campaign | Ad | old', ['old', 'new'], { campaignadold: 'new' }), { tag: 'new', method: 'Manual', confidence: 1 });
assert.notEqual(E.matchAdToTag('carpet', ['car', 'lamp'], { car: 'lamp' }).method, 'Manual');

// Low-confidence candidates remain visible for review without contaminating
// another tag's spend, profit, or decision.
const weak = analyze({ affiliate: [aff('weak', 100, { 'Tag_link1': 'HelmRsixSolid' })],
  ads: [ad('2026-08-01', 100, { 'Ad name': 'solid' })] });
assert.equal(weak.tags.find(t => t.tag === 'HelmRsixSolid').spend, 0);
assert.equal(weak.tags.find(t => t.tag === 'solid').spend, 100);
assert.equal(weak.matchLog[0].candidateTag, 'HelmRsixSolid');
assert.equal(weak.matchLog[0].method, 'Lemah');
for (const name of ['solid', 'solid solid solid']) {
  const fragment = E.matchAdToTag(name, ['HelmRsixSolid']);
  assert.equal(fragment.tag, name);
  assert.ok(fragment.confidence < 0.5);
}


// Commission per order is a CPA limit, not a CPC limit. Pending commission
// must be discounted before estimating an organic candidate's safe CPA.
const organicPending = analyze({ affiliate: [aff('organic-pending', 100, { 'Status Pesanan': 'Tertunda' })] },
  { pendingFactor: 0.5, targetROI: 100 }).actions.organicCandidates[0];
assert.equal(organicPending.maxCpa, 25);
assert.equal(organicPending.maxCpc, undefined);

// Preserve distinct period starts; same full range still keeps the newest save.
const snapshot = (start, end, saved, roas) => ({ account: 'a', saved, range: { start, end },
  kpi: { roasEff: roas }, tags: [{ tag: 'A', roasEff: roas, status: 'pantau' }] });
const first = snapshot('2026-08-01', '2026-08-10', '2026-08-11', 1);
const second = snapshot('2026-08-05', '2026-08-10', '2026-08-12', 2);
const third = snapshot('2026-08-11', '2026-08-20', '2026-08-21', 3);
const trend = E.buildTrend([first, second, third], 'a');
assert.equal(trend.series.length, 3);
assert.equal(trend.movers[0].from, 2);
assert.equal(trend.movers[0].delta, 1);
assert.equal(E.buildTrend([first, { ...first, saved: '2026-08-12' }], 'a').series.length, 1);
assert.equal(E.buildTrend([first, { ...first, account: 'b' }]).series.length, 2);

// Cancelled rows carry zero commission; their lost value is refund + purchase
// value, summed per order. Rows outside the period add nothing.
const cancelledRows = [aff('ok', 100),
  aff('c1', 0, { 'Status Pesanan': 'Dibatalkan', 'Nilai Pembelian(Rp)': 0, 'Jumlah Pengembalian Dana(Rp)': 80000 }),
  aff('c2', 0, { 'Status Pesanan': 'Dibatalkan', 'Nilai Pembelian(Rp)': 20000 }),
  aff('c2', 0, { 'Status Pesanan': 'Dibatalkan', 'Nilai Pembelian(Rp)': 5000 })];
const cancelled = analyze({ affiliate: cancelledRows });
assert.equal(cancelled.kpi.excluded.cancelledValue, 105000);
assert.equal(cancelled.kpi.excluded.cancelledOrders, 2);
assert.equal(cancelled.kpi.excluded.cancelledMax, 80000);
assert.equal(cancelled.kpi.excluded.cancelled, 3);
assert.equal(cancelled.kpi.cancelBase, 3);
near(cancelled.kpi.cancelRate, 2 / 3 * 100);
near(cancelled.kpi.cancelValueRate, 105000 / (1000 + 105000) * 100);
const outside = analyze({ affiliate: [...cancelledRows, aff('late', 0, { 'Status Pesanan': 'Dibatalkan',
  'Waktu Pemesanan': '2026-08-09 10:00:00', 'Nilai Pembelian(Rp)': 900000 })] },
{ dateStart: '2026-08-01', dateEnd: '2026-08-01' });
assert.equal(outside.kpi.excluded.cancelledValue, 105000);
assert.equal(outside.kpi.excluded.cancelledOrders, 2);
assert.equal(outside.kpi.cancelBase, 3);
// An order with one kept and one cancelled item counts once, as cancelled.
const partial = analyze({ affiliate: [aff('X', 100), aff('X', 0, { 'Status Pesanan': 'Dibatalkan' }), aff('Y', 50)] });
assert.equal(partial.kpi.cancelBase, 2);
assert.equal(partial.kpi.cancelRate, 50);
const noOrders = analyze({ affiliate: [] });
assert.deepEqual([noOrders.kpi.cancelBase, noOrders.kpi.cancelRate, noOrders.kpi.cancelValueRate,
  noOrders.kpi.excluded.cancelledValue, noOrders.kpi.excluded.cancelledMax], [0, 0, 0, 0, 0]);

// Completed-only ROAS shares the PPN-inclusive spend of roasEff and is 0 without ads.
const doneOnly = analyze({ affiliate: [aff('d', 300), aff('p', 100, { 'Status Pesanan': 'Tertunda' })],
  ads: [ad('2026-08-01', 200)] }, { ppn: 11 });
assert.equal(doneOnly.kpi.commDone, 300);
near(doneOnly.kpi.roasDone, 300 / 222);
near(doneOnly.kpi.commDone + doneOnly.kpi.commPending, doneOnly.kpi.comm);
assert.equal(analyze({ affiliate: [aff('d', 300)] }).kpi.roasDone, 0);

// Pre-PPN spend does not depend on the rate, so a PPN what-if needs no second
// analysis. It is not stored: snapshot.options.ppn already lets it be derived.
const ppnRows = { affiliate: [aff('p1', 300)], ads: [ad('2026-08-01', 200), ad('2026-08-02', 100)] };
const at0 = analyze(ppnRows, { ppn: 0 }), at11 = analyze(ppnRows, { ppn: 11 });
assert.equal(at0.kpi.spendBase, 300);
assert.equal(at11.kpi.spendBase, 300);
near(at11.kpi.spend, at11.kpi.spendBase * 1.11);
near(at11.tags[0].spend, at11.tags[0].spendBase * 1.11);
assert.equal(E.toSnapshot(at11).kpi.spendBase, undefined);

// Day rows carry effective commission, so Harian and the KPI cards share one definition.
const effData = { affiliate: [aff('e1', 300), aff('e2', 100, { 'Status Pesanan': 'Tertunda', 'Waktu Pemesanan': '2026-08-02 10:00:00' })],
  ads: [ad('2026-08-01', 100, { 'Ad name': 'Iklan satu' }), ad('2026-08-01', 300, { 'Ad name': 'Iklan dua' }),
    ad('2026-08-02', 200, { 'Ad name': 'Iklan satu' })],
  tagMap: { [E.normalize('Iklan satu')]: 'A', [E.normalize('Iklan dua')]: 'A' } };
const eff = analyze(effData, { pendingFactor: 0.5, ppn: 11 });
const effTag = eff.tags.find(t => t.tag === 'A');
near(effTag.commEff, 350);
near(Object.values(effTag.byDate).reduce((sum, d) => sum + d.commEff, 0), effTag.commEff);
near(eff.daily.reduce((sum, d) => sum + d.netEff, 0), eff.kpi.netEff);
// A unit's day follows its tag's day by that day's spend share. The unit's
// period total uses the period share instead, so its days need not add up to it.
assert.equal(eff.adUnits.length, 2);
for (const unit of eff.adUnits) for (const d of Object.keys(unit.byDate)) {
  const day = effTag.byDate[d];
  near(unit.byDate[d].commEff, day.commEff * unit.byDate[d].spend / day.spend);
}

// Each trend point names its PPN; one missing from a snapshot is unknown, not 0%.
const snapAt = (ppn, end, extra = {}) => ({ ...E.toSnapshot(analyze({ affiliate: [aff('t1')], ads: [ad()] }, { ppn }),
  { id: Date.parse(end), account: 'default', saved: end + ' 12:00:00' }), range: { start: '2026-08-01', end }, ...extra });
assert.deepEqual(E.buildTrend([snapAt(0, '2026-08-01'), snapAt(11, '2026-08-02')], 'default').series.map(s => s.ppn), [0, 11]);
assert.deepEqual(E.buildTrend([snapAt(0, '2026-08-01', { options: undefined }), snapAt(0, '2026-08-02', { options: { ppn: null } })],
  'default').series.map(s => s.ppn), [null, null]);

// Harian charts put commission on its click day (Waktu Klik). By order date a
// cheap day collects orders from earlier clicks: must 30 Sep read 4,14x.
const clickAff = (id, order, clicked, comm, status = 'Selesai') => aff(id, comm, {
  'Status Pesanan': status, 'Waktu Pemesanan': order + ' 10:00:00', 'Waktu Klik': clicked ? clicked + ' 09:00:00' : '' });
const clickDays = n => Array.from({ length: n }, (_, i) => ad('2026-08-' + String(i + 1).padStart(2, '0'), 100));
const clickData = {
  affiliate: [
    clickAff('late', '2026-08-05', '2026-08-02', 1000),
    clickAff('before', '2026-08-01', '2026-07-30', 500),
    clickAff('noclick', '2026-08-03', '', 300),
    clickAff('d6', '2026-08-06', '2026-08-06', 200),
    clickAff('d7', '2026-08-07', '2026-08-07', 100),
    clickAff('p7', '2026-08-09', '2026-08-07', 300, 'Tertunda'),
    clickAff('p8', '2026-08-08', '2026-08-08', 800, 'Tertunda'),
    clickAff('p9', '2026-08-09', '2026-08-09', 700, 'Tertunda'),
    clickAff('gone', '2026-08-04', '2026-08-04', 999, 'Dibatalkan'),
  ],
  ads: clickDays(9),
};
const byDay = res => Object.fromEntries(res.daily.map(day => [day.date, day]));
const clicked = analyze(clickData, { dateStart: '2026-08-01', pendingFactor: 0.5 });
const cd = byDay(clicked);
near(cd['2026-08-02'].commEffByClick, 1000);
near(cd['2026-08-05'].commEffByClick, 0);
near(cd['2026-08-05'].commEff, 1000); // the order-date series is unchanged
near(cd['2026-08-07'].commEffByClick, 100 + 300 * 0.5);
near(cd['2026-08-07'].roasEffByClick, 250 / 100);
near(cd['2026-08-07'].netEffByClick, 150);
near(cd['2026-08-07'].pendingPctByClick, 75);
assert.equal(clicked.byClick.available, true);
near(clicked.byClick.before, 500); near(clicked.byClick.beforeEff, 500);
near(clicked.byClick.missing, 300); near(clicked.byClick.missingEff, 300);
assert.ok(clicked.daily.every(day => day.date >= '2026-08-01'), 'a click before the start opens no day of its own');
assert.equal(cd['2026-08-04'].commByClick, 0, 'cancelled rows stay out of the click series');
for (const factor of [0, 0.25, 1]) {
  const res = analyze(clickData, { dateStart: '2026-08-01', pendingFactor: factor });
  const placed = field => res.daily.reduce((sum, day) => sum + (day[field] == null ? 0 : day[field]), 0);
  // Series plus the named remainders add up to the KPI: nothing is dropped silently.
  near(placed('commEffByClick') + res.byClick.beforeEff + res.byClick.missingEff, res.kpi.commEff);
  near(placed('commByClick') + res.byClick.before + res.byClick.missing, res.kpi.comm);
}
// Trailing click days with half or more still Tertunda are not mature, even inside the lag.
assert.deepEqual(clicked.daily.slice(-4).map(day => [day.date, day.matureByClick]),
  [['2026-08-06', true], ['2026-08-07', false], ['2026-08-08', false], ['2026-08-09', false]]);
assert.equal(clicked.byClick.matureUntil, '2026-08-06');
assert.ok(clicked.byClick.matureUntil <= clicked.range.matureUntil);
assert.equal(clicked.range.matureUntil, '2026-08-09', 'the verdict cut-off keeps its order-date meaning');
// The band date lives outside range, so saved snapshots keep their shape.
assert.deepEqual(Object.keys(E.toSnapshot(clicked).range), ['start', 'end', 'matureUntil', 'clickStart', 'clickEnd']);
assert.equal(E.toSnapshot(clicked).byClick, undefined);

// A commission report that ends before the ads: later click days are unknown,
// and the lag counts back from where the commission report ends.
const shortAff = analyze({ affiliate: [clickAff('s1', '2026-08-03', '2026-08-02', 400), clickAff('s2', '2026-08-09', '2026-08-09', 600)],
  ads: clickDays(12) }, { lagDays: 2 });
const sd = byDay(shortAff);
assert.equal(shortAff.byClick.dataEnd, '2026-08-09');
assert.deepEqual(['2026-08-10', '2026-08-11', '2026-08-12'].map(d => [sd[d].commEffByClick, sd[d].netEffByClick, sd[d].roasEffByClick, sd[d].matureByClick]),
  [[null, null, null, false], [null, null, null, false], [null, null, null, false]]);
assert.ok(shortAff.byClick.matureUntil <= '2026-08-07', shortAff.byClick.matureUntil);
assert.equal(sd['2026-08-09'].commEffByClick, 600);
assert.equal(sd['2026-08-07'].matureByClick, true);
assert.equal(sd['2026-08-08'].matureByClick, false);

// Without Waktu Klik the click series is unknown everywhere, not a row of zeros.
const noClick = analyze({ affiliate: [clickAff('n1', '2026-08-01', '', 100), clickAff('n2', '2026-08-02', '', 50)], ads: clickDays(2) });
assert.equal(noClick.byClick.available, false);
assert.equal(noClick.byClick.matureUntil, '');
for (const field of ['commByClick', 'commEffByClick', 'netEffByClick', 'roasEffByClick', 'pendingPctByClick', 'matureByClick'])
  assert.ok(noClick.daily.every(day => day[field] === null), field);
near(noClick.byClick.missingEff, 150);

/* ── Matching follows the Analisis findings on the September data ──────────
   Exact names decide, case included; near names only suggest; tags come from
   the click report too; an ad is its Ad ID. */
{
  // MaskerDuckbill (the ad's sub_id, clicks from Facebook) and Maskerduckbill
  // (an organic post with orders) are two sub_ids. The ad must not join the
  // organic one, and its clicks must stay with it.
  const r = analyze({
    affiliate: [aff('o1', 500, { 'Tag_link1': 'Maskerduckbill' })],
    ads: [ad('2026-08-01', 300, { 'Ad name': 'MaskerDuckbill' })],
    clicks: [click('2026-08-01', { 'Tag_link': 'MaskerDuckbill----' }), click('2026-08-01', { 'Tag_link': 'Maskerduckbill----' })],
  });
  const adTag = r.tags.find(t => t.tag === 'MaskerDuckbill'), organic = r.tags.find(t => t.tag === 'Maskerduckbill');
  assert.equal(r.matchLog[0].method, 'Exact');
  assert.equal(adTag.spend, 300);
  assert.equal(adTag.shopeeClicks, 1, 'the ad keeps its own clicks');
  assert.equal(organic.spend, 0, 'the organic tag gets no ad spend');
  assert.equal(organic.shopeeClicks, 1);
  assert.equal(organic.status, 'organik');

  // Without the click report only the organic spelling is known: a question,
  // never an automatic join.
  const noClicks = analyze({ affiliate: [aff('o1', 500, { 'Tag_link1': 'Maskerduckbill' })],
    ads: [ad('2026-08-01', 300, { 'Ad name': 'MaskerDuckbill' })] });
  assert.equal(noClicks.matchLog[0].method, 'Beda huruf');
  assert.equal(noClicks.matchLog[0].candidateTag, 'Maskerduckbill');
  assert.equal(noClicks.tags.find(t => t.tag === 'Maskerduckbill').spend, 0);
}
{
  // A test ad whose link works but has not sold yet is in the click report only.
  const r = analyze({ affiliate: [aff('o1', 500)],
    ads: [ad('2026-08-01', 300, { 'Ad name': 'TesBaru' })],
    clicks: [click('2026-08-01', { 'Tag_link': 'TesBaru----' })] });
  const t = r.tags.find(x => x.tag === 'TesBaru');
  assert.equal(r.matchLog[0].method, 'Exact', 'not "Tidak cocok"');
  assert.equal(t.spend, 300);
  assert.equal(t.shopeeClicks, 1);
  assert.equal(t.comm, 0);
}
{
  // LanaInstanHijabVID has a sub_id of its own; its spend must not move to
  // LanaInstanHijab, with or without that sub_id in the data.
  const base = { affiliate: [aff('o1', 700, { 'Tag_link1': 'LanaInstanHijab' })],
    ads: [ad('2026-08-01', 1000, { 'Ad name': 'LanaInstanHijab' }), ad('2026-08-01', 400, { 'Ad name': 'LanaInstanHijabVID' })] };
  const r = analyze(base);
  assert.equal(r.tags.find(t => t.tag === 'LanaInstanHijab').spend, 1000);
  const vid = r.matchLog.find(m => m.adName === 'LanaInstanHijabVID');
  assert.equal(vid.tag, 'LanaInstanHijabVID');
  assert.equal(vid.candidateTag, 'LanaInstanHijab', 'still offered as a suggestion');
  const withClicks = analyze({ ...base, clicks: [click('2026-08-01', { 'Tag_link': 'LanaInstanHijabVID----' })] });
  assert.equal(withClicks.matchLog.find(m => m.adName === 'LanaInstanHijabVID').method, 'Exact');
}
{
  // Two ads with one name in two campaigns are two units on one tag.
  const id1 = '120212345678901234', id2 = '120212345678905678';
  const r = analyze({ affiliate: [aff('o1', 500, { 'Tag_link1': 'BantalTidur' })],
    ads: [ad('2026-08-01', 100, { 'Ad name': 'BantalTidur', 'Ad ID': id1, 'Campaign name': '100826 | TST | JWA | BBA | BantalTidur' }),
          ad('2026-08-02', 300, { 'Ad name': 'BantalTidur', 'Ad ID': id2, 'Campaign name': '270926 | TST | INA | BantalTidur' }),
          ad('2026-08-03', 50, { 'Ad name': 'BantalTidur', 'Ad ID': id1, 'Campaign name': '100826 | TST | JWA | BBA | BantalTidur' })] });
  assert.equal(r.adUnits.length, 2);
  const u1 = r.adUnits.find(u => u.adId === id1), u2 = r.adUnits.find(u => u.adId === id2);
  assert.equal(u1.spend, 150); assert.equal(u2.spend, 300);
  assert.equal(u1.campaign, '100826 | TST | JWA | BBA | BantalTidur');
  assert.notEqual(u1.key, u2.key);
  assert.equal(r.tags.find(t => t.tag === 'BantalTidur').spend, 450);
  assert.equal(r.tags.find(t => t.tag === 'BantalTidur').activeUnits, 2);
  assert.deepEqual(r.learnedIds, { [id1]: 'BantalTidur', [id2]: 'BantalTidur' });

  // An uploaded export without IDs joins the one ad that carries its name...
  const mixed = analyze({ affiliate: [aff('o1', 500, { 'Tag_link1': 'Kuku' })],
    ads: [ad('2026-08-01', 100, { 'Ad name': 'Kuku' }), ad('2026-08-02', 200, { 'Ad name': 'Kuku', 'Ad ID': id1 })] });
  assert.equal(mixed.adUnits.length, 1);
  assert.equal(mixed.adUnits[0].spend, 300);
  assert.equal(mixed.adUnits[0].adId, id1);
  // ...but a name two ads share cannot be split, so it stays its own unit.
  const shared = analyze({ affiliate: [aff('o1', 500, { 'Tag_link1': 'Kuku' })],
    ads: [ad('2026-08-01', 100, { 'Ad name': 'Kuku' }), ad('2026-08-02', 200, { 'Ad name': 'Kuku', 'Ad ID': id1 }),
          ad('2026-08-02', 400, { 'Ad name': 'Kuku', 'Ad ID': id2 })] });
  assert.equal(shared.adUnits.length, 3);
  assert.equal(shared.adUnits.find(u => !u.adId).spend, 100);

  // Spreadsheet-rounded IDs identify nothing: those rows group by name.
  for (const bad of ['1.20212E+17', '120212345678901000', '12021234567890100', ' ']) assert.equal(E.intactAdId(bad), '', bad);
  assert.equal(E.intactAdId(' 120212345678901234 '), '120212345678901234');
  const rounded = analyze({ affiliate: [aff('o1', 500, { 'Tag_link1': 'A' })],
    ads: [ad('2026-08-01', 100, { 'Ad name': 'A', 'Ad ID': '120212345678901000' }),
          ad('2026-08-01', 100, { 'Ad name': 'B', 'Ad ID': '120212345678901000' })] });
  assert.equal(rounded.adUnits.length, 2, 'two ads that rounded to one ID stay two');
}
{
  // A renamed ad keeps the tag its exact name earned; a manual mapping or the
  // current exact name still win over the remembered one.
  const id = '120212345678901234';
  const data = { affiliate: [aff('o1', 500, { 'Tag_link1': 'Kuku' }), aff('o2', 500, { 'Tag_link1': 'Lain' })],
    ads: [ad('2026-08-01', 100, { 'Ad name': 'Kuku baru (salinan)', 'Ad ID': id })], adIdMap: { [id]: 'Kuku' } };
  const r = analyze(data);
  assert.equal(r.matchLog[0].method, 'Ad ID');
  assert.equal(r.matchLog[0].tag, 'Kuku');
  assert.equal(r.tags.find(t => t.tag === 'Kuku').spend, 100);
  assert.deepEqual(r.learnedIds, {}, 'only an exact name teaches');
  assert.equal(analyze({ ...data, tagMap: { kukubarusalinan: 'Lain' } }).matchLog[0].tag, 'Lain');
  const renamedToTag = analyze({ ...data, ads: [ad('2026-08-01', 100, { 'Ad name': 'Lain', 'Ad ID': id })] });
  assert.equal(renamedToTag.matchLog[0].method, 'Exact');
  assert.equal(renamedToTag.learnedIds[id], 'Lain');
}
{
  // Click capture: Shopee clicks on the tag ÷ Meta link clicks on days the ad
  // ran. Under 25% with enough evidence flags the mapping, even on an exact name.
  const days = Array.from({ length: 7 }, (_, i) => `2026-08-0${i + 1}`);
  const ads = days.map(d => ad(d, 100, { 'Ad name': 'Varo', 'Link clicks': 100 }));
  const clicksOn = (n, d, tag) => Array.from({ length: n }, () => click(d, { 'Tag_link': tag + '----' }));
  const low = analyze({ affiliate: [aff('o1', 500, { 'Tag_link1': 'Varo' })], ads,
    clicks: days.flatMap(d => clicksOn(10, d, 'Varo')).concat(clicksOn(500, '2026-08-08', 'Varo')) });
  const cap = low.tags.find(t => t.tag === 'Varo').capture;
  assert.equal(cap.metaClicks, 700);
  assert.equal(cap.shopeeClicks, 70, 'clicks on a day without spend do not count');
  assert.equal(cap.days, 7);
  assert.equal(cap.low, true);
  assert.equal(low.matchLog[0].capture.low, true);
  const short = analyze({ affiliate: [aff('o1', 500, { 'Tag_link1': 'Varo' })], ads: ads.slice(0, 3),
    clicks: clicksOn(10, '2026-08-01', 'Varo') });
  assert.equal(short.tags.find(t => t.tag === 'Varo').capture.low, false, 'too little evidence yet');
  const healthy = analyze({ affiliate: [aff('o1', 500, { 'Tag_link1': 'Varo' })], ads,
    clicks: days.flatMap(d => clicksOn(60, d, 'Varo')) });
  assert.equal(healthy.tags.find(t => t.tag === 'Varo').capture.low, false);
  assert.equal(analyze({ affiliate: [aff('o1')], ads }).tags.find(t => t.tag === 'A').capture, null, 'no click report, no verdict');
}

/* ── Review round 1 ────────────────────────────────────────────────────── */
{
  // Mapping TumblerIG by hand must not take Tumblerig off its exact tag.
  const tags = ['tumblerig', 'Tumblerig'];
  assert.equal(E.matchAdToTag('Tumblerig', tags, { TumblerIG: 'tumblerig' }).method, 'Exact');
  assert.equal(E.matchAdToTag('TumblerIG', tags, { TumblerIG: 'tumblerig' }).method, 'Manual');
  // A mapping in lower case (every mapping saved before case mattered) still
  // holds for any spelling.
  assert.equal(E.matchAdToTag('Telesin Video 2', ['TelesinGripvideo2'], { 'telesin video 2': 'TelesinGripvideo2' }).method, 'Manual');
  assert.equal(E.matchAdToTag('TumblerIG', tags, { tumblerig: 'Tumblerig' }).tag, 'Tumblerig');
}
{
  // A rename inside the period: the older exact name still decides, and is learned.
  const id = '120212345678901234';
  const r = analyze({ affiliate: [aff('o1', 500, { 'Tag_link1': 'Kuku' })],
    ads: [ad('2026-08-01', 100, { 'Ad name': 'Kuku', 'Ad ID': id }), ad('2026-08-02', 100, { 'Ad name': 'Kuku baru (salinan)', 'Ad ID': id })] });
  assert.equal(r.adUnits.length, 1);
  assert.equal(r.matchLog[0].adName, 'Kuku baru (salinan)');
  assert.equal(r.matchLog[0].method, 'Exact (nama lama)');
  assert.equal(r.tags.find(t => t.tag === 'Kuku').spend, 200);
  assert.deepEqual(r.learnedIds, { [id]: 'Kuku' });
}
{
  // "BantalTidur-2309A" in the click report is BantalTidur with slot two
  // filled, not the tag BantalTidur2309A.
  const known = E.tagLookup(['BantalTidur', 'BantalTidur2309A']);
  assert.equal(E.resolveClickTag('BantalTidur-2309A---', known), 'BantalTidur');
  assert.equal(E.resolveClickTag('BantalTidur2309A----', known), 'BantalTidur2309A');
  // A click-only sub_id with slot two filled splits when the click report
  // also shows it alone.
  const r = analyze({ affiliate: [aff('o1', 500)], ads: [ad('2026-08-01', 300, { 'Ad name': 'TesBaru' })],
    clicks: [click('2026-08-01', { 'Tag_link': 'TesBaru----' }), click('2026-08-01', { 'Tag_link': 'TesBaru-promo---', 'Klik ID': 'k2' })] });
  assert.equal(r.matchLog[0].method, 'Exact');
  assert.equal(r.tags.find(t => t.tag === 'TesBaru').shopeeClicks, 2);
  assert.ok(!r.tags.some(t => t.tag === 'TesBaru-promo'), 'no phantom tag');
}
{
  // Every suggestion stays under the "assigned" line, Lemah included.
  for (const [name, tags] of [['Kaos Polos', ['KaosPolosHitamXyz']], ['produk baru solid', ['HelmRsixSolid', 'produk lama']]]) {
    const m = E.matchAdToTag(name, tags, {});
    assert.ok(m.confidence <= 0.45, `${name}: ${m.method} ${m.confidence}`);
  }
}
{
  // A manual correction drops the remembered tag it overrides, so the next
  // rename does not bring the rejected tag back.
  const id = '120212345678901234';
  const r = analyze({ affiliate: [aff('o1', 500, { 'Tag_link1': 'Varo' }), aff('o2', 500, { 'Tag_link1': 'VaroSetelanJumbo1' })],
    ads: [ad('2026-08-01', 100, { 'Ad name': 'Varo', 'Ad ID': id })], tagMap: { Varo: 'VaroSetelanJumbo1' }, adIdMap: { [id]: 'Varo' } });
  assert.equal(r.matchLog[0].tag, 'VaroSetelanJumbo1');
  assert.deepEqual(r.forgetIds, [id]);
  assert.deepEqual(r.learnedIds, {});
}
{
  // A damaged ID joins the one intact ID it can be, and only that one.
  assert.ok(E.idAgrees('1.20212E+17', '120212345678901234'));
  assert.ok(E.idAgrees('120212345678902000', '120212345678901789'), 'rounded up');
  assert.ok(!E.idAgrees('120212345678901000', '120212345678905678'));
  assert.ok(!E.idAgrees('abc', '120212345678905678'));
  const X = '120212345678901234';
  const r = analyze({ affiliate: [aff('o1', 500, { 'Tag_link1': 'Kuku' })],
    ads: [ad('2026-08-01', 100, { 'Ad name': 'Kuku', 'Ad ID': '120212345678901000' }),
          ad('2026-08-01', 900, { 'Ad name': 'Kuku', 'Ad ID': '120212345678906000' }),
          ad('2026-08-02', 100, { 'Ad name': 'Kuku', 'Ad ID': X })] });
  assert.equal(r.adUnits.find(u => u.adId === X).spend, 200);
  assert.equal(r.adUnits.length, 2, "the other ad's spend is not reported as X");
  // A genuine 17-digit ID ending in 00 is not merged into another ad with the same name.
  const g = analyze({ affiliate: [aff('o1', 500, { 'Tag_link1': 'Kuku' })],
    ads: [ad('2026-08-01', 100, { 'Ad name': 'Kuku', 'Ad ID': '23851234567890500' }),
          ad('2026-08-01', 300, { 'Ad name': 'Kuku', 'Ad ID': '23859999999999123' })] });
  assert.equal(g.adUnits.length, 2);
}
{
  // Days the click report does not cover at all are left out of the capture.
  const days = Array.from({ length: 9 }, (_, i) => `2026-08-0${i + 1}`);
  const ads = days.map(d => ad(d, 100, { 'Ad name': 'Varo', 'Link clicks': 100 }));
  const clicks = ['2026-08-01', '2026-08-09'].flatMap(d => Array.from({ length: 90 }, (_, i) => click(d, { 'Tag_link': 'Varo----', 'Klik ID': d + i })));
  const cap = analyze({ affiliate: [aff('o1', 500, { 'Tag_link1': 'Varo' })], ads, clicks }).tags.find(t => t.tag === 'Varo').capture;
  assert.equal(cap.days, 2);
  assert.equal(cap.metaClicks, 200);
  assert.equal(cap.low, false);
}

/* ── Review round 2 ────────────────────────────────────────────────────── */
{
  // A value Excel shows with six digits fits many ads: it only joins an
  // intact ID that carries the same name.
  const r = analyze({ affiliate: [aff('o1', 500, { 'Tag_link1': 'Kuku' }), aff('o2', 500, { 'Tag_link1': 'Mukena' }), aff('o3', 500, { 'Tag_link1': 'Varo' })],
    ads: [ad('2026-08-01', 5000, { 'Ad name': 'Kuku', 'Ad ID': '1.20212E+17' }), ad('2026-08-01', 10000, { 'Ad name': 'Mukena', 'Ad ID': '1.20212E+17' }),
          ad('2026-08-02', 100, { 'Ad name': 'Varo', 'Ad ID': '120212345678901234' })] });
  assert.equal(r.tags.find(t => t.tag === 'Kuku').spend, 5000);
  assert.equal(r.tags.find(t => t.tag === 'Mukena').spend, 10000);
  assert.equal(r.adUnits.find(u => u.adId === '120212345678901234').spend, 100);
}
{
  // A lower-case mapping holds for other spellings, but never takes a name
  // off its own exact sub_id.
  const tags = ['MaskerDuckbill', 'Maskerduckbill'], map = { 'masker duckbill': 'Maskerduckbill' };
  assert.equal(E.matchAdToTag('MaskerDuckbill', tags, map).method, 'Exact');
  assert.equal(E.matchAdToTag('Masker  Duckbill!', tags, map).tag, 'MaskerDuckbill', 'spaces and punctuation are ignored, case is not');
  assert.equal(E.matchAdToTag('masker duckbill', tags, map).method, 'Manual');
  const loud = E.matchAdToTag('MASKER DUCKBILL', tags, map);
  assert.deepEqual([loud.method, loud.tag], ['Manual', 'Maskerduckbill'], 'the lower-case key covers spellings without their own sub_id');
}
{
  // A choice for one ad among copies sharing its name decides for that ad only.
  const id1 = '120212345678901234', id2 = '120212345678905678';
  const r = analyze({ affiliate: [aff('o1', 500, { 'Tag_link1': 'BantalPromo' })],
    ads: [ad('2026-08-01', 100, { 'Ad name': 'Bantal Promo Baru', 'Ad ID': id1 }), ad('2026-08-01', 300, { 'Ad name': 'Bantal Promo Baru', 'Ad ID': id2 })],
    tagMap: { ['id:' + id2]: 'BantalPromo' } });
  assert.equal(r.matchLog.find(m => m.adId === id2).method, 'Manual');
  assert.equal(r.matchLog.find(m => m.adId === id1).method, 'Contains', 'the other copy is still a question');
  assert.equal(r.tags.find(t => t.tag === 'BantalPromo').spend, 300);
}
{
  // Ad IDs leave the CSV export as text, so a spreadsheet keeps all 18 digits.
  const X = require('./export-data.js');
  const r = analyze({ affiliate: [aff('o1')], ads: [ad('2026-08-01', 100, { 'Ad ID': '120212345678901234' })] });
  const out = X.csv(r, { dataset: 'units' });
  assert.match(out, /"=""120212345678901234"""/);
  assert.match(X.csv(r, { dataset: 'matching' }), /"=""120212345678901234"""/);
  assert.match(out, /^﻿"Akun","Periode awal","Periode akhir","Nama iklan","Ad ID",/, 'the header row is plain text');
}

console.log('engine regression tests: PASS');
