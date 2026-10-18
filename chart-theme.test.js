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
assert.equal(T.axis('money').ticks.callback(1200000), 'Rp1,2 jt');

// Reference lines are flat, dashed and kept out of tooltips.
const ref = T.reference('Impas 1x', 1, 4, '#999');
assert.deepEqual(ref.data, [1, 1, 1, 1]);
assert.equal(ref.isReference, true);
assert.equal(ref.pointRadius, 0);

console.log('chart theme checks passed');
