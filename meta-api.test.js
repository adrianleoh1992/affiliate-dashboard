'use strict';
// Marketing API client against a fake fetch; no network, synthetic data only.
const assert = require('node:assert/strict');
const test = require('node:test');
const M = require('./meta-api');
const Imp = require('./import-pipeline');
const E = require('./engine');

function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init) => {
    const u = new URL(url);
    calls.push({ url: u, init });
    for (const [match, reply] of routes) {
      if (match(u)) {
        const r = typeof reply === 'function' ? reply(u) : reply;
        return { ok: (r.status || 200) < 400, status: r.status || 200, json: async () => r.body };
      }
    }
    throw new Error('unrouted ' + u);
  };
  fn.calls = calls;
  return fn;
}
const insight = (name, date, spend, extra) => Object.assign({
  ad_id: '9' + name.length, ad_name: name, adset_name: 'Set', campaign_name: 'Camp', account_currency: 'IDR',
  spend: String(spend), impressions: '1000', reach: '800', frequency: '1.25', inline_link_clicks: '40', clicks: '55',
  inline_link_click_ctr: '4', cpm: '15000', actions: [{ action_type: 'landing_page_view', value: '30' }, { action_type: 'link_click', value: '42' }],
  quality_ranking: 'ABOVE_AVERAGE', engagement_rate_ranking: 'UNKNOWN', conversion_rate_ranking: 'BELOW_AVERAGE_20',
  date_start: date, date_stop: date,
}, extra || {});

test('splitRange covers every day once in fixed windows', () => {
  const parts = M.splitRange('2026-08-01', '2026-08-31', 14);
  assert.deepEqual(parts, [
    { since: '2026-08-01', until: '2026-08-14' }, { since: '2026-08-15', until: '2026-08-28' }, { since: '2026-08-29', until: '2026-08-31' }]);
  assert.throws(() => M.splitRange('2026-08-02', '2026-08-01'), /sebelum/);
  assert.throws(() => M.splitRange('2026-02-30', '2026-03-01'), /YYYY-MM-DD/);
  assert.throws(() => M.splitRange('2024-01-01', '2026-01-01'), /maksimal/);
});

test('account ids are normalized and validated', () => {
  assert.equal(M.normalizeAccountId('123456'), 'act_123456');
  assert.equal(M.normalizeAccountId(' act_123456 '), 'act_123456');
  assert.throws(() => M.normalizeAccountId('act_12x'), /tidak valid/);
});

test('daily insights are paged, chunked, and sent with the token only as a query parameter', async () => {
  const fetch = fakeFetch([
    [u => u.pathname.endsWith('/insights') && !u.searchParams.get('after') && JSON.parse(u.searchParams.get('time_range')).since === '2026-08-01',
      { body: { data: [insight('Alpha', '2026-08-01', 100000)], paging: { next: 'https://graph.facebook.com/v24.0/act_1001/insights?after=abc&access_token=OLD' } } }],
    [u => u.searchParams.get('after') === 'abc', { body: { data: [insight('Bravo', '2026-08-02', 50000.5)] } }],
    [u => u.pathname.endsWith('/insights'), { body: { data: [insight('Alpha', '2026-08-03', 0)] } }],
    [u => u.searchParams.get('ids'), { body: { 95: { effective_status: 'ACTIVE', id: '95' } } }],
  ]);
  const api = M.create({ fetch });
  const progress = [];
  const result = await api.fetchDailyInsights('TOKEN123', '1001', '2026-08-01', '2026-08-03', { chunkDays: 2, onProgress: p => progress.push(p.step) });
  assert.equal(result.rows.length, 3);
  assert.deepEqual(progress, [0, 1, 2]);
  for (const call of fetch.calls) {
    assert.equal(call.url.hostname, 'graph.facebook.com');
    assert.equal(call.url.searchParams.getAll('access_token').join(), 'TOKEN123', 'stale paging tokens are replaced, never duplicated');
    assert.equal(call.init.credentials, 'omit');
  }
  const first = fetch.calls[0].url;
  assert.equal(first.searchParams.get('level'), 'ad');
  assert.equal(first.searchParams.get('time_increment'), '1');
  assert.equal(result.delivery.get('95'), 'ACTIVE');
});

test('generated CSV goes through the normal import and reaches the engine unchanged', async () => {
  const result = { account: 'act_1', since: '2026-08-01', until: '2026-08-02', delivery: new Map([['95', 'ACTIVE']]),
    rows: [insight('Alpha', '2026-08-01', '100000.50'), insight('Bravo', '2026-08-02', 2500, { ad_id: '96' })] };
  const parsed = Imp.parseText(M.toCsv(result), { fileName: M.fileName(result) });
  assert.equal(parsed.type, 'ads');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.stats.rejected, 0);
  assert.equal(parsed.issues.filter(x => x.severity === 'error').length, 0);
  assert.equal(parsed.rows[0]['Amount spent (IDR)'], 100000.5);
  assert.equal(parsed.rows[0]['Link clicks'], 42, 'actions:link_click wins over inline_link_clicks, as in the export');
  assert.equal(parsed.rows[0]['Landing page views'], 30);
  assert.equal(parsed.rows[0]['Quality ranking'], 'Above average');
  assert.equal(parsed.rows[0]['Ad delivery'], 'active');
  assert.equal(M.fileName(result), 'meta-api_act_1_2026-08-01_2026-08-02.csv');

  const aff = { 'ID Pemesanan': '1', 'Status Pesanan': 'Selesai', 'Waktu Pemesanan': '2026-08-01 10:00:00', 'Total Komisi per Produk(Rp)': '300000', 'Tag_link1': 'Alpha' };
  const out = E.analyze({ affiliate: [aff], ads: parsed.rows, clicks: [] }, { ppn: 0 });
  const alpha = out.tags.find(t => t.tag === 'Alpha');
  assert.equal(alpha.spend, 100000.5);
});

test('a non-IDR account is refused by the importer instead of mixing currencies', () => {
  const result = { account: 'act_1', since: '2026-08-01', until: '2026-08-01', rows: [insight('Alpha', '2026-08-01', 10, { account_currency: 'USD' })] };
  const parsed = Imp.parseText(M.toCsv(result), { fileName: 'x.csv' });
  assert.equal(parsed.stats.accepted, 0);
  assert.ok(parsed.issues.some(x => x.code === 'unsupported_currency'));
});

test('Graph API errors become actionable messages', async () => {
  const cases = [
    [{ code: 190, error_subcode: 463 }, 'token', /kedaluwarsa/],
    [{ code: 190 }, 'token', /tidak valid/],
    [{ code: 200 }, 'permission', /ads_read/],
    [{ code: 100, error_subcode: 33, message: 'Unsupported get request. Object with ID act_9 does not exist' }, 'permission', /tidak ditemukan.*ads_read/],
    [{ code: 17 }, 'rate', /Batas permintaan/],
    [{ code: 80004 }, 'rate', /Batas permintaan/],
    [{ code: 1 }, 'transient', /persempit/],
    [{ code: 100, message: 'Invalid parameter' }, 'api', /Invalid parameter/],
  ];
  for (const [error, kind, pattern] of cases) {
    const api = M.create({ fetch: fakeFetch([[() => true, { status: 400, body: { error } }]]) });
    await assert.rejects(api.listAdAccounts('T'), err => err.kind === kind && pattern.test(err.message) && !/T\b/.test(err.metaMessage || ''));
  }
  const offline = M.create({ fetch: async () => { throw new TypeError('Failed to fetch'); } });
  await assert.rejects(offline.listAdAccounts('T'), err => err.kind === 'network');
  await assert.rejects(M.create({ fetch: fakeFetch([]) }).listAdAccounts('  '), /Tempel token/);
});

test('a paging link off graph.facebook.com is refused so the token is never sent elsewhere', async () => {
  const fetch = fakeFetch([[u => u.pathname.endsWith('/adaccounts'), { body: { data: [], paging: { next: 'https://evil.example/next' } } }]]);
  await assert.rejects(M.create({ fetch }).listAdAccounts('T'), /tidak dikenali/);
  assert.equal(fetch.calls.length, 1);
});

test('ad accounts are listed with act_ ids', async () => {
  const fetch = fakeFetch([[u => u.pathname.endsWith('/me/adaccounts'),
    { body: { data: [{ id: 'act_22', account_id: '22', name: 'Zulu', currency: 'IDR', timezone_name: 'Asia/Jakarta', account_status: 1 }, { id: 'act_11', account_id: '11', name: 'Alpha', currency: 'USD' }] } }]]);
  const list = await M.create({ fetch }).listAdAccounts('T');
  assert.deepEqual(list.map(a => [a.id, a.name, a.currency]), [['act_11', 'Alpha', 'USD'], ['act_22', 'Zulu', 'IDR']]);
});

test('rows are shaped like the real account data read through the Meta connector', () => {
  // Values copied from a read-only look at a real IDR account (2026-09-10/11):
  // integer IDR spend strings, a paused campaign, UNKNOWN rankings, a row with
  // no link click action, and a zero row with no ad name.
  const result = { account: 'act_710653925376441', since: '2026-09-10', until: '2026-09-11',
    delivery: new Map([['120253309147120616', 'CAMPAIGN_PAUSED'], ['120253694690640616', 'ACTIVE'], ['120253837109020616', 'DISAPPROVED']]),
    rows: [
      { date_start: '2026-09-10', date_stop: '2026-09-10', spend: '0', impressions: '0', account_currency: 'IDR' },
      { ad_id: '120253309147120616', ad_name: 'BantalTidur', campaign_name: '100826 | TST | JWA | BBA | BantalTidur', adset_name: 'Interest Spec | All | FB | 25-55',
        account_currency: 'IDR', spend: '21697', impressions: '7072', reach: '7072', frequency: '1', clicks: '1419', inline_link_clicks: '1460',
        actions: [{ action_type: 'link_click', value: '1471' }, { action_type: 'landing_page_view', value: '449' }],
        quality_ranking: 'UNKNOWN', engagement_rate_ranking: 'UNKNOWN', conversion_rate_ranking: 'UNKNOWN', date_start: '2026-09-10', date_stop: '2026-09-10' },
      { ad_id: '120253694690640616', ad_name: 'KipasSaluranPembuangan', account_currency: 'IDR', spend: '11825', impressions: '1755', reach: '1739', frequency: '1.009201',
        clicks: '116', actions: [{ action_type: 'link_click', value: '75' }, { action_type: 'landing_page_view', value: '8' }],
        quality_ranking: 'AVERAGE', engagement_rate_ranking: 'ABOVE_AVERAGE', conversion_rate_ranking: 'ABOVE_AVERAGE', date_start: '2026-09-10', date_stop: '2026-09-10' },
      { ad_id: '120253837109020616', ad_name: 'AlunaOversizeAtasanVIDEO1', account_currency: 'IDR', spend: '95', impressions: '20', reach: '20', frequency: '1', clicks: '0',
        date_start: '2026-09-11', date_stop: '2026-09-11' },
    ] };
  const parsed = Imp.parseText(M.toCsv(result), { fileName: M.fileName(result) });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.stats.rejected, 0, 'the nameless zero row is dropped, not rejected');
  assert.equal(parsed.rows.length, 3);
  const [bantal, kipas, aluna] = parsed.rows;
  assert.equal(bantal['Amount spent (IDR)'], 21697);
  assert.equal(bantal['Link clicks'], 1471);
  assert.equal(bantal['Ad delivery'], 'inactive');
  assert.equal(bantal['Quality ranking'], '', 'UNKNOWN is not counted as a ranking');
  assert.equal(kipas['Ad delivery'], 'active');
  assert.equal(kipas['Engagement rate ranking'], 'Above average');
  assert.equal(aluna['Link clicks'], 0);
  assert.equal(aluna['Ad delivery'], 'rejected');
  assert.equal(aluna['Landing page views'], '', 'missing optional metric stays empty, not zero');
});

test('the same ad name in two campaigns on one day keeps both rows', () => {
  // Real accounts relaunch an ad under the same name (e.g. BantalTidur in two
  // campaigns). Ad ID keeps the rows distinct so whole-row dedupe cannot
  // drop one; the engine then sums them under the shared name/tag.
  const row = id => insight('BantalTidur', '2026-09-10', 1000, { ad_id: id });
  const result = { account: 'act_1', since: '2026-09-10', until: '2026-09-10', rows: [row('111'), row('222')] };
  const parsed = Imp.parseText(M.toCsv(result), { fileName: 'x.csv' });
  assert.equal(parsed.rows.length, 2);
  assert.notEqual(JSON.stringify(parsed.rows[0]), JSON.stringify(parsed.rows[1]));
  const aff = { 'ID Pemesanan': '1', 'Status Pesanan': 'Selesai', 'Waktu Pemesanan': '2026-09-10 10:00:00', 'Total Komisi per Produk(Rp)': '5000', 'Tag_link1': 'BantalTidur' };
  const out = E.analyze({ affiliate: [aff], ads: parsed.rows, clicks: [] }, { ppn: 0 });
  assert.equal(out.tags.find(t => t.tag === 'BantalTidur').spend, 2000);
});

test('deleted and archived ads are requested, and a refused status filter falls back without losing the pull', async () => {
  let refuse = true;
  const fetch = fakeFetch([
    [u => u.pathname.endsWith('/insights') && u.searchParams.get('level') === 'ad' && u.searchParams.get('filtering') && refuse,
      { status: 400, body: { error: { code: 100, message: 'Invalid filtering field' } } }],
    [u => u.pathname.endsWith('/insights') && u.searchParams.get('level') === 'ad', { body: { data: [insight('Alpha', '2026-08-01', 100)] } }],
    [u => u.pathname.endsWith('/insights'), { body: { data: [{ spend: '100', date_start: '2026-08-01', date_stop: '2026-08-01' }] } }],
    [u => u.searchParams.get('ids'), { body: {} }],
  ]);
  const api = M.create({ fetch });
  refuse = false;
  let result = await api.fetchDailyInsights('T', '1001', '2026-08-01', '2026-08-01');
  const filter = JSON.parse(fetch.calls[0].url.searchParams.get('filtering'));
  assert.equal(filter[0].field, 'ad.effective_status');
  assert.equal(filter[0].operator, 'IN');
  for (const status of ['ACTIVE', 'PAUSED', 'ARCHIVED', 'DELETED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED']) assert.ok(filter[0].value.includes(status), status);
  assert.equal(result.filtered, true);
  refuse = true;
  result = await api.fetchDailyInsights('T', '1001', '2026-08-01', '2026-08-01');
  assert.equal(result.filtered, false);
  assert.equal(result.rows.length, 1);
  assert.deepEqual(result.gaps, []);
});

test('spend the ad rows do not explain is reported per day', async () => {
  const fetch = fakeFetch([
    [u => u.pathname.endsWith('/insights') && u.searchParams.get('level') === 'ad',
      { body: { data: [insight('Alpha', '2026-08-01', 100), insight('Alpha', '2026-08-02', 200), insight('Bravo', '2026-08-02', 300, { ad_id: '96' })] } }],
    // Account-level daily totals: 2 Aug has 5.000 more than its ad rows (a
    // deleted ad), 1 Aug differs by rounding only.
    [u => u.pathname.endsWith('/insights'), { body: { data: [
      { spend: '101', date_start: '2026-08-01', date_stop: '2026-08-01' }, { spend: '5500', date_start: '2026-08-02', date_stop: '2026-08-02' }] } }],
    [u => u.searchParams.get('ids'), { body: {} }],
  ]);
  const result = await M.create({ fetch }).fetchDailyInsights('T', '1001', '2026-08-01', '2026-08-02');
  assert.deepEqual(result.gaps, [{ date: '2026-08-02', total: 5500, ads: 500, missing: 5000 }]);
  const totals = fetch.calls.find(c => !c.url.searchParams.get('level') && c.url.pathname.endsWith('/insights')).url;
  assert.equal(totals.searchParams.get('fields'), 'spend');
  assert.equal(totals.searchParams.get('time_increment'), '1');
});

test('current status and rankings sit on each ad\'s latest row only, so earlier rows hash the same on every re-pull', () => {
  const Daily = require('./daily-agg');
  const rows = status => ({ account: 'act_1', since: '2026-08-01', until: '2026-08-03', delivery: new Map([['95', status]]),
    rows: [insight('Alpha', '2026-08-01', 100), insight('Alpha', '2026-08-02', 100), insight('Alpha', '2026-08-03', 100)] });
  const first = Imp.parseText(M.toCsv(rows('ACTIVE')), { fileName: 'a.csv' }).rows;
  const again = Imp.parseText(M.toCsv(rows('PAUSED')), { fileName: 'b.csv' }).rows;
  assert.deepEqual(first.map(r => r['Ad delivery']), ['', '', 'active']);
  assert.deepEqual(first.map(r => r['Quality ranking']), ['', '', 'Above average']);
  assert.equal(again[2]['Ad delivery'], 'inactive');
  assert.equal(Daily.hashRow(first[0]), Daily.hashRow(again[0]));
  assert.equal(Daily.hashRow(first[1]), Daily.hashRow(again[1]));
  const aff = { 'ID Pemesanan': '1', 'Status Pesanan': 'Selesai', 'Waktu Pemesanan': '2026-08-01 10:00:00', 'Total Komisi per Produk(Rp)': '500', 'Tag_link1': 'Alpha' };
  const unit = E.analyze({ affiliate: [aff], ads: again, clicks: [] }, { ppn: 0 }).adUnits.find(u => u.adName === 'Alpha');
  assert.equal(unit.delivery, 'inactive');
  assert.equal(unit.active, false);
});

test('a cancel that lands while the body is read stays a cancel', async () => {
  const controller = new AbortController();
  const fetch = async () => ({ ok: true, status: 200, json: async () => { controller.abort(); const e = new Error('aborted'); e.name = 'AbortError'; throw e; } });
  await assert.rejects(M.create({ fetch }).listAdAccounts('T', controller.signal), err => err.name === 'AbortError');
});

test('yesterday follows the ad account timezone', () => {
  const now = new Date('2026-10-18T01:00:00Z'); // 08:00 in Jakarta, still 17 Oct in Los Angeles
  assert.equal(M.accountYesterday('Asia/Jakarta', now), '2026-10-17');
  assert.equal(M.accountYesterday('America/Los_Angeles', now), '2026-10-16');
  assert.ok(M.isDate(M.accountYesterday('Not/AZone', now)), 'an unknown zone falls back to the browser date');
});
