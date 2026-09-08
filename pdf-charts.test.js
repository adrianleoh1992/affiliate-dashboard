'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { jsPDF } = require('./vendor/jspdf.umd.min.js');
const Charts = require('./pdf-charts');

// A recording document exposes geometry independently of PDF serialization.
class RecordingDocument {
  constructor() { this.ops = []; this.size = 8; this.drawColor = []; this.fillColor = []; }
  setFont() { return this; }
  setFontSize(size) { this.size = size; return this; }
  setTextColor(...color) { this.textColor = color; return this; }
  setDrawColor(...color) { this.drawColor = color; return this; }
  setFillColor(...color) { this.fillColor = color; return this; }
  setLineWidth(width) { assert.ok(Number.isFinite(width)); return this; }
  getTextWidth(value) { return Array.from(String(value)).length * this.size * 0.15; }
  splitTextToSize(value, width) {
    const lines = [], max = Math.max(1, Math.floor(width / (this.size * 0.15)));
    const chars = Array.from(String(value));
    for (let index = 0; index < chars.length; index += max) lines.push(chars.slice(index, index + max).join(''));
    return lines;
  }
  text(value, x, y, options = {}) {
    const width = this.getTextWidth(value), offset = options.align === 'right' ? width : options.align === 'center' ? width / 2 : 0;
    this.ops.push({ kind: 'text', value: String(value), x: x - offset, y, width, size: this.size }); return this;
  }
  line(x1, y1, x2, y2) {
    this.ops.push({ kind: 'line', x1, y1, x2, y2, color: [...this.drawColor] }); return this;
  }
  rect(x, y, width, height) {
    this.ops.push({ kind: 'rect', x, y, width, height, color: [...this.fillColor] }); return this;
  }
  circle(x, y, radius) { this.ops.push({ kind: 'circle', x, y, radius }); return this; }
}

let count = 0;
function test(name, check) {
  try { check(); count++; process.stdout.write('✓ ' + name + '\n'); }
  catch (error) { process.stderr.write('✗ ' + name + '\n'); throw error; }
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.freeze(value); Object.values(value).forEach(freeze); }
  return value;
}
function within(doc, box) {
  const epsilon = 0.001;
  for (const op of doc.ops) {
    for (const value of Object.values(op)) if (typeof value === 'number') assert.ok(Number.isFinite(value), JSON.stringify(op));
    if (op.kind === 'line') {
      for (const x of [op.x1, op.x2]) assert.ok(x >= box.x - epsilon && x <= box.x + box.width + epsilon, JSON.stringify(op));
      for (const y of [op.y1, op.y2]) assert.ok(y >= box.y - epsilon && y <= box.y + box.height + epsilon, JSON.stringify(op));
    } else {
      const radius = op.radius || 0;
      assert.ok(op.x - radius >= box.x - epsilon && op.x + (op.width || radius) <= box.x + box.width + epsilon, JSON.stringify(op));
      assert.ok(op.y - radius >= box.y - epsilon && op.y + (op.height || radius) <= box.y + box.height + epsilon, JSON.stringify(op));
      if (op.kind === 'rect') assert.ok(op.width >= 0 && op.height >= 0, JSON.stringify(op));
    }
  }
}

test('currency abbreviations retain sign, currency and scale', () => {
  assert.equal(Charts.shortMoney(1250000), 'Rp 1,3 jt');
  assert.equal(Charts.shortMoney(-1200), 'Rp -1,2 rb');
  assert.equal(Charts.shortMoney(0), 'Rp 0');
  assert.equal(Charts.shortMoney(null), '-');
  assert.equal(Charts.shortMoney(Infinity), '-');
});

test('numbers on colored bars use readable contrast for amber, gray, orange and teal', () => {
  assert.deepEqual(Charts.contrastingText([187, 139, 34]), [0, 0, 0]);
  assert.deepEqual(Charts.contrastingText([131, 143, 151]), [0, 0, 0]);
  assert.deepEqual(Charts.contrastingText([210, 112, 64]), [0, 0, 0]);
  assert.deepEqual(Charts.contrastingText([16, 111, 107]), [255, 255, 255]);
});

test('scales include zero and round positive and negative extents to readable ticks', () => {
  assert.deepEqual(Charts.numberDomain([1230000]), { min: 0, max: 1500000, ticks: [0, 500000, 1000000, 1500000] });
  assert.deepEqual(Charts.numberDomain([-1230000]), { min: -1500000, max: 0, ticks: [-1500000, -1000000, -500000, 0] });
  for (const values of [[-100, 250], [0, 0], [], [null, NaN, Infinity], [-0.02, 0.03], [-8e307, 8e307], [Number.MIN_VALUE]]) {
    const domain = Charts.numberDomain(values);
    assert.ok(domain.min <= 0 && domain.max >= 0 && domain.max > domain.min);
    assert.ok(domain.ticks.length >= 2 && domain.ticks.length <= 10);
    domain.ticks.forEach(tick => assert.ok(Number.isFinite(tick)));
    values.filter(value => typeof value === 'number' && Number.isFinite(value))
      .forEach(value => assert.ok(value >= domain.min && value <= domain.max));
  }
});

test('dates reject invalid calendar days and retain elapsed-day proportions', () => {
  assert.equal(Charts.dateDay('2026-02-30'), null);
  assert.equal(Charts.dateDay('07/09/2026'), null);
  const rows = freeze([
    { date: '2026-09-08', spend: 30, comm: 40 },
    { date: '2026-09-01', spend: 10, comm: 20 },
    { date: '2026-09-02', spend: 15, comm: 25 },
    { date: '2026-09-99', spend: 999, comm: 999 },
  ]);
  const trend = Charts.prepareTrend(rows);
  assert.deepEqual(trend.points.map(point => point.date), ['2026-09-01', '2026-09-02', '2026-09-08']);
  assert.deepEqual(trend.points.map(point => point.position), [0, 1 / 7, 1]);
  assert.deepEqual(trend.segments.spend.map(segment => segment.length), [2, 1]);
  assert.equal(rows[0].date, '2026-09-08', 'Preparing chart must not sort the original analysis');
});

test('missing values break each line independently while real zero remains a point', () => {
  const trend = Charts.prepareTrend([
    { date: '2026-09-01', spend: 10, comm: 20 },
    { date: '2026-09-02', spend: null, comm: 0 },
    { date: '2026-09-03', spend: 30, comm: undefined },
    { date: '2026-09-04', spend: 40, comm: -10 },
  ]);
  assert.deepEqual(trend.segments.spend.map(segment => segment.length), [1, 2]);
  assert.deepEqual(trend.segments.comm.map(segment => segment.length), [2, 1]);
  assert.equal(trend.segments.comm[0][1].comm, 0);
});

test('trend draws consecutive segments only and shows the recent-date region', () => {
  const doc = new RecordingDocument(), box = { x: 14, y: 20, width: 182, height: 76 };
  const model = Charts.create(doc).trend({ ...box, matureUntil: '2026-09-02', rows: [
    { date: '2026-09-01', spend: 150000, comm: 200000 },
    { date: '2026-09-02', spend: 160000, comm: 0 },
    { date: '2026-09-04', spend: 170000, comm: 220000 },
  ] });
  within(doc, box);
  const seriesLines = doc.ops.filter(op => op.kind === 'line' && op.color.join() === '210,112,64');
  assert.equal(seriesLines.length, 2, 'One legend stroke and only one connected spend segment');
  assert.equal(model.segments.spend.length, 2);
  assert.ok(doc.ops.some(op => op.kind === 'text' && op.value === 'Belum matang'));
  const region = doc.ops.find(op => op.kind === 'rect' && op.height > 6 && op.color.join() === '249,244,236');
  assert.ok(region && region.width > 0 && region.width < box.width);
  assert.ok(doc.ops.some(op => op.kind === 'text' && op.value === 'Rp ribu'));
});

test('one-day, empty, all-zero and negative trends never create invalid geometry', () => {
  for (const rows of [[], [{ date: '2026-09-01', spend: null, comm: null }],
    [{ date: '2026-09-01', spend: 0, comm: 0 }], [{ date: '2026-09-01', spend: 10, comm: -20 }],
    [{ date: '2026-09-01', spend: 0.02, comm: 0.03 }]]) {
    const doc = new RecordingDocument(), box = { x: 14, y: 20, width: 182, height: 76 };
    Charts.create(doc).trend({ ...box, matureUntil: '2026-08-31', rows }); within(doc, box);
    if (rows.length && rows[0].spend != null) {
      const dots = doc.ops.filter(op => op.kind === 'circle');
      assert.equal(dots.length, 2); assert.equal(dots[0].x, box.x + 18 + (box.width - 23) / 2);
    }
  }
});

test('paired bars share a true zero origin, including negative commission', () => {
  const doc = new RecordingDocument(), box = { x: 14, y: 20, width: 182, height: 93 };
  const result = Charts.create(doc).pairedBars({ ...box, rows: [
    { label: 'Tag untung', left: 100000, right: 300000 },
    { label: 'Tag refund', left: 150000, right: -100000 },
  ] });
  within(doc, box);
  const bars = doc.ops.filter(op => op.kind === 'rect');
  assert.equal(bars.length, 4);
  assert.ok(bars.slice(0, 3).every(bar => Math.abs(bar.x - result.origin) < 0.001));
  assert.ok(bars[3].x < result.origin);
  assert.ok(Math.abs(bars[3].x + bars[3].width - result.origin) < 0.001);
});

test('paired bars retain all supplied categories, shorten long names explicitly and distinguish null from zero', () => {
  const doc = new RecordingDocument(), box = { x: 14, y: 20, width: 182, height: 93 };
  const rows = freeze(Array.from({ length: 6 }, (_, index) => ({
    label: index ? 'Tag ' + index : 'Kategori dengan nama sangat panjang untuk menguji batas label dua baris dan penanda pemotongan',
    left: index ? index * 1000 : 0, right: index ? null : 5000,
  })));
  const result = Charts.create(doc).pairedBars({ ...box, rows }); within(doc, box);
  assert.equal(result.rows.length, 6);
  assert.ok(doc.ops.some(op => op.kind === 'text' && op.value.endsWith('...')));
  assert.equal(doc.ops.filter(op => op.kind === 'text' && op.value === '-').length, 5);
  assert.ok(doc.ops.some(op => op.kind === 'text' && op.value === '0'));
  assert.equal(rows[0].label.length > 80, true);
});

test('paired bars handle no rows, all zero, all missing and only negative values', () => {
  for (const rows of [[], [{ label: 'Nol', left: 0, right: 0 }], [{ label: 'Kosong', left: null, right: NaN }],
    [{ label: 'Refund', left: -1000, right: -5000 }]]) {
    const doc = new RecordingDocument(), box = { x: 14, y: 20, width: 182, height: 93 };
    Charts.create(doc).pairedBars({ ...box, rows }); within(doc, box);
  }
});

test('decision diagram preserves every category and counts, with proportional segments', () => {
  const doc = new RecordingDocument(), box = { x: 14, y: 20, width: 182, height: 35 };
  const items = freeze([
    { label: 'SCALE', count: 4, color: [16, 111, 107] },
    { label: 'PANTAU', count: 2, color: [42, 107, 162] },
    { label: 'STOP', count: 1, color: [169, 50, 53] },
    { label: 'DATA KURANG', count: 0, color: [180, 150, 90] },
    { label: 'ORGANIK', count: 3, color: [111, 101, 144] },
  ]);
  const result = Charts.create(doc).decisions({ ...box, items }); within(doc, box);
  assert.equal(result.total, 10);
  assert.equal(result.items.length, 5);
  const segments = doc.ops.filter(op => op.kind === 'rect' && op.height === 6).slice(1);
  assert.deepEqual(segments.map(op => Number((op.width / box.width).toFixed(3))), [0.4, 0.2, 0.1, 0.3]);
  assert.ok(doc.ops.some(op => op.kind === 'text' && op.value === 'DATA KURANG'));
  assert.ok(doc.ops.some(op => op.kind === 'text' && op.value === '0'));
});

test('empty decision totals stay readable without division by zero', () => {
  const doc = new RecordingDocument(), box = { x: 14, y: 20, width: 182, height: 35 };
  const result = Charts.create(doc).decisions({ ...box, items: [
    { label: 'SCALE', count: 0 }, { label: 'STOP', count: NaN },
  ] });
  within(doc, box); assert.equal(result.total, 0);
  assert.ok(doc.ops.some(op => op.kind === 'text' && op.value === 'Belum ada tag'));
});

test('caller text sanitizer is applied to chart labels without changing source input', () => {
  const doc = new RecordingDocument(), box = { x: 14, y: 20, width: 182, height: 93 };
  const rows = freeze([{ label: 'Produk 東京', left: 1000, right: 2000 }]);
  Charts.create(doc, { text: value => String(value).replace('東京', '[CJK]') }).pairedBars({ ...box, rows });
  assert.ok(doc.ops.some(op => op.kind === 'text' && op.value.includes('[CJK]')));
  assert.equal(rows[0].label, 'Produk 東京');
});

test('actual jsPDF output contains vectors and selectable labels without raster images', () => {
  const doc = new jsPDF({ unit: 'mm', format: 'a4', compress: false });
  const charts = Charts.create(doc);
  charts.trend({ x: 14, y: 20, width: 182, height: 76, matureUntil: '2026-09-04', rows: [
    { date: '2026-09-01', spend: 150000, comm: 200000 },
    { date: '2026-09-02', spend: 180000, comm: 140000 },
    { date: '2026-09-03', spend: 100000, comm: null },
    { date: '2026-09-04', spend: 190000, comm: 230000 },
    { date: '2026-09-05', spend: 140000, comm: 160000 },
    { date: '2026-09-07', spend: 170000, comm: 260000 },
  ] });
  charts.pairedBars({ x: 14, y: 108, width: 182, height: 93, rows: [
    { label: 'Skincare harian', left: 850000, right: 1300000 },
    { label: 'Peralatan dapur', left: 670000, right: 980000 },
    { label: 'Aksesori ponsel', left: 560000, right: 400000 },
    { label: 'Kategori produk dengan nama yang cukup panjang hingga membutuhkan dua baris atau lebih', left: 420000, right: -80000 },
    { label: 'Tag tanpa komisi', left: 280000, right: 0 },
    { label: 'Tag organik', left: 0, right: 160000 },
  ] });
  charts.decisions({ x: 14, y: 213, width: 182, height: 35, items: [
    { label: 'SCALE', count: 14, color: [16, 111, 107] }, { label: 'PANTAU', count: 8, color: [42, 107, 162] },
    { label: 'STOP', count: 4, color: [169, 50, 53] }, { label: 'DATA KURANG', count: 0, color: [180, 150, 90] },
    { label: 'ORGANIK', count: 10, color: [111, 101, 144] },
  ] });
  const output = doc.output();
  assert.ok(output.startsWith('%PDF-'));
  assert.ok(output.includes('(Biaya + PPN)'));
  assert.ok(output.includes('(Komisi efektif)'));
  assert.ok(output.includes('(Belum matang)'));
  assert.ok(!/\b(?:NaN|Infinity)\b/.test(output));
  assert.ok(!output.includes('/Subtype /Image'), 'Charts must remain sharp at any zoom');
  if (process.env.PDF_CHART_QA_DIR) {
    fs.mkdirSync(process.env.PDF_CHART_QA_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.PDF_CHART_QA_DIR, 'vector-charts.pdf'), Buffer.from(doc.output('arraybuffer')));
  }
});

process.stdout.write('\n' + count + ' PDF chart checks passed.\n');
