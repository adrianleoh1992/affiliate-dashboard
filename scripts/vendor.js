'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
fs.mkdirSync(path.join(root, 'vendor'), { recursive: true });
for (const [source, destination] of [
  ['papaparse/papaparse.min.js', 'papaparse.min.js'],
  ['papaparse/LICENSE', 'papaparse-LICENSE'],
  ['chart.js/dist/chart.umd.min.js', 'chart.umd.js'],
  ['chart.js/LICENSE.md', 'chartjs-LICENSE.md'],
]) {
  fs.copyFileSync(path.join(root, 'node_modules', source), path.join(root, 'vendor', destination));
}
console.log('Local browser dependencies refreshed.');
