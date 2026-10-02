'use strict';
const assert = require('node:assert/strict');
const {IDBFactory, IDBKeyRange, IDBObjectStore} = require('fake-indexeddb');
const A = require('./daily-agg'), DS = require('./daily-store');
global.IDBKeyRange = IDBKeyRange;
const aff = (id, date='2026-08-01', status='Selesai', tag='Alpha') => ({'ID Pemesanan':id,'Waktu Pemesanan':date+' 10:00:00','Status Pesanan':status,'Tag_link1':tag,'Total Komisi per Produk(Rp)':'200'});
const ad = (id, extra={}) => ({'Ad ID':id,'Ad name':'Same','Reporting starts':'2026-08-01','Amount spent (IDR)':'100',...extra});
const item = (kind, rows) => ({kind,records:[],rawRows:rows,fileHash:A.hashRows(rows),fileName:kind+'.csv',sourceRows:rows.length});
const replace = (kind='affiliate',start='2026-08-01',end=start) => ({replacementRanges:[{kind,start,end}]});
const tests=[]; const test=(name,fn)=>tests.push({name,fn});
async function setup(){global.indexedDB=new IDBFactory();const store=await DS.open();return {store,account:await store.ensureAccount('shopee','One')};}
const snapshot = async (s,id) => { const x=await s.exportAccount(id); delete x.exported_at; return x; };

test('batch API exists',async()=>{const {store}=await setup();assert.equal(typeof store.saveBatch,'function');store.close();});
test('corrected pending commission replaces 200 with done 200, not 400',async()=>{
 const {store:s,account:a}=await setup();
 await s.saveDaily(a.id,'affiliate',[],item('affiliate',[aff('one',undefined,'Tertunda')]));
 await s.saveBatch(a.id,[item('affiliate',[aff('one')])],replace());
 const [d]=await s.range(a.id,'affiliate'); assert.equal(d.comm,200);assert.equal(d.comm_done,200);assert.equal(d.comm_pending,0);assert.equal(d.rows,1);s.close();
});
test('complete range removes absent tags and dates, restores identical rows and preserves outside/account',async()=>{
 const {store:s,account:a}=await setup(), b=await s.ensureAccount('shopee','Two');
 const rows=[aff('before','2026-07-31'),aff('keep'),aff('absent',undefined,undefined,'Gone'),aff('gone-day','2026-08-02'),aff('after','2026-08-03')];
 await s.saveBatch(a.id,[item('affiliate',rows)]);await s.saveBatch(b.id,[item('affiliate',rows)]);
 const other=await snapshot(s,b.id);
 const r=await s.saveBatch(a.id,[item('affiliate',[aff('keep'),aff('changed-before','2026-07-31'),aff('new-after','2026-08-04')])],replace('affiliate','2026-08-01','2026-08-02'));
 assert.equal(r.removed,3); assert.deepEqual((await s.range(a.id,'affiliate')).map(x=>[x.date,x.tag,x.comm]),[['2026-07-31','Alpha',200],['2026-08-01','Alpha',200],['2026-08-03','Alpha',200]]);
 assert.deepEqual(await snapshot(s,b.id),other);assert.equal((await s.knownRowHashes(a.id,'affiliate')).size,3);DS.validateBackup(await s.exportAccount(a.id));s.close();
});
test('empty complete period is valid; replacements require explicit valid bounds and full raw rows',async()=>{
 const {store:s,account:a}=await setup();await s.saveBatch(a.id,[item('affiliate',[aff('old')])]);
 for(const options of [{replacementRanges:[{kind:'affiliate',start:'2026-08-01'}]},replace('affiliate','2026-08-02','2026-08-01')]) await assert.rejects(s.saveBatch(a.id,[item('affiliate',[])],options),/rentang|Rentang|Tanggal/);
 await assert.rejects(s.saveBatch(a.id,[{kind:'affiliate',records:A.aggregateAffiliate([aff('old')])}],replace()),/rawRows|baris sumber/);
 await s.saveBatch(a.id,[item('affiliate',[])],replace());assert.deepEqual(await s.range(a.id,'affiliate'),[]);assert.equal((await s.knownRowHashes(a.id,'affiliate')).size,0);s.close();
});
test('overlapping files dedupe within one transaction and repeated imports are no-ops',async()=>{
 const {store:s,account:a}=await setup(), items=[item('affiliate',[aff('one')]),item('affiliate',[aff('one'),aff('two')])];
 const r=await s.saveBatch(a.id,items);assert.equal(r.duplicates,1);assert.equal((await s.range(a.id,'affiliate'))[0].comm,400);
 assert.equal((await s.saveBatch(a.id,items)).skipped,2);assert.equal((await s.range(a.id,'affiliate'))[0].comm,400);
 await s.saveBatch(a.id,items,replace());assert.equal((await s.range(a.id,'affiliate'))[0].comm,400);s.close();
});
test('failure after deletion and writes rolls back every kind, hash, and upload log',async()=>{
 const {store:s,account:a}=await setup();await s.saveBatch(a.id,[item('affiliate',[aff('old')]),item('ads',[ad('old')])]);const before=await snapshot(s,a.id);
 const original=IDBObjectStore.prototype.add;let wrote=false;
 IDBObjectStore.prototype.add=function(record,...rest){if(this.name==='ads'&&record.ad_id==='new'){assert.equal(wrote,true);throw new Error('simulated quota failure');}if(this.name==='affiliate')wrote=true;return original.call(this,record,...rest);};
 try {await assert.rejects(s.saveBatch(a.id,[item('affiliate',[aff('new')]),item('ads',[ad('new')])],{replacementRanges:[...replace().replacementRanges,...replace('ads').replacementRanges]}),/simulated quota/);}finally{IDBObjectStore.prototype.add=original;}
 assert.deepEqual(await snapshot(s,a.id),before);s.close();
});
test('partial source evidence persists in backups and cannot replace a complete period',async()=>{
 const {store:s,account:a}=await setup();const partial={...item('ads',[ad('partial')]),sourceState:'partial'};
 await s.saveBatch(a.id,[partial]);assert.equal((await s.uploadHistory(a.id))[0].source_state,'partial');
 const backup=JSON.parse(DS.serializeBackup(await s.exportAccount(a.id)));assert.equal(backup.uploads[0].source_state,'partial');
 await assert.rejects(s.saveBatch(a.id,[partial],replace('ads')),/parsial|sebagian/);s.close();
});
test('replacing or deleting one day retains partial Meta evidence on all outside aggregates',async()=>{
 const {store:s,account:a}=await setup();const rows=[ad('a'),ad('b',{'Reporting starts':'2026-08-02'})];
 await s.saveBatch(a.id,[{...item('ads',rows),sourceState:'partial'}]);
 await s.saveBatch(a.id,[{...item('ads',[ad('a')]),sourceState:'loaded'}],replace('ads'));
 const saved=await s.range(a.id,'ads');assert.notEqual(saved.find(x=>x.date==='2026-08-01').source_partial,true);assert.equal(saved.find(x=>x.date==='2026-08-02').source_partial,true);
 const backup=JSON.parse(DS.serializeBackup(await s.exportAccount(a.id)));assert.equal(backup.ads.find(x=>x.date==='2026-08-02').source_partial,true);
 await s.deleteDay(a.id,'ads','2026-08-01');assert.equal((await s.range(a.id,'ads'))[0].source_partial,true);s.close();
});
test('v2 identity migration preserves saved timestamps and never invents ad creation identities',async()=>{
 global.indexedDB=new IDBFactory();
 const opening=indexedDB.open(DS.DB_NAME,2);
 opening.onupgradeneeded=()=>{const db=opening.result;const accounts=db.createObjectStore('accounts',{keyPath:'id',autoIncrement:true});accounts.createIndex('kind_name',['kind','name'],{unique:true});accounts.add({id:1,kind:'shopee',name:'Legacy'});
 const ads=db.createObjectStore('ads',{keyPath:'id',autoIncrement:true});ads.createIndex('acct_date_unit',['account_id','date','ad_unit'],{unique:true});ads.createIndex('acct_date',['account_id','date']);
 const record=A.aggregateAds([ad('')])[0];delete record.ad_key;delete record.ad_id;ads.add({...record,account_id:1,created_at:'2026-08-05T10:00:00Z'});};
 const old=await new Promise((resolve,reject)=>{opening.onsuccess=()=>resolve(opening.result);opening.onerror=()=>reject(opening.error);});old.close();
 const s=await DS.open();const [saved]=await s.range(1,'ads');assert.equal(saved.ad_key,'name:Same');assert.equal(saved.created_at,'2026-08-05T10:00:00Z');
 const backup=await s.exportAccount(1);assert.equal(DS.validateBackup(backup).data.ads[0].ad_key,'name:Same');
 const v2=JSON.parse(JSON.stringify(backup));v2.database_version=2;delete v2.ads[0].ad_key;assert.equal(DS.validateBackup(v2).data.ads[0].ad_key,'name:Same');s.close();
});
test('backup accepts normalized observation cutoff parameters and historical v2 records',async()=>{
 const {store:s,account:a}=await setup();await s.saveBatch(a.id,[item('affiliate',[aff('one')])]);
 const backup=await s.exportAccount(a.id,{observationEnd:'2026-08-05',dateStart:'2026-08-01',dateEnd:'2026-08-01'});
 assert.equal(JSON.parse(DS.serializeBackup(backup)).parameters.observationEnd,'2026-08-05');
 backup.database_version=2;assert.equal(DS.validateBackup(backup).data.affiliate.length,1);s.close();
});
test('ad identity preserves same-name IDs and creation dates through backup',async()=>{
 const {store:s,account:a}=await setup();const rows=[ad('a'),ad('b'),ad('',{'Created time':'2026-07-01'}),ad('',{'Created time':'2026-07-02'}),ad('',{})];
 await s.saveBatch(a.id,[item('ads',rows)]);const saved=await s.range(a.id,'ads');assert.equal(saved.length,5);assert.equal(new Set(saved.map(x=>x.ad_key)).size,5);assert.ok(saved.every(x=>x.ad_unit==='Same'));
 const backup=JSON.parse(DS.serializeBackup(await s.exportAccount(a.id)));const b=await s.ensureAccount('shopee','Copy');await s.importAccount(b.id,backup,{replace:true});assert.deepEqual((await s.range(b.id,'ads')).map(x=>x.ad_key).sort(),saved.map(x=>x.ad_key).sort());s.close();
});
(async()=>{let failed=0;for(const {name,fn} of tests){try{await fn();console.log('PASS',name);}catch(e){failed++;console.error('FAIL',name,'\n',e.stack);}}if(failed)process.exitCode=1;else console.log(`${tests.length} daily batch tests passed`);})();
