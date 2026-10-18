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
  const M = window.MetaApi, E = window.Engine, toast = window.toast, esc = E.escapeHtml;
  const api = M.create();
  const PREFIX = 'adash_meta_v1_', KEY = acct => PREFIX + acct;
  const PULLED = /^meta-api_(act_\d+)_/, PULLED_RANGE = /_(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})\.csv$/;
  // OWNER is the dashboard account the token and ad-account list were entered
  // under. Creating an account with "+" fires no change event, so open() and
  // every pull compare it with active() instead of relying on that event.
  let TOKEN = '', ACCOUNTS = [], BUSY = null, OWNER = null, DEFAULT_RANGE = null;
  // Ads dates already in saved history for one dashboard account.
  let SAVED = { acct: null, dates: [] };

  function load(acct) { try { const v = JSON.parse(localStorage.getItem(KEY(acct || active()))); return v && typeof v === 'object' ? v : {}; } catch (e) { return {}; } }
  function store(patch, acct) {
    const next = Object.assign(load(acct), patch);
    Object.keys(next).forEach(k => { if (next[k] == null || next[k] === '') delete next[k]; });
    try { localStorage.setItem(KEY(acct || active()), JSON.stringify(next)); } catch (e) { /* storage blocked: settings stay for this session */ }
  }
  function forgetSession() { if (BUSY) BUSY.abort(); TOKEN = ''; ACCOUNTS = []; OWNER = null; }

  function setError(message) { $('metaError').textContent = message || ''; $('metaError').classList.toggle('hidden', !message); }
  function setStatus(message) { $('metaStatus').textContent = message || ''; }
  function setBusy(controller) {
    BUSY = controller;
    ['btnMetaAccounts', 'btnMetaPull', 'metaAccount', 'metaToken', 'metaSince', 'metaUntil'].forEach(id => { $(id).disabled = !!controller; });
    $('btnMetaCancel').classList.toggle('hidden', !controller);
    // The clicked button is now disabled; without this, Escape or Tab+Enter
    // lands on Tutup instead of Batalkan.
    if (controller) $('btnMetaCancel').focus();
    else $('btnMetaPull').disabled = !$('metaAccount').value;
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

  /* Insights dates follow the ad account's timezone, so the default ends on the
     account's yesterday. A range the user typed is never overwritten; one this
     script wrote is refreshed when the day (or the selected account) changes. */
  function selectedTimezone() {
    const info = ACCOUNTS.find(a => a.id === $('metaAccount').value);
    return info ? info.timezone : (load().adAccountTimezone || '');
  }
  function defaultRange() {
    const since = $('metaSince').value, until = $('metaUntil').value;
    const untouched = (!since && !until) || (DEFAULT_RANGE && since === DEFAULT_RANGE.since && until === DEFAULT_RANGE.until);
    if (!untouched) return;
    const end = M.accountYesterday(selectedTimezone());
    DEFAULT_RANGE = { since: M.shift(end, -6), until: end };
    $('metaSince').value = DEFAULT_RANGE.since; $('metaUntil').value = DEFAULT_RANGE.until;
    savedHint();
  }

  /* Saved history adds every row whose numbers differ from what it holds, so
     re-saving a re-pulled day that Meta has revised counts it twice. The
     dialog names saved days in the range before the pull. Saved ads are not
     kept per ad account, so the hint cannot tell which account they came from. */
  async function loadSaved() {
    const acct = active(), history = window.__dailyStore;
    if (!history) return;
    try {
      const account = (await history.listAccounts('shopee')).find(a => a.name === acct);
      const dates = account ? [...new Set((await history.range(account.id, 'ads')).map(r => r.date))].sort() : [];
      if (acct === active()) { SAVED = { acct, dates }; savedHint(); }
    } catch (e) { /* history unavailable: no hint */ }
  }
  function savedHint() {
    const since = $('metaSince').value, until = $('metaUntil').value;
    const hit = SAVED.acct === active() && since && until ? SAVED.dates.filter(d => d >= since && d <= until) : [];
    $('metaSaved').textContent = hit.length
      ? `Data Tersimpan sudah berisi biaya iklan untuk ${hit.length} hari di rentang ini (${hit[0]} — ${hit[hit.length - 1]}). Baris yang tidak berubah dilewati saat Simpan, tetapi angka yang direvisi Meta sejak disimpan akan ditambahkan, bukan diganti. Jika data tersimpan itu dari akun iklan yang sama, analisis tarikan ini di layar saja, atau hapus tanggal itu di Data Tersimpan sebelum Simpan (menghapus tanggal ikut menghapus akun iklan lain pada tanggal itu).`
      : '';
    $('metaSaved').classList.toggle('hidden', !hit.length);
  }

  function open() {
    if (BUSY && BUSY.signal.aborted) setBusy(null);
    if (OWNER !== active()) forgetSession();
    OWNER = active();
    const saved = load();
    TOKEN = TOKEN || saved.token || '';
    $('metaToken').value = TOKEN;
    $('metaRemember').checked = !!saved.token;
    $('metaContext').textContent = 'Akun dashboard: ' + active();
    renderAccounts(ACCOUNTS.length
      ? ACCOUNTS.find(a => a.id === saved.adAccountId) || ACCOUNTS[0]
      : saved.adAccountId ? { id: saved.adAccountId, name: saved.adAccountName } : null);
    defaultRange();
    setError(''); setStatus(saved.lastPull ? `Tarikan terakhir: ${saved.lastPull}` : '');
    if (SAVED.acct !== active()) SAVED = { acct: null, dates: [] };
    savedHint(); loadSaved();
    openModal('metaModal');
  }

  async function loadAccounts() {
    setError('');
    const acct = active(), controller = new AbortController(); setBusy(controller); setStatus('Memuat akun iklan…');
    try {
      const list = await api.listAdAccounts(currentToken(), controller.signal);
      if (controller.signal.aborted || acct !== active()) return;
      ACCOUNTS = list; TOKEN = currentToken(); OWNER = acct; rememberToken();
      const saved = load();
      renderAccounts(ACCOUNTS.find(a => a.id === saved.adAccountId) || ACCOUNTS[0]);
      defaultRange();
      setStatus(ACCOUNTS.length ? `${ACCOUNTS.length} akun iklan ditemukan.` : '');
      if (!ACCOUNTS.length) setError('Token valid, tetapi tidak ada akun iklan yang bisa dibaca. Tugaskan akun iklan ke pengguna atau System User pemilik token.');
    } catch (err) {
      if (err.name !== 'AbortError') { setError(err.message); setStatus(''); }
    } finally { if (BUSY === controller) setBusy(null); }
  }

  function rememberToken() {
    store({ token: $('metaRemember').checked ? TOKEN : null });
  }

  /* Ads files already loaded, with their date span. adAccount is set only for
     files this dialog pulled; their span also covers the requested range in
     the file name, which can reach days with account spend but no ad rows. */
  function adsSpans() {
    return FILES.map(f => {
      if (f.type !== 'ads') return null;
      const adAccount = (PULLED.exec(f.name) || [])[1] || null, asked = adAccount ? PULLED_RANGE.exec(f.name) : null;
      let min = asked ? asked[1] : '', max = asked ? asked[2] : '';
      (f.rowsData || []).forEach(r => { const d = E.dayOnly(r['Reporting starts']); if (E.isDate(d)) { if (!min || d < min) min = d; if (!max || d > max) max = d; } });
      return { file: f, start: min, end: max, adAccount };
    }).filter(x => x && x.start);
  }
  const idOf = r => String(r['Ad ID'] == null ? '' : r['Ad ID']).trim();
  // The CSV formula guard puts "'" before a pulled name starting with = + - @;
  // an export of the same ad has no such prefix.
  const nameOf = r => String(r['Ad name'] == null ? '' : r['Ad name']).trim().replace(/^'(?=[=+\-@\t\r])/, '').toLowerCase();
  const dayIn = (start, end) => r => { const d = E.dayOnly(r['Reporting starts']); return d >= start && d <= end; };
  /* Ad IDs that went through a spreadsheet come back rounded: scientific
     notation, or 18 digits ending in 000. Only intact IDs can prove anything. */
  const trustedIds = ids => ids.every(id => /^\d{6,}$/.test(id)) && !ids.every(id => id.length >= 16 && id.endsWith('000'));
  /* An uploaded export and a pull covering the same dates double count only
     when they come from the same ad account. Different accounts need positive
     evidence: every export row on those dates has an Ad ID, and none matches
     the pull. When the IDs look rounded, ad names decide instead. */
  function sameAccount(exportRows, pulledRows, start, end) {
    const mine = exportRows.filter(dayIn(start, end)), theirs = pulledRows.filter(dayIn(start, end));
    if (!mine.length || !theirs.length) return false;
    if (mine.some(r => !idOf(r))) return true;
    const ids = new Set(theirs.map(idOf));
    if (mine.some(r => ids.has(idOf(r)))) return true;
    if (trustedIds(mine.map(idOf))) return false;
    const names = new Set(theirs.map(nameOf).filter(Boolean));
    return mine.some(r => names.has(nameOf(r)));
  }
  const spanName = (rows, account, gaps) => {
    const days = rows.map(r => E.dayOnly(r['Reporting starts'])).concat((gaps || []).map(g => g.date)).filter(E.isDate).sort();
    return M.fileName({ account, since: days[0], until: days[days.length - 1] });
  };
  // parseText refuses text with U+FFFD as a broken encoding, and a lone
  // surrogate becomes U+FFFD once the text is put in a File. Both can only come
  // from a damaged ad name (a deleted ad cannot be renamed), so they become '?'.
  const wellFormed = s => s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|�/g, '?');
  // Spend the ad rows do not explain, as a quality note naming the file.
  const gapNote = (name, gaps) => gaps.length ? `${name}: ${full(gaps.reduce((s, g) => s + g.missing, 0))} biaya akun pada ${gaps.length} hari tidak muncul di baris iklan.` : '';
  function withGaps(entry, gaps) {
    const quality = (entry.quality || []).filter(q => q !== entry.metaGapNote), note = gapNote(entry.name, gaps);
    return Object.assign(entry, { metaGaps: gaps, metaGapNote: note, quality: note ? quality.concat(note) : quality });
  }
  // A result that arrives after the dialog was closed is still shown.
  function tell(message, isError) {
    if ($('metaModal').classList.contains('show')) return isError ? setError(message) : setStatus(message);
    toast(message);
  }

  async function pull() {
    setError('');
    const account = $('metaAccount').value, since = $('metaSince').value, until = $('metaUntil').value;
    if (!account) return setError('Pilih akun iklan.');
    if (!since || !until) return setError('Isi tanggal mulai dan akhir.');
    if (since > until) return setError('Tanggal mulai harus sebelum tanggal akhir.');
    const info = ACCOUNTS.find(a => a.id === account);
    if (info && info.currency && info.currency !== 'IDR') return setError(`Akun ini memakai ${info.currency}. Dashboard hanya menghitung biaya dalam IDR.`);
    // An export without Ad IDs can be refused before fetching; the full check
    // runs again on the data loaded at the end of the pull.
    const early = adsSpans().filter(x => !x.adAccount && x.start <= until && x.end >= since && !(x.file.rowsData || []).some(idOf));
    if (early.length) return setError(overlapMessage(early));

    // The pull belongs to the dashboard account and the loaded data it started
    // from. A switch, Kosongkan, a removed file or a cancel discards it.
    const acct = active(), epoch = IMPORT_EPOCH, controller = new AbortController();
    const stale = () => controller.signal.aborted || acct !== active() || epoch !== IMPORT_EPOCH;
    const discarded = () => setStatus(controller.signal.aborted ? 'Penarikan dibatalkan. Data lama tidak diubah.' : 'Akun dashboard atau data yang dimuat berubah selama penarikan, jadi hasilnya dibuang. Tarik ulang bila perlu.');
    const cancelled = new Promise(resolve => controller.signal.addEventListener('abort', resolve, { once: true }));
    setBusy(controller);
    TOKEN = currentToken(); OWNER = acct; rememberToken();
    try {
      const result = await api.fetchDailyInsights(TOKEN, account, since, until, {
        signal: controller.signal,
        onProgress: p => setStatus(p.step < p.total ? `Menarik ${p.range.since} — ${p.range.until} (${p.step + 1}/${p.total})…` : 'Membaca status iklan…'),
      });
      // Files still being read must be in FILES before overlaps are checked.
      // A cancel while waiting for them takes effect at once.
      setStatus('Menunggu file lain selesai diperiksa…');
      await Promise.race([IMPORT_QUEUE.catch(() => {}), cancelled]);
      if (stale()) return discarded();
      if (!result.rows.length) { setStatus(''); return setError(`Tidak ada data iklan yang tayang pada ${since} — ${until} di akun ini.`); }
      setStatus('Memeriksa data dari Meta…');
      const name = M.fileName(result), text = wellFormed(M.toCsv(result, info && info.currency));
      const parsed = DashboardImport.parseText(text, { fileName: name });
      if (!parsed.ok || parsed.stats.rejected) {
        const first = parsed.issues.find(x => x.severity === 'error');
        setStatus('');
        return setError('Data dari Meta tidak lolos pemeriksaan: ' + (first ? first.message : 'format tidak dikenali') + ' File lama tidak diubah.');
      }
      const file = new File([text], name, { type: 'text/csv' });
      if (file.size > 75 * 1024 * 1024) { setStatus(''); return setError('Hasil tarikan melebihi 75 MB. Persempit rentang tanggal lalu tarik per periode.'); }
      // Checking a large pull blocks the page; a cancel pressed meanwhile is
      // delivered here, before anything loaded is changed.
      await new Promise(resolve => setTimeout(resolve, 0));
      if (stale()) return discarded();

      const overlapping = adsSpans().filter(x => x.start <= until && x.end >= since);
      const foreign = overlapping.filter(x => !x.adAccount && sameAccount(x.file.rowsData || [], parsed.rows, since, until));
      if (foreign.length) { setStatus(''); return setError(overlapMessage(foreign)); }
      // An earlier pull from this ad account keeps only its days outside the
      // new range. Its other days are not fetched again, so they cannot come
      // back with revised numbers and be added to saved history a second time.
      const before = FILES.slice(), outside = r => !dayIn(since, until)(r);
      const trimmed = new Map(overlapping.filter(x => x.adAccount === account).map(x => {
        const rowsData = x.file.rowsData.filter(outside), gaps = (x.file.metaGaps || []).filter(g => g.date < since || g.date > until);
        if (!rowsData.length) return [x.file, null];
        const copy = Object.assign({}, x.file, { rowsData, rows: rowsData.length, name: spanName(rowsData, account, gaps) });
        return [x.file, withGaps(copy, gaps)];
      }));
      if (trimmed.size) { FILES = FILES.map(f => trimmed.has(f) ? trimmed.get(f) : f).filter(Boolean); rebuildData(); renderChips(); }
      setStatus('Memuat ke dashboard…');
      try { await files([file]); } catch (err) { /* reported below as not loaded */ }
      const added = FILES.find(f => f.name === name && f.type === 'ads' && !before.includes(f));
      if (!added) {
        const report = IMPORT_REPORTS.find(r => r.name === name), why = report && report.message ? ': ' + report.message : '.';
        if (BUSY === controller) setBusy(null);
        setStatus('');
        // Put the earlier pull back, but never into data that changed while
        // the file was being imported.
        if (acct === active() && epoch === IMPORT_EPOCH) {
          if (trimmed.size) { FILES = before.concat(FILES.filter(f => !before.includes(f) && ![...trimmed.values()].includes(f))); rebuildData(); finish(); }
          return tell('Hasil tarikan tidak dapat dimuat' + why + ' Data lama tetap dipakai.', true);
        }
        return tell('Hasil tarikan tidak dimuat karena data di dashboard berubah selama dimuat' + why + ' Tarik ulang rentang ini.', true);
      }

      const label = info ? info.name : (load(acct).adAccountName || account);
      const patch = { adAccountId: account, adAccountName: label, lastPull: `${since} — ${until}, ${new Date().toLocaleString('id-ID')}` };
      if (info) patch.adAccountTimezone = info.timezone;
      store(patch, acct);
      withGaps(added, result.gaps);
      if (BUSY === controller) setBusy(null);
      // Importing a large file blocks the page; an Escape pressed meanwhile is
      // handled first, so a warning is not written into a dialog about to close.
      await new Promise(resolve => setTimeout(resolve, 0));
      const loaded = `${added.rows} baris iklan harian dimuat dari ${label} (${since} — ${until}).`;
      if (result.gaps.length) {
        // Spend the ad rows do not explain would make ROAS look better than it
        // is, so the gap stays on screen and in the export's quality notes.
        const days = result.gaps.map(g => g.date), missing = full(result.gaps.reduce((s, g) => s + g.missing, 0));
        setStatus(loaded);
        return tell(`Perhatian: total biaya akun iklan ${missing} lebih besar dari jumlah baris iklan pada ${days.length} hari (${days.slice(0, 3).join(', ')}${days.length > 3 ? ', …' : ''}). Biaya itu tidak ikut dihitung, sehingga ROAS terlihat lebih baik dari kenyataan. Periksa tanggal tersebut di Ads Manager (iklan yang dihapus atau diarsipkan).`, true);
      }
      setStatus(loaded);
      closeModal($('metaModal'));
      toast(trimmed.size ? 'Data Meta diperbarui dari Ads Manager' : 'Data Meta dimuat dari Ads Manager');
    } catch (err) {
      if (err.name === 'AbortError') setStatus('Penarikan dibatalkan. Data lama tidak diubah.');
      else { tell(err.message, true); setStatus(''); }
    } finally { if (BUSY === controller) setBusy(null); }
  }
  function overlapMessage(list) {
    return `Tanggal ini sudah ada dari ${list.map(x => x.file.name).join(', ')}. Hapus file itu dari kotak Meta Ads dulu agar biaya tidak terhitung dua kali, atau pilih tanggal lain. Jika file itu dari akun iklan lain, sertakan kolom Ad ID saat mengekspornya, atau tarik akun itu juga dari Ads Manager.`;
  }

  /* Names, delivery status and rankings describe the ad today (Insights reports
     current values for past dates). On a pulled file they stay readable
     (engine.js and daily-agg.js read them by name) but are not enumerable, so
     they are not part of the row fingerprint; Ad ID keeps rows distinct. A
     re-pulled day whose numbers did not change is then a duplicate in memory
     and in saved history, even after a rename or a status change. */
  const settle = rows => rows.forEach(r => M.VOLATILE_COLUMNS.forEach(k => {
    if (!Object.prototype.propertyIsEnumerable.call(r, k)) return;
    const value = r[k];
    delete r[k];
    Object.defineProperty(r, k, { value, enumerable: false, writable: true, configurable: true });
  }));

  /* The same double-count guard in the other direction: an uploaded Meta
     export whose dates a pull from the same ad account already covers is
     refused, also when it is accepted from the review step. */
  const commitImport = window.commitImport;
  window.commitImport = function (report) {
    const p = report && report.parsed;
    if (p && p.type === 'ads' && PULLED.test(report.name || '')) settle(p.rows || []);
    else if (p && p.type === 'ads' && p.period) {
      const clash = adsSpans().filter(x => x.adAccount && x.start <= p.period.end && x.end >= p.period.start
        && sameAccount(p.rows || [], x.file.rowsData || [], x.start > p.period.start ? x.start : p.period.start, x.end < p.period.end ? x.end : p.period.end));
      if (clash.length) {
        report.state = 'error';
        report.message = `Tanggal di file ini sudah ada dari tarikan Ads Manager (${clash.map(x => x.file.name).join(', ')}). Hapus tarikan itu dulu, atau tarik ulang tanggal ini dari Ads Manager, agar biaya tidak terhitung dua kali. Jika file ini dari akun iklan lain, tarik akun itu juga dari Ads Manager.`;
        return false;
      }
    }
    return commitImport.apply(this, arguments);
  };

  $('btnMeta').onclick = e => { e.stopPropagation(); open(); };
  $('btnMetaAccounts').onclick = loadAccounts;
  $('btnMetaPull').onclick = pull;
  $('btnMetaCancel').onclick = () => { if (BUSY) BUSY.abort(); };
  $('metaRemember').onchange = () => { TOKEN = currentToken() || TOKEN; OWNER = active(); rememberToken(); };
  $('metaAccount').onchange = () => { $('btnMetaPull').disabled = !$('metaAccount').value; defaultRange(); };
  ['metaSince', 'metaUntil'].forEach(id => $(id).addEventListener('input', savedHint));
  $('btnMetaForget').onclick = () => {
    TOKEN = ''; ACCOUNTS = []; $('metaToken').value = ''; $('metaRemember').checked = false;
    // Tokens are remembered per dashboard account; "dari browser ini" has to
    // cover every one of them, not only the account on screen.
    try {
      Object.keys(localStorage).filter(k => k.startsWith(PREFIX)).forEach(k => {
        let v = null;
        try { v = JSON.parse(localStorage.getItem(k)); } catch (e) { /* unreadable entry: removed below */ }
        if (!v || typeof v !== 'object') return localStorage.removeItem(k);
        if ('token' in v) { delete v.token; localStorage.setItem(k, JSON.stringify(v)); }
      });
    } catch (e) { /* storage blocked: nothing was remembered */ }
    renderAccounts(null); setError(''); setStatus('Token dihapus dari browser ini.');
  };
  // Escape, Tutup and the backdrop all close the dialog through app.js; any of
  // them stops a running pull, so its result can never land unseen.
  new MutationObserver(() => { if (BUSY && !$('metaModal').classList.contains('show')) BUSY.abort(); })
    .observe($('metaModal'), { attributes: true, attributeFilter: ['class'] });
  // A different dashboard account has its own Meta settings and token.
  $('account').addEventListener('change', forgetSession);
})();
