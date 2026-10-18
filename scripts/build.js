'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const out = path.join(root, 'dist');
const assets = ['index.html', 'index-daily.html', 'styles.css', 'app.js', 'engine.js',
  'daily-agg.js', 'daily-store.js', 'daily-layer.js', 'cloud-store.js', 'cloud-panel.js', 'supabase-config.js', 'import-pipeline.js', 'export-data.js', 'pdf-charts.js', 'pdf-export.js', 'vendor'];
// dist is generated; a fresh directory prevents removed files surviving deployment.
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const file of assets) fs.cpSync(path.join(root, file), path.join(out, file), { recursive: true });
// Vercel env vars SUPABASE_URL and SUPABASE_ANON_KEY switch on the shared
// database. Only the public anon/publishable key belongs here, never service_role.
const supabase = { url: (process.env.SUPABASE_URL || '').trim(), anonKey: (process.env.SUPABASE_ANON_KEY || '').trim() };
if (supabase.url || supabase.anonKey) {
  if (!/^https:\/\/[^/\s]+$/.test(supabase.url) || !supabase.anonKey) throw new Error('SUPABASE_URL (https://…) dan SUPABASE_ANON_KEY harus diisi bersama');
  // Allowlist: a publishable key, or a legacy JWT whose role is anon. Anything
  // else (service_role, sb_secret_, a typo) would end up in public JavaScript.
  if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(supabase.anonKey) && jwtRole(supabase.anonKey) !== 'anon')
    throw new Error('SUPABASE_ANON_KEY harus publishable key (sb_publishable_…) atau anon key; kunci service_role/secret tidak boleh dipakai');
  fs.writeFileSync(path.join(out, 'supabase-config.js'), `window.SUPABASE_CONFIG = ${JSON.stringify(supabase)};\n`);
}
function jwtRole(token) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try { return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')).role || null; } catch (_) { return null; }
}
console.log('Static application built in dist/.' + (supabase.url ? ' Database bersama: ' + supabase.url : ''));
