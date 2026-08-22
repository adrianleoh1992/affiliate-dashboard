const { chromium } = require('playwright');
const path = require('path');

const D = '/Users/hadipradata/Downloads/';
const FILES = [
  D + 'AffiliateCommissionReport_202608222201.csv',
  D + 'AW-Adrian-Ads-Jul-23-2026-Aug-21-2026.csv',
  D + 'WebsiteClickReport202608222201.csv',
];

(async () => {
  const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

  await page.goto('http://127.0.0.1:8899/v2.html', { waitUntil: 'networkidle' });
  await page.setInputFiles('#files', FILES);
  await page.waitForSelector('#main:not(.hidden)', { timeout: 60000 });
  await page.waitForTimeout(3500);

  const kpis = await page.$$eval('.kpi', els => els.map(e => ({
    label: e.querySelector('.lbl').textContent,
    value: e.querySelector('.val').textContent,
    sub: e.querySelector('.sub').textContent,
  })));
  console.log('=== KPI ===');
  kpis.forEach(k => console.log(' ', k.label.padEnd(20), k.value.padEnd(14), k.sub));

  console.log('\n=== BANNER ===');
  for (const b of await page.$$eval('.banner', e => e.map(x => x.textContent.trim()))) {
    console.log('  •', b.replace(/\s+/g, ' ').slice(0, 130));
  }

  console.log('\n=== KEPUTUSAN ===');
  const rows = await page.$$eval('#tblMain tbody tr', trs => trs.map(tr => {
    const c = [...tr.querySelectorAll('td')].map(t => t.innerText.replace(/\n/g, ' | ').trim());
    return c;
  }));
  rows.slice(0, 8).forEach(r => console.log('  ', r[0].slice(0, 78)));
  console.log('  total baris:', rows.length);

  console.log('\n=== TABEL: kolom CPC ideal ===');
  rows.slice(0, 6).forEach(r => console.log('  ', r[0].split('|')[0].trim().padEnd(28),
    'biaya', r[1].padEnd(10), 'ROAS', r[4].padEnd(7), 'CPC', r[6].padEnd(6), 'ideal', r[7].padEnd(6), 'selisih', r[8]));

  // Leakage tab
  await page.click('[data-tab="kebocoran"]');
  await page.waitForTimeout(600);
  const leak = await page.$$eval('#tblLeak tbody tr', trs => trs.map(tr =>
    [...tr.querySelectorAll('td')].map(t => t.innerText.trim())));
  console.log('\n=== KEBOCORAN KLIK ===');
  leak.forEach(r => console.log('  ', (r[0]||'').padEnd(26), 'meta', (r[1]||'').padEnd(8),
    'shopee', (r[2]||'').padEnd(8), 'masuk', (r[3]||'').padEnd(8), 'hangus', r[5]||''));

  // Matching tab
  await page.click('[data-tab="matching"]');
  await page.waitForTimeout(400);
  const match = await page.$$eval('#tblMatch tbody tr', trs => trs.map(tr =>
    [...tr.querySelectorAll('td')].map(t => t.innerText.trim())));
  console.log('\n=== MATCHING ===');
  match.forEach(r => console.log('  ', (r[0]||'').padEnd(26), '->', (r[1]||'').padEnd(26), (r[2]||'').padEnd(10), r[3]||''));

  // Charts rendered?
  await page.click('[data-tab="harian"]');
  await page.waitForTimeout(900);
  const canvases = await page.$$eval('canvas', cs => cs.map(c => ({ id: c.id, w: c.width, h: c.height })));
  console.log('\n=== CHART ===');
  canvases.forEach(c => console.log('  ', c.id.padEnd(12), c.w + 'x' + c.h, c.w > 0 && c.h > 0 ? 'ok' : 'KOSONG'));

  // Sorting works?
  await page.click('[data-tab="keputusan"]');
  await page.waitForTimeout(300);
  await page.click('#tblMain th[data-sort="roasEff"]');
  await page.waitForTimeout(300);
  const sorted = await page.$$eval('#tblMain tbody tr td:nth-child(5)', t => t.slice(0,4).map(x=>x.textContent.trim()));
  console.log('\n=== SORT by ROAS ===\n  ', sorted.join('  '));

  // Dark mode
  await page.click('#btnTheme');
  await page.waitForTimeout(700);
  const theme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  console.log('\n=== DARK MODE ===\n  theme:', theme, '| bg:', bg);
  await page.screenshot({ path: '/tmp/v2-dark.png', fullPage: false });
  await page.click('#btnTheme');
  await page.waitForTimeout(700);
  await page.screenshot({ path: '/tmp/v2-light.png', fullPage: false });

  // Snapshot save
  await page.click('#btnSave');
  await page.waitForTimeout(500);
  const snaps = await page.evaluate(() => JSON.parse(localStorage.getItem('adash_snaps_v2')||'[]').length);
  console.log('\n=== SNAPSHOT === tersimpan:', snaps);

  // Decision cards act as filters
  await page.click('[data-tab="keputusan"]');
  await page.waitForTimeout(300);
  const before = await page.$$eval('#tblMain tbody tr', t => t.length);
  await page.click('.dcard.stop');
  await page.waitForTimeout(400);
  const after = await page.$$eval('#tblMain tbody tr', t => t.length);
  const note = await page.$eval('#filterNote', e => e.textContent);
  console.log('\n=== FILTER KARTU ===');
  console.log('  sebelum', before, '-> setelah klik STOP', after, '|', note);
  await page.click('#btnClearFilter');
  await page.waitForTimeout(300);
  const cleared = await page.$$eval('#tblMain tbody tr', t => t.length);
  console.log('  setelah reset:', cleared);

  // Contrast audit on coloured surfaces
  const contrast = await page.evaluate(() => {
    const lum = c => { const [r,g,b] = c.match(/\d+/g).map(Number).map(v => {
      v/=255; return v<=.03928 ? v/12.92 : Math.pow((v+.055)/1.055, 2.4); });
      return .2126*r + .7152*g + .0722*b; };
    const ratio = (a,b) => { const l1=lum(a), l2=lum(b);
      return ((Math.max(l1,l2)+.05)/(Math.min(l1,l2)+.05)).toFixed(2); };
    const out = [];
    document.querySelectorAll('.dcard h4, .badge, .kpi .val').forEach(el => {
      const s = getComputedStyle(el);
      let bg = s.backgroundColor, p = el;
      while ((bg==='rgba(0, 0, 0, 0)'||bg==='transparent') && p.parentElement) { p=p.parentElement; bg=getComputedStyle(p).backgroundColor; }
      out.push({ t: el.textContent.trim().slice(0,18), r: +ratio(s.color, bg) });
    });
    return out;
  });
  console.log('\n=== KONTRAS (min 4.5) ===');
  const fails = contrast.filter(c => c.r < 4.5);
  console.log('  diperiksa:', contrast.length, '| gagal:', fails.length);
  fails.slice(0,8).forEach(c => console.log('   ✗', c.t.padEnd(20), c.r));

  console.log('\n=== CONSOLE ERRORS ===');
  console.log(errors.length ? errors.slice(0,10).join('\n') : '  (tidak ada)');

  await browser.close();
})();
