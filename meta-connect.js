/* ── Meta Ads Manager connection ─────────────────────────────────────────────
   Loads after app.js. Pulls the daily ad-level report from the Marketing API
   (meta-api.js) and feeds it to app.js's files() as a CSV file, so the result
   goes through the same validation, matching and Simpan flow as an export.

   The token stays in this browser: in memory by default, in localStorage only
   when the user ticks "Ingat token". There is no backend to hold it.
*/
'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const M = window.MetaApi, toast = window.toast, esc = window.Engine.escapeHtml;
  const api = M.create();
  const KEY = acct => 'adash_meta_v1_' + acct;
  let TOKEN = '', ACCOUNTS = [], BUSY = null;

  const today = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); };
  function load() { try { const v = JSON.parse(localStorage.getItem(KEY(active()))); return v && typeof v === 'object' ? v : {}; } catch (e) { return {}; } }
  function store(patch) {
    const next = Object.assign(load(), patch);
    Object.keys(next).forEach(k => { if (next[k] == null || next[k] === '') delete next[k]; });
    try { localStorage.setItem(KEY(active()), JSON.stringify(next)); } catch (e) { /* storage blocked: settings stay for this session */ }
  }

  function setError(message) { $('metaError').textContent = message || ''; $('metaError').classList.toggle('hidden', !message); }
  function setStatus(message) { $('metaStatus').textContent = message || ''; }
  function setBusy(controller) {
    BUSY = controller;
    ['btnMetaAccounts', 'btnMetaPull', 'metaAccount', 'metaToken', 'metaSince', 'metaUntil'].forEach(id => { $(id).disabled = !!controller; });
    $('btnMetaCancel').classList.toggle('hidden', !controller);
    if (!controller) $('btnMetaPull').disabled = !$('metaAccount').value;
  }
  function currentToken() { return ($('metaToken').value || '').trim(); }

  function renderAccounts(selected) {
    const sel = $('metaAccount');
    sel.innerHTML = ACCOUNTS.length
      ? ACCOUNTS.map(a => `<option value="${esc(a.id)}">${esc(a.name)} · ${esc(a.id.replace(/^act_/, ''))}${a.currency ? ' · ' + esc(a.currency) : ''}</option>`).join('')
      : (selected ? `<option value="${esc(selected.id)}">${esc(selected.name || selected.id)}</option>` : '<option value="">Muat akun iklan dulu</option>');
    if (selected && [...sel.options].some(o => o.value === selected.id)) sel.value = selected.id;
    $('btnMetaPull').disabled = !sel.value || !!BUSY;
  }

  function open() {
    const saved = load();
    TOKEN = TOKEN || saved.token || '';
    $('metaToken').value = TOKEN;
    $('metaRemember').checked = !!saved.token;
    $('metaContext').textContent = 'Akun dashboard: ' + active();
    if (!$('metaUntil').value) {
      const end = M.shift(today(), -1);
      $('metaUntil').value = end; $('metaSince').value = M.shift(end, -6);
    }
    renderAccounts(saved.adAccountId ? { id: saved.adAccountId, name: saved.adAccountName } : null);
    setError(''); setStatus(saved.lastPull ? `Tarikan terakhir: ${saved.lastPull}` : '');
    openModal('metaModal');
  }

  async function loadAccounts() {
    setError('');
    const controller = new AbortController(); setBusy(controller); setStatus('Memuat akun iklan…');
    try {
      ACCOUNTS = await api.listAdAccounts(currentToken(), controller.signal);
      TOKEN = currentToken(); rememberToken();
      const saved = load();
      renderAccounts(ACCOUNTS.find(a => a.id === saved.adAccountId) || ACCOUNTS[0]);
      setStatus(ACCOUNTS.length ? `${ACCOUNTS.length} akun iklan ditemukan.` : '');
      if (!ACCOUNTS.length) setError('Token valid, tetapi tidak ada akun iklan yang bisa dibaca. Tugaskan akun iklan ke pengguna atau System User pemilik token.');
    } catch (err) {
      if (err.name !== 'AbortError') { setError(err.message); setStatus(''); }
    } finally { setBusy(null); }
  }

  function rememberToken() {
    store({ token: $('metaRemember').checked ? TOKEN : null });
  }

  /* Ads files already loaded, with their date span. A file pulled earlier from
     the same ad account is replaced; anything else covering the same dates
     would be counted twice, so the pull stops and says which file. */
  function adsFiles() {
    return FILES.map(f => {
      if (f.type !== 'ads') return null;
      let min = '', max = '';
      (f.rowsData || []).forEach(r => { const d = window.Engine.dayOnly(r['Reporting starts']); if (window.Engine.isDate(d)) { if (!min || d < min) min = d; if (!max || d > max) max = d; } });
      return { file: f, start: min, end: max, adAccount: (/^meta-api_(act_\d+)_/.exec(f.name) || [])[1] || null };
    }).filter(x => x && x.start);
  }

  async function pull() {
    setError('');
    const account = $('metaAccount').value, since = $('metaSince').value, until = $('metaUntil').value;
    if (!account) return setError('Pilih akun iklan.');
    if (!since || !until) return setError('Isi tanggal mulai dan akhir.');
    if (since > until) return setError('Tanggal mulai harus sebelum tanggal akhir.');
    const info = ACCOUNTS.find(a => a.id === account);
    if (info && info.currency && info.currency !== 'IDR') return setError(`Akun ini memakai ${info.currency}. Dashboard hanya menghitung biaya dalam IDR.`);

    const overlapping = adsFiles().filter(x => x.start <= until && x.end >= since);
    const foreign = overlapping.filter(x => x.adAccount !== account);
    if (foreign.length) return setError(`Tanggal ini sudah ada dari ${foreign.map(x => x.file.name).join(', ')}. Hapus file itu dari kotak Meta Ads dulu agar biaya tidak terhitung dua kali, atau pilih tanggal lain.`);
    // Widen to the union so replacing an earlier pull never drops its other days.
    const replace = overlapping.map(x => x.file);
    const start = overlapping.reduce((d, x) => x.start < d ? x.start : d, since);
    const end = overlapping.reduce((d, x) => x.end > d ? x.end : d, until);

    const controller = new AbortController(); setBusy(controller);
    TOKEN = currentToken(); rememberToken();
    try {
      const result = await api.fetchDailyInsights(TOKEN, account, start, end, {
        signal: controller.signal,
        onProgress: p => setStatus(p.step < p.total ? `Menarik ${p.range.since} — ${p.range.until} (${p.step + 1}/${p.total})…` : 'Membaca status iklan…'),
      });
      if (!result.rows.length) { setStatus(''); return setError(`Tidak ada data iklan yang tayang pada ${start} — ${end} di akun ini.`); }
      const text = M.toCsv(result, info && info.currency);
      const parsed = DashboardImport.parseText(text, { fileName: M.fileName(result) });
      if (!parsed.ok || parsed.stats.rejected) {
        const first = parsed.issues.find(x => x.severity === 'error');
        return setError('Data dari Meta tidak lolos pemeriksaan: ' + (first ? first.message : 'format tidak dikenali') + ' File lama tidak diubah.');
      }
      if (replace.length) { FILES = FILES.filter(f => !replace.includes(f)); rebuildData(); }
      const name = info ? info.name : account;
      store({ adAccountId: account, adAccountName: name, lastPull: `${start} — ${end}, ${new Date().toLocaleString('id-ID')}` });
      await files([new File([text], M.fileName(result), { type: 'text/csv' })]);
      setStatus(`${result.rows.length} baris iklan harian dimuat dari ${name} (${start} — ${end}).`);
      closeModal($('metaModal'));
      toast(replace.length ? 'Data Meta diperbarui dari Ads Manager' : 'Data Meta dimuat dari Ads Manager');
    } catch (err) {
      if (err.name === 'AbortError') setStatus('Penarikan dibatalkan. Data lama tidak diubah.');
      else { setError(err.message); setStatus(''); }
    } finally { setBusy(null); }
  }

  $('btnMeta').onclick = e => { e.stopPropagation(); open(); };
  $('btnMetaAccounts').onclick = loadAccounts;
  $('btnMetaPull').onclick = pull;
  $('btnMetaCancel').onclick = () => { if (BUSY) BUSY.abort(); };
  $('metaRemember').onchange = () => { TOKEN = currentToken() || TOKEN; rememberToken(); };
  $('metaAccount').onchange = () => { $('btnMetaPull').disabled = !$('metaAccount').value; };
  $('btnMetaForget').onclick = () => {
    TOKEN = ''; ACCOUNTS = []; $('metaToken').value = ''; $('metaRemember').checked = false;
    store({ token: null }); renderAccounts(null); setError(''); setStatus('Token dihapus dari browser ini.');
  };
  // A different dashboard account has its own Meta settings and token.
  $('account').addEventListener('change', () => { if (BUSY) BUSY.abort(); TOKEN = ''; ACCOUNTS = []; });
})();
