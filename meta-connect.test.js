'use strict';

// Ads Manager connection in a real browser against a mocked Graph API.
// Synthetic data only; any request outside the local server and the mocked
// graph.facebook.com fails the test.
const assert = require('node:assert/strict');
const { createHarness, aff, ad, upload } = require('./browser.regression.test');

const insight = (name, date, spend) => ({
  ad_id: String(100 + name.length), ad_name: name, adset_name: 'Set', campaign_name: 'Camp', account_currency: 'IDR',
  spend: String(spend), impressions: '1000', reach: '800', inline_link_clicks: '10', clicks: '12',
  date_start: date, date_stop: date,
});

function graph(state) {
  return async route => {
    const u = new URL(route.request().url());
    state.calls.push(u);
    const reply = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(body) });
    if (state.error) return reply({ error: state.error }, 400);
    if (u.pathname.endsWith('/me/adaccounts')) return reply({ data: [{ id: 'act_555', account_id: '555', name: 'Synthetic Ads', currency: 'IDR' }] });
    if (u.pathname.endsWith('/act_555/insights')) {
      const { since, until } = JSON.parse(u.searchParams.get('time_range'));
      return reply({ data: state.rows.filter(r => r.date_start >= since && r.date_start <= until) });
    }
    if (u.searchParams.get('ids')) return reply({});
    return reply({ error: { code: 100, message: 'unexpected ' + u.pathname } }, 400);
  };
}

async function openMeta(page, token = 'SYNTH_TOKEN') {
  await page.locator('#btnMeta').click();
  await page.locator('#metaToken').fill(token);
  await page.locator('#btnMetaAccounts').click();
  await page.waitForFunction(() => document.getElementById('metaAccount').value === 'act_555');
}
async function pull(page, since, until) {
  await page.locator('#metaSince').fill(since);
  await page.locator('#metaUntil').fill(until);
  await page.locator('#btnMetaPull').click();
}
const spend = (page, tag) => page.evaluate(t => (RESULT.tags.find(x => x.tag === t) || { spend: 0 }).spend, tag);
const adsChips = page => page.locator('[data-zchips="ads"] .fname').allInnerTexts();

async function main() {
  const harness = await createHarness(), cases = [];
  const test = (name, fn) => cases.push({ name, fn });

  test('pulled Meta data lands in the ads box and in the analysis', async (page, state) => {
    state.rows = [insight('Alpha', '2026-08-01', 100), insight('Bravo', '2026-08-02', 300)];
    await page.evaluate(() => { document.getElementById('ppn').value = '0'; });
    await upload(page, [{ name: 'affiliate.csv', rows: [aff('1', 'Alpha'), aff('2', 'Bravo', '2026-08-02')] }]);
    await openMeta(page);
    await pull(page, '2026-08-01', '2026-08-02');
    await page.locator('#metaModal').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => RESULT && RESULT.kpi.spend > 0);
    assert.deepEqual(await adsChips(page), ['meta-api_act_555_2026-08-01_2026-08-02.csv']);
    assert.equal(await spend(page, 'Alpha'), 100);
    assert.equal(await spend(page, 'Bravo'), 300);
    for (const u of state.calls) assert.equal(u.searchParams.get('access_token'), 'SYNTH_TOKEN');
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('adash_meta_v1_default')));
    assert.deepEqual(Object.keys(saved).sort(), ['adAccountId', 'adAccountName', 'lastPull']);
    assert.equal(saved.adAccountId, 'act_555');
    assert.doesNotMatch(await page.evaluate(() => JSON.stringify(localStorage)), /SYNTH_TOKEN/, 'token is not persisted unless asked');
    // Daily storage sees it like any export.
    await page.waitForFunction(() => !document.getElementById('ingestPlan').classList.contains('hidden'));
  });

  test('pulling again replaces the earlier pull instead of double counting', async (page, state) => {
    state.rows = [insight('Alpha', '2026-08-01', 100), insight('Alpha', '2026-08-02', 50)];
    await page.evaluate(() => { document.getElementById('ppn').value = '0'; });
    await upload(page, [{ name: 'affiliate.csv', rows: [aff('1', 'Alpha')] }]);
    await openMeta(page);
    await pull(page, '2026-08-01', '2026-08-02');
    await page.locator('#metaModal').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => RESULT && RESULT.kpi.spend === 150);
    state.rows = [insight('Alpha', '2026-08-01', 100), insight('Alpha', '2026-08-02', 80), insight('Alpha', '2026-08-03', 20)];
    await page.locator('#btnMeta').click();
    await pull(page, '2026-08-02', '2026-08-03');
    await page.locator('#metaModal').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => RESULT && RESULT.kpi.spend === 200);
    assert.deepEqual(await adsChips(page), ['meta-api_act_555_2026-08-01_2026-08-03.csv'], 'range widened to keep 1 Aug');
  });

  test('dates already covered by an uploaded Meta CSV are refused', async (page, state) => {
    state.rows = [insight('Alpha', '2026-08-01', 100)];
    await upload(page, [{ name: 'affiliate.csv', rows: [aff('1', 'Alpha')] }, { name: 'ads-export.csv', rows: [ad('Alpha', 100)] }]);
    await openMeta(page);
    await pull(page, '2026-08-01', '2026-08-01');
    await page.locator('#metaError').waitFor({ state: 'visible' });
    assert.match(await page.locator('#metaError').innerText(), /ads-export\.csv.*dua kali/s);
    assert.equal(state.calls.filter(u => u.pathname.endsWith('/insights')).length, 0);
    assert.deepEqual(await adsChips(page), ['ads-export.csv']);
  });

  test('an expired token explains what to do and changes nothing', async (page, state) => {
    state.error = { code: 190, error_subcode: 463, message: 'Session has expired' };
    await page.locator('#btnMeta').click();
    await page.locator('#metaToken').fill('OLD_TOKEN');
    await page.locator('#btnMetaAccounts').click();
    await page.locator('#metaError').waitFor({ state: 'visible' });
    assert.match(await page.locator('#metaError').innerText(), /kedaluwarsa/);
    assert.equal(await page.locator('#btnMetaPull').isDisabled(), true);
  });

  test('a remembered token survives reload and Hapus token removes it', async (page, state) => {
    state.rows = [];
    await page.locator('#btnMeta').click();
    await page.locator('#metaRemember').check();
    await page.locator('#metaToken').fill('KEEP_ME');
    await page.locator('#btnMetaAccounts').click();
    await page.waitForFunction(() => document.getElementById('metaAccount').value === 'act_555');
    await page.reload();
    await page.waitForFunction(() => window.MetaApi && window.DashboardImport);
    await page.locator('#btnMeta').click();
    assert.equal(await page.locator('#metaToken').inputValue(), 'KEEP_ME');
    assert.equal(await page.locator('#metaRemember').isChecked(), true);
    await page.locator('#btnMetaForget').click();
    assert.doesNotMatch(await page.evaluate(() => JSON.stringify(localStorage)), /KEEP_ME/);
  });

  test('the dialog fits a 360px screen', async page => {
    await page.setViewportSize({ width: 360, height: 740 });
    await page.locator('#btnMeta').click();
    const overflow = await page.evaluate(() => {
      const box = document.querySelector('#metaModal .modal-box');
      return box.scrollWidth - box.clientWidth;
    });
    assert.ok(overflow <= 1, 'no horizontal overflow');
  });

  let failed = 0;
  try {
    for (const { name, fn } of cases) {
      const context = await harness.browser.newContext({ viewport: { width: 1440, height: 1000 } });
      const state = { calls: [], rows: [], error: null }, external = [], errors = [];
      await context.route('**/*', route => {
        const url = route.request().url();
        if (url.startsWith(harness.url + '/')) return route.continue();
        if (url.startsWith('https://graph.facebook.com/')) return graph(state)(route);
        external.push(url);
        return route.abort();
      });
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      page.on('pageerror', error => errors.push(error.message));
      try {
        await page.goto(harness.url + '/index.html', { waitUntil: 'load' });
        await page.waitForFunction(() => window.Engine && window.DashboardImport && window.MetaApi && window.__dailyStore);
        await fn(page, state);
        assert.deepEqual(errors, [], 'uncaught browser errors');
        assert.deepEqual(external, [], 'external network requests');
        console.log('PASS ' + name);
      } catch (error) {
        failed++;
        console.error('FAIL ' + name + '\n  ' + error.stack);
      } finally { await context.close(); }
    }
  } finally { await harness.close(); }
  console.log(`${cases.length - failed}/${cases.length} Meta connection tests passed`);
  if (failed) process.exitCode = 1;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
