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

console.log('engine regression tests: PASS');
