'use strict';
const E=window.Engine,$=id=>document.getElementById(id);
let DATA={affiliate:[],ads:[],clicks:[]},FILES=[],RESULT=null,CHARTS={},SORT={key:'spend',dir:-1},FILTER=null,STAB=null;
const LS={accounts:'adash_accounts_v3',active:'adash_active_v3',map:'adash_map_v3',snaps:'adash_snaps_v3',opts:'adash_opts_v3',theme:'adash_theme_v3'};
const DEFAULT_MAP={'telesinvideo2':'TelesinGripvideo2','telesinvideo1':'TelesinGripvideo2','telesinvideo3':'TelesinGripvideo3','telesingrip':'TelesinGripvideo2','lemariolymp':'OlymplastLemari','lemariolympic':'OlymplastLemari','minilayarportable':'minilayarportable','helmrsixsolid':'HelmRsixSolid','spinningreelokuma':'Spinningreelokuma','seeouokacamatapolarized':'seeouokacamatapolarized'};
const esc=E.escapeHtml;
function rp(n){if(n==null||!isFinite(n))return'Rp0';let a=Math.abs(n),s=n<0?'-':'';if(a>=1e9)return s+'Rp'+(a/1e9).toFixed(2)+' M';if(a>=1e6)return s+'Rp'+(a/1e6).toFixed(1)+' jt';if(a>=1e3)return s+'Rp'+Math.round(a/1e3)+'rb';return s+'Rp'+Math.round(a)}
function full(n){return'Rp'+Math.round(n||0).toLocaleString('id-ID')} function nf(n){return Math.round(n||0).toLocaleString('id-ID')}
function rx(n){return n===Infinity?'∞':isFinite(n)?n.toFixed(2)+'x':'—'} function toast(s){let e=$('toast');e.textContent=s;e.classList.add('show');setTimeout(()=>e.classList.remove('show'),2400)}
function accounts(){try{return JSON.parse(localStorage.getItem(LS.accounts))||['default']}catch(e){return['default']}}
function active(){return localStorage.getItem(LS.active)||accounts()[0]||'default'}
function setActive(a){localStorage.setItem(LS.active,a)}
function map(){try{return JSON.parse(localStorage.getItem(LS.map+'_'+active()))||DEFAULT_MAP}catch(e){return DEFAULT_MAP}}
function saveMap(m){localStorage.setItem(LS.map+'_'+active(),JSON.stringify(m))}
function snaps(){try{return JSON.parse(localStorage.getItem(LS.snaps+'_'+active()))||[]}catch(e){return[]}}
function saveSnaps(a){localStorage.setItem(LS.snaps+'_'+active(),JSON.stringify(a.slice(0,120)))}
function renderAccounts(){let a=accounts(),s=$('account');s.innerHTML=a.map(x=>`<option value="${esc(x)}">${esc(x)}</option>`).join('');s.value=active()}
function applyTheme(t){document.documentElement.setAttribute('data-theme',t);$('btnTheme').textContent=t==='dark'?'Mode Terang':'Mode Gelap';localStorage.setItem(LS.theme,t);if(RESULT)render()}
applyTheme(localStorage.getItem(LS.theme)||'light');renderAccounts();
$('btnTheme').onclick=()=>applyTheme(document.documentElement.getAttribute('data-theme')==='dark'?'light':'dark');
$('account').onchange=()=>{setActive($('account').value);reset();renderAccounts();loadOpts();renderHistory()};
$('btnNewAcct').onclick=()=>{let n=prompt('Nama akun baru');if(!n)return;n=n.trim();if(!n)return;let a=accounts();if(!a.includes(n))a.push(n);localStorage.setItem(LS.accounts,JSON.stringify(a));setActive(n);reset();renderAccounts();toast('Akun dibuat: '+n)};
const drop=$('drop');drop.onclick=()=>$('files').click();['dragenter','dragover'].forEach(x=>drop.addEventListener(x,e=>{e.preventDefault();drop.classList.add('over')}));['dragleave','drop'].forEach(x=>drop.addEventListener(x,e=>{e.preventDefault();drop.classList.remove('over')}));drop.addEventListener('drop',e=>files(e.dataTransfer.files));$('files').onchange=e=>files(e.target.files);
function files(list){let ar=[...list||[]],pending=ar.length;if(!pending)return;ar.forEach(file=>{if(FILES.some(x=>x.name===file.name&&x.size===file.size)){toast('File sudah dimuat, dilewati');if(!--pending)finish();return}Papa.parse(file,{header:true,skipEmptyLines:true,complete:r=>{let rows=r.data||[],type=rows.length?E.detectFileType(Object.keys(rows[0])):'unknown';
  // Keep the parsed rows on the entry so removing one file can rebuild the
  // dataset from the survivors instead of forcing a full re-upload.
  FILES.push({name:file.name,size:file.size,type,rows:rows.length,rowsData:rows});
  if(type==='affiliate')DATA.affiliate=DATA.affiliate.concat(rows);else if(type==='ads')DATA.ads=DATA.ads.concat(rows);else if(type==='clicks')DATA.clicks=DATA.clicks.concat(rows);else toast('Format tidak dikenali: '+file.name);if(!--pending)finish()},error:()=>{toast('Gagal membaca '+file.name);if(!--pending)finish()}})})}
function finish(){renderChips();if(!DATA.affiliate.length)return toast('Laporan affiliate belum dimuat');let ds=[];DATA.affiliate.forEach(r=>{let d=E.dayOnly(r['Waktu Pemesanan']);if(E.isDate(d))ds.push(d)});DATA.ads.forEach(r=>{let d=E.dayOnly(r['Reporting starts']);if(E.isDate(d))ds.push(d)});ds.sort();if(ds.length){$('dateStart').value=ds[0];$('dateEnd').value=ds[ds.length-1]}$('emptyState').classList.add('hidden');$('main').classList.remove('hidden');recalc();toast('Data dimuat untuk '+active());
  // Optional add-on layers (e.g. the daily edition) subscribe here. FILES and
  // RESULT are `let`-scoped and not reachable from another script, so hand
  // them over explicitly rather than leaking more globals.
  if(typeof window.onDashboardData==='function')window.onDashboardData({files:FILES,result:RESULT,data:DATA});}
function renderChips(){$('chips').innerHTML=FILES.map((f,i)=>`<span class="chip ${f.type}"><span class="file-row"><span class="fname" title="${esc(f.name)}">${esc(f.name)}</span><span>· ${nf(f.rows)} baris</span><button class="rmfile" data-rm="${i}" title="Hapus file ini" aria-label="Hapus ${esc(f.name)}">×</button></span></span>`).join('');let p=[];if(DATA.affiliate.length)p.push('Affiliate '+nf(DATA.affiliate.length));if(DATA.ads.length)p.push('Ads '+nf(DATA.ads.length));if(DATA.clicks.length)p.push('Klik '+nf(DATA.clicks.length));$('uploadStatus').textContent=p.join(' · ');
  // Removing one file rebuilds from the survivors, so a mis-drop no longer
  // forces clearing everything and re-uploading all three reports.
  $('chips').querySelectorAll('[data-rm]').forEach(b=>b.onclick=e=>{e.stopPropagation();rmFile(+b.dataset.rm)});
  // Once the reports are in, the upload box has done its job. Shrinking it
  // gives the top of the screen back to the numbers.
  const loaded=FILES.length>0;
  $('uploadCard').classList.toggle('compact',loaded);
  $('btnMore').classList.toggle('hidden',!loaded);}
function rmFile(i){
  const f=FILES[i]; if(!f)return;
  FILES.splice(i,1);
  const keep=FILES.slice();
  DATA={affiliate:[],ads:[],clicks:[]};FILES=[];
  keep.forEach(k=>{FILES.push(k);if(k.rowsData){if(k.type==='affiliate')DATA.affiliate=DATA.affiliate.concat(k.rowsData);else if(k.type==='ads')DATA.ads=DATA.ads.concat(k.rowsData);else if(k.type==='clicks')DATA.clicks=DATA.clicks.concat(k.rowsData)}});
  renderChips();
  if(DATA.affiliate.length){recalc();toast('File dihapus: '+f.name)}
  else{$('main').classList.add('hidden');$('emptyState').classList.remove('hidden');toast('File dihapus')}
}
function reset(){DATA={affiliate:[],ads:[],clicks:[]};FILES=[];RESULT=null;FILTER=null;STAB=null;$('files').value='';$('chips').innerHTML='';$('uploadStatus').textContent='';$('main').classList.add('hidden');$('emptyState').classList.remove('hidden');Object.values(CHARTS).forEach(c=>{try{c.destroy()}catch(e){}});CHARTS={}}
// Clearing is destructive and used to fire on a single click.
$('btnReset').onclick=()=>{if(!FILES.length)return reset();if(confirm(`Kosongkan ${FILES.length} file yang dimuat? Snapshot tersimpan tidak terhapus.`)){reset();toast('Data dikosongkan')}};
$('btnPick').onclick=e=>{e.stopPropagation();$('files').click()};
$('btnMore').onclick=()=>$('files').click();
const O=['ppn','targetROI','thScale','thPantau','minSpend','minDays','lagDays','streakDays','pendingFactor'];O.concat(['dateStart','dateEnd']).forEach(id=>$(id).addEventListener('change',recalc));
function opts(){let o={dateStart:$('dateStart').value,dateEnd:$('dateEnd').value};O.forEach(k=>o[k]=parseFloat($(k).value)||0);return o}
function recalc(){if(!DATA.affiliate.length)return;RESULT=E.analyze({...DATA,tagMap:map()},opts());render()}
function render(){if(!RESULT)return;let r=RESULT,k=r.kpi; if($('settingsPeek'))$('settingsPeek').textContent=`${r.range.start} — ${r.range.end} · PPN ${r.options.ppn}% · target ROI ${r.options.targetROI}%`;renderBanner();renderKpi();renderClickKpi();renderActions();renderCalibration();renderSynth();renderDecisions();renderMain();renderUnit();renderLeak();renderDaily();renderTrend();renderOpportunity();renderDetails();renderMatch();renderCharts()}
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
  try{const S=E.stability({...DATA,tagMap:map()},RESULT.options,[0,3,5,7]);unstable=S.unstable;STAB=S}catch(e){STAB=null}
  const warn=!L.matches||unstable>0;
  el.className='calibration'+(warn?' warn':'');
  const parts=[];
  parts.push(L.matches
    ? `Lag atribusi <b>${L.current} hari</b> sudah sesuai data: ${L.coverage}% pesanan masuk dalam H+${L.suggested}.`
    : `Lag atribusi disetel <b>${L.current} hari</b>, tapi data menunjukkan <b>${L.suggested} hari</b> (${L.coverage}% pesanan masuk dalam H+${L.suggested}). <button class="btn sm" id="btnApplyLag">Pakai ${L.suggested} hari</button>`);
  if(unstable>0)parts.push(`<b>${unstable} vonis berubah</b> bila lag digeser — ditandai di kolom Tag.`);
  el.innerHTML=parts.join(' ');
  const b=$('btnApplyLag');
  if(b)b.onclick=()=>{$('lagDays').value=L.suggested;recalc();toast('Lag disetel ke '+L.suggested+' hari')};
}
function renderOpportunity(){
  const A=RESULT.actions,C=A.concentration;
  $('tblOrganic').querySelector('thead').innerHTML='<tr>'+['Tag','Komisi','Order','Komisi/Order','Maks CPC','Kanal Utama'].map((h,i)=>`<th class="${i&&i<5?'num':''}">${h}</th>`).join('')+'</tr>';
  $('tblOrganic').querySelector('tbody').innerHTML=A.organicCandidates.length
    ? A.organicCandidates.map(c=>`<tr><td><b>${esc(c.tag)}</b></td>
      <td class="num">${rp(c.comm)}</td><td class="num">${nf(c.orders)}</td>
      <td class="num">${rp(c.avgComm)}</td><td class="num col-ideal"><b>${rp(c.maxCpc)}</b></td>
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
    <div class="lbl">${label}${body?'<span class="chev">▾</span>':''}</div>
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
    kpiCard(share>=50?'bad':'','Kontribusi Organik',share.toFixed(1)+'%','porsi komisi tanpa biaya iklan',[
      ['ROAS Iklan',rx(k.paidRoas)],
      ['ROAS Gabungan',rx(k.roasEff)]])
  ].join('');
  bindDrill('kpis');
}
function bindDrill(id){
  $(id).querySelectorAll('.kpi.expandable').forEach(el=>{
    const flip=()=>{const o=el.classList.toggle('open');el.setAttribute('aria-expanded',o?'true':'false')};
    el.onclick=flip;
    el.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();flip()}};
  });
}
// Meta reports clicks per platform; Shopee reports them per Perujuk. Keeping
// both on the main screen is the point — where the two disagree is where the
// money goes missing.
function metaBySource(){
  const r=RESULT.range,out={};
  DATA.ads.forEach(a=>{
    const d=E.dayOnly(a['Reporting starts']); if(!E.isDate(d)||d<r.start||d>r.end)return;
    const p=(a.Platform||'').trim()||'Lainnya';
    out[p]=(out[p]||0)+(parseInt(a['Link clicks']||0,10)||0);
  });
  return Object.entries(out).filter(x=>x[1]>0).sort((a,b)=>b[1]-a[1]);
}
// The click report covers its own span, usually shorter than the analysis
// range. Dividing full-range spend by window-only clicks overstates the cost
// per click — here it read Rp247 against a true Rp105.
function spendInClickWindow(){
  const r=RESULT.range; if(!r.clickStart)return null;
  let s=0;
  DATA.ads.forEach(a=>{
    const d=E.dayOnly(a['Reporting starts']);
    if(!E.isDate(d)||d<r.clickStart||d>r.clickEnd)return;
    s+=parseFloat(a['Amount spent (IDR)']||a['Amount spent']||0)||0;
  });
  return s*(1+(RESULT.options.ppn||0)/100);
}
function renderClickKpi(){
  const k=RESULT.kpi,r=RESULT.range,el=$('clickKpis');
  const leaks=RESULT.tags.filter(t=>t.leak&&isFinite(t.leak.pct));
  if(!leaks.length&&!DATA.clicks.length){el.innerHTML='';return}
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
  const winSpend=spendInClickWindow();

  el.innerHTML=[
    kpiCard('','Klik Meta',nf(k.clicks),`${r.start} s/d ${r.end}`,[
      ['CPM',rp(k.cpm)],['CPC',full(k.cpc)],
      ['CTR',(k.ctr||0).toFixed(2)+'%'],['Impresi',nf(k.impr)],
      ...ms.slice(0,4).map(([p,v])=>[p,`${nf(v)} · ${msTot?(v/msTot*100).toFixed(0):0}%`])]),
    kpiCard('','Klik Shopee',nf(k.shopeeClicks),win,[
      ['Biaya per klik masuk',adShopee&&winSpend!=null?full(winSpend/adShopee):'—'],
      ['Biaya per pesanan',k.orders?full(k.costPerOrder):'—'],
      ...ss.slice(0,4).map(s=>[s.name||'(tanpa sumber)',`${nf(s.count)} · ${ssTot?(s.count/ssTot*100).toFixed(0):0}%`])]),
    kpiCard(lost>0?'bad':'','Klik Hilang',nf(lost),
      lost>0?`dari ${lostTags.length} tag · ${rp(k.wasted)} terbuang`:'tidak ada klik yang hilang',
      lost>0?[...lostTags.slice(0,4).map(t=>[t.tag,`−${nf(t.leak.metaClicks-t.leak.shopeeClicks)}`]),
              ['Klik ekstra dari share',`+${nf(gained)}`,1]]
            :[['Klik ekstra dari share',`+${nf(gained)}`,1]]),
    kpiCard(pctIn<100?'bad':'','% Klik Masuk Shopee',pctIn.toFixed(1)+'%',
      pctIn>100?'di atas 100% karena dibagikan orang':'sebagian klik tidak sampai',[
      [`${gainTags.length} tag dibagikan`,`+${nf(gained)} klik`],
      [`${lostTags.length} tag bocor`,`−${nf(lost)} klik`],
      ['Selisih bersih',`${adShopee-adMeta>=0?'+':''}${nf(adShopee-adMeta)} klik`]])
  ].join('');
  bindDrill('clickKpis');
}
function renderSynth(){let k=RESULT.kpi,g=RESULT.tags.filter(t=>t.spend>0),s=g.reduce((a,t)=>a+t.spend,0),c=g.reduce((a,t)=>a+t.commEff,0),ro=s?c/s:0,st=RESULT.kpi.counts.stop||0;$('synth').innerHTML=s?`Laba ${rp(k.netEff)} ditopang komisi organik <b>${rp(k.organicComm)}</b>. Iklan berbayar sendiri hanya ROAS <b>${rx(ro)}</b> — ${st?'ada '+st+' tag yang sebaiknya dihentikan.':'belum ada yang perlu dihentikan.'}`:''}
function renderDecisions(){let g={scale:[],pantau:[],stop:[],organik:[]};RESULT.tags.forEach(t=>{if(g[t.status])g[t.status].push(t)});g.stop.sort((a,b)=>a.roasEff-b.roasEff);g.pantau.sort((a,b)=>a.roasEff-b.roasEff);g.organik.sort((a,b)=>b.comm-a.comm);let box=(key,title,unit,fn,empty)=>{let a=g[key],it=a.length?a.slice(0,5).map(t=>`<div class="ditem"><span class="n">${esc(t.tag)}</span><span class="v">${fn(t)}</span></div>`).join('')+(a.length>5?`<div class="ditem"><span class="n">+${a.length-5} lainnya</span></div>`:''):`<div class="empty">${empty}</div>`;return`<div class="dcard ${key}${FILTER&&FILTER!==key?' dim':''}" data-filter="${key}"><h4>${title} (${a.length}) <span class="unit">${unit}</span></h4>${it}</div>`};$('dgrid').innerHTML=box('scale','Scale','roas',t=>rx(t.roasEff),`Belum ada tag mencapai ${RESULT.options.thScale}x`)+box('pantau','Pantau','roas',t=>rx(t.roasEff),'Tidak ada')+box('stop','Stop','roas',t=>rx(t.roasEff),'Tidak ada')+box('organik','Organik','komisi',t=>rp(t.comm),'Tidak ada');$('dgrid').querySelectorAll('[data-filter]').forEach(e=>e.onclick=()=>{FILTER=FILTER===e.dataset.filter?null:e.dataset.filter;renderDecisions();renderMain()})}
const MC=[['tag','Tag / Keputusan',0],['spend','Biaya',1],['commEff','Komisi Efektif',1],['netEff','Laba',1],['roasEff','ROAS',1],['roi','ROI %',1],['cpm','CPM',1],['cpc','CPC',1],['cpcIdeal','CPC Ideal',1],['orders','Order',1],['convRate','CR %',1],['costPerOrder','Biaya/Order',1],['daysProd','Hari',1]];
function renderMain(){let th=MC.map(x=>`<th class="${x[2]?'num':''}${x[0]==='cpcIdeal'?' col-ideal':''}" data-sort="${x[0]}">${x[1]}${SORT.key===x[0]?(SORT.dir<0?' ▾':' ▴'):''}</th>`).join('');$('tblMain').querySelector('thead').innerHTML='<tr>'+th+'</tr>';let rows=RESULT.tags.filter(t=>!FILTER||t.status===FILTER).slice().sort((a,b)=>{if(a.spend>0!==b.spend>0)return a.spend>0?-1:1;let x=a[SORT.key],y=b[SORT.key];if(SORT.key==='tag')return SORT.dir*String(x).localeCompare(y);x=isFinite(x)?x:-1e15;y=isFinite(y)?y:-1e15;return SORT.dir*(y-x)});$('tblMain').querySelector('tbody').innerHTML=rows.map(t=>{
  // A verdict that flips when the lag setting moves is not safe to act on yet.
  const s=STAB&&STAB.tags.find(x=>x.tag===t.tag);
  const frail=s&&!s.stable?` <span class="pill" title="Vonis berubah bila lag digeser: ${s.byLag.map(b=>'lag '+b.lag+' → '+b.status).join(', ')}">rapuh</span>`:'';
  return `<tr><td><div class="tagcell"><span class="nm">${esc(t.tag)} <span class="badge ${t.status}">${t.label}</span>${frail}</span><span class="rs">${esc(t.reason)}${t.bidHint?' · '+esc(t.bidHint):''}</span></div></td><td class="num">${rp(t.spend)}</td><td class="num">${rp(t.commEff)}</td><td class="num ${t.netEff>=0?'pos':'neg'}">${rp(t.netEff)}</td><td class="num">${rx(t.roasEff)}</td><td class="num">${t.spend?t.roi.toFixed(0)+'%':'—'}</td><td class="num">${rp(t.cpm)}</td><td class="num">${t.clicks?nf(t.cpc):'—'}</td><td class="num col-ideal"><b>${t.clicks?nf(t.cpcIdeal):'—'}</b></td><td class="num">${nf(t.orders)}</td><td class="num">${t.clicks?t.convRate.toFixed(2)+'%':'—'}</td><td class="num">${t.orders?rp(t.costPerOrder):'—'}</td><td class="num">${t.daysProd||'—'}</td></tr>`;
}).join('');$('filterNote').textContent=FILTER?'Disaring: '+FILTER+' · '+rows.length+' tag':'';$('btnClearFilter').classList.toggle('hidden',!FILTER);$('btnClearFilter').onclick=()=>{FILTER=null;renderDecisions();renderMain()};$('tblMain').querySelectorAll('th[data-sort]').forEach(e=>e.onclick=()=>{SORT.key===e.dataset.sort?SORT.dir*=-1:(SORT.key=e.dataset.sort,SORT.dir=-1);renderMain()})}
/* ── Part 2: ad units, leakage, daily, trend, details, matching, charts ── */
const UC=[['adName','Ad Unit',0],['delivery','Status',0],['spend','Spend+PPN',1],['cpm','CPM',1],['impr','Impresi',1],['clicks','Klik',1],['cpc','CPC',1],['cpcIdeal','CPC Ideal',1],['ctr','CTR %',1],['orders','Order',1],['convRate','CR %',1],['commEff','Komisi',1],['netEff','Laba',1],['roi','ROI %',1],['costPerOrder','Biaya/Order',1]];
function renderUnit(){
  const u=RESULT.adUnits;
  $('adunitNote').textContent=u.length+' ad unit · '+RESULT.range.start+' — '+RESULT.range.end;
  $('tblUnit').querySelector('thead').innerHTML='<tr>'+UC.map(c=>`<th class="${c[2]?'num':''}${c[0]==='cpcIdeal'?' col-ideal':''}">${c[1]}</th>`).join('')+'</tr>';
  $('tblUnit').querySelector('tbody').innerHTML=u.map(x=>`<tr>
    <td><div class="tagcell"><span class="nm">${esc(x.adName)} <span class="badge ${x.status}">${x.label}</span></span>
    <span class="rs">Tag: <span class="pill">${esc(x.tag)}</span>${x.estimated?' · komisi proporsional':''}</span></div></td>
    <td><span class="dot ${x.active?'on':'off'}"></span>${x.active?'Nyala':'Mati'}</td>
    <td class="num">${rp(x.spend)}</td><td class="num">${rp(x.cpm)}</td>
    <td class="num">${nf(x.impr)}</td><td class="num">${nf(x.clicks)}</td>
    <td class="num">${nf(x.cpc)}</td><td class="num col-ideal"><b>${nf(x.cpcIdeal)}</b></td>
    <td class="num">${x.ctr.toFixed(2)}</td><td class="num">${nf(x.orders)}</td>
    <td class="num">${x.convRate.toFixed(2)}</td><td class="num">${rp(x.commEff)}</td>
    <td class="num ${x.netEff>=0?'pos':'neg'}">${rp(x.netEff)}</td>
    <td class="num ${x.roi>=0?'pos':'neg'}">${x.spend?x.roi.toFixed(0)+'%':'—'}</td>
    <td class="num">${x.orders?rp(x.costPerOrder):'—'}</td></tr>`).join('');
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
  $('tblDaily').querySelector('thead').innerHTML='<tr>'+['Tanggal','Biaya','Komisi','Laba','ROAS','Klik Meta','Klik Shopee','Order','CR %','CPC'].map((h,i)=>`<th class="${i?'num':''}">${h}</th>`).join('')+'</tr>';
  $('tblDaily').querySelector('tbody').innerHTML=d.slice().reverse().map(x=>`<tr${x.mature?'':' style="opacity:.6"'}>
    <td><b>${x.date}</b>${x.mature?'':' <span class="pill">belum matang</span>'}</td>
    <td class="num">${rp(x.spend)}</td><td class="num">${rp(x.comm)}</td>
    <td class="num ${x.net>=0?'pos':'neg'}">${rp(x.net)}</td>
    <td class="num">${x.spend?x.roas.toFixed(2):'—'}</td><td class="num">${nf(x.clicks)}</td>
    <td class="num">${x.shopeeClicks?nf(x.shopeeClicks):'—'}</td><td class="num">${nf(x.orders)}</td>
    <td class="num">${x.clicks?x.convRate.toFixed(2):'—'}</td><td class="num">${x.clicks?nf(x.cpc):'—'}</td></tr>`).join('');
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
  $('trendBase').innerHTML=prev?`Perubahan dibanding periode <b>${prev.period}</b>.`:'';
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
    <td><span class="badge ${m.fromStatus||'evaluasi'}">${esc(m.fromStatus||'—')}</span></td>
    <td><span class="badge ${m.toStatus||'evaluasi'}">${esc(m.toStatus||'—')}</span>${m.changed?' <span class="pill">berubah</span>':''}</td></tr>`).join('')
    :`<tr><td colspan="6" style="text-align:center;color:var(--text-mute);padding:20px">Belum ada tag yang muncul di dua snapshot.</td></tr>`;
}
function renderDetails(){
  const b=RESULT.breakdown;
  $('tblProd').querySelector('thead').innerHTML='<tr>'+['Produk','Komisi','GMV','Qty'].map((h,i)=>`<th class="${i?'num':''}">${h}</th>`).join('')+'</tr>';
  $('tblProd').querySelector('tbody').innerHTML=b.productByComm.slice(0,12).map(p=>`<tr>
    <td style="white-space:normal;max-width:320px">${esc(p.name)}</td>
    <td class="num">${rp(p.comm)}</td><td class="num">${rp(p.gmv)}</td><td class="num">${nf(p.qty)}</td></tr>`).join('');
  $('tblShop').querySelector('thead').innerHTML='<tr><th>Toko</th><th class="num">Komisi</th></tr>';
  $('tblShop').querySelector('tbody').innerHTML=b.shop.slice(0,12).map(s=>`<tr>
    <td style="white-space:normal;max-width:280px">${esc(s.name)}</td><td class="num">${rp(s.comm)}</td></tr>`).join('');
}
function renderMatch(){
  $('tblMatch').querySelector('thead').innerHTML='<tr>'+['Nama Iklan','Tag Hasil','Metode','Keyakinan','Biaya','Klik'].map((h,i)=>`<th class="${i>2?'num':''}">${h}</th>`).join('')+'</tr>';
  $('tblMatch').querySelector('tbody').innerHTML=RESULT.matchLog.slice().sort((a,b)=>a.confidence-b.confidence).map(m=>{
    const c=m.confidence>=.9?'leak-ok':m.confidence>=.5?'leak-warn':'leak-bad';
    return `<tr><td><b>${esc(m.adName)}</b></td><td><span class="pill">${esc(m.tag)}</span></td>
      <td>${esc(m.method)}</td><td class="num ${c}">${(m.confidence*100).toFixed(0)}%</td>
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
  const el=$(id); if(!el) return;
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
  if(sc.length)mk('chSrc',{type:'doughnut',data:{labels:sc.map(x=>x.name),datasets:[{data:sc.map(x=>x.count),
    backgroundColor:[info,ok,acc,warn,bad,org]}]}});
  const rg=b.clickRegion.slice(0,6);
  if(rg.length)mk('chRegion',{type:'bar',data:{labels:rg.map(x=>x.name.slice(0,18)),datasets:[{label:'Klik',
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
document.querySelectorAll('.tab').forEach(t=>t.onclick=()=>{
  document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));
  document.querySelectorAll('.panel').forEach(x=>x.classList.remove('active'));
  t.classList.add('active');
  document.querySelector(`[data-panel="${t.dataset.tab}"]`).classList.add('active');
  requestAnimationFrame(()=>{if(RESULT)renderCharts()});
});
/* Tag map modal */
function mapRow(k,v){return `<div class="maprow"><input placeholder="nama iklan" value="${esc(k)}" data-k>
  <span style="color:var(--text-mute)">→</span><input placeholder="tag affiliate" value="${esc(v)}" data-v>
  <button class="btn ghost" data-del>×</button></div>`}
function bindDel(){$('mapRows').querySelectorAll('[data-del]').forEach(b=>b.onclick=()=>b.closest('.maprow').remove())}
function openMap(){const m=map();$('mapRows').innerHTML=Object.keys(m).map(k=>mapRow(k,m[k])).join('')||mapRow('','');$('mapModal').classList.add('show');bindDel()}
$('btnMap').onclick=openMap;
$('btnSet').onclick=()=>$('setModal').classList.add('show');
// Presets exist so the eleven fields below stay optional. Order matches
// [targetROI, thScale, thPantau, minSpend, minDays, lagDays, streakDays].
const PRESETS={konservatif:[100,2.5,1.2,100000,5,5,2],seimbang:[80,2,1,50000,3,3,3],agresif:[50,1.5,.8,25000,2,2,4]};
document.querySelectorAll('[data-preset]').forEach(b=>b.onclick=()=>{
  const p=PRESETS[b.dataset.preset]; if(!p)return;
  ['targetROI','thScale','thPantau','minSpend','minDays','lagDays','streakDays'].forEach((id,i)=>$(id).value=p[i]);
  recalc(); toast('Preset '+b.dataset.preset+' dipakai');
});
$('btnAddMap').onclick=()=>{$('mapRows').insertAdjacentHTML('beforeend',mapRow('',''));bindDel()};
$('btnSaveMap').onclick=()=>{const m={};$('mapRows').querySelectorAll('.maprow').forEach(r=>{
  const k=E.normalize(r.querySelector('[data-k]').value),v=r.querySelector('[data-v]').value.trim();
  if(k&&v)m[k]=v});saveMap(m);$('mapModal').classList.remove('show');toast('Mapping disimpan');recalc()};
document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>b.closest('.modal').classList.remove('show'));
document.querySelectorAll('.modal').forEach(m=>m.onclick=e=>{if(e.target===m)m.classList.remove('show')});
/* Snapshots — per account */
$('btnSave').onclick=()=>{
  if(!RESULT)return toast('Belum ada hasil analisis');
  const all=snaps();
  all.unshift(E.toSnapshot(RESULT,{account:active()}));
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
    <div class="meta"><div class="d">${x.range.start} — ${x.range.end}</div>
    <div class="t">disimpan ${x.saved} · ROAS berbayar ${rx(x.kpi.paidRoas)} · laba ${rp(x.kpi.netEff)}</div></div>
    <button class="btn sm" data-view="${x.id}">Lihat</button>
    <button class="btn sm danger" data-del="${x.id}">Hapus</button></div>`).join('')
    :'<p class="hint">Belum ada snapshot untuk akun ini.</p>';
  $('histRows').querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>{
    const x=snaps().find(y=>y.id===+b.dataset.view); if(!x)return;
    const lines=x.tags.filter(t=>t.spend>0).map(t=>`${t.tag} — ${t.label} · ROAS ${rx(t.roasEff)} · ${t.reason}`).join('\n');
    alert(`${x.range.start} — ${x.range.end}\nDisimpan ${x.saved}\n\nBiaya ${full(x.kpi.spend)}\nKomisi efektif ${full(x.kpi.commEff)}\nLaba ${full(x.kpi.netEff)}\nROAS berbayar ${rx(x.kpi.paidRoas)}\n\n${lines}`);
  });
  $('histRows').querySelectorAll('[data-del]').forEach(b=>b.onclick=()=>{
    saveSnaps(snaps().filter(y=>y.id!==+b.dataset.del));renderHistory();renderTrend();toast('Snapshot dihapus')});
}
$('btnHist').onclick=()=>{renderHistory();$('histModal').classList.add('show')};
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
  const f=e.target.files&&e.target.files[0]; if(!f)return;
  const rd=new FileReader();
  rd.onload=()=>{
    try{
      const d=JSON.parse(rd.result);
      const incoming=Array.isArray(d)?d:(d.snapshots||[]);
      if(!incoming.length)return toast('File tidak berisi snapshot');
      const cur=snaps(),ids=new Set(cur.map(x=>x.id));
      // Re-stamp to the active account so importing into a different account
      // does not silently mix two accounts' histories.
      const add=incoming.filter(x=>!ids.has(x.id)).map(x=>({...x,account:active()}));
      saveSnaps(cur.concat(add).sort((a,b)=>String(b.saved).localeCompare(String(a.saved))));
      renderHistory();renderTrend();requestAnimationFrame(()=>renderCharts());
      toast(add.length+' snapshot diimpor'+(incoming.length-add.length?', '+(incoming.length-add.length)+' duplikat dilewati':''));
    }catch(err){toast('File tidak valid')}
    $('importFile').value='';
  };
  rd.readAsText(f);
};
/* Export */
$('btnExport').onclick=()=>{
  if(!RESULT)return toast('Belum ada hasil analisis');
  const head=['Tag','Keputusan','Alasan','Biaya','Komisi','Komisi Efektif','Tertunda','Laba','ROAS','ROI %','CPM','CPC','CPC Ideal','Selisih CPC','Impresi','Reach','Klik Meta','Klik Shopee','% Masuk','CTR %','Order','CR %','Biaya per Order','GMV','Hari Produksi'];
  const rows=RESULT.tags.map(t=>[t.tag,t.label,t.reason,Math.round(t.spend),Math.round(t.comm),Math.round(t.commEff),
    Math.round(t.commPending),Math.round(t.netEff),isFinite(t.roasEff)?t.roasEff.toFixed(3):'',t.spend?t.roi.toFixed(1):'',
    Math.round(t.cpm),Math.round(t.cpc),Math.round(t.cpcIdeal),Math.round(t.cpcGap),t.impr,t.reach,t.clicks,
    t.leak?t.leak.shopeeClicks:'',t.leak?t.leak.pct.toFixed(1):'',t.ctr.toFixed(2),t.orders,t.convRate.toFixed(2),
    Math.round(t.costPerOrder),Math.round(t.gmv),t.daysProd]);
  const csv=[head].concat(rows).map(r=>r.map(c=>`"${String(c==null?'':c).replace(/"/g,'""')}"`).join(',')).join('\n');
  const url=URL.createObjectURL(new Blob(['\uFEFF'+csv],{type:'text/csv;charset=utf-8'}));
  const a=document.createElement('a');
  a.href=url;a.download=`keputusan-${active()}-${RESULT.range.start}_${RESULT.range.end}.csv`;a.click();
  URL.revokeObjectURL(url);toast('CSV diunduh');
};
// Settings are per account: two Shopee accounts can bill different VAT and
// tolerate different risk. The old global key was read but never written, so
// nothing carries over from it.
function loadOpts(){
  try{const o=JSON.parse(localStorage.getItem(LS.opts+'_'+active()));
    if(o)O.forEach(k=>{if(o[k]!=null&&$(k))$(k).value=o[k]})}catch(e){}
}
function saveOpts(){
  const o={};O.forEach(k=>{if($(k))o[k]=$(k).value});
  try{localStorage.setItem(LS.opts+'_'+active(),JSON.stringify(o))}catch(e){}
}
O.forEach(id=>$(id).addEventListener('change',saveOpts));
document.querySelectorAll('[data-preset]').forEach(b=>b.addEventListener('click',saveOpts));
loadOpts();
renderHistory();
