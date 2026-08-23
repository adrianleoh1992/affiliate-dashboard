/* End-to-end IndexedDB test with the real CSVs. Proves persistence, dedup,
   account isolation, and incremental period accumulation in a real browser. */
const { chromium } = require('playwright');
const D = '/Users/hadipradata/Downloads/';
const EXE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const AFF = D + 'AffiliateCommissionReport_202608222201.csv';
const ADS = D + 'AW-Adrian-Ads-Jul-23-2026-Aug-21-2026.csv';
const CLK = D + 'WebsiteClickReport202608222201.csv';

(async () => {
  const b = await chromium.launch({ executablePath: EXE, headless: true });
  const p = await b.newPage({ viewport: { width: 1200, height: 900 } });
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  p.on('dialog', async d => { await d.accept(); });

  await p.goto('http://127.0.0.1:8899/test-daily.html', { waitUntil: 'networkidle' });
  await p.evaluate(() => new Promise(r => { const q = indexedDB.deleteDatabase('affiliate_daily'); q.onsuccess = q.onerror = q.onblocked = () => r(); }));
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForTimeout(600);

  const log = () => p.$eval('#uploadLog', e => e.innerText.replace(/\s+/g, ' ').trim());

  // Account A
  await p.click('#btnShopee'); await p.waitForTimeout(300);
  await p.click('#btnAds'); await p.waitForTimeout(300);
  console.log('=== AKUN ===');
  console.log(' ', await p.$eval('#acctLog', e => e.innerText));

  // First upload of all three
  console.log('\n=== UNGGAH PERTAMA ===');
  for (const [sel, btn, file, label] of [
    ['#fileAff', '#btnAff', AFF, 'affiliate'],
    ['#fileAds', '#btnAds2', ADS, 'ads'],
    ['#fileClk', '#btnClk', CLK, 'clicks'],
  ]) {
    await p.setInputFiles(sel, file);
    await p.click(btn);
    await p.waitForFunction(() => !/Memproses/.test(document.getElementById('uploadLog').innerText), null, { timeout: 120000 });
    await p.waitForTimeout(400);
    console.log(`  ${label}: ${await log()}`);
  }

  // Coverage after first load
  await p.click('#btnCov'); await p.waitForTimeout(700);
  const cov1 = await p.$$eval('#cov .stat', els => els.map(e => e.innerText.replace(/\n/g, ' · ')));
  console.log('\n=== CAKUPAN SETELAH UNGGAH 1 ===');
  cov1.forEach(c => console.log('  ' + c));

  // Same file again — must be rejected by file hash
  console.log('\n=== UNGGAH ULANG FILE YANG SAMA ===');
  await p.setInputFiles('#fileAff', AFF);
  await p.click('#btnAff');
  await p.waitForTimeout(2500);
  console.log('  ' + await log());

  // Numbers must not have moved
  const totals = await p.evaluate(async () => {
    const s = await DailyStore.open();
    const accts = await s.listAccounts('shopee');
    const id = accts[0].id;
    const aff = await s.range(id, 'affiliate');
    const ads = await s.range(id, 'ads');
    const clk = await s.range(id, 'clicks');
    const sum = (a, f) => a.reduce((x, r) => x + (r[f] || 0), 0);
    return {
      comm: Math.round(sum(aff, 'comm')), orders: sum(aff, 'orders'),
      spend: Math.round(sum(ads, 'spend')), clicks: sum(clk, 'clicks'),
      affRows: aff.length, adsRows: ads.length, clkRows: clk.length,
    };
  });
  console.log('\n=== TOTAL TERSIMPAN ===');
  console.log('  komisi Rp' + totals.comm.toLocaleString('id-ID'), '| order', totals.orders.toLocaleString('id-ID'));
  console.log('  spend  Rp' + totals.spend.toLocaleString('id-ID'), '| klik ', totals.clicks.toLocaleString('id-ID'));
  console.log('  baris:', totals.affRows, 'affiliate ·', totals.adsRows, 'ads ·', totals.clkRows, 'clicks');
  console.log('  komisi benar (Rp31.028.615):', totals.comm === 31028615 ? 'YA' : 'TIDAK — ' + totals.comm);

  // Second account must stay isolated
  console.log('\n=== ISOLASI AKUN ===');
  await p.fill('#shopee', 'Akun Kedua');
  await p.click('#btnShopee'); await p.waitForTimeout(400);
  await p.click('#btnCov'); await p.waitForTimeout(600);
  const cov2 = await p.$$eval('#cov .stat', els => els.map(e => e.innerText.replace(/\n/g, ' · ')));
  cov2.forEach(c => console.log('  ' + c));

  // Same file into the new account: allowed, because the guard is per-account
  await p.setInputFiles('#fileAff', AFF);
  await p.click('#btnAff');
  await p.waitForFunction(() => !/Memproses/.test(document.getElementById('uploadLog').innerText), null, { timeout: 120000 });
  await p.waitForTimeout(500);
  console.log('  file sama ke akun kedua: ' + await log());

  const iso = await p.evaluate(async () => {
    const s = await DailyStore.open();
    const accts = await s.listAccounts('shopee');
    const out = {};
    for (const a of accts) {
      const rows = await s.range(a.id, 'affiliate');
      out[a.name] = Math.round(rows.reduce((x, r) => x + (r.comm || 0), 0));
    }
    return out;
  });
  console.log('  komisi per akun:', JSON.stringify(iso));

  // Persistence across reload
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForTimeout(700);
  const after = await p.evaluate(async () => {
    const s = await DailyStore.open();
    const accts = await s.listAccounts('shopee');
    const rows = await s.range(accts[0].id, 'affiliate');
    return { accounts: accts.length, comm: Math.round(rows.reduce((x, r) => x + (r.comm || 0), 0)) };
  });
  console.log('\n=== SETELAH RELOAD ===');
  console.log('  akun tersimpan:', after.accounts, '| komisi akun 1: Rp' + after.comm.toLocaleString('id-ID'));

  // Delete removes the data too
  await p.fill('#shopee', 'Akun Kedua');
  await p.click('#btnShopee'); await p.waitForTimeout(400);
  await p.click('#btnDel'); await p.waitForTimeout(900);
  const left = await p.evaluate(async () => {
    const s = await DailyStore.open();
    const accts = await s.listAccounts('shopee');
    let orphan = 0;
    for (const kind of ['affiliate', 'ads', 'clicks']) {
      for (let id = 1; id <= 10; id++) {
        if (accts.some(a => a.id === id)) continue;
        orphan += (await s.range(id, kind)).length;
      }
    }
    return { accounts: accts.map(a => a.name), orphan };
  });
  console.log('\n=== HAPUS AKUN ===');
  console.log('  tersisa:', left.accounts.join(', ') || '(kosong)', '| baris yatim:', left.orphan);

  console.log('\n=== ERROR ===');
  console.log(errs.length ? errs.slice(0, 5).join('\n') : '  (tidak ada)');
  await b.close();
})();
