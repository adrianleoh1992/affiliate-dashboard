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
test('tags CSV appends the link note after the existing columns',()=>{
  const data={...result,tags:[{...result.tags[0],linkNote:'hanya 0% klik sampai Shopee — cek link'}]};
  const p=Papa.parse(X.csv(data,{account:'Toko'}),{header:true,skipEmptyLines:true});
  // Klik Shopee dari FB+IG is already the last column on main, so the note follows it.
  assert.equal(p.meta.fields.indexOf('Catatan link'),p.meta.fields.indexOf('Klik Shopee dari FB+IG')+1);
  assert.equal(p.meta.fields.indexOf('Alasan')+1,p.meta.fields.indexOf('Biaya + PPN'),'existing column order is unchanged');
  assert.equal(p.data[0]['Catatan link'],'hanya 0% klik sampai Shopee — cek link');
  assert.equal(Papa.parse(X.csv(result,{}),{header:true,skipEmptyLines:true}).data[0]['Catatan link'],'');
});
test('tags CSV appends the threshold a verdict sits on, empty when it is clear of it',()=>{
  const data={...result,tags:[{...result.tags[0],borderAt:2},{...result.tags[0],tag:'Jauh',borderAt:null}]};
  const p=Papa.parse(X.csv(data,{account:'Toko'}),{header:true,skipEmptyLines:true});
  assert.equal(p.meta.fields[p.meta.fields.length-2],'Di batas ambang (x)','last of the dataset columns; only the PPN column follows');
  assert.equal(p.meta.fields.indexOf('Catatan link')+1,p.meta.fields.indexOf('Di batas ambang (x)'),'earlier appended columns keep their place');
  assert.deepEqual(p.data.map(row=>row['Di batas ambang (x)']),['2','']);
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
  assert.equal(row['Data matang'],'Tidak');assert.equal(row['Laba dari komisi total'],'-1250.75');assert.equal(row['Komisi total'],'0');
});
test('daily CSV says which commission each column uses and appends the effective ones',()=>{
  const data={...result,daily:[{...result.daily[0],commEff:950.5,netEff:-300.25,roasEff:0.76}]};
  const p=Papa.parse(X.csv(data,{dataset:'daily'}),{header:true,skipEmptyLines:true});
  assert.deepEqual(p.meta.fields.slice(3,8),['Tanggal','Komisi total','Biaya + PPN','Laba dari komisi total','ROAS dari komisi total'],'renamed in place');
  // Later groups append after these; they stay right after the old order-date columns, and PPN stays last.
  const effAt=p.meta.fields.indexOf('Data matang')+1;
  assert.deepEqual(p.meta.fields.slice(effAt,effAt+3),['Komisi efektif','Laba efektif','ROAS efektif']);
  assert.equal(p.meta.fields[p.meta.fields.length-1],'PPN biaya iklan (%)');
  assert.deepEqual([p.data[0]['Komisi efektif'],p.data[0]['Laba efektif'],p.data[0]['ROAS efektif']],['950.5','-300.25','0.76']);
  const tags=Papa.parse(X.csv(result,{}),{header:true,skipEmptyLines:true}).meta.fields;
  assert.equal(tags.indexOf('Komisi total'),tags.indexOf('Biaya + PPN')+1,'tags keep the total in its old place');
});
test('daily CSV appends the click-date series after the effective columns, blank when unknown',()=>{
  const data={...result,daily:[{...result.daily[0],commEff:950.5,commEffByClick:400.25,netEffByClick:-850.5,roasEffByClick:0.32,matureByClick:false},
    {...result.daily[0],date:'2026-08-02',commEffByClick:null,netEffByClick:null,roasEffByClick:null,matureByClick:null}]};
  const p=Papa.parse(X.csv(data,{dataset:'daily'}),{header:true,skipEmptyLines:true}),f=p.meta.fields;
  assert.deepEqual(f.slice(f.indexOf('ROAS efektif')+1,-1),['Komisi efektif (tgl klik)','Laba efektif (tgl klik)','ROAS efektif (tgl klik)','Data matang (tgl klik)'],'appended, PPN still last');
  assert.deepEqual(f.slice(3,8),['Tanggal','Komisi total','Biaya + PPN','Laba dari komisi total','ROAS dari komisi total'],'existing columns keep their place');
  assert.deepEqual(['Komisi efektif (tgl klik)','Laba efektif (tgl klik)','ROAS efektif (tgl klik)','Data matang (tgl klik)'].map(k=>p.data[0][k]),['400.25','-850.5','0.32','Tidak']);
  // Without Waktu Klik (or after the commission report ends) the engine says null: a blank, not a 0.
  assert.deepEqual(['Komisi efektif (tgl klik)','Laba efektif (tgl klik)','ROAS efektif (tgl klik)','Data matang (tgl klik)'].map(k=>p.data[1][k]),['','','','']);
});
test('every dataset ends with the PPN that produced its money columns',()=>{
  for(const dataset of Object.keys(X.DATASETS)){
    const p=Papa.parse(X.csv({...result,options:{ppn:11}},{dataset}),{header:true,skipEmptyLines:true});
    assert.equal(p.meta.fields[p.meta.fields.length-1],'PPN biaya iklan (%)',dataset);
    assert.equal(p.meta.fields.length,X.DATASETS[dataset].columns.length+4,dataset+': one column added, at the end');
    for(const row of p.data)assert.equal(row['PPN biaya iklan (%)'],'11',dataset);
  }
  // Unknown is blank, never a false 0.
  for(const options of [undefined,{},{ppn:null}])
    assert.equal(Papa.parse(X.csv({...result,options},{}),{header:true,skipEmptyLines:true}).data[0]['PPN biaya iklan (%)'],'');
  assert.equal(Papa.parse(X.csv({...result,options:{ppn:0}},{}),{header:true,skipEmptyLines:true}).data[0]['PPN biaya iklan (%)'],'0');
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
