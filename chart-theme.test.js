'use strict';

// Pure formatting and option merging behind every on-screen chart.
const assert = require('node:assert/strict');
const T = require('./chart-theme');

// Nested chart options add to the defaults instead of replacing whole blocks.
const merged = T.merge({ scales: { x: { grid: { display: false } }, y: { ticks: { color: 'a' } } } },
  { scales: { y: { beginAtZero: true }, y1: { position: 'right' } } });
assert.deepEqual(merged.scales.x, { grid: { display: false } }, 'x axis survives a y-only override');
assert.deepEqual(merged.scales.y, { ticks: { color: 'a' }, beginAtZero: true });
assert.equal(merged.scales.y1.position, 'right');
assert.deepEqual(T.merge({ a: [1, 2] }, { a: [3] }).a, [3], 'arrays are replaced');

// Indonesian decimals: comma for the fraction, so they never read as thousands.
assert.equal(T.money(1250000), 'Rp1,3 jt');
assert.equal(T.money(26100000), 'Rp26 jt');
assert.equal(T.money(-761000), '-Rp761rb');
assert.equal(T.money(900), 'Rp900');
assert.equal(T.money(2.5e9), 'Rp2,5 M');
assert.equal(T.money(null), '—');
assert.equal(T.count(33605), '33.605');
assert.equal(T.ratio(1.4321), '1,43x');
assert.equal(T.pct(22.14), '22,1%');
assert.equal(T.pct(90), '90%');

// Axis ticks drop trailing zeros.
const tick = T.axis('ratio').ticks.callback;
assert.equal(tick(2), '2x');
assert.equal(tick(0.5), '0,5x');
const moneyTick = T.axis('money').ticks.callback;
assert.equal(moneyTick(1200000), 'Rp1,2 jt');
assert.equal(moneyTick(1000000), 'Rp1 jt');
assert.deepEqual([1500, 2000, 2500].map(moneyTick), ['Rp1,5rb', 'Rp2rb', 'Rp2,5rb'], 'small money steps keep distinct labels');
assert.equal(moneyTick(-12500000), '-Rp12,5 jt');

// Count axes only step in whole numbers, so 0,5 order never reads as "1".
assert.equal(T.axis('count').ticks.precision, 0);
assert.equal(T.axis('count', { ticks: { color: 'a' } }).ticks.precision, 0, 'extra tick options keep whole steps');
assert.equal(T.axis('money').ticks.precision, undefined);

// Reference lines are flat, dashed and kept out of tooltips.
const ref = T.reference('Impas 1x', 1, 4, '#999');
assert.deepEqual(ref.data, [1, 1, 1, 1]);
assert.equal(ref.isReference, true);
assert.equal(ref.pointRadius, 0);

// A one-day chart still shows its reference line, drawn across the plot.
function drawn(datasets, visible = () => true) {
  const calls = [];
  const ctx = { save() {}, restore() {}, beginPath() {}, stroke() { calls.push('stroke'); }, setLineDash(d) { calls.push(['dash', d]); },
    moveTo(x, y) { calls.push(['move', x, y]); }, lineTo(x, y) { calls.push(['line', x, y]); } };
  T.singleReference.afterDatasetsDraw({ ctx, chartArea: { left: 10, right: 310 }, data: { datasets },
    scales: { y: { getPixelForValue: value => 200 - value * 50 } }, isDatasetVisible: visible });
  return calls;
}
const one = drawn([{ data: [3] }, T.reference('Impas 1x', 1, 1, '#999')]);
assert.deepEqual(one.filter(Array.isArray).filter(c => c[0] !== 'dash'), [['move', 10, 150], ['line', 310, 150]]);
assert.equal(drawn([T.reference('Impas 1x', 1, 2, '#999')]).length, 0, 'longer lines are drawn by Chart.js itself');
assert.equal(drawn([T.reference('Impas 1x', 1, 1, '#999')], () => false).length, 0, 'a hidden reference stays hidden');

// The not-yet-mature band starts half a step before its first day and runs to
// the right edge; it is drawn before the grid so gridlines stay visible.
function band(from, n, text, textWidth = 60) {
  const calls = [];
  const ctx = { save() {}, restore() {}, fillRect(...a) { calls.push(['rect', ...a]); }, fillText(t, x, y) { calls.push(['text', t, x, y]); },
    measureText: () => ({ width: textWidth }) };
  const plugin = T.recentBand(from, '#eee', text);
  plugin.beforeDraw({ ctx, chartArea: { left: 40, right: 340, top: 10, bottom: 210 }, data: { labels: Array(n).fill('x') },
    scales: { x: { getPixelForValue: i => 55 + i * 30 } }, options: { font: { family: 'Test' } } });
  return { plugin, calls };
}
global.document = { documentElement: {} };
global.getComputedStyle = () => ({ getPropertyValue: () => '#999' });
const b = band(7, 10);
assert.equal(b.plugin.id, 'recentBand');
assert.equal(typeof b.plugin.beforeDraw, 'function', 'drawn under the grid, not over the data');
assert.deepEqual(b.calls, [['rect', 55 + 7 * 30 - 15, 10, 340 - (55 + 7 * 30 - 15), 200]]);
assert.deepEqual(band(0, 10).calls[0].slice(0, 2), ['rect', 40], 'clamped to the plot area');
assert.deepEqual(band(-1, 10).calls, [], 'every day mature: nothing drawn');
assert.deepEqual(band(10, 10).calls, [], 'an index past the last day draws nothing');
assert.deepEqual(band(undefined, 10).calls, []);
const labelled = band(5, 10, 'belum matang');
assert.deepEqual(labelled.calls[1], ['text', 'belum matang', 55 + 5 * 30 - 15 + 4, 14]);
assert.equal(band(9, 10, 'belum matang').calls.length, 1, 'a label wider than the band is left out');

console.log('chart theme checks passed');
