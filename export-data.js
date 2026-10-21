(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory();
  else root.DashboardExport=factory();
})(typeof self!=='undefined'?self:this,function(){
  'use strict';
  const DATASETS={
    tags:{label:'Keputusan per tag',key:'tags',columns:[['Tag','tag'],['Keputusan','label'],['Alasan','reason'],['Biaya + PPN','spend'],['Komisi total','comm'],['Komisi efektif','commEff'],['Laba efektif','netEff'],['ROAS efektif','roasEff'],['ROI (%)','roi'],['Klik Meta','clicks'],['LP view','lpv'],['Klik Shopee','shopeeClicks'],['CPC Meta','cpc'],['Biaya per LP view','cpLpv'],['CPC Shopee','cpcShopee'],['Klik hilang Meta ke Shopee (%)','lostTotal'],['CPC ideal','cpcIdeal'],['Order','orders'],['Pesanan langsung','attrDirectOrders'],['Komisi langsung','attrDirectComm'],['Pesanan tidak langsung','attrIndirectOrders'],['Komisi tidak langsung','attrIndirectComm'],['Hari produksi matang','matureDaysProd'],['Biaya matang','matureSpend'],['ROAS matang','matureRoasEff'],['Catatan link','linkNote'],['Di batas ambang (x)','borderAt']]},
    units:{label:'Performa per iklan',key:'adUnits',columns:[['Nama iklan','adName'],['Ad ID','adId','id'],['Kampanye','campaign'],['Tag','tag'],['Keputusan','label'],['Biaya + PPN','spend'],['Komisi efektif (alokasi)','commEff'],['Laba efektif','netEff'],['Klik Meta','clicks'],['Impresi','impr'],['CPC','cpc'],['CTR (%)','ctr'],['Order (alokasi)','orders']]},
    // Renamed in place, effective values appended: the screen now shows effective, and positions must not move.
    // The earlier columns are by order date; the click-date ones follow and are blank when unknown.
    daily:{label:'Rincian per tanggal',key:'daily',columns:[['Tanggal','date'],['Komisi total','comm'],['Biaya + PPN','spend'],['Laba dari komisi total','net'],['ROAS dari komisi total','roas'],['Order','orders'],['Klik Meta','clicks'],['Klik Shopee','shopeeClicks'],['Data matang','mature'],['Komisi efektif','commEff'],['Laba efektif','netEff'],['ROAS efektif','roasEff'],['Komisi efektif (tgl klik)','commEffByClick'],['Laba efektif (tgl klik)','netEffByClick'],['ROAS efektif (tgl klik)','roasEffByClick'],['Data matang (tgl klik)','matureByClick']]},
    matching:{label:'Pencocokan iklan dan tag',key:'matchLog',columns:[['Nama iklan','adName'],['Ad ID','adId','id'],['Kampanye','campaign'],['Tag','tag'],['Kandidat tag','candidateTag'],['Metode','method'],['Keyakinan (0-1)','confidence'],['Biaya + PPN','spend'],['Klik','clicks']]},
  };
  function filenamePart(value){return String(value||'akun').normalize('NFKC').replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g,'-').replace(/\s+/g,'-').replace(/^\.+|\.+$/g,'').slice(0,90)||'akun'}
  function cell(value,kind){
    // An 18-digit Ad ID opened as a number keeps only 15 digits; ="…" keeps it
    // text. Digits only, so the formula can carry nothing else.
    if(kind==='id'&&/^\d+$/.test(String(value==null?'':value)))return '"=""'+value+'"""';
    if(value==null||typeof value==='number'&&!Number.isFinite(value))value='';
    if(typeof value==='boolean')value=value?'Ya':'Tidak';
    if(typeof value==='string'&&/^[\s\uFEFF]*[=+@\-]/.test(value))value="'"+value;
    return '"'+String(value).replace(/"/g,'""')+'"';
  }
  function csv(result,options={}){
    const config=DATASETS[options.dataset||'tags'];
    if(!config)throw new Error('Jenis data ekspor tidak dikenali');
    const source=options.rows||result[config.key]||[];
    // Every money column depends on the PPN used, so each row carries it; last, so no column moves.
    const ppn=result.options&&Number.isFinite(result.options.ppn)?result.options.ppn:'';
    const rows=[['Akun','Periode awal','Periode akhir',...config.columns.map(c=>c[0]),'PPN biaya iklan (%)']];
    const kinds=[null,null,null,...config.columns.map(c=>c[2]||null),null];
    source.forEach(row=>rows.push([options.account||'default',result.range.start,result.range.end,...config.columns.map(([,key])=>row[key]),ppn]));
    return '\uFEFF'+rows.map((row,i)=>row.map((v,j)=>cell(v,i?kinds[j]:null)).join(',')).join('\r\n')+'\r\n';
  }
  function json(result,options={}){
    return JSON.stringify({format:'affiliate-analysis',version:1,account:options.account||'default',
      exportedAt:options.generatedAt||new Date().toISOString(),quality:options.quality||[],
      note:'Angka rasio yang tidak dapat dihitung disimpan sebagai null. Ini adalah analisis, bukan backup untuk pemulihan akun.',
      analysis:result},(_,value)=>typeof value==='number'&&!Number.isFinite(value)?null:value,2);
  }
  return {DATASETS,filenamePart,csv,json};
});
