'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),http=require('node:http'),path=require('node:path');
const {chromium}=require('playwright'),Papa=require('papaparse');
const row=(id,status='Selesai',date='2026-08-01')=>({'ID Pemesanan':id,'Status Pesanan':status,'Waktu Pemesanan':date+' 10:00:00','Waktu Klik':date+' 09:00:00','Tag_link1':'Alpha','Total Komisi per Pesanan(Rp)':'200','Jumlah':'1','Nilai Pembelian(Rp)':'1000'});
async function main(){
 const server=http.createServer((req,res)=>{const file=path.join(__dirname,new URL(req.url,'http://localhost').pathname==='/'?'index.html':new URL(req.url,'http://localhost').pathname);fs.readFile(file,(err,data)=>{if(err)return res.writeHead(404).end();res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(data);});});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const executablePath=[process.env.CHROME_PATH,chromium.executablePath(),'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean).find(f=>fs.existsSync(f));
 const browser=await chromium.launch({headless:true,...(executablePath?{executablePath}:{})});
 try{
 const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}`);await page.waitForFunction(()=>window.__dailyStore);
 const upload=async rows=>{await page.setInputFiles('#files',{name:'affiliate.csv',mimeType:'text/csv',buffer:Buffer.from(Papa.unparse(rows))});await page.waitForFunction(()=>!document.getElementById('files').value);await page.waitForFunction(()=>!document.getElementById('ingestPlan').classList.contains('hidden'));};
 const records=()=>page.evaluate(async()=>{const a=(await __dailyStore.listAccounts('shopee')).find(x=>x.name==='default');return __dailyStore.range(a.id,'affiliate');});
 await upload([row('one','Tertunda'),row('gone','Selesai','2026-08-02')]);await page.locator('#btnSaveAll').click();await page.waitForFunction(()=>!document.getElementById('savedNote').classList.contains('hidden'));
 await page.reload();await page.waitForFunction(()=>window.__dailyStore);
 await page.locator('#btnStored').click();await page.waitForFunction(()=>document.getElementById('storedStrip').textContent.includes('Biaya Total'));
 const strip=await page.locator('#storedStrip').innerText();assert.match(strip,/Biaya Total\s*—/i);assert.match(await page.locator('#storedNote').innerText(),/agregat/i);
 await upload([row('one')]);
 assert.equal(await page.locator('#replaceMode').count(),1,'complete-period replacement must be available');
 await page.locator('#replaceMode').check();await page.locator('[data-replace-kind="affiliate"]').check();
 assert.equal(await page.locator('#replaceStart-affiliate').inputValue(),'','replacement bounds must not be silently inferred');
 await page.locator('#replaceStart-affiliate').fill('2026-08-01');await page.locator('#replaceEnd-affiliate').fill('2026-08-02');
 await page.locator('#btnPreviewReplace').click();await page.waitForFunction(()=>!document.getElementById('replacementPreview').classList.contains('hidden'));
 const preview=await page.locator('#replacementPreview').innerText();assert.match(preview,/default/);assert.match(preview,/2026-08-01/);assert.match(preview,/2026-08-02/);assert.match(preview,/400/);assert.match(preview,/200/);
 assert.equal(await page.locator('#btnSaveAll').isDisabled(),true);await page.locator('#replaceIntent').check();assert.equal(await page.locator('#btnSaveAll').isDisabled(),false);
 page.once('dialog',d=>d.accept());await page.locator('#btnSaveAll').click();await page.waitForFunction(()=>!document.getElementById('savedNote').classList.contains('hidden'));
 const saved=await records();assert.equal(saved.length,1);assert.equal(saved[0].comm,200);assert.equal(saved[0].comm_done,200);assert.equal(saved[0].comm_pending,0);
 await page.reload();await page.waitForFunction(()=>window.__dailyStore);await upload([row('one')]);await page.locator('#replaceMode').check();await page.locator('[data-replace-kind="affiliate"]').check();await page.locator('#replaceStart-affiliate').fill('2026-08-01');await page.locator('#replaceEnd-affiliate').fill('2026-08-01');await page.locator('#btnPreviewReplace').click();await page.locator('#replaceIntent').check();page.once('dialog',d=>d.accept());await page.locator('#btnSaveAll').click();await page.waitForFunction(()=>!document.getElementById('savedNote').classList.contains('hidden'));assert.equal((await records())[0].comm,200,'identical accepted rows must be restored after deletion');
 // Persisted source declarations and aggregate readiness survive a reload.
 await page.evaluate(()=>localStorage.setItem('adash_source_ranges_v1_default',JSON.stringify([{kind:'ads',state:'none',start:'2026-08-01',end:'2026-08-03'}])));
 await page.reload();await page.waitForFunction(()=>window.__dailyStore);await page.locator('#btnStored').click();await page.waitForFunction(()=>document.getElementById('storedStrip').textContent.includes('Biaya Total'));assert.match(await page.locator('#storedStrip').innerText(),/Biaya Total\s*Rp0/i);
 await page.evaluate(async()=>{const a=(await __dailyStore.listAccounts('shopee')).find(x=>x.name==='default');
 const ads=['2026-08-01','2026-08-03'].map(date=>({'Reporting starts':date,'Ad name':'Alpha','Amount spent (IDR)':'100'}));
 await __dailyStore.saveBatch(a.id,[{kind:'ads',rawRows:ads,fileHash:DailyAgg.hashRows(ads),sourceRows:2,sourceState:'loaded'}]);});
 await page.reload();await page.waitForFunction(()=>window.__dailyStore);await page.locator('#btnStored').click();await page.waitForFunction(()=>document.getElementById('storedStrip').textContent.includes('Biaya Total'));assert.match(await page.locator('#storedStrip').innerText(),/Biaya Total\s*—/i,'stale no-Meta declaration cannot fill gaps once Meta data exists');
 await page.evaluate(()=>localStorage.setItem('adash_source_ranges_v1_default',JSON.stringify([{kind:'ads',state:'complete',start:'2026-08-01',end:'2026-08-03'}])));
 await page.reload();await page.waitForFunction(()=>window.__dailyStore);await page.locator('#btnStored').click();await page.waitForFunction(()=>document.getElementById('storedStrip').textContent.includes('Biaya Total'));assert.doesNotMatch(await page.locator('#storedStrip').innerText(),/Biaya Total\s*—/i,'explicit complete Meta coverage permits an empty gap date');
 await page.evaluate(async()=>{const a=(await __dailyStore.listAccounts('shopee')).find(x=>x.name==='default');const ads=['2026-08-01','2026-08-03'].map(date=>({'Reporting starts':date,'Ad name':'Partial','Amount spent (IDR)':'100'}));await __dailyStore.saveBatch(a.id,[{kind:'ads',rawRows:ads,fileHash:DailyAgg.hashRows(ads),sourceRows:1,sourceState:'partial'}]);});
 await page.reload();await page.waitForFunction(()=>window.__dailyStore);await page.locator('#btnStored').click();await page.waitForFunction(()=>document.getElementById('storedStrip').textContent.includes('Biaya Total'));assert.match(await page.locator('#storedStrip').innerText(),/Biaya Total\s*—/i,'confirmed coverage does not repair partial imported source');
 await page.evaluate(async()=>{const a=(await __dailyStore.listAccounts('shopee')).find(x=>x.name==='default');const ads=[{'Reporting starts':'2026-08-01','Ad name':'Alpha','Amount spent (IDR)':'100'}];await __dailyStore.saveBatch(a.id,[{kind:'ads',rawRows:ads,sourceState:'loaded'}],{replacementRanges:[{kind:'ads',start:'2026-08-01',end:'2026-08-01'}]});});
 await page.reload();await page.waitForFunction(()=>window.__dailyStore);await page.locator('#btnStored').click();await page.waitForFunction(()=>document.getElementById('storedStrip').textContent.includes('Biaya Total'));assert.match(await page.locator('#storedStrip').innerText(),/Biaya Total\s*—/i,'outside partial status survives replacement, reload and removed overlapping upload log');
 console.log('PASS replacement UI, explicit range, intent gate, corrected status, identical restoration and unknown stored costs');
 }finally{await browser.close();await new Promise(r=>server.close(r));}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
