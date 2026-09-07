'use strict';

// End-to-end import, export, restore and keyboard flows use only synthetic data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Papa = require('papaparse');
const { createHarness, csv, aff, ad, click, upload, saveDaily, storedRows, readDownload } = require('./browser.regression.test');

async function setFile(page, selector, name, buffer, mimeType = 'text/csv') {
  await page.setInputFiles(selector, { name, mimeType, buffer: Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer) });
}
async function settle(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function download(page, selector) {
  const pending = page.waitForEvent('download');
  await page.locator(selector).click();
  return pending;
}
async function readBytes(item) {
  const stream = await item.createReadStream(), chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}
async function backup(page) {
  await page.locator('#btnStored').click();
  return JSON.parse(await readDownload(await download(page, '#btnExportAcct')));
}
async function openBackup(page, value, name = 'synthetic-backup.json') {
  await page.locator('#btnStored').click();
  await setFile(page, '#importAcctFile', name, JSON.stringify(value), 'application/json');
  await page.locator('#backupPreview').waitFor({ state: 'visible' });
}
async function prepare(page) {
  await page.evaluate(() => { document.getElementById('ppn').value = '0'; });
  await upload(page, [{ name: 'affiliate.csv', rows: [aff('1', 'Alpha'), aff('2', 'Bravo')] },
    { name: 'ads.csv', rows: [ad('Alpha', 100), ad('Bravo', 300)] }, { name: 'clicks.csv', rows: [click()] }]);
}

async function main() {
  const harness = await createHarness(), cases = [];
  const test = (name, fn) => cases.push({ name, fn });

  test('partial import waits for an explicit decision and exports its quality caveat', async page => {
    await upload(page, [{ name: 'existing.csv', rows: [aff('1')] }]);
    await upload(page, [{ name: 'mixed.csv', rows: [aff('2'), { ...aff('3'), 'Total Komisi per Pesanan(Rp)': 'Rp oops' }] }]);
    assert.equal(await page.evaluate(() => RESULT.kpi.comm), 200);
    assert.equal(await page.locator('[data-accept-import]').count(), 1);
    assert.match(await page.locator('#importFeedback').innerText(), /1 baris valid.*1 baris bermasalah/s);
    await page.locator('#btnClearFeedback').click();
    assert.equal(await page.locator('[data-accept-import]').count(), 1, 'closing results must not silently discard pending review');
    const issues = Papa.parse(await readDownload(await download(page, '[data-issues]')), { header: true, skipEmptyLines: true }).data;
    assert.equal(issues[0].File, 'mixed.csv');
    assert.equal(issues[0].Baris, '3');
    await page.locator('[data-accept-import]').click();
    assert.equal(await page.evaluate(() => RESULT.kpi.comm), 400);
    assert.equal(await page.locator('[data-accept-import]').count(), 0);
    await page.locator('#btnExport').click();
    await page.selectOption('#exportFormat', 'json');
    const analysis = JSON.parse(await readDownload(await download(page, '#btnDownloadData')));
    assert.match(JSON.stringify(analysis), /1 baris bermasalah dikecualikan/);
  });

  test('native report blanks and completion markers load without discarding affiliate rows', async page => {
    await page.evaluate(() => { document.getElementById('ppn').value = '0'; });
    const report = [aff('done'), { ...aff('pending'), 'Status Pesanan': 'Tertunda' },
      { ...aff('cancelled'), 'Status Pesanan': 'Dibatalkan' }].map(row => ({ ...row,
        'Jumlah Pengembalian Dana(Rp)': '', 'Waktu Terselesaikan': '--' }));
    await upload(page, [{ name: 'affiliate-native-shape.csv', rows: report },
      { name: 'ads-native-shape.csv', rows: [{ ...ad(), 'Landing page views': '', shop_clicks: '', Results: '' }] },
      { name: 'clicks-native-shape.csv', rows: [click(), click('')] }]);
    assert.equal(await page.locator('[data-accept-import]').count(), 0, 'Valid source blanks must not trigger partial acceptance');
    assert.deepEqual(await page.evaluate(() => ({ rows: DATA.affiliate.length,
      rejected: IMPORT_REPORTS.reduce((sum, r) => sum + r.parsed.stats.rejected, 0),
      commission: RESULT.kpi.comm, orders: RESULT.kpi.orders, spend: RESULT.kpi.spend })),
      { rows: 3, rejected: 0, commission: 400, orders: 2, spend: 100 });
    await saveDaily(page);
    assert.equal((await storedRows(page)).reduce((sum, row) => sum + row.comm, 0), 400);
    await page.locator('#btnExport').click();
    await page.selectOption('#exportFormat', 'json');
    const analysis = JSON.parse(await readDownload(await download(page, '#btnDownloadData')));
    assert.match(JSON.stringify(analysis), /Pengembalian Dana/);
  });

  test('discarding a partial file preserves existing data and gives a durable reason', async page => {
    await upload(page, [{ name: 'existing.csv', rows: [aff()] }]);
    await upload(page, [{ name: 'review.csv', rows: [aff('2'), { ...aff('3'), 'Waktu Pemesanan': '2026-02-30' }] }]);
    await page.locator('[data-discard-import]').click();
    assert.equal(await page.evaluate(() => RESULT.kpi.comm), 200);
    assert.equal(await page.locator('[data-accept-import]').count(), 0);
    assert.match(await page.locator('#importFeedback').innerText(), /diabaikan oleh pengguna/);
  });

  test('invalid files leave actionable feedback after the transient toast closes', async page => {
    for (const fixture of [
      { name: 'unknown.csv', content: 'hello,world\n1,2' },
      { name: 'excel.xlsx', content: 'not a csv' },
      { name: 'encoding.csv', content: Buffer.from([0xc3, 0x28]) },
    ]) {
      await setFile(page, '#files', fixture.name, fixture.content);
      await page.waitForFunction(() => !document.getElementById('files').value);
    }
    await page.evaluate(() => document.getElementById('toast').classList.remove('show'));
    const feedback = await page.locator('#importFeedback').innerText();
    assert.match(feedback, /unknown.csv/);
    assert.match(feedback, /CSV, bukan file Excel/);
    assert.match(feedback, /UTF-8\/UTF-16/);
    assert.equal(await page.evaluate(() => FILES.length), 0);
    assert.equal(await page.locator('#btnExport').isDisabled(), true);
    assert.equal(await page.locator('#btnPdf').isDisabled(), true);
  });

  test('file read failures remain visible and allow a successful retry', async page => {
    await page.evaluate(() => {
      const read = FileReader.prototype.readAsArrayBuffer;
      FileReader.prototype.readAsArrayBuffer = function (...args) {
        FileReader.prototype.readAsArrayBuffer = read;
        queueMicrotask(() => this.onerror(new ProgressEvent('error')));
      };
    });
    await upload(page, [{ name: 'unreadable.csv', rows: [aff()] }]);
    assert.match(await page.locator('#importFeedback').innerText(), /File tidak dapat dibaca/);
    await upload(page, [{ name: 'retry.csv', rows: [aff()] }]);
    assert.equal(await page.evaluate(() => RESULT.kpi.comm), 200);
  });

  for (const encoding of ['utf16le', 'utf16be']) {
    test(`${encoding} semicolon report preserves local decimals and leading-zero IDs`, async page => {
      const content = 'sep=;\r\n' + Papa.unparse([{ ...aff('001'), 'Total Komisi per Pesanan(Rp)': 'Rp 1.234,50' }], { delimiter: ';' });
      let bytes = Buffer.from('\ufeff' + content, 'utf16le');
      if (encoding === 'utf16be') bytes = bytes.swap16();
      await setFile(page, '#files', encoding + '.csv', bytes);
      await page.waitForFunction(() => !document.getElementById('files').value);
      assert.equal(await page.evaluate(() => RESULT.kpi.comm), 1234.5);
      assert.equal(await page.evaluate(() => DATA.affiliate[0]['ID Pemesanan']), '001');
    });
  }

  test('canceling a queued import preserves prior data and rejects stale read completion', async page => {
    await upload(page, [{ name: 'existing.csv', rows: [aff()] }]);
    await page.evaluate(() => {
      const read = FileReader.prototype.readAsArrayBuffer;
      window.__queuedFileReads = [];
      FileReader.prototype.readAsArrayBuffer = function (...args) { window.__queuedFileReads.push(() => read.apply(this, args)); };
    });
    await setFile(page, '#files', 'slow.csv', csv([aff('2')]));
    await page.waitForFunction(() => window.__queuedFileReads.length === 1);
    assert.equal(await page.locator('#btnExport').isDisabled(), true);
    await page.locator('#btnCancelImport').click();
    await page.evaluate(() => window.__queuedFileReads.splice(0).forEach(release => release()));
    await settle(page);
    assert.equal(await page.evaluate(() => RESULT.kpi.comm), 200);
    assert.equal(await page.evaluate(() => FILES.length), 1);
    assert.equal(await page.locator('#importProgress').isVisible(), false);
    assert.equal(await page.locator('#btnExport').isDisabled(), false);
  });

  for (const action of ['switch', 'reset']) {
    test(`pending partial review cannot leak into data after ${action}`, async page => {
      await upload(page, [{ name: 'mixed.csv', rows: [aff(), { ...aff('2'), 'Status Pesanan': 'Unknown' }] }]);
      assert.equal(await page.locator('[data-accept-import]').count(), 1);
      if (action === 'switch') await page.selectOption('#account', 'Account B');
      else await page.locator('#btnReset').click();
      assert.equal(await page.locator('[data-accept-import]').count(), 0);
      assert.equal(await page.evaluate(() => RESULT), null);
      assert.equal(await page.locator('#importFeedback').isVisible(), false);
    });
  }

  test('adding CSVs expands the full date range while preserving a user-selected period', async page => {
    const range = () => page.evaluate(() => ({
      start: document.getElementById('dateStart').value,
      end: document.getElementById('dateEnd').value,
      analyzedStart: RESULT.range.start, analyzedEnd: RESULT.range.end,
      commission: RESULT.kpi.comm,
    }));
    await upload(page, [{ name: 'initial-period.csv', rows: [
      aff('1', 'Alpha', '2026-08-03'), aff('2', 'Alpha', '2026-08-07'),
    ] }]);
    assert.deepEqual(await range(), { start: '2026-08-03', end: '2026-08-07',
      analyzedStart: '2026-08-03', analyzedEnd: '2026-08-07', commission: 400 });
    await upload(page, [{ name: 'extended-period.csv', rows: [
      aff('3', 'Alpha', '2026-08-01'), aff('4', 'Alpha', '2026-08-10'),
    ] }]);
    assert.deepEqual(await range(), { start: '2026-08-01', end: '2026-08-10',
      analyzedStart: '2026-08-01', analyzedEnd: '2026-08-10', commission: 800 });
    await page.locator('#btnSet').click();
    await page.locator('#dateStart').fill('2026-08-03');
    await page.locator('#dateStart').dispatchEvent('change');
    await page.locator('#dateEnd').fill('2026-08-07');
    await page.locator('#dateEnd').dispatchEvent('change');
    await page.keyboard.press('Escape');
    await upload(page, [{ name: 'more-dates.csv', rows: [
      aff('5', 'Alpha', '2026-07-30'), aff('6', 'Alpha', '2026-08-15'), aff('7', 'Alpha', '2026-08-05'),
    ] }]);
    assert.deepEqual(await range(), { start: '2026-08-03', end: '2026-08-07',
      analyzedStart: '2026-08-03', analyzedEnd: '2026-08-07', commission: 600 });
    assert.equal(await page.evaluate(() => DATA.affiliate.length), 7, 'Rows outside the chosen period remain loaded');
  });

  test('search exports only visible tags with account and period context', async page => {
    await prepare(page);
    await page.locator('#tagSearch').fill('brAVO');
    assert.equal(await page.locator('#tblMain tbody tr').count(), 1);
    assert.match(await page.locator('#tagSearchCount').innerText(), /1 dari 2 tag/);
    await page.locator('#btnExport').click();
    await page.selectOption('#exportScope', 'visible');
    assert.match(await page.locator('#exportPreview').innerText(), /1 baris/);
    const rows = Papa.parse(await readDownload(await download(page, '#btnDownloadData')), { header: true, skipEmptyLines: true }).data;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].Tag, 'Bravo');
    assert.equal(rows[0].Akun, 'default');
    assert.match(JSON.stringify(rows[0]), /2026-08-01/);
    await page.selectOption('#exportScope', 'all');
    assert.match(await page.locator('#exportPreview').innerText(), /2 baris/);
    await page.keyboard.press('Escape');
    await page.locator('#tagSearch').fill('not-present');
    await page.locator('#btnExport').click();
    await page.selectOption('#exportScope', 'visible');
    assert.equal(await page.locator('#btnDownloadData').isDisabled(), true);
    await page.selectOption('#exportFormat', 'json');
    assert.equal(await page.locator('#btnDownloadData').isDisabled(), false);
  });

  test('status filtering also scopes visible CSV exports', async page => {
    await prepare(page);
    await upload(page, [{ name: 'organic.csv', rows: [aff('3', 'OrganicOnly')] }]);
    await page.locator('#dgrid [data-filter="organik"]').click();
    assert.equal(await page.locator('#tblMain tbody tr').count(), 1);
    await page.locator('#btnExport').click();
    await page.selectOption('#exportScope', 'visible');
    const rows = Papa.parse(await readDownload(await download(page, '#btnDownloadData')), { header: true, skipEmptyLines: true }).data;
    assert.deepEqual(rows.map(row => row.Tag), ['OrganicOnly']);
  });

  test('every CSV dataset downloads parseable contextual rows', async page => {
    await prepare(page);
    await page.locator('#btnExport').click();
    for (const dataset of ['tags', 'units', 'daily', 'matching']) {
      await page.selectOption('#exportDataset', dataset);
      const item = await download(page, '#btnDownloadData');
      assert.ok(item.suggestedFilename().startsWith(dataset + '-default-2026-08-01_2026-08-01'));
      const parsed = Papa.parse(await readDownload(item), { header: true, skipEmptyLines: true });
      assert.deepEqual(parsed.errors, []);
      assert.ok(parsed.data.length > 0);
      assert.equal(parsed.data[0].Akun, 'default');
      assert.match(JSON.stringify(parsed.data[0]), /2026-08-01/);
    }
  });

  test('export and PDF dialogs trap keyboard focus, close with Escape and restore focus', async page => {
    await prepare(page);
    for (const [opener, modal] of [['#btnExport', '#exportModal'], ['#btnPdf', '#pdfModal']]) {
      await page.locator(opener).click();
      await settle(page);
      assert.equal(await page.locator(modal).getAttribute('aria-hidden'), 'false');
      assert.equal(await page.locator(modal).getAttribute('role'), 'dialog');
      await page.keyboard.press('Shift+Tab');
      assert.equal(await page.evaluate(selector => document.querySelector(selector).contains(document.activeElement), modal), true);
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(selector => document.querySelector(selector).contains(document.activeElement), modal), true);
      await page.keyboard.press('Escape');
      assert.equal(await page.locator(modal).isVisible(), false);
      assert.equal(await page.evaluate(selector => document.activeElement === document.querySelector(selector), opener), true);
    }
  });

  test('switching from export to PDF returns keyboard focus to the visible toolbar', async page => {
    await prepare(page);
    await page.locator('#btnExport').click();
    await page.locator('#btnExportPdf').click();
    await settle(page);
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => document.activeElement === document.getElementById('btnExport')), true);
  });

  test('all three PDF options download actual PDFs offline without invoking browser print', async page => {
    await prepare(page);
    await page.evaluate(() => { window.print = () => { throw new Error('Direct export must not invoke print'); }; });
    await page.locator('#btnPdf').click();
    await page.locator('#pdfTitle').fill('Synthetic report – café ∞');
    for (const mode of ['ringkas', 'standar', 'lengkap']) {
      const item = await download(page, `[data-pdf="${mode}"]`);
      const bytes = await readBytes(item);
      assert.ok(bytes.subarray(0, 5).equals(Buffer.from('%PDF-')));
      assert.ok(bytes.length > 10000);
      assert.ok(item.suggestedFilename().endsWith('-' + mode + '.pdf'));
      await page.waitForFunction(() => document.getElementById('pdfBusy').classList.contains('hidden'));
      assert.equal(await page.locator('#pdfError').isVisible(), false);
      assert.equal(await page.locator(`[data-pdf="${mode}"]`).isDisabled(), false);
    }
  });

  test('missing PDF library gives an inline error and a successful retry', async page => {
    await prepare(page);
    let fail = true;
    await page.route('**/vendor/jspdf.umd.min.js', route => fail ? route.abort() : route.continue());
    await page.locator('#btnPdf').click();
    await page.locator('[data-pdf="ringkas"]').click();
    await page.locator('#pdfError').waitFor({ state: 'visible' });
    assert.match(await page.locator('#pdfError').innerText(), /Pustaka PDF tidak dapat dimuat/);
    fail = false;
    const bytes = await readBytes(await download(page, '[data-pdf="ringkas"]'));
    assert.ok(bytes.subarray(0, 5).equals(Buffer.from('%PDF-')));
  });

  test('PDF preparation cannot download stale data after an account switch', async page => {
    await prepare(page);
    let release;
    const held = new Promise(resolve => { release = resolve; });
    let requested = false;
    await page.route('**/vendor/jspdf.umd.min.js', async route => {
      requested = true;
      await held;
      await route.continue();
    });
    const downloads = [];
    page.on('download', item => downloads.push(item));
    await page.locator('#btnPdf').click();
    await page.locator('[data-pdf="ringkas"]').click();
    assert.equal(await page.locator('#pdfBusy').isVisible(), true);
    await page.keyboard.press('Escape');
    await page.selectOption('#account', 'Account B');
    release();
    await page.waitForFunction(() => !PDF_BUSY);
    assert.equal(requested, true);
    assert.equal(downloads.length, 0);
    assert.equal(await page.evaluate(() => RESULT), null);
  });

  for (const width of [320, 390]) {
    test(`import review and export dialogs fit a ${width}px viewport`, async page => {
      await page.setViewportSize({ width, height: 844 });
      await prepare(page);
      await upload(page, [{ name: 'very-long-synthetic-report-name-with-diagnostics-2026-08-01.csv',
        rows: [aff('4'), { ...aff('5'), 'Total Komisi per Pesanan(Rp)': 'Rp invalid' }] }]);
      await page.locator('#importFeedback').scrollIntoViewIfNeeded();
      let dimensions = await page.evaluate(() => ({ document: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth }));
      assert.ok(dimensions.document <= dimensions.viewport + 1);
      for (const [button, modal] of [['#btnExport', '#exportModal'], ['#btnPdf', '#pdfModal']]) {
        await page.locator(button).click();
        const bounds = await page.locator(modal + ' .modal-box').boundingBox();
        assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width);
        assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 844);
        dimensions = await page.evaluate(() => ({ document: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth }));
        assert.ok(dimensions.document <= dimensions.viewport + 1);
        await page.keyboard.press('Escape');
      }
    });
  }

  test('backup preview states replacement scope and restore replaces only the selected account', async page => {
    await upload(page, [{ name: 'source.csv', rows: [aff()] }]);
    await saveDaily(page);
    const exported = await backup(page);
    await page.selectOption('#account', 'Account B');
    await upload(page, [{ name: 'target.csv', rows: [aff('2'), aff('3')] }]);
    await saveDaily(page);
    const before = await storedRows(page, 'affiliate', 'Account B');
    await openBackup(page, exported);
    assert.match(await page.locator('#backupPreviewSummary').innerText(), /default.*Account B.*diganti/s);
    assert.deepEqual(await storedRows(page, 'affiliate', 'Account B'), before);
    await page.locator('#btnRestoreAcct').click();
    await page.locator('#backupPreview').waitFor({ state: 'hidden' });
    assert.equal((await storedRows(page, 'affiliate', 'Account B')).reduce((sum, row) => sum + row.comm, 0), 200);
    assert.equal((await storedRows(page)).reduce((sum, row) => sum + row.comm, 0), 200);
    const restored = await backup(page);
    assert.equal(restored.account.name, 'Account B');
    assert.ok(restored.rowhashes.length > 0);
  });

  test('canceling or rejecting a corrupt backup preserves stored history', async page => {
    await upload(page, [{ name: 'source.csv', rows: [aff()] }]);
    await saveDaily(page);
    const exported = await backup(page), before = await storedRows(page);
    await openBackup(page, exported);
    await page.locator('#btnCancelRestore').click();
    assert.equal(await page.locator('#backupPreview').isVisible(), false);
    assert.deepEqual(await storedRows(page), before);
    exported.affiliate[0].comm = 'not a number';
    await setFile(page, '#importAcctFile', 'corrupt.json', JSON.stringify(exported), 'application/json');
    await page.waitForFunction(() => document.getElementById('toast').textContent.includes('Gagal membaca cadangan'));
    assert.equal(await page.locator('#backupPreview').isVisible(), false);
    assert.deepEqual(await storedRows(page), before);
  });

  for (const action of ['switch', 'reset']) {
    test(`delayed backup read cannot revive a preview after ${action}`, async page => {
      await upload(page, [{ name: 'source.csv', rows: [aff()] }]);
      await saveDaily(page);
      const exported = await backup(page);
      await page.evaluate(() => {
        const read = File.prototype.text;
        window.__backupReads = [];
        File.prototype.text = function (...args) {
          return new Promise((resolve, reject) => window.__backupReads.push(() => read.apply(this, args).then(resolve, reject)));
        };
      });
      await setFile(page, '#importAcctFile', 'slow.json', JSON.stringify(exported), 'application/json');
      await page.waitForFunction(() => window.__backupReads.length === 1);
      if (action === 'switch') await page.selectOption('#account', 'Account B');
      else { page.once('dialog', dialog => dialog.accept()); await page.locator('#btnReset').click(); }
      await page.evaluate(() => window.__backupReads.splice(0).forEach(release => release()));
      await settle(page);
      assert.equal(await page.locator('#backupPreview').isVisible(), false);
      assert.equal((await storedRows(page)).reduce((sum, row) => sum + row.comm, 0), 200);
      assert.equal((await storedRows(page, 'affiliate', 'Account B')).length, 0);
    });
  }

  if (process.env.EXPERIENCE_SCREENSHOTS) {
    test('capture synthetic desktop and mobile experience states', async page => {
      const output = path.resolve(process.env.EXPERIENCE_SCREENSHOTS);
      fs.mkdirSync(output, { recursive: true });
      await prepare(page);
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.locator('#btnClearFeedback').click();
        await page.locator('#toast.show').waitFor({ state: 'hidden' });
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: path.join(output, `main-${width}.png`) });
        await page.screenshot({ path: path.join(output, `main-full-${width}.png`), fullPage: true });
        await upload(page, [{ name: 'review-report.csv', rows: [aff('4'), { ...aff('5'), 'Total Komisi per Pesanan(Rp)': 'Rp 1oops' }] }]);
        await page.locator('#toast.show').waitFor({ state: 'hidden' });
        await page.locator('#importFeedback').scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(output, `import-${width}.png`) });
        await page.locator('[data-discard-import]').click();
        await page.locator('#btnPdf').click();
        await page.screenshot({ path: path.join(output, `pdf-${width}.png`) });
        await page.keyboard.press('Escape');
      }
    });
  }

  let failed = 0;
  try {
    for (const { name, fn } of cases) {
      const context = await harness.browser.newContext({ viewport: { width: 1440, height: 1000 } });
      const external = [], errors = [];
      await context.route('**/*', route => {
        if (route.request().url().startsWith(harness.url + '/')) return route.continue();
        external.push(route.request().url());
        return route.abort();
      });
      const page = await context.newPage();
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
        await page.waitForFunction(() => window.Engine && window.Papa && window.DashboardImport && window.DashboardExport && window.__dailyStore);
        await fn(page);
        assert.deepEqual(errors, [], 'uncaught browser errors');
        assert.deepEqual(external, [], 'external network requests');
        console.log('PASS ' + name);
      } catch (error) {
        failed++;
        console.error('FAIL ' + name + '\n  ' + error.stack);
      } finally { await context.close(); }
    }
  } finally { await harness.close(); }
  console.log(`${cases.length - failed}/${cases.length} experience tests passed`);
  if (failed) process.exitCode = 1;
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
