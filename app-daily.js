/* ── Daily edition: account-aware ingest with an approval step ──────────────
   Flow: pick account → parse CSV → dedupe → SHOW the plan → user approves →
   write. Nothing reaches storage before the user has seen what will change,
   because a wrong account choice mixes two accounts' data and is hard to undo.
*/
'use strict';
const E = window.Engine, A = window.DailyAgg, $ = id => document.getElementById(id);
let STORE = null, ACCT = null, AD_ACCT = null;
let PARSED = [], PLAN = null, RESULT = null, CHARTS = {};

const esc = E.escapeHtml;
const rp = n => {
  if (n == null || !isFinite(n)) return 'Rp0';
  const a = Math.abs(n), s = n < 0 ? '-' : '';
  if (a >= 1e9) return s + 'Rp' + (a / 1e9).toFixed(2) + ' M';
  if (a >= 1e6) return s + 'Rp' + (a / 1e6).toFixed(1) + ' jt';
  if (a >= 1e3) return s + 'Rp' + Math.round(a / 1e3) + 'rb';
  return s + 'Rp' + Math.round(a);
};
const nf = n => Math.round(n || 0).toLocaleString('id-ID');
const rx = n => n === Infinity ? '∞' : isFinite(n) ? n.toFixed(2) + 'x' : '—';
function toast(s) {
  const e = $('toast'); e.textContent = s; e.classList.add('show');
  setTimeout(() => e.classList.remove('show'), 2600);
}

/* ── Boot ─────────────────────────────────────────────────────────────────── */
(async () => {
  try {
    STORE = await DailyStore.open();
    await refreshAccounts();
  } catch (e) {
    toast('Gagal membuka penyimpanan: ' + e.message);
  }
})();

async function refreshAccounts(keepId) {
  const shopee = await STORE.listAccounts('shopee');
  const ads = await STORE.listAccounts('ads');
  const selS = $('selShopee'), selA = $('selAds');
  selS.innerHTML = shopee.length
    ? shopee.map(a => `<option value="${a.id}">${esc(a.name)}</option>`).join('')
    : '<option value="">— belum ada akun —</option>';
  if (keepId) selS.value = String(keepId);
  ACCT = shopee.find(a => String(a.id) === selS.value) || shopee[0] || null;

  const mine = ACCT ? ads.filter(a => a.shopee_id === ACCT.id) : [];
  selA.innerHTML = mine.length
    ? mine.map(a => `<option value="${a.id}">${esc(a.name)}</option>`).join('')
    : '<option value="">— belum ada akun iklan —</option>';
  AD_ACCT = mine.find(a => String(a.id) === selA.value) || mine[0] || null;

  await refreshCoverage();
}

/* What is already stored, so the user knows the starting point. */
async function refreshCoverage() {
  if (!ACCT) { $('covStrip').innerHTML = '<span class="chip empty">Belum ada akun dipilih</span>'; return; }
  const c = await STORE.coverage(ACCT.id);
  const label = { affiliate: 'Affiliate', ads: 'Iklan', clicks: 'Klik' };
  $('covStrip').innerHTML = Object.keys(label).map(k => {
    const v = c[k];
    if (!v.rows) return `<span class="chip empty">${label[k]}: belum ada data</span>`;
    return `<span class="chip"><b>${label[k]}</b> · ${v.days} hari · ${v.start} — ${v.end}</span>`;
  }).join('');
}

$('selShopee').onchange = async () => { await refreshAccounts($('selShopee').value); resetUpload(); };
$('selAds').onchange = async () => {
  const ads = await STORE.listAccounts('ads');
  AD_ACCT = ads.find(a => String(a.id) === $('selAds').value) || null;
};

$('btnShopeeAdd').onclick = async () => {
  const n = prompt('Nama akun Shopee (mis. "BBA Utama")');
  if (!n || !n.trim()) return;
  try {
    const a = await STORE.ensureAccount('shopee', n.trim());
    await refreshAccounts(a.id);
    resetUpload();
    toast('Akun dibuat: ' + a.name);
  } catch (e) { toast('Gagal: ' + e.message); }
};
$('btnAdsAdd').onclick = async () => {
  if (!ACCT) return toast('Pilih akun Shopee dulu');
  const n = prompt('Nama akun iklan (mis. "Meta — Adrian")');
  if (!n || !n.trim()) return;
  try {
    const a = await STORE.ensureAccount('ads', n.trim(), { shopee_id: ACCT.id });
    await refreshAccounts(ACCT.id);
    $('selAds').value = String(a.id);
    AD_ACCT = a;
    toast('Akun iklan dibuat: ' + a.name);
  } catch (e) { toast('Gagal: ' + e.message); }
};

/* ── Upload ───────────────────────────────────────────────────────────────── */
const drop = $('drop');
drop.onclick = () => $('files').click();
$('btnPick').onclick = e => { e.stopPropagation(); $('files').click(); };
['dragenter', 'dragover'].forEach(x => drop.addEventListener(x, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(x => drop.addEventListener(x, e => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', e => handleFiles(e.dataTransfer.files));
$('files').onchange = e => handleFiles(e.target.files);

function resetUpload() {
  PARSED = []; PLAN = null; RESULT = null;
  $('chips').innerHTML = ''; $('upStatus').textContent = '';
  $('ingestPlan').classList.add('hidden');
  $('savedNote').classList.add('hidden');
  $('main').classList.add('hidden');
  $('files').value = '';
  Object.values(CHARTS).forEach(c => { try { c.destroy(); } catch (e) {} });
  CHARTS = {};
}

function handleFiles(list) {
  if (!ACCT) return toast('Pilih atau buat akun Shopee dulu');
  const arr = [...(list || [])];
  if (!arr.length) return;
  let pending = arr.length;
  $('upStatus').textContent = 'Membaca ' + arr.length + ' file...';
  arr.forEach(file => {
    Papa.parse(file, {
      header: true, skipEmptyLines: true,
      complete: r => {
        const rows = r.data || [];
        const kind = rows.length ? E.detectFileType(Object.keys(rows[0])) : 'unknown';
        PARSED = PARSED.filter(p => p.name !== file.name);
        PARSED.push({ name: file.name, kind, rows });
        if (!--pending) afterParse();
      },
      error: () => { toast('Gagal membaca ' + file.name); if (!--pending) afterParse(); },
    });
  });
}

async function afterParse() {
  $('chips').innerHTML = PARSED.map(p =>
    `<span class="chip ${p.kind}">${esc(p.name)} · ${nf(p.rows.length)} baris${p.kind === 'unknown' ? ' · tidak dikenali' : ''}</span>`
  ).join('');
  $('upStatus').textContent = PARSED.length + ' file dibaca';
  await buildPlan();
  runAnalysis();
}

/* Build the ingest plan without writing anything. */
async function buildPlan() {
  if (!ACCT) return;
  const kinds = { affiliate: 'affiliate', ads: 'ads', clicks: 'clicks' };
  const plan = { acct: ACCT, items: [], total: { added: 0, updated: 0, dup: 0 } };

  for (const p of PARSED) {
    if (!kinds[p.kind]) continue;
    const kind = kinds[p.kind];
    const fileHash = A.hashRows(p.rows);
    const seen = await STORE.seenFile(ACCT.id, fileHash);
    const known = await STORE.knownRowHashes(ACCT.id, kind);
    const dedup = A.dedupe(p.rows, known);
    const agg = kind === 'affiliate' ? A.aggregateAffiliate(dedup.kept)
      : kind === 'ads' ? A.aggregateAds(dedup.kept)
      : A.aggregateClicks(dedup.kept);
    const keyFields = kind === 'ads' ? ['date', 'ad_unit'] : ['date', 'tag'];
    const existing = await STORE.existingKeys(ACCT.id, kind);
    const ing = A.planIngest(agg, existing, keyFields);
    plan.items.push({
      file: p.name, kind, fileHash, seenBefore: seen,
      sourceRows: p.rows.length, duplicates: dedup.duplicates,
      rowHashes: dedup.hashes, records: agg,
      added: ing.newCount, updated: ing.updateCount,
      period: ing.period, days: ing.days,
    });
    if (!seen) {
      plan.total.added += ing.newCount;
      plan.total.updated += ing.updateCount;
      plan.total.dup += dedup.duplicates;
    }
  }
  PLAN = plan;
  renderPlan();
}

function renderPlan() {
  if (!PLAN || !PLAN.items.length) { $('ingestPlan').classList.add('hidden'); return; }
  $('planAcct').textContent = PLAN.acct.name;
  const label = { affiliate: 'Affiliate', ads: 'Iklan', clicks: 'Klik' };
  $('planRows').innerHTML = PLAN.items.map(it => {
    const pills = it.seenBefore
      ? `<span class="plan-pill seen">sudah diunggah ${new Date(it.seenBefore.uploaded_at).toLocaleDateString('id-ID', { day: '2-digit', month: '2-digit', year: 'numeric' })} — dilewati</span>`
      : [
          it.added ? `<span class="plan-pill new">${nf(it.added)} baru</span>` : '',
          it.updated ? `<span class="plan-pill upd">${nf(it.updated)} diperbarui</span>` : '',
          it.duplicates ? `<span class="plan-pill dup">${nf(it.duplicates)} duplikat dilewati</span>` : '',
          (!it.added && !it.updated) ? '<span class="plan-pill dup">tidak ada perubahan</span>' : '',
        ].join('');
    const per = it.period ? `<span class="plan-period">${it.days} hari · ${it.period.start} — ${it.period.end}</span>` : '';
    return `<div class="plan-row"><div class="plan-kind">${label[it.kind] || it.kind}</div>
      <div class="plan-nums">${pills}${per}</div></div>`;
  }).join('');
  const writable = PLAN.items.some(it => !it.seenBefore && (it.added || it.updated));
  const anythingNew = PLAN.items.some(it => it.added || it.updated);
  const btn = $('btnSaveAll');
  // The button stays enabled either way: when there is nothing to write it
  // becomes a plain dismiss, because a disabled control cannot be clicked and
  // a status message is not an action.
  btn.disabled = false;
  btn.dataset.mode = writable ? 'save' : 'close';
  btn.textContent = writable
    ? `Simpan ${nf(PLAN.total.added)} baru · ${nf(PLAN.total.updated)} perbarui`
    : (anythingNew ? 'Tutup' : 'Tidak ada yang perlu disimpan');
  btn.classList.toggle('primary', writable);
  btn.classList.toggle('ghost', !writable);
  // "Nothing to do" is not an error, so don't offer a second dismiss next to it.
  $('btnSkipSave').classList.toggle('hidden', !writable);
  $('ingestPlan').classList.remove('hidden');
  $('savedNote').classList.add('hidden');
}

$('btnSkipSave').onclick = () => {
  $('ingestPlan').classList.add('hidden');
  toast('Dilewati — data tidak disimpan ke riwayat');
};

$('btnSaveAll').onclick = async () => {
  if (!PLAN || !ACCT) return;
  const btn = $('btnSaveAll');
  // In "close" mode the plan is informational — nothing to write.
  if (btn.dataset.mode === 'close') { $('ingestPlan').classList.add('hidden'); return; }
  btn.disabled = true; btn.textContent = 'Menyimpan...';
  let added = 0, updated = 0, skipped = 0;
  try {
    for (const it of PLAN.items) {
      if (it.seenBefore) { skipped++; continue; }
      const res = await STORE.saveDaily(ACCT.id, it.kind, it.records, {
        rowHashes: it.rowHashes, fileHash: it.fileHash, fileName: it.file,
        sourceRows: it.sourceRows, duplicates: it.duplicates, period: it.period,
      });
      added += res.added; updated += res.updated;
    }
    $('ingestPlan').classList.add('hidden');
    $('savedNote').innerHTML = `<b>Tersimpan ke ${esc(ACCT.name)}</b> — ${nf(added)} baris baru, ${nf(updated)} diperbarui`
      + (skipped ? `, ${skipped} file dilewati karena sudah pernah diunggah` : '')
      + `. Buka tab <b>Riwayat Harian</b> untuk melihat trennya.`;
    $('savedNote').classList.remove('hidden');
    await refreshCoverage();
    await renderStored();
    await renderUploads();
    await buildPlan();
    toast('Tersimpan: ' + nf(added) + ' baru');
  } catch (e) {
    toast('Gagal menyimpan: ' + e.message);
    btn.disabled = false; renderPlan();
  }
};

$('btnExport').onclick = async () => {
  if (!ACCT) return toast('Pilih akun dulu');
  const data = await STORE.exportAccount(ACCT.id);
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url;
  a.download = `harian-${ACCT.name.replace(/\s+/g, '-')}-${new Date().toISOString().slice(0, 10)}.json`;
  a.click(); URL.revokeObjectURL(url);
  toast('Riwayat akun diekspor');
};
