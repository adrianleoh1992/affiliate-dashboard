'use strict';

// Portable, assertion-based integration coverage. Every fixture is synthetic;
// tests never read personal reports, require a running server, or modify accounts.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const E = require('./engine');

function csv(rows) {
  const keys = [...new Set(rows.flatMap(row => Object.keys(row)))];
  const cell = value => '"' + String(value ?? '').replace(/"/g, '""') + '"';
  return [keys, ...rows.map(row => keys.map(key => row[key]))].map(row => row.map(cell).join(',')).join('\n');
}

function aff(id = '1', tag = 'Alpha', date = '2026-08-01') {
  return { 'ID Pemesanan': id, 'Status Pesanan': 'Selesai',
    'Waktu Pemesanan': date + ' 10:00:00', 'Waktu Klik': date + ' 09:00:00',
    'Total Komisi per Pesanan(Rp)': '200', 'Tag_link1': tag, 'Jumlah': '1',
    'Nilai Pembelian(Rp)': '1000', 'Platform': 'Facebook',
    'Nama Toko': 'Synthetic Shop', 'Nama Barang': 'Synthetic Product ' + id };
}

function ad(tag = 'Alpha', spend = '100', date = '2026-08-01') {
  return { 'Reporting starts': date, 'Reporting ends': date, 'Ad name': tag,
    'Amount spent (IDR)': String(spend), 'Link clicks': '10',
    'Impressions': '1000', 'Reach': '800', 'Landing page views': '8' };
}

function click(tag = 'Alpha', date = '2026-08-01') {
  return { 'Waktu Klik': date + ' 09:00:00', 'Tag_link': tag, 'Perujuk': 'Facebook' };
}

function snapshot(id = 1, end = '2026-08-01') {
  return E.toSnapshot(E.analyze({ affiliate: [aff()], ads: [ad()], clicks: [], tagMap: {} },
    { ppn: 0, lagDays: 0, dateStart: '2026-08-01', dateEnd: end }),
  { id, account: 'default', saved: end + ' 12:00:00' });
}

async function createHarness() {
  const root = __dirname;
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
    '.json': 'application/json', '.svg': 'image/svg+xml' };
  const server = http.createServer((req, res) => {
    let file;
    try { file = path.resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname)); }
    catch { res.writeHead(400).end(); return; }
    if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    if (file === root) file = path.join(root, 'index.html');
    fs.readFile(file, (error, data) => {
      if (error) { res.writeHead(404).end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(data);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const candidates = [process.env.CHROME_PATH, chromium.executablePath(),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean);
  const executablePath = candidates.find(candidate => fs.existsSync(candidate));
  let browser;
  try { browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) }); }
  catch (error) { await new Promise(resolve => server.close(resolve)); throw error; }
  return { browser, url: `http://127.0.0.1:${server.address().port}`,
    close: async () => { await browser.close(); await new Promise(resolve => server.close(resolve)); } };
}

async function upload(page, fixtures) {
  await page.setInputFiles('#files', fixtures.map(({ name, rows, content }) => ({
    name, mimeType: 'text/csv', buffer: Buffer.from(content ?? csv(rows)),
  })));
  await page.waitForFunction(() => !document.getElementById('files').value);
  // Allow subscribed IndexedDB/UI work and scheduled chart rendering to settle.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function importSnapshots(page, snapshots) {
  await page.setInputFiles('#importFile', { name: 'synthetic-snapshots.json',
    mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ snapshots })) });
  await page.waitForFunction(() => !document.getElementById('importFile').value);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function saveDaily(page) {
  await page.waitForFunction(() => {
    const button = document.getElementById('btnSaveAll');
    return !document.getElementById('ingestPlan').classList.contains('hidden') &&
      button.dataset.mode === 'save' && !button.disabled;
  });
  await page.locator('#btnSaveAll').click();
  await page.waitForFunction(() => !document.getElementById('savedNote').classList.contains('hidden'));
}

// PPN lives in Setelan only: adrian's Meta invoices carry none, so it is not a card-level switch.
async function setPpn(page, value) {
  await page.locator('#btnSet').click();
  await page.selectOption('#ppn', value);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.getElementById('setModal').classList.contains('show'));
}

async function storedRows(page, kind = 'affiliate', name = 'default') {
  return page.evaluate(async ({ kind, name }) => {
    const account = (await window.__dailyStore.listAccounts('shopee')).find(account => account.name === name);
    return account ? window.__dailyStore.range(account.id, kind) : [];
  }, { kind, name });
}

async function readDownload(download) {
  const stream = await download.createReadStream(), chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const harness = await createHarness();
  const cases = [];
  const test = (name, fn) => cases.push({ name, fn });

  test('direct and indirect orders show per tag with an account total', async page => {
    const T = 'Tipe Pesanan', direct = 'Pesanan Produk dari Toko yang Dipromosikan', indirect = 'Pesanan dari Toko yang tidak Dipromosikan';
    await upload(page, [{ name: 'affiliate.csv', rows: [
      { ...aff('1', 'Alpha'), [T]: direct }, { ...aff('2', 'Alpha'), [T]: indirect },
      { ...aff('3', 'Alpha'), [T]: indirect }, { ...aff('4', 'Bravo'), [T]: indirect }] }]);
    const head = await page.locator('#tblAttr thead').innerText();
    assert.match(head, /Pesanan langsung/i); assert.match(head, /Komisi tidak langsung/i);
    assert.doesNotMatch(head, /Tidak diketahui/i, 'no unknown column when every row is labelled');
    const alpha = await page.locator('#tblAttr tbody tr', { hasText: 'Alpha' }).innerText();
    assert.deepEqual(alpha.split('\t').map(x => x.replace(/▸/g, '').trim()), ['Alpha', '1', 'Rp200', '2', 'Rp400', '67%']);
    const total = await page.locator('#tblAttr tfoot tr').innerText();
    assert.deepEqual(total.split('\t').map(x => x.trim()), ['Total akun', '1', 'Rp200', '3', 'Rp600', '75%']);
    assert.match(await page.locator('#attrNote').innerText(), /Tipe Pesanan/);
    // Each order count opens that kind's products under the row; the other count switches, the same one closes.
    const row = page.locator('#tblAttr tbody tr[data-attr="Alpha"]');
    await row.locator('button[data-kind="indirect"]').click();
    let detail = await page.locator('#tblAttr tbody tr.daydetail').innerText();
    assert.match(detail, /Terjual tidak langsung · Alpha · 2 produk[\s\S]*Synthetic Product 2[\s\S]*Synthetic Product 3/i);
    assert.doesNotMatch(detail, /Synthetic Product 1|Synthetic Product 4/, 'only this kind, only this tag');
    assert.equal(await row.locator('button[data-kind="indirect"]').getAttribute('aria-expanded'), 'true');
    await row.locator('button[data-kind="direct"]').click();
    assert.equal(await page.locator('#tblAttr tbody tr.daydetail').count(), 1);
    assert.match(await page.locator('#tblAttr tbody tr.daydetail').innerText(), /Terjual langsung · Alpha · 1 produk[\s\S]*Synthetic Product 1/i);
    await row.locator('button[data-kind="direct"]').press('Enter');
    assert.equal(await page.locator('#tblAttr tbody tr.daydetail').count(), 0);
    assert.equal(await page.locator('#tblAttr tfoot button').count(), 0, 'the total row is not a link');
    // Column headers sort: highest first, then lowest; the total row stays last.
    const order = async () => page.locator('#tblAttr tbody tr[data-attr]').evaluateAll(rows => rows.map(r => r.dataset.attr));
    await page.locator('#tblAttr th[data-sort="dOrders"]').click();
    assert.deepEqual(await order(), ['Alpha', 'Bravo']);
    assert.equal(await page.locator('#tblAttr th[data-sort="dOrders"]').getAttribute('aria-sort'), 'descending');
    await page.locator('#tblAttr th[data-sort="dOrders"]').click();
    assert.deepEqual(await order(), ['Bravo', 'Alpha']);
    await page.locator('#tblAttr th[data-sort="share"]').press('Enter');
    assert.deepEqual(await order(), ['Bravo', 'Alpha'], 'Bravo is 100% indirect, Alpha 67%');
    assert.equal(await page.evaluate(() => document.activeElement.closest('#tblAttr thead') && document.activeElement.dataset.sort), 'share',
      'a keyboard sort leaves focus on the header it sorted, not on the page');
    assert.match(await page.locator('#tblAttr tfoot').innerText(), /Total akun/);
  });

  test('a long product list shows five first and the rest on request', async page => {
    const T = 'Tipe Pesanan', indirect = 'Pesanan dari Toko yang tidak Dipromosikan';
    await upload(page, [{ name: 'affiliate.csv', rows: Array.from({ length: 8 }, (_, i) => ({ ...aff(String(i + 1)), [T]: indirect })) }]);
    const row = page.locator('#tblAttr tbody tr[data-attr="Alpha"]');
    await row.locator('button[data-kind="indirect"]').click();
    const products = () => page.locator('#tblAttr tr.daydetail tbody tr').count();
    assert.equal(await products(), 5);
    await page.locator('#tblAttr .attr-more').click();
    assert.equal(await products(), 8);
    assert.match(await page.locator('#tblAttr .attr-more').innerText(), /5 teratas/);
    await page.locator('#tblAttr .attr-more').click();
    assert.equal(await products(), 5);
    await page.locator('#tblAttr .attr-more').press('Enter');
    assert.equal(await products(), 8);
    assert.match(await page.evaluate(() => document.activeElement.className + ' ' + document.activeElement.textContent), /attr-more .*5 teratas/,
      'focus follows to the redrawn button');
  });

  test('the direct/indirect table filters by tag search and keeps the account total', async page => {
    await page.evaluate(() => { document.getElementById('ppn').value = '0'; });
    const typed = (id, tag, kind) => ({ ...aff(id, tag), 'Tipe Pesanan': kind });
    await upload(page, [{ name: 'affiliate.csv', rows: [typed('1', 'Alpha', 'Pesanan Produk dari Toko yang Dipromosikan'),
      typed('2', 'Bravo', 'Pesanan dari Toko yang tidak Dipromosikan'), typed('3', 'Charlie', 'Pesanan dari Toko yang tidak Dipromosikan')] }]);
    const tags = () => page.locator('#tblAttr tbody tr[data-attr]').evaluateAll(rows => rows.map(r => r.dataset.attr).sort());
    assert.deepEqual(await tags(), ['Alpha', 'Bravo', 'Charlie']);
    await page.fill('#attrSearch', 'brav');
    assert.deepEqual(await tags(), ['Bravo']);
    assert.match(await page.locator('#attrSearchCount').innerText(), /1 dari 3 tag/);
    assert.match(await page.locator('#tblAttr tfoot').innerText(), /Total akun/);
    await page.fill('#attrSearch', 'zzz');
    assert.match(await page.locator('#tblAttr tbody').innerText(), /Tidak ada tag yang cocok/);
    await page.fill('#attrSearch', '');
    assert.equal((await tags()).length, 3);
  });

  test('ad units show LP views; any table sorts by a header and keeps its header in view', async page => {
    await page.evaluate(() => { document.getElementById('ppn').value = '0'; });
    await upload(page, [{ name: 'affiliate.csv', rows: [aff('1', 'Alpha'), aff('2', 'Beta')] },
      { name: 'ads.csv', rows: [{ ...ad('Alpha', 100), 'Landing page views': '4' }, { ...ad('Beta', 300), 'Landing page views': '20' }, { ...ad('Gamma', 50), 'Landing page views': '0' }] }]);
    const unit = page.locator('#tblUnit');
    const head = await unit.locator('thead th').allInnerTexts();
    const lp = head.findIndex(h => /^LP View$/i.test(h.trim()));
    assert.ok(lp > head.findIndex(h => /CPC Meta/i.test(h)) && lp < head.findIndex(h => /Klik Shopee/i.test(h)), 'LP View sits between Meta and Shopee');
    assert.match(head[lp + 1], /Biaya\/LP View/i);
    const col = async i => (await unit.locator('tbody tr.dayrow').evaluateAll((rows, i) => rows.map(r => r.cells[i].innerText.trim()), i));
    assert.deepEqual(await col(lp + 1), ['Rp15', 'Rp25', '—']); // biggest spend first by default
    // Open Beta's daily rows, then sort by LP View: the detail row moves with Beta.
    await unit.locator('tbody tr.dayrow', { hasText: 'Beta' }).click();
    await unit.locator('thead th').nth(lp).click();
    assert.deepEqual((await col(0)).map(t => t.split(/\s/)[0]), ['Beta', 'Alpha', 'Gamma'], 'largest first, empty last');
    assert.equal(await unit.locator('tbody tr.dayrow').first().evaluate(r => r.nextElementSibling.classList.contains('daydetail')), true);
    assert.equal(await unit.locator('thead th').nth(lp).getAttribute('aria-sort'), 'descending');
    await unit.locator('thead th').nth(lp).click();
    assert.deepEqual((await col(0)).map(t => t.split(/\s/)[0]), ['Alpha', 'Beta', 'Gamma']);
    assert.equal(await unit.locator('tbody tr.dayrow').nth(1).evaluate(r => r.nextElementSibling.classList.contains('daydetail')), true, 'detail row follows Beta');
    // A re-render keeps the chosen order.
    await page.evaluate(() => recalc());
    assert.deepEqual((await col(0)).map(t => t.split(/\s/)[0]), ['Alpha', 'Beta', 'Gamma']);
    // The decision table keeps its own sorting.
    assert.equal(await page.locator('#tblMain th[data-sort="spend"]').getAttribute('aria-sort') !== null, true);
    // Long tables scroll inside their box, so the sticky header stays in view.
    const box = await page.locator('#tblUnit').evaluate(t => { const s = getComputedStyle(t.parentElement); return { overflowY: s.overflowY, maxHeight: s.maxHeight, th: getComputedStyle(t.tHead.rows[0].cells[0]).position }; });
    assert.equal(box.overflowY, 'auto');
    assert.notEqual(box.maxHeight, 'none');
    assert.equal(box.th, 'sticky');
  });

  test('a placement export feeds the platform card without doubling spend', async page => {
    await page.evaluate(() => { document.getElementById('ppn').value = '0'; });
    const plc = (platform, placement, spend, clicks) => ({ ...ad('Alpha', spend), Platform: platform, Placement: placement, 'Link clicks': String(clicks) });
    const placements = [plc('Facebook', 'Feed', 60, 6), plc('Facebook', 'Facebook Reels', 20, 2), plc('Instagram', 'Instagram Reels', 20, 2)];
    await upload(page, [{ name: 'affiliate.csv', rows: [aff('1', 'Alpha'), { ...aff('2', 'Alpha'), Platform: 'Instagram' }] },
      { name: 'placement.csv', rows: placements }]);
    assert.equal(await page.locator('#plcCard').isVisible(), true);
    // Daily placement rows stand in for the missing plain ads export.
    assert.equal(await page.evaluate(() => RESULT.kpi.spend), 100);
    const plat = await page.locator('#tblPlcPlat tbody').innerText();
    assert.match(plat, /Facebook\tRp80\t80%[\s\S]*2,50x/, 'ROAS uses the decimal comma like every other ratio');
    assert.match(plat, /Instagram\tRp20\t20%[\s\S]*10,00x/);
    assert.ok(!/100%/.test(plat.split('\n')[0].split('\t')[7]), 'no click report means no lost-click figure');
    // Clicking a tag opens its own placements with estimated commission.
    await page.locator('#tblPlcTag tr[data-plc-tag="Alpha"] .attr-open').click();
    const detail = await page.locator('#tblPlcTag tr.daydetail').innerText();
    assert.match(detail, /Feed[\s\S]*Rp60[\s\S]*Rp150/);
    assert.match(detail, /Instagram Reels[\s\S]*Rp20[\s\S]*Rp200/);
    await upload(page, [{ name: 'ads.csv', rows: [ad('Alpha', 100)] }]);
    assert.equal(await page.evaluate(() => RESULT.kpi.spend), 100, 'plain ads and placement rows are never added together');
    assert.match(await page.locator('#uploadStatus').innerText(), /Placement 3/);
  });

  test('an ad no tag claims raises a notice and can be matched by hand', async page => {
    await upload(page, [{ name: 'affiliate.csv', rows: [aff('1', 'Alpha'), aff('2', 'Bravo')] },
      { name: 'ads.csv', rows: [ad('Alpha', 100), ad('Zulu', 300)] }]);
    assert.match(await page.locator('#banners').innerText(), /1 iklan belum cocok ke tag Shopee/);
    await page.locator('#btnFixMatch').click();
    // Bravo has commission and no ad: it is listed as an unpaired tag and offered first.
    assert.match(await page.locator('#tblOrphan tbody').innerText(), /Bravo/);
    assert.equal(await page.locator('#tagOptions option').first().getAttribute('value'), 'Bravo');
    await page.check('#matchOnlyOpen');
    assert.deepEqual(await page.locator('#tblMatch tbody tr b').allInnerTexts(), ['Zulu']);
    await page.uncheck('#matchOnlyOpen');
    await page.fill('#matchSearch', 'alp');
    assert.deepEqual(await page.locator('#tblMatch tbody tr b').allInnerTexts(), ['Alpha']);
    assert.match(await page.locator('#tblOrphan tbody').innerText(), /Tidak ada tag yang cocok/);
    await page.fill('#matchSearch', '');
    const pick = page.locator('#tblMatch input[data-pick-ad="Zulu"]');
    await pick.fill('Nope');
    await pick.press('Enter');
    assert.equal(await page.evaluate(() => RESULT.tags.find(t => t.tag === 'Bravo').spend > 0), false, 'an unknown tag is refused');
    await pick.fill('Bravo');
    await page.locator('#tblMatch [data-pick-go]').first().click();
    await page.waitForFunction(() => !RESULT.matchLog.some(m => m.adName === 'Zulu' && m.confidence < .5));
    assert.equal(await page.evaluate(() => RESULT.tags.find(t => t.tag === 'Bravo').spend > 0), true);
    assert.doesNotMatch(await page.locator('#banners').innerText(), /belum cocok/);
  });

  test('a commission report without an attribution column says so instead of showing zeros', async page => {
    await upload(page, [{ name: 'affiliate.csv', rows: [aff('1', 'Alpha')] }]);
    assert.match(await page.locator('#tblAttr tbody').innerText(), /tidak punya kolom tipe atribusi/);
    assert.equal(await page.locator('#tblAttr tfoot').innerText(), '');
  });

  test('CSV upload renders metrics and sorts spend from highest to lowest', async page => {
    await page.evaluate(() => { document.getElementById('ppn').value = '0'; });
    await upload(page, [{ name: 'affiliate.csv', rows: [aff('1', 'Alpha'), aff('2', 'Bravo')] },
      { name: 'ads.csv', rows: [ad('Alpha', 100), ad('Bravo', 300)] }]);
    assert.equal(await page.locator('#main').isVisible(), true);
    assert.match(await page.locator('#tblMain tbody tr').first().innerText(), /Bravo/);
    await page.locator('#tblMain th[data-sort="spend"]').click();
    assert.match(await page.locator('#tblMain tbody tr').first().innerText(), /Alpha/);
    const totals = await page.evaluate(() => ({ comm: RESULT.kpi.comm, spend: RESULT.kpi.spend }));
    assert.deepEqual(totals, { comm: 400, spend: 400 });
    // Drill rows are display:none until opened, so read textContent, not innerText.
    const kpis = await page.locator('#kpis').textContent();
    assert.match(kpis, /Sudah Selesai/);
    assert.match(kpis, /Tertunda × 0,95/);
    assert.match(kpis, /ROAS hanya Selesai1,00x · batas bawah/);
  });

  test('Status Order shows cancelled order value and the cancellation rate', async page => {
    const cancelled = { ...aff('3'), 'Status Pesanan': 'Dibatalkan', 'Total Komisi per Pesanan(Rp)': '0', 'Nilai Pembelian(Rp)': '20000' };
    await upload(page, [{ name: 'affiliate.csv', rows: [aff('1'), aff('2'), cancelled] }]);
    const sum = await page.locator('#statSum').textContent();
    assert.match(sum, /nilai pesanan Rp20rb/, 'cancelled rows have zero commission; show the order value');
    assert.match(sum, /komisi Rp/);
    assert.match(sum, /Tingkat Batal/);
    assert.match(sum, /33,3%/);
    assert.match(sum, /1 dari 3 pesanan · menurut nilai 90,9% · terbesar Rp20rb/);
  });

  test('the decision table shows LP views, their cost and the share of clicks lost before Shopee', async page => {
    await page.evaluate(() => { document.getElementById('ppn').value = '0'; });
    await upload(page, [{ name: 'affiliate.csv', rows: [aff('1', 'Alpha')] },
      { name: 'ads.csv', rows: [ad('Alpha', 100)] },
      { name: 'clicks.csv', rows: [1, 2, 3, 4].map(i => ({ ...click(), 'Klik ID': 'k' + i })) }]);
    const head = await page.locator('#tblMain thead').innerText();
    for (const h of [/LP View/i, /Biaya\/LP View/i, /Klik Masuk Shopee/i, /CPC Shopee/i, /Klik Hilang/i]) assert.match(head, h);
    const cells = await page.locator('#tblMain tbody tr').first().locator('td').allInnerTexts();
    const col = key => page.evaluate(k => MC.findIndex(c => c[0] === k), key);
    assert.equal(cells[await col('lpv')], '8');
    assert.equal(cells[await col('cpLpv')], 'Rp13'); // Rp100 / 8 LP views
    assert.equal(cells[await col('lostTotal')], '60%'); // 10 Meta clicks, 4 reached Shopee
    await page.locator('#tblMain th[data-sort="lostTotal"]').click();
    assert.equal(await page.locator('#tblMain th[data-sort="lostTotal"]').getAttribute('aria-sort'), 'descending');
    await page.locator('#tblMain th[data-sort="lostTotal"]').press('Enter');
    assert.equal(await page.locator('#tblMain th[data-sort="lostTotal"]').getAttribute('aria-sort'), 'ascending');
    assert.equal(await page.evaluate(() => document.activeElement.closest('#tblMain thead') && document.activeElement.dataset.sort), 'lostTotal',
      'a keyboard sort leaves focus on the header it sorted');
  });

  test('Klik Hilang is coloured by the same link verdict as the Klik tab and rounds like the "cek link" note', async page => {
    const date = '2026-08-01';
    // Meta link clicks / Shopee clicks: 7,5% arrive (judged broken), 50% (warn), 5% on 299 clicks (unjudged),
    // 133% (Shopee counted more: ROAS is an upper bound), 95% (healthy), and 58/400, which is 14,499…% in floating point.
    const tags = [['Broken', 400, 30], ['Warn', 400, 200], ['Tiny', 299, 15], ['Over', 300, 400], ['Fine', 400, 380], ['Half', 400, 58]];
    const at = i => `${date} 09:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`;
    await upload(page, [
      { name: 'affiliate.csv', rows: tags.map(([tag]) => aff(tag, tag, date)) },
      { name: 'ads.csv', rows: tags.map(([tag, meta]) => ({ ...ad(tag, 40000, date), 'Link clicks': String(meta) })) },
      { name: 'clicks.csv', rows: tags.flatMap(([tag, , shopee]) => Array.from({ length: shopee }, (_, i) => ({ ...click(tag, date), 'Waktu Klik': at(i) }))) }]);
    const rows = await page.evaluate(() => {
      const col = MC.findIndex(c => c[0] === 'lostTotal');
      return Object.fromEntries([...document.querySelectorAll('#tblMain tbody tr.dayrow')].map(tr => {
        const cell = tr.querySelectorAll(':scope>td')[col];
        return [tr.dataset.bd, { text: cell.textContent, cls: [...cell.classList].filter(c => c !== 'num'), title: cell.title,
          note: tr.querySelector('.rs b') ? tr.querySelector('.rs b').textContent : '' }];
      }));
    });
    assert.deepEqual([rows.Broken.text, rows.Broken.cls], ['92%', ['leak-bad']]);
    assert.match(rows.Broken.note, /^hanya 8% klik sampai Shopee/, 'the note and the cell add up to 100%');
    assert.deepEqual([rows.Warn.text, rows.Warn.cls], ['50%', ['leak-warn']]);
    assert.deepEqual([rows.Tiny.text, rows.Tiny.cls], ['95%', []], 'under 300 clicks the share is shown but not judged');
    assert.match(rows.Tiny.title, /belum dinilai: 299 klik iklan \(perlu ±300\)/);
    assert.deepEqual([rows.Over.text, rows.Over.cls], ['+33% lebih', ['leak-over']], 'surplus clicks are not a green light');
    assert.match(rows.Over.note, /ROAS memuat trafik lain/);
    assert.deepEqual([rows.Fine.text, rows.Fine.cls], ['5%', ['leak-ok']]);
    assert.equal(Number(rows.Half.note.match(/hanya (\d+)%/)[1]) + Number(rows.Half.text.replace('%', '')), 100, rows.Half.note + ' beside ' + rows.Half.text);
    // The Klik tab marks the same tags the same way.
    const leakTab = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#tblLeak tbody tr')].map(tr =>
      [tr.querySelector('td b').textContent, [...tr.querySelectorAll('td')[4].classList].filter(c => c !== 'num')])));
    for (const tag of ['Broken', 'Warn', 'Tiny', 'Over', 'Fine', 'Half']) assert.deepEqual(leakTab[tag], rows[tag].cls, tag + ' matches the Klik tab');
    // A healthy period total beside a "klik masuk rendah" note (days the ad ran) is not painted green.
    assert.doesNotMatch(await page.evaluate(() => lostCell({ lostTotal: 5, leak: { reliable: true, severity: 'ok', metaClicks: 900 },
      capture: { low: true } }, '')), /leak-ok|pos/);
  });

  test('the per-date breakdown inside the compact tag table keeps its own click columns', async page => {
    await upload(page, [{ name: 'affiliate.csv', rows: [aff('1', 'Alpha')] }, { name: 'ads.csv', rows: [ad('Alpha', 100)] }]);
    assert.equal(await page.locator('#tblMain').getAttribute('class'), 'compact-columns');
    await page.locator('#tblMain tbody tr.dayrow').first().click();
    const shown = await page.locator('#tblMain .daydetail th').evaluateAll(ths => ths.filter(th => getComputedStyle(th).display !== 'none').map(th => th.textContent));
    for (const h of ['Klik Meta', 'CPC Meta', 'Klik Shopee']) assert.ok(shown.some(x => x.includes(h)), h + ' is hidden in the breakdown: ' + shown.join(' | '));
    const cells = await page.locator('#tblMain .daydetail tbody tr').first().locator('td').evaluateAll(tds => tds.filter(td => getComputedStyle(td).display !== 'none').length);
    assert.equal(cells, shown.length, 'every header has its cell');
    // The tag table itself still drops ROI, CPM, CR and Biaya/Order in this view.
    const main = await page.locator('#tblMain>thead>tr>th').evaluateAll(ths => ths.filter(th => getComputedStyle(th).display === 'none').map(th => th.dataset.sort));
    assert.deepEqual(main, ['roi', 'cpm', 'convRate', 'costPerOrder']);
  });

  test('the products header reads in full on a phone', async page => {
    await page.setViewportSize({ width: 360, height: 800 });
    const T = 'Tipe Pesanan', indirect = 'Pesanan dari Toko yang tidak Dipromosikan';
    await upload(page, [{ name: 'affiliate.csv', rows: [{ ...aff('1'), [T]: indirect }] }]);
    await page.locator('#tblAttr tbody tr[data-attr="Alpha"] button[data-kind="indirect"]').click();
    const fit = await page.locator('#tblAttr .attr-prod th').evaluateAll(ths => ths.filter(th => getComputedStyle(th).display !== 'none').map(th => {
      const range = document.createRange(); range.selectNodeContents(th);
      return { h: th.textContent, over: Math.round((range.getBoundingClientRect().right - th.getBoundingClientRect().right) * 10) / 10 };
    }));
    for (const { h, over } of fit) assert.ok(over <= 0, `${h} runs ${over}px past its cell`);
  });

  test('browser print keeps every column of the tag and ad tables on an A4 page', async page => {
    const T = 'Tipe Pesanan', tag = 'A_long_campaign_tag_name_for_print';
    for (const split of [false, true]) {
      if (split) {
        await page.emulateMedia({ media: null });
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.reload({ waitUntil: 'load' });
        await page.waitForFunction(() => window.Engine && window.Papa && window.DailyStore && window.__dailyStore);
      }
      const order = (id, t) => split ? { ...aff(id, t), [T]: 'Pesanan dari Toko yang tidak Dipromosikan' } : aff(id, t);
      await upload(page, [{ name: 'affiliate.csv', rows: [order('1', tag), order('2', 'Bravo')] },
        { name: 'ads.csv', rows: [ad(tag, 1500000), ad('Bravo', 250000)] }, { name: 'clicks.csv', rows: [click(tag)] }]);
      // What runPrint('ringkas') sets, without opening the print dialog.
      await page.evaluate(() => document.body.classList.add('printing', 'pr-ringkas', 'pp-tags', 'pp-units', 'pp-peluang'));
      await page.emulateMedia({ media: 'print' });
      await page.setViewportSize({ width: 718, height: 1000 }); // A4 at 10 mm side margins
      for (const compact of [true, false]) {
        await page.evaluate(on => document.getElementById('tblMain').classList.toggle('compact-columns', on), compact);
        const fit = await page.evaluate(() => ['tblMain', 'tblUnit'].map(id => {
          const table = document.getElementById(id), card = table.closest('.card'), style = getComputedStyle(card);
          const inner = card.getBoundingClientRect().right - parseFloat(style.paddingRight) - parseFloat(style.borderRightWidth);
          return { id, over: Math.round(table.getBoundingClientRect().right - inner) };
        }));
        const label = (split ? 'with' : 'without') + ' Tipe Pesanan, ' + (compact ? 'compact' : 'all metrics');
        for (const { id, over } of fit) assert.ok(over <= 0, `${id} (${label}) runs ${over}px off the page`);
        // Anything wider makes Chrome shrink the whole page, small print included.
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth) <= 718, `the page (${label}) is wider than A4`);
      }
    }
  });

  test('showing every product keeps the page where it was and focus on the button', async page => {
    await page.setViewportSize({ width: 1440, height: 700 });
    const T = 'Tipe Pesanan', indirect = 'Pesanan dari Toko yang tidak Dipromosikan';
    await upload(page, [{ name: 'affiliate.csv', rows: Array.from({ length: 40 }, (_, i) => ({ ...aff(String(i + 1)), [T]: indirect })) }]);
    await page.locator('#tblAttr tbody tr[data-attr="Alpha"] button[data-kind="indirect"]').click();
    await page.locator('#tblAttr .attr-more').scrollIntoViewIfNeeded();
    const before = await page.evaluate(() => scrollY);
    await page.locator('#tblAttr .attr-more').press('Enter');
    assert.equal(await page.locator('#tblAttr tr.daydetail tbody tr').count(), 40);
    assert.ok(Math.abs(await page.evaluate(() => scrollY) - before) <= 2, 'product 6 onward stays in view instead of scrolling to the list end');
    assert.match(await page.evaluate(() => document.activeElement.className), /attr-more/);
  });

  test('arrived clicks show every source; Klik Hilang counts Facebook and Instagram', async page => {
    await page.evaluate(() => { document.getElementById('ppn').value = '0'; });
    const from = (i, p) => ({ ...click(), 'Klik ID': 'k' + i, Perujuk: p });
    await upload(page, [{ name: 'affiliate.csv', rows: [aff('1', 'Alpha')] },
      { name: 'ads.csv', rows: [ad('Alpha', 100)] },
      { name: 'clicks.csv', rows: [from(1, 'Facebook'), from(2, 'Instagram'), from(3, 'Others'), from(4, 'WhatsApp')] }]);
    const head = await page.locator('#tblMain thead').innerText();
    assert.match(head, /Klik Masuk Shopee/i);
    assert.doesNotMatch(head, /FB\+IG/i);
    const cells = await page.locator('#tblMain tbody tr').first().locator('td').allInnerTexts();
    const col = key => page.evaluate(k => MC.findIndex(c => c[0] === k), key);
    assert.equal(cells[await col('shopeeClicks')], '4');
    assert.equal(cells[await col('clicks')], '10');
    assert.equal(cells[await col('lostTotal')], '80%'); // 10 Meta clicks, 2 from Facebook/Instagram
  });

  test('the platform card lists Other sources under Facebook and Instagram', async page => {
    await page.evaluate(() => { document.getElementById('ppn').value = '0'; });
    const plc = (platform, placement, spend, clicks) => ({ ...ad('Alpha', spend), Platform: platform, Placement: placement, 'Link clicks': String(clicks) });
    const from = (i, p) => ({ ...click(), 'Klik ID': 'k' + i, Perujuk: p });
    await upload(page, [{ name: 'affiliate.csv', rows: [aff('1', 'Alpha'), { ...aff('2', 'Alpha'), Platform: 'Others' }] },
      { name: 'placement.csv', rows: [plc('Facebook', 'Feed', 80, 8), plc('Instagram', 'Instagram Reels', 20, 2)] },
      { name: 'clicks.csv', rows: [from(1, 'Facebook'), from(2, 'Others'), from(3, 'Others'), from(4, 'Websites')] }]);
    const plat = await page.locator('#tblPlcPlat tbody').innerText();
    assert.match(plat, /Other \(bukan FB\/IG\)\s*▸?\s*Others 2 · Websites 1/);
    const place = await page.locator('#tblPlcPlace tbody tr.plc-other').innerText();
    assert.match(place, /^Other\s*▸?\s*Bukan placement Meta\s*3 klik Shopee · 1 pesanan · Others 2 · Websites 1\s*Rp200\s*—$/);
    await page.locator('#tblPlcTag tr[data-plc-tag="Alpha"] .attr-open').click();
    assert.match(await page.locator('#tblPlcTag tr.daydetail tr.plc-other').innerText(), /3 klik Shopee · 1 pesanan/);
    // Opening Other lists the tags its clicks landed on.
    await page.locator('#tblPlcPlat button[data-other="plat"]').click();
    const tagsOther = await page.locator('#tblPlcPlat tr.daydetail').innerText();
    assert.match(tagsOther, /Alpha\s*3\s*1\s*Rp200\s*Others 2 · Websites 1/);
    await page.locator('#tblPlcPlace button[data-other="place"]').click();
    assert.equal(await page.locator('#tblPlcPlace tr.daydetail').count(), 1);
    await page.locator('#tblPlcPlat button[data-other="plat"]').click();
    assert.equal(await page.locator('#tblPlcPlat tr.daydetail').count(), 0);
  });

  test('platform rows take the link verdict colours of the tag table', async page => {
    await page.evaluate(() => { document.getElementById('ppn').value = '0'; });
    const plc = (platform, placement, spend, clicks) => ({ ...ad('Alpha', spend), Platform: platform, Placement: placement, 'Link clicks': String(clicks) });
    const from = (i, p) => ({ ...click(), 'Klik ID': 'k' + i, Perujuk: p });
    await upload(page, [{ name: 'affiliate.csv', rows: [aff('1', 'Alpha')] },
      { name: 'placement.csv', rows: [plc('Facebook', 'Feed', 80, 400), plc('Instagram', 'Instagram Reels', 20, 100)] },
      { name: 'clicks.csv', rows: Array.from({ length: 40 }, (_, i) => from(i, 'Facebook')) }]);
    const lostAt = await page.evaluate(() => [...document.querySelectorAll('#tblPlcPlat thead th')].findIndex(th => th.textContent === 'Klik hilang'));
    const cell = name => page.locator('#tblPlcPlat tbody tr', { hasText: name }).first().locator('td').nth(lostAt);
    // 40 of 400 arrived: judged, and red like a tag's "cek link".
    assert.equal(await cell('Facebook').innerText(), '90%');
    assert.match(await cell('Facebook').getAttribute('class'), /leak-bad/);
    // 100 Meta clicks is under the 300-click floor: shown, not judged.
    assert.equal(await cell('Instagram').innerText(), '100%');
    assert.doesNotMatch(await cell('Instagram').getAttribute('class'), /leak-|neg|pos/);
    assert.match(await cell('Instagram').getAttribute('title'), /belum dinilai: 100 klik iklan/);
  });

  test('a tag in the click table opens its placements with spend, clicks and commission', async page => {
    await page.evaluate(() => { document.getElementById('ppn').value = '0'; });
    const plc = (platform, placement, spend, clicks, impr) => ({ ...ad('Alpha', spend), Platform: platform, Placement: placement, 'Link clicks': String(clicks), Impressions: String(impr) });
    const from = (i, p) => ({ ...click(), 'Klik ID': 'k' + i, Perujuk: p });
    const shopee = [['Facebook', 250], ['Instagram', 200], ['Others', 30]].flatMap(([p, n]) => Array.from({ length: n }, () => p));
    await upload(page, [
      { name: 'affiliate.csv', rows: [aff('1'), aff('2'), aff('3'), { ...aff('4'), Platform: 'Instagram' }, { ...aff('5'), Platform: 'Instagram' }, { ...aff('6'), Platform: 'Others' }] },
      { name: 'ads.csv', rows: [{ ...ad('Alpha', 130000), 'Link clicks': '1170' }] },
      { name: 'placement.csv', rows: [plc('Facebook', 'Feed', 60000, 300, 20000), plc('Facebook', 'Facebook Stories', 20000, 200, 9000),
        plc('Instagram', 'Instagram Stories', 30000, 400, 8000), plc('Instagram', 'Instagram Reels', 15000, 120, 6000),
        plc('Audience Network', 'Native, banner and interstitial', 5000, 150, 30000)] },
      { name: 'clicks.csv', rows: shopee.map((p, i) => from(i, p)) }]);
    await page.locator('[data-tab="klik"]').click();
    // Spend, commission and profit sit on the tag row, so it reads without opening.
    const head = (await page.locator('#tblLeak > thead th').allInnerTexts()).map(s => s.trim().toUpperCase());
    assert.deepEqual(head.slice(6, 9), ['BIAYA', 'KOMISI EFEKTIF', 'LABA']);
    const tagRow = page.locator('#tblLeak > tbody > tr').first().locator('td');
    assert.deepEqual((await tagRow.allInnerTexts()).slice(6, 9).map(s => s.trim()), ['Rp130rb', 'Rp1rb', '-Rp129rb']);
    assert.match(await tagRow.nth(8).getAttribute('class'), /neg/);
    const button = page.locator('#tblLeak button[data-leak-tag="Alpha"]');
    assert.equal(await button.getAttribute('aria-expanded'), 'false');
    await button.click();
    assert.equal(await button.getAttribute('aria-expanded'), 'true');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.leakTag), 'Alpha', 'opening keeps focus on the tag');
    const detail = page.locator('#tblLeak > tbody > tr.daydetail');
    const row = async name => (await detail.locator('tr', { hasText: name }).first().locator('td').allInnerTexts()).map(s => s.trim());
    // Arrivals are real per platform: 250 of 500 Facebook clicks, judged like the tag row.
    assert.deepEqual(await row('Facebook'), ['Facebook', 'Rp80.000', '500', '43%', '1,72%', 'Rp160', '250', '50,0%', 'Rp600', '0,01x']);
    assert.match(await detail.locator('tr.plc-plat', { hasText: 'Facebook' }).locator('td').nth(7).getAttribute('class'), /leak-warn/);
    assert.deepEqual(await row('Instagram Stories'), ['Instagram Stories', 'Rp30.000', '400', '34%', '5,00%', 'Rp75', '—', '—', 'Rp308', '0,01x'],
      'a placement has no Shopee arrivals of its own; its commission is the platform split by click share');
    assert.equal((await row('Facebook Stories'))[8], 'Rp240');
    assert.deepEqual((await row('Lainnya')).slice(6, 8), ['—', '—'], 'Audience Network arrivals land under Other, so no % is claimed');
    assert.deepEqual((await row('Other (bukan FB/IG)')).slice(-4), ['30', '—', 'Rp200', '—']);
    const total = (await detail.locator('tfoot td').allInnerTexts()).map(s => s.trim());
    assert.deepEqual(total, ['Total tag', 'Rp130.000', '1.170', '100%', '1,60%', 'Rp111', '450', '38,5%', 'Rp1.200', '0,01x']);
    assert.equal(await page.locator('#tblLeak > tbody > tr').first().locator('td').nth(4).innerText(), '38,5%', 'the total matches the tag row');
    assert.match(await detail.innerText(), /Shopee hanya mencatat asal klik per platform/);
    // The opened box moves with its row when the table is sorted, and closes again.
    await page.locator('#tblLeak > thead th', { hasText: 'Klik Meta' }).click();
    assert.equal(await page.evaluate(() => document.querySelector('#tblLeak button[data-leak-tag="Alpha"]').closest('tr').nextElementSibling.className), 'daydetail');
    await button.focus();
    await page.keyboard.press('Enter');
    assert.equal(await detail.count(), 0);
    assert.equal(await button.getAttribute('aria-expanded'), 'false');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.leakTag), 'Alpha', 'a sorted table keeps focus on the tag');
    // Biaya carries PPN like every other spend figure, and stays open across a recalculation.
    await button.click();
    await setPpn(page, '11');
    assert.deepEqual((await row('Facebook')).slice(0, 2), ['Facebook', 'Rp88.800']);
  });

  test('the placement box in the click table says what is missing', async page => {
    await page.evaluate(() => { document.getElementById('ppn').value = '0'; });
    await upload(page, [{ name: 'affiliate.csv', rows: [aff('1')] }, { name: 'ads.csv', rows: [ad('Alpha', 100)] }, { name: 'clicks.csv', rows: [click()] }]);
    await page.locator('[data-tab="klik"]').click();
    await page.locator('#tblLeak button[data-leak-tag="Alpha"]').click();
    assert.match(await page.locator('#tblLeak tr.daydetail').innerText(), /Unggah file Meta Ads per placement/);
    // A whole-period file outside the click report: Meta numbers show, arrivals do not.
    const week = { ...ad('Alpha', 700), 'Reporting starts': '2026-07-25', 'Reporting ends': '2026-07-31', Platform: 'Facebook', Placement: 'Feed', 'Link clicks': '70' };
    await upload(page, [{ name: 'placement.csv', rows: [week] }]);
    const text = await page.locator('#tblLeak tr.daydetail').innerText();
    assert.match(text, /Facebook\tRp700\t70\t100%/);
    assert.match(text, /Total tag\tRp700\t70\t100%\t[^\t]+\tRp10\t—\t—/);
    assert.match(text, /2026-07-25 s\/d 2026-07-31 tidak berada di dalam periode laporan klik \(2026-08-01 s\/d 2026-08-01\)/);
  });

  test('without Perujuk the placement box compares arrivals for the whole tag only', async page => {
    await page.evaluate(() => { document.getElementById('ppn').value = '0'; });
    const plc = (platform, placement, clicks) => ({ ...ad('Alpha', clicks * 100), Platform: platform, Placement: placement, 'Link clicks': String(clicks) });
    const { Platform, ...noPlatform } = aff('1');
    await upload(page, [{ name: 'affiliate.csv', rows: [noPlatform] },
      { name: 'ads.csv', rows: [{ ...ad('Alpha', 50000), 'Link clicks': '500' }] },
      { name: 'placement.csv', rows: [plc('Facebook', 'Feed', 300), plc('Instagram', 'Instagram Stories', 200)] },
      { name: 'clicks.csv', rows: Array.from({ length: 460 }, (_, i) => { const { Perujuk, ...c } = click(); return { ...c, 'Klik ID': 'k' + i }; }) }]);
    await page.locator('[data-tab="klik"]').click();
    await page.locator('#tblLeak button[data-leak-tag="Alpha"]').click();
    const box = page.locator('#tblLeak tr.daydetail');
    const fb = (await box.locator('tr.plc-plat').first().locator('td').allInnerTexts()).map(s => s.trim());
    assert.deepEqual(fb.slice(6), ['—', '—', '—', '—'], 'no platform arrivals, and no ROAS without a Platform column');
    assert.equal(await box.locator('tr.plc-other').count(), 0);
    const total = (await box.locator('tfoot td').allInnerTexts()).map(s => s.trim());
    assert.deepEqual(total.slice(6, 8), ['460', '92,0%'], 'the total matches the tag row');
    assert.match(await box.innerText(), /Laporan klik tanpa kolom Perujuk/);
  });

  test('placements under a tag in the click table cover only the click report days', async page => {
    await page.evaluate(() => { document.getElementById('ppn').value = '0'; });
    const feed = date => ({ ...ad('Alpha', 100, date), Platform: 'Facebook', Placement: 'Feed' });
    await upload(page, [{ name: 'affiliate.csv', rows: [aff('1')] },
      { name: 'ads.csv', rows: [ad('Alpha', 100, '2026-07-31'), ad('Alpha', 100)] },
      { name: 'placement.csv', rows: [feed('2026-07-31'), feed('2026-08-01')] },
      { name: 'clicks.csv', rows: Array.from({ length: 5 }, (_, i) => ({ ...click(), 'Klik ID': 'k' + i })) }]);
    await page.locator('[data-tab="klik"]').click();
    await page.locator('#tblLeak button[data-leak-tag="Alpha"]').click();
    // The click report holds 1 Aug only: the tag row and its placements both count that day.
    assert.equal(await page.locator('#tblLeak > tbody > tr').first().locator('td').nth(1).innerText(), '10');
    // 31 Jul spend is outside the click report: the row's profit counts 1 Aug only.
    const money = (await page.locator('#tblLeak > tbody > tr').first().locator('td').allInnerTexts()).slice(6, 9).map(s => s.trim());
    assert.deepEqual(money, ['Rp100', 'Rp200', 'Rp100']);
    const fb = (await page.locator('#tblLeak tr.daydetail tr.plc-plat').first().locator('td').allInnerTexts()).map(s => s.trim());
    assert.deepEqual(fb.slice(0, 3).concat(fb.slice(6, 8)), ['Facebook', 'Rp100', '10', '5', '50,0%']);
    assert.match(await page.locator('#tblLeak tr.daydetail .dayhead').innerText(), /2026-08-01 s\/d 2026-08-01/);
  });

  test('shared clicks that lift a tag over its ad clicks are named with every source', async page => {
    await page.evaluate(() => { document.getElementById('ppn').value = '0'; });
    const from = (i, p) => ({ ...click(), 'Klik ID': 'k' + i, Perujuk: p });
    await upload(page, [{ name: 'affiliate.csv', rows: [aff('1', 'Alpha')] },
      { name: 'ads.csv', rows: [{ ...ad('Alpha', 100), 'Link clicks': '300' }] },
      { name: 'clicks.csv', rows: Array.from({ length: 735 }, (_, i) => from(i, i < 285 ? 'Facebook' : 'Others')) }]);
    // 285 of 300 from Facebook is a healthy link; with 450 shares the tag's ROAS is an upper bound.
    assert.match(await page.locator('#tblMain tbody tr').first().locator('.rs').innerText(), /klik Shopee 245% dari klik iklan — ROAS memuat trafik lain/);
    assert.match(await page.locator('#tblLeak thead').innerText(), /Klik Shopee FB\+IG/);
    const row = await page.locator('#tblLeak tbody tr').first().innerText();
    assert.match(row, /285[\s\S]*95,0%[\s\S]*Semua perujuk 245% dari klik iklan — ada trafik lain/);
  });

  test('renamed reports and overlapping CSV rows cannot inflate totals', async page => {
    await page.evaluate(() => { document.getElementById('ppn').value = '0'; });
    const row1 = aff('1'), row2 = aff('2');
    await upload(page, [{ name: 'first.csv', rows: [row1] }]);
    await upload(page, [{ name: 'renamed.csv', rows: [row1] }]);
    assert.equal(await page.evaluate(() => RESULT.kpi.comm), 200);
    await upload(page, [{ name: 'overlapping.csv', rows: [row1, row2] }]);
    assert.equal(await page.evaluate(() => RESULT.kpi.comm), 400);
    assert.equal(await page.evaluate(() => RESULT.kpi.orders), 2);
    await upload(page, [{ name: 'ads-1.csv', rows: [ad()] }]);
    await upload(page, [{ name: 'ads-renamed.csv', rows: [ad()] }]);
    assert.equal(await page.evaluate(() => RESULT.kpi.spend), 100);
  });

  test('different reports sharing filename and byte length are both accepted', async page => {
    const a = csv([aff('1')]), b = csv([aff('2')]);
    assert.equal(Buffer.byteLength(a), Buffer.byteLength(b));
    await upload(page, [{ name: 'report.csv', content: a }]);
    await upload(page, [{ name: 'report.csv', content: b }]);
    assert.equal(await page.evaluate(() => RESULT.kpi.orders), 2);
    assert.equal(await page.evaluate(() => RESULT.kpi.comm), 400);
  });

  test('unknown and malformed CSVs are rejected without invisible file entries', async page => {
    await upload(page, [{ name: 'unknown.csv', content: 'hello,world\n1,2' }]);
    assert.equal(await page.evaluate(() => FILES.length), 0);
    assert.equal(await page.locator('#emptyState').isVisible(), true);
    await upload(page, [{ name: 'broken.csv', content: 'ID Pemesanan,Status Pesanan,Waktu Pemesanan,Total Komisi per Pesanan(Rp)\n1,Selesai,"2026-08-01,200' }]);
    assert.equal(await page.evaluate(() => FILES.length), 0);
    assert.equal(await page.evaluate(() => RESULT), null);
  });

  test('removing the last affiliate report clears results and date controls', async page => {
    await upload(page, [{ name: 'affiliate.csv', rows: [aff()] }]);
    await page.locator('[data-zchips="affiliate"] [data-rm]').click();
    assert.equal(await page.locator('#emptyState').isVisible(), true);
    assert.equal(await page.locator('#gapCard').isVisible(), false);
    assert.deepEqual(await page.evaluate(() => ({ result: RESULT, min: DATES.min, max: DATES.max,
      start: document.getElementById('dateStart').value, end: document.getElementById('dateEnd').value })),
    { result: null, min: '', max: '', start: '', end: '' });
    await page.locator('#btnSave').click();
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('adash_snaps_v3_default') || '[]').length), 0);
  });

  test('new accounts and existing unconfigured accounts use their own defaults', async page => {
    const baseline = await page.evaluate(() => ({ ppn: document.getElementById('ppn').value,
      roi: document.getElementById('targetROI').value }));
    await page.evaluate(() => {
      document.getElementById('ppn').value = '12';
      document.getElementById('targetROI').value = '125';
      document.getElementById('targetROI').dispatchEvent(new Event('change'));
    });
    page.once('dialog', dialog => dialog.accept('Fresh Account'));
    await page.locator('#btnNewAcct').click();
    assert.deepEqual(await page.evaluate(() => ({ ppn: document.getElementById('ppn').value,
      roi: document.getElementById('targetROI').value })), baseline);
    await page.selectOption('#account', 'default');
    assert.equal(await page.locator('#targetROI').inputValue(), '125');
    await page.selectOption('#account', 'Account B');
    assert.deepEqual(await page.evaluate(() => ({ ppn: document.getElementById('ppn').value,
      roi: document.getElementById('targetROI').value })), baseline);
  });

  for (const action of ['switch', 'reset']) {
    test(`CSV parse completion cannot resurrect data after ${action}`, async page => {
      await page.evaluate(() => {
        const read = FileReader.prototype.readAsArrayBuffer;
        window.__heldParses = [];
        FileReader.prototype.readAsArrayBuffer = function (...args) {
          window.__heldParses.push(() => read.apply(this, args));
        };
      });
      await page.setInputFiles('#files', { name: 'slow.csv', mimeType: 'text/csv', buffer: Buffer.from(csv([aff()])) });
      await page.waitForFunction(() => window.__heldParses.length > 0);
      if (action === 'switch') await page.selectOption('#account', 'Account B');
      else { page.once('dialog', dialog => dialog.accept()); await page.locator('#btnReset').click(); }
      await page.evaluate(() => window.__heldParses.splice(0).forEach(release => release()));
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
      assert.equal(await page.evaluate(() => RESULT), null);
      assert.equal(await page.evaluate(() => FILES.length), 0);
      assert.equal(await page.locator('#main').isVisible(), false);
      assert.equal(await page.locator('#ingestPlan').isVisible(), false);
    });
  }

  test('snapshot history imports on an empty dashboard without chart errors', async page => {
    await importSnapshots(page, [snapshot(1), snapshot(2, '2026-08-02')]);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('adash_snaps_v3_default') || '[]').length), 2);
    await page.locator('#btnHist').click();
    assert.equal(await page.locator('#histRows .snaprow').count(), 2);
    assert.equal(await page.evaluate(() => RESULT), null);
  });

  test('invalid imported snapshots cannot poison persisted history', async page => {
    await importSnapshots(page, [snapshot(1)]);
    const before = await page.evaluate(() => localStorage.getItem('adash_snaps_v3_default'));
    await importSnapshots(page, [{ id: 2, saved: '2026-08-02 12:00:00' }]);
    assert.equal(await page.evaluate(() => localStorage.getItem('adash_snaps_v3_default')), before);
    await page.locator('#btnHist').click();
    assert.equal(await page.locator('#histRows .snaprow').count(), 1);
  });

  test('imported snapshot strings cannot create HTML or execute script', async page => {
    const attack = '<img src=x onerror="window.__snapshotXss=1">';
    const poisoned = snapshot(1);
    poisoned.saved = attack;
    poisoned.range.start = attack;
    poisoned.range.end = attack;
    poisoned.id = '\"><img src=x onerror="window.__snapshotXss=1">';
    poisoned.tags[0].status = '\"><img src=x onerror="window.__snapshotXss=1">';
    await importSnapshots(page, [poisoned, snapshot(2, '2026-08-02')]);
    await page.locator('#btnHist').click();
    assert.equal(await page.evaluate(() => window.__snapshotXss), undefined);
    assert.equal(await page.locator('#histRows img, #trendBody img').count(), 0);
    // The rendering boundary must also tolerate old/corrupted browser storage.
    await page.evaluate(snapshot => {
      localStorage.setItem('adash_snaps_v3_default', JSON.stringify([snapshot]));
    }, poisoned);
    await page.reload({ waitUntil: 'load' });
    assert.equal(await page.evaluate(() => window.__snapshotXss), undefined);
    assert.equal(await page.locator('#histRows img').count(), 0);
  });

  test('repeated snapshot IDs inside one import are deduplicated', async page => {
    await importSnapshots(page, [snapshot(1), snapshot(1)]);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('adash_snaps_v3_default') || '[]').length), 1);
  });

  for (const action of ['switch', 'reset']) {
  test(`snapshot read completion cannot import after ${action}`, async page => {
    await page.evaluate(() => {
      const read = FileReader.prototype.readAsText;
      window.__heldReads = [];
      FileReader.prototype.readAsText = function (...args) {
        window.__heldReads.push(() => read.apply(this, args));
      };
    });
    await page.setInputFiles('#importFile', { name: 'slow.json', mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ snapshots: [snapshot(1)] })) });
    await page.waitForFunction(() => window.__heldReads.length > 0);
    if (action === 'switch') await page.selectOption('#account', 'Account B');
    else await page.locator('#btnReset').click();
    await page.evaluate(() => window.__heldReads.splice(0).forEach(release => release()));
    await page.waitForFunction(() => !document.getElementById('importFile').value);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('adash_snaps_v3_Account B') || '[]').length), 0);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('adash_snaps_v3_default') || '[]').length), 0);
  });
  }

  test('saving overlapping daily reports preserves every unique order exactly once', async page => {
    const first = aff('1'), second = aff('2');
    await upload(page, [{ name: 'first.csv', rows: [first] }]);
    await saveDaily(page);
    await upload(page, [{ name: 'overlap.csv', rows: [first, second] }]);
    await saveDaily(page);
    const rows = await storedRows(page);
    assert.equal(rows.reduce((sum, row) => sum + row.comm, 0), 400);
    assert.equal(rows.reduce((sum, row) => sum + row.orders, 0), 2);
    await page.locator('[data-tab="tersimpan"]').click();
    assert.match(await page.locator('#tblStored tbody').innerText(), /400/);
    const history = await page.locator('#tblUploads tbody').innerText();
    await upload(page, [{ name: 'renamed.csv', rows: [first, second] }]);
    assert.equal(await page.locator('#btnSaveAll').getAttribute('data-mode'), 'close');
    assert.deepEqual(await storedRows(page), rows);
    assert.equal(await page.locator('#tblUploads tbody').innerText(), history);
  });

  test('saved history shows direct and indirect orders per tag, old days as unknown', async page => {
    const T = 'Tipe Pesanan';
    await upload(page, [{ name: 'old.csv', rows: [aff('9', 'Bravo')] }]);
    await saveDaily(page);
    await upload(page, [{ name: 'new.csv', rows: [{ ...aff('1'), [T]: 'Pesanan Produk dari Toko yang Dipromosikan' },
      { ...aff('2'), [T]: 'Pesanan dari Toko yang tidak Dipromosikan' }, { ...aff('3'), [T]: 'Pesanan dari Toko yang tidak Dipromosikan' }] }]);
    await saveDaily(page);
    await page.locator('[data-tab="tersimpan"]').click();
    await page.waitForFunction(() => document.querySelectorAll('#tblStoredAttr tbody tr').length === 2);
    const cells = async row => (await row.locator('td').allInnerTexts()).map(x => x.trim());
    assert.deepEqual(await cells(page.locator('#tblStoredAttr tbody tr', { hasText: 'Alpha' })), ['Alpha', '1', 'Rp200', '2', 'Rp400', '67%', '0 · Rp0']);
    assert.deepEqual(await cells(page.locator('#tblStoredAttr tbody tr', { hasText: 'Bravo' })), ['Bravo', '0', 'Rp0', '0', 'Rp0', '—', '1 · Rp200']);
    assert.deepEqual(await cells(page.locator('#tblStoredAttr tfoot tr')), ['Total akun', '1', 'Rp200', '2', 'Rp400', '67%', '1 · Rp200']);
  });

  test('deleting one stored day and saving again restores it without doubling other days', async page => {
    await upload(page, [{ name: 'two-days.csv', rows: [aff('1'), aff('2', 'Alpha', '2026-08-02')] }]);
    await saveDaily(page);
    await page.locator('[data-tab="tersimpan"]').click();
    page.once('dialog', dialog => dialog.accept());
    await page.locator('[data-del-day="affiliate|2026-08-01"]').click();
    await page.waitForFunction(() => !document.querySelector('[data-del-day="affiliate|2026-08-01"]'));
    assert.deepEqual((await storedRows(page)).map(row => [row.date, row.comm]), [['2026-08-02', 200]]);
    await saveDaily(page);
    const rows = await storedRows(page);
    assert.deepEqual(rows.map(row => [row.date, row.comm, row.orders]).sort(),
      [['2026-08-01', 200, 1], ['2026-08-02', 200, 1]]);
    assert.equal(await page.evaluate(() => RESULT.kpi.comm), 400);
  });

  test('saving daily data stays isolated from another account', async page => {
    await upload(page, [{ name: 'affiliate.csv', rows: [aff()] }]);
    await saveDaily(page);
    await page.selectOption('#account', 'Account B');
    await page.waitForFunction(() => document.getElementById('storedNote').textContent === 'Belum ada data tersimpan');
    await upload(page, [{ name: 'other-account.csv', rows: [aff('2'), aff('3')] }]);
    await saveDaily(page);
    assert.equal((await storedRows(page, 'affiliate', 'default')).reduce((sum, row) => sum + row.comm, 0), 200);
    assert.equal((await storedRows(page, 'affiliate', 'Account B')).reduce((sum, row) => sum + row.comm, 0), 400);
  });

  test('ads and clicks can be saved before an affiliate report is loaded', async page => {
    await upload(page, [{ name: 'ads.csv', rows: [ad()] }, { name: 'clicks.csv', rows: [click()] }]);
    await saveDaily(page);
    assert.equal((await storedRows(page, 'ads')).reduce((sum, row) => sum + row.spend, 0), 100);
    assert.equal((await storedRows(page, 'clicks')).reduce((sum, row) => sum + row.clicks, 0), 1);
    assert.match(await page.locator('#storedNote').textContent(), /1 hari/);
    assert.match(await page.locator('#tblStored tbody').textContent(), /2026-08-01/);
  });

  test('daily history remains accessible after reload and honors current zero-valued settings', async page => {
    await page.evaluate(() => {
      const ppn = document.getElementById('ppn');
      document.getElementById('pendingFactor').value = '0';
      ppn.value = '0'; ppn.dispatchEvent(new Event('change'));
    });
    await upload(page, [{ name: 'affiliate.csv', rows: [aff(), { ...aff('2'), 'Status Pesanan': 'Tertunda' }] },
      { name: 'ads.csv', rows: [ad()] }]);
    await saveDaily(page);
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => window.__dailyStore);
    await page.locator('#btnStored').click();
    await page.waitForFunction(() => Boolean(Chart.getChart(document.getElementById('chStored'))));
    assert.equal(await page.evaluate(() => RESULT), null);
    assert.equal(await page.locator('[data-panel="tersimpan"]').isVisible(), true);
    assert.equal(await page.locator('#kpis').isVisible(), false);
    assert.equal(await page.locator('#tblStored tbody tr').first().locator('td').nth(1).innerText(), 'Rp200');
    assert.equal(await page.locator('#tblStored tbody tr').first().locator('td').nth(2).innerText(), 'Rp100');
    assert.equal(await page.locator('#tblStored tbody tr').first().locator('td').nth(9).innerText(), 'Rp10', 'stored CPC is money too');
    await page.evaluate(() => {
      document.getElementById('ppn').value = '11';
      const factor = document.getElementById('pendingFactor');
      factor.value = '0.5'; factor.dispatchEvent(new Event('change'));
    });
    await page.waitForFunction(() => document.querySelector('#tblStored tbody tr td:nth-child(2)').textContent === 'Rp300');
    assert.equal(await page.locator('#tblStored tbody tr').first().locator('td').nth(2).innerText(), 'Rp111');
    const strip = Object.fromEntries(await page.locator('#storedStrip .s').evaluateAll(cells =>
      cells.map(cell => [cell.querySelector('.l').textContent, cell.querySelector('.v').textContent])));
    assert.equal(strip['Komisi Efektif'], 'Rp300');
    assert.equal(strip['Komisi Total'], 'Rp400', 'the stored total sits beside the effective headline');
    assert.equal(strip['Biaya + PPN 11%'], 'Rp111');
    await page.selectOption('#account', 'Account B');
    await page.locator('#btnStored').click();
    await page.waitForFunction(() => document.getElementById('storedNote').textContent === 'Belum ada data tersimpan');
    assert.equal(await page.locator('#storedStrip .s').count(), 0);
    assert.equal(await page.evaluate(() => Boolean(Chart.getChart(document.getElementById('chStored')))), false);
    await upload(page, [{ name: 'new-account.csv', rows: [aff('2')] }]);
    await page.locator('[data-tab="iklan"]').click();
    assert.equal(await page.locator('#kpis').isVisible(), true);
    assert.equal(await page.evaluate(() => RESULT.kpi.comm), 200);
  });

  test('print mode prepares the report and restores the active tab and card state', async page => {
    await upload(page, [{ name: 'affiliate.csv', rows: [aff()] }, { name: 'ads.csv', rows: [ad()] }]);
    await page.locator('[data-tab="harian"]').click();
    const before = await page.evaluate(() => ({
      panels: [...document.querySelectorAll('.panel')].map(panel => panel.classList.contains('active')),
      cards: [...document.querySelectorAll('.kpi.expandable')].map(card => card.classList.contains('open')),
    }));
    await page.evaluate(() => {
      window.print = () => {
        window.__printState = {
          printing: document.body.classList.contains('printing'),
          mode: document.body.classList.contains('pr-ringkas'),
          panels: [...document.querySelectorAll('.panel')].every(panel => panel.classList.contains('active')),
        };
        window.dispatchEvent(new Event('afterprint'));
      };
    });
    await page.locator('#btnPdf').click();
    await page.locator('#btnBrowserPrint').click();
    await page.waitForFunction(() => window.__printState);
    assert.deepEqual(await page.evaluate(() => window.__printState), { printing: true, mode: true, panels: true });
    assert.deepEqual(await page.evaluate(() => ({
      panels: [...document.querySelectorAll('.panel')].map(panel => panel.classList.contains('active')),
      cards: [...document.querySelectorAll('.kpi.expandable')].map(card => card.classList.contains('open')),
    })), before);
    assert.equal(await page.locator('#pdfBusy').isVisible(), false);
    assert.equal(await page.evaluate(() => document.body.classList.contains('printing')), false);
  });

  test('CSV export neutralizes formulas supplied through report fields', async page => {
    const formula = '=HYPERLINK("https://example.invalid","click")';
    await upload(page, [{ name: 'affiliate.csv', rows: [aff('1', formula)] }]);
    const pending = page.waitForEvent('download');
    await page.locator('#btnExport').click();
    await page.locator('#btnDownloadData').click();
    const text = await readDownload(await pending);
    const rows = await page.evaluate(text => Papa.parse(text).data, text);
    assert.equal(rows[1][rows[0].indexOf('Tag')], "'" + formula);
  });

  for (const entry of ['index.html', 'index-daily.html']) {
    test(`${entry} loads and analyzes reports with external resources blocked`, async page => {
      await page.goto(harness.url + '/' + entry, { waitUntil: 'load' });
      await page.waitForFunction(() => window.Engine && window.Papa && window.Chart && window.__dailyStore);
      await upload(page, [{ name: 'affiliate.csv', rows: [aff()] }, { name: 'ads.csv', rows: [ad()] }]);
      assert.equal(await page.locator('#main').isVisible(), true);
      assert.equal(await page.evaluate(() => RESULT.kpi.comm), 200);
      await page.locator('[data-tab="harian"]').click();
      await page.waitForFunction(() => Boolean(Chart.getChart(document.getElementById('chDaily'))));
      assert.equal(await page.locator('#chDaily').isVisible(), true);
    });
  }

  test('daily charts keep clicks and orders on separate axes and tabs announce their state', async page => {
    await upload(page, [{ name: 'affiliate.csv', rows: [aff('1'), aff('2', 'Alpha', '2026-08-02')] },
      { name: 'ads.csv', rows: [ad('Alpha', 100), ad('Alpha', 100, '2026-08-02')] },
      { name: 'clicks.csv', rows: [click(), click('Alpha', '2026-08-02')] }]);
    await page.locator('[data-tab="harian"]').click();
    await page.waitForFunction(() => Boolean(Chart.getChart(document.getElementById('chClicks'))));
    const axes = await page.evaluate(() => {
      const chart = Chart.getChart(document.getElementById('chClicks'));
      return { ids: chart.data.datasets.map(ds => ds.yAxisID || 'y'), left: chart.scales.y.max, right: chart.scales.y1.position,
        xGridHidden: chart.options.scales.x.grid.display === false,
        roasRefs: Chart.getChart(document.getElementById('chRoas')).data.datasets.filter(ds => ds.isReference).map(ds => ds.data[0]) };
    });
    assert.deepEqual(axes.ids, ['y', 'y', 'y1'], 'orders get their own axis; clicks stay on the left');
    assert.ok(axes.left >= 10, 'left axis is scaled to click counts, not left empty');
    assert.equal(axes.right, 'right');
    assert.equal(axes.xGridHidden, true, 'a per-chart y override must not wipe the shared x styling');
    assert.deepEqual(axes.roasRefs, [1, 2], 'ROAS bars show break-even and the scale threshold');
    assert.equal(await page.locator('#tab-harian').getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('#tab-iklan').getAttribute('aria-selected'), 'false');
    await page.locator('#tab-harian').focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator('#tab-produk').getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('#panel-produk').isVisible(), true);
  });

  test('Harian charts and calendar follow the click date, shade unripe days and name what they leave out', async page => {
    await page.evaluate(() => { document.getElementById('ppn').value = '0'; });
    const clickedOn = (row, day) => ({ ...row, 'Waktu Klik': day + ' 09:00:00' });
    // Order 2 lands on 08-02 from a click on 08-01; order 3 was clicked before the period starts.
    await upload(page, [{ name: 'affiliate.csv', rows: [aff('1', 'Alpha', '2026-08-01'), clickedOn(aff('2', 'Alpha', '2026-08-02'), '2026-08-01'),
      clickedOn(aff('3', 'Alpha', '2026-08-01'), '2026-07-30')] },
      { name: 'ads.csv', rows: [ad('Alpha', 100, '2026-08-01'), ad('Alpha', 100, '2026-08-02'), ad('Alpha', 100, '2026-08-03')] }]);
    await page.locator('[data-tab="harian"]').click();
    await page.waitForFunction(() => Boolean(Chart.getChart(document.getElementById('chRoas'))));
    const ui = await page.evaluate(() => {
      const daily = Chart.getChart(document.getElementById('chDaily')), roas = Chart.getChart(document.getElementById('chRoas'));
      const day3 = [...document.querySelectorAll('#calendar .cday')].find(cell => cell.querySelector('b') && cell.querySelector('b').textContent === '3');
      return { daily: daily.data.datasets[0].data, roas: roas.data.datasets[0].data, roasLabel: roas.data.datasets[0].label,
        expectDaily: RESULT.daily.map(d => d.commEffByClick), expectRoas: RESULT.daily.map(d => d.spend > 0 ? d.roasEffByClick : null),
        plugins: [daily, roas].map(chart => chart.config.plugins.map(plugin => plugin.id)),
        mature: document.getElementById('matureNote').textContent, roasNote: document.getElementById('roasNote').textContent,
        basis: document.getElementById('dailyBasis').textContent, cal: document.getElementById('calNote').textContent,
        day3: day3 ? day3.textContent.replace(/\s+/g, '') : '', day3Title: day3 ? day3.title : '',
        tableComm: [...document.querySelectorAll('#tblDaily tbody tr.dayrow')].map(tr => tr.querySelectorAll('td')[3].textContent),
        stored: document.getElementById('panel-tersimpan').textContent };
    });
    assert.deepEqual(ui.daily, ui.expectDaily);
    // Orders 1 and 2 were both clicked on 08-01; 08-03 comes after the commission report ends.
    assert.deepEqual(ui.daily, [400, 0, null], 'click-date commission; an unknown day is null, not zero');
    assert.deepEqual(ui.roas, ui.expectRoas);
    assert.equal(ui.roasLabel, 'ROAS efektif (tgl klik)');
    for (const ids of ui.plugins) for (const id of ['recentBand', 'singleReference']) assert.ok(ids.includes(id), id);
    assert.match(ui.mature, /^Komisi efektif menurut tanggal klik · area hijau = laba, merah = rugi · latar berwarna = belum matang$/);
    assert.match(ui.roasNote, /Komisi efektif tgl klik ÷ biaya hari itu · iklan \+ organik/);
    assert.match(ui.basis, /Rp200 komisi dari klik sebelum 2026-08-01 tidak masuk grafik\./);
    assert.match(ui.basis, /Laporan komisi berakhir 2026-08-02; komisi klik sesudahnya belum diketahui\./);
    assert.match(ui.cal, /tanggal klik/);
    assert.match(ui.day3, /^3Laba—Komisi—Biaya100ROAS—$/, 'unknown days print a dash, never Rp0');
    assert.match(ui.day3Title, /order \(tgl pesanan\)/);
    assert.deepEqual(ui.tableComm, ['Rp0', 'Rp200', 'Rp400'], 'the table stays on the order date');
    assert.match(ui.stored, /ROAS per Hari \(tanggal pesanan\)/);
    assert.match(ui.stored, /Grafik di tab Harian memakai tanggal klik/);
  });

  test('without Waktu Klik the Harian charts say they use the order date', async page => {
    const noClick = row => { const copy = { ...row }; delete copy['Waktu Klik']; return copy; };
    await upload(page, [{ name: 'affiliate.csv', rows: [noClick(aff('1')), noClick(aff('2', 'Alpha', '2026-08-02'))] },
      { name: 'ads.csv', rows: [ad('Alpha', 100), ad('Alpha', 100, '2026-08-02')] }]);
    await page.locator('[data-tab="harian"]').click();
    await page.waitForFunction(() => Boolean(Chart.getChart(document.getElementById('chDaily'))));
    const ui = await page.evaluate(() => ({ available: RESULT.byClick.available,
      daily: Chart.getChart(document.getElementById('chDaily')).data.datasets[0].data, expect: RESULT.daily.map(d => d.commEff),
      roasLabel: Chart.getChart(document.getElementById('chRoas')).data.datasets[0].label,
      mature: document.getElementById('matureNote').textContent, roasNote: document.getElementById('roasNote').textContent,
      basis: document.getElementById('dailyBasis').textContent, cal: document.getElementById('calNote').textContent }));
    assert.equal(ui.available, false);
    assert.deepEqual(ui.daily, ui.expect, 'order-date effective commission, never a row of click-date zeros');
    assert.equal(ui.roasLabel, 'ROAS efektif');
    assert.match(ui.mature, /^Komisi efektif menurut tanggal pesanan/);
    assert.match(ui.roasNote, /tgl pesanan/);
    assert.match(ui.basis, /tanpa kolom Waktu Klik: komisi dicatat pada tanggal pesanan/);
    assert.match(ui.cal, /tanggal pesanan/);
  });

  test('Harian shades unripe days from the click-date boundary when it differs from the order-date one', async page => {
    // The band's start index lives in a closure, so record what renderCharts passes in.
    await page.evaluate(() => {
      const original = ChartTheme.recentBand;
      window.__bands = [];
      ChartTheme.recentBand = (...args) => { const plugin = original(...args); window.__bands.push({ from: args[0], plugin }); return plugin; };
    });
    const days = Array.from({ length: 10 }, (_, i) => '2026-08-' + String(i + 1).padStart(2, '0'));
    const late = (id, clicked, placed) => ({ ...aff(id, 'Alpha', placed), 'Status Pesanan': 'Tertunda', 'Waktu Klik': clicked + ' 09:00:00' });
    // With the default 3-day lag the order date is ripe through 08-07. Orders 6 and 7 were clicked on
    // 08-06 and 08-07, placed days later and are still Tertunda, so by click date those days are unripe too.
    await upload(page, [{ name: 'affiliate.csv', rows: [...days.slice(0, 5).map((day, i) => aff(String(i + 1), 'Alpha', day)),
      late('6', '2026-08-06', '2026-08-09'), late('7', '2026-08-07', '2026-08-10')] },
      { name: 'ads.csv', rows: days.map(day => ad('Alpha', 100, day)) }]);
    await page.locator('[data-tab="harian"]').click();
    await page.waitForFunction(() => Boolean(Chart.getChart(document.getElementById('chRoas'))));
    const ui = await page.evaluate(() => {
      const daily = Chart.getChart(document.getElementById('chDaily')), roas = Chart.getChart(document.getElementById('chRoas'));
      const shade = (colors, base) => colors.map(c => c === base ? 'ripe' : c === base + '55' ? 'raw' : c);
      const last = window.__bands[window.__bands.length - 1];
      return { clickUntil: RESULT.byClick.matureUntil, orderUntil: RESULT.range.matureUntil, dates: RESULT.daily.map(d => d.date),
        raw: [...document.querySelectorAll('#calendar .cday.raw b')].map(b => b.textContent),
        points: daily.data.datasets.flatMap(ds => [shade(ds.pointBackgroundColor, ds.borderColor), shade(ds.pointBorderColor, ds.borderColor)]),
        froms: [...new Set(window.__bands.map(band => band.from))],
        plugged: [daily, roas].map(chart => chart.config.plugins.includes(last.plugin)) };
    });
    assert.equal(ui.orderUntil, '2026-08-07');
    assert.equal(ui.clickUntil, '2026-08-05', 'fixture: the click-date boundary sits before the order-date one');
    const rawByClick = ui.dates.map(date => date > ui.clickUntil);
    assert.deepEqual(ui.raw, ['6', '7', '8', '9', '10'], 'calendar marks the click-date unripe days, not only the last lag days');
    for (const colors of ui.points) assert.deepEqual(colors, rawByClick.map(raw => raw ? 'raw' : 'ripe'), 'chDaily points fade from the click-date boundary');
    assert.deepEqual(ui.froms, [5], 'every render starts the band at the first click-date unripe day');
    assert.equal(ui.dates[ui.froms[0] - 1], ui.clickUntil);
    assert.deepEqual(ui.plugged, [true, true], 'both Harian charts draw that band');
  });

  test('without Waktu Klik the Harian chart and calendar weigh Tertunda commission by the pending factor', async page => {
    await page.evaluate(() => { document.getElementById('ppn').value = '0'; });
    const noClick = row => { const copy = { ...row }; delete copy['Waktu Klik']; return copy; };
    const order = (id, date, comm, status) => noClick({ ...aff(id, 'Alpha', date), 'Total Komisi per Pesanan(Rp)': String(comm), 'Status Pesanan': status });
    // 08-01: Rp200 Selesai + Rp400 Tertunda × 0,95 = Rp580 effective (Rp600 total); 08-02: Rp100 Tertunda = Rp95.
    await upload(page, [{ name: 'affiliate.csv', rows: [order('1', '2026-08-01', 200, 'Selesai'), order('2', '2026-08-01', 400, 'Tertunda'),
      order('3', '2026-08-02', 100, 'Tertunda')] }, { name: 'ads.csv', rows: [ad('Alpha', 100), ad('Alpha', 100, '2026-08-02')] }]);
    await page.locator('[data-tab="harian"]').click();
    await page.waitForFunction(() => Boolean(Chart.getChart(document.getElementById('chDaily'))));
    const ui = await page.evaluate(() => {
      const komisi = day => {
        const cell = [...document.querySelectorAll('#calendar .cday')].find(c => c.querySelector('b') && c.querySelector('b').textContent === day);
        const line = [...cell.querySelectorAll('u > span')].find(span => span.querySelector('em').textContent === 'Komisi');
        return line.textContent.replace('Komisi', '');
      };
      return { available: RESULT.byClick.available, total: RESULT.daily.map(d => d.comm), expect: RESULT.daily.map(d => d.commEff),
        daily: Chart.getChart(document.getElementById('chDaily')).data.datasets[0].data, cal: ['1', '2'].map(komisi) };
    });
    assert.equal(ui.available, false);
    assert.deepEqual(ui.total, [600, 100], 'fixture: total commission differs from effective');
    assert.deepEqual(ui.daily, ui.expect, 'the chart plots RESULT.daily commEff');
    assert.ok(Math.abs(ui.daily[0] - 580) < 1e-9 && Math.abs(ui.daily[1] - 95) < 1e-9, `Selesai + 0,95 × Tertunda, got ${ui.daily}`);
    assert.deepEqual(ui.cal, ['580', '95'], 'calendar Komisi is effective, not total');
  });

  test('a commission day without spend has no ROAS bar and its calendar ROAS prints a dash', async page => {
    await page.evaluate(() => { document.getElementById('ppn').value = '0'; });
    // 08-02 has a click-date order but no ad row: ROAS is undefined there, not 0x and not comm ÷ 1.
    await upload(page, [{ name: 'affiliate.csv', rows: [aff('1'), aff('2', 'Alpha', '2026-08-02')] },
      { name: 'ads.csv', rows: [ad('Alpha', 100)] }]);
    await page.locator('[data-tab="harian"]').click();
    await page.waitForFunction(() => Boolean(Chart.getChart(document.getElementById('chRoas'))));
    const ui = await page.evaluate(() => {
      const day2 = [...document.querySelectorAll('#calendar .cday')].find(c => c.querySelector('b') && c.querySelector('b').textContent === '2');
      return { days: RESULT.daily.map(d => [d.date, d.spend, d.commEffByClick]),
        roas: Chart.getChart(document.getElementById('chRoas')).data.datasets[0].data, day2: day2.textContent.replace(/\s+/g, '') };
    });
    assert.deepEqual(ui.days, [['2026-08-01', 100, 200], ['2026-08-02', 0, 200]], 'fixture: commission on a zero-spend day');
    assert.deepEqual(ui.roas, [2, null], 'no bar for the zero-spend day');
    assert.match(ui.day2, /ROAS—$/, 'calendar ROAS for the zero-spend day is a dash');
    assert.match(ui.day2, /Komisi200/, 'the day still shows its commission');
  });

  test('concentration shows spend share against commission share and warns on a top-3 dependency', async page => {
    await page.evaluate(() => { document.getElementById('ppn').value = '0'; });
    const spends = [['Alpha', 300], ['Bravo', 250], ['Charlie', 200], ['Delta', 50], ['Echo', 50], ['Foxtrot', 50]];
    await upload(page, [{ name: 'affiliate.csv', rows: spends.map(([tag], i) => aff(String(i + 1), tag)) },
      { name: 'ads.csv', rows: spends.map(([tag, spend]) => ad(tag, spend)).concat([ad('Zulu Kilo', 40)]) }]);
    const card = await page.evaluate(() => ({ text: document.getElementById('concentration').textContent.replace(/\s+/g, ' '),
      risk: !!document.querySelector('#concentration .riskbox'), rows: document.querySelectorAll('#concentration tbody tr').length,
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth }));
    assert.match(card.text, /1 tag teratas \(Alpha\)/);
    assert.match(card.text, /2 tag di luar 5 teratas/);
    assert.match(card.text, /5 tag dengan biaya terbesar memakan 90,4% biaya iklan dan menghasilkan 83,3% komisi efektif iklan; 2 tag lainnya memakan 9,6% biaya dengan ROAS 2,22x\./);
    assert.equal(card.rows, 4, 'top 1, 3 and 5 plus the remainder');
    assert.equal(card.risk, true, 'top 3 hold 79,8% of spend across 7 paid tags');
    assert.match(card.text, /3 tag menyerap 79,8% biaya iklan/);
    assert.match(card.text, /1 nama iklan berbiaya \(4,3% biaya\) tidak ada di laporan komisi/);
    assert.equal(card.overflow, false);
  });

  test('four evenly spread paid tags are not flagged as a concentration risk', async page => {
    // The top 3 hold 75% here, but with four tags that is arithmetic, not a dependency.
    const even = ['Alpha', 'Bravo', 'Charlie', 'Delta'];
    await upload(page, [{ name: 'affiliate.csv', rows: even.map((tag, i) => aff('e' + i, tag)) },
      { name: 'ads.csv', rows: even.map(tag => ad(tag, 100)) }]);
    assert.match(await page.locator('#concentration').textContent(), /1 tag teratas \(\w+\)[\s\S]*1 tag di luar 3 teratas/);
    assert.equal(await page.locator('#concentration .riskbox').count(), 0);
  });

  test('horizontal bars answer for the row under the pointer and count axes step in whole numbers', async page => {
    const cat = (id, name, comm) => ({ ...aff(id), 'L1 Kategori Global': name, 'Total Komisi per Pesanan(Rp)': String(comm) });
    await upload(page, [{ name: 'affiliate.csv', rows: [cat('1', 'Elektronik', 100000), cat('2', 'Fashion', 60000),
      cat('3', 'Rumah', 20000), cat('4', 'Lainnya', 9000)] }, { name: 'ads.csv', rows: [ad()] }, { name: 'clicks.csv', rows: [click()] }]);
    await page.locator('[data-tab="produk"]').click();
    await page.waitForFunction(() => Boolean(Chart.getChart(document.getElementById('chCat'))));
    // Point at the shortest bar's row, level with the end of the longest bar:
    // index mode along x picked the bar whose end lies nearest, not the row.
    await page.locator('#chCat').scrollIntoViewIfNeeded();
    const target = await page.evaluate(() => {
      const chart = Chart.getChart(document.getElementById('chCat')), box = chart.canvas.getBoundingClientRect();
      const bars = chart.getDatasetMeta(0).data, last = bars.length - 1;
      return { x: box.left + bars[0].x - 2, y: box.top + bars[last].y, label: chart.data.labels[last] };
    });
    await page.mouse.move(target.x, target.y);
    await page.waitForFunction(() => Chart.getChart(document.getElementById('chCat')).tooltip.dataPoints?.length);
    assert.equal(await page.evaluate(() => Chart.getChart(document.getElementById('chCat')).tooltip.dataPoints[0].label), target.label);
    await page.locator('[data-tab="harian"]').click();
    await page.waitForFunction(() => Boolean(Chart.getChart(document.getElementById('chClicks'))));
    const ticks = await page.evaluate(() => {
      const chart = Chart.getChart(document.getElementById('chClicks'));
      return { orders: chart.scales.y1.ticks.map(tick => tick.value),
        singleDayRef: Chart.getChart(document.getElementById('chRoas')).config.plugins.some(plugin => plugin.id === 'singleReference') };
    });
    assert.ok(ticks.orders.every(Number.isInteger), 'order ticks: ' + ticks.orders.join(', '));
    assert.equal(ticks.singleDayRef, true, 'a one-day ROAS chart still draws its reference lines');
  });

  test('results stay in place while another report is read, and the decade warning keeps its card', async page => {
    await upload(page, [{ name: 'affiliate.csv', rows: [aff()] }, { name: 'ads.csv', rows: [ad()] }, { name: 'clicks.csv', rows: [click()] }]);
    assert.equal(await page.locator('#gapCard').getAttribute('class').then(c => /gap-clean/.test(c)), true);
    await page.evaluate(() => {
      window.__resultStates = [];
      new MutationObserver(() => window.__resultStates.push(document.body.classList.contains('has-result')))
        .observe(document.body, { attributes: true, attributeFilter: ['class'] });
    });
    await upload(page, [{ name: 'old.csv', rows: [aff('9', 'Alpha', '2014-01-05')] }]);
    assert.equal(await page.evaluate(() => window.__resultStates.includes(false)), false, 'the guide must not flash back');
    assert.match(await page.locator('#gapBody').innerText(), /melebihi 10 tahun/);
    assert.equal(await page.locator('#gapCard').getAttribute('class').then(c => /gap-clean/.test(c)), false);
    assert.equal(await page.locator('#gapCard .card-head').isVisible(), true);
  });

  test('a fractional ROAS Scale reads with a comma and redraws the stored chart', async page => {
    await upload(page, [{ name: 'affiliate.csv', rows: [aff(), aff('2', 'Alpha', '2026-08-02')] },
      { name: 'ads.csv', rows: [ad(), ad('Alpha', 100, '2026-08-02')] }]);
    await saveDaily(page);
    await page.locator('[data-tab="tersimpan"]').click();
    await page.waitForFunction(() => Boolean(Chart.getChart(document.getElementById('chStoredRoas'))));
    const target = () => page.evaluate(() => Chart.getChart(document.getElementById('chStoredRoas'))
      .data.datasets.filter(ds => ds.isReference).map(ds => ds.data[0]));
    assert.deepEqual(await target(), [1, 2]);
    await page.evaluate(() => { const input = document.getElementById('thScale'); input.value = '3'; input.dispatchEvent(new Event('change')); });
    await page.waitForFunction(() => Chart.getChart(document.getElementById('chStoredRoas')).data.datasets.some(ds => ds.isReference && ds.data[0] === 3));
    await page.evaluate(() => document.querySelector('[data-preset="konservatif"]').click());
    await page.waitForFunction(() => Chart.getChart(document.getElementById('chStoredRoas')).data.datasets.some(ds => ds.isReference && ds.data[0] === 2.5));
    await page.locator('[data-tab="iklan"]').click();
    assert.match(await page.locator('#dgrid .dcard.scale').innerText(), /mencapai 2,5x/);
  });

  test('link warnings sit beside the real STOP reason and the action cards do not count one rupiah twice', async page => {
    const days = Array.from({ length: 8 }, (_, i) => '2026-08-0' + (i + 1));
    const order = (tag, date, comm) => ({ ...aff(tag + date, tag, date), 'Total Komisi per Pesanan(Rp)': String(comm) });
    const spend = (tag, date, clicks) => ({ ...ad(tag, 20000, date), 'Link clicks': String(clicks), 'Ad delivery': 'active' });
    await upload(page, [
      { name: 'affiliate.csv', rows: days.flatMap(d => [order('Broken', d, 2000), order('LiveLeak', d, 100000)]) },
      // Broken: 1.280 paid clicks, none arrive. LiveLeak: 800 paid clicks, 10% arrive.
      { name: 'ads.csv', rows: days.flatMap(d => [spend('Broken', d, 160), spend('LiveLeak', d, 100)]) },
      // Identical rows are deduplicated on import, so each click gets its own minute.
      { name: 'clicks.csv', rows: days.flatMap(d => Array.from({ length: 10 }, (_, i) => ({ ...click('LiveLeak', d), 'Waktu Klik': d + ' 09:0' + i + ':00' }))) }]);
    const ui = await page.evaluate(() => ({
      statuses: RESULT.tags.map(t => t.tag + ':' + t.status).sort(),
      arrived: RESULT.tags.map(t => t.tag + ':' + t.leak.shopeeClicks + '/' + t.leak.metaClicks).sort(),
      stopLoss: rp(RESULT.actions.stopLoss), linkLive: rp(RESULT.actions.leakWasteLive), linkAll: rp(RESULT.actions.leakWaste),
      grid: [...document.querySelectorAll('#actionGrid .action-card')].map(card => card.innerText.replace(/\s+/g, ' ').trim()),
      banner: document.getElementById('banners').innerText,
      lost: document.querySelector('#clickKpis .kpi.bad .sub') ? document.querySelector('#clickKpis .kpi.bad .sub').innerText : '',
      reason: [...document.querySelectorAll('#tblMain tbody tr')].find(tr => tr.innerText.includes('Broken')).querySelector('.rs').innerText,
      leakHead: document.querySelector('#tblLeak thead').innerText,
    }));
    assert.deepEqual(ui.statuses, ['Broken:stop', 'LiveLeak:scale']);
    assert.deepEqual(ui.arrived, ['Broken:0/1280', 'LiveLeak:80/800']);
    assert.match(ui.reason, /^ROAS .+ · hanya 0% klik sampai Shopee — cek link sebelum dimatikan/, 'the real STOP reason comes first');
    const stopCard = ui.grid.find(text => text.startsWith('Rugi di Tag STOP'));
    assert.ok(stopCard && stopCard.includes(ui.stopLoss) && /1 tag cek link dulu/.test(stopCard), 'STOP card: ' + stopCard);
    const linkCard = ui.grid.find(text => text.startsWith('Hilang karena Link'));
    assert.ok(linkCard && linkCard.includes(ui.linkLive) && /1 tag di luar STOP/.test(linkCard), 'link card: ' + linkCard);
    assert.ok(ui.grid.some(text => text.startsWith('Potensi perbaikan laba')));
    assert.ok(!ui.grid.some(text => /Total bisa dialihkan|Biaya di Tag STOP/.test(text)));
    assert.match(ui.banner, /2 tag: kurang dari 25% klik sampai Shopee\./);
    assert.ok(ui.banner.includes(ui.linkAll), 'the banner quotes the money of the tags it counts');
    assert.match(ui.lost, /^jumlah per tag · bersih [\d.]+ · biaya Rp.+–Rp/);
    assert.match(ui.leakHead, /± Klik/);
  });

  test('Potensi perbaikan laba adds the STOP loss, not the gross STOP spend', async page => {
    const days = Array.from({ length: 8 }, (_, i) => '2026-08-0' + (i + 1));
    const order = (tag, date, comm) => ({ ...aff(tag + date, tag, date), 'Total Komisi per Pesanan(Rp)': String(comm) });
    await upload(page, [
      // Loser: ROAS 0,1 every day, so STOP while still earning some commission.
      // Overbid: ROAS 1,5 is PANTAU and pays above its ideal CPC, so bidSaving > 0.
      { name: 'affiliate.csv', rows: days.flatMap(d => [order('Loser', d, 2000), order('Overbid', d, 30000)]) },
      { name: 'ads.csv', rows: days.flatMap(d => [ad('Loser', 20000, d), ad('Overbid', 20000, d)]) }]);
    const ui = await page.evaluate(() => ({
      statuses: RESULT.tags.map(t => t.tag + ':' + t.status).sort(),
      bidSaving: RESULT.actions.bidSaving,
      maxGain: rp(RESULT.actions.maxGain), reclaimable: rp(RESULT.actions.reclaimable),
      card: [...document.querySelectorAll('#actionGrid .action-card')]
        .filter(card => card.querySelector('.a-label').textContent === 'Potensi perbaikan laba')
        .map(card => card.querySelector('.a-val').textContent),
    }));
    assert.deepEqual(ui.statuses, ['Loser:stop', 'Overbid:pantau']);
    assert.ok(ui.bidSaving > 0, 'fixture: an overbid tag feeds the bid half of the sum');
    assert.notEqual(ui.maxGain, ui.reclaimable, 'fixture: STOP tags still earn, so loss and spend differ');
    assert.deepEqual(ui.card, [ui.maxGain], 'the card quotes actions.maxGain, not the legacy reclaimable budget');
  });

  // One click-report day. Broken (300 paid clicks, exactly the floor) and Cheap
  // (400) are judged; Tiny (299) and Extra (100, a surplus) are not. Only Broken
  // is a broken link, but Cheap and Tiny lose clicks too and Extra's surplus
  // makes the net loss smaller than the per-tag sum.
  const leakFixture = () => {
    const date = '2026-08-01';
    const tags = [['Broken', 300, 30, 30000], ['Cheap', 400, 200, 40000], ['Tiny', 299, 15, 29900], ['Extra', 100, 250, 10000]];
    // Identical rows are deduplicated on import, so each click gets its own second.
    const at = i => `${date} 09:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`;
    return [
      { name: 'affiliate.csv', rows: tags.map(([tag]) => aff(tag, tag, date)) },
      { name: 'ads.csv', rows: tags.map(([tag, meta, , spend]) => ({ ...ad(tag, spend, date), 'Link clicks': String(meta) })) },
      { name: 'clicks.csv', rows: tags.flatMap(([tag, , shopee]) =>
        Array.from({ length: shopee }, (_, i) => ({ ...click(tag, date), 'Waktu Klik': at(i) }))) }];
  };

  test('the leak banner quotes only the broken links it counts and Klik Hilang names the net loss', async page => {
    await upload(page, leakFixture());
    const ui = await page.evaluate(() => {
      const k = RESULT.kpi;
      const card = [...document.querySelectorAll('#clickKpis .kpi')].find(el => el.querySelector('.lbl').textContent.startsWith('Klik Hilang'));
      return {
        leaks: RESULT.tags.map(t => `${t.tag}:${t.leak.shopeeClicks}/${t.leak.metaClicks}:${t.leak.severity}:${t.leak.reliable}`).sort(),
        leakTags: k.leakTags, lostClicks: k.lostClicks, netLostClicks: k.netLostClicks,
        leakWaste: rp(RESULT.actions.leakWaste), wasted: rp(k.wasted), wastedLow: rp(k.wastedLow),
        banner: document.getElementById('banners').textContent,
        hilang: card && { val: card.querySelector('.val').textContent, sub: card.querySelector('.sub').textContent },
      };
    });
    assert.deepEqual(ui.leaks, ['Broken:30/300:bad:true', 'Cheap:200/400:warn:true',
      'Extra:250/100:over:false', 'Tiny:15/299:bad:false']);
    assert.equal(ui.leakTags, 1);
    assert.equal(new Set([ui.leakWaste, ui.wastedLow, ui.wasted]).size, 3, 'fixture: the three money figures differ on screen');
    assert.match(ui.banner, /1 tag: kurang dari 25% klik sampai Shopee\./);
    assert.ok(ui.banner.includes(`maks. ${ui.leakWaste} — periksa link`), 'banner quotes actions.leakWaste: ' + ui.banner);
    assert.ok(!ui.banner.includes(ui.wasted), 'banner must not quote kpi.wasted, which includes warn and unjudged tags');
    // Per-tag sum 270 + 200 + 284 = 754; net 1.099 paid − 495 arrived = 604.
    assert.deepEqual([ui.lostClicks, ui.netLostClicks], [754, 604]);
    assert.deepEqual(ui.hilang, { val: '754', sub: `jumlah per tag · bersih 604 · biaya ${ui.wastedLow}–${ui.wasted}` });
  });

  test('the leak table leaves tags under 300 paid clicks unjudged and marks a judged broken link', async page => {
    await upload(page, leakFixture());
    // The Klik tab is hidden, so read textContent and class names, not innerText.
    const rows = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#tblLeak tbody tr')].map(tr => {
      const cells = tr.querySelectorAll('td');
      return [cells[0].querySelector('b').textContent, { pct: [...cells[4].classList], marked: tr.querySelectorAll('[class*="leak-"]').length,
        note: cells[9].textContent }];
    })));
    // Tiny is under 25% like Broken; only the sample size keeps it unjudged.
    assert.deepEqual(rows.Tiny, { pct: ['num'], marked: 0, note: 'Belum bisa dinilai: 299 klik iklan (perlu ±300)' });
    assert.deepEqual(rows.Extra, { pct: ['num'], marked: 0, note: 'Belum bisa dinilai: 100 klik iklan (perlu ±300)' });
    assert.deepEqual(rows.Broken, { pct: ['num', 'leak-bad'], marked: 1, note: 'Kurang dari 25% klik sampai — periksa link' });
    assert.deepEqual(rows.Cheap.pct, ['num', 'leak-warn']);
  });

  test('unjudged paid tags get their own net on the board, near-threshold verdicts say so, and reach is gone', async page => {
    await page.evaluate(() => { document.getElementById('ppn').value = '0'; });
    const days = Array.from({ length: 10 }, (_, i) => '2026-08-' + String(i + 1).padStart(2, '0'));
    const order = (tag, date, comm) => ({ ...aff(tag + date, tag, date), 'Total Komisi per Pesanan(Rp)': String(comm) });
    await upload(page, [
      // Scale205: ROAS 2,05 on 7 mature days, inside 10% of the Scale threshold.
      { name: 'affiliate.csv', rows: [...days.map(d => order('Scale205', d, 41000)), order('SmallPaid', '2026-08-01', 4000)] },
      { name: 'ads.csv', rows: [...days.map(d => ad('Scale205', 20000, d)), ad('SmallPaid', 7500, '2026-08-01'),
        ad('SmallPaid', 7500, '2026-08-02'), ad('NoSuchTag', 9000, '2026-08-02'),
        ...days.map(d => ({ ...ad('IdleAd', 0, d), 'Link clicks': '0', 'Impressions': '0', 'Reach': '0', 'Landing page views': '0' }))] },
      { name: 'clicks.csv', rows: Array.from({ length: 5 }, (_, i) => ({ ...click('ClickOnly', '2026-08-03'), 'Waktu Klik': '2026-08-03 09:0' + i + ':00' })) }]);
    const read = () => page.evaluate(() => ({
      card: document.querySelector('#dgrid .dcard.evaluasi').innerText.replace(/\s+/g, ' '),
      synth: document.getElementById('synth').innerText,
      rows: document.querySelectorAll('#tblMain tbody tr.dayrow').length,
      note: document.getElementById('filterNote').textContent,
      edge: [...document.querySelectorAll('#tblMain .pill.edge')].map(e => ({ text: e.textContent, title: e.title })),
      counts: RESULT.kpi.counts.evaluasi,
    }));
    const before = await read();
    assert.equal(before.counts, 4, 'idle ad names and click-only sub_ids stay evaluasi');
    assert.match(before.card, /Belum cukup data \(2\)/i);
    assert.match(before.card, /Laba bersih -Rp20rb dari biaya Rp24rb/);
    assert.match(before.synth, /2 tag berbiaya belum cukup data untuk divonis; gabungannya rugi Rp20rb dari biaya Rp24rb\./);
    assert.deepEqual(before.edge.map(e => e.text), ['di batas']);
    assert.ok(before.edge[0].title.includes('ROAS matang 2,05x') && before.edge[0].title.includes('ambang Scale 2,00x'), before.edge[0].title);
    await page.locator('#dgrid [data-filter="evaluasi"]').click();
    const filtered = await read();
    assert.equal(filtered.rows, 2, 'the filtered table holds the same tags the card counts');
    assert.equal(filtered.note, 'Disaring: belum cukup data (berbiaya) · 2 tag');
    await page.locator('[data-tab="harian"]').click();
    assert.doesNotMatch(await page.locator('#dailyStrip').innerText(), /reach/i, 'daily reach summed over days is not unique people');
  });

  test('PPN from Setelan re-analyses, persists per account and re-renders stored history', async page => {
    await upload(page, [{ name: 'affiliate.csv', rows: [aff('1')] }, { name: 'ads.csv', rows: [ad('Alpha', 100)] }]);
    await saveDaily(page);
    assert.equal(await page.locator('[data-ppn-switch], .ppn-alt, .ppn-unconfirmed').count(), 0, 'PPN is a Setelan value, not a switch on the cards');
    assert.equal(await page.locator('#kpis .kpi:nth-child(2) .sub').textContent(), 'tanpa PPN');
    await setPpn(page, '11');
    const after = await page.evaluate(() => ({ ppn: RESULT.options.ppn, spend: RESULT.kpi.spend, base: RESULT.kpi.spendBase,
      saved: JSON.parse(localStorage.getItem('adash_opts_v3_default')).ppn,
      sub: document.querySelector('#kpis .kpi:nth-child(2) .sub').textContent,
      drill: document.querySelector('#kpis .kpi:nth-child(2) .kdrill').textContent }));
    assert.equal(after.ppn, 11);
    assert.ok(Math.abs(after.spend - 111) < 1e-9, 'spend ' + after.spend);
    assert.equal(after.base, 100);
    assert.equal(after.saved, '11', 'saved per account through the existing change event');
    assert.equal(after.sub, 'termasuk PPN 11%');
    assert.match(after.drill, /Meta \(sebelum PPN\) \+ PPN 11%Rp100 \+ Rp11/);
    await page.evaluate(() => { window.print = () => window.dispatchEvent(new Event('afterprint')); });
    await page.evaluate(() => runPrint('ringkas'));
    assert.match(await page.locator('#phRange').textContent(), /· PPN biaya iklan 11%$/);
    page.once('dialog', dialog => dialog.accept('Akun PPN'));
    await page.locator('#btnNewAcct').click();
    assert.equal(await page.inputValue('#ppn'), '0', 'a new account starts without PPN');
    await page.selectOption('#account', 'default');
    assert.equal(await page.inputValue('#ppn'), '11');
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => window.__dailyStore);
    await page.locator('#btnStored').click();
    await page.waitForFunction(() => document.querySelector('#tblStored tbody tr td:nth-child(3)')?.textContent === 'Rp111');
    await setPpn(page, '0');
    await page.waitForFunction(() => document.querySelector('#tblStored tbody tr td:nth-child(3)').textContent === 'Rp100');
    assert.match(await page.locator('#storedStrip').textContent(), /Biaya \(PPN 0%\)Rp100/);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('adash_opts_v3_default')).ppn), '0');
    assert.equal(await page.evaluate(() => RESULT), null);
  });

  test('Laba Bersih, commission names both totals, and Harian matches the cards', async page => {
    await page.evaluate(() => { document.getElementById('ppn').value = '0'; });
    const order = (id, comm, status = 'Selesai') => ({ ...aff(id), 'Total Komisi per Pesanan(Rp)': String(comm), 'Status Pesanan': status });
    await upload(page, [{ name: 'affiliate.csv', rows: [order('1', 70000), order('2', 36000, 'Tertunda'), order('3', 40000)] },
      { name: 'ads.csv', rows: [ad('Alpha', 140000)] }]);
    const read = () => page.evaluate(() => {
      const card = n => document.querySelector(`#kpis .kpi:nth-child(${n})`);
      const row = [...document.querySelectorAll('#tblDaily tbody tr.dayrow')][0].querySelectorAll('td');
      return { labels: [1, 2, 3, 4].map(n => card(n).querySelector('.lbl').firstChild.textContent),
        vals: [1, 3, 4].map(n => card(n).querySelector('.val').textContent),
        commSub: card(1).querySelector('.sub').textContent, commDrill: card(1).querySelector('.kdrill').textContent,
        net: card(3).querySelector('.sub').textContent,
        netDrill: card(3).querySelector('.kdrill').textContent, synth: document.getElementById('synth').textContent,
        day: [3, 4, 5].map(i => row[i].textContent), dayTitle: row[3].title, dayCpc: row[7].textContent,
        dailyNet: RESULT.daily.reduce((sum, d) => sum + d.netEff, 0), kpiNet: RESULT.kpi.netEff };
    });
    let ui = await read();
    assert.deepEqual(ui.labels, ['Komisi Efektif', 'Spend Iklan', 'Laba Bersih', 'ROAS Gabungan']);
    assert.equal(ui.commSub, 'total Rp146rb · 3 pesanan');
    assert.match(ui.commDrill, /Komisi Total \(Selesai \+ Tertunda\)Rp146rb/);
    assert.match(ui.commDrill, /Produk terjual3/);
    assert.deepEqual(ui.vals, ['Rp144rb', 'Rp4rb', '1,03x']);
    assert.equal(ui.net, 'komisi efektif − biaya (tanpa PPN)');
    assert.doesNotMatch(ui.netDrill + ui.synth, /bila PPN|invoice Meta/, 'no PPN what-if: the invoices carry no PPN');
    assert.deepEqual(ui.day, ['Rp144rb', 'Rp4rb', '1,03'], 'the one-day table matches the cards');
    assert.equal(ui.dayTitle, 'Total Rp146.000');
    assert.equal(ui.dayCpc, 'Rp14.000', 'CPC Meta is money, like CPC Shopee beside it');
    assert.ok(Math.abs(ui.dailyNet - ui.kpiNet) < 1e-6);
    // An account that is billed PPN still gets it from Setelan.
    await setPpn(page, '11');
    ui = await read();
    assert.deepEqual(ui.vals, ['Rp144rb', '-Rp11rb', '0,93x']);
    assert.equal(ui.net, 'komisi efektif − biaya termasuk PPN 11%');
    assert.deepEqual(ui.day, ['Rp144rb', '-Rp11rb', '0,93']);
    // Day breakdown, Semua Tag breakdown and both daily charts use the same effective commission.
    await page.locator('[data-tab="harian"]').click();
    await page.waitForFunction(() => Boolean(Chart.getChart(document.getElementById('chRoas'))));
    await page.locator('#tblDaily tbody tr.dayrow').first().click();
    assert.match(await page.locator('#tblDaily .daydetail tbody tr').first().innerText(), /Rp144rb\s+-Rp11rb\s+0,93\s+10\s+Rp15\.540/);
    const charts = await page.evaluate(() => ({ daily: Chart.getChart(document.getElementById('chDaily')).data.datasets[0],
      roas: Chart.getChart(document.getElementById('chRoas')).data.datasets[0].data }));
    assert.equal(charts.daily.label, 'Komisi Efektif');
    assert.deepEqual(charts.daily.data, [144200]);
    assert.ok(Math.abs(charts.roas[0] - 144200 / 155400) < 1e-9);
    await page.locator('[data-tab="iklan"]').click();
    await page.locator('#tblMain tbody tr.dayrow').first().click();
    assert.match(await page.locator('#tblMain .daydetail').textContent(), /Komisi Efektif[\s\S]+Rp144rb\s*-Rp11rb\s*0,93\s*10\s*Rp15\.540/);
  });

  test('Klik Shopee counts every click but Shopee Video, which gets its own tag', async page => {
    const date = '2026-08-01';
    const at = i => `${date} 09:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`;
    let n = 0;
    const clicks = (tag, count, src) => Array.from({ length: count }, () => ({ ...click(tag, date), 'Waktu Klik': at(n++), Perujuk: src }));
    await upload(page, [
      { name: 'affiliate.csv', rows: [aff('1', 'Alpha', date), { ...aff('2', '', date), Platform: 'Shopeevideo-Shopee' }] },
      { name: 'ads.csv', rows: [{ ...ad('Alpha', 100, date), 'Link clicks': '100' }] },
      { name: 'clicks.csv', rows: [...clicks('Alpha', 60, 'Facebook'), ...clicks('Alpha', 10, 'Instagram'),
        ...clicks('Alpha', 5, 'Others'), ...clicks('Boosted', 7, 'Facebook'), ...clicks('Boosted', 3, 'Websites'),
        ...clicks('', 4, 'Shopeevideo-Shopee')] }]);
    const card = await page.evaluate(() => {
      const el = [...document.querySelectorAll('#clickKpis .kpi')].find(e => e.querySelector('.lbl').textContent.startsWith('Klik Shopee'));
      const pct = [...document.querySelectorAll('#clickKpis .kpi')].find(e => e.querySelector('.lbl').textContent.startsWith('% Klik Masuk'));
      const sv = RESULT.tags.find(t => t.tag === 'Shopee Video');
      return { val: el.querySelector('.val').textContent, sub: el.querySelector('.sub').textContent,
        rows: [...el.querySelectorAll('.krow')].slice(0, 6).map(r => [...r.children].map(c => c.textContent)),
        pct: pct.querySelector('.val').textContent, pctSub: pct.querySelector('.sub').textContent,
        sv: sv && [sv.shopeeClicks, sv.orders], untagged: RESULT.tags.some(t => t.tag === '(tanpa tag)') };
    });
    assert.equal(card.val, '85');
    assert.match(card.sub, /tanpa Shopee Video$/);
    assert.deepEqual(card.rows, [['Semua klik di laporan Shopee', '89'], ['Shopee Video (dipisah)', '−4'],
      ['FB+IG ke tag beriklan', '70'], ['FB+IG ke tag tanpa iklan Meta', '7'],
      ['boost Shopee atau organik: Boosted 7', ''], ['Perujuk lain (Others, Websites, …)', '8']]);
    assert.deepEqual(card.sv, [4, 1], 'untagged Shopee Video clicks and orders land on one named tag');
    assert.equal(card.untagged, false);
    assert.equal(card.pct, '70,0%', '% masuk still compares FB+IG on advertised tags with Meta');
    assert.match(card.pctSub, /^70 ÷ 100 · /);
  });

  test('placement rows under Spend Iklan include PPN and add up to the headline', async page => {
    await page.evaluate(() => { document.getElementById('ppn').value = '0'; });
    await upload(page, [{ name: 'affiliate.csv', rows: [aff()] }, { name: 'ads.csv', rows: [
      { ...ad('Alpha', 100000), Placement: 'Feed', Platform: 'Facebook' },
      { ...ad('Alpha', 40000), Placement: 'Stories', Platform: 'Instagram' }] }]);
    await setPpn(page, '11');
    const card = await page.evaluate(() => ({ val: document.querySelector('#kpis .kpi:nth-child(2) .val').textContent, total: rp(RESULT.kpi.spend),
      rows: [...document.querySelectorAll('#kpis .kpi:nth-child(2) .krow')].map(r => [...r.children].map(c => c.textContent)) }));
    assert.equal(card.val, 'Rp155rb');
    assert.equal(card.total, 'Rp155rb');
    assert.deepEqual(card.rows, [['Meta (sebelum PPN) + PPN 11%', 'Rp140rb + Rp15rb'],
      ['Facebook Feed', 'Rp111rb · 71%'], ['Instagram Stories', 'Rp44rb · 29%']]);
  });

  test('snapshot history names each PPN and the trend warns when they differ', async page => {
    const at11 = E.toSnapshot(E.analyze({ affiliate: [aff()], ads: [ad()], clicks: [], tagMap: {} },
      { ppn: 11, lagDays: 0, dateStart: '2026-08-01', dateEnd: '2026-08-02' }), { id: 2, account: 'default', saved: '2026-08-02 12:00:00' });
    await importSnapshots(page, [snapshot(1), at11]);
    assert.match(await page.locator('#trendBase').innerText(), /PPN berbeda antar snapshot \(0%, 11%\): laba, biaya dan ROAS tidak sebanding\./);
    await page.locator('#btnHist').click();
    const rows = await page.locator('#histRows').innerText();
    assert.match(rows, /PPN 11%/);
    assert.match(rows, /PPN 0%/);
  });

  test('keyboard focus scrolls below the sticky header at every header height', async page => {
    for (const [width, sticky] of [[768, true], [1024, true], [1440, true], [390, false]]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const { header, padding } = await page.evaluate(() => ({ header: document.querySelector('header').offsetHeight,
        padding: parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) }));
      if (sticky) assert.ok(padding >= header, `${width}px: header ${header}px, scroll padding ${padding}px`);
      else assert.ok(padding < header, `${width}px: the header scrolls away, so no full-height padding`);
    }
  });

  for (const width of [320, 390]) {
    test(`dashboard stays within a ${width}px mobile viewport`, async page => {
      await page.setViewportSize({ width, height: 844 });
      await upload(page, [{ name: 'affiliate.csv', rows: [aff('1', 'A very long synthetic product tag for mobile layouts')] },
        { name: 'ads.csv', rows: [ad('A very long synthetic product tag for mobile layouts')] }]);
      for (const tab of ['iklan', 'klik', 'harian', 'produk', 'status', 'tersimpan', 'rincian']) {
        await page.locator(`[data-tab="${tab}"]`).click();
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const dimensions = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth,
          document: document.documentElement.scrollWidth }));
        assert.ok(dimensions.document <= dimensions.viewport + 1, `${tab} overflows by ${dimensions.document - dimensions.viewport}px`);
      }
    });
  }

  let failed = 0;
  try {
    for (const { name, fn } of cases) {
      const context = await harness.browser.newContext({ viewport: { width: 1440, height: 1000 } });
      const externalRequests = [];
      await context.route('**/*', route => {
        if (route.request().url().startsWith(harness.url + '/')) return route.continue();
        externalRequests.push(route.request().url());
        return route.abort();
      });
      const page = await context.newPage(), errors = [];
      page.setDefaultTimeout(10000);
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(() => {
        if (!localStorage.getItem('adash_accounts_v3')) {
          localStorage.setItem('adash_accounts_v3', JSON.stringify(['default', 'Account B']));
          localStorage.setItem('adash_active_v3', 'default');
        }
      });
      try {
        await page.goto(harness.url + '/index.html', { waitUntil: 'load' });
        await page.waitForFunction(() => window.Engine && window.Papa && window.DailyStore && window.__dailyStore);
        await fn(page);
        assert.deepEqual(errors, [], 'uncaught browser errors');
        assert.deepEqual(externalRequests, [], 'dashboard attempted external network requests');
        console.log('PASS ' + name);
      } catch (error) {
        failed++;
        console.error('FAIL ' + name + '\n  ' + error.message);
        if (errors.length) console.error('  Browser errors: ' + errors.join(' | '));
      } finally { await context.close(); }
    }
  } finally { await harness.close(); }
  console.log(`${cases.length - failed}/${cases.length} browser regressions passed`);
  if (failed) process.exitCode = 1;
}

module.exports = { createHarness, csv, aff, ad, click, upload, snapshot, importSnapshots, saveDaily, storedRows, readDownload };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
