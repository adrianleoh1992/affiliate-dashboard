'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const out = path.join(root, 'dist');
const assets = ['index.html', 'index-daily.html', 'styles.css', 'app.js', 'engine.js',
  'daily-agg.js', 'daily-store.js', 'daily-layer.js', 'vendor'];
// dist is generated; a fresh directory prevents removed files surviving deployment.
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const file of assets) fs.cpSync(path.join(root, file), path.join(out, file), { recursive: true });
console.log('Static application built in dist/.');
