/* The daily edition must keep EVERY dashboard metric and add storage on top.
   This test compares the two pages element by element, then exercises the
   daily-only features. */
const { chromium } = require('playwright');
const D = '/Users/hadipradata/Downloads/';
const EXE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const F = [D + 'AffiliateCommissionReport_202608222201.csv',
           D + 'AW-Adrian-Ads-Jul-23-2026-Aug-21-2026.csv',
           D + 'WebsiteClickReport202608222201.csv'];

async function survey(page, url, files) {
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.evaluate(() => localStorage.clear());
  await page.evaluate(() => new Promise(r => {
    const q = indexedDB.deleteDatabase('affiliate_daily');
    q.onsuccess = q.onerror = q.onblocked = () => r();
  }));
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  if (url.includes('daily')) {
    page.once('dialog', async d => await d.accept('BBA Utama'));
    await page.click('#btnShopeeAdd');
    await page.waitForTimeout(700);
  }
  await page.setInputFiles('#files', files);
  await page.waitForSelector('#main:not(.hidden)', { timeout: 120000 });
  await page.waitForTimeout(4000);
  // Visit every tab so hidden charts get a layout box and render.
  for (const t of await page.$$eval('.tab', els => els.map(e => e.dataset.tab))) {
    await page.click(`[data-tab="${t}"]`);
    await page.waitForTimeout(700);
  }
  await page.click('[data-tab="keputusan"]');
  await page.waitForTimeout(500);
  return page.evaluate(() => ({
    tabs: [...document.querySelectorAll('.tab')].map(t => t.textContent.trim()),
    kpis: [...document.querySelectorAll('.kpi')].map(e =>
      e.querySelector('.lbl').textContent.trim() + '=' + e.querySelector('.val').textContent.trim()),
    mainCols: [...document.querySelectorAll('#tblMain thead th')].map(t => t.textContent.replace(/[▾▴]/g, '').trim()),
    mainRows: document.querySelectorAll('#tblMain tbody tr').length,
    tables: [...document.querySelectorAll('table[id]')].map(t => t.id).sort(),
    charts: [...document.querySelectorAll('canvas[id]')].map(c => c.id + (c.width > 0 ? '' : ':KOSONG')).sort(),
    actionCards: [...document.querySelectorAll('.action-card')].map(e =>
      e.querySelector('.a-label').textContent.trim() + '=' + e.querySelector('.a-val').textContent.trim()),
    calibration: (document.getElementById('lagCal') || {}).innerText || '',
    frail: [...document.querySelectorAll('#tblMain tbody tr')].filter(r => /rapuh/.test(r.innerText)).length,
  }));
}

(async () => {
  const b = await chromium.launch({ executablePath: EXE, headless: true });
  const errs = [];

  const p1 = await b.newPage({ viewport: { width: 1500, height: 1000 } });
  p1.on('pageerror', e => errs.push('DASHBOARD: ' + e.message));
  const dash = await survey(p1, 'http://127.0.0.1:8899/index.html', F);
  await p1.close();

  const p2 = await b.newPage({ viewport: { width: 1500, height: 1000 } });
  p2.on('pageerror', e => errs.push('HARIAN: ' + e.message));
  p2.on('console', m => { if (m.type() === 'error') errs.push('HARIAN console: ' + m.text()); });
  const daily = await survey(p2, 'http://127.0.0.1:8899/index-daily.html', F);

  const miss = (a, b) => a.filter(x => !b.includes(x));
  console.log('=== PARITAS METRIK ===');
  console.log('  tab      dashboard', dash.tabs.length, '· harian', daily.tabs.length);
  console.log('           hilang:', miss(dash.tabs, daily.tabs).join(', ') || '(tidak ada)');
  console.log('           tambahan:', miss(daily.tabs, dash.tabs).join(', ') || '(tidak ada)');
  console.log('  KPI      dashboard', dash.kpis.length, '· harian', daily.kpis.length);
  console.log('           hilang:', miss(dash.kpis.map(k => k.split('=')[0]), daily.kpis.map(k => k.split('=')[0])).join(', ') || '(tidak ada)');
  console.log('  kolom    dashboard', dash.mainCols.length, '· harian', daily.mainCols.length);
  console.log('           hilang:', miss(dash.mainCols, daily.mainCols).join(', ') || '(tidak ada)');
  console.log('  tabel    dashboard', dash.tables.length, '· harian', daily.tables.length);
  console.log('           hilang:', miss(dash.tables, daily.tables).join(', ') || '(tidak ada)');
  console.log('           tambahan:', miss(daily.tables, dash.tables).join(', ') || '(tidak ada)');
  console.log('  chart    dashboard', dash.charts.length, '· harian', daily.charts.length);
  console.log('           hilang:', miss(dash.charts, daily.charts).join(', ') || '(tidak ada)');
  console.log('           tambahan:', miss(daily.charts, dash.charts).join(', ') || '(tidak ada)');
  console.log('           kosong :', daily.charts.filter(c => /KOSONG/.test(c)).join(', ') || '(tidak ada)');

  console.log('\n=== NILAI IDENTIK? ===');
  const sameKpi = JSON.stringify(dash.kpis) === JSON.stringify(daily.kpis.slice(0, dash.kpis.length));
  console.log('  KPI sama persis:', sameKpi ? 'YA' : 'TIDAK');
  if (!sameKpi) { console.log('   dash :', dash.kpis.join(' | ')); console.log('   daily:', daily.kpis.join(' | ')); }
  console.log('  baris tabel vonis:', dash.mainRows, 'vs', daily.mainRows, dash.mainRows === daily.mainRows ? 'SAMA' : 'BEDA');
  console.log('  kartu aksi:', dash.actionCards.length, 'vs', daily.actionCards.length);
  console.log('  vonis rapuh:', dash.frail, 'vs', daily.frail);
  console.log('  kalibrasi lag ada:', !!daily.calibration.trim());
  if (!sameKpi || dash.mainRows !== daily.mainRows) errs.push('Nilai dashboard dan harian berbeda');
  if (miss(dash.tabs, daily.tabs).length) errs.push('Ada tab dashboard yang hilang');
  if (miss(dash.charts, daily.charts).length) errs.push('Ada chart dashboard yang hilang');
  if (miss(dash.mainCols, daily.mainCols).length) errs.push('Ada kolom dashboard yang hilang');

  // Daily-only behaviour
  console.log('\n=== RENCANA SIMPAN ===');
  const planRows = await p2.$$eval('.plan-row', els => els.map(e => e.innerText.replace(/\s+/g, ' ').trim()));
  planRows.forEach(r => console.log('  ' + r));
  const before = await p2.evaluate(async () => {
    const a = (await window.__dailyStore.listAccounts('shopee'))[0];
    return (await window.__dailyStore.range(a.id, 'affiliate')).length;
  });
  console.log('  tersimpan sebelum approve:', before, before === 0 ? '(benar)' : '(BUG)');
  if (before !== 0) errs.push('Data tertulis sebelum persetujuan');

  await p2.click('#btnSaveAll');
  await p2.waitForSelector('#savedNote:not(.hidden)', { timeout: 60000 });
  await p2.waitForTimeout(1200);
  console.log('  ' + await p2.$eval('#savedNote', e => e.innerText.replace(/\s+/g, ' ').trim()));

  await p2.click('[data-tab="tersimpan"]');
  await p2.waitForTimeout(1800);
  const strip = await p2.$$eval('#storedStrip .s', els => els.map(e =>
    e.querySelector('.l').textContent + '=' + e.querySelector('.v').textContent));
  console.log('\n=== DATA TERSIMPAN ===');
  console.log('  ' + strip.join('  '));
  console.log('  baris:', (await p2.$$('#tblStored tbody tr')).length);

  const recon = await p2.evaluate(async () => {
    const a = (await window.__dailyStore.listAccounts('shopee'))[0];
    const aff = await window.__dailyStore.range(a.id, 'affiliate');
    const ads = await window.__dailyStore.range(a.id, 'ads');
    const sum = (x, f) => x.reduce((t, r) => t + (r[f] || 0), 0);
    const commEff = (sum(aff, 'comm') - sum(aff, 'comm_pending')) + sum(aff, 'comm_pending') * 0.95;
    return { roas: +(commEff / (sum(ads, 'spend') * 1.11)).toFixed(2), orders: sum(aff, 'orders') };
  });
  const engRoas = parseFloat((daily.kpis.find(k => /ROAS Gabungan/.test(k)) || '=0').split('=')[1]);
  console.log('\n=== STORE vs ENGINE ===');
  console.log('  ROAS store', recon.roas, '· engine', engRoas, recon.roas === engRoas ? 'COCOK' : 'BEDA');
  console.log('  order store', recon.orders.toLocaleString('id-ID'));
  if (recon.roas !== engRoas) errs.push('Store dan engine tidak konsisten');

  await p2.click('[data-tab="unggahan"]');
  await p2.waitForTimeout(900);
  console.log('\n=== LOG UNGGAHAN ===');
  for (const u of await p2.$$eval('#tblUploads tbody tr', rows => rows.map(r =>
    [...r.querySelectorAll('td')].map(c => c.innerText.trim()).join(' · '))))
    console.log('  ' + u);

  await p2.click('[data-tab="keputusan"]');
  await p2.waitForTimeout(600);
  await p2.setInputFiles('#files', F);
  await p2.waitForTimeout(4500);
  console.log('\n=== UNGGAH ULANG ===');
  for (const r of await p2.$$eval('.plan-row', els => els.map(e => e.innerText.replace(/\s+/g, ' ').trim())))
    console.log('  ' + r);
  console.log('  tombol:', await p2.$eval('#btnSaveAll', e => e.textContent.trim()));

  await p2.screenshot({ path: '/tmp/daily-full.png', fullPage: false });
  console.log('\n=== ERROR ===');
  console.log(errs.length ? errs.slice(0, 8).join('\n') : '  (tidak ada)');
  await b.close();
})();
