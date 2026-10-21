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
    assert.match(plat, /Facebook\tRp80\t80%[\s\S]*2\.50x/);
    assert.match(plat, /Instagram\tRp20\t20%[\s\S]*10\.00x/);
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
  });

  test('the decision table shows LP views, their cost and the share of clicks lost before Shopee', async page => {
    await page.evaluate(() => { document.getElementById('ppn').value = '0'; });
    await upload(page, [{ name: 'affiliate.csv', rows: [aff('1', 'Alpha')] },
      { name: 'ads.csv', rows: [ad('Alpha', 100)] },
      { name: 'clicks.csv', rows: [1, 2, 3, 4].map(i => ({ ...click(), 'Klik ID': 'k' + i })) }]);
    const head = await page.locator('#tblMain thead').innerText();
    for (const h of [/LP View/i, /Biaya\/LP View/i, /Klik Shopee/i, /CPC Shopee/i, /Klik Hilang/i]) assert.match(head, h);
    const cells = await page.locator('#tblMain tbody tr').first().locator('td').allInnerTexts();
    const col = key => page.evaluate(k => MC.findIndex(c => c[0] === k), key);
    assert.equal(cells[await col('lpv')], '8');
    assert.equal(cells[await col('cpLpv')], 'Rp13'); // Rp100 / 8 LP views
    assert.equal(cells[await col('lostTotal')], '60%'); // 10 Meta clicks, 4 reached Shopee
    await page.locator('#tblMain th[data-sort="lostTotal"]').click();
    assert.equal(await page.locator('#tblMain th[data-sort="lostTotal"]').getAttribute('aria-sort'), 'descending');
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
    await page.evaluate(() => {
      document.getElementById('ppn').value = '11';
      const factor = document.getElementById('pendingFactor');
      factor.value = '0.5'; factor.dispatchEvent(new Event('change'));
    });
    await page.waitForFunction(() => document.querySelector('#tblStored tbody tr td:nth-child(2)').textContent === 'Rp300');
    assert.equal(await page.locator('#tblStored tbody tr').first().locator('td').nth(2).innerText(), 'Rp111');
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
