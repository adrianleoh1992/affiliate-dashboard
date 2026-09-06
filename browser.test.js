'use strict';
// Compatibility entry point: portable synthetic coverage replaces personal CSV fixtures.
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const run = spawnSync(process.execPath, [path.join(__dirname, 'browser.regression.test.js')], { stdio: 'inherit' });
if (run.error) throw run.error;
process.exitCode = run.status ?? 1;
