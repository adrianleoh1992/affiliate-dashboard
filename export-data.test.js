'use strict';
const assert=require('node:assert/strict');
const {test}=require('node:test');
const Papa=require('papaparse');
const X=require('./export-data');
const result={range:{start:'2026-08-01',end:'2026-08-14'},tags:[{tag:'=1+1',label:'Pantau',reason:'Ada "kutipan",\ndan baris baru',spend:1250.75,commEff:0,netEff:-1250.75,roasEff:Infinity,orders:0,matureDaysProd:0}],
  adUnits:[{adName:'Iklan',spend:0}],daily:[{date:'2026-08-01',comm:0,spend:1250.75,net:-1250.75,mature:false}],matchLog:[]};
test('CSV keeps decimal precision, zero, negative amounts and multiline text',()=>{
  const text=X.csv(result,{account:'Akun utama'}),p=Papa.parse(text,{header:true,skipEmptyLines:true});
  assert.equal(text.charCodeAt(0),0xfeff);assert(text.includes('\r\n'));
  assert.equal(p.errors.length,0);const row=p.data[0];
  assert.equal(row['Biaya + PPN'],'1250.75');assert.equal(row['Komisi efektif'],'0');assert.equal(row['Laba efektif'],'-1250.75');
  assert.equal(row['Alasan'],result.tags[0].reason);assert.equal(row['ROAS efektif'],'');
});
test('CSV neutralizes source formulas without turning negative numbers into text',()=>{
  for(const tag of ['=SUM(A1)',' +1','\t@bad','-cmd','\uFEFF=1']){
    const data={...result,tags:[{...result.tags[0],tag}]};
    const row=Papa.parse(X.csv(data,{account:'=account'}),{header:true,skipEmptyLines:true}).data[0];
    assert.equal(row.Tag,"'"+tag);assert.equal(row.Akun,"'=account");assert.equal(row['Laba efektif'],'-1250.75');
  }
});
test('every dataset carries account and period with consistent row widths',()=>{
  for(const dataset of Object.keys(X.DATASETS)){
    const p=Papa.parse(X.csv(result,{account:'Toko',dataset}),{header:true,skipEmptyLines:true});assert.equal(p.errors.length,0);
    for(const row of p.data){assert.equal(row.Akun,'Toko');assert.equal(row['Periode awal'],'2026-08-01');assert.equal(row['Periode akhir'],'2026-08-14')}
  }
});
test('explicit filtered rows do not leak other tags and empty exports retain headers',()=>{
  assert.equal(Papa.parse(X.csv(result,{rows:[]}),{header:true,skipEmptyLines:true}).data.length,0);
  assert.throws(()=>X.csv(result,{dataset:'unknown'}),/tidak dikenali/);
});
test('daily CSV maps booleans and retains actual source values',()=>{
  const row=Papa.parse(X.csv(result,{dataset:'daily'}),{header:true,skipEmptyLines:true}).data[0];
  assert.equal(row['Data matang'],'Tidak');assert.equal(row.Laba,'-1250.75');assert.equal(row.Komisi,'0');
});
test('JSON is versioned, preserves metadata and represents unavailable ratios honestly',()=>{
  const data=JSON.parse(X.json(result,{account:'A',quality:['Laporan parsial'],generatedAt:'2026-09-07T00:00:00Z'}));
  assert.equal(data.version,1);assert.equal(data.format,'affiliate-analysis');assert.equal(data.analysis.tags[0].roasEff,null);
  assert.equal(data.analysis.tags[0].netEff,-1250.75);assert.deepEqual(data.quality,['Laporan parsial']);
  assert.equal(result.tags[0].roasEff,Infinity);
});
test('download filenames preserve names while removing filesystem controls',()=>{
  assert.equal(X.filenamePart('../Akun: satu/dua?'),'-Akun--satu-dua-');
  assert.equal(X.filenamePart('Café 日本'),'Café-日本');assert(X.filenamePart('x'.repeat(200)).length<=90);
});
