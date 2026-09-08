'use strict';

// Browser PDF regression checks use only synthetic data and do not need a server.
// PDF_QA_DIR=/absolute/path additionally writes reviewable samples for visual QA.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const Engine = require('./engine');

function fixture(size = 100) {
  const affiliate = [], ads = [], clicks = [];
  for (let index = 0; index < size; index++) {
    const special = ['__proto__', 'constructor', 'Toko Café Éléphant - crème brûlée', 'Produk 東京 🚀'];
    const tag = special[index] || 'Tag ' + String(index + 1).padStart(3, '0') + ' - Koleksi rumah dan kebutuhan sehari-hari';
    const date = '2026-08-' + String(index % 28 + 1).padStart(2, '0');
    affiliate.push({ 'ID Pemesanan': String(index), 'Status Pesanan': index % 5 === 0 ? 'Tertunda' : 'Selesai',
      'Waktu Pemesanan': date + ' 10:00:00', 'Waktu Klik': date + ' 09:00:00', 'Jumlah': '2',
      'Tag_link1': tag, 'Total Komisi per Produk(Rp)': '123456.78', 'Nilai Pembelian(Rp)': '987654.32',
      'Nama Barang': 'Produk pengujian ' + index + ': ' + tag, 'Nama Toko': 'Café Nusantara',
      'Platform': 'Facebook', 'L1 Kategori Global': 'Perlengkapan rumah', 'Content Type': 'Video',
    });
    ads.push({ 'Ad name': 'Campaign ' + index + ' | Set A | ' + tag, 'Campaign name': 'Campaign ' + index,
      'Amount spent (IDR)': '75000.25', 'Reporting starts': date, 'Reporting ends': date,
      'Link clicks': '19', 'Impressions': '1357', 'Reach': '1034', 'Ad delivery': index % 2 ? 'active' : 'inactive' });
    clicks.push({ 'Waktu Klik': date + ' 09:00:00', 'Tag_link': tag, 'Perujuk': 'Facebook', 'Wilayah Klik': 'Jakarta' });
  }
  return Engine.analyze({ affiliate, ads, clicks, tagMap: {} }, {
    ppn: 11, pendingFactor: 0.95, minDays: 1, lagDays: 3, dateStart: '2026-08-01', dateEnd: '2026-08-28',
  });
}

function demoFixture() {
  const affiliate = [], ads = [], clicks = [];
  const campaigns = [
    { tag: 'Skincare harian', spend: 40000, commission: 15000, orders: 8, metaClicks: 85, shopeeClicks: 78 },
    { tag: 'Peralatan dapur', spend: 30000, commission: 10000, orders: 4, metaClicks: 65, shopeeClicks: 60 },
    { tag: 'Aksesori ponsel', spend: 25000, commission: 8000, orders: 1, metaClicks: 55, shopeeClicks: 48 },
  ];
  for (let day = 1; day <= 14; day++) {
    const date = '2026-08-' + String(day).padStart(2, '0');
    for (const [index, campaign] of campaigns.entries()) {
      for (let order = 0; order < campaign.orders; order++) affiliate.push({
        'ID Pemesanan': 'DEMO-' + day + '-' + index + '-' + order,
        'Status Pesanan': day > 11 ? 'Tertunda' : 'Selesai',
        'Waktu Pemesanan': date + ' 14:00:00', 'Waktu Klik': date + ' 09:00:00',
        'Jumlah': '1', 'Tag_link1': campaign.tag,
        'Total Komisi per Produk(Rp)': String(campaign.commission),
        'Nilai Pembelian(Rp)': String(campaign.commission * 10),
        'Nama Barang': campaign.tag + ' - produk contoh', 'Nama Toko': 'Toko Demonstrasi',
        'Platform': 'Facebook', 'L1 Kategori Global': 'Contoh produk', 'Content Type': 'Video',
      });
      ads.push({ 'Ad name': 'Demo | Set A | ' + campaign.tag, 'Campaign name': 'Kampanye demonstrasi',
        'Amount spent (IDR)': String(campaign.spend), 'Reporting starts': date, 'Reporting ends': date,
        'Link clicks': String(campaign.metaClicks), 'Impressions': String(campaign.metaClicks * 35),
        'Reach': String(campaign.metaClicks * 25), 'Ad delivery': 'active' });
      for (let click = 0; click < campaign.shopeeClicks; click++) clicks.push({
        'Waktu Klik': date + ' 09:00:00', 'Tag_link': campaign.tag, 'Perujuk': 'Facebook', 'Wilayah Klik': 'Jakarta',
      });
    }
  }
  return Engine.analyze({ affiliate, ads, clicks, tagMap: {} }, {
    ppn: 11, pendingFactor: 0.95, minDays: 3, lagDays: 3,
    dateStart: '2026-08-01', dateEnd: '2026-08-14',
  });
}

async function main() {
  const candidates = [process.env.CHROME_PATH, chromium.executablePath(),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome',
    '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean);
  const executablePath = candidates.find(candidate => fs.existsSync(candidate));
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.setContent('<!doctype html><html><body><h1>PDF regression fixture</h1></body></html>');
    for (const script of ['vendor/jspdf.umd.min.js', 'vendor/jspdf.plugin.autotable.min.js', 'vendor/pdf-font.js', 'pdf-charts.js', 'pdf-export.js']) {
      await page.addScriptTag({ path: path.join(__dirname, script) });
    }
    const result = fixture();
    const outputs = await page.evaluate(result => {
      const original = JSON.stringify(result);
      function freeze(value) {
        if (value && typeof value === 'object' && !Object.isFrozen(value)) {
          Object.freeze(value); Object.values(value).forEach(freeze);
        }
        return value;
      }
      freeze(result);
      const labels = [], cards = [], OriginalPDF = window.jspdf.jsPDF;
      window.jspdf.jsPDF = function (options) {
        const doc = new OriginalPDF(options), drawText = doc.text, drawCard = doc.roundedRect;
        doc.text = function (value, x, y, ...rest) {
          labels.push({ value: String(value), page: doc.getCurrentPageInfo().pageNumber });
          return drawText.call(this, value, x, y, ...rest);
        };
        doc.roundedRect = function (x, y, width, height, ...rest) {
          cards.push({ x, y, width, height, page: doc.getCurrentPageInfo().pageNumber });
          return drawCard.call(this, x, y, width, height, ...rest);
        };
        return doc;
      };
      window.jspdf.jsPDF.API = OriginalPDF.API;
      const bounds = [], chartCalls = [], api = window.jspdf.jsPDF.API, autoTable = api.autoTable;
      const makeCharts = DashboardPDFCharts.create;
      DashboardPDFCharts = { ...DashboardPDFCharts, create(doc, options) {
        const charts = makeCharts(doc, options);
        return Object.fromEntries(Object.entries(charts).map(([name, draw]) => [name, box => {
          chartCalls.push({ name, box, page: doc.getCurrentPageInfo().pageNumber });
          return draw(box);
        }]));
      } };
      api.autoTable = function (options) {
        const draw = options.didDrawCell;
        options.didDrawCell = data => {
          bounds.push({ x: data.cell.x, y: data.cell.y, width: data.cell.width, height: data.cell.height,
            kind: data.section, text: data.cell.text.join(' '), page: data.doc.getCurrentPageInfo().pageNumber });
          if (draw) draw(data);
        };
        return autoTable.call(this, options);
      };
      const reports = {};
      for (const mode of ['ringkas', 'standar', 'lengkap']) {
        const start = bounds.length;
        const chartStart = chartCalls.length;
        const labelStart = labels.length, cardStart = cards.length;
        const doc = window.DashboardPDF.create(result, { mode, account: 'QA Café Indonesia',
          title: 'Laporan kinerja affiliate - data sintetis', generatedAt: '2026-09-06T05:00:00Z',
          quality: ['DATA SINTETIS UNTUK PENGUJIAN - bukan data akun sebenarnya.'] });
        reports[mode] = { pages: doc.getNumberOfPages(), bytes: doc.output('datauristring').split(',')[1],
          bounds: bounds.slice(start), charts: chartCalls.slice(chartStart), font: doc.getFont().fontName,
          labels: labels.slice(labelStart), cards: cards.slice(cardStart) };
      }
      const invalid = [];
      for (const [data, options] of [[null, {}], [result, { mode: '__proto__' }], [result, { mode: 'constructor' }],
        [result, { generatedAt: 'bad-date' }]]) {
        try { window.DashboardPDF.create(data, options); invalid.push(false); }
        catch { invalid.push(true); }
      }
      return { reports, unchanged: original === JSON.stringify(result), invalid };
    }, result);
    assert.deepEqual(errors, [], 'PDF generation must not cause browser errors');
    assert.equal(outputs.unchanged, true, 'Export must not mutate the analysis');
    assert.deepEqual(outputs.invalid, [true, true, true, true], 'Reject missing input, unknown modes and invalid metadata');
    const qaDir = process.env.PDF_QA_DIR;
    if (qaDir) fs.mkdirSync(qaDir, { recursive: true });
    for (const [mode, report] of Object.entries(outputs.reports)) {
      assert.equal(report.font, 'DashboardSans', 'Embed the supplied Unicode font');
      assert.ok(report.pages > 2, 'Large fixture must paginate');
      const bytes = Buffer.from(report.bytes, 'base64');
      assert.equal(bytes.subarray(0, 5).toString(), '%PDF-', 'Download must contain a real PDF');
      assert.deepEqual(report.charts.map(chart => chart.name), ['trend', 'decisions', 'pairedBars']);
      for (const { box } of report.charts) {
        assert.ok(box.x >= 14 && box.x + box.width <= 196 && box.y >= 18 && box.y + box.height <= 279, 'Charts must fit page bounds');
      }
      assert.equal(report.charts[0].page, 2, 'Trend follows the main dashboard page');
      const front = report.labels.filter(label => label.page === 1).map(label => label.value);
      for (const label of ['01  Dashboard utama', 'Komisi Total', 'Spend Iklan', 'Laba Bersih', 'ROAS Total',
        'Klik Meta', 'Klik Shopee', 'Klik Hilang', '% Klik Masuk Shopee', 'Biaya di Tag STOP', 'Total bisa dialihkan']) {
        assert.ok(front.includes(label), 'Front page must include the main dashboard block: ' + label);
      }
      assert.equal(report.cards.filter(card => card.page === 1).length, 15, 'All KPI, click, budget and decision cards must fit on the dashboard page');
      for (const card of report.cards) assert.ok(card.x >= 14 && card.x + card.width <= 196.01 && card.y >= 18 && card.y + card.height <= 279,
        'Dashboard cards must remain within page bounds');
      const trend = report.charts[0].box.rows;
      assert.ok(trend.some(row => row.comm != null));
      assert.ok(Math.abs(trend.reduce((sum, row) => sum + (row.comm || 0), 0) - result.kpi.commEff) < 0.0001,
        'Trend must use effective commission matching the summary');
      assert.equal(report.charts[1].box.items.reduce((sum, item) => sum + item.count, 0), result.tags.length);
      for (const cell of report.bounds) {
        assert.ok(cell.x >= 13.99 && cell.x + cell.width <= 196.01, 'Table cell must stay inside horizontal page bounds');
        assert.ok(cell.y >= 17.99 && cell.y + cell.height <= 279.02,
          `Table cell must not overlap header/footer: ${JSON.stringify(cell)}`);
      }
      for (const tag of ['__proto__', 'constructor', 'Toko Café Éléphant', 'Tag 100']) {
        assert.ok(report.bounds.some(cell => cell.kind === 'body' && cell.text.includes(tag)), 'Every tag must be exported: ' + tag);
      }
      assert.ok(report.bounds.some(cell => cell.text.includes('[U+6771]')), 'Unsupported Unicode must retain explicit identity');
      const pageNumbers = new Set(report.bounds.filter(cell => cell.kind === 'body').map(cell => cell.page));
      for (const pageNumber of pageNumbers) {
        assert.ok(report.bounds.some(cell => cell.kind === 'head' && cell.page === pageNumber), 'Table headers must repeat on each page');
      }
      if (qaDir) fs.writeFileSync(path.join(qaDir, 'affiliate-' + mode + '.pdf'), bytes);
      console.log('PASS PDF ' + mode + ': ' + report.pages + ' pages, ' + bytes.length + ' bytes; all tags, repeated headers, page bounds');
    }
    assert.ok(outputs.reports.standar.pages > outputs.reports.ringkas.pages, 'Standard adds ad and daily detail');
    assert.ok(outputs.reports.lengkap.pages > outputs.reports.standar.pages, 'Complete adds matching, products and breakdowns');
    // Empty / ad-free accounts are valid reports, with unavailable ratios rendered as dashes.
    const empty = await page.evaluate(result => {
      const doc = window.DashboardPDF.create(result, { mode: 'lengkap', account: 'Akun tanpa data', generatedAt: '2026-09-06' });
      return { pages: doc.getNumberOfPages(), bytes: doc.output('arraybuffer').byteLength };
    }, Engine.analyze({ affiliate: [], ads: [], clicks: [] }, {}));
    assert.ok(empty.pages > 0 && empty.bytes > 1000);
    console.log('PASS PDF missing inputs, mode validation, Unicode labels, source immutability, empty report');
    const clickSource = {
      affiliate: ['A', 'B'].map(tag => ({ 'ID Pemesanan': tag, 'Status Pesanan': 'Selesai',
        'Waktu Pemesanan': '2026-09-01 10:00:00', 'Tag_link1': tag, 'Total Komisi per Produk(Rp)': '100' })),
      ads: [1, 2].flatMap(day => ['A', 'B'].map((tag, index) => ({ 'Ad name': tag,
        'Amount spent (IDR)': '50', 'Reporting starts': '2026-09-0' + day, 'Reporting ends': '2026-09-0' + day,
        'Link clicks': String((index + 1) * (day === 1 ? 10 : 1000)) }))),
      clicks: ['A', 'B'].flatMap((tag, index) => Array.from({ length: index === 0 ? 5 : 25 }, () => ({
        'Waktu Klik': '2026-09-01 09:00:00', 'Tag_link': tag }))), tagMap: { A: 'A', B: 'B' },
    };
    const clickReports = await page.evaluate(results => {
      const OriginalPDF = window.jspdf.jsPDF;
      let labels;
      window.jspdf.jsPDF = function (options) {
        const doc = new OriginalPDF(options), originalText = doc.text;
        doc.text = function (value, ...rest) {
          if (doc.getCurrentPageInfo().pageNumber === 1) labels.push(String(value));
          return originalText.call(this, value, ...rest);
        };
        return doc;
      };
      window.jspdf.jsPDF.API = OriginalPDF.API;
      try {
        return results.map(result => {
          labels = [];
          DashboardPDF.create(result, { mode: 'ringkas', generatedAt: '2026-09-06' });
          return ['Klik Meta', 'Klik Shopee', 'Klik Hilang', '% Klik Masuk Shopee'].map(label => labels[labels.indexOf(label) + 1]);
        });
      } finally { window.jspdf.jsPDF = OriginalPDF; }
    }, [clickSource, { ...clickSource, clicks: [] }, { ...clickSource, ads: [] }]
      .map(source => Engine.analyze(source, { ppn: 0, lagDays: 0 })));
    assert.deepEqual(clickReports[0], ['30', '30', '5', '100,00%'],
      'Dashboard compares matched tags in the click window; gains on one tag must not offset lost clicks on another');
    assert.deepEqual(clickReports[1], ['3.030', '-', '-', '-'], 'Without a click report, show full-period Meta clicks and unavailable comparison metrics');
    assert.deepEqual(clickReports[2], ['-', '-', '-', '-'], 'Without ads, a click comparison must remain unavailable');
    console.log('PASS PDF dashboard click scope, per-tag losses and unavailable comparisons');
    const partialSources = Engine.analyze({
      affiliate: [1, 3, 4].map(day => ({ 'ID Pemesanan': 'coverage-' + day, 'Status Pesanan': 'Selesai',
        'Waktu Pemesanan': '2026-09-0' + day + ' 10:00:00', 'Tag_link1': 'Coverage',
        'Total Komisi per Produk(Rp)': day === 4 ? '0' : '100' })),
      ads: [1, 2, 4].map(day => ({ 'Ad name': 'Coverage', 'Amount spent (IDR)': day === 4 ? '0' : '50',
        'Reporting starts': '2026-09-0' + day, 'Reporting ends': '2026-09-0' + day })), clicks: [],
    }, { ppn: 0, lagDays: 0 });
    const coverageRows = await page.evaluate(result => {
      const api = window.jspdf.jsPDF.API, original = api.autoTable;
      let dailyRows;
      api.autoTable = function (options) {
        if (options.head[0][0] === 'Tanggal / kematangan') dailyRows = options.body;
        return original.call(this, options);
      };
      try { window.DashboardPDF.create(result, { mode: 'standar', generatedAt: '2026-09-06' }); }
      finally { api.autoTable = original; }
      return dailyRows;
    }, partialSources);
    assert.equal(coverageRows.length, 4);
    assert.deepEqual(coverageRows[1].slice(1), ['Rp 50,00', '-', '-', '-', '-'], 'Ad-only day must not claim zero affiliate sales or a confirmed loss');
    assert.deepEqual(coverageRows[2].slice(1), ['-', 'Rp 100,00', '-', '-', '1'], 'Affiliate-only day must not imply zero ad spend');
    assert.deepEqual(coverageRows[3].slice(1), ['Rp 0,00', 'Rp 0,00', 'Rp 0,00', '-', '1'], 'Source rows containing zero must retain their real zero values');
    console.log('PASS PDF daily table distinguishes missing sources from real zero values');
    const activity = Engine.analyze({
      affiliate: [['Organik tetap', 100, 'Selesai'], ['Refund tetap', -10, 'Selesai'], ['Pending tetap', 50, 'Tertunda']]
        .map(([tag, commission, status], index) => ({ 'ID Pemesanan': 'activity-' + index,
          'Status Pesanan': status, 'Waktu Pemesanan': '2026-09-01 10:00:00',
          'Tag_link1': tag, 'Total Komisi per Produk(Rp)': String(commission) })),
      ads: [['Tanpa aktivitas', 0], ['Biaya tetap', 50]].map(([tag, spend]) => ({
        'Ad name': tag, 'Amount spent (IDR)': String(spend),
        'Reporting starts': '2026-09-01', 'Reporting ends': '2026-09-01',
      })),
      clicks: [{ 'Waktu Klik': '2026-09-01 09:00:00', 'Tag_link': 'Klik saja' }],
      tagMap: { 'Tanpa aktivitas': 'Tanpa aktivitas', 'Biaya tetap': 'Biaya tetap' },
    }, { ppn: 0, pendingFactor: 0, lagDays: 0 });
    const activityReports = await page.evaluate(result => {
      const originalResult = JSON.stringify(result), api = window.jspdf.jsPDF.API;
      const originalTable = api.autoTable, originalCharts = DashboardPDFCharts.create;
      let tables, charts;
      api.autoTable = function (options) { tables.push(options.body); return originalTable.call(this, options); };
      DashboardPDFCharts.create = function (doc, options) {
        return Object.fromEntries(Object.entries(originalCharts(doc, options)).map(([name, draw]) => [name, box => {
          charts[name] = box; return draw(box);
        }]));
      };
      try {
        const reports = ['ringkas', 'standar', 'lengkap'].map(mode => {
          tables = []; charts = {};
          DashboardPDF.create(result, { mode, generatedAt: '2026-09-06' });
          return { mode, tables, charts };
        });
        // The report remains valid if all tags have zero monetary activity.
        const allZero = { ...result, tags: result.tags.filter(t => ['Tanpa aktivitas', 'Klik saja'].includes(t.tag)) };
        tables = []; charts = {};
        DashboardPDF.create(allZero, { mode: 'lengkap', generatedAt: '2026-09-06' });
        return { reports, emptyCount: charts.decisions.items.reduce((sum, item) => sum + item.count, 0),
          emptyBars: charts.pairedBars.rows.length, unchanged: originalResult === JSON.stringify(result) };
      } finally { api.autoTable = originalTable; DashboardPDFCharts.create = originalCharts; }
    }, activity);
    assert.equal(activityReports.unchanged, true, 'Report filtering must preserve the analysis and source data');
    assert.equal(activityReports.emptyCount, 0);
    assert.equal(activityReports.emptyBars, 0);
    for (const report of activityReports.reports) {
      const contents = JSON.stringify(report.tables);
      for (const tag of ['Tanpa aktivitas', 'Klik saja']) assert.ok(!contents.includes(tag), report.mode + ': omit zero tags from every table, including ad/matching detail');
      for (const tag of ['Organik tetap', 'Refund tetap', 'Pending tetap', 'Biaya tetap']) assert.ok(contents.includes(tag), report.mode + ': keep nonzero cost or real commission for ' + tag);
      assert.equal(report.charts.decisions.items.reduce((sum, item) => sum + item.count, 0), 4);
      assert.deepEqual(report.charts.pairedBars.rows.map(row => row.label).sort(), ['Biaya tetap', 'Organik tetap', 'Pending tetap', 'Refund tetap']);
    }
    console.log('PASS PDF all modes omit zero-activity tags consistently while retaining organic, loss, refund and pending commission');
    if (qaDir) {
      const result = demoFixture();
      assert.equal(result.tags.length, 3);
      assert.equal(result.daily.length, 14);
      const demo = await page.evaluate(result => {
        const doc = window.DashboardPDF.create(result, { mode: 'standar', account: 'Toko Demonstrasi',
          title: 'Contoh laporan affiliate - data sintetis', generatedAt: '2026-08-15T02:00:00Z',
          quality: ['DATA SINTETIS - contoh laporan untuk demonstrasi fitur PDF. Seluruh akun, produk, dan angka pada laporan ini adalah data buatan.'] });
        return { pages: doc.getNumberOfPages(), bytes: doc.output('datauristring').split(',')[1] };
      }, result);
      assert.ok(demo.pages >= 2 && demo.pages <= 8, 'Dashboard, visual pages and full tables must remain readable and compact');
      fs.writeFileSync(path.join(qaDir, 'demo-report.pdf'), Buffer.from(demo.bytes, 'base64'));
      console.log('PASS PDF demo: ' + demo.pages + ' pages, 3 tags, 14 days, synthetic data only');
    }
  } finally { await browser.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
