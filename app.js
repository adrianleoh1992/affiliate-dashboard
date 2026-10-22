'use strict';
const E=window.Engine,$=id=>document.getElementById(id);
let DATA={affiliate:[],ads:[],clicks:[],placement:[]},FILES=[],RESULT=null,CHARTS={},SORT={key:'spend',dir:-1},FILTER=null,STAB=null;
let IMPORT_EPOCH=0, IMPORT_QUEUE=Promise.resolve(), PENDING_IMPORTS=0;
let ROW_KEYS={affiliate:new Set(),ads:new Set(),clicks:new Set(),placement:new Set()};
let IMPORT_REPORTS=[],IMPORT_SEQUENCE=0,TAG_QUERY='',PDF_BUSY=false;
const ACTIVE_READERS=new Set();
const LS={accounts:'adash_accounts_v3',active:'adash_active_v3',map:'adash_map_v3',snaps:'adash_snaps_v3',opts:'adash_opts_v3',theme:'adash_theme_v3'};
/* No seeded mapping. What used to sit here was one account's ad names shipped
   as the default for every account, and it overrode the matcher at full
   confidence — including a wrong entry, telesinvideo1 → TelesinGripvideo2,
   which is exactly the "three ads on one tag" the matcher was fixed to stop.
   A mapping is a fact about one workspace; it belongs in that workspace's own
   saved map, entered once through Kelola Tag. */
const DEFAULT_MAP={};
const esc=E.escapeHtml;
// Indonesian decimals take a comma: "Rp1.2 jt" next to "1.635 pesanan" read as
// one thousand two hundred. The PDF already writes them this way.
function dec(n,d){return Number(n).toFixed(d).replace('.',',')}
function rp(n){if(n==null||!isFinite(n))return'Rp0';let a=Math.abs(n),s=n<0?'-':'';if(a>=1e9)return s+'Rp'+dec(a/1e9,2)+' M';if(a>=1e6)return s+'Rp'+dec(a/1e6,1)+' jt';if(a>=1e3)return s+'Rp'+Math.round(a/1e3)+'rb';return s+'Rp'+Math.round(a)}
function rpShort(n){if(n==null||!isFinite(n))return'—';let a=Math.abs(n),s=n<0?'-':'';if(a>=1e9)return s+dec(a/1e9,1)+'M';if(a>=1e6)return s+dec(a/1e6,1)+'jt';if(a>=1e3)return s+Math.round(a/1e3)+'rb';return s+Math.round(a)}
function full(n){return'Rp'+Math.round(n||0).toLocaleString('id-ID')} function nf(n){return Math.round(n||0).toLocaleString('id-ID')}
function rx(n){return n===Infinity?'∞':Number.isFinite(n)?dec(n,2)+'x':'—'}
let TOAST_TIMER;function toast(s){clearTimeout(TOAST_TIMER);let e=$('toast');e.textContent=s;e.classList.add('show');TOAST_TIMER=setTimeout(()=>e.classList.remove('show'),4000)}
function readStorage(key){try{return localStorage.getItem(key)}catch(e){return null}}
function accounts(){try{const a=JSON.parse(readStorage(LS.accounts));return Array.isArray(a)&&a.length&&a.every(x=>typeof x==='string'&&x.trim())?[...new Set(a)]:['default']}catch(e){return['default']}}
function active(){const a=accounts(),saved=readStorage(LS.active);return a.includes(saved)?saved:a[0]}
function setActive(a){localStorage.setItem(LS.active,a)}
function map(){try{const m=JSON.parse(readStorage(LS.map+'_'+active()));return m&&typeof m==='object'&&!Array.isArray(m)?Object.fromEntries(Object.entries(m).filter(([k,v])=>k&&typeof v==='string')):{...DEFAULT_MAP}}catch(e){return{...DEFAULT_MAP}}}
function saveMap(m){localStorage.setItem(LS.map+'_'+active(),JSON.stringify(m))}
/* Ad ID → tag, learned from exact names (the engine's learnedIds), so an ad
   renamed later keeps its tag. Separate from the manual map: nothing in it is
   typed, and a manual mapping or the current exact name always beats it. */
const ADMAP='adash_admap_v1';
function adIdMap(){try{const m=JSON.parse(readStorage(ADMAP+'_'+active()));return m&&typeof m==='object'&&!Array.isArray(m)?Object.fromEntries(Object.entries(m).filter(([k,v])=>/^\d+$/.test(k)&&typeof v==='string'&&v)):{}}catch(e){return{}}}
function rememberAdIds(learned,forget){const m=adIdMap();let changed=false;Object.entries(learned||{}).forEach(([k,v])=>{if(m[k]!==v){m[k]=v;changed=true}});(forget||[]).forEach(k=>{if(k in m){delete m[k];changed=true}});if(changed)try{localStorage.setItem(ADMAP+'_'+active(),JSON.stringify(m))}catch(e){}}
const SNAP_STATUSES=new Set(['scale','pantau','stop','organik','evaluasi']);
function validSnapshot(x){
  if(!x||typeof x!=='object'||!Number.isSafeInteger(x.id)||x.id<0||typeof x.saved!=='string'||!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?$/.test(x.saved)||!Number.isFinite(Date.parse(x.saved.replace(' ','T'))))return false;
  if(!x.range||!E.isDate(x.range.start)||!E.isDate(x.range.end)||x.range.start>x.range.end)return false;
  if(!x.kpi||!['spend','commEff','netEff'].every(k=>Number.isFinite(x.kpi[k])))return false;
  if(!Object.entries(x.kpi).every(([k,v])=>k==='counts'?v&&typeof v==='object'&&!Array.isArray(v)&&Object.entries(v).every(([status,n])=>SNAP_STATUSES.has(status)&&Number.isSafeInteger(n)&&n>=0):v===null||Number.isFinite(v)))return false;
  return Array.isArray(x.tags)&&x.tags.length<=20000&&x.tags.every(t=>t&&typeof t.tag==='string'&&typeof t.label==='string'&&typeof t.reason==='string'&&SNAP_STATUSES.has(t.status)&&Object.entries(t).every(([k,v])=>['tag','label','reason','status'].includes(k)||v===null||Number.isFinite(v)));
}
function snaps(){try{const a=JSON.parse(readStorage(LS.snaps+'_'+active()));return Array.isArray(a)?a.filter(validSnapshot).filter(s=>!s.account||s.account===active()).slice(0,120):[]}catch(e){return[]}}
function saveSnaps(a){localStorage.setItem(LS.snaps+'_'+active(),JSON.stringify(a.slice(0,120)))}
function renderAccounts(){let a=accounts(),s=$('account');s.innerHTML=a.map(x=>`<option value="${esc(x)}">${esc(x)}</option>`).join('');s.value=active();if($('flowAccount'))$('flowAccount').textContent=active()}
// The sticky header is one to three rows tall depending on width (and not
// sticky on phones). Keyboard focus scrolls items to just below it, not under it.
(function(){const hdr=document.querySelector('header');if(!hdr)return;
  const fit=()=>{document.documentElement.style.scrollPaddingTop=(getComputedStyle(hdr).position==='sticky'?hdr.offsetHeight+8:16)+'px'};
  if(window.ResizeObserver)new ResizeObserver(fit).observe(hdr);addEventListener('resize',fit);fit()})();
function applyTheme(t){t=t==='dark'?'dark':'light';document.documentElement.setAttribute('data-theme',t);$('btnTheme').setAttribute('aria-pressed',String(t==='dark'));try{localStorage.setItem(LS.theme,t)}catch(e){}if(RESULT)render()}
applyTheme(readStorage(LS.theme)||'light');renderAccounts();
$('btnTheme').onclick=()=>applyTheme(document.documentElement.getAttribute('data-theme')==='dark'?'light':'dark');
$('account').onchange=()=>{try{setActive($('account').value);reset();loadOpts();renderHistory()}catch(e){toast('Penyimpanan akun tidak tersedia')}renderAccounts()};
$('btnNewAcct').onclick=()=>{let n=prompt('Nama akun baru');if(!n||!n.trim())return;n=n.trim();try{let a=accounts();if(!a.includes(n))a.push(n);localStorage.setItem(LS.accounts,JSON.stringify(a));setActive(n);reset();renderAccounts();loadOpts();renderHistory();toast('Akun dipilih: '+n)}catch(e){toast('Penyimpanan akun tidak tersedia')}};
// The whole card is the drop target; the three boxes are for reading and
// deleting, not for routing. File type comes from the header row either way,
// so a file dropped on the wrong box still lands in the right place.
const drop=$('uploadCard');
['dragenter','dragover'].forEach(x=>drop.addEventListener(x,e=>{e.preventDefault();drop.classList.add('over')}));
['dragleave','drop'].forEach(x=>drop.addEventListener(x,e=>{e.preventDefault();drop.classList.remove('over')}));
drop.addEventListener('drop',e=>files(e.dataTransfer.files));
// Keep each File reference until reading completes. Account/reset cancels pending reads.
$('files').onchange=e=>files(e.target.files);
document.querySelectorAll('[data-zpick]').forEach(b=>b.onclick=e=>{e.stopPropagation();$('files').click()});
document.querySelectorAll('[data-zdel]').forEach(b=>b.onclick=e=>{e.stopPropagation();rmZone(b.dataset.zdel)});
function parseFile(file){return new Promise((resolve,reject)=>{
  if(/\.xlsx?$/i.test(file.name))return reject(new Error('Ekspor ulang sebagai CSV, bukan file Excel.'));
  if(file.size>75*1024*1024)return reject(new Error('File melebihi 75 MB. Pecah laporan menjadi periode lebih pendek.'));
  const reader=new FileReader();ACTIVE_READERS.add(reader);
  const done=()=>ACTIVE_READERS.delete(reader);
  reader.onerror=()=>{done();reject(new Error('File tidak dapat dibaca. Pilih kembali file dari perangkat.'))};
  reader.onabort=()=>{done();reject(new Error('Pembacaan dibatalkan'))};
  reader.onload=()=>{
    done();try{
      const bytes=new Uint8Array(reader.result);let encoding='utf-8';
      if(bytes[0]===0xff&&bytes[1]===0xfe)encoding='utf-16le';else if(bytes[0]===0xfe&&bytes[1]===0xff)encoding='utf-16be';
      const text=new TextDecoder(encoding,{fatal:true}).decode(bytes);
      resolve(DashboardImport.parseText(text,{fileName:file.name}));
    }catch(e){reject(new Error(e instanceof TypeError?'Teks bukan UTF-8/UTF-16 yang valid. Ekspor ulang sebagai CSV UTF-8.':e.message))}
  };
  reader.readAsArrayBuffer(file);
})}
function updateImportUI(){
  $('importProgress').classList.toggle('hidden',!PENDING_IMPORTS);
  $('uploadCard').setAttribute('aria-busy',PENDING_IMPORTS?'true':'false');
  $('flowImport').classList.toggle('done',FILES.length>0&&!PENDING_IMPORTS);
  $('flowAnalyze').classList.toggle('done',!!RESULT&&!PENDING_IMPORTS);
  // Once the numbers are on screen the three-step guide has done its job.
  // A second report being read keeps the current numbers on screen, so the
  // guide stays hidden instead of pushing the drop area down and back.
  document.body.classList.toggle('has-result',!!RESULT);
  $('flowImportNote').textContent=PENDING_IMPORTS?'Memeriksa file…':FILES.length?FILES.length+' file dimuat':'Unggah laporan CSV';
  $('flowAnalyzeNote').textContent=RESULT?(RESULT.tags.length+' tag · '+RESULT.range.start+' — '+RESULT.range.end):'Menunggu laporan komisi';
  $('btnExport').disabled=!RESULT||PENDING_IMPORTS>0;$('btnPdf').disabled=!RESULT||PENDING_IMPORTS>0;
  document.querySelectorAll('[data-accept-import]').forEach(b=>b.disabled=PENDING_IMPORTS>0);
}
function renderImportReports(){
  $('importFeedback').classList.toggle('hidden',!IMPORT_REPORTS.length);
  // Files that passed with nothing to say are already listed in the boxes
  // above; repeating each one as a full row pushed the results off screen.
  const clean=IMPORT_REPORTS.length>0&&IMPORT_REPORTS.every(r=>r.state==='accepted'&&r.parsed&&!r.parsed.issues.length&&!r.message);
  const rows=IMPORT_REPORTS.map(report=>{
    const p=report.parsed,issues=p?p.issues:[],state={accepted:'Siap dianalisis',review:'Perlu diperiksa',error:'Tidak dimuat',duplicate:'Duplikat dilewati'}[report.state]||report.state;
    return `<article class="import-result ${report.state}"><div class="import-result-head"><b>${esc(report.name)}</b><span>${state}</span></div>`
      +(p?`<p>${nf(p.stats.accepted)} baris valid${p.stats.rejected?' · '+nf(p.stats.rejected)+' baris bermasalah':''}${p.period?' · '+esc(p.period.start)+' — '+esc(p.period.end):''}</p>`:'')
      +(report.message?`<p>${esc(report.message)}</p>`:'')
      +(issues.length?`<ul>${issues.slice(0,4).map(issue=>`<li>${issue.row&&!/^Baris\s+\d+/.test(issue.message)?'Baris '+issue.row+': ':''}${esc(issue.message)}</li>`).join('')}</ul>${issues.length>4?'<p>'+nf(issues.length-4)+' catatan lain tersedia di rincian CSV.</p>':''}`:'')
      +(report.state==='review'?`<div class="button-row"><button class="btn sm" data-discard-import="${report.id}">Abaikan file</button><button class="btn sm" data-accept-import="${report.id}">Muat ${nf(p.stats.accepted)} baris valid saja</button></div>`:'')
      +(issues.length?`<button class="btn ghost sm" data-issues="${report.id}">Unduh rincian pemeriksaan</button>`:'')+'</article>';
  }).join('');
  $('importFeedbackRows').innerHTML=clean
    ?`<details class="import-clean"><summary><span class="ok-mark" aria-hidden="true">✓</span>${nf(IMPORT_REPORTS.length)} file lolos pemeriksaan dan siap dianalisis<span class="hint-inline">Lihat per file</span></summary>${rows}</details>`
    :rows;
  $('importFeedbackRows').querySelectorAll('[data-accept-import]').forEach(b=>b.onclick=()=>{
    const report=IMPORT_REPORTS.find(x=>x.id===+b.dataset.acceptImport);if(!report||report.epoch!==IMPORT_EPOCH||report.account!==active()||PENDING_IMPORTS)return;
    commitImport(report);finish();renderImportReports();
  });
  $('importFeedbackRows').querySelectorAll('[data-discard-import]').forEach(b=>b.onclick=()=>{const r=IMPORT_REPORTS.find(x=>x.id===+b.dataset.discardImport);if(r){r.state='error';r.message='File diabaikan oleh pengguna';delete r.parsed.rows}renderImportReports()});
  $('importFeedbackRows').querySelectorAll('[data-issues]').forEach(b=>b.onclick=()=>{
    const r=IMPORT_REPORTS.find(x=>x.id===+b.dataset.issues);if(!r||!r.parsed)return;
    const csv=Papa.unparse(r.parsed.issues.map(x=>({File:r.name,Baris:x.row||'',Jumlah:x.count||1,Tingkat:x.severity,Kolom:x.column||'',Catatan:x.message})),{escapeFormulae:true,newline:'\r\n'});
    downloadBlob(new Blob(['\uFEFF'+csv],{type:'text/csv;charset=utf-8'}),'pemeriksaan-'+DashboardExport.filenamePart(r.name)+'.csv');
  });
}
function commitImport(report){
  const p=report.parsed,rows=p.rows||[],keys=rows.map(rowKey);
  if(!rows.length||keys.every(key=>ROW_KEYS[p.type].has(key))){report.state='duplicate';return false}
  const entry={name:report.name,size:report.size,type:p.type,rows:rows.length,rowsData:rows,quality:[]};
  if(p.stats.rejected)entry.quality.push(`${report.name}: ${p.stats.rejected} baris bermasalah dikecualikan setelah persetujuan pengguna.`);
  entry.quality.push(...p.issues.filter(x=>x.severity==='warning').slice(0,5).map(x=>`${report.name}: ${x.message}`));
  FILES.push(entry);appendRows(entry,keys);report.state='accepted';return true;
}
function rowKey(row){return JSON.stringify(Object.keys(row).sort().map(k=>[k,row[k]]))}
function rebuildData(){
  DATA={affiliate:[],ads:[],clicks:[],placement:[]};
  ROW_KEYS={affiliate:new Set(),ads:new Set(),clicks:new Set(),placement:new Set()};
  FILES.forEach(f=>appendRows(f));
}
function appendRows(f,keys){f.duplicates=0;(f.rowsData||[]).forEach((row,i)=>{const key=keys?keys[i]:rowKey(row);if(ROW_KEYS[f.type].has(key)){f.duplicates++;return}ROW_KEYS[f.type].add(key);DATA[f.type].push(row)})}
function notifyData(){if(typeof window.onDashboardData==='function')window.onDashboardData({files:FILES.slice(),result:RESULT,data:DATA})}
function files(list){
  const ar=[...list||[]];if(!ar.length)return;
  const epoch=IMPORT_EPOCH,account=active();PENDING_IMPORTS++;updateImportUI();
  IMPORT_QUEUE=IMPORT_QUEUE.catch(()=>{}).then(async()=>{
    if(epoch!==IMPORT_EPOCH||account!==active())return;
    let added=0;const pending=[];
    for(let i=0;i<ar.length;i++){
      const file=ar[i],report={id:++IMPORT_SEQUENCE,epoch,account,name:file.name,size:file.size};
      $('importProgressLabel').textContent=`Memeriksa ${i+1}/${ar.length}: ${file.name}`;$('importProgressBar').max=ar.length;$('importProgressBar').value=i;
      await new Promise(resolve=>requestAnimationFrame(resolve));
      try{
        const parsed=await parseFile(file);
        if(epoch!==IMPORT_EPOCH||account!==active())return;
        report.parsed=parsed;
        if(!parsed.ok||parsed.fatal){report.state='error';report.message='Perbaiki catatan berikut lalu pilih ulang file.'}
        else if(parsed.stats.rejected){report.state='review';report.message='Baris bermasalah belum dimuat. Pilihan memuat sebagian data dapat mengubah hasil analisis.'}
        else{report.state='ready';pending.push(report)}
      }catch(err){if(epoch!==IMPORT_EPOCH||account!==active())return;report.state='error';report.message=err.message}
      IMPORT_REPORTS.unshift(report);IMPORT_REPORTS=IMPORT_REPORTS.slice(0,30);renderImportReports();
      $('importProgressBar').value=i+1;
    }
    if(epoch!==IMPORT_EPOCH||account!==active())return;
    pending.forEach(report=>{if(commitImport(report))added++});renderImportReports();
    if(added)finish();
  }).finally(()=>{if(epoch===IMPORT_EPOCH){PENDING_IMPORTS--;if(!PENDING_IMPORTS)$('files').value='';updateImportUI()}});
  return IMPORT_QUEUE;
}
$('btnCancelImport').onclick=()=>{invalidateImports();toast('Pembacaan dibatalkan. Data yang sudah dimuat tetap tersedia.')};
$('btnClearFeedback').onclick=()=>{IMPORT_REPORTS=IMPORT_REPORTS.filter(x=>x.state==='review');renderImportReports()};
function updateDates(){
  let min='',max='';
  for(const [kind,col] of [['affiliate','Waktu Pemesanan'],['ads','Reporting starts'],['clicks','Waktu Klik'],['placement','Reporting starts']]){
    for(const row of DATA[kind]){const d=E.dayOnly(row[col]);if(E.isDate(d)){if(!min||d<min)min=d;if(!max||d>max)max=d}}
  }
  const oldStart=$('dateStart').value,oldEnd=$('dateEnd').value,wasAll=(!oldStart&&!oldEnd)||(oldStart===DATES.min&&oldEnd===DATES.max);
  DATES.min=min;DATES.max=max;
  let start=wasAll?min:oldStart,end=wasAll?max:oldEnd;
  if(min&&max){start=start<min?min:start;end=end>max?max:end;if(start>end){start=min;end=max}}else{start='';end=''}
  $('dateStart').value=start;$('dateEnd').value=end;
}
function clearResult(){
  RESULT=null;STAB=null;FILTER=null;
  updateAnalysisAvailability();
  $('main').classList.add('hidden');$('emptyState').classList.remove('hidden');$('gapCard').classList.add('hidden');
  Object.values(CHARTS).forEach(c=>{try{c.destroy()}catch(e){}});CHARTS={};
}
function finish(){
  renderChips();updateDates();
  if(!DATA.affiliate.length){clearResult();notifyData();return toast('Laporan affiliate belum dimuat')}
  $('emptyState').classList.add('hidden');$('main').classList.remove('hidden');recalc();notifyData();toast('Data dimuat untuk '+active());
}
const ZONE_EMPTY={affiliate:'Belum ada file',ads:'Belum ada file',clicks:'Belum ada file',placement:'Opsional'};
// One box per report instead of one pile. Deleting a whole report used to mean
// hunting its files inside a single list of chips.
function renderChips(){
  ['affiliate','ads','clicks','placement'].forEach(z=>{
    const box=document.querySelector(`[data-zchips="${z}"]`);
    const mine=FILES.map((f,i)=>({f,i})).filter(x=>x.f.type===z);
    box.innerHTML=mine.length?mine.map(({f,i})=>`<span class="chip ${f.type}"><span class="file-row">
      <span class="fname" title="${esc(f.name)}">${esc(f.name)}</span><span>· ${nf(f.rows-f.duplicates)} baris${f.duplicates?' · '+nf(f.duplicates)+' duplikat dilewati':''}</span>
      <button class="rmfile" data-rm="${i}" title="Hapus file ini" aria-label="Hapus ${esc(f.name)}">×</button></span></span>`).join('')
      :`<span class="zone-empty">${ZONE_EMPTY[z]}</span>`;
    document.querySelector(`[data-zone="${z}"]`).classList.toggle('filled',mine.length>0);
    document.querySelector(`[data-zdel="${z}"]`).classList.toggle('hidden',!mine.length);
  });
  let p=[];if(DATA.affiliate.length)p.push('Affiliate '+nf(DATA.affiliate.length));if(DATA.ads.length)p.push('Ads '+nf(DATA.ads.length));if(DATA.clicks.length)p.push('Klik '+nf(DATA.clicks.length));if(DATA.placement.length)p.push('Placement '+nf(DATA.placement.length));$('uploadStatus').textContent=p.join(' · ');
  // Removing one file rebuilds from the survivors, so a mis-drop no longer
  // forces clearing everything and re-uploading all three reports.
  $('zones').querySelectorAll('[data-rm]').forEach(b=>b.onclick=e=>{e.stopPropagation();rmFile(+b.dataset.rm)});
  $('uploadCard').classList.toggle('compact',FILES.length>0);updateImportUI();}
function invalidateImports(){IMPORT_EPOCH++;ACTIVE_READERS.forEach(r=>r.abort());ACTIVE_READERS.clear();PENDING_IMPORTS=0;IMPORT_QUEUE=Promise.resolve();$('files').value='';IMPORT_REPORTS=IMPORT_REPORTS.filter(x=>x.state!=='review'&&x.state!=='ready');renderImportReports();updateImportUI()}
function rmZone(z){
  const n=FILES.filter(f=>f.type===z).length;if(!n)return;
  if(!confirm(`Hapus ${n} file ${z}? Snapshot tersimpan tidak terhapus.`))return;
  invalidateImports();FILES=FILES.filter(f=>f.type!==z);rebuildData();finish();toast(n+' file dihapus');
}
function rmFile(i){
  const f=FILES[i];if(!f)return;
  invalidateImports();FILES.splice(i,1);rebuildData();finish();toast('File dihapus: '+f.name);
}
function reset(){
  invalidateImports();DATA={affiliate:[],ads:[],clicks:[],placement:[]};ROW_KEYS={affiliate:new Set(),ads:new Set(),clicks:new Set(),placement:new Set()};FILES=[];clearResult();
  DATES.min='';DATES.max='';$('dateStart').value='';$('dateEnd').value='';IMPORT_REPORTS=[];TAG_QUERY='';$('tagSearch').value='';renderImportReports();renderChips();updateImportUI();$('uploadStatus').textContent='';notifyData();
}
// Clearing is destructive and used to fire on a single click.
$('btnReset').onclick=()=>{if(!FILES.length)return reset();if(confirm(`Kosongkan ${FILES.length} file yang dimuat? Snapshot tersimpan tidak terhapus.`)){reset();toast('Data dikosongkan')}};
const O=['ppn','targetROI','thScale','thPantau','minSpend','minDays','lagDays','streakDays','pendingFactor'];
const UI_DEFAULTS=Object.fromEntries(O.map(k=>[k,Number($(k).value)]));
O.concat(['dateStart','dateEnd']).forEach(id=>$(id).addEventListener('change',recalc));
function opts(){let o={dateStart:$('dateStart').value,dateEnd:$('dateEnd').value};O.forEach(k=>o[k]=$(k).value===''?UI_DEFAULTS[k]:Number($(k).value));return E.normalizeOptions(o)}
// Presets count back from the last day that has data, not from the real
// calendar today. Uploading on Monday should still show Sunday as "kemarin".
const DATES={min:'',max:''};
function shiftDay(d,n){const t=new Date(d+'T00:00:00Z');t.setUTCDate(t.getUTCDate()+n);return t.toISOString().slice(0,10)}
function presetRange(n){
  if(!DATES.max)return null;
  if(!n)return[DATES.min,DATES.max];
  let s=shiftDay(DATES.max,-(n-1));
  return[s<DATES.min?DATES.min:s,DATES.max];
}
function applyPreset(n){
  const r=presetRange(n); if(!r)return;
  $('dateStart').value=r[0];$('dateEnd').value=r[1];
  recalc();saveOpts();
}
function renderPeriod(){
  const s=$('dateStart').value,e=$('dateEnd').value;
  document.querySelectorAll('[data-days]').forEach(b=>{
    const r=presetRange(+b.dataset.days);
    // A preset that would resolve to the same window as "Semua" is not a
    // separate choice — hide it rather than offer two buttons doing one thing.
    const dup=+b.dataset.days>0&&r&&r[0]===DATES.min;
    b.classList.toggle('hidden',!!dup);
    b.classList.toggle('active',!!r&&r[0]===s&&r[1]===e);
  });
  const days=s&&e?Math.round((new Date(e+'T00:00:00Z')-new Date(s+'T00:00:00Z'))/864e5)+1:0;
  $('pbRange').textContent=s&&e?`${s} s/d ${e} · ${days} hari`:'';
}
document.querySelectorAll('[data-days]').forEach(b=>b.onclick=()=>applyPreset(+b.dataset.days));
$('btnCustomDate').onclick=()=>openModal('setModal');
function recalc(){const o=opts();O.forEach(k=>$(k).value=o[k]);if(o.dateStart&&o.dateEnd&&o.dateStart>o.dateEnd){if(RESULT){$('dateStart').value=RESULT.range.start;$('dateEnd').value=RESULT.range.end}toast('Tanggal mulai harus sebelum tanggal akhir');return}if(!DATA.affiliate.length)return;try{RESULT=E.analyze({...DATA,ads:adsRows(),tagMap:map(),adIdMap:adIdMap()},o);RESULT.placement=window.Placement?Placement.analyze({placement:DATA.placement,affiliate:DATA.affiliate,clicks:DATA.clicks,matchLog:RESULT.matchLog,range:RESULT.range}):null;RESULT.leakPlacement=window.Placement&&RESULT.range.clickStart?Placement.analyze({placement:DATA.placement,affiliate:DATA.affiliate,clicks:DATA.clicks,matchLog:RESULT.matchLog,range:{start:RESULT.range.clickStart,end:RESULT.range.clickEnd}}):null;rememberAdIds(RESULT.learnedIds,RESULT.forgetIds);STAB=null;updateAnalysisAvailability();render()}catch(e){clearResult();toast('Analisis gagal: '+e.message)}}
function render(){if(!RESULT)return;updateImportUI();let r=RESULT,k=r.kpi; if($('settingsPeek'))$('settingsPeek').textContent=`${r.range.start} — ${r.range.end} · PPN ${r.options.ppn}% · target ROI ${r.options.targetROI}%`;renderPeriod();renderGaps();renderBanner();renderKpi();renderClickKpi();renderActions();renderCalibration();renderSynth();renderDecisions();renderMain();renderAttr();renderPlacement();renderUnit();renderLeak();renderDaily();renderCalendar();renderStatus();renderTrend();renderOpportunity();renderDetails();renderMatch();renderCharts()}
function renderActions(){
  const A=RESULT.actions;
  // The advice used to be scattered across rows and never added up. These are
  // the same recommendations expressed as money, which is what gets acted on.
  const cards=[];
  if(A.bidSaving>0)cards.push(['money','Hemat dari Turunkan Bid',rp(A.bidSaving),
    `${A.overbidCount} tag membayar di atas CPC ideal`]);
  // STOP tags still earn commission and are mostly off already, so the headline
  // is this period's loss; gross spend and the rest of the context sit below it.
  if(A.stopSpend>0)cards.push(['risk','Rugi di Tag STOP',rp(A.stopLoss),
    `${A.stopCount} tag · biaya ${rp(A.stopSpend)}, komisi ${rp(A.stopComm)} periode ini`
    +(A.stopLiveCount==null?'':A.stopLiveCount===0?' · semua iklannya sudah mati':` · ${A.stopLiveCount} masih ada iklan nyala`)
    +(A.stopProfitCount?` · ${A.stopProfitCount} tag masih untung`:'')
    +(A.leakStopCount?` · ${A.leakStopCount} tag cek link dulu`:'')]);
  // Leaking STOP tags are already inside the STOP card; counting them here too
  // would claim the same rupiah twice in one strip.
  if(A.leakWasteLive>0)cards.push(['risk','Hilang karena Link',rp(A.leakWasteLive),
    `${A.leakLiveCount} tag di luar STOP · biaya klik tak sampai Shopee (maks.)`]);
  // A trailing summary, not a fourth tile. It adds profit changes only: gross
  // STOP spend is not a saving while those tags still earn commission.
  const tail=A.maxGain>0?`<div class="action-card info"><div class="a-label">Potensi perbaikan laba</div><div class="a-val">${rp(A.maxGain)}</div><div class="a-copy">batas atas · bid + rugi tag STOP periode ini</div></div>`:'';
  $('actionGrid').innerHTML=cards.map(c=>`<div class="action-card ${c[0]}">
    <div class="a-label">${c[1]}</div><div class="a-val">${c[2]}</div><div class="a-copy">${c[3]}</div></div>`).join('')+tail;
}
function renderCalibration(){
  const L=RESULT.lagCal,el=$('lagCal');
  if(!L||!L.sampleSize){el.innerHTML='';el.className='calibration hidden';return}
  // Lag is the single most decision-changing setting, so show whether the
  // current value actually matches this account's observed behaviour.
  let unstable=0;
  try{if(!STAB)STAB=E.stability({...DATA,ads:adsRows(),tagMap:map(),adIdMap:adIdMap()},RESULT.options,[0,3,5,7]);unstable=STAB.unstable}catch(e){STAB=null}
  const warn=!L.matches||unstable>0;
  el.className='calibration'+(warn?' warn':'');
  const parts=[];
  parts.push(L.matches
    ? `Lag atribusi <b>${L.current} hari</b> sudah sesuai data: ${L.coverage}% pesanan masuk dalam H+${L.suggested}.`
    : `Lag atribusi disetel <b>${L.current} hari</b>, tapi data menunjukkan <b>${L.suggested} hari</b> (${L.coverage}% pesanan masuk dalam H+${L.suggested}). <button class="btn sm" id="btnApplyLag">Pakai ${L.suggested} hari</button>`);
  if(unstable>0)parts.push(`<b>${unstable} vonis berubah</b> bila lag digeser — ditandai di kolom Tag.`);
  el.innerHTML=parts.join(' ');
  const b=$('btnApplyLag');
  if(b)b.onclick=()=>{$('lagDays').value=L.suggested;recalc();saveOpts();toast('Lag disetel ke '+L.suggested+' hari')};
}
function renderOpportunity(){
  const A=RESULT.actions,C=A.concentration;
  $('tblOrganic').querySelector('thead').innerHTML='<tr>'+['Tag','Komisi Total','Order','Komisi/Order','Maks Biaya/Order','Kanal Utama'].map((h,i)=>`<th class="${i&&i<5?'num':''}">${h}</th>`).join('')+'</tr>';
  $('tblOrganic').querySelector('tbody').innerHTML=A.organicCandidates.length
    ? A.organicCandidates.map(c=>`<tr><td><b>${esc(c.tag)}</b></td>
      <td class="num">${rp(c.comm)}</td><td class="num">${nf(c.orders)}</td>
      <td class="num">${rp(c.avgComm)}</td><td class="num col-ideal"><b>${rp(c.maxCpa)}</b></td>
      <td>${esc(c.topPlatform||'—')}</td></tr>`).join('')
    : `<tr><td colspan="6" style="text-align:center;color:var(--text-mute);padding:22px">Belum ada tag organik dengan komisi.</td></tr>`;
  if(!C){$('concentration').innerHTML='<p class="hint">Belum ada tag berbayar.</p>';return}
  const G=C.groups||[];
  if(G.length&&C.rest){
    // Pareto by spend: the head that earns and the tail that burns. The top-3
    // rule needs enough tags, or any account with four or five tags trips it.
    const pc=v=>dec(v,1)+'%',cs=g=>C.paidComm>0?pc(g.commShare):'—',last=G[G.length-1],g3=G.find(g=>g.n===3);
    const risky=C.topShare>=35||!!(g3&&C.count>=6&&g3.spendShare>=60),head=C.topShare>=35?G[0]:g3;
    const bar=(v,c)=>`<span class="minibar" style="width:${Math.max(0,Math.min(100,v)).toFixed(1)}%;background:var(${c})"></span>`;
    const row=(label,g,title)=>`<tr><td${title?` title="${esc(title)}"`:''}>${label}</td><td class="num">${pc(g.spendShare)}</td><td class="barcell">${bar(g.spendShare,'--accent')}</td>
      <td class="num">${cs(g)}</td><td class="barcell">${bar(g.commShare,'--ok')}</td><td class="num">${g.spend>0?rx(g.roasEff):'—'}</td></tr>`;
    $('concentration').innerHTML=`<p class="hint conc-head"><b>${last.n} tag dengan biaya terbesar</b> memakan ${pc(last.spendShare)} biaya iklan dan menghasilkan ${cs(last)} komisi efektif iklan; ${nf(C.rest.n)} tag lainnya memakan ${pc(C.rest.spendShare)} biaya dengan ROAS ${rx(C.rest.roasEff)}.</p>
      ${risky?`<div class="riskbox conc-risk"><strong>${head.n===1?esc(C.topTag):head.n+' tag'} menyerap ${pc(head.spendShare)} biaya iklan</strong> dan menghasilkan ${cs(head)} komisi efektif iklan. Kalau produknya bermasalah, sebagian besar anggaran ikut terdampak.</div>`:''}
      <div class="tscroll"><table class="conc-tbl"><thead><tr><th>Kelompok (urut biaya)</th><th class="num">Porsi biaya</th><th class="barcell"></th><th class="num">Porsi komisi efektif</th><th class="barcell"></th><th class="num">ROAS</th></tr></thead><tbody>${
      G.map(g=>row(g.n===1?`1 tag teratas (${esc(C.topTag)})`:`${g.n} tag teratas`,g,g.n>1?g.tags.join(', '):'')).join('')
      }${row(`${nf(C.rest.n)} tag di luar ${last.n} teratas`,C.rest,'')}</tbody></table></div>
      <p class="hint conc-foot">Porsi komisi dihitung dari komisi efektif tag berbayar (dasar ROAS Iklan); komisi organik tidak dihitung.${C.noComm&&C.noComm.n?` ${nf(C.noComm.n)} nama iklan berbiaya (${pc(C.noComm.spendShare)} biaya) tidak ada di laporan komisi dan dihitung berkomisi 0 — sebagian bisa salah sambung; periksa di Kelola Tag.`:''}</p>`;
    return;
  }
  const risky=C.topShare>=35;
  $('concentration').innerHTML=risky
    ? `<div class="riskbox"><strong>${esc(C.topTag)} menyerap ${C.topShare.toFixed(0)}% biaya iklan</strong>
       dengan ROAS ${rx(C.topRoas)}. Dua tag teratas menguasai ${C.top2Share.toFixed(0)}% dari ${C.count} tag berbayar.
       Kalau produk itu bermasalah, sebagian besar anggaran ikut terdampak.</div>`
    : `<p class="hint">Sebaran anggaran wajar: tag terbesar ${C.topShare.toFixed(0)}% dari ${C.count} tag berbayar.</p>`;
}

/* ── Kelengkapan data ───────────────────────────────────────────────────────
   A day with no rows and a day with genuinely zero activity look identical
   once aggregated, so coverage is read from the raw files: a date is covered
   when at least one row carries it. The gap that actually corrupts numbers is
   ads-without-clicks — every CPC Shopee, % masuk and leak figure on those days
   is computed against clicks that were never uploaded. */
const SRC={
  affiliate:{label:'Laporan Komisi',col:'Waktu Pemesanan',get:()=>DATA.affiliate},
  ads:{label:'Meta Ads',col:'Reporting starts',get:()=>adsRows()},
  clicks:{label:'Laporan Klik',col:'Waktu Klik',get:()=>DATA.clicks,chunk:7},
};
function datesOf(k){
  const c=SRC[k].col,out=new Set();
  SRC[k].get().forEach(r=>{const d=E.dayOnly(r[c]);if(E.isDate(d))out.add(d)});
  return out;
}
function chunkRuns(missing,max){
  const runs=[];let cur=null;
  missing.forEach(d=>{
    if(cur&&shiftDay(cur.end,1)===d&&(!max||cur.n<max)){cur.end=d;cur.n++;return}
    cur={start:d,end:d,n:1};runs.push(cur);
  });
  return runs;
}
function renderGaps(){
  const card=$('gapCard');
  const have={};let min='',max='';
  Object.keys(SRC).forEach(k=>{
    have[k]=datesOf(k);
    have[k].forEach(d=>{if(!min||d<min)min=d;if(!max||d>max)max=d});
  });
  if(!min){card.classList.add('hidden');return}
  const all=[],span=E.diffDays(min,max)+1;
  if(span>3660){card.classList.remove('hidden','gap-clean');$('gapNote').textContent=min+' — '+max;$('gapBody').textContent='Rentang laporan melebihi 10 tahun. Periksa tanggal sumber; rincian tanggal kosong tidak ditampilkan.';return}
  for(let d=min;d<=max;d=shiftDay(d,1))all.push(d);
  const rows=[],adsDays=have.ads;
  let clickGapWithSpend=0;
  Object.keys(SRC).forEach(k=>{
    if(!have[k].size)return; // a report not loaded at all is already a banner
    const miss=all.filter(d=>!have[k].has(d));
    if(!miss.length)return;
    if(k==='clicks')clickGapWithSpend=miss.filter(d=>adsDays.has(d)).length;
    rows.push({k,label:SRC[k].label,miss,runs:chunkRuns(miss,SRC[k].chunk)});
  });
  // Name the reports actually loaded. Claiming all three are complete while
  // two of them were never uploaded is the worst thing this card could say.
  const loaded=Object.keys(SRC).filter(k=>have[k].size);
  const missingReports=Object.keys(SRC).filter(k=>!have[k].size).map(k=>SRC[k].label);
  // Nothing missing is one line of reassurance, not a full card.
  card.classList.toggle('gap-clean',!rows.length&&!missingReports.length);
  if(!rows.length){
    card.classList.remove('hidden');
    $('gapNote').textContent=`${min} — ${max} · ${all.length} hari`;
    $('gapBody').innerHTML=`<div class="gap-ok"><b>Data lengkap.</b> ${loaded.map(k=>SRC[k].label).join(' dan ')} menutupi seluruh ${all.length} hari (${min} — ${max}), tidak ada tanggal yang bolong.</div>`
      +(missingReports.length?`<div class="gap-warn" style="margin:12px 0 0">${missingReports.join(' dan ')} belum dimuat sama sekali.</div>`:'');
    return;
  }
  card.classList.remove('hidden');
  $('gapNote').textContent=`${min} — ${max} · ${all.length} hari`;
  $('gapBody').innerHTML=(missingReports.length?`<div class="gap-warn"><b>${missingReports.join(' dan ')} belum dimuat sama sekali.</b></div>`:'')
    +(clickGapWithSpend
    ? `<div class="gap-warn"><b>${clickGapWithSpend} hari ada biaya iklan tapi tidak ada data klik.</b>
       Pada hari-hari itu CPC Shopee, % klik masuk, dan klik hilang dihitung terhadap klik yang belum diunggah —
       angkanya belum bisa dipercaya sampai filenya masuk.</div>` : '')
    +rows.map(r=>`<div class="gap-row">
      <div class="gap-head"><b>${r.label}</b>
        <span>${nf(r.miss.length)} hari belum ada${SRC[r.k].chunk?` · ${r.runs.length} file lagi (maks ${SRC[r.k].chunk} hari per unduhan)`:''}</span></div>
      <div class="gap-runs">${r.runs.map(x=>`<span class="gap-chip">${x.start}${x.n>1?' → '+x.end:''}<em>${x.n} hari</em></span>`).join('')}</div>
    </div>`).join('');
}
function renderBanner(){let r=RESULT,k=r.kpi,b=[];if(!adsRows().length)b.push(['warn','⚠','Laporan Meta Ads belum dimuat.']);if(!DATA.clicks.length)b.push(['info','ℹ','Website Click Report belum dimuat — kebocoran tidak dihitung.']);if(k.leakTags)b.push(['bad','🚨',`<b>${k.leakTags} tag: kurang dari 25% klik sampai Shopee.</b> Biaya klik yang tak sampai di tag itu maks. ${rp(r.actions.leakWaste)} — periksa link.`]);const um=unmatchedAds();if(um.length){const sp=um.reduce((s,m)=>s+m.spend,0);b.push(['warn','🔗',`<b>${um.length} iklan belum cocok ke tag Shopee</b> (biaya ${rp(sp)}): ${um.slice(0,3).map(m=>esc(m.adName)).join(', ')}${um.length>3?` dan ${um.length-3} lainnya`:''}. Biasanya nama iklan berbeda dari tag di link. <button class="btn sm" type="button" id="btnFixMatch">Cocokkan sekarang</button>`])}$('banners').innerHTML=b.map(x=>`<div class="banner ${x[0]}"><span>${x[1]}</span><div>${x[2]}</div></div>`).join('');if($('btnFixMatch'))$('btnFixMatch').onclick=openMap;$('lagNote').innerHTML=r.range.matureUntil&&r.range.matureUntil<r.range.end?`Pesanan menyusul setelah klik; vonis STOP dihitung sampai <b>${r.range.matureUntil}</b>.`:''}
// Four cards, matching the mind map. Every number that used to sit in its own
// KPI tile is still here — it moved one level down, into the card it belongs to.
// Eight tiles of equal weight meant nothing stood out; these four have a
// hierarchy, and the detail opens on click.
// Not every Meta export carries a Placement column — it depends on the
// breakdown chosen at export time. Returning null (rather than a single
// "Lainnya · 100%" row) lets the caller say so instead of faking a split.
function placementSplit(){
  if(!adsRows().length)return null;
  if(!Object.prototype.hasOwnProperty.call(adsRows()[0],'Placement'))return null;
  const r=RESULT.range,out={};
  adsRows().forEach(a=>{
    const d=E.dayOnly(a['Reporting starts']); if(!E.isDate(d)||d<r.start||d>r.end)return;
    // "Feed" exists on both Facebook and Instagram, so the platform has to be
    // part of the label or the two silently merge into one meaningless row.
    const pl=(a.Placement||'').trim()||'Tanpa placement',pf=(a.Platform||'').trim();
    const key=pf&&!pl.toLowerCase().startsWith(pf.toLowerCase())?`${pf} ${pl}`:pl;
    // Parsed like the engine and with PPN, so the rows add up to the card's headline.
    out[key]=(out[key]||0)+E.num(E.pick(a,E.COL.ads.spend))*(1+RESULT.options.ppn/100);
  });
  const rows=Object.entries(out).filter(x=>x[1]>0).sort((a,b)=>b[1]-a[1]);
  const tot=rows.reduce((s,x)=>s+x[1],0);
  if(!tot)return null;
  const top=rows.slice(0,4).map(([p,v])=>[p,`${rp(v)} · ${(v/tot*100).toFixed(0)}%`]);
  const rest=rows.slice(4).reduce((s,x)=>s+x[1],0);
  if(rest>0)top.push([`${rows.length-4} placement lain`,`${rp(rest)} · ${(rest/tot*100).toFixed(0)}%`]);
  return top;
}
function kpiCard(cls,label,value,note,rows){
  const body=rows.filter(Boolean).map(r=>`<div class="krow${r[2]?' est':''}"><span>${r[0]}</span><span>${r[1]}</span></div>`).join('');
  return `<div class="kpi ${cls}${body?' expandable':''}"${body?' tabindex="0" role="button" aria-expanded="false"':''}>
    <div class="lbl">${label}${body?'<span class="chev">Rincian</span>':''}</div>
    <div class="val">${value}</div><div class="sub">${note}</div>
    ${body?`<div class="kdrill">${body}</div>`:''}</div>`;
}
function renderKpi(){
  const k=RESULT.kpi,o=RESULT.options,paid=RESULT.tags.filter(t=>t.spend>0);
  const paidComm=paid.reduce((s,t)=>s+t.commEff,0),org=k.organicComm;
  const paidNet=paidComm-k.spend;
  const share=k.commEff?org/k.commEff*100:0;
  const pl=placementSplit();
  const pct=v=>k.commEff?` · ${(v/k.commEff*100).toFixed(0)}%`:'';
  const base=spendBase();
  $('kpis').innerHTML=[
    // The headline is effective, so Komisi − Spend = Laba holds across the row;
    // the total sits beside it. Selesai plus weighted Tertunda adds up to the
    // headline; the share still pending is what moves the verdicts.
    kpiCard('','Komisi Efektif',rp(k.commEff),`total ${rp(k.comm)} · ${nf(k.orders)} pesanan`,[
      ['Komisi Total (Selesai + Tertunda)',rp(k.comm)],
      ['Sudah Selesai',rp(k.commDone)],
      ['Tertunda × '+dec(o.pendingFactor,2),`${rp(k.commPending)} → ${rp(k.commPending*o.pendingFactor)}`],
      ['Komisi Organik',rp(org)+pct(org)],
      ['Komisi Iklan',rp(paidComm)+pct(paidComm)],
      ['Produk terjual',nf(k.qty)]]),
    // One PPN row, so the placement rows stay the only list that adds up to the headline.
    kpiCard('','Spend Iklan',rp(k.spend),o.ppn?`termasuk PPN ${o.ppn}%`:'tanpa PPN',
      [k.spend&&o.ppn?[`Meta (sebelum PPN) + PPN ${o.ppn}%`,`${rp(base)} + ${rp(k.spend-base)}`]:null].concat(pl||(adsRows().length?[
        ['Klik Meta',nf(k.clicks)],
        ['CPM',rp(k.cpm)],
        ['CPC',k.clicks?full(k.cpc):'—'],
        ['Rincian placement','ekspor tanpa breakdown',1]
      ]:[['Laporan Meta belum dimuat','—']]))),
    kpiCard(k.netEff>=0?'good':'bad','Laba Bersih',rp(k.netEff),
      o.ppn?`komisi efektif − biaya termasuk PPN ${o.ppn}%`:'komisi efektif − biaya (tanpa PPN)',[
      ['Laba Organik',rp(org)],
      ['Laba Iklan',rp(paidNet)]]),
    // ROAS Organik divides organic commission by the SAME total spend, so the
    // two parts add up to the total exactly. Dividing by organic spend would
    // be dividing by zero; this way the card is a decomposition, not a ratio
    // with a missing denominator.
    kpiCard('','ROAS Gabungan',rx(k.roasEff),
      k.paidRoas<1?`iklan sendiri ${rx(k.paidRoas)} — di bawah impas`:'iklan dan organik digabung',[
      ['ROAS Iklan',rx(k.paidRoas)],
      ['ROAS Organik',k.spend?rx(org/k.spend):'—'],
      ['Kontribusi Organik',dec(share,1)+'%'],
      ['ROAS hanya Selesai',k.spend?rx(k.roasDone)+' · batas bawah':'—']])
  ].join('');
  bindDrill('kpis');
}
function bindDrill(id){
  $(id).querySelectorAll('.kpi.expandable').forEach(el=>{
    // The all-open preference is applied at render time, not toggled onto an
    // already-drawn card, so re-rendering keeps whatever state the user chose.
    if(ALL_DETAIL){el.classList.add('open');el.setAttribute('aria-expanded','true')}
    const flip=()=>{const o=el.classList.toggle('open');el.setAttribute('aria-expanded',o?'true':'false');syncAllBtn()};
    el.onclick=flip;
    el.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();flip()}};
  });
  syncAllBtn();
}
let ALL_DETAIL=false;
try{ALL_DETAIL=localStorage.getItem('adash_alldetail')==='1'}catch(e){}
function allCards(){return[...document.querySelectorAll('#kpis .kpi.expandable,#clickKpis .kpi.expandable')]}
function syncAllBtn(){
  const c=allCards(),open=c.filter(e=>e.classList.contains('open')).length;
  const all=c.length>0&&open===c.length;
  const b=$('btnAllDetail');
  b.textContent=all?'Sembunyikan semua rincian':'Tampilkan semua rincian';
  b.setAttribute('aria-pressed',all?'true':'false');
  b.classList.toggle('hidden',!c.length);
}
$('btnAllDetail').onclick=()=>{
  const c=allCards(),open=c.every(e=>e.classList.contains('open'));
  ALL_DETAIL=!open;
  c.forEach(e=>{e.classList.toggle('open',ALL_DETAIL);e.setAttribute('aria-expanded',ALL_DETAIL?'true':'false')});
  try{localStorage.setItem('adash_alldetail',ALL_DETAIL?'1':'0')}catch(e){}
  syncAllBtn();
};
// Meta reports clicks per platform; Shopee reports them per Perujuk. Keeping
// both on the main screen is the point — where the two disagree is where the
// money goes missing.
// Scoped to the click window when there is one, so the platform split adds up
// to the headline instead of quietly reporting a longer period.
function metaBySource(){
  const r=RESULT.range,out={};
  const from=r.clickStart||r.start,to=r.clickEnd||r.end;
  adsRows().forEach(a=>{
    const d=E.dayOnly(a['Reporting starts']); if(!E.isDate(d)||d<from||d>to)return;
    const p=(a.Platform||'').trim()||'Lainnya';
    out[p]=(out[p]||0)+(parseInt(a['Link clicks']||0,10)||0);
  });
  return Object.entries(out).filter(x=>x[1]>0).sort((a,b)=>b[1]-a[1]);
}
// The click report covers its own span, usually shorter than the analysis
// range. Dividing full-range spend by window-only clicks overstates the cost
// per click — it read Rp247 against a true Rp105. Daily rows already carry
// PPN, so summing them keeps one definition of spend.
function clickWindowStats(){
  const r=RESULT.range; if(!r.clickStart)return null;
  const w={spend:0,impr:0,clicks:0,orders:0,shopee:0,days:0};
  RESULT.daily.forEach(d=>{
    if(d.date<r.clickStart||d.date>r.clickEnd)return;
    w.spend+=d.spend;w.impr+=d.impr;w.clicks+=d.clicks;w.orders+=d.orders;
    w.shopee+=d.shopeeClicks;w.days++;
  });
  return w.days?w:null;
}
function renderClickKpi(){
  const k=RESULT.kpi,r=RESULT.range,el=$('clickKpis');
  const leaks=RESULT.tags.filter(t=>t.leak&&isFinite(t.leak.pct));
  // Klik Meta stands on the ads report alone. Only the three cards that
  // compare against Shopee need the click report, so deleting it should not
  // take the Meta side down with it.
  const hasClicks=leaks.length>0;
  if(!adsRows().length&&!hasClicks){el.innerHTML='';return}
  // Window-matched totals: the click report covers its own date span, so the
  // ratio has to compare like with like or it is meaningless.
  const adMeta=leaks.reduce((s,t)=>s+t.leak.metaClicks,0);
  const adShopee=leaks.reduce((s,t)=>s+t.leak.shopeeClicks,0);
  const lostTags=leaks.filter(t=>t.leak.shopeeClicks<t.leak.metaClicks)
    .sort((a,b)=>(a.leak.shopeeClicks-a.leak.metaClicks)-(b.leak.shopeeClicks-b.leak.metaClicks));
  const lost=lostTags.reduce((s,t)=>s+(t.leak.metaClicks-t.leak.shopeeClicks),0);
  const gainTags=leaks.filter(t=>t.leak.shopeeClicks>t.leak.metaClicks);
  const gained=gainTags.reduce((s,t)=>s+(t.leak.shopeeClicks-t.leak.metaClicks),0);
  const pctIn=adMeta?adShopee/adMeta*100:0;
  const ms=metaBySource(),msTot=ms.reduce((s,x)=>s+x[1],0);
  const ss=(RESULT.breakdown.clickSource||[]),ssTot=ss.reduce((s,x)=>s+x.count,0);
  const win=r.clickStart?`${r.clickStart} s/d ${r.clickEnd}`:'klik belum dimuat';
  const W=clickWindowStats();
  // Both columns divide the SAME spend, impressions and orders — only the click
  // count changes. That is the whole point of reading them side by side: the
  // gap between each pair is exactly what the leak or the resharing did.
  const sp=W?W.spend:k.spend,im=W?W.impr:k.impr,od=W?W.orders:k.orders;
  const mC=W?adMeta:k.clicks,sC=adShopee;
  const per=(n,d)=>d?full(n/d):'—';
  const per1k=(n,d)=>d?full(n/d*1000):'—';
  const pc=(n,d)=>d?dec(n/d*100,2)+'%':'—';

  const out=[];
  if(adsRows().length)out.push(
    kpiCard('','Klik Meta',nf(mC),hasClicks?win:`${r.start} s/d ${r.end}`,[
      ['Impresi',nf(im)],['CPM',per1k(sp,im)],['CPC',per(sp,mC)],
      ['CTR',pc(mC,im)],['CR',pc(od,mC)],
      ...ms.slice(0,3).map(([p,v])=>[p,`${nf(v)} · ${msTot?(v/msTot*100).toFixed(0):0}%`]),
      ['CR memakai semua pesanan','termasuk dari tag organik',1]]));
  if(hasClicks)out.push(
    kpiCard('','Klik Shopee',nf(sC),`${win} · ${nf(k.shopeeClicks)} total`,[
      // Shopee reports no impressions, so there is no CPM to report either.
      // Spend ÷ Shopee clicks × 1000 is a cost per thousand arrivals, not a
      // cost per thousand views — printing it under the label CPM invites the
      // wrong comparison with the Rp5.704 next to it.
      ['Impresi','—',1],['CPM','—',1],['CPC',per(sp,sC)],
      ['CTR',pc(sC,im)],['CR',pc(od,sC)],
      ...ss.slice(0,3).map(s=>[s.name||'(tanpa sumber)',`${nf(s.count)} · ${ssTot?(s.count/ssTot*100).toFixed(0):0}%`]),
      ['CTR memakai impresi Meta','Shopee tak melaporkan impresi',1],
      ...(RESULT.tags.some(t=>t.shopeeSrc)?[['Hanya perujuk Facebook/Instagram','dipakai untuk klik hilang',1]]:[])]),
    // Per-tag sum as the headline, the net beside it, and the money as a range:
    // the data cannot tell a misrouted click from outside traffic.
    kpiCard(lost>0?'bad':'','Klik Hilang',nf(lost),
      lost>0?`jumlah per tag · bersih ${nf(k.netLostClicks)} · biaya ${rp(k.wastedLow)}–${rp(k.wasted)}`:'tidak ada klik yang hilang',[
      ...lostTags.slice(0,4).map(t=>[t.tag,`−${nf(t.leak.metaClicks-t.leak.shopeeClicks)}`]),
      ['Kelebihan di tag lain',`+${nf(gained)}`,1],
      lost>0&&['Biaya: bawah = semua kelebihan dianggap salah tag; atas = tidak ada','',1]]),
    kpiCard(pctIn<70?'bad':'','% Klik Masuk Shopee',dec(pctIn,1)+'%',
      pctIn>100?'di atas 100%: ada trafik di luar iklan':'sebagian klik tidak sampai',[
      [`${gainTags.length} tag kelebihan klik`,`+${nf(gained)} klik`],
      [`${lostTags.length} tag kekurangan klik`,`−${nf(lost)} klik`],
      ['Selisih bersih',`${adShopee-adMeta>=0?'+':''}${nf(adShopee-adMeta)} klik`]]));
  el.innerHTML=out.join('');
  bindDrill('clickKpis');
}
function renderSynth(){
  const k=RESULT.kpi,st=k.counts.stop||0,A=RESULT.actions;
  $('synth').innerHTML=k.spend?`Periode ini menghasilkan ${k.netEff>=0?'laba':'rugi'} <b>${rp(Math.abs(k.netEff))}</b>. `
    +(k.organicComm>0?`Komisi organik efektif <b>${rp(k.organicComm)}</b>. `:'')
    +`ROAS iklan berbayar <b>${rx(k.paidRoas)}</b>. `
    +(st?`${st} tag berstatus STOP berdasarkan data matang.`:'Belum ada tag berstatus STOP.')
    // Unjudged paid tags are not neutral; their combined net is real money.
    +(A.evalCount?` ${A.evalCount} tag berbiaya belum cukup data untuk divonis; gabungannya ${A.evalNet>=0?'laba':'rugi'} <b>${rp(Math.abs(A.evalNet))}</b> dari biaya ${rp(A.evalSpend)}.`:''):'';
}
function renderDecisions(){let g={scale:[],pantau:[],stop:[],organik:[],evaluasi:[]};RESULT.tags.forEach(t=>{if(g[t.status]&&(t.status!=='evaluasi'||t.spend>0))g[t.status].push(t)});g.evaluasi.sort((a,b)=>b.spend-a.spend);g.stop.sort((a,b)=>a.roasEff-b.roasEff);g.pantau.sort((a,b)=>a.roasEff-b.roasEff);g.organik.sort((a,b)=>b.comm-a.comm);let box=(key,title,unit,fn,empty,head='')=>{let a=g[key],it=a.length?a.slice(0,5).map(t=>`<div class="ditem"><span class="n">${esc(t.tag)}</span><span class="v">${fn(t)}</span></div>`).join('')+(a.length>5?`<div class="ditem"><span class="n">+${a.length-5} lainnya</span></div>`:''):`<div class="empty">${empty}</div>`;return`<div class="dcard ${key}${FILTER&&FILTER!==key?' dim':''}" data-filter="${key}" role="button" tabindex="0" aria-pressed="${FILTER===key}"><h4>${title} (${a.length}) <span class="unit">${unit}</span></h4>${head}${it}</div>`};const A=RESULT.actions,evHead=A.evalCount?`<p class="dtotal" title="Komisi efektif dikurangi biaya + PPN selama periode, sama dengan kolom Laba di tabel. Termasuk iklan yang namanya belum cocok ke tag (komisinya bisa tercatat di tag lain) dan hari terakhir yang komisinya masih menyusul."><span>Laba bersih</span><b class="${A.evalNet>=0?'pos':'neg'}">${rp(A.evalNet)}</b><span>dari biaya ${rp(A.evalSpend)}</span></p>`:'';$('dgrid').innerHTML=box('scale','Scale','roas',t=>rx(t.roasEff),`Belum ada tag mencapai ${String(RESULT.options.thScale).replace('.',',')}x`)+box('pantau','Pantau','roas',t=>rx(t.roasEff),'Tidak ada')+box('stop','Stop','roas',t=>rx(t.roasEff),'Tidak ada')+box('organik','Organik','komisi total',t=>rp(t.comm),'Tidak ada')+box('evaluasi','Belum cukup data','laba',t=>rp(t.netEff),'Semua tag berbiaya sudah divonis',evHead);$('dgrid').querySelectorAll('[data-filter]').forEach(e=>e.onclick=()=>{FILTER=FILTER===e.dataset.filter?null:e.dataset.filter;renderDecisions();renderMain()});$('dgrid').querySelectorAll('[data-filter]').forEach(e=>e.onkeydown=event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();e.click()}})}

/* Rows in Semua Tag and Per Ad Unit open into their own day-by-day history.
   The totals answer "is this working"; the days answer "since when". */
const BDCOLS=['Tanggal','Biaya','Komisi Efektif','Laba','ROAS','Klik Meta','CPC Meta','Klik Shopee','Order','Biaya/Order','Nilai/Order'];
function breakdownRows(byDate){
  const r=RESULT.range;
  return Object.keys(byDate||{}).filter(d=>d>=r.start&&d<=r.end).sort().reverse()
    .map(d=>byDate[d]);
}
function breakdownHTML(title,byDate,note){
  const rows=breakdownRows(byDate);
  const body=rows.length?rows.map(v=>{
    const net=v.commEff-v.spend,sh=v.shopeeClicks||0;
    return `<tr><td><b>${v.date}</b></td>
      <td class="num">${rp(v.spend)}</td><td class="num">${rp(v.commEff)}</td>
      <td class="num ${net>=0?'pos':'neg'}">${rp(net)}</td>
      <td class="num">${v.spend?dec(v.commEff/v.spend,2):'—'}</td>
      <td class="num">${nf(v.clicks)}</td>
      <td class="num">${v.clicks&&v.spend?full(v.spend/v.clicks):'—'}</td>
      <td class="num">${sh?nf(sh):'—'}</td>
      <td class="num">${nf(v.orders)}</td>
      <td class="num">${v.orders&&v.spend?rp(v.spend/v.orders):'—'}</td>
      <td class="num">${v.orders?rp(v.gmv/v.orders):'—'}</td></tr>`;
  }).join(''):`<tr><td colspan="${BDCOLS.length}" style="color:var(--text-mute);padding:14px">Tidak ada hari dengan aktivitas pada periode ini.</td></tr>`;
  return `<div class="daybox">
    <div class="dayhead">${esc(title)} <span>${rows.length} hari${note?' · '+note:''}</span></div>
    <div class="tscroll"><table class="daytbl"><thead><tr>${
      BDCOLS.map((h,i)=>`<th class="${i?'num':''}">${h}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></div>
  </div>`;
}
function bindBreakdown(tableId,lookup,cols){
  $(tableId).querySelectorAll('tbody tr[data-bd]').forEach(tr=>{
    const open=()=>{
      if(tr.nextElementSibling&&tr.nextElementSibling.classList.contains('daydetail')){
        tr.nextElementSibling.remove();tr.classList.remove('open');tr.setAttribute('aria-expanded','false');return;
      }
      const it=lookup(tr.dataset.bd); if(!it)return;
      const det=document.createElement('tr');
      det.className='daydetail';
      det.innerHTML=`<td colspan="${cols}">${breakdownHTML('Per hari · '+(it.title||tr.dataset.bd),it.byDate,it.note)}</td>`;
      tr.after(det);tr.classList.add('open');tr.setAttribute('aria-expanded','true');
    };
    tr.onclick=open;
    tr.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();open()}};
  });
}
const MC=[['tag','Tag / Keputusan',0],['spend','Biaya',1],['commEff','Komisi Efektif',1],['netEff','Laba',1],['roasEff','ROAS',1],['roi','ROI %',1],['cpm','CPM',1],['clicks','Klik Meta',1],['shopeeClicks','Klik Masuk Shopee',1],['cpc','CPC Meta',1],['lpv','LP View',1],['cpLpv','Biaya/LP View',1],['cpcShopee','CPC Shopee',1],['lostTotal','Klik Hilang',1],['cpcIdeal','CPC Ideal',1],['orders','Order',1],['convRate','CR %',1],['costPerOrder','Biaya/Order',1],['daysProd','Hari',1]];
// The evaluasi filter keeps paid tags only, so the name says so.
function filterName(f){return{evaluasi:'belum cukup data (berbiaya)'}[f]||f}
function visibleTags(){return RESULT?RESULT.tags.filter(t=>(!FILTER||t.status===FILTER&&(FILTER!=='evaluasi'||t.spend>0))&&(!TAG_QUERY||[t.tag,t.label,t.reason,t.linkNote,t.borderAt!=null?'di batas':''].some(x=>String(x||'').toLocaleLowerCase().includes(TAG_QUERY)))):[]}
$('btnMetrics').onclick=()=>{const compact=$('tblMain').classList.toggle('compact-columns');$('btnMetrics').textContent=compact?'Semua metrik':'Metrik utama';$('btnMetrics').setAttribute('aria-pressed',String(!compact))};
$('attrSearch').oninput=()=>{ATTR_QUERY=$('attrSearch').value.trim().toLocaleLowerCase();if(RESULT)renderAttr()};
$('tagSearch').oninput=()=>{TAG_QUERY=$('tagSearch').value.trim().toLocaleLowerCase();if(RESULT)renderMain()};
/* Direct vs indirect orders per tag. Shopee's report decides which is which;
   rows it does not label clearly are shown as unknown, never split by guess. */
let ATTR_ALL=false,ATTR_SORT=null,ATTR_QUERY='';const ATTR_OPEN=new Map(); // tag → {kind, all}
const ATTR_KIND={direct:'Terjual langsung',indirect:'Terjual tidak langsung',unknown:'Tipe tidak diketahui'},ATTR_TOP=5;
/* Products behind one kind of a tag's orders: the direct list is what the
   link sold, the indirect list is what buyers chose instead. Five first, the
   rest on request, so a long indirect list does not push the table away. */
function attrProductsHTML(t,kind,all){
  const items=(t.attrProducts||{})[kind]||[];
  if(!items.length)return`<div class="daybox attr-box"><div class="attr-prod"><h4>${ATTR_KIND[kind]}</h4><p class="hint">Tidak ada.</p></div></div>`;
  const shown=all?items:items.slice(0,ATTR_TOP),rest=items.slice(ATTR_TOP);
  const more=rest.length?`<button class="btn sm attr-more" data-more="${all?'less':'all'}">${all?'Tampilkan '+ATTR_TOP+' teratas':`Tampilkan semua ${nf(items.length)} produk (+${nf(rest.length)}, ${rp(rest.reduce((s,p)=>s+p.comm,0))})`}</button>`:'';
  return`<div class="daybox attr-box"><div class="attr-prod"><h4>${ATTR_KIND[kind]} · ${esc(t.tag)} · ${nf(items.length)} produk</h4><table><thead><tr><th>Produk</th><th class="num">Pesanan</th><th class="num">Qty</th><th class="num">Komisi</th></tr></thead><tbody>`
    +shown.map(p=>`<tr><td><div class="nm">${esc(p.name)}</div>${p.shop?`<div class="rs">${esc(p.shop)}</div>`:''}</td><td class="num">${nf(p.orders)}</td><td class="num">${nf(p.qty)}</td><td class="num">${rp(p.comm)}</td></tr>`).join('')
    +`</tbody></table>${more}</div></div>`;
}
// A daily export broken down by placement holds the same spend as the plain
// ads export, so it stands in for it only when no plain file is loaded;
// both together would count every rupiah twice.
function adsRows(){
  if(DATA.ads.length||!DATA.placement.length)return DATA.ads;
  return DATA.placement.filter(r=>E.dayOnly(r['Reporting starts'])===E.dayOnly(r['Reporting ends']||r['Reporting starts']));
}
let PLC_ALL=false,PLC_TAGS_ALL=false;const PLC_OPEN=new Set(),PLC_OTHER_OPEN=new Set();
/* Shopee clicks and orders whose referrer is not Facebook or Instagram
   (Others, Websites, …). They have no Meta placement, so they sit under the
   placements as their own row with real, not estimated, commission. */
function plcOtherRow(o,cols,names,key){
  if(!o||!(o.shopeeClicks||o.comm))return'';
  const what=`${nf(o.shopeeClicks)} klik Shopee · ${nf(o.orders)} pesanan`+(names?' · '+names:'');
  const open=key&&PLC_OTHER_OPEN.has(key);
  const label=key?`<button class="attr-open${open?' open':''}" data-other="${key}" aria-expanded="${open}" title="Lihat tag asal klik Other">Other<span class="exp" aria-hidden="true">▸</span></button>`:'Other';
  return`<tr class="plc-other"><td>${label}</td><td colspan="${cols-3}">Bukan placement Meta <small class="src-other">${esc(what)}</small></td><td class="num" title="Komisi nyata dari pesanan dengan perujuk selain Facebook/Instagram">${o.comm?full(o.comm):'—'}</td><td class="num">—</td></tr>`
    +(open?`<tr class="daydetail"><td colspan="${cols}">${plcOtherTags()}</td></tr>`:'');
}
/* Which tags the Other clicks and orders landed on, with their sources. */
function plcOtherTags(){
  const list=(RESULT.placement.otherTags||[]);
  if(!list.length)return'<p class="hint">Tidak ada klik atau pesanan Other.</p>';
  const src=t=>t.sources.slice(0,3).map(x=>`${esc(x.source)} ${nf(x.shopeeClicks)}`).join(' · ')+(t.sources.length>3?` · +${t.sources.length-3} lain`:'');
  return`<div class="daybox attr-box plc-other-box"><table><thead><tr><th>Tag</th><th class="num">Klik Shopee</th><th class="num">Pesanan</th><th class="num">Komisi</th><th>Sumber</th></tr></thead><tbody>`
    +list.map(t=>`<tr><td>${esc(t.tag)}</td><td class="num">${t.shopeeClicks?nf(t.shopeeClicks):'—'}</td><td class="num">${t.orders?nf(t.orders):'—'}</td><td class="num">${t.comm?full(t.comm):'—'}</td><td>${src(t)}</td></tr>`).join('')
    +`</tbody></table><p class="hint">${nf(list.length)} tag. Hanya tag yang punya iklan di file placement.</p></div>`;
}
// One tag's placements. Spend and clicks are Meta's; commission is the tag's
// platform commission split by click share, so it is marked as an estimate.
function plcTagDetail(t){
  const rows=(t.placements||[]).filter(p=>p.spend>0||p.clicks>0);
  if(!rows.length)return'<p class="hint">Tidak ada biaya per placement untuk tag ini.</p>';
  const roas=v=>v==null||!isFinite(v)?'—':`<span class="${v>=1?'pos':'neg'}">${rx(v)}</span>`;
  return`<div class="daybox attr-box"><table><thead><tr><th>Platform</th><th>Placement</th><th class="num">Biaya</th><th class="num">Klik Meta</th><th class="num">CTR</th><th class="num">CPC</th><th class="num">Estimasi komisi</th><th class="num">Estimasi ROAS</th></tr></thead><tbody>`
    +rows.map(p=>`<tr><td>${esc(p.platform)}</td><td>${esc(p.placement)}</td><td class="num">${full(p.spend)}</td><td class="num">${nf(p.clicks)}</td><td class="num">${p.ctr==null?'—':p.ctr.toFixed(2).replace('.',',')+'%'}</td><td class="num">${p.cpc==null?'—':full(p.cpc)}</td><td class="num est">${p.estComm?full(p.estComm):'—'}</td><td class="num">${roas(p.estRoas)}</td></tr>`).join('')
    +plcOtherRow(t.platforms[Placement.OTHER],8)
    +'</tbody></table><p class="hint">Komisi per placement adalah estimasi: komisi tag di platform itu dibagi menurut porsi klik Meta tiap placement.</p></div>';
}
function renderPlacement(){
  const P=RESULT.placement,card=$('plcCard');
  card.classList.toggle('hidden',!P);if(!P)return;
  const roasCell=v=>v==null||!isFinite(v)?'<td class="num">—</td>':`<td class="num ${v>=1?'pos':'neg'}">${rx(v)}</td>`;
  const money=v=>`<td class="num">${v?full(v):'—'}</td>`,count=v=>`<td class="num">${v?nf(v):'—'}</td>`;
  const pct=(v,d)=>`<td class="num">${v==null||!isFinite(v)?'—':v.toFixed(d==null?1:d).replace('.',',')+'%'}</td>`;
  const head=(id,cols)=>$(id).querySelector('thead').innerHTML='<tr>'+cols.map((c,i)=>`<th class="${i>=(id==='tblPlcPlace'?2:1)?'num':''}">${c}</th>`).join('')+'</tr>';
  const spendAll=P.total.spend;
  const srcNames=(P.otherSources||[]).slice(0,4).map(o=>`${o.source} ${nf(o.shopeeClicks)}`).join(' · ')+((P.otherSources||[]).length>4?` · +${P.otherSources.length-4} lain`:'');
  head('tblPlcPlat',['Platform','Biaya','% biaya','Klik Meta','CPC Meta','Klik Shopee','CPC Shopee','Klik hilang','Pesanan','Komisi','ROAS','Laba']);
  const platRow=p=>`<tr${p.platform==='Total'?' class="total"':''}><td>${p.platform===Placement.OTHER?`<button class="attr-open${PLC_OTHER_OPEN.has('plat')?' open':''}" data-other="plat" aria-expanded="${PLC_OTHER_OPEN.has('plat')}" title="Lihat tag asal klik Other">${esc(p.platform)}<span class="exp" aria-hidden="true">▸</span></button>`:esc(p.platform)}${p.platform===Placement.OTHER&&srcNames?`<small class="src-other">${esc(srcNames)}</small>`:''}</td>${money(p.spend)}${pct(spendAll?p.spend/spendAll*100:null,0)}${count(p.clicks)}${money(p.cpc)}${count(p.shopeeClicks)}${money(p.cpcShopee)}${p.platform===Placement.OTHER||!P.hasClicks?'<td class="num">—</td>':lostCell(platformLeak(p),'Klik Meta yang tidak tercatat di Shopee pada platform ini')}${count(p.orders)}${money(p.comm)}${roasCell(p.roas)}<td class="num ${p.net>=0?'pos':'neg'}">${p.spend?rp(p.net):'—'}</td></tr>`
    +(p.platform===Placement.OTHER&&PLC_OTHER_OPEN.has('plat')?`<tr class="daydetail"><td colspan="12">${plcOtherTags()}</td></tr>`:'');
  $('tblPlcPlat').querySelector('tbody').innerHTML=P.platforms.map(platRow).join('');
  $('tblPlcPlat').querySelector('tfoot').innerHTML=platRow(P.total);
  head('tblPlcPlace',['Platform','Placement','Biaya','% biaya','Impresi','Klik Meta','CTR','CPC Meta','CPC vs rata-rata','Estimasi komisi','Estimasi ROAS']);
  const vs=v=>v==null||!isFinite(v)?'<td class="num">—</td>':`<td class="num ${v<=-10?'pos':v>=10?'neg':''}">${v>0?'+':''}${v.toFixed(0)}%</td>`;
  // Placements under 0.5% of spend are noise until asked for.
  const big=P.placements.filter(p=>p.share>=0.5),list=PLC_ALL?P.placements:big;
  $('tblPlcPlace').querySelector('tbody').innerHTML=list.map(p=>`<tr><td>${esc(p.platform)}</td><td>${esc(p.placement)}</td>${money(p.spend)}${pct(p.share)}${count(p.impr)}${count(p.clicks)}${pct(p.ctr,2)}${money(p.cpc)}${vs(p.cpcVsAvg)}<td class="num est">${p.estComm?full(p.estComm):'—'}</td>${roasCell(p.estRoas)}</tr>`).join('')
    +plcOtherRow(P.platforms.find(p=>p.platform===Placement.OTHER),11,srcNames,'place');
  $('plcCard').querySelectorAll('button[data-other]').forEach(b=>b.onclick=()=>{
    const k=b.dataset.other;PLC_OTHER_OPEN.has(k)?PLC_OTHER_OPEN.delete(k):PLC_OTHER_OPEN.add(k);renderPlacement()});
  const more=$('btnPlcAll');more.classList.toggle('hidden',big.length===P.placements.length);
  more.textContent=PLC_ALL?'Sembunyikan placement kecil':`Tampilkan ${P.placements.length-big.length} placement kecil (<0,5% biaya)`;
  more.onclick=()=>{PLC_ALL=!PLC_ALL;renderPlacement()};
  head('tblPlcTag',['Tag','Biaya FB','Komisi FB','ROAS FB','Biaya IG','Komisi IG','ROAS IG','Komisi Lainnya + Other','Lebih untung di']);
  const pf=(t,k)=>t.platforms[k]||{spend:0,comm:0,roas:null};
  const tagCut=15,tagList=PLC_TAGS_ALL?P.tags:P.tags.slice(0,tagCut);
  $('tblPlcTag').querySelector('tbody').innerHTML=tagList.map(t=>{
    const fb=pf(t,'Facebook'),ig=pf(t,'Instagram'),other=pf(t,'Lainnya').comm+pf(t,Placement.OTHER).comm;
    // A side with under Rp10.000 spend has too little to call either way.
    const ok=x=>x.spend>=10000&&x.roas!=null;
    const best=!fb.comm&&!ig.comm?'Belum ada komisi':ok(fb)&&ok(ig)?(Math.abs(fb.roas-ig.roas)<0.1?'Setara':fb.roas>ig.roas?'Facebook':'Instagram'):'—';
    const open=PLC_OPEN.has(t.tag);
    const detail=open?`<tr class="daydetail"><td colspan="9">${plcTagDetail(t)}</td></tr>`:'';
    return`<tr data-plc-tag="${esc(t.tag)}"><td><button class="attr-open${open?' open':''}" aria-expanded="${open}" title="Lihat placement ${esc(t.tag)}">${esc(t.tag)}<span class="exp" aria-hidden="true">▸</span></button></td>${money(fb.spend)}${money(fb.comm)}${roasCell(fb.spend?fb.roas:null)}${money(ig.spend)}${money(ig.comm)}${roasCell(ig.spend?ig.roas:null)}${money(other)}<td>${best}</td></tr>`+detail;
  }).join('');
  $('tblPlcTag').querySelectorAll('tr[data-plc-tag] .attr-open').forEach(b=>b.onclick=()=>{
    const tag=b.closest('tr').dataset.plcTag;PLC_OPEN.has(tag)?PLC_OPEN.delete(tag):PLC_OPEN.add(tag);renderPlacement()});
  const tagBtn=$('btnPlcTags');tagBtn.classList.toggle('hidden',P.tags.length<=tagCut);
  tagBtn.textContent=PLC_TAGS_ALL?`Tampilkan ${tagCut} teratas`:`Tampilkan semua ${P.tags.length} tag`;
  tagBtn.onclick=()=>{PLC_TAGS_ALL=!PLC_TAGS_ALL;renderPlacement()};
  $('plcNote').textContent=`${P.range.start} s/d ${P.range.end}${P.daily?' · ikut filter tanggal':' · satu periode, tidak ikut filter tanggal'}`
    +(P.unmatchedSpend?` · ${rp(P.unmatchedSpend)} biaya dari iklan yang belum cocok ke tag`:'')
    +(P.hasOrderPlatform?'':' · laporan komisi tanpa kolom Platform, komisi per platform kosong')
    +(P.hasClicks?'':' · laporan klik belum dimuat');
}
function renderAttr(){
  const A=RESULT.attribution||{},tot=A.total,cut=30;
  const tb=$('tblAttr');
  if(!A.column||!tot){
    $('attrNote').textContent='';$('attrStrip').innerHTML='';$('btnAttrAll').classList.add('hidden');$('attrTools').classList.add('hidden');
    tb.querySelector('thead').innerHTML='';tb.querySelector('tfoot').innerHTML='';
    tb.querySelector('tbody').innerHTML='<tr><td class="tbl-empty">Laporan komisi ini tidak punya kolom tipe atribusi (langsung/tidak langsung), jadi belum bisa dipisah. Unggah laporan komisi Shopee terbaru yang memuat kolom itu.</td></tr>';
    return;
  }
  $('attrTools').classList.remove('hidden');
  const unk=tot.unknown.rows>0;
  const share=a=>{const c=a.direct.comm+a.indirect.comm;return c>0?(a.indirect.comm/c*100).toFixed(0)+'%':'—'};
  // In a tag row the order counts open that kind's products; the total row is plain.
  const count=(a,kind,label,tag)=>tag&&a[kind].orders?`<button class="attr-open" data-kind="${kind}" aria-expanded="false" title="Lihat produk ${label}">${nf(a[kind].orders)}<span class="exp" aria-hidden="true">▸</span></button>`:nf(a[kind].orders);
  const cells=(a,tag)=>`<td class="num">${count(a,'direct','langsung',tag)}</td><td class="num">${rp(a.direct.comm)}</td><td class="num">${count(a,'indirect','tidak langsung',tag)}</td><td class="num">${rp(a.indirect.comm)}</td><td class="num">${share(a)}</td>`
    +(unk?`<td class="num" title="${nf(a.unknown.rows)} baris tanpa tipe atribusi yang jelas">${count(a,'unknown','tidak diketahui',tag)} · ${rp(a.unknown.comm)}</td>`:'');
  const head=['Tag','Pesanan langsung','Komisi langsung','Pesanan tidak langsung','Komisi tidak langsung','Porsi komisi tidak langsung'].concat(unk?['Tidak diketahui']:[]);
  // Every column sorts; until one is picked the order is total commission, highest first.
  const keys=['tag','dOrders','dComm','iOrders','iComm','share','unknown'];
  const val={tag:t=>t.tag,dOrders:t=>t.attr.direct.orders,dComm:t=>t.attr.direct.comm,iOrders:t=>t.attr.indirect.orders,iComm:t=>t.attr.indirect.comm,
    share:t=>{const c=t.attr.direct.comm+t.attr.indirect.comm;return c>0?t.attr.indirect.comm/c:-1},unknown:t=>t.attr.unknown.orders};
  const S=ATTR_SORT&&head[keys.indexOf(ATTR_SORT.key)]?ATTR_SORT:null;
  tb.querySelector('thead').innerHTML='<tr>'+head.map((h,i)=>{const k=keys[i],on=S&&S.key===k;
    return`<th class="${i?'num':''} sortable" data-sort="${k}" tabindex="0" aria-sort="${on?(S.dir<0?'descending':'ascending'):'none'}">${h}${on?(S.dir<0?' ▾':' ▴'):''}</th>`}).join('')+'</tr>';
  tb.querySelectorAll('th[data-sort]').forEach(th=>{
    const go=()=>{const k=th.dataset.sort;ATTR_SORT=S&&S.key===k?{key:k,dir:-S.dir}:{key:k,dir:k==='tag'?1:-1};renderAttr()};
    // The header is rebuilt, so a keyboard sort puts focus back on its replacement.
    th.onclick=go;th.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();const k=th.dataset.sort;go();tb.querySelector(`th[data-sort="${k}"]`).focus()}};
  });
  const withAttr=RESULT.tags.filter(t=>t.attr&&(t.attr.direct.rows||t.attr.indirect.rows||t.attr.unknown.rows));
  const rows=withAttr.filter(t=>!ATTR_QUERY||t.tag.toLocaleLowerCase().includes(ATTR_QUERY))
    .sort((a,b)=>{
      if(!S)return b.comm-a.comm||a.tag.localeCompare(b.tag);
      const x=val[S.key](a),y=val[S.key](b);
      return (S.key==='tag'?S.dir*String(x).localeCompare(y):S.dir*(x-y))||b.comm-a.comm||a.tag.localeCompare(b.tag);
    });
  const shown=ATTR_ALL?rows:rows.slice(0,cut);
  tb.querySelector('tbody').innerHTML=shown.map(t=>`<tr data-attr="${esc(t.tag)}"><td>${esc(t.tag)}${t.attr.mixed?` <span class="pill" title="${nf(t.attr.mixed)} pesanan berisi barang langsung dan tidak langsung, dihitung di kedua kolom">${nf(t.attr.mixed)} campuran</span>`:''}</td>${cells(t.attr,t.tag)}</tr>`).join('')
    ||`<tr><td colspan="${head.length}" class="tbl-empty">${ATTR_QUERY?'Tidak ada tag yang cocok dengan pencarian.':'Tidak ada pesanan pada periode ini.'}</td></tr>`;
  // The total stays the whole account, whatever the search shows.
  tb.querySelector('tfoot').innerHTML=withAttr.length?`<tr><td>Total akun</td>${cells(tot)}</tr>`:'';
  $('attrSearchCount').textContent=ATTR_QUERY?rows.length+' dari '+withAttr.length+' tag':withAttr.length+' tag';
  /* One detail row per tag, showing one kind at a time: the same number
     closes it, the other number switches it. */
  const show=(tr,kind,all)=>{
    const tag=tr.dataset.attr,next=tr.nextElementSibling;
    if(next&&next.classList.contains('daydetail'))next.remove();
    tr.querySelectorAll('.attr-open').forEach(b=>{const on=b.dataset.kind===kind;b.classList.toggle('open',on);b.setAttribute('aria-expanded',String(on))});
    if(!kind){ATTR_OPEN.delete(tag);return}
    const t=RESULT.tags.find(x=>x.tag===tag);if(!t)return;
    ATTR_OPEN.set(tag,{kind,all});
    const det=document.createElement('tr');det.className='daydetail';
    det.innerHTML=`<td colspan="${head.length}">${attrProductsHTML(t,kind,all)}</td>`;
    tr.after(det);
    const more=det.querySelector('.attr-more');
    // The list is redrawn with its button; focus follows to the new one.
    if(more)more.onclick=()=>{show(tr,kind,more.dataset.more==='all');const next=tr.nextElementSibling&&tr.nextElementSibling.querySelector('.attr-more');if(next)next.focus({preventScroll:true})};
  };
  tb.querySelectorAll('tbody tr[data-attr]').forEach(tr=>{
    tr.querySelectorAll('.attr-open').forEach(b=>b.onclick=()=>{
      const cur=ATTR_OPEN.get(tr.dataset.attr);
      show(tr,cur&&cur.kind===b.dataset.kind?'':b.dataset.kind,false);
    });
    const was=ATTR_OPEN.get(tr.dataset.attr);
    if(was)show(tr,was.kind,was.all);
  });
  const btn=$('btnAttrAll');btn.classList.toggle('hidden',rows.length<=cut);
  btn.textContent=ATTR_ALL?`Tampilkan ${cut} teratas`:`Tampilkan semua ${rows.length} tag`;btn.setAttribute('aria-pressed',String(ATTR_ALL));
  btn.onclick=()=>{ATTR_ALL=!ATTR_ALL;renderAttr()};
  const both=tot.direct.comm+tot.indirect.comm;
  $('attrStrip').innerHTML=[['Pesanan langsung',nf(tot.direct.orders)],['Komisi langsung',rp(tot.direct.comm)],['Pesanan tidak langsung',nf(tot.indirect.orders)],['Komisi tidak langsung',rp(tot.indirect.comm)],['Porsi komisi tidak langsung',both>0?(tot.indirect.comm/both*100).toFixed(0)+'%':'—']]
    .concat(unk?[['Tidak diketahui',nf(tot.unknown.orders)+' pesanan']]:[])
    .map(x=>`<div class="s"><div class="l">${x[0]}</div><div class="v">${x[1]}</div></div>`).join('');
  const odd=(A.unknownValues||[]).map(v=>`"${v.value}" (${nf(v.rows)} baris)`).join(', ');
  $('attrNote').textContent=`Kolom "${A.column}"`+(tot.mixed?` · ${nf(tot.mixed)} pesanan campuran dihitung di kedua sisi`:'')+(odd?` · nilai tak dikenali: ${odd}`:'');
}
/* Share of Meta link clicks that never reached Shopee. Negative means Shopee
   counted more clicks than Meta sent (organic or shared links). The colour is
   the link verdict the Klik tab and the "cek link" note use, judged from 300
   clicks. Beside a "klik masuk rendah" note (days the ad ran) a healthy period
   total stays uncoloured rather than green. Rounded from the arriving share
   itself, as the note is, so "hanya 8%" sits next to 92%, not 93%. */
function lostCell(t,tip){if(t==null||typeof t!=='object')return lostPctCell(t,tip);const v=t.lostTotal,L=t.leak;if(v==null||!isFinite(v))return'<td class="num">—</td>';
  const sev=L&&L.reliable?L.severity:'',cls=sev==='bad'||sev==='warn'?'leak-'+sev:t.capture&&t.capture.low?'':sev?'leak-'+sev:'';
  const r=L&&isFinite(L.pct)?100-Math.round(L.pct):Math.round(v),wait=L&&!L.reliable?` · belum dinilai: ${nf(L.metaClicks)} klik iklan (perlu ±300)`:'';
  return`<td class="num ${cls}" title="${tip}${wait}">${r<0?'+'+nf(-r)+'% lebih':nf(r)+'%'}</td>`}
/* A plain share with no per-tag link verdict behind it, such as a platform
   total in the placement card. */
function lostPctCell(v,tip){if(v==null||!isFinite(v))return'<td class="num">—</td>';const cls=v>=50?'neg':v<=10?'pos':'',r=100-Math.round(100-v);return`<td class="num ${cls}" title="${tip}">${r<0?'+'+nf(-r)+'% lebih':nf(r)+'%'}</td>`}
/* A platform total judged like a tag's link: same thresholds, and only from
   300 Meta clicks, so the placement card and the tag table colour alike. */
function platformLeak(p){if(p.lost==null||!isFinite(p.lost))return null;const a=100-p.lost,L=E.LINK;
  return{lostTotal:p.lost,leak:{pct:a,metaClicks:p.clicks,reliable:p.clicks>=L.minClicks,severity:a<L.low?'bad':a<L.warn?'warn':a>L.over?'over':'ok'}}}
/* Every Shopee click on the tag inside the click report window. The tooltip
   splits it by Perujuk; the platform card has the full Facebook/Instagram/Other
   breakdown. */
function inCell(t){
  if(!t.shopeeClicks)return'<td class="num">—</td>';
  const s=t.shopeeSrc,tip=`Jendela laporan klik. Pada jendela yang sama Meta mencatat ${nf(t.winClicks)} klik.`
    +(s?` Menurut Perujuk: Facebook ${nf(s.fb)} · Instagram ${nf(s.ig)} · Other ${nf(s.other)}.`:'');
  return`<td class="num" title="${tip}">${nf(t.shopeeClicks)}</td>`;
}
function renderMain(){let th=MC.map(x=>`<th class="${x[2]?'num':''}${x[0]==='cpcIdeal'?' col-ideal':''}" data-sort="${x[0]}" tabindex="0" aria-sort="${SORT.key===x[0]?(SORT.dir<0?'descending':'ascending'):'none'}">${x[1]}${SORT.key===x[0]?(SORT.dir<0?' ▾':' ▴'):''}</th>`).join('');$('tblMain').querySelector('thead').innerHTML='<tr>'+th+'</tr>';let rows=visibleTags().slice().sort((a,b)=>{if(a.spend>0!==b.spend>0)return a.spend>0?-1:1;let x=a[SORT.key],y=b[SORT.key];if(SORT.key==='tag')return SORT.dir*String(x).localeCompare(y);x=x!=null&&isFinite(x)?x:-1e15;y=y!=null&&isFinite(y)?y:-1e15;return SORT.dir*(x-y)});$('tblMain').querySelector('tbody').innerHTML=rows.map(t=>{
  // A verdict that flips when the lag setting moves is not safe to act on yet.
  const s=STAB&&STAB.tags.find(x=>x.tag===t.tag);
  const frail=s&&!s.stable?` <span class="pill" title="Vonis berubah bila lag digeser: ${s.byLag.map(b=>'lag '+b.lag+' → '+b.status).join(', ')}">rapuh</span>`:'';
  // A ROAS a few orders away from the threshold that decided the verdict.
  const edge=t.borderAt!=null?` <span class="pill edge" title="ROAS matang ${rx(t.matureRoasEff)} berada dalam ±10% dari ambang ${t.borderAt===RESULT.options.thScale?'Scale':'Pantau'} ${rx(t.borderAt)}. Beberapa pesanan saja bisa membalik vonis.">di batas</span>`:'';
  return `<tr class="dayrow" data-bd="${esc(t.tag)}" tabindex="0" role="button" aria-expanded="false"><td><div class="tagcell"><span class="nm">${esc(t.tag)} <span class="badge ${t.status}">${t.label}</span>${frail}${edge}</span><span class="rs">${esc(t.reason)}${t.linkNote?` · <b class="${t.linkTone==='over'?'leak-over':'neg'}">${esc(t.linkNote)}</b>`:''}${t.bidHint?' · '+esc(t.bidHint):''}</span></div></td><td class="num">${rp(t.spend)}</td><td class="num">${rp(t.commEff)}</td><td class="num ${t.netEff>=0?'pos':'neg'}">${rp(t.netEff)}</td><td class="num">${rx(t.roasEff)}</td><td class="num">${t.spend?t.roi.toFixed(0)+'%':'—'}</td><td class="num">${rp(t.cpm)}</td><td class="num">${t.clicks?nf(t.clicks):'—'}</td>${inCell(t)}<td class="num">${t.clicks?full(t.cpc):'—'}</td><td class="num">${t.lpv?nf(t.lpv):'—'}</td><td class="num"${t.cpLpv?` title="${full(t.spend)} biaya ÷ ${nf(t.lpv)} LP view"`:''}>${t.cpLpv?full(t.cpLpv):'—'}</td><td class="num"${t.cpcShopee?` title="${full(t.winSpend)} biaya pada jendela klik ÷ ${nf(t.shopeeClicks)} klik masuk"`:''}>${t.cpcShopee?full(t.cpcShopee):'—'}</td>${lostCell(t,`Jendela laporan klik: ${nf(t.winClicks)} klik Meta → ${nf(t.leak?t.leak.shopeeClicks:t.shopeeClicks)} klik Shopee${t.shopeeSrc?' dari Facebook/Instagram':''}`)}<td class="num col-ideal"><b>${t.clicks?full(t.cpcIdeal):'—'}</b></td><td class="num">${nf(t.orders)}</td><td class="num">${t.clicks?dec(t.convRate,2)+'%':'—'}</td><td class="num">${t.orders?rp(t.costPerOrder):'—'}</td><td class="num">${t.daysProd||'—'}</td></tr>`;
}).join('');if(!rows.length)$('tblMain').querySelector('tbody').innerHTML=`<tr><td colspan="${MC.length}" class="tbl-empty">${FILTER?'Tidak ada tag berstatus '+filterName(FILTER)+' pada periode ini.':'Tidak ada tag pada periode ini.'}</td></tr>`;
  $('tagSearchCount').textContent=rows.length+' dari '+RESULT.tags.length+' tag';
  $('filterNote').textContent=FILTER?'Disaring: '+filterName(FILTER)+' · '+rows.length+' tag':'';
  const rg=RESULT.range;
  $('tagNote').textContent=(rg.clickStart?`Kolom Shopee dari laporan klik ${rg.clickStart} — ${rg.clickEnd} · `:'')
    +'klik judul kolom untuk mengurutkan';$('btnClearFilter').classList.toggle('hidden',!FILTER);$('btnClearFilter').onclick=()=>{FILTER=null;renderDecisions();renderMain()};bindBreakdown('tblMain',tag=>{const t=RESULT.tags.find(x=>x.tag===tag);return t?{byDate:t.byDate}:null},MC.length);
  $('tblMain').querySelectorAll('th[data-sort]').forEach(e=>e.onclick=()=>{SORT.key===e.dataset.sort?SORT.dir*=-1:(SORT.key=e.dataset.sort,SORT.dir=-1);renderMain()});$('tblMain').querySelectorAll('th[data-sort]').forEach(e=>e.onkeydown=event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();const k=e.dataset.sort;e.click();$('tblMain').querySelector(`th[data-sort="${k}"]`).focus()}})}
/* ── Part 2: ad units, leakage, daily, trend, details, matching, charts ── */
const UC=[['adName','Ad Unit',0],['delivery','Status',0],['spend','Spend+PPN',1],['cpm','CPM',1],['impr','Impresi',1],['clicks','Klik Meta',1],['cpc','CPC Meta',1],['lpv','LP View',1],['cpLpv','Biaya/LP View',1],['shopeeClicks','Klik Shopee',1],['cpcShopee','CPC Shopee',1],['cpcIdeal','CPC Ideal',1],['ctr','CTR %',1],['orders','Order',1],['convRate','CR %',1],['commEff','Komisi Efektif',1],['netEff','Laba',1],['roi','ROI %',1],['costPerOrder','Biaya/Order',1]];
/* One name can belong to several ads (copies in other campaigns). Only then
   does the row say which one it is. */
function repeatedNames(list){const seen=new Set(),twin=new Set();list.forEach(x=>{seen.has(x.adName)?twin.add(x.adName):seen.add(x.adName)});return twin}
function whichAd(x){return [x.campaign,x.adId?'Ad ID '+x.adId:''].filter(Boolean).join(' · ')||'tanpa Ad ID'}
function renderUnit(){
  const u=RESULT.adUnits;
  const r=RESULT.range;
  $('adunitNote').textContent=u.length+' ad unit · '+r.start+' — '+r.end
    +(r.clickStart?` · kolom Shopee dari laporan klik ${r.clickStart} — ${r.clickEnd}`:'');
  $('tblUnit').querySelector('thead').innerHTML='<tr>'+UC.map(c=>`<th class="${c[2]?'num':''}${c[0]==='cpcIdeal'?' col-ideal':''}">${c[1]}</th>`).join('')+'</tr>';
  const emptyUnit=!adsRows().length
    ? 'Laporan Meta Ads belum dimuat — tabel ini butuh data iklan.'
    : 'Tidak ada iklan dengan biaya pada periode ini.';
  if(!u.length){
    $('tblUnit').querySelector('tbody').innerHTML=`<tr><td colspan="${UC.length}" class="tbl-empty">${emptyUnit}</td></tr>`;
    return;
  }
  const twin=repeatedNames(u);
  $('tblUnit').querySelector('tbody').innerHTML=u.map(x=>`<tr class="dayrow" data-bd="${esc(x.key)}" tabindex="0" role="button" aria-expanded="false">
    <td><div class="tagcell"><span class="nm">${esc(x.adName)} <span class="badge ${x.status}">${x.label}</span></span>
    <span class="rs">Tag: <span class="pill">${esc(x.tag)}</span>${x.estimated?' · komisi proporsional':''}${twin.has(x.adName)?' · '+esc(whichAd(x)):''}</span></div></td>
    <td><span class="dot ${x.active?'on':'off'}"></span>${x.active?'Nyala':'Mati'}</td>
    <td class="num">${rp(x.spend)}</td><td class="num">${rp(x.cpm)}</td>
    <td class="num">${nf(x.impr)}</td><td class="num">${nf(x.clicks)}</td>
    <td class="num">${full(x.cpc)}</td>
    <td class="num">${x.lpv?nf(x.lpv):'—'}</td>
    <td class="num"${x.lpv?` title="${full(x.spend)} biaya ÷ ${nf(x.lpv)} LP view"`:''}>${x.lpv?full(x.spend/x.lpv):'—'}</td>
    <td class="num"${x.shopeeClicks?' title="Jendela laporan klik, dibagi proporsional dari tag induk"':''}>${x.shopeeClicks?nf(x.shopeeClicks):'—'}</td>
    <td class="num"${x.cpcShopee?' title="Biaya pada jendela klik ÷ klik masuk, di tingkat tag"':''}>${x.cpcShopee?full(x.cpcShopee):'—'}</td>
    <td class="num col-ideal"><b>${full(x.cpcIdeal)}</b></td>
    <td class="num">${dec(x.ctr,2)}</td><td class="num">${nf(x.orders)}</td>
    <td class="num">${dec(x.convRate,2)}</td><td class="num">${rp(x.commEff)}</td>
    <td class="num ${x.netEff>=0?'pos':'neg'}">${rp(x.netEff)}</td>
    <td class="num ${x.roi>=0?'pos':'neg'}">${x.spend?x.roi.toFixed(0)+'%':'—'}</td>
    <td class="num">${x.orders?rp(x.costPerOrder):'—'}</td></tr>`).join('');
  bindBreakdown('tblUnit',key=>{const a=RESULT.adUnits.find(x=>x.key===key);
    return a?{title:a.adName+(twin.has(a.adName)?' · '+whichAd(a):''),byDate:a.byDate,note:a.estimated?'komisi & klik Shopee proporsional dari tag':''}:null},UC.length);
}
const LEAK_OPEN=new Set();
function renderLeak(){
  const r=RESULT.range;
  $('leakRange').textContent=r.clickStart?`Klik report ${r.clickStart} s/d ${r.clickEnd}`:'Click report belum dimuat';
  const rows=RESULT.tags.filter(t=>t.leak&&isFinite(t.leak.pct));
  const bySrc=RESULT.tags.some(t=>t.shopeeSrc);
  // Spend, commission and profit on the click report's days, so a tag reads
  // as profitable or not beside its clicks without opening it.
  const win=t=>Object.values(t.byDate||{}).filter(x=>x.date>=r.clickStart&&x.date<=r.clickEnd)
    .reduce((a,x)=>(a.spend+=x.spend,a.commEff+=x.commEff,a),{spend:0,commEff:0});
  const per=`Tanggal laporan klik ${r.clickStart} s/d ${r.clickEnd}`;
  $('tblLeak').querySelector('thead').innerHTML='<tr>'+['Tag','Klik Meta',bySrc?'Klik Shopee FB+IG':'Klik Shopee','± Klik','% Masuk','Biaya Klik Kurang','Biaya','Komisi Efektif','Laba','Catatan'].map((h,i)=>`<th class="${i&&i<9?'num':''}"${i>5&&i<9?` title="${per}"`:''}>${h}</th>`).join('')+'</tr>';
  $('tblLeak').querySelector('tbody').innerHTML=rows.length?rows.sort((a,b)=>a.leak.pct-b.leak.pct).map(t=>{
    const L=t.leak;
    // Signed, because the two directions mean different things: missing clicks
    // point at the link, extra clicks are outside traffic that inflates ROAS.
    // Small samples are not judged. The note cell keeps a floor width so phones
    // scroll the table sideways instead of growing very tall rows.
    const d=L.shopeeClicks-L.metaClicks,w=win(t),net=w.commEff-w.spend;
    const note=!L.reliable?`Belum bisa dinilai: ${nf(L.metaClicks)} klik iklan (perlu ±300)`
      : L.severity==='bad'?'Kurang dari 25% klik sampai — periksa link'
      : L.severity==='warn'?'Sebagian klik tidak sampai; wajar bila klik sangat murah'
      : L.severity==='over'?(bySrc?`Semua perujuk ${nf(Math.round(L.allPct))}% dari klik iklan`:'Jauh di atas klik iklan')+' — ada trafik lain (organik, akun lain, atau iklan lain yang salah tag). ROAS tag ini batas atas'
      : d>0?'Sedikit di atas klik iklan':d<0?'Selisih kecil, wajar':'Pas dengan klik berbayar';
    const open=LEAK_OPEN.has(t.tag);
    return `<tr><td><button class="attr-open${open?' open':''}" data-leak-tag="${esc(t.tag)}" aria-expanded="${open}" title="Lihat placement ${esc(t.tag)}"><b>${esc(t.tag)}</b><span class="exp" aria-hidden="true">▸</span></button></td><td class="num">${nf(L.metaClicks)}</td><td class="num">${nf(L.shopeeClicks)}</td>
      <td class="num ${d<0?'neg':d>0?'pos':''}">${d>0?'+':''}${nf(d)}</td>
      <td class="num ${L.reliable?'leak-'+L.severity:''}">${dec(L.pct,1)}%</td>
      <td class="num ${L.wasted>0?'neg':''}">${L.wasted>0?rp(L.wasted):'—'}</td>
      <td class="num">${w.spend?rp(w.spend):'—'}</td><td class="num">${w.commEff?rp(w.commEff):'—'}</td>
      <td class="num ${net>0?'pos':net<0?'neg':''}">${w.spend||w.commEff?rp(net):'—'}</td>
      <td style="white-space:normal;min-width:220px;font-size:11px;color:var(--text-dim)">${note}</td></tr>`
      +(open?`<tr class="daydetail"><td colspan="10">${leakPlcDetail(t)}</td></tr>`:'');
  }).join(''):`<tr><td colspan="10" style="text-align:center;color:var(--text-mute);padding:24px">Muat Website Click Report untuk melihat perbandingan klik.</td></tr>`;
  // Opened in place, so focus and the chosen sort order stay put.
  $('tblLeak').querySelectorAll('button[data-leak-tag]').forEach(b=>b.onclick=()=>{
    const tag=b.dataset.leakTag,tr=b.closest('tr'),next=tr.nextElementSibling,open=!LEAK_OPEN.has(tag);
    if(open){LEAK_OPEN.add(tag);tr.insertAdjacentHTML('afterend',`<tr class="daydetail"><td colspan="10">${leakPlcDetail(RESULT.tags.find(x=>x.tag===tag))}</td></tr>`)}
    else{LEAK_OPEN.delete(tag);if(next&&next.classList.contains('daydetail'))next.remove()}
    b.classList.toggle('open',open);b.setAttribute('aria-expanded',String(open))});
}
/* One tag's clicks by platform and placement, on the click report's window
   so the rows add up to the tag's row above. Shopee's "Perujuk" names the
   platform (Facebook, Instagram), never the placement: arrivals and % masuk
   are real per platform only. Per placement, spend and clicks are Meta's and
   commission is the platform's commission split by click share. */
function leakPlcDetail(t){
  const P=RESULT.leakPlacement,r=RESULT.range,box=h=>`<div class="daybox attr-box leak-plc">${h}</div>`;
  if(!DATA.placement.length)return box('<p class="hint">Unggah file <b>Meta Ads per placement</b> (kotak ke-4) untuk melihat biaya, klik, dan komisi per placement tag ini.</p>');
  const T=P&&P.tags.find(x=>x.tag===t.tag);
  if(!T)return box(`<p class="hint">${P?`Tag ini tidak ada di file placement (${P.range.start} s/d ${P.range.end}).`:`File placement tidak mencakup periode laporan klik (${r.clickStart} s/d ${r.clickEnd}).`}</p>`);
  // A whole-period file that reaches outside the click report would count
  // clicks Shopee never had a chance to record. Without "Perujuk" no click
  // has a platform, so arrivals are compared for the whole tag only.
  const inWin=P.hasClicks&&P.range.start>=r.clickStart&&P.range.end<=r.clickEnd,same=inWin&&P.hasClickSrc;
  const k=1+(RESULT.options.ppn||0)/100,num=(v,c)=>`<td class="num${c?' '+c:''}">${v}</td>`,dash=num('—');
  // Placement spend is Meta's, without PPN; costs here carry it like every other Biaya.
  const cost=v=>v?full(v*k):'—',money=v=>v?full(v):'—',count=v=>v?nf(v):'—',ctr=v=>v==null||!isFinite(v)?'—':dec(v,2)+'%';
  const roas=v=>v==null||!isFinite(v)?'—':`<span class="${v>=1?'pos':'neg'}">${rx(v)}</span>`;
  const plats=['Facebook','Instagram','Lainnya'].filter(x=>{const p=T.platforms[x];return p&&(p.spend||p.clicks||p.shopeeClicks||p.comm)});
  const sum=f=>plats.reduce((s,x)=>s+(T.platforms[x][f]||0),0),clicks=sum('clicks'),impr=sum('impr'),spend=sum('spend');
  const share=c=>clicks?dec(c/clicks*100,0)+'%':'—';
  // Same verdict and 300-click floor as the tag row. "Lainnya" (Messenger,
  // Audience Network, Threads) mostly arrives under Shopee's Other, so its
  // share would read as lost clicks it is not: counted, not turned into a %.
  const arrived=(meta,shopee,judge,ok=same)=>{
    if(!ok)return dash+dash;
    if(!judge)return num(count(shopee))+'<td class="num" title="Klik Messenger, Audience Network, dan Threads biasanya tercatat di Shopee sebagai Other">—</td>';
    if(!meta)return num(count(shopee))+dash;
    const L=platformLeak({lost:100-shopee/meta*100,clicks:meta}).leak;
    return num(count(shopee))+num(dec(shopee/meta*100,1)+'%',L.reliable?'leak-'+L.severity:'');
  };
  const body=plats.map(x=>{
    const p=T.platforms[x];
    const places=(T.placements||[]).filter(q=>q.platform===x&&(q.spend||q.clicks)).sort((a,b)=>b.clicks-a.clicks||b.spend-a.spend);
    return`<tr class="plc-plat"><td>${esc(x)}</td>${num(cost(p.spend))}${num(count(p.clicks))}${num(share(p.clicks))}${num(ctr(p.ctr))}${num(p.cpc==null?'—':full(p.cpc*k))}${arrived(p.clicks,p.shopeeClicks,x!=='Lainnya')}${num(money(p.comm))}${num(roas(P.hasOrderPlatform&&p.spend?p.comm/(p.spend*k):null))}</tr>`
      +places.map(q=>`<tr class="plc-place"><td>${esc(q.placement)}</td>${num(cost(q.spend))}${num(count(q.clicks))}${num(share(q.clicks))}${num(ctr(q.ctr))}${num(q.cpc==null?'—':full(q.cpc*k))}<td class="num" title="Shopee tidak mencatat placement">—</td><td class="num" title="Shopee tidak mencatat placement">—</td>${num(money(q.estComm),'est')}${num(P.hasOrderPlatform&&q.spend?rx(q.estComm/(q.spend*k)):'—','est')}</tr>`).join('');
  }).join('');
  const o=T.platforms[Placement.OTHER];
  const other=P.hasClickSrc&&o&&(o.shopeeClicks||o.comm)?`<tr class="plc-other"><td>Other (bukan FB/IG)</td><td colspan="5"><small class="src-other">Bukan klik iklan Meta</small></td>${num(same?count(o.shopeeClicks):'—')}${dash}${num(money(o.comm))}${dash}</tr>`:'';
  const meta=P.hasClickSrc?['Facebook','Instagram'].reduce((s,x)=>s+(T.platforms[x]?T.platforms[x].shopeeClicks:0),0):Object.values(T.platforms).reduce((s,p)=>s+(p.shopeeClicks||0),0);
  const head=['Platform / placement','Biaya','Klik Meta','Porsi klik','CTR','CPC Meta','Klik Shopee','% Masuk','Komisi','ROAS'];
  return box(`<div class="dayhead">Placement · ${esc(t.tag)} <span>${P.range.start} s/d ${P.range.end}</span></div>
    <div class="tscroll"><table class="daytbl"><thead><tr>${head.map((h,i)=>`<th class="${i?'num':''}">${h}</th>`).join('')}</tr></thead><tbody>${body}${other}</tbody>
    <tfoot><tr><td>Total tag</td>${num(cost(spend))}${num(count(clicks))}${num(clicks?'100%':'—')}${num(ctr(impr?clicks/impr*100:null))}${num(clicks?full(spend*k/clicks):'—')}${arrived(clicks,meta,true,inWin)}${num(money(T.comm))}${num(roas(spend?T.comm/(spend*k):null))}</tr></tfoot></table></div>
    <p class="hint">Shopee hanya mencatat asal klik per platform (Facebook atau Instagram), bukan per placement. Jadi % masuk dihitung per platform, dan kebocoran per placement (misalnya Stories) tidak bisa diukur di sini. Komisi dan ROAS placement (miring) adalah estimasi: komisi platform dibagi menurut porsi klik, seolah klik semua placement sama-sama sampai ke Shopee. Untuk menguji Stories, pisahkan Stories ke iklan dengan tag sendiri, lalu bandingkan % masuk-nya.`
    +(inWin?'':` File placement ${P.range.start} s/d ${P.range.end} tidak berada di dalam periode laporan klik (${r.clickStart} s/d ${r.clickEnd}), jadi klik masuk tidak dihitung.`)
    +(!inWin||P.hasClickSrc?'':' Laporan klik tanpa kolom Perujuk, jadi klik Shopee tidak bisa dibagi per platform; klik masuk hanya dihitung untuk total tag.')
    +(P.hasOrderPlatform?'':' Laporan komisi tanpa kolom Platform, jadi komisi per platform kosong.')+'</p>');
}
function renderDaily(){
  const d=RESULT.daily,k=RESULT.kpi;
  $('dailyStrip').innerHTML=[['Impresi',nf(k.impr)],['Klik',nf(k.clicks)],['CTR',dec(k.ctr,2)+'%'],['CPM',rp(k.cpm)],['CPC',rp(k.cpc)],['Landing View',nf(k.lpv)],['CR',dec(k.convRate,2)+'%'],['GMV',rp(k.gmv)],['Biaya/Order',rp(k.costPerOrder)]].map(x=>`<div class="s"><div class="l">${x[0]}</div><div class="v">${x[1]}</div></div>`).join('');
  $('tblDaily').querySelector('thead').innerHTML='<tr>'+DAYCOLS.map((h,i)=>`<th class="${i>1?'num':''}">${h}</th>`).join('')+'</tr>';
  $('tblDaily').querySelector('tbody').innerHTML=d.slice().reverse().map(x=>dayRow(x)).join('');
  $('tblDaily').querySelectorAll('[data-day]').forEach(tr=>{
    tr.onclick=()=>toggleDay(tr.dataset.day,tr);
    tr.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();toggleDay(tr.dataset.day,tr)}};
  });
}
const DAYCOLS=['','Tanggal','Biaya','Komisi Efektif','Laba','ROAS','Klik Meta','CPC Meta','Klik Shopee','CPC Shopee',
  'Order','Biaya/Order','Nilai/Order','Komisi/Order'];
// Averages per order sit next to the per-click costs. Cost per order says what
// a sale costs to buy; value and commission per order say what it is worth.
// A cost per click with no spend behind it is not zero, it is absent — organic
// tags print "—" rather than a Rp0 that reads like a bargain. Commission per
// order is effective, like the Komisi column beside it.
function orderCells(v,orders){
  return `<td class="num">${nf(v.clicks)}</td>
    <td class="num">${v.clicks&&v.spend?full(v.spend/v.clicks):'—'}</td>
    <td class="num">${v.shopeeClicks?nf(v.shopeeClicks):'—'}</td>
    <td class="num">${v.shopeeClicks&&v.spend?full(v.spend/v.shopeeClicks):'—'}</td>
    <td class="num">${nf(orders)}</td>
    <td class="num">${orders&&v.spend?rp(v.spend/orders):'—'}</td>
    <td class="num">${orders?rp(v.gmv/orders):'—'}</td>
    <td class="num">${orders?rp((v.commEff!=null?v.commEff:v.comm)/orders):'—'}</td>`;
}
function dayRow(x){
  return `<tr class="dayrow" data-day="${x.date}" tabindex="0" role="button" aria-expanded="false"${x.mature?'':' style="opacity:.6"'}>
    <td class="expcell"><span class="exp">▸</span></td>
    <td><b>${x.date}</b>${x.mature?'':' <span class="pill">belum matang</span>'}</td>
    <td class="num">${rp(x.spend)}</td><td class="num" title="Total ${full(x.comm)}">${rp(x.commEff)}</td>
    <td class="num ${x.netEff>=0?'pos':'neg'}">${rp(x.netEff)}</td>
    <td class="num">${x.spend?dec(x.roasEff,2):'—'}</td>
    ${orderCells(x,x.orders)}</tr>`;
}
function toggleDay(date,tr){
  if(tr.nextElementSibling&&tr.nextElementSibling.classList.contains('daydetail')){
    tr.nextElementSibling.remove();tr.classList.remove('open');tr.setAttribute('aria-expanded','false');return;
  }
  const rows=RESULT.tags.map(t=>({tag:t.tag,status:t.status,label:t.label,d:t.byDate&&t.byDate[date]}))
    .filter(x=>x.d).sort((a,b)=>b.d.spend-a.d.spend||b.d.comm-a.d.comm);
  const body=rows.length?rows.map(x=>{
    const v=x.d,net=v.commEff-v.spend;
    return `<tr><td><b>${esc(x.tag)}</b> <span class="badge ${x.status}">${x.label}</span></td>
      <td class="num">${rp(v.spend)}</td><td class="num">${rp(v.commEff)}</td>
      <td class="num ${net>=0?'pos':'neg'}">${rp(net)}</td>
      <td class="num">${v.spend?dec(v.commEff/v.spend,2):'—'}</td>
      ${orderCells(v,v.orders)}</tr>`;
  }).join(''):`<tr><td colspan="${DAYCOLS.length-1}" style="color:var(--text-mute);padding:14px">Tidak ada tag yang aktif pada tanggal ini.</td></tr>`;
  const det=document.createElement('tr');
  det.className='daydetail';
  det.innerHTML=`<td colspan="${DAYCOLS.length}"><div class="daybox">
    <div class="dayhead">Rincian per tag · ${date} <span>${rows.length} tag</span></div>
    <div class="tscroll"><table class="daytbl"><thead><tr>${
      ['Tag',...DAYCOLS.slice(2)].map((h,i)=>`<th class="${i?'num':''}">${h}</th>`).join('')
    }</tr></thead><tbody>${body}</tbody></table></div>
  </div></td>`;
  tr.after(det);tr.classList.add('open');tr.setAttribute('aria-expanded','true');
}

/* Status Order — the only view that shows cancelled and unpaid orders, since
   every other number in the dashboard drops them. Answers one question: how
   much is still hanging, and from which days. */
function renderStatus(){
  const days=RESULT.statusDaily||[],r=RESULT.range;
  const T={done:0,pending:0,unpaid:0,cancelled:0,orders:0,comm:0};
  const C={done:0,pending:0,unpaid:0,cancelled:0};
  days.forEach(d=>{
    T.done+=d.done;T.pending+=d.pending;T.unpaid+=d.unpaid;T.cancelled+=d.cancelled;
    T.orders+=d.orders;T.comm+=d.comm;
    ['done','pending','unpaid','cancelled'].forEach(k=>C[k]+=d.commBy[k]||0);
  });
  const settled=days.filter(d=>d.settled).length,open=days.filter(d=>d.open>0).length;
  $('statNote').textContent=`${r.start} — ${r.end} · ${days.length} hari ada order · ${settled} sudah settle · ${open} masih ada tertunda`;
  // Shopee zeroes commission on cancelled rows, so that cell shows the lost
  // order value instead; the prefixes keep the two kinds of rupiah apart.
  const K=RESULT.kpi,X=K.excluded||{};
  const box=(k,label,n,sub,cls)=>`<div class="stat-cell ${cls}">
    <div class="sl">${label}</div><div class="sv">${nf(n)}</div>
    <div class="sc">${sub}</div></div>`;
  $('statSum').innerHTML=
    box('done','Selesai',T.done,'komisi '+rp(C.done),'ok')+
    box('pending','Tertunda',T.pending,'komisi '+rp(C.pending),'warn')+
    box('unpaid','Belum Dibayar',T.unpaid,'komisi '+rp(C.unpaid),'warn')+
    box('cancelled','Dibatalkan',T.cancelled,'nilai pesanan '+rp(X.cancelledValue||0),'bad')+
    `<div class="stat-cell bad"><div class="sl">Tingkat Batal</div><div class="sv">${dec(K.cancelRate||0,1)}%</div>
      <div class="sc">${nf(X.cancelledOrders)} dari ${nf(K.cancelBase)} pesanan · menurut nilai ${dec(K.cancelValueRate||0,1)}%${X.cancelledMax?' · terbesar '+rp(X.cancelledMax):''}</div></div>`+
    `<div class="stat-cell total"><div class="sl">Komisi belum final</div>
      <div class="sv">${rp(C.pending+C.unpaid)}</div>
      <div class="sc">dari ${nf(T.pending+T.unpaid)} pesanan · ${T.orders?dec((T.pending+T.unpaid)/T.orders*100,1):0}% dari semua</div></div>`;

  const byDate={};days.forEach(d=>byDate[d.date]=d);
  const all=[];
  for(let d=new Date(r.start+'T00:00:00Z');d<=new Date(r.end+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+1))
    all.push(d.toISOString().slice(0,10));
  $('statGrid').innerHTML=all.map(k=>{
    const d=byDate[k];
    const day=k.slice(8),mon=k.slice(5,7);
    if(!d)return `<div class="statcard none"><div class="sh"><b>${day}</b><span>kosong</span></div></div>`;
    const cls=d.settled?'settled':(d.open?'open':'none');
    return `<div class="statcard ${cls}" title="${k}">
      <div class="sh"><b>${day}</b><span>${d.settled?'Settle':d.open?'Berjalan':'—'}</span></div>
      <div class="sq">
        <span><em>Selesai</em><i class="ok">${nf(d.done)}</i></span>
        <span><em>Tertunda</em><i class="${d.pending?'warn':''}">${nf(d.pending)}</i></span>
        <span><em>Blm bayar</em><i class="${d.unpaid?'warn':''}">${nf(d.unpaid)}</i></span>
        <span><em>Batal</em><i class="${d.cancelled?'bad':''}">${nf(d.cancelled)}</i></span>
      </div>
      <div class="sf"><em>Komisi</em>${rp(d.comm)}</div>
      <div class="sf mute"><em>Belum final</em>${rp((d.commBy.pending||0)+(d.commBy.unpaid||0))}</div>
    </div>`;
  }).join('');
}
function renderTrend(){
  const tr=E.buildTrend(snaps(),active());
  // classList.toggle coerces its second argument, so `has` must be a real
  // boolean — passing the delta object here silently inverted the panels.
  const has=tr.series.length>=2 && !!tr.delta;
  $('trendEmpty').classList.toggle('hidden',has);
  $('trendBody').classList.toggle('hidden',!has);
  if(!has)return;
  const d=tr.delta,last=tr.latest,prev=tr.prev;
  // Snapshot fields can be null (leakPct on tags without click data, or any
  // metric absent from an older snapshot), so coerce before formatting.
  const n=v=>(typeof v==='number'&&isFinite(v))?v:0;
  // An arrow alone does not say how much, or against what. Show the signed
  // change and name the baseline period once, above the strip.
  const dl=(v,fmt,inv)=>{v=n(v);if(!v)return '';const good=inv?v<0:v>0;
    return ` <span class="dlt ${good?'up':'down'}">${v>0?'▲':'▼'} ${fmt(Math.abs(v))}</span>`};
  const pct=v=>dec(n(v),2);
  $('trendRange').textContent=tr.series.length+' snapshot · '+tr.series[0].period+' — '+last.period;
  $('trendBase').innerHTML=prev?`Perubahan dibanding periode <b>${esc(prev.period)}</b>.`:'';
  // A PPN switch between saves moves Laba, Biaya and ROAS by itself.
  const ppns=[...new Set(tr.series.map(s=>s.ppn).filter(v=>v!=null))];
  if(ppns.length>1)$('trendBase').innerHTML+=` <b>PPN berbeda antar snapshot (${ppns.map(v=>v+'%').join(', ')})</b>: laba, biaya dan ROAS tidak sebanding.`;
  $('trendStrip').innerHTML=[
    ['Laba',rp(n(last.netEff))+dl(d.netEff,rp)],
    ['ROAS Berbayar',rx(n(last.paidRoas))+dl(d.paidRoas,pct)],
    ['ROAS Gabungan',rx(n(last.roasEff))+dl(d.roasEff,pct)],
    ['Biaya',rp(n(last.spend))+dl(d.spend,rp,1)],
    ['Order',nf(n(last.orders))+dl(d.orders,nf)],
    ['Biaya klik kurang (maks.)',rp(n(last.wasted))+dl(d.wasted,rp,1)],
    ['Organik',n(last.organicShare).toFixed(0)+'%'],['Snapshot',tr.series.length],
  ].map(x=>`<div class="s"><div class="l">${x[0]}</div><div class="v">${x[1]}</div></div>`).join('');
  const mv=tr.movers.slice(0,12);
  $('tblMovers').querySelector('thead').innerHTML='<tr>'+['Tag','Dari','Ke','Perubahan','Status Awal','Status Kini'].map((h,i)=>`<th class="${i&&i<4?'num':''}">${h}</th>`).join('')+'</tr>';
  $('tblMovers').querySelector('tbody').innerHTML=mv.length?mv.map(m=>`<tr>
    <td><b>${esc(m.tag)}</b></td><td class="num">${rx(n(m.from))}</td><td class="num">${rx(n(m.to))}</td>
    <td class="num ${n(m.delta)>=0?'pos':'neg'}">${n(m.delta)>=0?'+':''}${dec(n(m.delta),2)}</td>
    <td><span class="badge ${esc(m.fromStatus||'evaluasi')}">${esc(m.fromStatus||'—')}</span></td>
    <td><span class="badge ${esc(m.toStatus||'evaluasi')}">${esc(m.toStatus||'—')}</span>${m.changed?' <span class="pill">berubah</span>':''}</td></tr>`).join('')
    :`<tr><td colspan="6" style="text-align:center;color:var(--text-mute);padding:20px">Belum ada tag yang muncul di dua snapshot.</td></tr>`;
}
let PRODVIEW='comm';
function renderDetails(){
  const b=RESULT.breakdown;
  $('tblShop').querySelector('thead').innerHTML='<tr><th>Toko</th><th class="num">Komisi</th></tr>';
  $('tblShop').querySelector('tbody').innerHTML=b.shop.slice(0,12).map(s=>`<tr>
    <td style="white-space:normal;max-width:280px">${esc(s.name)}</td><td class="num">${rp(s.comm)}</td></tr>`).join('');
  renderProducts();
}
function renderProducts(){
  const b=RESULT.breakdown,byComm=PRODVIEW==='comm';
  const rows=(byComm?b.productByComm:b.productByQty).slice(0,20);
  $('prodTitle').textContent=byComm?'Komisi Terbesar':'Produk Terlaris';
  $('prodNote').textContent=byComm?'diurutkan dari komisi tertinggi':'diurutkan dari jumlah unit terjual';
  const max=rows.reduce((m,p)=>Math.max(m,byComm?p.comm:p.qty),0)||1;
  $('tblProdMain').querySelector('thead').innerHTML='<tr>'+
    ['Produk',byComm?'Komisi':'Qty','','GMV','Order',byComm?'Qty':'Komisi']
      .map((h,i)=>`<th class="${i&&i!==2?'num':''}">${h}</th>`).join('')+'</tr>';
  $('tblProdMain').querySelector('tbody').innerHTML=rows.length?rows.map(p=>{
    const lead=byComm?p.comm:p.qty;
    // A bar next to the number turns twenty rows into one shape you can scan.
    return `<tr><td style="white-space:normal;max-width:340px">${esc(p.name)}</td>
      <td class="num"><b>${byComm?rp(p.comm):nf(p.qty)}</b></td>
      <td class="barcell"><span class="minibar" style="width:${(lead/max*100).toFixed(1)}%"></span></td>
      <td class="num">${rp(p.gmv)}</td><td class="num">${nf(p.orders)}</td>
      <td class="num">${byComm?nf(p.qty):rp(p.comm)}</td></tr>`;
  }).join(''):`<tr><td colspan="6" style="text-align:center;color:var(--text-mute);padding:22px">Belum ada data produk.</td></tr>`;
}
document.querySelectorAll('[data-prod]').forEach(b=>b.onclick=()=>{
  PRODVIEW=b.dataset.prod;
  document.querySelectorAll('[data-prod]').forEach(x=>x.classList.toggle('active',x===b));
  renderProducts();
});
// Helicopter view: one square per day, so a whole month reads as a shape.
// The daily table below answers "how much"; this answers "which days".
let CALVIEW='net';
const CALDEF={
  net:{label:'Laba',val:(d,B)=>B.net(d),signed:true},
  roas:{label:'ROAS',val:(d,B)=>B.roas(d)==null?null:B.roas(d)-1,signed:true},
  comm:{label:'Komisi',val:(d,B)=>B.comm(d),signed:false},
  spend:{label:'Biaya',val:d=>d.spend,signed:false},
};
/* Calendar and charts put commission on its click day (Waktu Klik): by order
   date a day with little spend collects orders from earlier clicks and looks
   profitable (must 30 Sep read 4,14x; by click 0,84x). Null = unknown, never 0.
   The Rincian Harian table stays on the order date and says so. */
function dayBasis(){const R=RESULT,on=!!(R&&R.byClick&&R.byClick.available);return{on,label:on?'tanggal klik':'tanggal pesanan',comm:x=>on?x.commEffByClick:x.commEff,net:x=>on?x.netEffByClick:x.netEff,roas:x=>x.spend>0?(on?x.roasEffByClick:x.roasEff):null,ripe:x=>on?x.matureByClick:x.mature}}
function renderCalendar(){
  const el=$('calendar'),days=RESULT.daily;
  if(!days.length){el.innerHTML='';$('calNote').textContent='';return}
  const B=dayBasis(),C=CALDEF[CALVIEW],vals=days.map(d=>C.val(d,B)).filter(v=>v!=null&&isFinite(v));
  const mag=Math.max(...vals.map(Math.abs),1);
  const byMonth={};
  days.forEach(d=>{(byMonth[d.date.slice(0,7)]=byMonth[d.date.slice(0,7)]||{})[d.date]=d});
  const NM=['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agu','Sep','Okt','Nov','Des'];
  const DOW=['Sen','Sel','Rab','Kam','Jum','Sab','Min'];
  el.innerHTML=Object.keys(byMonth).sort().map(mk=>{
    const [y,m]=mk.split('-').map(Number);
    const first=new Date(Date.UTC(y,m-1,1)),last=new Date(Date.UTC(y,m,0)).getUTCDate();
    const pad=(first.getUTCDay()+6)%7; // grid starts Monday
    let cells=Array(pad).fill('<span class="cday pad"></span>');
    for(let i=1;i<=last;i++){
      const key=`${mk}-${String(i).padStart(2,'0')}`,d=byMonth[mk][key];
      if(!d){cells.push(`<span class="cday none"><b>${i}</b></span>`);continue}
      const v=C.val(d,B),net=B.net(d),cm=B.comm(d),ro=B.roas(d),ripe=B.ripe(d);
      let cls='zero',op=0;
      if(v!=null&&isFinite(v)){op=Math.min(Math.abs(v)/mag,1);cls=C.signed?(v>=0?'pos':'neg'):'pos'}
      // All four numbers live in the square. The switcher above now only picks
      // which one drives the colour and sits on the top line — nobody should
      // have to click through four views to read one day.
      // The lead number sits on its own line at full size; the three below drop
      // the "Rp" so "Komisi 1,1jt" fits a 90px square without being cut off.
      // rp(null) prints Rp0; an unknown click day shows a dash instead.
      const lines=[
        ['Laba',net==null?'—':rp(net),net==null?'':net>=0?'up':'down',rpShort(net)],
        ['Komisi',cm==null?'—':rp(cm),'',rpShort(cm)],
        ['Biaya',rp(d.spend),'',rpShort(d.spend)],
        ['ROAS',ro==null?'—':dec(ro,2)+'x',''],
      ];
      const lead=lines.splice({net:0,comm:1,spend:2,roas:3}[CALVIEW],1)[0];
      cells.push(`<span class="cday ${cls}${ripe?'':' raw'}" style="--i:${op.toFixed(3)}"
        title="${key} · ${nf(d.orders)} order (tgl pesanan) · ${nf(d.clicks)} klik Meta${d.shopeeClicks?' · '+nf(d.shopeeClicks)+' klik Shopee':''}${ripe?'':' · data belum matang'}">
        <b>${i}</b><i class="${lead[2]}"><em>${lead[0]}</em>${lead[1]}</i>
        <u>${lines.map(l=>`<span><em>${l[0]}</em>${l[3]||l[1]}</span>`).join('')}</u></span>`);
    }
    return `<div class="calmonth"><h4>${NM[m-1]} ${y}</h4>
      <div class="cgrid">${DOW.map(x=>`<span class="cdow">${x}</span>`).join('')}${cells.join('')}</div></div>`;
  }).join('');
  $('calNote').textContent=`${days.length} hari · warna mengikuti ${C.label} · ${B.label} · kotak bergaris belum matang`;
}
document.querySelectorAll('[data-cal]').forEach(b=>b.onclick=()=>{
  CALVIEW=b.dataset.cal;
  document.querySelectorAll('[data-cal]').forEach(x=>x.classList.toggle('active',x===b));
  renderCalendar();
});
/* A suggestion used to mean opening Kelola Tag and typing the mapping by hand
   — the setup people choose this tool to avoid. Each suggested tag is now a
   button that saves that one mapping and recalculates. */
function suggestHtml(m,twin){const list=(m.candidates&&m.candidates.length)?m.candidates:(m.candidateTag?[m.candidateTag]:[]);if(!list.length)return'';
  // Several ads share this name: the choice is stored for this Ad ID only.
  const key=twin&&m.adId?'id:'+m.adId:m.adName.trim();
  const lead=m.method==='Ambigu'?'Cocok ke beberapa tag — pilih satu:':'Saran:';
  return `<div class="pick-tags"><span>${lead}</span> ${list.map(t=>`<button class="btn sm" type="button" data-accept-ad="${esc(m.adName)}" data-accept-key="${esc(key)}" data-accept-tag="${esc(t)}" title="Sambungkan iklan ini ke ${esc(t)}">${esc(t)}</button>`).join(' ')}</div>`}
function acceptMatch(key,ad,tag){const m=map();m[key||ad.trim()]=tag;
  try{saveMap(m)}catch(err){return toast('Mapping gagal disimpan: penyimpanan tidak tersedia')}toast(ad+' → '+tag);
  // Keep the rows below in step: Simpan rebuilds the map from them, and would
  // otherwise drop the mapping just accepted.
  $('mapRows').innerHTML=Object.keys(m).map(k=>mapRow(k,m[k])).join('')||mapRow('','');bindDel();recalc()}
$('tblMatch').addEventListener('click',e=>{const b=e.target.closest('[data-accept-tag]');if(b)acceptMatch(b.dataset.acceptKey,b.dataset.acceptAd,b.dataset.acceptTag)});
function pickFrom(input){
  const tag=input.value.trim();if(!tag)return;
  if(!RESULT.tags.some(t=>t.tag===tag))return toast('Tag "'+tag+'" tidak ada di laporan Shopee. Pilih dari daftar.');
  acceptMatch(input.dataset.pickKey,input.dataset.pickAd,tag);
}
$('tblMatch').addEventListener('click',e=>{const b=e.target.closest('[data-pick-go]');if(b)pickFrom(b.parentElement.querySelector('input[data-pick-key]'))});
$('tblMatch').addEventListener('keydown',e=>{const i=e.target.closest('input[data-pick-key]');if(i&&e.key==='Enter'){e.preventDefault();pickFrom(i)}});
let MATCH_QUERY='',MATCH_OPEN=false;
$('matchSearch').oninput=()=>{MATCH_QUERY=$('matchSearch').value.trim().toLocaleLowerCase();if(RESULT)renderMatch()};
$('matchOnlyOpen').onchange=()=>{MATCH_OPEN=$('matchOnlyOpen').checked;if(RESULT)renderMatch()};
/* Ads with spend that no Shopee tag claims. Their spend sits on a tag of
   their own name with no clicks or commission, so it reads as pure loss. */
function unmatchedAds(){return RESULT.matchLog.filter(m=>m.confidence<.5&&m.spend>0).sort((a,b)=>b.spend-a.spend)}
/* Tags an unmatched ad can be joined to: every sub_id Shopee reported.
   Those with clicks or commission but no ad come first: an ad whose name
   was mistyped usually left exactly such a tag behind. */
function pickableTags(){
  const shopee=RESULT.tags.filter(t=>t.comm>0||t.shopeeClicks>0||t.orders>0);
  const orphan=shopee.filter(t=>!(t.spend>0)).sort((a,b)=>(b.shopeeClicks||0)-(a.shopeeClicks||0)||b.comm-a.comm);
  const rest=shopee.filter(t=>t.spend>0).sort((a,b)=>a.tag.localeCompare(b.tag));
  return {orphan,rest};
}
// One shared list feeds every picker; typing in a picker searches it.
function tagOptionsHtml(){
  const P=pickableTags(),opt=(t,lead)=>`<option value="${esc(t.tag)}" label="${lead}${t.shopeeClicks?nf(t.shopeeClicks)+' klik':''}${t.comm?' · '+rp(t.comm):''}"></option>`;
  return P.orphan.map(t=>opt(t,'tanpa iklan · ')).join('')+P.rest.map(t=>opt(t,'')).join('');
}
function pickHtml(m,twin){
  const key=twin&&m.adId?'id:'+m.adId:m.adName.trim(),P=pickableTags();
  if(!P.orphan.length&&!P.rest.length)return'';
  return `<div class="pick-manual"><label><span>Pilih tag manual:</span><input type="search" list="tagOptions" placeholder="Ketik untuk cari tag…" autocomplete="off" data-pick-key="${esc(key)}" data-pick-ad="${esc(m.adName)}"></label><button class="btn sm" type="button" data-pick-go>Pasangkan</button></div>`;
}
/* A mapping whose tag catches under ~25% of the ad's Meta link clicks sends
   most of its traffic to another sub_id, even when the name matches exactly. */
const lowCapture=m=>m.confidence>=.5&&!!(m.capture&&m.capture.low);
function renderMatch(){
  $('tblMatch').querySelector('thead').innerHTML='<tr>'+['Nama Iklan','Tag Hasil','Metode','Keyakinan','Biaya','Klik'].map((h,i)=>`<th class="${i>2?'num':''}">${h}</th>`).join('')+'</tr>';
  const twin=repeatedNames(RESULT.matchLog),rank=m=>lowCapture(m)?Math.min(m.confidence,.49):m.confidence;
  const hit=s=>!MATCH_QUERY||String(s||'').toLocaleLowerCase().includes(MATCH_QUERY);
  const list=RESULT.matchLog.filter(m=>(!MATCH_OPEN||m.confidence<.5)&&(hit(m.adName)||hit(m.tag)));
  $('tagOptions').innerHTML=tagOptionsHtml();
  $('matchCount').textContent=`${list.length} dari ${RESULT.matchLog.length} iklan`;
  $('tblMatch').querySelector('tbody').innerHTML=list.slice().sort((a,b)=>{
    // Unmatched ads that spent money are the ones to fix first, biggest first.
    const ua=a.confidence<.5&&a.spend>0,ub=b.confidence<.5&&b.spend>0;
    return ua!==ub?(ua?-1:1):ua?b.spend-a.spend:rank(a)-rank(b)}).map(m=>{
    const c=m.confidence>=.9?'leak-ok':m.confidence>=.5?'leak-warn':'leak-bad';
    const cap=lowCapture(m)?`<br><small class="leak-bad">Klik masuk rendah: klik Shopee di tag ini hanya ${Math.round(m.capture.pct)}% dari klik Meta selama iklan jalan. Cek link iklan.</small>`:'';
    return `<tr><td><b>${esc(m.adName)}</b>${twin.has(m.adName)?`<br><small>${esc(whichAd(m))}</small>`:''}</td><td><span class="pill">${esc(m.tag)}</span>${cap}</td>
      <td>${esc(m.method)}${suggestHtml(m,twin.has(m.adName))}${m.confidence<.5&&m.spend>0?pickHtml(m,twin.has(m.adName)):''}</td><td class="num ${c}">${(m.confidence*100).toFixed(0)}%</td>
      <td class="num">${rp(m.spend)}</td><td class="num">${nf(m.clicks)}</td></tr>`;
  }).join('')||`<tr><td colspan="6" class="tbl-empty">${MATCH_OPEN&&!MATCH_QUERY?'Semua iklan sudah dipasangkan ke tag.':'Tidak ada iklan yang cocok dengan pencarian.'}</td></tr>`;
  // Shopee tags with clicks or commission but no ad: either organic, or the
  // other half of an ad whose name was mistyped.
  const orphan=pickableTags().orphan.filter(t=>hit(t.tag));
  $('tblOrphan').querySelector('thead').innerHTML='<tr><th>Tag</th><th class="num">Klik Shopee</th><th class="num">Pesanan</th><th class="num">Komisi</th></tr>';
  $('tblOrphan').querySelector('tbody').innerHTML=orphan.map(t=>`<tr><td>${esc(t.tag)}</td><td class="num">${nf(t.shopeeClicks)}</td><td class="num">${nf(t.orders)}</td><td class="num">${rp(t.comm)}</td></tr>`).join('')
    ||`<tr><td colspan="4" class="tbl-empty">${MATCH_QUERY?'Tidak ada tag yang cocok dengan pencarian.':'Semua tag Shopee sudah punya iklan.'}</td></tr>`;
  $('orphanCount').textContent=orphan.length+' tag';
  // The mapping table now lives behind one button, so that button has to say
  // when something inside needs looking at.
  const weak=RESULT.matchLog.filter(m=>m.confidence<.5||lowCapture(m)).length;
  const dot=$('mapAlert');
  dot.textContent=weak||'';
  dot.title=weak?`${weak} pencocokan perlu diperiksa`:'';
  dot.classList.toggle('hidden',!weak);
}
/* ── Part 3: charts, tabs, modals, snapshots, export ── */
function cv(v){return getComputedStyle(document.documentElement).getPropertyValue(v).trim()}
function mk(id,cfg){
  const el=$(id); if(!el||typeof Chart==='undefined') return;
  // A canvas inside a hidden tab measures 0x0 and stays blank; the tab switch
  // re-runs renderCharts() once it has a real box.
  if(!el.offsetParent&&!(el.offsetWidth&&el.offsetHeight)) return;
  if(CHARTS[id])CHARTS[id].destroy();
  CHARTS[id]=ChartTheme.create(Chart,el,cfg);
}
const CT=window.ChartTheme;
// Canvas text does not re-flow when the web font arrives; redraw once it has.
if(document.fonts&&document.fonts.ready)document.fonts.ready.then(()=>{if(RESULT)renderCharts()});
function renderCharts(){
  if(!RESULT)return;
  const R=RESULT,d=R.daily,lbl=d.map(x=>x.date.slice(5)),b=R.breakdown;
  const acc=cv('--accent'),ok=cv('--ok'),info=cv('--info'),warn=cv('--warn'),bad=cv('--bad'),org=cv('--organic'),mute=cv('--text-mute');
  // Days still inside the attribution lag are drawn dashed and faded on a
  // shaded background: their commission is still arriving, so the dip at the
  // end is not a real drop. By click date the band also covers click days whose
  // commission is still mostly Tertunda. The unripe days are always a suffix.
  const B=dayBasis(),bc=R.byClick||{};
  const raw=i=>d[i]&&!B.ripe(d[i]),anyRaw=d.some(x=>!B.ripe(x));
  const fresh=(color)=>({segment:{borderDash:c=>raw(c.p1DataIndex)?[5,4]:undefined},
    pointBackgroundColor:d.map(x=>B.ripe(x)?color:color+'55'),pointBorderColor:d.map(x=>B.ripe(x)?color:color+'55')});
  const band=[CT.recentBand(d.findIndex(x=>!B.ripe(x)),cv('--surface-2'),'belum matang')];
  // Headroom above the data keeps the band's label off the top line.
  const shade=anyRaw?' · latar berwarna = belum matang':'',room=anyRaw?{grace:'10%'}:{};
  $('matureNote').textContent='Komisi efektif menurut '+B.label+' · area hijau = laba, merah = rugi'+shade;
  $('roasNote').textContent='Komisi efektif tgl '+(B.on?'klik':'pesanan')+' ÷ biaya hari itu · iklan + organik'+shade;
  // Every rupiah the chart cannot place is named, so the series and this note add up to the KPI.
  $('dailyBasis').textContent=(B.on?['Komisi dicatat pada tanggal klik, jadi tiap hari membandingkan biaya hari itu dengan komisi dari klik hari itu.',
    bc.beforeEff?`${rp(bc.beforeEff)} komisi dari klik sebelum ${R.range.start} tidak masuk grafik.`:'',
    bc.missingEff?`${rp(bc.missingEff)} komisi tanpa tanggal klik yang terbaca juga tidak masuk.`:'',
    bc.dataEnd&&bc.dataEnd<R.range.end?`Laporan komisi berakhir ${bc.dataEnd}; komisi klik sesudahnya belum diketahui.`:'',
    anyRaw?'Hari belum matang: pesanan dari klik itu masih bisa masuk setelah laporan diunduh, atau separuh lebih komisinya masih Tertunda, jadi angkanya masih bisa naik.':'']
    :['Laporan komisi tanpa kolom Waktu Klik: komisi dicatat pada tanggal pesanan, jadi hari berbiaya kecil bisa tampak untung karena menampung pesanan dari klik hari sebelumnya.']).filter(Boolean).join(' ');

  mk('chDaily',{type:'line',plugins:band,data:{labels:lbl,datasets:[
    // The band between the two lines is the day's profit: green above, red below.
    {label:'Komisi Efektif',data:d.map(B.comm),borderColor:ok,backgroundColor:ok,fill:{target:1,above:ok+'2e',below:bad+'2e'},fmt:'money',...fresh(ok)},
    {label:'Biaya Iklan',data:d.map(x=>x.spend),borderColor:acc,backgroundColor:acc,fill:false,fmt:'money',...fresh(acc)}]},
    options:{scales:{y:CT.axis('money',{beginAtZero:true,...room})}}});
  const thScale=R.options&&Number.isFinite(R.options.thScale)?R.options.thScale:2;
  // A day without spend has no ROAS; null leaves its bar out instead of a red 0x.
  mk('chRoas',{type:'bar',plugins:band,data:{labels:lbl,datasets:[{label:B.on?'ROAS efektif (tgl klik)':'ROAS efektif',data:d.map(B.roas),fmt:'ratio',order:1,
    backgroundColor:d.map(x=>{const v=B.roas(x),c=v==null?mute:v>=thScale?ok:v>=1?warn:bad;return B.ripe(x)?c:c+'55'})},
    CT.reference('Impas 1x',1,d.length,mute),
    CT.reference('Target scale '+CT.ratio(thScale),thScale,d.length,ok)]},
    options:{scales:{y:CT.axis('ratio',{beginAtZero:true,...room})}}});
  mk('chClicks',{type:'line',data:{labels:lbl,datasets:[
    {label:'Klik Meta',data:d.map(x=>x.clicks),borderColor:info,backgroundColor:info,fmt:'count'},
    {label:'Klik Shopee',data:d.map(x=>x.shopeeClicks),borderColor:warn,backgroundColor:warn,fmt:'count'},
    {label:'Order',data:d.map(x=>x.orders),borderColor:ok,backgroundColor:ok,borderDash:[2,3],fmt:'count',yAxisID:'y1'}]},
    options:{scales:{y:CT.axis('count',{beginAtZero:true,title:{display:true,text:'Klik',color:mute}}),
      y1:CT.axis('count',{position:'right',beginAtZero:true,grid:{display:false},border:{display:false},
        title:{display:true,text:'Order',color:mute}})}}});

  const pf=b.platform.slice(0,6);
  mk('chPlat',{type:'doughnut',data:{labels:pf.map(x=>x.name),datasets:[{label:'Komisi',data:pf.map(x=>x.comm),fmt:'money',
    backgroundColor:[acc,ok,info,warn,bad,org],borderColor:cv('--surface'),borderWidth:2}]},options:{cutout:'62%'}});
  const ct=b.category.slice(0,8);
  mk('chCat',{type:'bar',data:{labels:ct.map(x=>x.name.slice(0,22)),datasets:[{label:'Komisi',
    data:ct.map(x=>x.comm),backgroundColor:acc,fmt:'money'}]},
    options:{indexAxis:'y',plugins:{legend:{display:false}},scales:{x:CT.axis('money',{beginAtZero:true,grid:{display:true}}),y:{grid:{display:false}}}}});
  mk('chHour',{type:'bar',data:{labels:b.hourly.map(h=>String(h.hour).padStart(2,'0')),datasets:[{label:'Komisi',
    data:b.hourly.map(h=>h.comm),backgroundColor:info,fmt:'money'}]},
    options:{plugins:{legend:{display:false},tooltip:{callbacks:{title:items=>items[0].label+':00'}}},scales:{y:CT.axis('money',{beginAtZero:true})}}});
  const lp=R.lagProfile.slice(0,8);
  mk('chLag',{type:'bar',data:{labels:lp.map(x=>'H+'+x.day),datasets:[
    {label:'% pesanan',data:lp.map(x=>x.pct),backgroundColor:info,fmt:'pct'},
    {label:'kumulatif %',data:lp.map(x=>x.cumulative),type:'line',borderColor:acc,backgroundColor:acc,fmt:'pct'}]},
    options:{scales:{y:CT.axis('pct',{beginAtZero:true,max:100})}}});
  const st=R.settlement.filter(s=>s.age<=21);
  mk('chSettle',{type:'line',data:{labels:st.map(s=>'H+'+s.age),datasets:[{label:'% tertunda',
    data:st.map(s=>s.pendingPct),borderColor:warn,backgroundColor:warn+'22',fill:'origin',fmt:'pct'}]},
    options:{plugins:{legend:{display:false}},scales:{y:CT.axis('pct',{beginAtZero:true,max:100})}}});
  const sc=b.clickSource.slice(0,6);
  mk('chSrc',{type:'doughnut',data:{labels:sc.map(x=>x.name),datasets:[{label:'Klik',data:sc.map(x=>x.count),fmt:'count',
    backgroundColor:[info,ok,acc,warn,bad,org],borderColor:cv('--surface'),borderWidth:2}]},options:{cutout:'62%'}});
  const rg=b.clickRegion.slice(0,6);
  mk('chRegion',{type:'bar',data:{labels:rg.map(x=>x.name.slice(0,18)),datasets:[{label:'Klik',
    data:rg.map(x=>x.count),backgroundColor:warn,fmt:'count'}]},
    options:{indexAxis:'y',plugins:{legend:{display:false}},scales:{x:CT.axis('count',{beginAtZero:true,grid:{display:true}}),y:{grid:{display:false}}}}});

  const tr=E.buildTrend(snaps(),active());
  if(tr.series.length>=2){
    const tl=tr.series.map(s=>s.period);
    mk('chTrend',{type:'bar',data:{labels:tl,datasets:[
      {label:'Biaya',data:tr.series.map(s=>s.spend),backgroundColor:acc+'99',fmt:'money'},
      {label:'Komisi Efektif',data:tr.series.map(s=>s.commEff),backgroundColor:ok+'99',fmt:'money'},
      {label:'Laba',data:tr.series.map(s=>s.netEff),type:'line',borderColor:info,backgroundColor:info,pointRadius:3,fmt:'money'}]},
      options:{scales:{y:CT.axis('money',{beginAtZero:true})}}});
    mk('chTrendRoas',{type:'line',data:{labels:tl,datasets:[
      {label:'ROAS Berbayar',data:tr.series.map(s=>s.paidRoas),borderColor:acc,backgroundColor:acc,pointRadius:3,fmt:'ratio'},
      {label:'ROAS Gabungan',data:tr.series.map(s=>s.roasEff),borderColor:ok,backgroundColor:ok,pointRadius:3,fmt:'ratio'}]},
      // Start at zero: a truncated axis makes a small ROAS move look dramatic.
      options:{scales:{y:CT.axis('ratio',{beginAtZero:true})}}});
    mk('chTrendMix',{type:'bar',data:{labels:tl,datasets:[
      {label:'Scale',data:tr.series.map(s=>s.counts.scale||0),backgroundColor:ok,stack:'s'},
      {label:'Pantau',data:tr.series.map(s=>s.counts.pantau||0),backgroundColor:warn,stack:'s'},
      {label:'Stop',data:tr.series.map(s=>s.counts.stop||0),backgroundColor:bad,stack:'s'},
      {label:'Organik',data:tr.series.map(s=>s.counts.organik||0),backgroundColor:org,stack:'s'}]},
      options:{scales:{x:{stacked:true},y:CT.axis('count',{stacked:true,beginAtZero:true,ticks:{precision:0}})}}});
  }
}
function updateAnalysisAvailability(){
  updateImportUI();
  $('main').classList.toggle('stored-only',!RESULT);
  document.querySelectorAll('.tab').forEach(t=>t.disabled=!RESULT&&t.dataset.tab!=='tersimpan');
}
$('btnStored').onclick=()=>{
  updateAnalysisAvailability();$('main').classList.remove('hidden');$('emptyState').classList.add('hidden');
  document.querySelector('[data-tab="tersimpan"]').click();
};
document.querySelectorAll('.tab').forEach(t=>t.onclick=()=>{
  document.querySelectorAll('.tab').forEach(x=>{x.classList.remove('active');x.setAttribute('aria-selected','false');x.tabIndex=-1});
  document.querySelectorAll('.panel').forEach(x=>x.classList.remove('active'));
  t.classList.add('active');t.setAttribute('aria-selected','true');t.tabIndex=0;
  document.querySelector(`[data-panel="${t.dataset.tab}"]`).classList.add('active');
  requestAnimationFrame(()=>{if(RESULT)renderCharts()});
});
// Arrow keys move between tabs, as in any tab strip; Tab leaves the strip.
document.querySelector('.tabs').addEventListener('keydown',e=>{
  const tabs=[...document.querySelectorAll('.tab:not(:disabled)')],i=tabs.indexOf(document.activeElement);
  if(i<0)return;
  const next={ArrowRight:i+1,ArrowLeft:i-1,Home:0,End:tabs.length-1}[e.key];
  if(next==null)return;
  e.preventDefault();const t=tabs[(next+tabs.length)%tabs.length];t.focus();t.click();
});

/* ── Export PDF ─────────────────────────────────────────────────────────────
   Printed through the browser rather than a PDF library: text stays sharp and
   selectable, the file stays small, and nothing new is pulled from a CDN.
   html2canvas + jsPDF would add roughly a megabyte and hand back a raster.

   Charts are the catch. A canvas inside a hidden panel was drawn at zero size,
   so it prints blank — every panel is made visible and the charts redrawn
   before the print dialog opens, then everything is put back. */
const PDFMODE={
  ringkas:{label:'Ringkas',parts:['tags','units','peluang']},
  standar:{label:'Standar',parts:['tags','units','peluang','harian','kalender']},
  lengkap:{label:'Lengkap',parts:['tags','units','peluang','harian','kalender','klik','produk','statsum','statgrid']},
};
$('btnPdf').onclick=openPdfModal;
document.querySelectorAll('[data-pdf]').forEach(b=>b.onclick=()=>downloadPdf(b.dataset.pdf));
$('btnBrowserPrint').onclick=()=>runPrint('ringkas');

function runPrint(mode){
  const M=PDFMODE[mode]; if(!M||!RESULT||document.body.classList.contains('printing'))return;
  const r=RESULT.range;
  $('phAcct').textContent=active();
  $('phRange').textContent=`Periode ${r.start} — ${r.end} · PPN biaya iklan ${RESULT.options.ppn}%`;
  $('phMade').textContent='Dibuat '+new Date().toLocaleString('id-ID',{dateStyle:'long',timeStyle:'short'});
  closeModal($('pdfModal'));
  $('pdfBusy').classList.remove('hidden');$('pdfBusy').style.display='';

  const panels=[...document.querySelectorAll('.panel')];
  const wasActive=panels.map(p=>p.classList.contains('active'));
  const cards=[...document.querySelectorAll('#kpis .kpi.expandable,#clickKpis .kpi.expandable')];
  const wasOpen=cards.map(e=>e.classList.contains('open'));

  document.body.classList.add('printing','pr-'+mode);
  M.parts.forEach(p=>document.body.classList.add('pp-'+p));
  panels.forEach(p=>p.classList.add('active'));
  // Every card's detail belongs in a document someone reads away from the app;
  // there is nothing to click on paper.
  cards.forEach(e=>e.classList.add('open'));

  const printMedia=window.matchMedia('print');
  let restored=false,printOpened=false;
  const onMedia=e=>{if(e.matches)printOpened=true;else if(printOpened)restore()};
  const onFocus=()=>{if(!printMedia.matches)restore()};
  const restore=()=>{
    if(restored)return;restored=true;
    window.removeEventListener('afterprint',restore);window.removeEventListener('focus',onFocus);printMedia.removeEventListener('change',onMedia);
    document.body.classList.remove('printing','pr-ringkas','pr-standar','pr-lengkap');
    M.parts.forEach(p=>document.body.classList.remove('pp-'+p));
    panels.forEach((p,i)=>p.classList.toggle('active',wasActive[i]));
    cards.forEach((e,i)=>{e.classList.toggle('open',wasOpen[i]);e.setAttribute('aria-expanded',wasOpen[i]?'true':'false')});
    $('pdfBusy').classList.add('hidden');$('pdfBusy').style.display='none';
    requestAnimationFrame(()=>renderCharts());
  };

  requestAnimationFrame(()=>requestAnimationFrame(()=>{
    try{renderCharts()}catch(e){}
    setTimeout(()=>{
      window.addEventListener('afterprint',restore,{once:true});
      printMedia.addEventListener('change',onMedia);
      window.addEventListener('focus',onFocus);
      Object.values(CHARTS).forEach(chart=>chart.update('none'));
      try{window.print()}catch(e){restore();toast('Dialog cetak tidak tersedia')}
    },mode==='ringkas'?150:700);
  }));
}

/* Tag map modal */
function mapRow(k,v){return `<div class="maprow"><input placeholder="nama iklan di Meta" aria-label="Nama iklan (Meta Ads)" value="${esc(k)}" data-k>
  <span class="maparrow" aria-hidden="true">→</span><input placeholder="tag Shopee" aria-label="Tag Shopee (sub_id)" value="${esc(v)}" data-v>
  <button class="btn ghost" data-del aria-label="Hapus baris" title="Hapus baris">×</button></div>`}
function bindDel(){$('mapRows').querySelectorAll('[data-del]').forEach(b=>b.onclick=()=>b.closest('.maprow').remove())}
function openMap(){const m=map();$('mapRows').innerHTML=Object.keys(m).map(k=>mapRow(k,m[k])).join('')||mapRow('','');openModal('mapModal');bindDel()}
$('btnMap').onclick=openMap;
$('btnSet').onclick=()=>openModal('setModal');
// Presets exist so the eleven fields below stay optional. Order matches
// [targetROI, thScale, thPantau, minSpend, minDays, lagDays, streakDays].
const PRESETS={konservatif:[100,2.5,1.2,100000,5,5,2],seimbang:[80,2,1,50000,3,3,3],agresif:[50,1.5,.8,25000,2,2,4]};
document.querySelectorAll('[data-preset]').forEach(b=>b.onclick=()=>{
  const p=PRESETS[b.dataset.preset]; if(!p)return;
  ['targetROI','thScale','thPantau','minSpend','minDays','lagDays','streakDays'].forEach((id,i)=>$(id).value=p[i]);
  recalc(); toast('Preset '+b.dataset.preset+' dipakai');
});
$('btnAddMap').onclick=()=>{$('mapRows').insertAdjacentHTML('beforeend',mapRow('',''));bindDel()};
$('btnSaveMap').onclick=()=>{const m=Object.create(null);$('mapRows').querySelectorAll('.maprow').forEach(r=>{
  const k=r.querySelector('[data-k]').value.trim(),v=r.querySelector('[data-v]').value.trim();
  if(k&&v)m[k]=v});try{saveMap(m)}catch(e){return toast('Mapping gagal disimpan: penyimpanan tidak tersedia')} closeModal($('mapModal'));toast('Mapping disimpan');recalc()};
const MODAL_OPENERS=new WeakMap();
function openModal(id){const m=$(id),previous=document.querySelector('.modal.show'),opener=previous?(MODAL_OPENERS.get(previous)||document.activeElement):document.activeElement;document.querySelectorAll('.modal.show').forEach(x=>closeModal(x,false));MODAL_OPENERS.set(m,opener);m.classList.add('show');m.setAttribute('aria-hidden','false');document.body.classList.add('modal-open');requestAnimationFrame(()=>m.querySelector('.modal-box').focus())}
function closeModal(m,restore=true){if(!m)return;m.classList.remove('show');m.setAttribute('aria-hidden','true');if(!document.querySelector('.modal.show'))document.body.classList.remove('modal-open');const target=MODAL_OPENERS.get(m);if(restore&&target&&target.isConnected&&!target.disabled&&target.getClientRects().length)target.focus()}
document.querySelectorAll('.modal').forEach((m,i)=>{m.setAttribute('role','dialog');m.setAttribute('aria-modal','true');m.setAttribute('aria-hidden','true');const h=m.querySelector('h2');if(h){h.id=h.id||'dialogTitle'+i;m.setAttribute('aria-labelledby',h.id)}m.querySelector('.modal-box').tabIndex=-1;m.onclick=e=>{if(e.target===m)closeModal(m)}});
document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>closeModal(b.closest('.modal')));
document.addEventListener('keydown',e=>{const m=document.querySelector('.modal.show');if(!m)return;if(e.key==='Escape'){e.preventDefault();closeModal(m);return}if(e.key!=='Tab')return;const items=[...m.querySelectorAll('button,input,select,a[href],[tabindex="0"]')].filter(x=>!x.disabled&&x.getClientRects().length);if(!items.length){e.preventDefault();return}const first=items[0],last=items[items.length-1];if(e.shiftKey&&(document.activeElement===first||!items.includes(document.activeElement))){e.preventDefault();last.focus()}else if(!e.shiftKey&&(document.activeElement===last||!items.includes(document.activeElement))){e.preventDefault();first.focus()}});
/* Snapshots — per account */
$('btnSave').onclick=()=>{
  if(!RESULT)return toast('Belum ada hasil analisis');
  const all=snaps();
  all.unshift(E.toSnapshot(RESULT,{account:active(),id:Math.max(Date.now(),...all.map(x=>x.id+1))}));
  try{
    saveSnaps(all);
    toast('Snapshot disimpan untuk '+active());
    // Refresh the trend surface immediately: the new snapshot may be the second
    // one, which is what flips Perkembangan from empty state to charts.
    renderTrend();renderHistory();requestAnimationFrame(()=>renderCharts());
  }catch(e){toast('Penyimpanan browser penuh')}
};
// Older or imported snapshots may carry no options; a missing PPN is unknown, not 0%.
function snapPpn(x){return x.options&&Number.isFinite(x.options.ppn)?x.options.ppn:null}
function renderHistory(){
  const s=snaps();
  $('histAcct').textContent=active()+' · '+s.length+' snapshot';
  $('histRows').innerHTML=s.length?s.map(x=>`<div class="snaprow">
    <div class="meta"><div class="d">${esc(x.range.start)} — ${esc(x.range.end)}</div>
    <div class="t">disimpan ${esc(x.saved)} · PPN ${snapPpn(x)!=null?snapPpn(x)+'%':'?'} · ROAS berbayar ${rx(x.kpi.paidRoas)} · laba ${rp(x.kpi.netEff)}</div></div>
    <button class="btn sm" data-view="${esc(x.id)}">Lihat</button>
    <button class="btn sm danger" data-del="${esc(x.id)}">Hapus</button></div>`).join('')
    :'<p class="hint">Belum ada snapshot untuk akun ini.</p>';
  $('histRows').querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>{
    const x=snaps().find(y=>y.id===+b.dataset.view); if(!x)return;
    const lines=x.tags.filter(t=>t.spend>0).map(t=>`${t.tag} — ${t.label} · ROAS ${rx(t.roasEff)} · ${t.reason}`).join('\n');
    alert(`${esc(x.range.start)} — ${esc(x.range.end)}\nDisimpan ${x.saved}\nPPN biaya iklan ${snapPpn(x)!=null?snapPpn(x)+'%':'tidak tercatat'}\n\nBiaya ${full(x.kpi.spend)}\nKomisi efektif ${full(x.kpi.commEff)}\nLaba ${full(x.kpi.netEff)}\nROAS berbayar ${rx(x.kpi.paidRoas)}\n\n${lines}`);
  });
  $('histRows').querySelectorAll('[data-del]').forEach(b=>b.onclick=()=>{
    try{saveSnaps(snaps().filter(y=>y.id!==+b.dataset.del));renderHistory();renderTrend();renderCharts();toast('Snapshot dihapus')}catch(e){toast('Snapshot gagal dihapus')}});
}
$('btnHist').onclick=()=>{renderHistory();openModal('histModal')};
// Snapshots are the only record of how an account developed. Keeping them
// locked inside one browser makes them one cache-clear away from gone.
$('btnExportSnaps').onclick=()=>{
  const s=snaps(); if(!s.length)return toast('Belum ada snapshot untuk diekspor');
  const blob=new Blob([JSON.stringify({account:active(),exported:new Date().toISOString(),snapshots:s},null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob),a=document.createElement('a');
  a.href=url;a.download=`riwayat-${active()}-${new Date().toISOString().slice(0,10)}.json`;a.click();
  URL.revokeObjectURL(url);toast(s.length+' snapshot diekspor');
};
$('btnImportSnaps').onclick=()=>$('importFile').click();
$('importFile').onchange=e=>{
  const f=e.target.files&&e.target.files[0];if(!f)return;
  const account=active(),epoch=IMPORT_EPOCH,rd=new FileReader();
  if(f.size>20*1024*1024){$('importFile').value='';return toast('File snapshot terlalu besar (maksimum 20 MB)')}
  rd.onload=()=>{
    try{
      if(account!==active()||epoch!==IMPORT_EPOCH)return;
      const d=JSON.parse(rd.result),incoming=Array.isArray(d)?d:d&&d.snapshots;
      if(!Array.isArray(incoming)||!incoming.length||incoming.length>1000||!incoming.every(validSnapshot))return toast('File tidak berisi snapshot yang valid');
      const cur=snaps(),ids=new Set(cur.map(x=>x.id)),add=[];
      for(const x of incoming){if(ids.has(x.id))continue;ids.add(x.id);add.push({...x,account})}
      saveSnaps(cur.concat(add).sort((a,b)=>String(b.saved).localeCompare(String(a.saved))));
      renderHistory();renderTrend();renderCharts();
      toast(add.length+' snapshot diimpor'+(incoming.length-add.length?', '+(incoming.length-add.length)+' duplikat dilewati':''));
    }catch(err){toast('Impor gagal: file tidak valid atau penyimpanan penuh')}
    finally{$('importFile').value=''}
  };
  rd.onerror=()=>{$('importFile').value='';toast('Gagal membaca snapshot')};
  rd.readAsText(f);
};
/* Exports use the selected analysis period and explicit datasets. */
function downloadBlob(blob,name){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000)}
function qualityNotes(){
  const notes=FILES.flatMap(f=>f.quality||[]);
  if(!adsRows().length)notes.push('Laporan Meta Ads belum dimuat; evaluasi biaya dan ROAS iklan belum lengkap.');
  if(!DATA.clicks.length)notes.push('Laporan klik belum dimuat; kebocoran klik tidak dihitung.');
  if(RESULT&&RESULT.matchLog.some(m=>m.confidence<.5))notes.push('Ada pencocokan iklan lemah yang memerlukan mapping manual.');
  return [...new Set(notes)];
}
function updateExportPreview(){
  if(!RESULT)return;
  const json=$('exportFormat').value==='json',dataset=$('exportDataset').value,scope=$('exportScope').value;
  $('exportDatasetField').classList.toggle('hidden',json);$('exportScopeField').classList.toggle('hidden',json||dataset!=='tags');
  const cfg=DashboardExport.DATASETS[dataset],count=dataset==='tags'&&scope==='visible'?visibleTags().length:RESULT[cfg.key].length;
  $('exportPreview').textContent=json?'Seluruh hasil analisis dan catatan kualitas data akan disertakan.':`${count} baris · ${cfg.label}${dataset==='tags'&&scope==='visible'?' · mengikuti pencarian dan filter':''}.`;
  $('btnDownloadData').textContent=json?'Unduh JSON':'Unduh CSV';$('btnDownloadData').disabled=!json&&!count;
}
$('btnExport').onclick=()=>{if(!RESULT)return toast('Muat data untuk mengekspor analisis');$('exportContext').textContent=active()+' · '+RESULT.range.start+' — '+RESULT.range.end;updateExportPreview();openModal('exportModal')};
['exportFormat','exportDataset','exportScope'].forEach(id=>$(id).onchange=updateExportPreview);
$('btnDownloadData').onclick=()=>{
  if(!RESULT)return;const account=active(),json=$('exportFormat').value==='json',dataset=$('exportDataset').value;
  const options={account,dataset,quality:qualityNotes()};if(!json&&dataset==='tags'&&$('exportScope').value==='visible')options.rows=visibleTags();
  const text=json?DashboardExport.json(RESULT,options):DashboardExport.csv(RESULT,options),extension=json?'json':'csv';
  downloadBlob(new Blob([text],{type:json?'application/json':'text/csv;charset=utf-8'}),`${json?'analisis':dataset}-${DashboardExport.filenamePart(account)}-${RESULT.range.start}_${RESULT.range.end}.${extension}`);
  toast(extension.toUpperCase()+' diunduh');
};
function openPdfModal(){if(!RESULT)return toast('Muat data untuk membuat PDF');$('pdfContext').textContent=active()+' · '+RESULT.range.start+' — '+RESULT.range.end;$('pdfError').classList.add('hidden');openModal('pdfModal')}
$('btnExportPdf').onclick=openPdfModal;
let PDF_LIBRARIES;
function loadPdfLibraries(){
  if(!PDF_LIBRARIES)PDF_LIBRARIES=(async()=>{for(const src of ['vendor/jspdf.umd.min.js','vendor/jspdf.plugin.autotable.min.js','vendor/pdf-font.js','pdf-charts.js','pdf-export.js'])await new Promise((resolve,reject)=>{const script=document.createElement('script');script.src=src;script.onload=resolve;script.onerror=()=>{script.remove();reject(new Error('Pustaka PDF tidak dapat dimuat. Periksa kelengkapan folder aplikasi.'))};document.head.append(script)})})().catch(e=>{PDF_LIBRARIES=null;throw e});
  return PDF_LIBRARIES;
}
async function downloadPdf(mode){
  if(!RESULT||PDF_BUSY)return;
  const result=RESULT,account=active(),epoch=IMPORT_EPOCH,title=$('pdfTitle').value.trim()||'Laporan kinerja affiliate',quality=qualityNotes();
  PDF_BUSY=true;document.querySelectorAll('[data-pdf]').forEach(b=>b.disabled=true);$('pdfBusy').style.display='';$('pdfBusy').classList.remove('hidden');$('pdfError').classList.add('hidden');
  try{
    await loadPdfLibraries();await new Promise(resolve=>requestAnimationFrame(resolve));
    if(epoch!==IMPORT_EPOCH||account!==active()||RESULT!==result)throw new Error('Data atau akun berubah. Buka ulang ekspor untuk membuat laporan terbaru.');
    const version=(($('appVersion')||{}).textContent||'').replace(/^·\s*versi\s*/,'').trim();
    const doc=DashboardPDF.create(result,{account,mode,title,quality,version});
    downloadBlob(doc.output('blob'),`laporan-${DashboardExport.filenamePart(account)}-${result.range.start}_${result.range.end}-${mode}.pdf`);toast('PDF '+mode+' diunduh');
  }catch(e){$('pdfError').textContent=e.message;$('pdfError').classList.remove('hidden')}
  finally{PDF_BUSY=false;document.querySelectorAll('[data-pdf]').forEach(b=>b.disabled=false);$('pdfBusy').classList.add('hidden')}
}
// Pre-PPN spend, for the Spend card's PPN row when an account is billed PPN.
function spendBase(){const k=RESULT.kpi;return Number.isFinite(k.spendBase)?k.spendBase:k.spend/(1+RESULT.options.ppn/100)}
// Settings are per account: two Shopee accounts can bill different VAT and
// tolerate different risk. The old global key was read but never written, so
// nothing carries over from it.
function loadOpts(){
  let saved={};try{const o=JSON.parse(readStorage(LS.opts+'_'+active()));if(o&&typeof o==='object'&&!Array.isArray(o))saved=o}catch(e){}
  const o=E.normalizeOptions({...UI_DEFAULTS,...saved});if(![...$('ppn').options].some(x=>Number(x.value)===o.ppn))o.ppn=UI_DEFAULTS.ppn;O.forEach(k=>$(k).value=o[k]);
}
function saveOpts(){
  const o={};O.forEach(k=>{if($(k))o[k]=$(k).value});
  try{localStorage.setItem(LS.opts+'_'+active(),JSON.stringify(o))}catch(e){toast('Pengaturan belum tersimpan: penyimpanan tidak tersedia')}
}
O.forEach(id=>$(id).addEventListener('change',saveOpts));
document.querySelectorAll('[data-preset]').forEach(b=>b.addEventListener('click',saveOpts));
loadOpts();
updateAnalysisAvailability();
renderHistory();
/* Click any column header to sort a table; click again to reverse. The
   decision table and the direct/indirect table keep their own sorting. The
   chosen order survives re-renders, and an opened detail row moves with
   the row above it. */
const TABLE_SORT={},OWN_SORT=new Set(['tblMain','tblAttr']);
function cellValue(td){
  const s=(td?td.innerText||td.textContent:'').trim().split('\n')[0].trim();
  if(!s||s==='—'||s==='-')return null;
  let t=s.replace(/^Rp\s*/i,'').replace(/^−/,'-'),k=1;
  const neg=/^-/.test(t)||/\blebih\b/.test(t);
  t=t.replace(/^[+-]/,'').replace(/\s*(lebih|lain)\b.*$/,'').replace(/[%x×]$/,'').trim();
  const unit=t.match(/(rb|jt|m)$/i);if(unit){k={rb:1e3,jt:1e6,m:1e9}[unit[1].toLowerCase()];t=t.slice(0,-unit[1].length).trim()}
  // Indonesian numbers: dots group thousands, a comma marks decimals; a dot
  // not followed by exactly three digits is a decimal point (2.50x, 6.02%).
  if(t.includes(','))t=t.replace(/\./g,'').replace(',','.');
  else if(/^\d{1,3}(\.\d{3})+$/.test(t))t=t.replace(/\./g,'');
  if(!/^\d+(\.\d+)?$/.test(t))return s.toLocaleLowerCase('id');
  return (neg?-1:1)*parseFloat(t)*k;
}
function cellAt(tr,col){let i=0;for(const td of tr.cells){if(i===col)return td;i+=td.colSpan||1}return null}
function applyTableSort(table){
  const st=TABLE_SORT[table.id],tb=table.tBodies[0];if(!st||!tb)return;
  const rows=[...tb.rows];
  if(!rows.length||rows.some(r=>r.cells.length===1&&r.cells[0].colSpan>1&&!r.classList.contains('daydetail')))return;
  const groups=[],tail=[];
  rows.forEach(r=>{if(r.classList.contains('daydetail')&&groups.length)groups[groups.length-1].push(r);else if(r.classList.contains('total'))tail.push(r);else groups.push([r])});
  const val=g=>cellValue(cellAt(g[0],st.col));
  const sorted=groups.map((g,i)=>({g,i,v:val(g)})).sort((a,b)=>{
    if(a.v==null||b.v==null)return a.v==null&&b.v==null?a.i-b.i:a.v==null?1:-1;
    if(typeof a.v!==typeof b.v)return typeof a.v==='number'?-1:1;
    return (typeof a.v==='number'?a.v-b.v:a.v.localeCompare(b.v,'id'))*st.dir||a.i-b.i;
  });
  // Moving rows drops focus from a button inside them; give it back.
  const focus=document.activeElement,frag=document.createDocumentFragment();sorted.forEach(x=>x.g.forEach(r=>frag.append(r)));tail.forEach(r=>frag.append(r));
  tb.append(frag);if(focus&&focus!==document.activeElement&&table.contains(focus))focus.focus({preventScroll:true});
}
function markSortHeader(table){
  const st=TABLE_SORT[table.id],head=table.tHead&&table.tHead.rows[0];if(!head)return;
  let i=0;for(const th of head.cells){
    th.classList.toggle('sorted',!!st&&st.col===i);
    th.setAttribute('aria-sort',st&&st.col===i?(st.dir<0?'descending':'ascending'):'none');
    i+=th.colSpan||1;
  }
}
document.querySelectorAll('.tscroll>table[id]').forEach(table=>{
  if(OWN_SORT.has(table.id))return;
  let busy=false;
  const resort=()=>{if(busy||!TABLE_SORT[table.id])return;busy=true;applyTableSort(table);markSortHeader(table);obs.takeRecords();busy=false};
  const obs=new MutationObserver(resort);
  obs.observe(table,{childList:true,subtree:false});
  if(table.tHead)obs.observe(table.tHead,{childList:true});
  if(table.tBodies[0])obs.observe(table.tBodies[0],{childList:true});
  const pick=th=>{
    if(th.closest('table')!==table||!th.closest('thead')||th.colSpan>1)return;
    let col=0;for(const c of th.parentElement.cells){if(c===th)break;col+=c.colSpan||1}
    const cur=TABLE_SORT[table.id],first=[...table.tBodies[0]?.rows||[]].map(r=>cellValue(cellAt(r,col))).find(v=>v!=null);
    TABLE_SORT[table.id]=cur&&cur.col===col?{col,dir:-cur.dir}:{col,dir:typeof first==='number'?-1:1};
    resort();
  };
  table.addEventListener('click',e=>{const th=e.target.closest('th');if(th)pick(th)});
  table.addEventListener('keydown',e=>{const th=e.target.closest('th');if(th&&(e.key==='Enter'||e.key===' ')){e.preventDefault();pick(th)}});
  const tabbable=()=>table.tHead&&[...table.tHead.querySelectorAll('th')].forEach(th=>{if(!th.hasAttribute('tabindex'))th.tabIndex=0});
  new MutationObserver(tabbable).observe(table.tHead||table,{childList:true,subtree:true});tabbable();
});
