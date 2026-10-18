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
  inline_link_click_ctr: '4', cpm: '15000', actions: [{ action_type: 'landing_page_view', value: '30' }],
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
  assert.equal(result.delivery.get('95'), 'active');
});

test('generated CSV goes through the normal import and reaches the engine unchanged', async () => {
  const result = { account: 'act_1', since: '2026-08-01', until: '2026-08-02', delivery: new Map([['95', 'active']]),
    rows: [insight('Alpha', '2026-08-01', '100000.50'), insight('Bravo', '2026-08-02', 2500)] };
  const parsed = Imp.parseText(M.toCsv(result), { fileName: M.fileName(result) });
  assert.equal(parsed.type, 'ads');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.stats.rejected, 0);
  assert.equal(parsed.issues.filter(x => x.severity === 'error').length, 0);
  assert.equal(parsed.rows[0]['Amount spent (IDR)'], 100000.5);
  assert.equal(parsed.rows[0]['Link clicks'], 40);
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
