'use strict';
// Compare a checked-in baseline against the working engine on deterministic
// exports. Usage: node scripts/benchmark-engine.js [baseline-git-ref]
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const Module = require('node:module');
const { performance } = require('node:perf_hooks');
const path = require('node:path');

const repo = path.resolve(__dirname, '..');
const revision = process.argv[2] || 'HEAD';
const source = execFileSync('git', ['show', `${revision}:engine.js`], { cwd: repo, encoding: 'utf8' });
const baselinePath = path.join(repo, 'baseline-engine.js');
const baseline = new Module(baselinePath);
baseline._compile(source, baselinePath);
const engines = { baseline: baseline.exports, updated: require('../engine.js') };
const options = { ppn: 11, minSpend: 0, minDays: 1, lagDays: 0 };

function fixture(tagCount) {
  const data = { affiliate: [], ads: [], clicks: [] };
  const date = i => `2026-08-${String(Math.floor(i / tagCount) % 25 + 1).padStart(2, '0')}`;
  for (let i = 0; i < 4000; i++) data.affiliate.push({
    'ID Pemesanan': String(i), 'Status Pesanan': i % 5 ? 'Selesai' : 'Tertunda',
    'Waktu Pemesanan': date(i) + ' 10:00:00', 'Waktu Klik': date(i) + ' 09:00:00',
    'Total Komisi per Produk(Rp)': '150', 'Total Komisi per Pesanan(Rp)': '150',
    'Nilai Pembelian(Rp)': '1000', 'Jumlah': '1',
    'Tag_link1': 'Product' + i % tagCount, 'Nama Barang': 'Product' + i % tagCount,
  });
  for (let i = 0; i < 5000; i++) data.ads.push({
    'Reporting starts': date(i), 'Ad name': 'Product ' + i % tagCount,
    'Amount spent (IDR)': '100', 'Link clicks': '10', 'Impressions': '1000', 'Ad delivery': 'active',
  });
  for (let i = 0; i < 1000; i++) data.clicks.push({
    'Waktu Klik': date(i) + ' 09:00:00', 'Tag_link': 'Product' + i % tagCount,
  });
  return data;
}
function median(values) { return values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)]; }

for (const tagCount of [100, 500]) {
  const data = fixture(tagCount), timing = { baseline: [], updated: [] }, result = {};
  // Alternate execution order to reduce JIT/thermal bias. Discard five warmup
  // pairs, then report the median of 21 runs. No flaky speed assertion in CI.
  for (let iteration = 0; iteration < 26; iteration++) {
    for (const name of iteration % 2 ? ['updated', 'baseline'] : ['baseline', 'updated']) {
      const start = performance.now();
      result[name] = engines[name].analyze(data, options);
      const elapsed = performance.now() - start;
      if (iteration >= 5) timing[name].push(elapsed);
    }
  }
  // Confirm the optimization preserves source totals on this fixture.
  for (const key of ['spend', 'comm', 'commEff', 'clicks', 'orders']) {
    assert.ok(Math.abs(result.baseline.kpi[key] - result.updated.kpi[key]) < 1e-6, key);
  }
  const before = median(timing.baseline), after = median(timing.updated);
  console.log(JSON.stringify({ rows: 10000, tags: tagCount, baseline: revision,
    baselineMedianMs: +before.toFixed(2), updatedMedianMs: +after.toFixed(2),
    improvementPercent: +((1 - after / before) * 100).toFixed(1), measuredRuns: 21 }));
}
