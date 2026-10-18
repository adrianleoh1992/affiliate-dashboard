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
