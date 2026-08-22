const { chromium } = require('playwright');
const D = '/Users/hadipradata/Downloads/';
const FILES = [
  D + 'AffiliateCommissionReport_202608222201.csv',
  D + 'AW-Adrian-Ads-Jul-23-2026-Aug-21-2026.csv',
  D + 'WebsiteClickReport202608222201.csv',
];
const PAGE = 'http://127.0.0.1:8899/index.html';
const EXE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  const page = await browser.newPage({ viewport: { width: 1560, height: 1050 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

  await page.goto(PAGE, { waitUntil: 'networkidle' });
  await page.setInputFiles('#files', FILES);
  await page.waitForSelector('#main:not(.hidden)', { timeout: 90000 });
  await page.waitForTimeout(4000);

  console.log('=== KPI ===');
  for (const k of await page.$$eval('.kpi', e => e.map(x => ({
    l: x.querySelector('.lbl').textContent, v: x.querySelector('.val').textContent,
    s: x.querySelector('.sub').textContent }))))
    console.log(' ', k.l.padEnd(21), k.v.padEnd(13), k.s);

  console.log('\n=== KEPUTUSAN (6 teratas) ===');
  const rows = await page.$$eval('#tblMain tbody tr', t => t.map(r =>
    [...r.querySelectorAll('td')].map(c => c.innerText.replace(/\n/g, ' | ').trim())));
  rows.slice(0, 6).forEach(r => console.log('  ', r[0].split('|')[0].trim().padEnd(30),
    'ROAS', r[4].padEnd(7), 'CPM', r[6].padEnd(9), 'CPC', r[7].padEnd(6), 'ideal', r[8]));
  console.log('  total baris:', rows.length);

  await page.click('[data-tab="adunit"]'); await page.waitForTimeout(700);
  const units = await page.$$eval('#tblUnit tbody tr', t => t.map(r =>
    [...r.querySelectorAll('td')].map(c => c.innerText.replace(/\n/g, ' ').trim())));
  console.log('\n=== PER AD UNIT ===');
  units.forEach(u => console.log('  ', u[0].slice(0, 34).padEnd(36), u[1].padEnd(7),
    u[2].padEnd(11), 'CPM', u[3].padEnd(8), 'CTR', u[8].padEnd(6), 'ROI', u[13]));

  await page.click('[data-tab="kebocoran"]'); await page.waitForTimeout(700);
  const leak = await page.$$eval('#tblLeak tbody tr', t => t.map(r =>
    [...r.querySelectorAll('td')].map(c => c.innerText.trim())));
  console.log('\n=== KEBOCORAN ===');
  leak.forEach(r => console.log('  ', (r[0]||'').padEnd(26), 'masuk', (r[3]||'').padEnd(8), 'hangus', r[5]||''));

  await page.click('[data-tab="harian"]'); await page.waitForTimeout(900);
  const strip = await page.$$eval('#dailyStrip .s', e => e.map(x =>
    x.querySelector('.l').textContent + '=' + x.querySelector('.v').textContent));
  console.log('\n=== STRIP HARIAN ===\n  ', strip.join('  '));
  console.log('   baris harian:', (await page.$$('#tblDaily tbody tr')).length);

  // Snapshot + trend: save two DIFFERENT periods to prove per-account history.
  // Start from a clean slate so a previous run's snapshots can't mask a bug,
  // and open the collapsed settings panel before touching the date inputs.
  await page.click('[data-tab="keputusan"]'); await page.waitForTimeout(300);
  await page.evaluate(() => localStorage.removeItem('adash_snaps_v3_default'));
  await page.click('#btnSave'); await page.waitForTimeout(600);
  await page.evaluate(() => { document.getElementById('settingsCard').open = true; });
  await page.waitForTimeout(300);
  await page.fill('#dateEnd', '2026-08-10'); await page.waitForTimeout(2400);
  await page.click('#btnSave'); await page.waitForTimeout(700);
  await page.fill('#dateEnd', '2026-08-21'); await page.waitForTimeout(2400);

  await page.click('[data-tab="perkembangan"]'); await page.waitForTimeout(1200);
  const trendVisible = await page.$eval('#trendBody', e => !e.classList.contains('hidden'));
  const tstrip = await page.$$eval('#trendStrip .s', e => e.map(x =>
    x.querySelector('.l').textContent + '=' + x.querySelector('.v').textContent.trim()));
  const movers = await page.$$eval('#tblMovers tbody tr', t => t.length);
  console.log('\n=== PERKEMBANGAN ===');
  console.log('  tampil:', trendVisible, '| movers:', movers);
  console.log('  ', tstrip.join('  '));

  await page.click('[data-tab="rincian"]'); await page.waitForTimeout(1000);
  const canv = await page.$$eval('canvas', c => c.map(x => x.id + ':' + (x.width > 0 ? 'ok' : 'KOSONG')));
  console.log('\n=== CHART ===\n  ', canv.join('  '));

  // Multi-account isolation
  page.on('dialog', async d => { await d.accept('akun-kedua'); });
  await page.click('#btnNewAcct'); await page.waitForTimeout(900);
  const acctOpts = await page.$$eval('#account option', o => o.map(x => x.value));
  const emptyShown = await page.$eval('#emptyState', e => !e.classList.contains('hidden'));
  console.log('\n=== MULTI-AKUN ===');
  console.log('  akun:', acctOpts.join(', '), '| data direset:', emptyShown);
  const snapCounts = await page.evaluate(() => ({
    def: JSON.parse(localStorage.getItem('adash_snaps_v3_default') || '[]').length,
    dua: JSON.parse(localStorage.getItem('adash_snaps_v3_akun-kedua') || '[]').length,
  }));
  console.log('  snapshot default:', snapCounts.def, '| akun-kedua:', snapCounts.dua);

  console.log('\n=== CONSOLE ERRORS ===');
  console.log(errors.length ? errors.slice(0, 8).join('\n') : '  (tidak ada)');
  await browser.close();
})();
