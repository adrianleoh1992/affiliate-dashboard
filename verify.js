// Verifikasi engine terhadap CSV asli.
const fs = require('fs');
const E = require('./engine.js');

const Papa = require('papaparse');
const files = process.argv.slice(2);
if (files.length !== 3) {
  console.error('Usage: node verify.js affiliate.csv ads.csv clicks.csv');
  process.exit(1);
}
function parseCSV(file) {
  const result = Papa.parse(fs.readFileSync(file, 'utf8'), {
    header: true, skipEmptyLines: 'greedy', transformHeader: h => h.replace(/^\uFEFF/, '').trim(),
  });
  if (result.errors.length) throw new Error(file + ': ' + result.errors[0].message);
  return result.data;
}
const [aff, ads, clk] = files.map(parseCSV);

const TAGMAP = {
  'telesinvideo2':'TelesinGripvideo2','lemariolympic':'OlymplastLemari',
  'minilayarportable':'minilayarportable','helmrsixsolid':'HelmRsixSolid',
  'spinningreelokuma':'Spinningreelokuma','seeouokacamatapolarized':'seeouokacamatapolarized',
};
const r = E.analyze({ affiliate: aff, ads: ads, clicks: clk, tagMap: TAGMAP }, { ppn: 11 });
const rp = n => 'Rp' + Math.round(n).toLocaleString('id-ID');
const k = r.kpi;

console.log('periode', r.range.start, '->', r.range.end, '| matang s/d', r.range.matureUntil);
console.log('klik report', r.range.clickStart, '->', r.range.clickEnd);
console.log('\n── PORTOFOLIO ──');
console.log('spend', rp(k.spend), '| komisi', rp(k.comm), '| efektif', rp(k.commEff));
console.log('laba', rp(k.netEff), '| ROAS gab', k.roasEff.toFixed(2), '| ROAS berbayar', k.paidRoas.toFixed(2));
console.log('organik', rp(k.organicComm), `(${k.organicShare.toFixed(1)}% dari komisi efektif)`);
console.log('GMV', rp(k.gmv), '| order', k.orders, '| qty', k.qty, '| refund', rp(k.refund));
console.log('impresi', k.impr.toLocaleString('id-ID'), '| reach', k.reach.toLocaleString('id-ID'),
            '| klik', k.clicks.toLocaleString('id-ID'), '| LPV', k.lpv.toLocaleString('id-ID'));
console.log('CPM', rp(k.cpm), '| CPC', rp(k.cpc), '| CTR', k.ctr.toFixed(2)+'%',
            '| CR', k.convRate.toFixed(2)+'%', '| biaya/order', rp(k.costPerOrder));
console.log('komisi rate', k.commRate.toFixed(2)+'%', '| avg order', rp(k.avgOrder), '| avg komisi', rp(k.avgComm));
console.log('terbuang', rp(k.wasted), '| tag bocor', k.leakTags);
console.log('status', JSON.stringify(k.statusCount));
console.log('vonis', JSON.stringify(k.counts));

console.log('\n── PER AD UNIT ──');
console.log('AD UNIT'.padEnd(26)+'STATUS'.padEnd(9)+'SPEND'.padStart(11)+'CPM'.padStart(8)+
            'KLIK'.padStart(7)+'CPC'.padStart(7)+'IDEAL'.padStart(7)+'ORDER'.padStart(7)+
            'CR%'.padStart(7)+'ROAS'.padStart(7)+'  VONIS');
r.adUnits.forEach(u => console.log(
  u.adName.slice(0,25).padEnd(26) + (u.active?'Nyala':'Mati').padEnd(9) +
  rp(u.spend).padStart(11) + Math.round(u.cpm).toString().padStart(8) +
  u.clicks.toString().padStart(7) + Math.round(u.cpc).toString().padStart(7) +
  Math.round(u.cpcIdeal).toString().padStart(7) + u.orders.toString().padStart(7) +
  u.convRate.toFixed(2).padStart(7) + u.roasEff.toFixed(2).padStart(7) + '  ' + u.label));

console.log('\n── PER TAG ──');
r.tags.filter(t=>t.spend>0).forEach(t => console.log(
  t.tag.slice(0,24).padEnd(25) + rp(t.spend).padStart(11) + rp(t.commEff).padStart(12) +
  t.roasEff.toFixed(2).padStart(7) + (t.leak?t.leak.pct.toFixed(0)+'%':'-').padStart(7) +
  ('CTR '+t.ctr.toFixed(2)).padStart(10) + ('freq '+t.freq.toFixed(2)).padStart(11) +
  '  ' + t.label + ' — ' + t.reason));

console.log('\n── BREAKDOWN ──');
console.log('platform:', r.breakdown.platform.slice(0,5).map(x=>x.name+' '+rp(x.comm)).join(' | '));
console.log('toko:', r.breakdown.shop.slice(0,3).map(x=>x.name.slice(0,18)+' '+rp(x.comm)).join(' | '));
console.log('kategori:', r.breakdown.category.slice(0,4).map(x=>x.name.slice(0,20)+' '+rp(x.comm)).join(' | '));
console.log('sumber klik:', r.breakdown.clickSource.slice(0,4).map(x=>x.name+' '+x.count).join(' | '));
console.log('wilayah:', r.breakdown.clickRegion.slice(0,4).map(x=>x.name+' '+x.count).join(' | '));
const topH = r.breakdown.hourly.slice().sort((a,b)=>b.comm-a.comm).slice(0,5);
console.log('jam terbaik:', topH.map(h=>h.hour+':00 '+rp(h.comm)).join(' | '));
console.log('lag:', r.lagProfile.slice(0,7).map(x=>'H+'+x.day+' '+x.cumulative.toFixed(0)+'%').join(' '));
console.log('settlement:', r.settlement.filter(s=>[0,2,5,10,20].includes(s.age))
  .map(s=>'umur'+s.age+' '+s.pendingPct.toFixed(0)+'% tertunda').join(' | '));
console.log('produk teratas:', r.breakdown.productByComm.slice(0,3).map(p=>p.name.slice(0,28)+' '+rp(p.comm)).join(' | '));

// snapshot + trend simulation
const s1 = E.toSnapshot(r, { account:'adrian', saved:'2026-08-22 22:00:00' });
console.log('\n── SNAPSHOT ──');
console.log('ukuran', (JSON.stringify(s1).length/1024).toFixed(1)+'KB', '| tag', s1.tags.length);
const tr = E.buildTrend([s1], 'adrian');
console.log('trend titik:', tr.series.length, '| delta:', tr.delta ? 'ada' : 'butuh 2+ snapshot');
