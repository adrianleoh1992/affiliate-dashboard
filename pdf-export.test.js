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
      'Tipe Penawaran': index % 2 ? 'Komisi XTRA' : '-',
      'Tipe Pesanan': index % 3 ? 'Pesanan dari Toko yang tidak Dipromosikan' : 'Pesanan Produk dari Toko yang Dipromosikan',
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
      for (const label of ['01  Dashboard utama', 'Komisi Efektif', 'Spend Iklan', 'Laba Bersih', 'ROAS Gabungan',
        'Klik Meta', 'Klik Shopee', 'Klik Hilang', '% Klik Masuk Shopee', 'Rugi di Tag STOP', 'Potensi perbaikan laba', 'Tag belum cukup data']) {
        assert.ok(front.includes(label), 'Front page must include the main dashboard block: ' + label);
      }
      assert.equal(report.cards.filter(card => card.page === 1).length, 16, 'All KPI, click, budget and decision cards must fit on the dashboard page');
      // The headline is effective; the total sits in its note. The PPN used is on page 1 and every footer.
      const at = (label, offset) => front[front.indexOf(label) + offset];
      assert.match(at('Komisi Efektif', 2), /^Total Rp [\d.]+,\d\d \| [\d.]+ pesanan$/);
      assert.equal(at('Spend Iklan', 2), 'Termasuk PPN 11%');
      assert.equal(at('Laba Bersih', 2), 'Komisi efektif - (biaya + PPN 11%)');
      assert.ok(front.some(label => label.startsWith('Periode ') && label.endsWith('|  PPN biaya iklan 11%')), 'header names the PPN');
      for (let page = 1; page <= report.pages; page++) assert.ok(report.labels.some(label => label.page === page
        && label.value.endsWith(' | PPN biaya iklan 11% | Semua nilai uang dalam IDR')), mode + ': footer of page ' + page + ' names the PPN');
      // Page 2: completed commission, its floor ROAS and the cancellation rate, untruncated in 4 columns.
      const second = report.labels.filter(label => label.page === 2).map(label => label.value);
      for (const [label, note] of [['Komisi organik efektif', 'Termasuk Komisi Efektif'], ['Komisi tertunda', '20,00% dari komisi laporan'],
        ['Komisi selesai', 'ROAS hanya selesai 1,19x'], ['Pesanan batal', 'Menurut nilai 0,00%']]) {
        const at = second.indexOf(label);
        assert.ok(at >= 0, 'Page 2 must include ' + label);
        assert.equal(second[at + 2], note, label + ' note must fit its card');
      }
      // The offer row is the whole product commission, not the XTRA component.
      const offerRow = report.bounds.some(cell => cell.kind === 'body' && cell.text.includes('Tipe penawaran (seluruh komisi produk)'));
      const pageText = report.labels.map(label => label.value).join(' ');
      assert.equal(offerRow, mode === 'lengkap', mode + ': offer-type rows belong to the complete report only');
      assert.equal(pageText.includes('bukan besar komisi XTRA'), mode === 'lengkap', mode + ': the offer note travels with its rows');
      for (const card of report.cards) assert.ok(card.x >= 14 && card.x + card.width <= 196.01 && card.y >= 18 && card.y + card.height <= 279,
        'Dashboard cards must remain within page bounds');
      const trend = report.charts[0].box.rows;
      assert.ok(trend.some(row => row.comm != null));
      // The trend is by click date; with what sits before the start or has no
      // click date it adds up to the summary's effective commission.
      assert.ok(Math.abs(trend.reduce((sum, row) => sum + (row.comm || 0), 0) + result.byClick.beforeEff + result.byClick.missingEff
        - result.kpi.commEff) < 0.0001, 'Trend must use effective commission matching the summary');
      assert.ok(second.includes('Komisi efektif (tanggal klik)'), mode + ': the trend legend names its date basis');
      // Concentration: a Pareto table of spend share vs paid effective commission share.
      assert.ok(pageText.includes('Konsentrasi biaya vs komisi'), mode + ': concentration section');
      assert.ok(report.bounds.some(cell => cell.kind === 'head' && cell.text === 'Porsi komisi efektif'));
      assert.ok(report.bounds.some(cell => cell.kind === 'body' && cell.text === '90 tag di luar 10 teratas'), mode + ': the complement row');
      assert.ok(!pageText.includes('Risiko konsentrasi anggaran'), mode + ': the old two-number grid is replaced');
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
      // Direct vs indirect orders, as on the dashboard; products per kind only in the complete report.
      assert.ok(report.bounds.some(cell => cell.kind === 'head' && cell.text === 'Pesanan tidak langsung'), 'Direct/indirect table exported');
      assert.ok(report.bounds.some(cell => cell.kind === 'body' && cell.text === 'Total akun'), 'Direct/indirect account total exported');
      assert.equal(report.bounds.some(cell => cell.kind === 'head' && cell.text === 'Tag / jenis'), mode === 'lengkap', 'Product split only in Lengkap');
      // Every mode carries the per-tag click costs, lost clicks and direct/indirect split.
      for (const h of ['Klik Meta', 'CPC Meta', 'LP view', 'Biaya / LP', 'Klik Shopee', 'CPC Shopee', 'Klik hilang', 'Order langsung', 'Komisi langsung', 'Order tidak langsung', 'Komisi tidak langsung'])
        assert.ok(report.bounds.some(cell => cell.kind === 'head' && cell.text === h), mode + ' per-tag click table column: ' + h);
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
          // The last entry is the Klik Hilang note, which names the per-tag sum and the net.
          return ['Klik Meta', 'Klik Shopee', 'Klik Hilang', '% Klik Masuk Shopee'].map(label => labels[labels.indexOf(label) + 1])
            .concat([labels[labels.indexOf('Klik Hilang') + 2]]);
        });
      } finally { window.jspdf.jsPDF = OriginalPDF; }
    }, [clickSource, { ...clickSource, clicks: [] }, { ...clickSource, ads: [] }]
      .map(source => Engine.analyze(source, { ppn: 0, lagDays: 0 })));
    assert.deepEqual(clickReports[0], ['30', '30', '5', '100,00%', 'Per tag; bersih 0'],
      'Dashboard compares matched tags in the click window; gains on one tag must not offset lost clicks on another');
    assert.deepEqual(clickReports[1], ['3.030', '-', '-', '-', 'Jumlah per tag'], 'Without a click report, show full-period Meta clicks and unavailable comparison metrics');
    assert.deepEqual(clickReports[2], ['-', '-', '-', '-', 'Jumlah per tag'], 'Without ads, a click comparison must remain unavailable');
    console.log('PASS PDF dashboard click scope, per-tag losses and unavailable comparisons');
    // 3 of 40 clicks arrive (7,5%): the dashboard note says "hanya 8%", so the lost share prints 92%, not 93%.
    // 58 of 400 is 14,499…% in floating point: "hanya 14%", so 86%, not 85%.
    const lostLabels = await page.evaluate(result => {
      const OriginalPDF = window.jspdf.jsPDF, labels = [];
      window.jspdf.jsPDF = function (options) {
        const doc = new OriginalPDF(options), originalText = doc.text;
        doc.text = function (value, ...rest) { labels.push(String(value)); return originalText.call(this, value, ...rest); };
        return doc;
      };
      window.jspdf.jsPDF.API = OriginalPDF.API;
      try { DashboardPDF.create(result, { mode: 'ringkas', generatedAt: '2026-09-06' }); return labels; }
      finally { window.jspdf.jsPDF = OriginalPDF; }
    }, Engine.analyze({
      affiliate: ['A', 'B'].map(tag => ({ 'ID Pemesanan': tag, 'Status Pesanan': 'Selesai', 'Waktu Pemesanan': '2026-09-01 10:00:00', 'Tag_link1': tag, 'Total Komisi per Produk(Rp)': '100' })),
      ads: [['A', 40], ['B', 400]].map(([tag, clicks]) => ({ 'Ad name': tag, 'Amount spent (IDR)': '50', 'Reporting starts': '2026-09-01', 'Reporting ends': '2026-09-01', 'Link clicks': String(clicks) })),
      clicks: [['A', 3], ['B', 58]].flatMap(([tag, n]) => Array.from({ length: n }, (_, i) => ({ 'Waktu Klik': '2026-09-01 09:00:' + String(i).padStart(2, '0'), 'Tag_link': tag }))), tagMap: { A: 'A', B: 'B' },
    }, { ppn: 0, lagDays: 0 }));
    assert.ok(lostLabels.includes('92%') && lostLabels.includes('86%'), 'per-tag Klik hilang rounds from the arriving share');
    assert.ok(!lostLabels.includes('93%') && !lostLabels.includes('85%'));
    console.log('PASS PDF per-tag lost clicks round like the dashboard link note');
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
    // Click-date twin: the gap still means "no source row", and commission the
    // trend cannot place is named instead of dropped.
    const clickCoverage = Engine.analyze({
      affiliate: [1, 3, 4].map(day => ({ 'ID Pemesanan': 'click-' + day, 'Status Pesanan': 'Selesai',
        'Waktu Pemesanan': '2026-09-0' + day + ' 10:00:00', 'Waktu Klik': '2026-09-0' + day + ' 09:00:00', 'Tag_link1': 'Coverage',
        'Total Komisi per Produk(Rp)': day === 4 ? '0' : '100' })).concat([{ 'ID Pemesanan': 'click-none', 'Status Pesanan': 'Selesai',
        'Waktu Pemesanan': '2026-09-03 11:00:00', 'Tag_link1': 'Coverage', 'Total Komisi per Produk(Rp)': '40' }]),
      ads: [1, 2, 4].map(day => ({ 'Ad name': 'Coverage', 'Amount spent (IDR)': day === 4 ? '0' : '50',
        'Reporting starts': '2026-09-0' + day, 'Reporting ends': '2026-09-0' + day })), clicks: [],
    }, { ppn: 0, lagDays: 0 });
    const clickTrend = await page.evaluate(result => {
      const OriginalPDF = window.jspdf.jsPDF, originalCharts = DashboardPDFCharts.create, labels = [];
      let trend;
      window.jspdf.jsPDF = function (options) {
        const doc = new OriginalPDF(options), originalText = doc.text;
        doc.text = function (value, ...rest) {
          if (doc.getCurrentPageInfo().pageNumber === 2) labels.push(String(value));
          return originalText.call(this, value, ...rest);
        };
        return doc;
      };
      window.jspdf.jsPDF.API = OriginalPDF.API;
      DashboardPDFCharts.create = function (doc, options) {
        return Object.fromEntries(Object.entries(originalCharts(doc, options)).map(([name, draw]) => [name, box => {
          if (name === 'trend') trend = box; return draw(box);
        }]));
      };
      try { DashboardPDF.create(result, { mode: 'ringkas', generatedAt: '2026-09-06' }); }
      finally { window.jspdf.jsPDF = OriginalPDF; DashboardPDFCharts.create = originalCharts; }
      return { rows: trend.rows.map(row => [row.date, row.comm]), label: trend.commLabel, text: labels.join(' ') };
    }, clickCoverage);
    assert.deepEqual(clickTrend.rows, [['2026-09-01', 100], ['2026-09-02', null], ['2026-09-03', 100], ['2026-09-04', 0]],
      'An ad-only day without click commission stays a gap; a real zero stays a point');
    assert.equal(clickTrend.label, 'Komisi efektif (tanggal klik)');
    assert.match(clickTrend.text, /tanggal klik/);
    assert.match(clickTrend.text, /Rp 40,00 tanpa tanggal klik tidak tampil\./);
    console.log('PASS PDF click-date trend keeps gaps for missing sources and names commission it cannot place');
    // Orders clicked on 09-06 and 09-07 land days later and are still Tertunda: by click date the
    // trend's unripe band starts two days before the order-date lag cut-off.
    const ripeDays = Array.from({ length: 10 }, (_, i) => '2026-09-' + String(i + 1).padStart(2, '0'));
    const ripeOrder = (id, clicked, placed, status) => ({ 'ID Pemesanan': 'ripe-' + id, 'Status Pesanan': status,
      'Waktu Pemesanan': placed + ' 10:00:00', 'Waktu Klik': clicked + ' 09:00:00', 'Tag_link1': 'Ripe',
      'Total Komisi per Produk(Rp)': '100' });
    const ripeSource = {
      affiliate: [...ripeDays.slice(0, 5).map((day, i) => ripeOrder(i, day, day, 'Selesai')),
        ripeOrder(6, '2026-09-06', '2026-09-09', 'Tertunda'), ripeOrder(7, '2026-09-07', '2026-09-10', 'Tertunda')],
      ads: ripeDays.map(day => ({ 'Ad name': 'Ripe', 'Amount spent (IDR)': '50', 'Reporting starts': day, 'Reporting ends': day })), clicks: [],
    };
    const noClickTime = rows => rows.map(row => { const copy = { ...row }; delete copy['Waktu Klik']; return copy; });
    const ripeResults = [ripeSource, { ...ripeSource, affiliate: noClickTime(ripeSource.affiliate) }]
      .map(source => Engine.analyze(source, { ppn: 0, lagDays: 3 }));
    const ripeTrend = await page.evaluate(results => {
      const originalCharts = DashboardPDFCharts.create;
      let trend;
      DashboardPDFCharts.create = function (doc, options) {
        return Object.fromEntries(Object.entries(originalCharts(doc, options)).map(([name, draw]) => [name, box => {
          if (name === 'trend') trend = box; return draw(box);
        }]));
      };
      try { return results.map(result => { DashboardPDF.create(result, { mode: 'ringkas', generatedAt: '2026-09-11' }); return trend.matureUntil; }); }
      finally { DashboardPDFCharts.create = originalCharts; }
    }, ripeResults);
    assert.equal(ripeResults[0].range.matureUntil, '2026-09-07');
    assert.equal(ripeResults[0].byClick.matureUntil, '2026-09-05', 'fixture: the click-date boundary sits before the order-date one');
    assert.equal(ripeTrend[0], ripeResults[0].byClick.matureUntil, 'a click-date trend shades from the click-date boundary');
    assert.equal(ripeResults[1].byClick.available, false);
    assert.equal(ripeTrend[1], ripeResults[1].range.matureUntil, 'without Waktu Klik the trend keeps the order-date boundary');
    console.log('PASS PDF trend shades unripe days from the boundary of its own date basis');
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
    // A Scale at 2,05x sits on its threshold; two paid tags are not judged yet.
    const edgeDays = Array.from({ length: 10 }, (_, i) => '2026-09-' + String(i + 1).padStart(2, '0'));
    const edgeOrder = (tag, date, commission) => ({ 'ID Pemesanan': tag + date, 'Status Pesanan': 'Selesai',
      'Waktu Pemesanan': date + ' 10:00:00', 'Tag_link1': tag, 'Total Komisi per Produk(Rp)': String(commission) });
    const edgeAd = (tag, date, spend) => ({ 'Ad name': tag, 'Amount spent (IDR)': String(spend),
      'Reporting starts': date, 'Reporting ends': date });
    const edge = Engine.analyze({
      affiliate: [...edgeDays.map(date => edgeOrder('Scale205', date, 41000)), edgeOrder('SmallPaid', '2026-09-01', 4000)],
      ads: [...edgeDays.map(date => edgeAd('Scale205', date, 20000)), edgeAd('SmallPaid', '2026-09-01', 7500),
        edgeAd('SmallPaid', '2026-09-02', 7500), edgeAd('NoSuchTag', '2026-09-02', 9000)], clicks: [],
    }, { ppn: 0, lagDays: 3 });
    const edgeReport = await page.evaluate(result => {
      const api = window.jspdf.jsPDF.API, originalTable = api.autoTable, OriginalPDF = window.jspdf.jsPDF;
      const tables = [], front = [];
      api.autoTable = function (options) { tables.push(options.body); return originalTable.call(this, options); };
      window.jspdf.jsPDF = function (options) {
        const doc = new OriginalPDF(options), originalText = doc.text;
        doc.text = function (value, ...rest) {
          if (doc.getCurrentPageInfo().pageNumber === 1) front.push([].concat(value).join(' '));
          return originalText.call(this, value, ...rest);
        };
        return doc;
      };
      window.jspdf.jsPDF.API = OriginalPDF.API;
      try { DashboardPDF.create(result, { mode: 'lengkap', generatedAt: '2026-09-11' }); }
      finally { api.autoTable = originalTable; window.jspdf.jsPDF = OriginalPDF; }
      return { tables, front };
    }, edge);
    const verdictCells = edgeReport.tables.flat().filter(row => row.length === 6).map(row => row[0] + ' = ' + row[1]);
    assert.ok(verdictCells.includes('Scale205 = Scale\ndi batas'), 'near-threshold verdict is marked: ' + verdictCells.join(' | '));
    assert.ok(verdictCells.includes('SmallPaid = Belum cukup data'), 'the PDF names unjudged tags like the dashboard badge');
    const card = edgeReport.front.indexOf('Tag belum cukup data');
    assert.deepEqual(edgeReport.front.slice(card, card + 3), ['Tag belum cukup data', 'Rp -20.000,00', '2 tag | laba efektif']);
    assert.ok(edgeReport.front.join(' ').includes('2 tag berbiaya belum cukup data (biaya Rp 24.000,00)'), 'page-1 note counts paid unjudged tags');
    console.log('PASS PDF unjudged paid tags get their own card and near-threshold verdicts read "di batas"');
    // Cancelled rows report the lost order value (refund + purchase value), not their zero commission.
    const cancelOrder = (id, status, extra = {}) => ({ 'ID Pemesanan': id, 'Status Pesanan': status,
      'Waktu Pemesanan': '2026-09-01 10:00:00', 'Tag_link1': 'Batal', 'Total Komisi per Produk(Rp)': status === 'Selesai' ? '100' : '0',
      'Nilai Pembelian(Rp)': '1000', ...extra });
    const cancelText = await page.evaluate(result => {
      const OriginalPDF = window.jspdf.jsPDF, lines = [];
      window.jspdf.jsPDF = function (options) {
        const doc = new OriginalPDF(options), originalText = doc.text;
        doc.text = function (value, ...rest) { lines.push([].concat(value).join(' ')); return originalText.call(this, value, ...rest); };
        return doc;
      };
      window.jspdf.jsPDF.API = OriginalPDF.API;
      try { DashboardPDF.create(result, { mode: 'ringkas', generatedAt: '2026-09-06' }); }
      finally { window.jspdf.jsPDF = OriginalPDF; }
      return lines.join(' ');
    }, Engine.analyze({ affiliate: [cancelOrder('ok', 'Selesai'),
      cancelOrder('c1', 'Dibatalkan', { 'Nilai Pembelian(Rp)': '0', 'Jumlah Pengembalian Dana(Rp)': '80000' }),
      cancelOrder('c2', 'Dibatalkan', { 'Nilai Pembelian(Rp)': '20000' }), cancelOrder('c2', 'Dibatalkan', { 'Nilai Pembelian(Rp)': '5000' }),
      cancelOrder('u1', 'Belum Dibayar')] }, { ppn: 0, lagDays: 0 }));
    assert.ok(cancelText.includes('Dikecualikan: 3 baris batal (2 pesanan, nilai pesanan Rp 105.000,00; terbesar Rp 80.000,00) dan 1 baris belum dibayar.'), cancelText);
    assert.ok(cancelText.includes('Pesanan batal 66,67% Menurut nilai 99,06%'), 'page 2 shows the cancellation rate by order and by value');
    console.log('PASS PDF cancelled orders carry their order value and rate');
    // adrian's Meta invoices carry no PPN, so there are no PPN what-if cards; at 0% the notes say so plainly.
    const ppnText = await page.evaluate(results => {
      const OriginalPDF = window.jspdf.jsPDF;
      let lines;
      window.jspdf.jsPDF = function (options) {
        const doc = new OriginalPDF(options), originalText = doc.text;
        doc.text = function (value, ...rest) { lines.push([].concat(value).join(' ')); return originalText.call(this, value, ...rest); };
        return doc;
      };
      window.jspdf.jsPDF.API = OriginalPDF.API;
      try { return results.map(result => { lines = []; DashboardPDF.create(result, { mode: 'ringkas', generatedAt: '2026-09-06' }); return lines; }); }
      finally { window.jspdf.jsPDF = OriginalPDF; }
    }, [{ ads: [] }, {}].map(extra => Engine.analyze({ ...clickSource, ...extra }, { ppn: 0, lagDays: 0 })));
    for (const lines of ppnText) assert.ok(!lines.some(line => /Laba bila PPN|invoice Meta/.test(line)), 'no PPN what-if cards');
    assert.ok(ppnText[1].includes('Tanpa PPN'));
    assert.ok(ppnText[1].includes('Komisi efektif - biaya iklan'));
    assert.ok(ppnText[1].some(line => line.endsWith(' | PPN biaya iklan 0% | Semua nilai uang dalam IDR')));
    console.log('PASS PDF names the PPN on every page without a PPN what-if');
    // Must-scale account: 54 STOP tags losing Rp 165.000 each (Rp 9,72 jt gross STOP spend), three
    // overbid PANTAU tags and a leaking link inside and outside STOP. Tag names are short, so any
    // '...' on page 1 is a card note that did not fit the 4-column grid.
    const scaleDate = '2026-09-01';
    // [tag, spend, commission, Meta link clicks, Shopee clicks]
    const scaleSpecs = [
      ...Array.from({ length: 53 }, (_, i) => ['Stop ' + String(i + 1).padStart(2, '0'), 180000, 15000, 0, 0]),
      ['Stop Bocor', 180000, 15000, 400, 0],    // STOP; none of 400 clicks arrive
      ['Scale Bocor', 250000, 750000, 500, 50], // SCALE; 10% of 500 clicks arrive
      ['Sedikit', 100000, 300000, 120, 12],     // also 10%, but 120 clicks is under the 300-click floor
      ...[1, 2, 3].map(i => ['Bid ' + i, 100000, 144000, 200, 190]), // ROAS 1,44: PANTAU paying above its ideal CPC
    ];
    const mustScale = Engine.analyze({
      affiliate: scaleSpecs.map(([tag, , commission], index) => ({ 'ID Pemesanan': 'scale-' + index, 'Status Pesanan': 'Selesai',
        'Waktu Pemesanan': scaleDate + ' 10:00:00', 'Waktu Klik': scaleDate + ' 09:00:00', 'Tag_link1': tag,
        'Total Komisi per Produk(Rp)': String(commission) })),
      ads: scaleSpecs.map(([tag, spend, , meta]) => ({ 'Ad name': tag, 'Amount spent (IDR)': String(spend),
        'Reporting starts': scaleDate, 'Reporting ends': scaleDate, 'Link clicks': String(meta), 'Ad delivery': 'active' })),
      clicks: scaleSpecs.flatMap(([tag, , , , shopee]) => Array.from({ length: shopee }, () => ({
        'Waktu Klik': scaleDate + ' 09:00:00', 'Tag_link': tag }))),
    }, { ppn: 0, lagDays: 0, minDays: 1 });
    const act = mustScale.actions, scaleLeak = tag => mustScale.tags.find(t => t.tag === tag).leak;
    assert.equal(act.stopCount, 54);
    assert.equal(act.overbidCount, 3);
    assert.deepEqual([act.stopLoss, act.stopSpend, act.bidSaving, act.maxGain, act.reclaimable], [8910000, 9720000, 60000, 8970000, 9780000],
      'fixture: STOP tags still earn, so the loss (and maxGain) differ from the gross spend (and reclaimable)');
    assert.deepEqual([act.leakStopCount, act.leakLiveCount, mustScale.kpi.leakTags], [1, 1, 2], 'fixture: one leaking link inside STOP, one outside');
    assert.deepEqual([act.leakWasteLive, act.leakWaste], [225000, 405000]);
    assert.deepEqual([scaleLeak('Sedikit').severity, scaleLeak('Sedikit').reliable], ['bad', false], 'fixture: under 25% but too few clicks to judge');
    const scaleReport = await page.evaluate(result => {
      const api = window.jspdf.jsPDF.API, originalTable = api.autoTable, OriginalPDF = window.jspdf.jsPDF;
      const tables = [], front = [];
      api.autoTable = function (options) { tables.push({ head: options.head[0], body: options.body }); return originalTable.call(this, options); };
      window.jspdf.jsPDF = function (options) {
        const doc = new OriginalPDF(options), originalText = doc.text;
        doc.text = function (value, ...rest) {
          if (doc.getCurrentPageInfo().pageNumber === 1) front.push([].concat(value).join(' '));
          return originalText.call(this, value, ...rest);
        };
        return doc;
      };
      window.jspdf.jsPDF.API = OriginalPDF.API;
      try { DashboardPDF.create(result, { mode: 'lengkap', generatedAt: '2026-09-02' }); }
      finally { api.autoTable = originalTable; window.jspdf.jsPDF = OriginalPDF; }
      return { tables, front };
    }, mustScale);
    const cutOff = scaleReport.front.filter(label => label.endsWith('...'));
    assert.deepEqual(cutOff, [], 'page-1 cards must not be truncated at 54 STOP tags and Rp 9,72 jt: ' + cutOff.join(' | '));
    const scaleCard = label => scaleReport.front.slice(scaleReport.front.indexOf(label) + 1, scaleReport.front.indexOf(label) + 3);
    assert.deepEqual(scaleCard('Rugi di Tag STOP'), ['Rp 8.910.000,00', '54 tag'], 'the STOP card quotes actions.stopLoss, not the gross stopSpend');
    assert.deepEqual(scaleCard('Potensi perbaikan laba'), ['Rp 8.970.000,00', 'Batas atas: bid + rugi STOP'],
      'the card quotes actions.maxGain, not the legacy reclaimable budget');
    const priority = Object.fromEntries(scaleReport.tables.find(t => t.head[0] === 'Periksa').body.map(row => [row[0], row.slice(1)]));
    assert.equal(priority['Tag berstatus Stop'][0], '54');
    assert.ok(priority['Tag berstatus Stop'][1].startsWith('Rp 8.910.000,00 rugi | '), 'the Stop row leads with the loss: ' + priority['Tag berstatus Stop'][1]);
    assert.ok(priority['Tag berstatus Stop'][1].includes('biaya Rp 9.720.000,00 | 1 tag cek link dulu'), 'gross STOP spend, off the page-1 card, stays in this row');
    // The leaking STOP tag is already in the Stop row; this row claims only the live one.
    assert.deepEqual(priority['Link perlu dicek (di luar Stop)'], ['1', 'Rp 225.000,00 biaya klik kurang (maks.)'],
      'the link row uses leakLiveCount and leakWasteLive, not the all-tag totals');
    const masuk = Object.fromEntries(scaleReport.tables.find(t => t.head[4] === 'Masuk').body.map(row => [row[0], row[4]]));
    assert.equal(masuk['Sedikit'], '10,00%\ndata sedikit', 'under 300 Meta clicks a low arrival rate is not a link verdict');
    assert.equal(masuk['Scale Bocor'], '10,00%\ncek link');
    assert.equal(masuk['Stop Bocor'], '0,00%\ncek link');
    console.log('PASS PDF must-scale cards fit page 1; STOP loss, maxGain and live link money match Prioritas tindakan and the leak table');
    // Large money values in the per-tag click table shrink to fit instead of wrapping:
    // "Rp 1.500.000" split over two lines reads as Rp1.500.
    const wide = await page.evaluate(result => {
      const big = JSON.parse(JSON.stringify(result));
      const t = big.tags.find(x => x.spend > 0) || big.tags[0];
      Object.assign(t, { tag: 'Tag dengan nama yang cukup panjang', clicks: 123456, cpc: 13889, lpv: 98765, cpLpv: 1500000, shopeeClicks: 54321, cpcShopee: 27778, winSpend: 9e8, lostTotal: 92.4 });
      t.attr = { direct: { orders: 12345, comm: 2500000 }, indirect: { orders: 23456, comm: 12345678 }, unknown: { orders: 0, comm: 0 } };
      big.attribution = { column: 'Tipe Pesanan', total: { direct: t.attr.direct, indirect: t.attr.indirect, unknown: t.attr.unknown, mixed: 0 } };
      big.range = { ...big.range, clickStart: big.range.start, clickEnd: big.range.end };
      const api = window.jspdf.jsPDF.API, originalTable = api.autoTable, cells = [];
      api.autoTable = function (options) {
        if (options.head[0].includes('Biaya / LP')) options.didDrawCell = data => { if (data.section === 'body') cells.push(data.cell.text); };
        return originalTable.call(this, options);
      };
      try { DashboardPDF.create(big, { mode: 'ringkas', generatedAt: '2026-09-06' }); }
      finally { api.autoTable = originalTable; }
      return cells;
    }, activity);
    assert.ok(wide.length > 0, 'per-tag click table drawn');
    const wrapped = wide.filter((lines, i) => i % 12 !== 0 && lines.length > 1);
    assert.deepEqual(wrapped, [], 'every value in the per-tag click table stays on one line');
    assert.ok(wide.some(lines => lines[0] === 'Rp 1.500.000'), 'large money value printed whole');
    console.log('PASS PDF per-tag click table keeps large money values on one line');
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
