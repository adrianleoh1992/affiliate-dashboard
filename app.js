'use strict';
const E=window.Engine,$=id=>document.getElementById(id);
let DATA={affiliate:[],ads:[],clicks:[]},FILES=[],RESULT=null,CHARTS={},SORT={key:'spend',dir:-1},FILTER=null,STAB=null;
let IMPORT_EPOCH=0, IMPORT_QUEUE=Promise.resolve(), PENDING_IMPORTS=0;
let ROW_KEYS={affiliate:new Set(),ads:new Set(),clicks:new Set()};
let IMPORT_REPORTS=[],IMPORT_SEQUENCE=0,TAG_QUERY='',PDF_BUSY=false;
const ACTIVE_READERS=new Set();
const LS={accounts:'adash_accounts_v3',active:'adash_active_v3',map:'adash_map_v3',snaps:'adash_snaps_v3',opts:'adash_opts_v3',theme:'adash_theme_v3'};
const DEFAULT_MAP={'telesinvideo2':'TelesinGripvideo2','telesinvideo1':'TelesinGripvideo2','telesinvideo3':'TelesinGripvideo3','telesingrip':'TelesinGripvideo2','lemariolymp':'OlymplastLemari','lemariolympic':'OlymplastLemari','minilayarportable':'minilayarportable','helmrsixsolid':'HelmRsixSolid','spinningreelokuma':'Spinningreelokuma','seeouokacamatapolarized':'seeouokacamatapolarized'};
const esc=E.escapeHtml;
function rp(n){if(n==null||!isFinite(n))return'Rp0';let a=Math.abs(n),s=n<0?'-':'';if(a>=1e9)return s+'Rp'+(a/1e9).toFixed(2)+' M';if(a>=1e6)return s+'Rp'+(a/1e6).toFixed(1)+' jt';if(a>=1e3)return s+'Rp'+Math.round(a/1e3)+'rb';return s+'Rp'+Math.round(a)}
function full(n){return'Rp'+Math.round(n||0).toLocaleString('id-ID')} function nf(n){return Math.round(n||0).toLocaleString('id-ID')}
function rx(n){return n===Infinity?'∞':Number.isFinite(n)?n.toFixed(2)+'x':'—'}
let TOAST_TIMER;function toast(s){clearTimeout(TOAST_TIMER);let e=$('toast');e.textContent=s;e.classList.add('show');TOAST_TIMER=setTimeout(()=>e.classList.remove('show'),4000)}
function readStorage(key){try{return localStorage.getItem(key)}catch(e){return null}}
function accounts(){try{const a=JSON.parse(readStorage(LS.accounts));return Array.isArray(a)&&a.length&&a.every(x=>typeof x==='string'&&x.trim())?[...new Set(a)]:['default']}catch(e){return['default']}}
function active(){const a=accounts(),saved=readStorage(LS.active);return a.includes(saved)?saved:a[0]}
function setActive(a){localStorage.setItem(LS.active,a)}
function map(){try{const m=JSON.parse(readStorage(LS.map+'_'+active()));return m&&typeof m==='object'&&!Array.isArray(m)?Object.fromEntries(Object.entries(m).filter(([k,v])=>k&&typeof v==='string')):{...DEFAULT_MAP}}catch(e){return{...DEFAULT_MAP}}}
function saveMap(m){localStorage.setItem(LS.map+'_'+active(),JSON.stringify(m))}
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
function applyTheme(t){t=t==='dark'?'dark':'light';document.documentElement.setAttribute('data-theme',t);$('btnTheme').textContent=t==='dark'?'Mode Terang':'Mode Gelap';try{localStorage.setItem(LS.theme,t)}catch(e){}if(RESULT)render()}
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
  $('flowImportNote').textContent=PENDING_IMPORTS?'Memeriksa file…':FILES.length?FILES.length+' file dimuat':'Unggah laporan CSV';
  $('flowAnalyzeNote').textContent=RESULT?(RESULT.tags.length+' tag · '+RESULT.range.start+' — '+RESULT.range.end):'Menunggu laporan komisi';
  $('btnExport').disabled=!RESULT||PENDING_IMPORTS>0;$('btnPdf').disabled=!RESULT||PENDING_IMPORTS>0;
  document.querySelectorAll('[data-accept-import]').forEach(b=>b.disabled=PENDING_IMPORTS>0);
}
function renderImportReports(){
  $('importFeedback').classList.toggle('hidden',!IMPORT_REPORTS.length);
  $('importFeedbackRows').innerHTML=IMPORT_REPORTS.map(report=>{
    const p=report.parsed,issues=p?p.issues:[],state={accepted:'Siap dianalisis',review:'Perlu diperiksa',error:'Tidak dimuat',duplicate:'Duplikat dilewati'}[report.state]||report.state;
    return `<article class="import-result ${report.state}"><div class="import-result-head"><b>${esc(report.name)}</b><span>${state}</span></div>`
      +(p?`<p>${nf(p.stats.accepted)} baris valid${p.stats.rejected?' · '+nf(p.stats.rejected)+' baris bermasalah':''}${p.period?' · '+esc(p.period.start)+' — '+esc(p.period.end):''}</p>`:'')
      +(report.message?`<p>${esc(report.message)}</p>`:'')
      +(issues.length?`<ul>${issues.slice(0,4).map(issue=>`<li>${issue.row&&!/^Baris\s+\d+/.test(issue.message)?'Baris '+issue.row+': ':''}${esc(issue.message)}</li>`).join('')}</ul>${issues.length>4?'<p>'+nf(issues.length-4)+' catatan lain tersedia di rincian CSV.</p>':''}`:'')
      +(report.state==='review'?`<div class="button-row"><button class="btn sm" data-discard-import="${report.id}">Abaikan file</button><button class="btn sm" data-accept-import="${report.id}">Muat ${nf(p.stats.accepted)} baris valid saja</button></div>`:'')
      +(issues.length?`<button class="btn ghost sm" data-issues="${report.id}">Unduh rincian pemeriksaan</button>`:'')+'</article>';
  }).join('');
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
  DATA={affiliate:[],ads:[],clicks:[]};
  ROW_KEYS={affiliate:new Set(),ads:new Set(),clicks:new Set()};
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
  for(const [kind,col] of [['affiliate','Waktu Pemesanan'],['ads','Reporting starts'],['clicks','Waktu Klik']]){
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
const ZONE_EMPTY={affiliate:'Belum ada file',ads:'Belum ada file',clicks:'Belum ada file'};
// One box per report instead of one pile. Deleting a whole report used to mean
// hunting its files inside a single list of chips.
function renderChips(){
  ['affiliate','ads','clicks'].forEach(z=>{
    const box=document.querySelector(`[data-zchips="${z}"]`);
    const mine=FILES.map((f,i)=>({f,i})).filter(x=>x.f.type===z);
    box.innerHTML=mine.length?mine.map(({f,i})=>`<span class="chip ${f.type}"><span class="file-row">
      <span class="fname" title="${esc(f.name)}">${esc(f.name)}</span><span>· ${nf(f.rows-f.duplicates)} baris${f.duplicates?' · '+nf(f.duplicates)+' duplikat dilewati':''}</span>
      <button class="rmfile" data-rm="${i}" title="Hapus file ini" aria-label="Hapus ${esc(f.name)}">×</button></span></span>`).join('')
      :`<span class="zone-empty">${ZONE_EMPTY[z]}</span>`;
    document.querySelector(`[data-zone="${z}"]`).classList.toggle('filled',mine.length>0);
    document.querySelector(`[data-zdel="${z}"]`).classList.toggle('hidden',!mine.length);
  });
  let p=[];if(DATA.affiliate.length)p.push('Affiliate '+nf(DATA.affiliate.length));if(DATA.ads.length)p.push('Ads '+nf(DATA.ads.length));if(DATA.clicks.length)p.push('Klik '+nf(DATA.clicks.length));$('uploadStatus').textContent=p.join(' · ');
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
  invalidateImports();DATA={affiliate:[],ads:[],clicks:[]};ROW_KEYS={affiliate:new Set(),ads:new Set(),clicks:new Set()};FILES=[];clearResult();
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
function recalc(){const o=opts();O.forEach(k=>$(k).value=o[k]);if(o.dateStart&&o.dateEnd&&o.dateStart>o.dateEnd){if(RESULT){$('dateStart').value=RESULT.range.start;$('dateEnd').value=RESULT.range.end}toast('Tanggal mulai harus sebelum tanggal akhir');return}if(!DATA.affiliate.length)return;try{RESULT=E.analyze({...DATA,tagMap:map()},o);STAB=null;updateAnalysisAvailability();render()}catch(e){clearResult();toast('Analisis gagal: '+e.message)}}
function render(){if(!RESULT)return;updateImportUI();let r=RESULT,k=r.kpi; if($('settingsPeek'))$('settingsPeek').textContent=`${r.range.start} — ${r.range.end} · PPN ${r.options.ppn}% · target ROI ${r.options.targetROI}%`;renderPeriod();renderGaps();renderBanner();renderKpi();renderClickKpi();renderActions();renderCalibration();renderSynth();renderDecisions();renderMain();renderUnit();renderLeak();renderDaily();renderCalendar();renderStatus();renderTrend();renderOpportunity();renderDetails();renderMatch();renderCharts()}
function renderActions(){
  const A=RESULT.actions;
  // The advice used to be scattered across rows and never added up. These are
  // the same recommendations expressed as money, which is what gets acted on.
  const cards=[];
  if(A.bidSaving>0)cards.push(['money','Hemat dari Turunkan Bid',rp(A.bidSaving),
    `${A.overbidCount} tag membayar di atas CPC ideal`]);
  if(A.stopSpend>0)cards.push(['risk','Biaya di Tag STOP',rp(A.stopSpend),
    `${A.stopCount} tag, rugi ${rp(A.stopLoss)} periode ini`]);
  if(A.leakWaste>0)cards.push(['risk','Hilang karena Link',rp(A.leakWaste),
    'klik dibayar tapi tak sampai Shopee']);
  // "Total Bisa Dialihkan" was just the sum of the two above it — a fourth tile
  // carrying no new information. It reads as a trailing summary instead.
  const tail=A.reclaimable>0?`<div class="action-card info"><div class="a-label">Total bisa dialihkan</div><div class="a-val">${rp(A.reclaimable)}</div></div>`:'';
  $('actionGrid').innerHTML=cards.map(c=>`<div class="action-card ${c[0]}">
    <div class="a-label">${c[1]}</div><div class="a-val">${c[2]}</div><div class="a-copy">${c[3]}</div></div>`).join('')+tail;
}
function renderCalibration(){
  const L=RESULT.lagCal,el=$('lagCal');
  if(!L||!L.sampleSize){el.innerHTML='';el.className='calibration hidden';return}
  // Lag is the single most decision-changing setting, so show whether the
  // current value actually matches this account's observed behaviour.
  let unstable=0;
  try{if(!STAB)STAB=E.stability({...DATA,tagMap:map()},RESULT.options,[0,3,5,7]);unstable=STAB.unstable}catch(e){STAB=null}
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
  $('tblOrganic').querySelector('thead').innerHTML='<tr>'+['Tag','Komisi','Order','Komisi/Order','Maks Biaya/Order','Kanal Utama'].map((h,i)=>`<th class="${i&&i<5?'num':''}">${h}</th>`).join('')+'</tr>';
  $('tblOrganic').querySelector('tbody').innerHTML=A.organicCandidates.length
    ? A.organicCandidates.map(c=>`<tr><td><b>${esc(c.tag)}</b></td>
      <td class="num">${rp(c.comm)}</td><td class="num">${nf(c.orders)}</td>
      <td class="num">${rp(c.avgComm)}</td><td class="num col-ideal"><b>${rp(c.maxCpa)}</b></td>
      <td>${esc(c.topPlatform||'—')}</td></tr>`).join('')
    : `<tr><td colspan="6" style="text-align:center;color:var(--text-mute);padding:22px">Belum ada tag organik dengan komisi.</td></tr>`;
  if(!C){$('concentration').innerHTML='<p class="hint">Belum ada tag berbayar.</p>';return}
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
  ads:{label:'Meta Ads',col:'Reporting starts',get:()=>DATA.ads},
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
  if(span>3660){card.classList.remove('hidden');$('gapNote').textContent=min+' — '+max;$('gapBody').textContent='Rentang laporan melebihi 10 tahun. Periksa tanggal sumber; rincian tanggal kosong tidak ditampilkan.';return}
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
  if(!rows.length){
    card.classList.remove('hidden');
    $('gapNote').textContent=`${min} — ${max} · ${all.length} hari`;
    $('gapBody').innerHTML=`<div class="gap-ok">${loaded.map(k=>SRC[k].label).join(' dan ')} menutupi seluruh ${all.length} hari, tidak ada tanggal yang bolong.</div>`
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
function renderBanner(){let r=RESULT,k=r.kpi,b=[];if(!DATA.ads.length)b.push(['warn','⚠','Laporan Meta Ads belum dimuat.']);if(!DATA.clicks.length)b.push(['info','ℹ','Website Click Report belum dimuat — kebocoran tidak dihitung.']);if(k.leakTags)b.push(['bad','🚨',`<b>${k.leakTags} tag kehilangan lebih dari 30% klik.</b> Perkiraan biaya terbuang ${rp(k.wasted)} — periksa link.`]);$('banners').innerHTML=b.map(x=>`<div class="banner ${x[0]}"><span>${x[1]}</span><div>${x[2]}</div></div>`).join('');$('lagNote').innerHTML=r.range.matureUntil&&r.range.matureUntil<r.range.end?`Pesanan menyusul setelah klik; vonis STOP dihitung sampai <b>${r.range.matureUntil}</b>.`:''}
// Four cards, matching the mind map. Every number that used to sit in its own
// KPI tile is still here — it moved one level down, into the card it belongs to.
// Eight tiles of equal weight meant nothing stood out; these four have a
// hierarchy, and the detail opens on click.
// Not every Meta export carries a Placement column — it depends on the
// breakdown chosen at export time. Returning null (rather than a single
// "Lainnya · 100%" row) lets the caller say so instead of faking a split.
function placementSplit(){
  if(!DATA.ads.length)return null;
  if(!Object.prototype.hasOwnProperty.call(DATA.ads[0],'Placement'))return null;
  const r=RESULT.range,out={};
  DATA.ads.forEach(a=>{
    const d=E.dayOnly(a['Reporting starts']); if(!E.isDate(d)||d<r.start||d>r.end)return;
    // "Feed" exists on both Facebook and Instagram, so the platform has to be
    // part of the label or the two silently merge into one meaningless row.
    const pl=(a.Placement||'').trim()||'Tanpa placement',pf=(a.Platform||'').trim();
    const key=pf&&!pl.toLowerCase().startsWith(pf.toLowerCase())?`${pf} ${pl}`:pl;
    out[key]=(out[key]||0)+(parseFloat(a['Amount spent (IDR)']||a['Amount spent']||0)||0);
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
  const k=RESULT.kpi,paid=RESULT.tags.filter(t=>t.spend>0);
  const paidComm=paid.reduce((s,t)=>s+t.commEff,0),org=k.organicComm;
  const paidNet=paidComm-k.spend;
  const share=k.commEff?org/k.commEff*100:0;
  const pl=placementSplit();
  const pct=v=>k.commEff?` · ${(v/k.commEff*100).toFixed(0)}%`:'';
  $('kpis').innerHTML=[
    kpiCard('','Komisi Total',rp(k.commEff),`${nf(k.orders)} pesanan · ${nf(k.qty)} produk`,[
      ['Komisi Organik',rp(org)+pct(org)],
      ['Komisi Iklan',rp(paidComm)+pct(paidComm)]]),
    kpiCard('','Spend Iklan',rp(k.spend),`PPN ${RESULT.options.ppn}%`,
      pl||(DATA.ads.length?[
        ['Klik Meta',nf(k.clicks)],
        ['CPM',rp(k.cpm)],
        ['CPC',k.clicks?full(k.cpc):'—'],
        ['Rincian placement','ekspor tanpa breakdown',1]
      ]:[['Laporan Meta belum dimuat','—']])),
    kpiCard(k.netEff>=0?'good':'bad','Laba Bersih',rp(k.netEff),k.netEff>=0?'setelah biaya iklan':'rugi',[
      ['Laba Organik',rp(org)],
      ['Laba Iklan',rp(paidNet)]]),
    // ROAS Organik divides organic commission by the SAME total spend, so the
    // two parts add up to the total exactly. Dividing by organic spend would
    // be dividing by zero; this way the card is a decomposition, not a ratio
    // with a missing denominator.
    kpiCard('','ROAS Total',rx(k.roasEff),
      k.paidRoas<1?`iklan sendiri ${rx(k.paidRoas)} — di bawah impas`:'iklan dan organik digabung',[
      ['ROAS Iklan',rx(k.paidRoas)],
      ['ROAS Organik',k.spend?rx(org/k.spend):'—'],
      ['Kontribusi Organik',share.toFixed(1)+'%']])
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
  DATA.ads.forEach(a=>{
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
  if(!DATA.ads.length&&!hasClicks){el.innerHTML='';return}
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
  const pc=(n,d)=>d?(n/d*100).toFixed(2)+'%':'—';

  const out=[];
  if(DATA.ads.length)out.push(
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
      ['CTR memakai impresi Meta','Shopee tak melaporkan impresi',1]]),
    kpiCard(lost>0?'bad':'','Klik Hilang',nf(lost),
      lost>0?`dari ${lostTags.length} tag · ${rp(k.wasted)} terbuang`:'tidak ada klik yang hilang',
      lost>0?[...lostTags.slice(0,4).map(t=>[t.tag,`−${nf(t.leak.metaClicks-t.leak.shopeeClicks)}`]),
              ['Klik ekstra dari share',`+${nf(gained)}`,1]]
            :[['Klik ekstra dari share',`+${nf(gained)}`,1]]),
    kpiCard(pctIn<100?'bad':'','% Klik Masuk Shopee',pctIn.toFixed(1)+'%',
      pctIn>100?'di atas 100% karena dibagikan orang':'sebagian klik tidak sampai',[
      [`${gainTags.length} tag dibagikan`,`+${nf(gained)} klik`],
      [`${lostTags.length} tag bocor`,`−${nf(lost)} klik`],
      ['Selisih bersih',`${adShopee-adMeta>=0?'+':''}${nf(adShopee-adMeta)} klik`]]));
  el.innerHTML=out.join('');
  bindDrill('clickKpis');
}
function renderSynth(){
  const k=RESULT.kpi,st=k.counts.stop||0;
  $('synth').innerHTML=k.spend?`Periode ini menghasilkan ${k.netEff>=0?'laba':'rugi'} <b>${rp(Math.abs(k.netEff))}</b>. `
    +(k.organicComm>0?`Komisi organik efektif <b>${rp(k.organicComm)}</b>. `:'')
    +`ROAS iklan berbayar <b>${rx(k.paidRoas)}</b>. `
    +(st?`${st} tag berstatus STOP berdasarkan data matang.`:'Belum ada tag berstatus STOP.'):'';
}
function renderDecisions(){let g={scale:[],pantau:[],stop:[],organik:[]};RESULT.tags.forEach(t=>{if(g[t.status])g[t.status].push(t)});g.stop.sort((a,b)=>a.roasEff-b.roasEff);g.pantau.sort((a,b)=>a.roasEff-b.roasEff);g.organik.sort((a,b)=>b.comm-a.comm);let box=(key,title,unit,fn,empty)=>{let a=g[key],it=a.length?a.slice(0,5).map(t=>`<div class="ditem"><span class="n">${esc(t.tag)}</span><span class="v">${fn(t)}</span></div>`).join('')+(a.length>5?`<div class="ditem"><span class="n">+${a.length-5} lainnya</span></div>`:''):`<div class="empty">${empty}</div>`;return`<div class="dcard ${key}${FILTER&&FILTER!==key?' dim':''}" data-filter="${key}" role="button" tabindex="0" aria-pressed="${FILTER===key}"><h4>${title} (${a.length}) <span class="unit">${unit}</span></h4>${it}</div>`};$('dgrid').innerHTML=box('scale','Scale','roas',t=>rx(t.roasEff),`Belum ada tag mencapai ${RESULT.options.thScale}x`)+box('pantau','Pantau','roas',t=>rx(t.roasEff),'Tidak ada')+box('stop','Stop','roas',t=>rx(t.roasEff),'Tidak ada')+box('organik','Organik','komisi',t=>rp(t.comm),'Tidak ada');$('dgrid').querySelectorAll('[data-filter]').forEach(e=>e.onclick=()=>{FILTER=FILTER===e.dataset.filter?null:e.dataset.filter;renderDecisions();renderMain()});$('dgrid').querySelectorAll('[data-filter]').forEach(e=>e.onkeydown=event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();e.click()}})}

/* Rows in Semua Tag and Per Ad Unit open into their own day-by-day history.
   The totals answer "is this working"; the days answer "since when". */
const BDCOLS=['Tanggal','Biaya','Komisi','Laba','ROAS','Klik Meta','CPC Meta','Klik Shopee','Order','Biaya/Order','Nilai/Order'];
function breakdownRows(byDate){
  const r=RESULT.range;
  return Object.keys(byDate||{}).filter(d=>d>=r.start&&d<=r.end).sort().reverse()
    .map(d=>byDate[d]);
}
function breakdownHTML(title,byDate,note){
  const rows=breakdownRows(byDate);
  const body=rows.length?rows.map(v=>{
    const net=v.comm-v.spend,sh=v.shopeeClicks||0;
    return `<tr><td><b>${v.date}</b></td>
      <td class="num">${rp(v.spend)}</td><td class="num">${rp(v.comm)}</td>
      <td class="num ${net>=0?'pos':'neg'}">${rp(net)}</td>
      <td class="num">${v.spend?(v.comm/v.spend).toFixed(2):'—'}</td>
      <td class="num">${nf(v.clicks)}</td>
      <td class="num">${v.clicks&&v.spend?nf(v.spend/v.clicks):'—'}</td>
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
      det.innerHTML=`<td colspan="${cols}">${breakdownHTML('Per hari · '+tr.dataset.bd,it.byDate,it.note)}</td>`;
      tr.after(det);tr.classList.add('open');tr.setAttribute('aria-expanded','true');
    };
    tr.onclick=open;
    tr.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();open()}};
  });
}
const MC=[['tag','Tag / Keputusan',0],['spend','Biaya',1],['commEff','Komisi Efektif',1],['netEff','Laba',1],['roasEff','ROAS',1],['roi','ROI %',1],['cpm','CPM',1],['clicks','Klik Meta',1],['cpc','CPC Meta',1],['shopeeClicks','Klik Shopee',1],['cpcShopee','CPC Shopee',1],['cpcIdeal','CPC Ideal',1],['orders','Order',1],['convRate','CR %',1],['costPerOrder','Biaya/Order',1],['daysProd','Hari',1]];
function visibleTags(){return RESULT?RESULT.tags.filter(t=>(!FILTER||t.status===FILTER)&&(!TAG_QUERY||[t.tag,t.label,t.reason].some(x=>String(x||'').toLocaleLowerCase().includes(TAG_QUERY)))):[]}
$('btnMetrics').onclick=()=>{const compact=$('tblMain').classList.toggle('compact-columns');$('btnMetrics').textContent=compact?'Semua metrik':'Metrik utama';$('btnMetrics').setAttribute('aria-pressed',String(!compact))};
$('tagSearch').oninput=()=>{TAG_QUERY=$('tagSearch').value.trim().toLocaleLowerCase();if(RESULT)renderMain()};
function renderMain(){let th=MC.map(x=>`<th class="${x[2]?'num':''}${x[0]==='cpcIdeal'?' col-ideal':''}" data-sort="${x[0]}" tabindex="0" aria-sort="${SORT.key===x[0]?(SORT.dir<0?'descending':'ascending'):'none'}">${x[1]}${SORT.key===x[0]?(SORT.dir<0?' ▾':' ▴'):''}</th>`).join('');$('tblMain').querySelector('thead').innerHTML='<tr>'+th+'</tr>';let rows=visibleTags().slice().sort((a,b)=>{if(a.spend>0!==b.spend>0)return a.spend>0?-1:1;let x=a[SORT.key],y=b[SORT.key];if(SORT.key==='tag')return SORT.dir*String(x).localeCompare(y);x=isFinite(x)?x:-1e15;y=isFinite(y)?y:-1e15;return SORT.dir*(x-y)});$('tblMain').querySelector('tbody').innerHTML=rows.map(t=>{
  // A verdict that flips when the lag setting moves is not safe to act on yet.
  const s=STAB&&STAB.tags.find(x=>x.tag===t.tag);
  const frail=s&&!s.stable?` <span class="pill" title="Vonis berubah bila lag digeser: ${s.byLag.map(b=>'lag '+b.lag+' → '+b.status).join(', ')}">rapuh</span>`:'';
  return `<tr class="dayrow" data-bd="${esc(t.tag)}" tabindex="0" role="button" aria-expanded="false"><td><div class="tagcell"><span class="nm">${esc(t.tag)} <span class="badge ${t.status}">${t.label}</span>${frail}</span><span class="rs">${esc(t.reason)}${t.bidHint?' · '+esc(t.bidHint):''}</span></div></td><td class="num">${rp(t.spend)}</td><td class="num">${rp(t.commEff)}</td><td class="num ${t.netEff>=0?'pos':'neg'}">${rp(t.netEff)}</td><td class="num">${rx(t.roasEff)}</td><td class="num">${t.spend?t.roi.toFixed(0)+'%':'—'}</td><td class="num">${rp(t.cpm)}</td><td class="num">${t.clicks?nf(t.clicks):'—'}</td><td class="num">${t.clicks?nf(t.cpc):'—'}</td><td class="num"${t.shopeeClicks?` title="Jendela laporan klik. Pada jendela yang sama Meta mencatat ${nf(t.winClicks)} klik."`:''}>${t.shopeeClicks?nf(t.shopeeClicks):'—'}</td><td class="num"${t.cpcShopee?` title="${full(t.winSpend)} biaya pada jendela klik ÷ ${nf(t.shopeeClicks)} klik masuk"`:''}>${t.cpcShopee?nf(t.cpcShopee):'—'}</td><td class="num col-ideal"><b>${t.clicks?nf(t.cpcIdeal):'—'}</b></td><td class="num">${nf(t.orders)}</td><td class="num">${t.clicks?t.convRate.toFixed(2)+'%':'—'}</td><td class="num">${t.orders?rp(t.costPerOrder):'—'}</td><td class="num">${t.daysProd||'—'}</td></tr>`;
}).join('');if(!rows.length)$('tblMain').querySelector('tbody').innerHTML=`<tr><td colspan="${MC.length}" class="tbl-empty">${FILTER?'Tidak ada tag berstatus '+FILTER+' pada periode ini.':'Tidak ada tag pada periode ini.'}</td></tr>`;
  $('tagSearchCount').textContent=rows.length+' dari '+RESULT.tags.length+' tag';
  $('filterNote').textContent=FILTER?'Disaring: '+FILTER+' · '+rows.length+' tag':'';
  const rg=RESULT.range;
  $('tagNote').textContent=(rg.clickStart?`Kolom Shopee dari laporan klik ${rg.clickStart} — ${rg.clickEnd} · `:'')
    +'klik judul kolom untuk mengurutkan';$('btnClearFilter').classList.toggle('hidden',!FILTER);$('btnClearFilter').onclick=()=>{FILTER=null;renderDecisions();renderMain()};bindBreakdown('tblMain',tag=>{const t=RESULT.tags.find(x=>x.tag===tag);return t?{byDate:t.byDate}:null},MC.length);
  $('tblMain').querySelectorAll('th[data-sort]').forEach(e=>e.onclick=()=>{SORT.key===e.dataset.sort?SORT.dir*=-1:(SORT.key=e.dataset.sort,SORT.dir=-1);renderMain()});$('tblMain').querySelectorAll('th[data-sort]').forEach(e=>e.onkeydown=event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();e.click()}})}
/* ── Part 2: ad units, leakage, daily, trend, details, matching, charts ── */
const UC=[['adName','Ad Unit',0],['delivery','Status',0],['spend','Spend+PPN',1],['cpm','CPM',1],['impr','Impresi',1],['clicks','Klik Meta',1],['cpc','CPC Meta',1],['shopeeClicks','Klik Shopee',1],['cpcShopee','CPC Shopee',1],['cpcIdeal','CPC Ideal',1],['ctr','CTR %',1],['orders','Order',1],['convRate','CR %',1],['commEff','Komisi',1],['netEff','Laba',1],['roi','ROI %',1],['costPerOrder','Biaya/Order',1]];
function renderUnit(){
  const u=RESULT.adUnits;
  const r=RESULT.range;
  $('adunitNote').textContent=u.length+' ad unit · '+r.start+' — '+r.end
    +(r.clickStart?` · kolom Shopee dari laporan klik ${r.clickStart} — ${r.clickEnd}`:'');
  $('tblUnit').querySelector('thead').innerHTML='<tr>'+UC.map(c=>`<th class="${c[2]?'num':''}${c[0]==='cpcIdeal'?' col-ideal':''}">${c[1]}</th>`).join('')+'</tr>';
  const emptyUnit=!DATA.ads.length
    ? 'Laporan Meta Ads belum dimuat — tabel ini butuh data iklan.'
    : 'Tidak ada iklan dengan biaya pada periode ini.';
  if(!u.length){
    $('tblUnit').querySelector('tbody').innerHTML=`<tr><td colspan="${UC.length}" class="tbl-empty">${emptyUnit}</td></tr>`;
    return;
  }
  $('tblUnit').querySelector('tbody').innerHTML=u.map(x=>`<tr class="dayrow" data-bd="${esc(x.adName)}" tabindex="0" role="button" aria-expanded="false">
    <td><div class="tagcell"><span class="nm">${esc(x.adName)} <span class="badge ${x.status}">${x.label}</span></span>
    <span class="rs">Tag: <span class="pill">${esc(x.tag)}</span>${x.estimated?' · komisi proporsional':''}</span></div></td>
    <td><span class="dot ${x.active?'on':'off'}"></span>${x.active?'Nyala':'Mati'}</td>
    <td class="num">${rp(x.spend)}</td><td class="num">${rp(x.cpm)}</td>
    <td class="num">${nf(x.impr)}</td><td class="num">${nf(x.clicks)}</td>
    <td class="num">${nf(x.cpc)}</td>
    <td class="num"${x.shopeeClicks?' title="Jendela laporan klik, dibagi proporsional dari tag induk"':''}>${x.shopeeClicks?nf(x.shopeeClicks):'—'}</td>
    <td class="num"${x.cpcShopee?' title="Biaya pada jendela klik ÷ klik masuk, di tingkat tag"':''}>${x.cpcShopee?nf(x.cpcShopee):'—'}</td>
    <td class="num col-ideal"><b>${nf(x.cpcIdeal)}</b></td>
    <td class="num">${x.ctr.toFixed(2)}</td><td class="num">${nf(x.orders)}</td>
    <td class="num">${x.convRate.toFixed(2)}</td><td class="num">${rp(x.commEff)}</td>
    <td class="num ${x.netEff>=0?'pos':'neg'}">${rp(x.netEff)}</td>
    <td class="num ${x.roi>=0?'pos':'neg'}">${x.spend?x.roi.toFixed(0)+'%':'—'}</td>
    <td class="num">${x.orders?rp(x.costPerOrder):'—'}</td></tr>`).join('');
  bindBreakdown('tblUnit',name=>{const a=RESULT.adUnits.find(x=>x.adName===name);
    return a?{byDate:a.byDate,note:a.estimated?'komisi & klik Shopee proporsional dari tag':''}:null},UC.length);
}
function renderLeak(){
  const r=RESULT.range;
  $('leakRange').textContent=r.clickStart?`Klik report ${r.clickStart} s/d ${r.clickEnd}`:'Click report belum dimuat';
  const rows=RESULT.tags.filter(t=>t.leak&&isFinite(t.leak.pct));
  $('tblLeak').querySelector('thead').innerHTML='<tr>'+['Tag','Klik Meta','Klik Shopee','± Share','% Masuk','Biaya Terbuang','Catatan'].map((h,i)=>`<th class="${i&&i<6?'num':''}">${h}</th>`).join('')+'</tr>';
  $('tblLeak').querySelector('tbody').innerHTML=rows.length?rows.sort((a,b)=>a.leak.pct-b.leak.pct).map(t=>{
    const L=t.leak;
    // Signed, because the two directions mean opposite things. Extra clicks are
    // people resharing the content; missing clicks are a broken link.
    const d=L.shopeeClicks-L.metaClicks;
    const note=d<0
      ? (L.severity==='bad'?'Sebagian besar klik tidak sampai — periksa link':'Ada klik yang tidak sampai, layak dicek')
      : d>0?'Dibagikan orang di luar iklan — sinyal konten bagus':'Pas dengan klik berbayar';
    return `<tr><td><b>${esc(t.tag)}</b></td><td class="num">${nf(L.metaClicks)}</td><td class="num">${nf(L.shopeeClicks)}</td>
      <td class="num ${d<0?'neg':d>0?'pos':''}">${d>0?'+':''}${nf(d)}</td>
      <td class="num leak-${L.severity}">${L.pct.toFixed(1)}%</td>
      <td class="num ${L.wasted>0?'neg':''}">${L.wasted>0?rp(L.wasted):'—'}</td>
      <td style="white-space:normal;font-size:11px;color:var(--text-dim)">${note}</td></tr>`;
  }).join(''):`<tr><td colspan="7" style="text-align:center;color:var(--text-mute);padding:24px">Muat Website Click Report untuk melihat perbandingan klik.</td></tr>`;
}
function renderDaily(){
  const d=RESULT.daily,k=RESULT.kpi;
  $('dailyStrip').innerHTML=[['Impresi',nf(k.impr)],['Reach',nf(k.reach)],['Klik',nf(k.clicks)],['CTR',k.ctr.toFixed(2)+'%'],['CPM',rp(k.cpm)],['CPC',rp(k.cpc)],['Landing View',nf(k.lpv)],['CR',k.convRate.toFixed(2)+'%'],['GMV',rp(k.gmv)],['Biaya/Order',rp(k.costPerOrder)]].map(x=>`<div class="s"><div class="l">${x[0]}</div><div class="v">${x[1]}</div></div>`).join('');
  $('tblDaily').querySelector('thead').innerHTML='<tr>'+DAYCOLS.map((h,i)=>`<th class="${i>1?'num':''}">${h}</th>`).join('')+'</tr>';
  $('tblDaily').querySelector('tbody').innerHTML=d.slice().reverse().map(x=>dayRow(x)).join('');
  $('tblDaily').querySelectorAll('[data-day]').forEach(tr=>{
    tr.onclick=()=>toggleDay(tr.dataset.day,tr);
    tr.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();toggleDay(tr.dataset.day,tr)}};
  });
}
const DAYCOLS=['','Tanggal','Biaya','Komisi','Laba','ROAS','Klik Meta','CPC Meta','Klik Shopee','CPC Shopee',
  'Order','Biaya/Order','Nilai/Order','Komisi/Order'];
// Averages per order sit next to the per-click costs. Cost per order says what
// a sale costs to buy; value and commission per order say what it is worth.
// A cost per click with no spend behind it is not zero, it is absent — organic
// tags print "—" rather than a Rp0 that reads like a bargain.
function orderCells(v,orders){
  return `<td class="num">${nf(v.clicks)}</td>
    <td class="num">${v.clicks&&v.spend?nf(v.spend/v.clicks):'—'}</td>
    <td class="num">${v.shopeeClicks?nf(v.shopeeClicks):'—'}</td>
    <td class="num">${v.shopeeClicks&&v.spend?nf(v.spend/v.shopeeClicks):'—'}</td>
    <td class="num">${nf(orders)}</td>
    <td class="num">${orders&&v.spend?rp(v.spend/orders):'—'}</td>
    <td class="num">${orders?rp(v.gmv/orders):'—'}</td>
    <td class="num">${orders?rp(v.comm/orders):'—'}</td>`;
}
function dayRow(x){
  return `<tr class="dayrow" data-day="${x.date}" tabindex="0" role="button" aria-expanded="false"${x.mature?'':' style="opacity:.6"'}>
    <td class="expcell"><span class="exp">▸</span></td>
    <td><b>${x.date}</b>${x.mature?'':' <span class="pill">belum matang</span>'}</td>
    <td class="num">${rp(x.spend)}</td><td class="num">${rp(x.comm)}</td>
    <td class="num ${x.net>=0?'pos':'neg'}">${rp(x.net)}</td>
    <td class="num">${x.spend?x.roas.toFixed(2):'—'}</td>
    ${orderCells(x,x.orders)}</tr>`;
}
function toggleDay(date,tr){
  if(tr.nextElementSibling&&tr.nextElementSibling.classList.contains('daydetail')){
    tr.nextElementSibling.remove();tr.classList.remove('open');tr.setAttribute('aria-expanded','false');return;
  }
  const rows=RESULT.tags.map(t=>({tag:t.tag,status:t.status,label:t.label,d:t.byDate&&t.byDate[date]}))
    .filter(x=>x.d).sort((a,b)=>b.d.spend-a.d.spend||b.d.comm-a.d.comm);
  const body=rows.length?rows.map(x=>{
    const v=x.d,net=v.comm-v.spend;
    return `<tr><td><b>${esc(x.tag)}</b> <span class="badge ${x.status}">${x.label}</span></td>
      <td class="num">${rp(v.spend)}</td><td class="num">${rp(v.comm)}</td>
      <td class="num ${net>=0?'pos':'neg'}">${rp(net)}</td>
      <td class="num">${v.spend?(v.comm/v.spend).toFixed(2):'—'}</td>
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
  const box=(k,label,n,comm,cls)=>`<div class="stat-cell ${cls}">
    <div class="sl">${label}</div><div class="sv">${nf(n)}</div>
    <div class="sc">${rp(comm)}</div></div>`;
  $('statSum').innerHTML=
    box('done','Selesai',T.done,C.done,'ok')+
    box('pending','Tertunda',T.pending,C.pending,'warn')+
    box('unpaid','Belum Dibayar',T.unpaid,C.unpaid,'warn')+
    box('cancelled','Dibatalkan',T.cancelled,C.cancelled,'bad')+
    `<div class="stat-cell total"><div class="sl">Komisi belum final</div>
      <div class="sv">${rp(C.pending+C.unpaid)}</div>
      <div class="sc">dari ${nf(T.pending+T.unpaid)} pesanan · ${T.orders?((T.pending+T.unpaid)/T.orders*100).toFixed(1):0}% dari semua</div></div>`;

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
  const pct=v=>n(v).toFixed(2);
  $('trendRange').textContent=tr.series.length+' snapshot · '+tr.series[0].period+' — '+last.period;
  $('trendBase').innerHTML=prev?`Perubahan dibanding periode <b>${esc(prev.period)}</b>.`:'';
  $('trendStrip').innerHTML=[
    ['Laba',rp(n(last.netEff))+dl(d.netEff,rp)],
    ['ROAS Berbayar',rx(n(last.paidRoas))+dl(d.paidRoas,pct)],
    ['ROAS Gabungan',rx(n(last.roasEff))+dl(d.roasEff,pct)],
    ['Biaya',rp(n(last.spend))+dl(d.spend,rp,1)],
    ['Order',nf(n(last.orders))+dl(d.orders,nf)],
    ['Terbuang',rp(n(last.wasted))+dl(d.wasted,rp,1)],
    ['Organik',n(last.organicShare).toFixed(0)+'%'],['Snapshot',tr.series.length],
  ].map(x=>`<div class="s"><div class="l">${x[0]}</div><div class="v">${x[1]}</div></div>`).join('');
  const mv=tr.movers.slice(0,12);
  $('tblMovers').querySelector('thead').innerHTML='<tr>'+['Tag','Dari','Ke','Perubahan','Status Awal','Status Kini'].map((h,i)=>`<th class="${i&&i<4?'num':''}">${h}</th>`).join('')+'</tr>';
  $('tblMovers').querySelector('tbody').innerHTML=mv.length?mv.map(m=>`<tr>
    <td><b>${esc(m.tag)}</b></td><td class="num">${rx(n(m.from))}</td><td class="num">${rx(n(m.to))}</td>
    <td class="num ${n(m.delta)>=0?'pos':'neg'}">${n(m.delta)>=0?'+':''}${n(m.delta).toFixed(2)}</td>
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
  net:{label:'Laba',val:d=>d.net,signed:true},
  roas:{label:'ROAS',val:d=>d.spend?d.roas-1:null,signed:true},
  comm:{label:'Komisi',val:d=>d.comm,signed:false},
  spend:{label:'Biaya',val:d=>d.spend,signed:false},
};
function renderCalendar(){
  const el=$('calendar'),days=RESULT.daily;
  if(!days.length){el.innerHTML='';$('calNote').textContent='';return}
  const C=CALDEF[CALVIEW],vals=days.map(C.val).filter(v=>v!=null&&isFinite(v));
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
      const v=C.val(d);
      let cls='zero',op=0;
      if(v!=null&&isFinite(v)){op=Math.min(Math.abs(v)/mag,1);cls=C.signed?(v>=0?'pos':'neg'):'pos'}
      // All four numbers live in the square. The switcher above now only picks
      // which one drives the colour and sits on the top line — nobody should
      // have to click through four views to read one day.
      const lines=[
        ['Laba',rp(d.net),d.net>=0?'up':'down'],
        ['Komisi',rp(d.comm),''],
        ['Biaya',rp(d.spend),''],
        ['ROAS',d.spend?d.roas.toFixed(2)+'x':'—',''],
      ];
      const lead=lines.splice({net:0,comm:1,spend:2,roas:3}[CALVIEW],1)[0];
      cells.push(`<span class="cday ${cls}${d.mature?'':' raw'}" style="--i:${op.toFixed(3)}"
        title="${key} · ${nf(d.orders)} order · ${nf(d.clicks)} klik Meta${d.shopeeClicks?' · '+nf(d.shopeeClicks)+' klik Shopee':''}${d.mature?'':' · data belum matang'}">
        <b>${i}</b><i class="${lead[2]}"><em>${lead[0]}</em>${lead[1]}</i>
        <u>${lines.map(l=>`<span><em>${l[0]}</em>${l[1]}</span>`).join('')}</u></span>`);
    }
    return `<div class="calmonth"><h4>${NM[m-1]} ${y}</h4>
      <div class="cgrid">${DOW.map(x=>`<span class="cdow">${x}</span>`).join('')}${cells.join('')}</div></div>`;
  }).join('');
  $('calNote').textContent=`${days.length} hari · warna mengikuti ${C.label} · kotak bergaris belum matang`;
}
document.querySelectorAll('[data-cal]').forEach(b=>b.onclick=()=>{
  CALVIEW=b.dataset.cal;
  document.querySelectorAll('[data-cal]').forEach(x=>x.classList.toggle('active',x===b));
  renderCalendar();
});
function renderMatch(){
  $('tblMatch').querySelector('thead').innerHTML='<tr>'+['Nama Iklan','Tag Hasil','Metode','Keyakinan','Biaya','Klik'].map((h,i)=>`<th class="${i>2?'num':''}">${h}</th>`).join('')+'</tr>';
  $('tblMatch').querySelector('tbody').innerHTML=RESULT.matchLog.slice().sort((a,b)=>a.confidence-b.confidence).map(m=>{
    const c=m.confidence>=.9?'leak-ok':m.confidence>=.5?'leak-warn':'leak-bad';
    return `<tr><td><b>${esc(m.adName)}</b></td><td><span class="pill">${esc(m.tag)}</span></td>
      <td>${esc(m.method)}${m.candidateTag?'<div class="hint">Saran: '+esc(m.candidateTag)+' · perlu mapping manual</div>':''}</td><td class="num ${c}">${(m.confidence*100).toFixed(0)}%</td>
      <td class="num">${rp(m.spend)}</td><td class="num">${nf(m.clicks)}</td></tr>`;
  }).join('');
  // The mapping table now lives behind one button, so that button has to say
  // when something inside needs looking at.
  const weak=RESULT.matchLog.filter(m=>m.confidence<.5).length;
  const dot=$('mapAlert');
  dot.textContent=weak||'';
  dot.title=weak?`${weak} pencocokan lemah perlu diperiksa`:'';
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
  const grid=cv('--border'),text=cv('--text-dim');
  cfg.options=Object.assign({responsive:true,maintainAspectRatio:false,
    // With only a handful of snapshots Chart.js stretches bars across the whole
    // plot area, which reads as blocks rather than a comparison.
    datasets:{bar:{maxBarThickness:54,categoryPercentage:.7,barPercentage:.85}},
    plugins:{legend:{labels:{color:text,font:{family:'Plus Jakarta Sans',size:11}}}},
    scales:cfg.type==='doughnut'?undefined:{x:{grid:{color:grid},ticks:{color:text,font:{size:10}}},
      y:{grid:{color:grid},ticks:{color:text,font:{size:10}}}}},cfg.options||{});
  CHARTS[id]=new Chart(el,cfg);
}
function renderCharts(){
  if(!RESULT)return;
  const R=RESULT,d=R.daily,lbl=d.map(x=>x.date.slice(5)),b=R.breakdown;
  const acc=cv('--accent'),ok=cv('--ok'),info=cv('--info'),warn=cv('--warn'),bad=cv('--bad'),org=cv('--organic');
  $('matureNote').textContent=R.range.matureUntil?'Titik pudar = data belum matang':'';

  mk('chDaily',{type:'line',data:{labels:lbl,datasets:[
    {label:'Komisi',data:d.map(x=>x.comm),borderColor:ok,backgroundColor:ok+'22',fill:true,tension:.3,pointRadius:2},
    {label:'Biaya Iklan',data:d.map(x=>x.spend),borderColor:acc,backgroundColor:acc+'18',fill:true,tension:.3,pointRadius:2}]}});
  mk('chRoas',{type:'bar',data:{labels:lbl,datasets:[{label:'ROAS',data:d.map(x=>x.roas),
    backgroundColor:d.map(x=>!x.mature?warn+'55':x.roas>=2?ok:x.roas>=1?warn:bad)}]}});
  mk('chClicks',{type:'line',data:{labels:lbl,datasets:[
    {label:'Klik Meta',data:d.map(x=>x.clicks),borderColor:info,tension:.3,pointRadius:2},
    {label:'Klik Shopee',data:d.map(x=>x.shopeeClicks),borderColor:warn,tension:.3,pointRadius:2},
    {label:'Order',data:d.map(x=>x.orders),borderColor:ok,tension:.3,pointRadius:2,yAxisID:'y1'}]},
    options:{scales:{y1:{position:'right',grid:{display:false},ticks:{color:cv('--text-dim'),font:{size:10}}}}}});

  const pf=b.platform.slice(0,6);
  mk('chPlat',{type:'doughnut',data:{labels:pf.map(x=>x.name),datasets:[{data:pf.map(x=>x.comm),
    backgroundColor:[acc,ok,info,warn,bad,org]}]}});
  const ct=b.category.slice(0,8);
  mk('chCat',{type:'bar',data:{labels:ct.map(x=>x.name.slice(0,22)),datasets:[{label:'Komisi',
    data:ct.map(x=>x.comm),backgroundColor:acc}]},options:{indexAxis:'y'}});
  mk('chHour',{type:'bar',data:{labels:b.hourly.map(h=>h.hour+':00'),datasets:[{label:'Komisi',
    data:b.hourly.map(h=>h.comm),backgroundColor:info}]}});
  const lp=R.lagProfile.slice(0,8);
  mk('chLag',{type:'bar',data:{labels:lp.map(x=>'H+'+x.day),datasets:[
    {label:'% pesanan',data:lp.map(x=>x.pct),backgroundColor:info},
    {label:'kumulatif %',data:lp.map(x=>x.cumulative),type:'line',borderColor:acc,tension:.3,pointRadius:2}]}});
  const st=R.settlement.filter(s=>s.age<=21);
  mk('chSettle',{type:'line',data:{labels:st.map(s=>'umur '+s.age),datasets:[{label:'% tertunda',
    data:st.map(s=>s.pendingPct),borderColor:warn,backgroundColor:warn+'22',fill:true,tension:.3,pointRadius:2}]}});
  const sc=b.clickSource.slice(0,6);
  mk('chSrc',{type:'doughnut',data:{labels:sc.map(x=>x.name),datasets:[{data:sc.map(x=>x.count),
    backgroundColor:[info,ok,acc,warn,bad,org]}]}});
  const rg=b.clickRegion.slice(0,6);
  mk('chRegion',{type:'bar',data:{labels:rg.map(x=>x.name.slice(0,18)),datasets:[{label:'Klik',
    data:rg.map(x=>x.count),backgroundColor:warn}]},options:{indexAxis:'y'}});

  const tr=E.buildTrend(snaps(),active());
  if(tr.series.length>=2){
    const tl=tr.series.map(s=>s.period);
    mk('chTrend',{type:'bar',data:{labels:tl,datasets:[
      {label:'Biaya',data:tr.series.map(s=>s.spend),backgroundColor:acc+'99'},
      {label:'Komisi Efektif',data:tr.series.map(s=>s.commEff),backgroundColor:ok+'99'},
      {label:'Laba',data:tr.series.map(s=>s.netEff),type:'line',borderColor:info,tension:.3,pointRadius:3}]}});
    mk('chTrendRoas',{type:'line',data:{labels:tl,datasets:[
      {label:'ROAS Berbayar',data:tr.series.map(s=>s.paidRoas),borderColor:acc,tension:.3,pointRadius:3},
      {label:'ROAS Gabungan',data:tr.series.map(s=>s.roasEff),borderColor:ok,tension:.3,pointRadius:3}]},
      // Start at zero: a truncated axis makes a small ROAS move look dramatic.
      options:{scales:{y:{beginAtZero:true}}}});
    mk('chTrendMix',{type:'bar',data:{labels:tl,datasets:[
      {label:'Scale',data:tr.series.map(s=>s.counts.scale||0),backgroundColor:ok,stack:'s'},
      {label:'Pantau',data:tr.series.map(s=>s.counts.pantau||0),backgroundColor:warn,stack:'s'},
      {label:'Stop',data:tr.series.map(s=>s.counts.stop||0),backgroundColor:bad,stack:'s'},
      {label:'Organik',data:tr.series.map(s=>s.counts.organik||0),backgroundColor:org,stack:'s'}]},
      options:{scales:{x:{stacked:true},y:{stacked:true,beginAtZero:true}}}});
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
  document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));
  document.querySelectorAll('.panel').forEach(x=>x.classList.remove('active'));
  t.classList.add('active');
  document.querySelector(`[data-panel="${t.dataset.tab}"]`).classList.add('active');
  requestAnimationFrame(()=>{if(RESULT)renderCharts()});
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
  $('phRange').textContent=`Periode ${r.start} — ${r.end}`;
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
function mapRow(k,v){return `<div class="maprow"><input placeholder="nama iklan" value="${esc(k)}" data-k>
  <span style="color:var(--text-mute)">→</span><input placeholder="tag affiliate" value="${esc(v)}" data-v>
  <button class="btn ghost" data-del>×</button></div>`}
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
  const k=E.normalize(r.querySelector('[data-k]').value),v=r.querySelector('[data-v]').value.trim();
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
function renderHistory(){
  const s=snaps();
  $('histAcct').textContent=active()+' · '+s.length+' snapshot';
  $('histRows').innerHTML=s.length?s.map(x=>`<div class="snaprow">
    <div class="meta"><div class="d">${esc(x.range.start)} — ${esc(x.range.end)}</div>
    <div class="t">disimpan ${esc(x.saved)} · ROAS berbayar ${rx(x.kpi.paidRoas)} · laba ${rp(x.kpi.netEff)}</div></div>
    <button class="btn sm" data-view="${esc(x.id)}">Lihat</button>
    <button class="btn sm danger" data-del="${esc(x.id)}">Hapus</button></div>`).join('')
    :'<p class="hint">Belum ada snapshot untuk akun ini.</p>';
  $('histRows').querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>{
    const x=snaps().find(y=>y.id===+b.dataset.view); if(!x)return;
    const lines=x.tags.filter(t=>t.spend>0).map(t=>`${t.tag} — ${t.label} · ROAS ${rx(t.roasEff)} · ${t.reason}`).join('\n');
    alert(`${esc(x.range.start)} — ${esc(x.range.end)}\nDisimpan ${x.saved}\n\nBiaya ${full(x.kpi.spend)}\nKomisi efektif ${full(x.kpi.commEff)}\nLaba ${full(x.kpi.netEff)}\nROAS berbayar ${rx(x.kpi.paidRoas)}\n\n${lines}`);
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
  if(!DATA.ads.length)notes.push('Laporan Meta Ads belum dimuat; evaluasi biaya dan ROAS iklan belum lengkap.');
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
  if(!PDF_LIBRARIES)PDF_LIBRARIES=(async()=>{for(const src of ['vendor/jspdf.umd.min.js','vendor/jspdf.plugin.autotable.min.js','vendor/pdf-font.js','pdf-export.js'])await new Promise((resolve,reject)=>{const script=document.createElement('script');script.src=src;script.onload=resolve;script.onerror=()=>{script.remove();reject(new Error('Pustaka PDF tidak dapat dimuat. Periksa kelengkapan folder aplikasi.'))};document.head.append(script)})})().catch(e=>{PDF_LIBRARIES=null;throw e});
  return PDF_LIBRARIES;
}
async function downloadPdf(mode){
  if(!RESULT||PDF_BUSY)return;
  const result=RESULT,account=active(),epoch=IMPORT_EPOCH,title=$('pdfTitle').value.trim()||'Laporan kinerja affiliate',quality=qualityNotes();
  PDF_BUSY=true;document.querySelectorAll('[data-pdf]').forEach(b=>b.disabled=true);$('pdfBusy').style.display='';$('pdfBusy').classList.remove('hidden');$('pdfError').classList.add('hidden');
  try{
    await loadPdfLibraries();await new Promise(resolve=>requestAnimationFrame(resolve));
    if(epoch!==IMPORT_EPOCH||account!==active()||RESULT!==result)throw new Error('Data atau akun berubah. Buka ulang ekspor untuk membuat laporan terbaru.');
    const doc=DashboardPDF.create(result,{account,mode,title,quality});
    downloadBlob(doc.output('blob'),`laporan-${DashboardExport.filenamePart(account)}-${result.range.start}_${result.range.end}-${mode}.pdf`);toast('PDF '+mode+' diunduh');
  }catch(e){$('pdfError').textContent=e.message;$('pdfError').classList.remove('hidden')}
  finally{PDF_BUSY=false;document.querySelectorAll('[data-pdf]').forEach(b=>b.disabled=false);$('pdfBusy').classList.add('hidden')}
}
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
