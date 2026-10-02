'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHarness, aff, ad, click, upload, readDownload } = require('./browser.regression.test');
async function main() {
  const harness = await createHarness(), cases=[];
  const test=(name,run)=>cases.push({name,run});
  const prepare=page=>upload(page,[{name:'affiliate.csv',rows:[aff('1','Alpha'),aff('2','Bravo')]},{name:'ads.csv',rows:[ad('Unrelated high',300),ad('Unrelated low',100)]},{name:'clicks.csv',rows:[click('ClickOnly')]}]);
  test('unresolved queue sorts spend and saves an observed click-only tag without typing an ad name',async page=>{
    await prepare(page);await page.locator('#btnMap').click();
    assert.match(await page.locator('#tblMatch tbody tr').first().innerText(),/Unrelated high/);
    assert.equal(await page.locator('#tblMatch tbody tr td:nth-child(2) .pill').first().innerText(),'Belum terhubung');
    await page.locator('#matchSearch').fill('high');
    assert.equal(await page.locator('#tblMatch tbody tr[data-map-row]').count(),1);
    await page.locator('[data-edit-map]').first().click();
    await page.locator('#mapTagSearch').fill('click');
    await page.selectOption('#mapTagPicker','ClickOnly');
    assert.match(await page.locator('#mapPreview').innerText(),/Unrelated high.*ClickOnly/s);
    await page.locator('#btnApplyMap').click();
    assert.equal(await page.evaluate(()=>RESULT.adUnits.find(x=>x.adName==='Unrelated high').tag),'ClickOnly');
    assert.match(await page.locator('#mapStatus').innerText(),/Tersimpan/);
    assert.equal(await page.evaluate(()=>Object.values(JSON.parse(localStorage.getItem('adash_map_v3_default'))).includes('ClickOnly')),true);
    await page.selectOption('#matchFilter','all');await page.locator('[data-edit-map]').first().click();
    await page.locator('#mapTagSearch').fill('bravo');await page.selectOption('#mapTagPicker','Bravo');await page.locator('#btnApplyMap').click();
    assert.equal(await page.evaluate(()=>RESULT.adUnits.find(x=>x.adName==='Unrelated high').tag),'Bravo');
    await page.locator('[data-remove-map]').first().click();
    assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('adash_map_v3_default'))),{});
  });
  test('same-name IDs map independently while legacy names stay visibly shared',async page=>{
    await page.evaluate(()=>localStorage.setItem('adash_map_v3_default',JSON.stringify({shared:'Alpha'})));
    await upload(page,[{name:'aff.csv',rows:[aff('1','Alpha'),aff('2','Bravo')]},{name:'ads.csv',rows:[{...ad('Shared',300),'Ad ID':'101'},{...ad('Shared',100),'Ad ID':'102'}]}]);
    await page.locator('#btnMap').click();await page.selectOption('#matchFilter','all');
    assert.match(await page.locator('#tblMatch').innerText(),/nama bersama/);
    await page.locator('[data-edit-map]').first().click();await page.selectOption('#mapTagPicker','Bravo');await page.locator('#btnApplyMap').click();
    assert.deepEqual(await page.evaluate(()=>RESULT.adUnits.map(u=>[u.adId,u.tag]).sort()),[['101','Bravo'],['102','Alpha']]);
    await page.reload();await page.waitForFunction(()=>window.__dailyStore);
    assert.deepEqual(await page.evaluate(()=>map()),{shared:'Alpha','@id:101':'Bravo'});
  });
  test('an observed Meta date gap keeps costs unavailable until its period is confirmed',async page=>{
    await upload(page,[{name:'aff.csv',rows:[aff('1','Alpha','2026-08-01'),aff('2','Alpha','2026-08-03')]},{name:'ads.csv',rows:[ad('Alpha',100,'2026-08-01'),ad('Alpha',100,'2026-08-03')]}]);
    assert.equal(await page.evaluate(()=>RESULT.kpi.spend),null);
    await page.locator('[data-confirm-source="ads"]').click();await page.locator('#btnConfirmSource').click();
    assert.equal(await page.evaluate(()=>RESULT.kpi.spend),200);
    assert.equal(await page.evaluate(()=>RESULT.tags[0].decisionReady),false,'affiliate observation still has an unconfirmed gap');
    await page.locator('[data-clear-source="ads"]').click();assert.equal(await page.evaluate(()=>RESULT.kpi.spend),null);
  });
  test('accepting partial Meta retains unknown totals after feedback is closed',async page=>{
    await upload(page,[{name:'aff.csv',rows:[aff()]},{name:'ads.csv',rows:[ad('Alpha',100),{...ad('Alpha',200),'Amount spent (IDR)':'broken'}]}]);
    await page.locator('[data-accept-import]').click();await page.locator('#btnClearFeedback').click();
    assert.equal(await page.evaluate(()=>RESULT.kpi.spend),null);
    assert.equal(await page.evaluate(()=>RESULT.readiness.observedSpend),100);
    assert.match(await page.locator('#gapBody').innerText(),/Sebagian data/);
  });
  test('mapping failure does not claim stored state or change the analysis',async page=>{
    await prepare(page);await page.locator('#btnMap').click();await page.locator('[data-edit-map]').first().click();await page.selectOption('#mapTagPicker','Alpha');
    await page.evaluate(()=>{Storage.prototype.setItem=function(){throw new Error('quota')};});await page.locator('#btnApplyMap').click();
    assert.match(await page.locator('#mapStatus').innerText(),/gagal disimpan/i);
    assert.notEqual(await page.evaluate(()=>RESULT.adUnits.find(x=>x.adName==='Unrelated high').tag),'Alpha');
  });
  for(const action of ['switch','reset'])test(`mapping dialog and retained handlers cannot write after ${action}`,async page=>{
    await prepare(page);await page.locator('#btnMap').click();await page.locator('[data-edit-map]').first().click();await page.selectOption('#mapTagPicker','Alpha');
    await page.evaluate(()=>{window.__oldApply=document.getElementById('btnApplyMap').onclick;});
    if(action==='switch')await page.evaluate(()=>{document.getElementById('account').value='Account B';document.getElementById('account').dispatchEvent(new Event('change'));});
    else {page.once('dialog',d=>d.accept());await page.evaluate(()=>document.getElementById('btnReset').click());}
    await page.evaluate(()=>window.__oldApply());
    assert.equal(await page.locator('#mapModal').isVisible(),false);
    assert.equal(await page.evaluate(()=>localStorage.getItem('adash_map_v3_Account B')),null);
    assert.equal(await page.evaluate(()=>localStorage.getItem('adash_map_v3_default')),null);
  });
  test('mapping JSON preview states merge scope and rejects unknown targets',async page=>{
    await prepare(page);await page.locator('#btnMap').click();
    const value={version:1,account:'Exported account',mappings:{'@name:Unrelated high':'Alpha'}};
    await page.setInputFiles('#importMapFile',{name:'mapping.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(value))});
    await page.locator('#mapImportPreview').waitFor({state:'visible'});
    assert.match(await page.locator('#mapImportPreview').innerText(),/Exported account.*default.*Gabung/s);
    assert.equal(await page.evaluate(()=>localStorage.getItem('adash_map_v3_default')),null);
    await page.locator('#btnMergeMap').click();
    const download=page.waitForEvent('download');await page.locator('#btnExportMap').click();const exported=JSON.parse(await readDownload(await download));
    assert.equal(exported.account,'default');assert.equal(exported.mappings['@name:Unrelated high'],'Alpha');
    value.mappings['@name:Unrelated low']='NeverObserved';
    await page.setInputFiles('#importMapFile',{name:'unknown.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(value))});
    await page.waitForFunction(()=>document.getElementById('mapStatus').textContent.includes('belum ditemukan'));
    assert.match(await page.locator('#mapStatus').innerText(),/belum ditemukan/);
    assert.equal(await page.locator('#mapImportPreview').isVisible(),false);
  });
  test('missing Meta is unavailable until a scoped no-Meta declaration and null snapshots survive',async page=>{
    await upload(page,[{name:'affiliate.csv',rows:[aff()]}]);
    assert.equal(await page.evaluate(()=>RESULT.kpi.spend),null);
    assert.match(await page.locator('#kpis').innerText(),/Spend Iklan[\s\S]*?—/i);
    await page.locator('#btnSave').click();assert.equal(await page.evaluate(()=>snaps().length),1);
    await page.locator('#btnNoMeta').click();
    assert.match(await page.locator('#sourceConfirmText').innerText(),/default.*2026-08-01/s);
    await page.locator('#btnConfirmSource').click();
    assert.equal(await page.evaluate(()=>RESULT.kpi.spend),0);
    assert.match(await page.locator('#gapBody').innerText(),/Tidak menjalankan Meta/);
    await page.selectOption('#account','Account B');await upload(page,[{name:'other.csv',rows:[aff()]}]);assert.equal(await page.evaluate(()=>RESULT.kpi.spend),null);
  });
  test('mapping imports keep the latest file and cancel stale reads and previews',async page=>{
    await prepare(page);await page.locator('#btnMap').click();
    await page.evaluate(()=>{const original=File.prototype.text;window.pendingMappings={};File.prototype.text=function(){const file=this;return new Promise(resolve=>{window.pendingMappings[file.name]=async()=>resolve(await original.call(file))})}});
    const select=async(name,tag)=>page.setInputFiles('#importMapFile',{name,mimeType:'application/json',buffer:Buffer.from(JSON.stringify({version:1,account:'default',mappings:{'@name:Unrelated high':tag}}))});
    await select('A.json','Alpha');await select('B.json','Bravo');await page.evaluate(()=>pendingMappings['B.json']());await page.locator('#mapImportPreview').waitFor({state:'visible'});await page.evaluate(()=>pendingMappings['A.json']());
    await page.locator('#btnMergeMap').click();assert.equal(await page.evaluate(()=>map()['@name:Unrelated high']),'Bravo');
    await select('C.json','Alpha');await page.evaluate(()=>clearMapImport());await page.evaluate(()=>pendingMappings['C.json']());assert.equal(await page.locator('#mapImportPreview').isVisible(),false);
    await select('D.json','Alpha');await page.evaluate(()=>pendingMappings['D.json']());await page.locator('#mapImportPreview').waitFor({state:'visible'});await page.evaluate(()=>recalc());assert.equal(await page.locator('#mapImportPreview').isVisible(),false);
  });
  test('click differences are descriptive and blocked decisions are visible',async page=>{
    await prepare(page);
    assert.doesNotMatch(await page.locator('#clickKpis').innerText(),/Klik Hilang|terbuang|karena dibagikan|tidak sampai/);
    assert.match(await page.locator('#dgrid').innerText(),/Perlu diperiksa/i);
  });
  test('unknown costs remain unavailable inside tag and daily breakdowns',async page=>{
    await upload(page,[{name:'aff.csv',rows:[aff()]}]);
    await page.locator('#tblMain tbody tr[data-bd]').click();
    assert.equal(await page.locator('#tblMain .daytbl tbody tr td').nth(3).innerText(),'—');
    await page.locator('[data-tab="harian"]').click();await page.locator('#tblDaily tbody tr[data-day]').click();
    assert.equal(await page.locator('#tblDaily .daytbl tbody tr td').nth(3).innerText(),'—');
  });
  test('keyboard users can expand mapping backup controls and reach export',async page=>{
    await prepare(page);await page.locator('#btnMap').click();await page.locator('.saved-mappings summary').focus();await page.keyboard.press('Space');await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(()=>document.activeElement.id),'btnExportMap');
  });
  test('accepted diagnostics release row arrays while kept file data remains available',async page=>{
    await prepare(page);await upload(page,[{name:'duplicate.csv',rows:[aff('1','Alpha'),aff('2','Bravo')]}]);
    assert.equal(await page.evaluate(()=>IMPORT_REPORTS.every(r=>!r.parsed||!r.parsed.rows)),true);
    assert.equal(await page.evaluate(()=>FILES.every(f=>f.rowsData.length>0)),true);
  });
  if(process.env.MATCHING_SCREENSHOTS)test('matching picker fits mobile and traps keyboard focus',async page=>{
    await prepare(page);await page.locator('#btnMap').click();await page.locator('[data-edit-map]').first().click();
    fs.mkdirSync(process.env.MATCHING_SCREENSHOTS,{recursive:true});
    for(const width of [1440,390]){await page.setViewportSize({width,height:900});await page.screenshot({path:path.join(process.env.MATCHING_SCREENSHOTS,`matching-${width}.png`)});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.getElementById('mapModal').contains(document.activeElement)),true);}
  });
  let failed=0;
  try{for(const {name,run}of cases){const context=await harness.browser.newContext({viewport:{width:1440,height:1000}});const page=await context.newPage();page.setDefaultTimeout(2500);const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.addInitScript(()=>{localStorage.setItem('adash_accounts_v3',JSON.stringify(['default','Account B']));localStorage.setItem('adash_active_v3','default');});try{await page.goto(harness.url);await page.waitForFunction(()=>window.__dailyStore);await run(page);assert.deepEqual(errors,[]);console.log('PASS '+name);}catch(e){failed++;console.error('FAIL '+name+'\n'+e.message);}finally{await context.close();}}}finally{await harness.close();}console.log(`${cases.length-failed}/${cases.length} matching UI tests passed`);if(failed)process.exitCode=1;
}
if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1;});
