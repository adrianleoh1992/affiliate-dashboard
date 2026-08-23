/* End-to-end for the daily edition: the approval step, dedup on re-upload,
   accumulation across periods, and account isolation — in a real browser. */
const { chromium } = require('playwright');
const D = '/Users/hadipradata/Downloads/';
const EXE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const AFF = D + 'AffiliateCommissionReport_202608222201.csv';
const ADS = D + 'AW-Adrian-Ads-Jul-23-2026-Aug-21-2026.csv';
const CLK = D + 'WebsiteClickReport202608222201.csv';
const URL = 'http://127.0.0.1:8899/index-daily.html';

(async () => {
  const b = await chromium.launch({ executablePath: EXE, headless: true });
  const p = await b.newPage({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 2 });
  const errs = [];
  p.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  p.on('dialog', async d => { await d.accept('BBA Utama'); });

  await p.goto(URL, { waitUntil: 'networkidle' });
  await p.evaluate(() => new Promise(r => {
    const q = indexedDB.deleteDatabase('affiliate_daily');
    q.onsuccess = q.onerror = q.onblocked = () => r();
  }));
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForTimeout(700);

  // Account creation
  await p.click('#btnShopeeAdd');
  await p.waitForTimeout(800);
  console.log('=== AKUN ===');
  console.log('  ', await p.$eval('#covStrip', e => e.innerText.replace(/\n/g, ' | ')));

  // Upload all three, then inspect the plan BEFORE saving
  await p.setInputFiles('#files', [AFF, ADS, CLK]);
  await p.waitForSelector('#ingestPlan:not(.hidden)', { timeout: 120000 });
  await p.waitForTimeout(1200);
  console.log('\n=== RENCANA SIMPAN (sebelum ditulis) ===');
  for (const r of await p.$$eval('.plan-row', els => els.map(e => e.innerText.replace(/\s+/g, ' ').trim())))
    console.log('  ' + r);
  console.log('  tombol:', await p.$eval('#btnSaveAll', e => e.innerText));

  // Nothing must be stored yet
  const before = await p.evaluate(async () => {
    const s = await DailyStore.open();
    const a = (await s.listAccounts('shopee'))[0];
    return (await s.range(a.id, 'affiliate')).length;
  });
  console.log('  baris tersimpan sebelum approve:', before, before === 0 ? '(benar, belum ditulis)' : '(BUG)');

  // Approve
  await p.click('#btnSaveAll');
  await p.waitForSelector('#savedNote:not(.hidden)', { timeout: 60000 });
  await p.waitForTimeout(1200);
  console.log('\n=== SETELAH SIMPAN ===');
  console.log('  ' + (await p.$eval('#savedNote', e => e.innerText.replace(/\s+/g, ' ').trim())));
  console.log('  ' + (await p.$eval('#covStrip', e => e.innerText.replace(/\n/g, ' | '))));

  // KPI must match the dashboard engine
  const kpis = await p.$$eval('.kpi', els => els.map(e => ({
    l: e.querySelector('.lbl').textContent, v: e.querySelector('.val').textContent })));
  console.log('\n=== KPI ===');
  kpis.forEach(k => console.log('  ' + k.l.padEnd(18) + k.v));

  // Re-upload the same files: plan must show them as already ingested
  console.log('\n=== UNGGAH ULANG FILE SAMA ===');
  await p.setInputFiles('#files', [AFF, ADS, CLK]);
  await p.waitForTimeout(4000);
  for (const r of await p.$$eval('.plan-row', els => els.map(e => e.innerText.replace(/\s+/g, ' ').trim())))
    console.log('  ' + r);
  console.log('  tombol:', await p.$eval('#btnSaveAll', e => e.innerText),
    '| disabled:', await p.$eval('#btnSaveAll', e => e.disabled));

  // Totals must not have moved
  const totals = await p.evaluate(async () => {
    const s = await DailyStore.open();
    const a = (await s.listAccounts('shopee'))[0];
    const aff = await s.range(a.id, 'affiliate');
    const ads = await s.range(a.id, 'ads');
    const sum = (x, f) => x.reduce((t, r) => t + (r[f] || 0), 0);
    return { comm: Math.round(sum(aff, 'comm')), orders: sum(aff, 'orders'),
             spend: Math.round(sum(ads, 'spend')), rows: aff.length };
  });
  console.log('\n=== TOTAL TERSIMPAN ===');
  console.log('  komisi Rp' + totals.comm.toLocaleString('id-ID'),
    '| order', totals.orders.toLocaleString('id-ID'),
    '| spend Rp' + totals.spend.toLocaleString('id-ID'));
  console.log('  benar (31.028.615 / 8.004):',
    totals.comm === 31028615 && totals.orders === 8004 ? 'YA' : 'TIDAK');

  // Stored-history tab
  await p.click('[data-tab="riwayat"]');
  await p.waitForTimeout(1800);
  const strip = await p.$$eval('#storedStrip .s', els => els.map(e =>
    e.querySelector('.l').textContent + '=' + e.querySelector('.v').textContent));
  console.log('\n=== RIWAYAT HARIAN ===');
  console.log('  ' + strip.join('  '));
  console.log('  ' + await p.$eval('#storedNote', e => e.innerText));
  console.log('  baris tabel:', (await p.$$('#tblStored tbody tr')).length);
  const charts = await p.$$eval('canvas', c => c.map(x => x.id + ':' + (x.width > 0 ? 'ok' : 'KOSONG')));
  console.log('  chart:', charts.join(' '));

  // The stored view and the KPI row are computed from different sources
  // (IndexedDB aggregates vs engine.js), so they must be reconciled directly
  // rather than by eye — a mismatch means one applies VAT or the pending
  // factor differently.
  const recon = await p.evaluate(async () => {
    const s = await DailyStore.open();
    const a = (await s.listAccounts('shopee'))[0];
    const aff = await s.range(a.id, 'affiliate');
    const ads = await s.range(a.id, 'ads');
    const sum = (x, f) => x.reduce((t, r) => t + (r[f] || 0), 0);
    const commEff = (sum(aff, 'comm') - sum(aff, 'comm_pending')) + sum(aff, 'comm_pending') * 0.95;
    const spend = sum(ads, 'spend') * 1.11;
    return {
      roas: +(commEff / spend).toFixed(2),
      orders: sum(aff, 'orders'),
      engineRoas: +RESULT.kpi.roasEff.toFixed(2),
      engineOrders: RESULT.kpi.orders,
    };
  });
  console.log('\n=== KONSISTENSI STORE vs ENGINE ===');
  console.log('  ROAS  store', recon.roas, '· engine', recon.engineRoas,
    recon.roas === recon.engineRoas ? 'COCOK' : 'BEDA');
  console.log('  Order store', recon.orders.toLocaleString('id-ID'), '· engine', recon.engineOrders.toLocaleString('id-ID'),
    recon.orders === recon.engineOrders ? 'COCOK' : 'BEDA');
  if (recon.roas !== recon.engineRoas || recon.orders !== recon.engineOrders)
    errs.push('Store dan engine tidak konsisten');
  await p.screenshot({ path: '/tmp/daily-riwayat.png' });

  // Upload log
  await p.click('[data-tab="unggahan"]');
  await p.waitForTimeout(900);
  const ups = await p.$$eval('#tblUploads tbody tr', rows => rows.map(r =>
    [...r.querySelectorAll('td')].map(c => c.innerText.trim()).join(' · ')));
  console.log('\n=== LOG UNGGAHAN ===');
  ups.forEach(u => console.log('  ' + u));

  // Account isolation
  console.log('\n=== AKUN KEDUA ===');
  p.removeAllListeners('dialog');
  p.on('dialog', async d => { await d.accept('Akun Kedua'); });
  await p.click('#btnShopeeAdd');
  await p.waitForTimeout(1000);
  console.log('  ' + await p.$eval('#covStrip', e => e.innerText.replace(/\n/g, ' | ')));
  const iso = await p.evaluate(async () => {
    const s = await DailyStore.open();
    const out = {};
    for (const a of await s.listAccounts('shopee'))
      out[a.name] = (await s.range(a.id, 'affiliate')).length;
    return out;
  });
  console.log('  baris per akun:', JSON.stringify(iso));

  // Persistence
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForTimeout(1000);
  const after = await p.evaluate(async () => {
    const s = await DailyStore.open();
    const accts = await s.listAccounts('shopee');
    return { accounts: accts.map(a => a.name) };
  });
  console.log('\n=== SETELAH RELOAD ===');
  console.log('  akun:', after.accounts.join(', '));

  // Mobile
  await p.setViewportSize({ width: 390, height: 844 });
  await p.waitForTimeout(800);
  const mob = await p.evaluate(() => ({
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    acctCols: getComputedStyle(document.querySelector('.acctrow')).gridTemplateColumns.split(' ').length,
    pickH: Math.round(document.getElementById('btnPick').getBoundingClientRect().height),
  }));
  console.log('\n=== MOBILE 390px ===');
  console.log('  meluber:', mob.overflow, '| kolom akun:', mob.acctCols, '| tombol pilih:', mob.pickH + 'px');
  await p.screenshot({ path: '/tmp/daily-mobile.png' });

  console.log('\n=== ERROR ===');
  console.log(errs.length ? errs.slice(0, 6).join('\n') : '  (tidak ada)');
  await b.close();
})();
