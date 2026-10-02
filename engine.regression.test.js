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
assert.equal(taxTag.leak.wasted, null); // A count difference cannot prove wasted spend.
assert.equal(taxTag.leak.difference, 9);
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
  coverage: { ads: { start: '2026-08-01', end: '2026-08-06', confirmed: true } },
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
const lineItems = analyze({ sourceState: { ads: 'none' }, affiliate: [aff('same', 40), aff('same', 60), aff('pending', 100, { 'Status Pesanan': ' Tertunda ' })] });
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
const maturity = analyze({ affiliate: [aff('1', 300)], ads: [ad(), ad('2026-08-02', 1000)], coverage: { affiliate: { start: '2026-08-01', end: '2026-08-02', confirmed: true } } }, { lagDays: 1 });
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

// An inactive latest row must override an older active delivery state.
const inactive = analyze({ ads: [ad(), ad('2026-08-02', 100, { 'Ad delivery': 'inactive' })] });
assert.equal(inactive.adUnits[0].active, false);
assert.equal(inactive.adUnits[0].delivery, 'inactive');
assert.equal(analyze({ ads: [ad('2026-08-01', 100, { 'Ad delivery': 'tidak aktif' })] }).adUnits[0].active, false);

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
const organicPending = analyze({ sourceState: { ads: 'none' }, affiliate: [aff('organic-pending', 100, { 'Status Pesanan': 'Tertunda' })] },
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


// Missing Meta is unknown; a deliberate no-Meta declaration establishes zero.
const missingCosts = analyze({ affiliate: [aff('unknown-cost', 300)] });
assert.equal(missingCosts.kpi.spend, null, 'a missing Meta report must not be zero spend');
assert.equal(missingCosts.kpi.netEff, null);
assert.equal(missingCosts.tags[0].status, 'evaluasi');
assert.equal(missingCosts.actions.organicCandidates.length, 0);
const noMeta = analyze({ affiliate: [aff('declared-zero', 300)], sourceState: { ads: 'none' } });
assert.equal(noMeta.daily[0].hasAds, true, 'Explicit no-Meta costs must remain known zero in daily consumers');
assert.equal(noMeta.kpi.spend, 0);
assert.equal(noMeta.readiness.costsKnown, true);
assert.equal(noMeta.tags[0].label, 'Tanpa biaya Meta terdeteksi');
const partialCosts = analyze({ affiliate: [aff('partial', 300)], ads: [ad()], sourceState: { ads: 'partial' } });
assert.equal(partialCosts.kpi.spend, null);
assert.equal(partialCosts.readiness.observedSpend, 100);
assert.equal(partialCosts.matchLog[0].spend, 100, 'queue keeps observed spend even while full costs unknown');
assert.equal(partialCosts.tags[0].netEff, null);
assert.equal(partialCosts.adUnits[0].roasEff, null);
assert.equal(partialCosts.daily[0].spend, null);
const gappedCosts = analyze({ affiliate: [aff('gap', 300)], ads: [ad(), ad('2026-08-03')] });
assert.equal(gappedCosts.readiness.costsKnown, false, 'unobserved dates are not assumed zero');
const confirmedCoverage = { ads: { start: '2026-08-01', end: '2026-08-03', confirmed: true }, affiliate: { start: '2026-08-01', end: '2026-08-03', confirmed: true } };
const confirmedGap = analyze({ affiliate: [aff('gap-confirmed', 300)], ads: [ad(), ad('2026-08-03')], coverage: confirmedCoverage });
assert.equal(confirmedGap.kpi.spend, 200);
assert.equal(confirmedGap.readiness.coverage.ads.basis, 'confirmed');

// Paid rows without attribution cannot create paid advice or organic expansion.
const unmatchedDecision = analyze({ affiliate: [aff('other-tag', 1000, { 'Tag_link1': 'OrganicCandidate' })], ads: [ad('2026-08-01', 100, { 'Ad name': 'Unrelated paid creative' })] });
assert.equal(unmatchedDecision.adUnits[0].status, 'evaluasi');
assert.equal(unmatchedDecision.actions.stopCount, 0);
assert.equal(unmatchedDecision.actions.organicCandidates.length, 0);
assert.equal(unmatchedDecision.readiness.unresolvedUnits, 1);
const ambiguousDecision = analyze({ affiliate: [aff('v', 300, { 'Tag_link1': 'AtasanViolet' }), aff('r', 300, { 'Tag_link1': 'AtasanRebecca' })], ads: [ad('2026-08-01', 100, { 'Ad name': 'Atasan' })] });
assert.ok(ambiguousDecision.tags.every(t => t.status === 'evaluasi'));
assert.ok(ambiguousDecision.tags.find(t => t.tag === 'AtasanViolet').blockers.length);

// Accounting stays on order dates. H+3 revenue is attached to its click cohort,
// including a later order month only when an explicit observation cutoff allows it.
const crossMonthInput = {
  affiliate: [aff('late-order', 300, { 'Waktu Pemesanan': '2026-09-03 10:00:00', 'Waktu Klik': '2026-08-31 09:00:00' })],
  ads: [ad('2026-08-31')],
  coverage: { affiliate: { start: '2026-08-31', end: '2026-09-03', confirmed: true } },
};
const crossMonthOptions = { dateStart: '2026-08-31', dateEnd: '2026-08-31', lagDays: 3, observationEnd: '2026-09-03' };
const crossMonth = analyze(crossMonthInput, crossMonthOptions);
assert.equal(crossMonth.kpi.comm, 0, 'September commission must not change August accounting');
assert.equal(crossMonth.tags[0].matureCommEff, 300);
assert.equal(crossMonth.tags[0].matureRoasEff, 3);
assert.equal(crossMonth.tags[0].status, 'scale');
assert.equal(crossMonth.range.observationEnd, '2026-09-03');
assert.equal(crossMonth.daily[0].comm, 0);
assert.equal(analyze(crossMonthInput, { ...crossMonthOptions, observationEnd: undefined }).tags[0].matureCommEff, 0);
const preWindow = analyze({ affiliate: [aff('old-click', 900, { 'Waktu Klik': '2026-07-31 09:00:00' })], ads: [ad()] });
assert.equal(preWindow.kpi.comm, 900);
assert.equal(preWindow.tags[0].matureCommEff, 0);
assert.equal(preWindow.tags[0].status, 'stop', 'old clicks do not fund current production');
for (const clickAt of ['', 'invalid', '2026-08-02 09:00:00', '2026-08-01 99:00:00', '2026-08-01 11:00:00']) {
  const invalidCohort = analyze({ affiliate: [aff('missing-click', 900, { 'Waktu Klik': clickAt })], ads: [ad()] });
  assert.equal(invalidCohort.kpi.comm, 900);
  assert.equal(invalidCohort.tags[0].matureCommEff, 0);
  assert.equal(invalidCohort.tags[0].status, 'evaluasi', 'unknown or impossible click date cannot drive STOP');
  assert.equal(invalidCohort.tags[0].decisionReady, false);
}

// Two same-name IDs map independently; dimension rows of one identity sum.
const identityData = {
  affiliate: [aff('id-a', 300, { 'Tag_link1': 'TagA' }), aff('id-b', 100, { 'Tag_link1': 'TagB' })],
  ads: [ad('2026-08-01', 30, { 'Ad name': 'Shared name', 'Ad ID': '001' }), ad('2026-08-01', 70, { 'Ad name': 'Shared name', 'Ad ID': '001', Age: '25-34' }), ad('2026-08-01', 200, { 'Ad name': 'Shared name', 'Ad ID': '002' })],
  tagMap: { sharedname: 'TagB', '@id:001': 'TagA' },
};
const identities = analyze(identityData);
assert.equal(identities.adUnits.length, 2);
const firstIdentity = identities.adUnits.find(u => u.adId === '001');
assert.equal(firstIdentity.spend, 100);
assert.equal(firstIdentity.tag, 'TagA');
assert.equal(firstIdentity.mappingScope, 'identity');
assert.equal(identities.adUnits.find(u => u.adId === '002').mappingScope, 'name');
assert.equal(E.adIdentity({ 'Ad name': 'Same', 'Date created': '2026-08-01' }).adKey, 'created:["Same","2026-08-01"]');
assert.notEqual(E.adIdentity({ 'Ad name': 'Same' }).adKey, E.adIdentity({ 'Ad name': 'same' }).adKey);
assert.equal(firstIdentity.mapKey, '@id:001');
const noSale = analyze({ affiliate: [], ads: [ad('2026-08-01', 100, { 'Ad name': 'NoSale' })], clicks: [click('2026-08-01', { 'Tag_link': 'NoSale----' })], sourceState: { affiliate: 'loaded' }, coverage: { affiliate: { start: '2026-08-01', end: '2026-08-01', confirmed: true } } });
assert.deepEqual(noSale.observedTags, ['NoSale']);
assert.equal(noSale.matchLog[0].method, 'Exact');
assert.equal(noSale.tags[0].status, 'stop', 'complete zero sales can still be evaluated');

// Unknowns persist across serialization and trend deltas, never a fake rise from zero.
const unknownSnap = E.toSnapshot(missingCosts, { account: 'unknown', saved: '2026-08-02' });
const knownSnap = E.toSnapshot(noMeta, { account: 'unknown', saved: '2026-08-03' });
knownSnap.range = { ...knownSnap.range, start: '2026-08-02', end: '2026-08-02' };
const unknownTrend = E.buildTrend([JSON.parse(JSON.stringify(unknownSnap)), knownSnap], 'unknown');
assert.equal(unknownSnap.readiness.costsKnown, false);
assert.equal(unknownSnap.tags[0].decisionReady, false);
assert.equal(unknownTrend.series[0].spend, null);
assert.equal(unknownTrend.delta.spend, null);
assert.equal(unknownTrend.delta.netEff, null);
assert.equal(unknownTrend.movers[0].delta, null);

// Extending observation without report coverage cannot manufacture mature evidence.
const uncoveredFuture = analyze({ affiliate: [aff('today', 300)], ads: [ad()] }, { observationEnd: '2026-08-04', lagDays: 3 });
assert.equal(uncoveredFuture.tags[0].status, 'evaluasi');
assert.equal(uncoveredFuture.readiness.decisionReady, false);
const cutoffInput = { ...crossMonthInput, affiliate: [...crossMonthInput.affiliate,
  aff('after-cutoff', 5000, { 'Waktu Pemesanan': '2026-09-04 10:00:00', 'Waktu Klik': '2026-08-31 09:00:00' })] };
assert.equal(analyze(cutoffInput, crossMonthOptions).tags[0].matureCommEff, 300);
assert.ok(crossMonth.tags[0].cpcIdeal > crossMonth.tags[0].cpc,
  'a profitable observed cohort must not get a zero bid ceiling from its zero order-date commission');
assert.equal(crossMonth.actions.overbidCount, 0);
const identitySharedTag = analyze({ ...identityData, tagMap: { sharedname: 'TagA' } });
assert.equal(identitySharedTag.tags.find(t => t.tag === 'TagA').activeUnits, 2);
const missingSnapshot = E.toSnapshot(analyze({ ads: [ad()], sourceState: { ads: 'partial' } }));
assert.equal(missingSnapshot.tags.length, 1, 'unknown-cost paid rows must remain in snapshots');
assert.equal(missingSnapshot.tags[0].spend, null);
assert.equal(E.buildTrend([first], 'a').series[0].readiness.basis, 'legacy-order-date');

const conflictingNone = analyze({ affiliate: [aff('conflict', 500)], ads: [ad()], sourceState: { ads: 'none' } });
assert.equal(conflictingNone.readiness.costsKnown, false);
assert.equal(conflictingNone.readiness.observedSpend, 100);
assert.equal(conflictingNone.matchLog[0].spend, 100);
assert.equal(conflictingNone.kpi.spend, null, 'conflicting declaration blocks completeness, not observed diagnostics');
assert.equal(conflictingNone.tags[0].status, 'evaluasi');
assert.equal(analyze({ affiliate: [aff('partial-aff', 300)], sourceState: { ads: 'none', affiliate: 'partial' } }).actions.organicCandidates.length, 0);
assert.equal(analyze({ affiliate: [aff('no-click', 300, { 'Waktu Klik': '' })], sourceState: { ads: 'none' } }).actions.organicCandidates.length, 0);
const legacyNoSale = analyze({ affiliate: [], ads: [ad()], tagMap: { a: 'HistoricTag' }, sourceState: { affiliate: 'loaded' }, coverage: { affiliate: { start: '2026-08-01', end: '2026-08-01', confirmed: true } } });
assert.equal(legacyNoSale.tags[0].matureCommEff, 0);
assert.equal(legacyNoSale.tags[0].status, 'stop');
assert.equal(analyze({ ads: [ad()], tagMap: { a: 'HistoricTag' } }).tags[0].status, 'evaluasi');
assert.equal(crossMonth.lagCal.sampleSize, 1, 'lag calibration includes explicitly observed later orders');
assert.equal(crossMonth.lagCal.suggested, 3);

console.log('engine regression tests (including readiness, identity and click cohorts): PASS');

const earlyObservation = analyze({affiliate:[aff('early',300)],ads:[ad(),ad('2026-08-02'),ad('2026-08-03')]}, {dateStart:'2026-08-01',dateEnd:'2026-08-03',observationEnd:'2026-08-01'});
assert.equal(earlyObservation.readiness.observationEnd,'2026-08-03','Observation cutoff cannot shorten accounting coverage');
assert.equal(earlyObservation.readiness.decisionReady,false);

const laterClickTag = analyze({ads:[ad('2026-08-01',100,{'Ad name':'ClickOnlyTag'})], clicks:[click('2026-09-01',{'Tag_link':'ClickOnlyTag----'})]}, {dateStart:'2026-08-01',dateEnd:'2026-08-01'});
assert.ok(laterClickTag.observedTags.includes('ClickOnlyTag'),'Imported click-only tags stay selectable across a date filter');
assert.equal(laterClickTag.matchLog[0].method,'Exact');
assert.equal(laterClickTag.kpi.shopeeClicks,0,'Tag authority must not change selected click totals');
