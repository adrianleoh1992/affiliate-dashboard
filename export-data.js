(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory();
  else root.DashboardExport=factory();
})(typeof self!=='undefined'?self:this,function(){
  'use strict';
  const DATASETS={
    tags:{label:'Keputusan per tag',key:'tags',columns:[['Tag','tag'],['Keputusan','label'],['Alasan','reason'],['Biaya + PPN','spend'],['Komisi','comm'],['Komisi efektif','commEff'],['Laba efektif','netEff'],['ROAS efektif','roasEff'],['ROI (%)','roi'],['Klik Meta','clicks'],['Klik Shopee','shopeeClicks'],['CPC Meta','cpc'],['CPC ideal','cpcIdeal'],['Order','orders'],['Hari produksi matang','matureDaysProd'],['Biaya matang','matureSpend'],['ROAS matang','matureRoasEff']]},
    units:{label:'Performa per iklan',key:'adUnits',columns:[['Nama iklan','adName'],['Tag','tag'],['Keputusan','label'],['Biaya + PPN','spend'],['Komisi efektif (alokasi)','commEff'],['Laba efektif','netEff'],['Klik Meta','clicks'],['Impresi','impr'],['CPC','cpc'],['CTR (%)','ctr'],['Order (alokasi)','orders']]},
    daily:{label:'Rincian per tanggal',key:'daily',columns:[['Tanggal','date'],['Komisi','comm'],['Biaya + PPN','spend'],['Laba','net'],['ROAS','roas'],['Order','orders'],['Klik Meta','clicks'],['Klik Shopee','shopeeClicks'],['Data matang','mature']]},
    matching:{label:'Pencocokan iklan dan tag',key:'matchLog',columns:[['Nama iklan','adName'],['Tag','tag'],['Kandidat tag','candidateTag'],['Metode','method'],['Keyakinan (0-1)','confidence'],['Biaya + PPN','spend'],['Klik','clicks']]},
  };
  function filenamePart(value){return String(value||'akun').normalize('NFKC').replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g,'-').replace(/\s+/g,'-').replace(/^\.+|\.+$/g,'').slice(0,90)||'akun'}
  function cell(value){
    if(value==null||typeof value==='number'&&!Number.isFinite(value))value='';
    if(typeof value==='boolean')value=value?'Ya':'Tidak';
    if(typeof value==='string'&&/^[\s\uFEFF]*[=+@\-]/.test(value))value="'"+value;
    return '"'+String(value).replace(/"/g,'""')+'"';
  }
  function csv(result,options={}){
    const config=DATASETS[options.dataset||'tags'];
    if(!config)throw new Error('Jenis data ekspor tidak dikenali');
    const source=options.rows||result[config.key]||[];
    const rows=[['Akun','Periode awal','Periode akhir',...config.columns.map(c=>c[0])]];
    source.forEach(row=>rows.push([options.account||'default',result.range.start,result.range.end,...config.columns.map(([,key])=>row[key])]));
    return '\uFEFF'+rows.map(row=>row.map(cell).join(',')).join('\r\n')+'\r\n';
  }
  function json(result,options={}){
    return JSON.stringify({format:'affiliate-analysis',version:1,account:options.account||'default',
      exportedAt:options.generatedAt||new Date().toISOString(),quality:options.quality||[],
      note:'Angka rasio yang tidak dapat dihitung disimpan sebagai null. Ini adalah analisis, bukan backup untuk pemulihan akun.',
      analysis:result},(_,value)=>typeof value==='number'&&!Number.isFinite(value)?null:value,2);
  }
  return {DATASETS,filenamePart,csv,json};
});
