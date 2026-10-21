'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('./placement');

const row = (name, platform, placement, spend, clicks, dates = ['2026-08-01', '2026-08-07']) => ({
  'Reporting starts': dates[0], 'Reporting ends': dates[1], 'Ad name': name, Platform: platform, Placement: placement,
  'Amount spent (IDR)': spend, Impressions: clicks * 20, 'Link clicks': clicks,
});
const order = (id, tag, platform, comm, status = 'Selesai') => ({
  'ID Pemesanan': id, 'Status Pesanan': status, 'Waktu Pemesanan': '2026-08-03 10:00:00',
  'Total Komisi per Produk(Rp)': comm, 'Tag_link1': tag, Platform: platform,
});
const click = (tag, src) => ({ 'Waktu Klik': '2026-08-03 09:00:00', 'Tag_link': tag + '----', Perujuk: src });
const matchLog = [{ adName: 'Ad A', tag: 'Alpha', spend: 1 }, { adName: 'Ad B', tag: 'Bravo', spend: 1 }];

test('platform totals join Meta spend with Shopee clicks and commission', () => {
  const r = P.analyze({
    placement: [row('Ad A', 'Facebook', 'Feed', 600, 60), row('Ad A', 'Facebook', 'Facebook Reels', 400, 20), row('Ad A', 'Instagram', 'Instagram Reels', 500, 50)],
    affiliate: [order('1', 'Alpha', 'Facebook', 1200), order('2', 'Alpha', 'Instagram', 250), order('3', 'Alpha', 'Others', 99),
      order('4', 'Alpha', 'Facebook', 5000, 'Dibatalkan'), order('5', 'Organic', 'Facebook', 7000)],
    clicks: [click('Alpha', 'Facebook'), click('Alpha', 'Instagram'), click('Organic', 'Facebook')],
    matchLog,
  });
  const fb = r.platforms.find(p => p.platform === 'Facebook'), ig = r.platforms.find(p => p.platform === 'Instagram');
  assert.equal(fb.spend, 1000);
  assert.equal(fb.comm, 1200, 'cancelled orders and tags without ads are left out');
  assert.equal(fb.roas, 1.2);
  assert.equal(fb.shopeeClicks, 1);
  assert.equal(ig.roas, 0.5);
  assert.equal(r.platforms.find(p => p.platform === P.OTHER).comm, 99);
  assert.deepEqual(r.otherSources, [{ source: 'Others', shopeeClicks: 0, orders: 1, comm: 99 }]);
  assert.equal(r.total.orders, 3);
  // Facebook commission splits 3:1 by link clicks between Feed and Reels.
  const feed = r.placements.find(p => p.placement === 'Feed'), reels = r.placements.find(p => p.placement === 'Facebook Reels');
  assert.equal(feed.estComm, 900);
  assert.equal(reels.estComm, 300);
  assert.equal(r.daily, false);
});

test('daily rows follow the date filter; unmatched ads stay visible', () => {
  const r = P.analyze({
    placement: [row('Ad A', 'Facebook', 'Feed', 100, 10, ['2026-08-01', '2026-08-01']), row('Ad A', 'Facebook', 'Feed', 300, 30, ['2026-08-02', '2026-08-02']),
      row('Ad X', 'Facebook', 'Feed', 50, 5, ['2026-08-02', '2026-08-02'])],
    affiliate: [], clicks: [], matchLog, range: { start: '2026-08-02', end: '2026-08-02' },
  });
  assert.equal(r.total.spend, 350);
  assert.equal(r.unmatchedSpend, 50);
  assert.equal(r.daily, true);
});

test('no placement rows gives no breakdown', () => {
  assert.equal(P.analyze({ placement: [] }), null);
});
