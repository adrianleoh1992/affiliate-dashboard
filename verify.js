// Verifikasi engine terhadap CSV asli.
const fs = require('fs');
const E = require('./engine.js');

function parseCSV(text) {
  const rows = []; let row = [], cell = '', q = false;
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i+1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const head = rows.shift().map(h => h.trim());
  return rows.filter(r => r.length > 1).map(r => {
    const o = {}; head.forEach((h, i) => o[h] = (r[i] || '').trim()); return o;
  });
}

const D = '/Users/hadipradata/Downloads/';
const aff = parseCSV(fs.readFileSync(D + 'AffiliateCommissionReport_202608222201.csv', 'utf8'));
const ads = parseCSV(fs.readFileSync(D + 'AW-Adrian-Ads-Jul-23-2026-Aug-21-2026.csv', 'utf8'));
const clk = parseCSV(fs.readFileSync(D + 'WebsiteClickReport202608222201.csv', 'utf8'));

console.log('rows:', aff.length, ads.length, clk.length);
console.log('detect aff:', E.detectFileType(Object.keys(aff[0])));
console.log('detect ads:', E.detectFileType(Object.keys(ads[0])));
console.log('detect clk:', E.detectFileType(Object.keys(clk[0])));

const TAGMAP = {
  'telesinvideo2':'TelesinGripvideo2','lemariolympic':'OlymplastLemari',
  'minilayarportable':'minilayarportable','helmrsixsolid':'HelmRsixSolid',
  'spinningreelokuma':'Spinningreelokuma','seeouokacamatapolarized':'seeouokacamatapolarized',
};
const r = E.analyze({ affiliate: aff, ads: ads, clicks: clk, tagMap: TAGMAP }, { ppn: 11 });

console.log('\nrange', r.range.start, '->', r.range.end, '| matang s/d', r.range.matureUntil);
console.log('klik report', r.range.clickStart, '->', r.range.clickEnd);
const k = r.kpi;
const rp = n => 'Rp' + Math.round(n).toLocaleString('id-ID');
console.log('\nKPI: spend', rp(k.spend), '| komisi', rp(k.comm), '| efektif', rp(k.commEff));
console.log('     net', rp(k.netEff), '| ROAS', k.roas.toFixed(2), '| ROASeff', k.roasEff.toFixed(2), '| ROI', k.roi.toFixed(1)+'%');
console.log('     order', k.orders, '| pending', k.pendingPct.toFixed(1)+'%', '| hangus', rp(k.wasted));
console.log('     dibatalkan', k.excluded.cancelled, '| belum bayar', k.excluded.unpaid);

console.log('\nMATCHING:');
r.matchLog.forEach(m => console.log('  ', m.adName.padEnd(26), '->', String(m.tag).padEnd(26), m.method, m.confidence.toFixed(2)));

console.log('\nKEPUTUSAN (berbiaya):');
console.log('TAG'.padEnd(26) + 'SPEND'.padStart(12) + 'KOMISI'.padStart(12) + 'ROASe'.padStart(7) +
            'CPC'.padStart(7) + 'IDEAL'.padStart(7) + '%MSK'.padStart(7) + '  STATUS');
r.tags.filter(t => t.spend > 0).forEach(t => {
  console.log(
    t.tag.slice(0,25).padEnd(26) + rp(t.spend).padStart(12) + rp(t.comm).padStart(12) +
    t.roasEff.toFixed(2).padStart(7) + Math.round(t.cpc).toString().padStart(7) +
    Math.round(t.cpcIdeal).toString().padStart(7) +
    (t.leak ? t.leak.pct.toFixed(0)+'%' : '-').padStart(7) + '  ' + t.label + ' — ' + t.reason);
});
const org = r.tags.filter(t => t.status === 'organik');
console.log('\nORGANIK:', org.length, 'tag,', rp(org.reduce((s,t)=>s+t.comm,0)));
console.log('\nLAG (kumulatif):', r.lagProfile.slice(0,8).map(x => 'H+'+x.day+':'+x.cumulative.toFixed(0)+'%').join(' '));
