'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {chromium}=require('playwright');
const Engine=require('./engine');

async function main(){
  const executablePath=[process.env.CHROME_PATH,chromium.executablePath(),'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean).find(p=>fs.existsSync(p));
  const browser=await chromium.launch({headless:true,...(executablePath?{executablePath}:{})});
  try{
    const page=await browser.newPage();
    await page.setContent('<!doctype html><html><body>PDF readiness regression</body></html>');
    for(const name of ['vendor/jspdf.umd.min.js','vendor/jspdf.plugin.autotable.min.js','vendor/pdf-font.js','pdf-charts.js','pdf-export.js'])await page.addScriptTag({path:path.join(__dirname,name)});
    const result=Engine.analyze({affiliate:[{'ID Pemesanan':'one','Waktu Pemesanan':'2026-09-01 10:00:00','Waktu Klik':'2026-09-01 09:00:00','Status Pesanan':'Selesai','Tag_link1':'Alpha','Total Komisi per Produk(Rp)':'250'}],ads:[],clicks:[]},{ppn:0,lagDays:0});
    result.readiness={costsKnown:false,decisionReady:false,basis:'click-cohort',reasons:['Laporan Meta belum tersedia']};
    Object.assign(result.kpi,{spend:null,net:null,netEff:null,roas:null,roasEff:null,paidSpend:null,paidRoas:null,organicComm:null});
    result.tags.forEach(t=>Object.assign(t,{spend:null,netEff:null,roasEff:null,matureSpend:null,matureRoasEff:null,status:'evaluasi',label:'Menunggu laporan Meta',reason:'Laporan Meta belum tersedia',decisionReady:false,blockers:['meta_missing']}));
    Object.assign(result.actions,{bidSaving:null,stopSpend:null,reclaimable:null,leakWaste:null});
    const output=await page.evaluate(result=>{
      const Original=jspdf.jsPDF;let labels=[],tables=[];
      jspdf.jsPDF=function(options){
        const doc=new Original(options),drawText=doc.text,drawTable=doc.autoTable;
        doc.text=function(value,...args){labels.push(String(value));return drawText.call(this,value,...args)};
        doc.autoTable=function(options){tables.push({head:options.head,body:options.body});return drawTable.call(this,options)};
        return doc;
      };
      jspdf.jsPDF.API=Original.API;
      const pdf=DashboardPDF.create(result,{mode:'lengkap',generatedAt:'2026-10-02T03:00:00Z'});
      const missing={labels:labels.slice(),tables:tables.slice(),bytes:pdf.output('arraybuffer').byteLength};
      labels=[];tables=[];
      const zero={...result,readiness:{...result.readiness,costsKnown:true},kpi:{...result.kpi,spend:0,netEff:250}};
      DashboardPDF.create(zero,{mode:'ringkas',generatedAt:'2026-10-02T03:00:00Z'});
      return{missing,zero:labels};
    },result);
    const next=(labels,key)=>labels[labels.indexOf(key)+1];
    assert.ok(output.missing.bytes>1000,'real PDF is generated');
    assert.equal(next(output.missing.labels,'Spend Iklan'),'-','unknown cost must not render Rp0');
    assert.equal(next(output.missing.labels,'Laba Bersih'),'-','unknown net must not render a profit or zero');
    assert.equal(next(output.zero,'Spend Iklan'),'Rp 0,00','explicit known zero remains zero');
    const decisions=output.missing.tables.find(t=>t.head[0].includes('ROAS matang'));
    assert.equal(decisions.body[0][1],'Menunggu laporan Meta','specific blocker must survive PDF status rendering');
    assert.equal(decisions.body[0][2],'-');assert.equal(decisions.body[0][4],'-');
    assert.ok(output.missing.labels.some(s=>s.includes('tanggal klik')),'PDF explains the decision basis');
    assert.ok(!output.missing.labels.includes('Klik Hilang'),'PDF must not infer loss from cross-platform counts');
    assert.ok(!output.missing.tables.some(t=>t.head.flat().includes('Estimasi biaya selisih')),'click difference must not be priced as waste');
    console.log('PASS PDF unknown costs, explicit zero, blocker label, decision basis and neutral click comparison');
  }finally{await browser.close()}
}
main().catch(error=>{console.error(error);process.exitCode=1});
