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

{
  // Direct vs indirect orders per tag, read from Shopee's attribution column.
  const T = 'Tipe Atribusi';
  for (const [v, k] of [
    // Shopee's own wording, column "Tipe Pesanan" (report of 21 Oct 2026).
    ['Pesanan Produk dari Toko yang Dipromosikan', 'direct'], ['Pesanan dari Toko yang tidak Dipromosikan', 'indirect'],
    ['Pesanan Langsung', 'direct'], ['Pesanan Tidak Langsung', 'indirect'],
    ['Pesanan di Toko yang Sama', 'direct'], ['Pesanan di Toko Berbeda', 'indirect'],
    ['Direct', 'direct'], ['Indirect', 'indirect'], ['Ordered in Same Shop', 'direct'],
    ['Ordered in Different Shop', 'indirect'], ['', ''], ['Lainnya', ''], ['XTRA', '']]) {
    assert.equal(E.attrKind(v), k, v);
  }
  const real = analyze({ affiliate: [aff('o1', 9, { 'Tipe Pesanan': 'Pesanan dari Toko yang tidak Dipromosikan' })] });
  assert.equal(real.attribution.column, 'Tipe Pesanan');
  assert.equal(real.attribution.total.indirect.orders, 1);
  const r = analyze({ affiliate: [
    aff('o1', 100, { [T]: 'Pesanan Langsung' }),
    aff('o1', 50, { [T]: 'Pesanan Langsung' }),                 // second item, same order
    aff('o2', 30, { [T]: 'Pesanan Tidak Langsung' }),
    aff('o3', 20, { [T]: 'Pesanan Tidak Langsung', 'Status Pesanan': 'Tertunda' }),
    aff('o4', 40, { [T]: 'Pesanan Langsung', 'Status Pesanan': 'Dibatalkan' }),  // excluded
    aff('o5', 10, { [T]: 'Pesanan Langsung', 'Tag_link1': 'B' }),
    aff('o5', 5, { [T]: 'Pesanan Tidak Langsung', 'Tag_link1': 'B' }),          // mixed order
    aff('o6', 7, { [T]: '???', 'Tag_link1': 'B' }),                           // never guessed
  ] }, { pendingFactor: 0.5 });
  assert.equal(r.attribution.column, T);
  const a = r.tags.find(t => t.tag === 'A').attr;
  assert.equal(a.direct.orders, 1); near(a.direct.comm, 150);
  assert.equal(a.indirect.orders, 2); near(a.indirect.comm, 50); near(a.indirect.commEff, 40);
  assert.equal(a.unknown.rows, 0); assert.equal(a.mixed, 0);
  const b = r.tags.find(t => t.tag === 'B');
  assert.equal(b.attr.mixed, 1); assert.equal(b.attr.direct.orders, 1); assert.equal(b.attr.indirect.orders, 1);
  assert.equal(b.attr.unknown.orders, 1); near(b.attr.unknown.comm, 7);
  assert.equal(b.attrDirectOrders, 1); near(b.attrIndirectComm, 5);
  const tot = r.attribution.total;
  assert.equal(tot.direct.orders, 2); assert.equal(tot.indirect.orders, 3); assert.equal(tot.mixed, 1);
  near(tot.direct.comm + tot.indirect.comm + tot.unknown.comm, r.kpi.comm);
  assert.deepEqual(r.attribution.unknownValues, [{ value: '???', rows: 1 }]);

  // A header Shopee might rename is still found by its word.
  assert.equal(analyze({ affiliate: [aff('o1', 1, { 'Atribusi Pesanan': 'Langsung' })] }).attribution.column, 'Atribusi Pesanan');

  // No column: nothing is invented, and the export leaves the cells empty.
  const none = analyze({ affiliate: [aff('o1')] });
  assert.equal(none.attribution.column, '');
  assert.equal(none.tags[0].attrDirectOrders, null);
  const X = require('./export-data.js');
  assert.match(X.csv(none), /"Order","Pesanan langsung","Komisi langsung"/);
  assert.match(X.csv(r), /"Pesanan tidak langsung"/);
}

console.log('engine regression tests: PASS');
