/* ── Daily layer ────────────────────────────────────────────────────────────
   Loads AFTER app.js and wraps it. The dashboard keeps every metric, tab, and
   chart it already has; this file only adds what the daily edition needs:

     - account context (Shopee + ads), because the CSVs carry no account identity
     - dedup + an approval step before anything is written
     - two extra tabs: stored daily history and the upload log

   Nothing in app.js, engine.js, or styles.css is modified. The dashboard's own
   finish() and reset() are wrapped, not replaced, so any future change there
   flows through here automatically instead of needing a second implementation.
*/
'use strict';
(() => {
  const A = window.DailyAgg;
  const $ = id => document.getElementById(id);
  let STORE = null, ACCT = null, PLAN = null;
  let ACCOUNT_REV = 0, PLAN_REV = 0, STORED_REV = 0, SAVING = false;
  let BACKUP_REV = 0, BACKUP = null, RESTORING = false;
  const DCHARTS = {};

  /* app.js declares these as top-level `function`, which does land on window.
     Its state (`FILES`, `RESULT`) is declared with `let`, which does NOT, so a
     window lookup would be permanently undefined. The wrapped finish() below
     captures what this layer needs at the moment app.js has it. */
  const rp = window.rp, nf = n => Math.round(n || 0).toLocaleString('id-ID');
  const rx = window.rx, esc = window.Engine.escapeHtml;
  const toast = window.toast;
  const run = fn => Promise.resolve().then(fn).catch(e => toast('Penyimpanan: ' + e.message));
  let FILES_SNAP = [];

  /* ── Accounts ───────────────────────────────────────────────────────────── */
  /* The main dashboard already owns one account selector in the header, and a
     second one here would be two doors to the same thing. So this follows that
     selector instead of owning its own: the chosen name becomes the IndexedDB
     account. The ads account stays a per-account label — the user runs one ads
     account per Shopee account today, but the schema keeps it separate so a
     second one later needs no migration. */
  function adsKey(name) { return 'adash_adsacct_' + name; }
  function shopeeName() { return (window.active && window.active()) || 'default'; }

  async function refreshAccounts() {
    if (!STORE) return;
    const revision = ++ACCOUNT_REV, name = shopeeName();
    const account = await STORE.ensureAccount('shopee', name);
    if (revision !== ACCOUNT_REV || name !== shopeeName()) return;
    const changed = !ACCT || ACCT.id !== account.id;
    // Preserve the account reference when only the optional ads label changes;
    // pending previews and ingestion plans are bound to this identity.
    if (changed) ACCT = account;
    if (changed) {
      PLAN = null; ++PLAN_REV; ++STORED_REV;
      cancelBackup();
      $('dsStart').value = ''; $('dsEnd').value = '';
      Object.values(DCHARTS).forEach(chart => chart.destroy());
      Object.keys(DCHARTS).forEach(key => delete DCHARTS[key]);
    }
    let adsName = '';
    try { adsName = localStorage.getItem(adsKey(name)) || ''; } catch (e) {}
    const f = $('adsAcctName'); if (f) f.value = adsName;
    const b = $('adsAcctNote');
    if (b) b.textContent = adsName ? `Spend dicap "${adsName}"` : 'Belum diberi nama — opsional';
    await refreshCoverage();
  }

  async function refreshCoverage() {
    if (!ACCT) { $('covStrip').innerHTML = '<span class="chip empty">Belum ada akun dipilih</span>'; return; }
    const account = ACCT;
    const c = await STORE.coverage(account.id);
    if (ACCT !== account || account.name !== shopeeName()) return;
    const label = { affiliate: 'Affiliate', ads: 'Iklan', clicks: 'Klik' };
    $('covStrip').innerHTML = Object.keys(label).map(k => {
      const v = c[k];
      return v.rows
        ? `<span class="chip"><b>${label[k]}</b> · ${v.days} hari · ${v.start} — ${v.end}</span>`
        : `<span class="chip empty">${label[k]}: belum ada data</span>`;
    }).join('');
  }

  /* ── Ingest plan: computed after the dashboard has parsed the files ─────── */
  async function buildPlan() {
    const revision = ++PLAN_REV, account = ACCT, files = FILES_SNAP.slice();
    PLAN = null;
    $('ingestPlan').classList.add('hidden');
    if (!STORE || !account || account.name !== shopeeName() || !files.length) return;
    const plan = { acct: account, items: [], total: { added: 0, updated: 0, dup: 0 } };
    const cache = new Map(), batchFiles = new Map();
    for (const f of files) {
      if (!['affiliate', 'ads', 'clicks'].includes(f.type)) continue;
      const rows = f.rowsData || [];
      if (!rows.length) continue;
      if (!cache.has(f.type)) {
        const [known, existing] = await Promise.all([
          STORE.knownRowHashes(account.id, f.type), STORE.existingKeys(account.id, f.type),
        ]);
        cache.set(f.type, { known, existing, dates: new Set([...existing].map(key => key.slice(0, 10))) });
      }
      const { known, existing, dates } = cache.get(f.type);
      const fileHash = A.hashRows(rows), batchKey = f.type + '|' + fileHash;
      const seen = batchFiles.get(batchKey) || await STORE.seenFile(account.id, fileHash, f.type);
      const valid = rows.filter(r => A.isDate(A.rowDate(r, f.type)));
      const dedup = A.dedupe(valid, known);
      const records = A.aggregate(f.type, dedup.kept);
      const keyFields = f.type === 'ads' ? ['date', 'ad_key'] : ['date', 'tag'];
      const ing = A.planIngest(records, existing, keyFields);
      plan.items.push({
        file: f.name, kind: f.type, fileHash, seenBefore: seen,
        sourceState: f.partial || (window.analysisData && window.analysisData().sourceState[f.type] === 'partial') ? 'partial' : 'loaded',
        sourceRows: rows.length, duplicates: dedup.duplicates, invalid: rows.length - valid.length,
        overlapsDate: records.some(record => dates.has(record.date)),
        rawRows: rows, records, added: ing.newCount, updated: ing.updateCount,
        period: valid.length ? { start: valid.map(r => A.rowDate(r, f.type)).sort()[0], end: valid.map(r => A.rowDate(r, f.type)).sort().pop() } : null, days: new Set(valid.map(r => A.rowDate(r, f.type))).size,
      });
      if (!seen) {
        records.forEach(r => existing.add(keyFields.map(key => r[key]).join('|')));
        records.forEach(r => dates.add(r.date));
        batchFiles.set(batchKey, { uploaded_at: new Date().toISOString() });
        plan.total.added += ing.newCount;
        plan.total.updated += ing.updateCount;
        plan.total.dup += dedup.duplicates;
      }
    }
    if (revision !== PLAN_REV || ACCT !== account || account.name !== shopeeName()) return;
    PLAN = plan;
    renderPlan();
  }

  function renderPlan() {
    if (!PLAN || !PLAN.items.length) { $('ingestPlan').classList.add('hidden'); return; }
    $('planAcct').textContent = PLAN.acct.name;
    const writable = PLAN.items.some(it => !it.seenBefore && (it.added || it.updated));
    const allSeen = PLAN.items.length && PLAN.items.every(it => it.seenBefore);

    if (allSeen) {
      // A no-op plan repeated three times is noise. Collapse it to one line.
      const when = new Date(PLAN.items[0].seenBefore.uploaded_at)
        .toLocaleDateString('id-ID', { day: '2-digit', month: '2-digit', year: 'numeric' });
      $('planRows').innerHTML = `<div class="plan-row single"><div class="plan-nums">
        <span class="plan-pill seen">Semua file sudah diunggah ${when} — tidak ada perubahan</span></div></div>`;
    } else {
      const label = { affiliate: 'Affiliate', ads: 'Iklan', clicks: 'Klik' };
      $('planRows').innerHTML = PLAN.items.map(it => {
        const pills = it.seenBefore
          ? `<span class="plan-pill seen">sudah diunggah ${new Date(it.seenBefore.uploaded_at)
              .toLocaleDateString('id-ID', { day: '2-digit', month: '2-digit', year: 'numeric' })} — dilewati</span>`
          : [
              it.added ? `<span class="plan-pill new">${nf(it.added)} baru</span>` : '',
              it.updated ? `<span class="plan-pill upd">${nf(it.updated)} diperbarui</span>` : '',
              it.duplicates ? `<span class="plan-pill dup">${nf(it.duplicates)} baris duplikat dilewati</span>` : '',
              it.invalid ? `<span class="plan-pill dup">${nf(it.invalid)} tanggal tidak valid dilewati</span>` : '',
              (!it.added && !it.updated) ? '<span class="plan-pill dup">tidak ada perubahan</span>' : '',
            ].join('');
        const per = it.period
          ? `<span class="plan-period">${it.days} hari · ${it.period.start} — ${it.period.end}</span>` : '';
        return `<div class="plan-row"><div class="plan-kind">${label[it.kind] || it.kind}</div>
          <div class="plan-nums">${pills}${per}</div></div>`;
      }).join('');
    }
    if (PLAN.items.some(it => !it.seenBefore && it.overlapsDate)) {
      $('planRows').insertAdjacentHTML('afterbegin', '<p class="hint"><b>Periode bertumpuk:</b> penyimpanan hanya mengenali duplikat dengan isi baris yang sama. Jika status, komisi, atau angka laporan lama berubah, gunakan Ganti periode lengkap di bawah. Muat hanya versi laporan yang benar untuk periode tersebut. Menambahkan laporan revisi langsung dapat menghitung ulang transaksi lama.</p>');
    }

    $('ingestPlan').querySelector('.ingest-head').classList.toggle('hidden', allSeen);
    const btn = $('btnSaveAll');
    // Stays clickable either way: a disabled button cannot dismiss the panel,
    // and "nothing to save" is a status, not an action.
    btn.disabled = SAVING;
    btn.dataset.mode = writable ? 'save' : 'close';
    btn.textContent = writable
      ? `Simpan ${nf(PLAN.total.added)} baru · ${nf(PLAN.total.updated)} perbarui`
      : 'Tutup';
    btn.classList.toggle('primary', writable);
    btn.classList.toggle('ghost', !writable);
    $('btnSkipSave').classList.toggle('hidden', !writable);
    $('ingestPlan').classList.remove('hidden');
    $('savedNote').classList.add('hidden');
    renderReplacement();
  }

  function renderReplacement() {
    let host = $('replacementControls');
    if (!host) {
      host = document.createElement('div'); host.id = 'replacementControls';
      $('planRows').after(host);
    }
    PLAN.replacement = null;
    const kinds = [...new Set(PLAN.items.map(item => item.kind))];
    const labels = { affiliate: 'Komisi affiliate', ads: 'Meta Ads', clicks: 'Klik Shopee' };
    host.innerHTML = `<label><input type="checkbox" id="replaceMode"> Ganti periode lengkap</label>
      <div id="replacementFields" class="hidden"><p class="hint">Pilih jenis laporan dan isi rentang lengkap yang akan diganti. Semua data lama dalam rentang ini, termasuk tag atau tanggal yang tidak ada di laporan baru, akan dihapus. Muat hanya versi laporan yang benar. Data di luar rentang tidak berubah.</p>
      ${kinds.map(kind => `<div class="plan-row"><label><input type="checkbox" data-replace-kind="${kind}"> ${labels[kind]}</label>
        <label>Dari <input type="date" id="replaceStart-${kind}" aria-label="Awal penggantian ${labels[kind]}"></label>
        <label>Sampai <input type="date" id="replaceEnd-${kind}" aria-label="Akhir penggantian ${labels[kind]}"></label></div>`).join('')}
      <button type="button" class="btn" id="btnPreviewReplace">Tinjau penggantian</button>
      <div id="replacementPreview" class="hidden" aria-live="polite"><div id="replacementSummary"></div>
      <label><input type="checkbox" id="replaceIntent"> Saya memastikan laporan yang dimuat lengkap untuk seluruh rentang dan siap mengganti data lama.</label></div></div>`;
    let previewRevision = 0;
    const normal = { disabled: $('btnSaveAll').disabled, mode: $('btnSaveAll').dataset.mode, text: $('btnSaveAll').textContent };
    const invalidate = () => {
      if (!PLAN) return;
      ++previewRevision;
      PLAN.replacement = null;
      $('replacementPreview').classList.add('hidden'); $('replaceIntent').checked = false;
      const mode = $('replaceMode').checked;
      $('replacementFields').classList.toggle('hidden', !mode);
      $('btnSaveAll').disabled = mode || normal.disabled;
      $('btnSaveAll').dataset.mode = mode ? 'replace' : normal.mode;
      $('btnSaveAll').textContent = mode ? 'Ganti periode lengkap' : normal.text;
    };
    host.querySelectorAll('input:not(#replaceIntent)').forEach(input => input.addEventListener(input.type === 'date' ? 'input' : 'change', invalidate));
    $('replaceIntent').onchange = () => { $('btnSaveAll').disabled = !PLAN || !PLAN.replacement || !$('replaceIntent').checked || SAVING; };
    $('btnPreviewReplace').onclick = () => run(async () => {
      const plan = PLAN, account = ACCT, revision = PLAN_REV, preview = ++previewRevision;
      if (!plan || plan.acct !== account || account.name !== shopeeName()) return;
      const ranges = kinds.filter(kind => host.querySelector(`[data-replace-kind="${kind}"]`).checked)
        .map(kind => ({ kind, start: $('replaceStart-' + kind).value, end: $('replaceEnd-' + kind).value }));
      if (!ranges.length) throw new Error('Pilih jenis laporan yang akan diganti');
      if (ranges.some(range => !A.isDate(range.start) || !A.isDate(range.end) || range.start > range.end))
        throw new Error('Isi tanggal awal dan akhir penggantian yang valid');
      if (plan.items.some(item => ranges.some(range => range.kind === item.kind) && item.sourceState === 'partial'))
        throw new Error('Laporan parsial tidak dapat mengganti periode lengkap; perbaiki baris sumber terlebih dahulu');
      const lines = [];
      for (const range of ranges) {
        const old = await STORE.range(account.id, range.kind, range.start, range.end);
        const rows = plan.items.filter(item => item.kind === range.kind).flatMap(item => item.rawRows)
          .filter(row => { const date = A.rowDate(row, range.kind); return date >= range.start && date <= range.end; });
        const incoming = A.aggregate(range.kind, A.dedupe(rows).kept);
        const total = records => range.kind === 'affiliate' ? rp(records.reduce((sum, row) => sum + row.comm, 0))
          : range.kind === 'ads' ? rp(records.reduce((sum, row) => sum + row.spend, 0))
          : nf(records.reduce((sum, row) => sum + row.clicks, 0)) + ' klik';
        lines.push(`${labels[range.kind]} · ${range.start} — ${range.end}: ${old.length} agregat / ${total(old)} → ${incoming.length} agregat / ${total(incoming)}`);
      }
      if (PLAN !== plan || ACCT !== account || revision !== PLAN_REV || preview !== previewRevision || account.name !== shopeeName()) return;
      plan.replacement = { ranges, lines };
      $('replacementSummary').innerHTML = `<p><b>Akun ${esc(account.name)}</b></p>` + lines.map(line => `<p>${esc(line)}</p>`).join('')
        + '<p class="hint">Hanya jenis dan rentang yang dipilih diganti. Jenis lain dalam unggahan ini tidak disimpan melalui tindakan ini.</p>';
      $('replaceIntent').checked = false;
      $('replacementPreview').classList.remove('hidden');
      $('btnSaveAll').disabled = true;
    });
  }

  /* ── Stored history ─────────────────────────────────────────────────────── */
  function cv(v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }
  function mk(id, cfg) {
    const el = $(id); if (!el) return;
    if (!el.offsetParent && !(el.offsetWidth && el.offsetHeight)) return;
    if (DCHARTS[id]) DCHARTS[id].destroy();
    const grid = cv('--border'), text = cv('--text-dim');
    cfg.options = Object.assign({
      responsive: true, maintainAspectRatio: false,
      datasets: { bar: { maxBarThickness: 44 } },
      plugins: { legend: { labels: { color: text, font: { family: 'Plus Jakarta Sans', size: 11 } } } },
      scales: { x: { grid: { color: grid }, ticks: { color: text, font: { size: 10 } } },
                y: { grid: { color: grid }, ticks: { color: text, font: { size: 10 } } } },
    }, cfg.options || {});
    DCHARTS[id] = new Chart(el, cfg);
  }

  async function renderStored() {
    const revision = ++STORED_REV, account = ACCT;
    if (!STORE || !account || account.name !== shopeeName()) return;
    const start = $('dsStart').value || null, end = $('dsEnd').value || null;
    if (start && end && start > end) { toast('Tanggal mulai harus sebelum tanggal akhir'); return; }
    const [aff, ads, clk, uploads] = await Promise.all([...['affiliate', 'ads', 'clicks'].map(kind => STORE.range(account.id, kind, start, end)), STORE.uploadHistory(account.id)]);
    if (revision !== STORED_REV || ACCT !== account || account.name !== shopeeName()) return;
    if (!aff.length && !ads.length && !clk.length) {
      Object.values(DCHARTS).forEach(chart => chart.destroy());
      Object.keys(DCHARTS).forEach(key => delete DCHARTS[key]);
      $('storedNote').textContent = start || end ? 'Tidak ada data pada rentang ini' : 'Belum ada data tersimpan';
      $('storedStrip').innerHTML = '';
      $('tblStored').querySelector('thead').innerHTML = '';
      $('tblStored').querySelector('tbody').innerHTML =
        '<tr><td style="text-align:center;color:var(--text-mute);padding:26px">Unggah CSV lalu tekan Simpan ke Riwayat.</td></tr>';
      return;
    }

    const byDay = new Map();
    const touch = d => {
      if (!byDay.has(d)) byDay.set(d, { date: d, comm: 0, pending: 0, orders: 0, gmv: 0,
        spend: 0, clicks: 0, impr: 0, shopeeClicks: 0, orderKeys: new Set() });
      return byDay.get(d);
    };
    aff.forEach(r => { const b = touch(r.date); b.comm += r.comm || 0; b.pending += r.comm_pending || 0;
      if (Array.isArray(r.order_keys)) r.order_keys.forEach(key => b.orderKeys.add(key));
      else b.orders += r.orders || 0;
      b.gmv += r.gmv || 0; });
    ads.forEach(r => { const b = touch(r.date); b.spend += r.spend || 0; b.clicks += r.clicks || 0;
      b.impr += r.impressions || 0; });
    clk.forEach(r => { const b = touch(r.date); b.shopeeClicks += r.clicks || 0; });

    const adsDates = new Set(ads.map(row => row.date));
    const days = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
    // Same two adjustments engine.js makes, or the tabs disagree: Meta reports
    // spend without VAT, and pending commission is discounted.
    const options = window.Engine.normalizeOptions(window.opts ? window.opts() : {});
    const ppn = 1 + options.ppn / 100;
    const pf = options.pendingFactor;
    days.forEach(d => {
      d.orders += d.orderKeys.size;
      const context = window.dashboardSourceCoverage ? window.dashboardSourceCoverage(account.name, d.date, d.date) : {};
      const declaredNone = context.sourceState && context.sourceState.ads === 'none';
      const partial = ads.some(row => row.date === d.date && row.source_partial) || uploads.some(upload => upload.kind === 'ads' && upload.source_state === 'partial' && (!upload.period_start || !upload.period_end || (upload.period_start <= d.date && upload.period_end >= d.date)));
      const complete = ads.length > 0 && !declaredNone && context.coverage && context.coverage.ads && context.coverage.ads.confirmed;
      d.costsKnown = !partial && (adsDates.has(d.date) || complete || (!!declaredNone && !ads.length));
      d.spendPpn = d.costsKnown ? d.spend * ppn : null;
      d.commEff = (d.comm - d.pending) + d.pending * pf;
      d.net = d.costsKnown ? d.commEff - d.spendPpn : null;
      d.roas = d.costsKnown ? (d.spendPpn > 0 ? d.commEff / d.spendPpn : 0) : null;
      d.cpc = d.costsKnown ? (d.clicks > 0 ? d.spendPpn / d.clicks : 0) : null;
      d.leak = d.clicks > 0 ? d.shopeeClicks / d.clicks * 100 : null;
    });

    const sum = f => days.reduce((s, d) => s + (d[f] || 0), 0);
    const rangeStart = start || days[0].date, rangeEnd = end || days[days.length - 1].date;
    const expectedDays = Math.round((Date.parse(rangeEnd + 'T00:00:00Z') - Date.parse(rangeStart + 'T00:00:00Z')) / 86400000) + 1;
    const wholeRange = window.dashboardSourceCoverage ? window.dashboardSourceCoverage(account.name, rangeStart, rangeEnd) : {};
    const rangeHasNoMeta = !ads.length && wholeRange.sourceState && wholeRange.sourceState.ads === 'none';
    const confirmedMeta = ads.length > 0 && !(wholeRange.sourceState && wholeRange.sourceState.ads === 'none') && wholeRange.coverage && wholeRange.coverage.ads && wholeRange.coverage.ads.confirmed;
    const partialRange = ads.some(row => row.source_partial) || uploads.some(upload => upload.kind === 'ads' && upload.source_state === 'partial' && (!upload.period_start || !upload.period_end || (upload.period_start <= rangeEnd && upload.period_end >= rangeStart)));
    const costsKnown = !partialRange && days.every(day => day.costsKnown) && (rangeHasNoMeta || confirmedMeta || adsDates.size === expectedDays);
    const money = value => value == null ? '—' : rp(value);
    const totComm = sum('commEff'), totSpend = costsKnown ? sum('spendPpn') : null;
    $('storedNote').textContent = `${days.length} hari · ${days[0].date} — ${days[days.length - 1].date} · Ringkasan agregat; tidak memuat transaksi, produk, atau cohort klik untuk rekomendasi.` + (costsKnown ? (rangeHasNoMeta ? ' Biaya nol mengikuti pernyataan tanpa Meta untuk periode ini.' : confirmedMeta ? ' Biaya mengikuti data Meta dan konfirmasi kelengkapan periode.' : ' Biaya mengikuti data Meta yang teramati; kelengkapan laporan sumber tidak diverifikasi.') : partialRange ? ' Biaya dan laba belum tersedia lengkap: laporan Meta tersimpan masih parsial.' : ' Biaya dan laba belum tersedia lengkap: tanggal tanpa data Meta bukan biaya nol.');
    // Empty range inputs mean all history, including later uploads.

    const paidDays = days.filter(d => d.spendPpn > 0);
    $('storedStrip').innerHTML = [
      ['Hari Tersimpan', nf(days.length)],
      ['Komisi Total', rp(totComm)],
      ['Biaya Total', money(totSpend)],
      ['Laba Total', money(costsKnown ? totComm - totSpend : null)],
      ['ROAS Rata', costsKnown ? rx(totSpend > 0 ? totComm / totSpend : 0) : '—'],
      ['Hari ROAS < 1', costsKnown ? nf(paidDays.filter(d => d.roas < 1).length) + ' / ' + nf(paidDays.length) : '—'],
    ].map(x => `<div class="s"><div class="l">${x[0]}</div><div class="v">${x[1]}</div></div>`).join('');

    const lbl = days.map(d => d.date.slice(5));
    mk('chStored', { type: 'line', data: { labels: lbl, datasets: [
      { label: 'Komisi Efektif', data: days.map(d => d.commEff), borderColor: cv('--ok'),
        backgroundColor: cv('--ok') + '22', fill: true, tension: .3, pointRadius: 2 },
      { label: 'Biaya + PPN', data: days.map(d => d.spendPpn), borderColor: cv('--accent'),
        backgroundColor: cv('--accent') + '18', fill: true, tension: .3, pointRadius: 2 },
    ]}});
    mk('chStoredRoas', { type: 'bar', data: { labels: lbl, datasets: [
      { label: 'ROAS', data: days.map(d => d.roas),
        backgroundColor: days.map(d => d.roas >= 2 ? cv('--ok') : d.roas >= 1 ? cv('--warn') : cv('--bad')) },
    ]}, options: { scales: { y: { beginAtZero: true } } } });
    mk('chStoredClk', { type: 'line', data: { labels: lbl, datasets: [
      { label: 'Klik Meta', data: days.map(d => d.clicks), borderColor: cv('--info'), tension: .3, pointRadius: 2 },
      { label: 'Klik Shopee', data: days.map(d => d.shopeeClicks), borderColor: cv('--warn'), tension: .3, pointRadius: 2 },
    ]}});

    const cols = ['Tanggal', 'Komisi Efektif', 'Biaya+PPN', 'Laba', 'ROAS', 'Order', 'Klik Meta', 'Klik Shopee', 'Rasio klik Shopee/Meta', 'CPC'];
    $('tblStored').querySelector('thead').innerHTML = '<tr>' +
      cols.map((h, i) => `<th class="${i ? 'num' : ''}">${h}</th>`).join('') + '</tr>';
    $('tblStored').querySelector('tbody').innerHTML = days.slice().reverse().map(d => `<tr>
      <td><b>${d.date}</b></td><td class="num">${rp(d.commEff)}</td><td class="num">${money(d.spendPpn)}</td>
      <td class="num ${d.net == null ? '' : d.net >= 0 ? 'pos' : 'neg'}">${money(d.net)}</td>
      <td class="num">${d.spendPpn > 0 ? d.roas.toFixed(2) : '—'}</td>
      <td class="num">${nf(d.orders)}</td><td class="num">${nf(d.clicks)}</td>
      <td class="num">${d.shopeeClicks ? nf(d.shopeeClicks) : '—'}</td>
      <td class="num ">${d.leak != null ? d.leak.toFixed(0) + '%' : '—'}</td>
      <td class="num">${d.cpc != null && d.clicks ? nf(d.cpc) : '—'}</td></tr>`).join('');
  }

  async function renderUploads() {
    if (!ACCT) return;
    const account = ACCT;
    const ups = await STORE.uploadHistory(account.id, 80);
    if (ACCT !== account || account.name !== shopeeName()) return;
    const cols = ['Waktu', 'File', 'Jenis', 'Baris Sumber', 'Baru', 'Diperbarui', 'Duplikat', 'Periode'];
    $('tblUploads').querySelector('thead').innerHTML = '<tr>' +
      cols.map((h, i) => `<th class="${i > 2 && i < 7 ? 'num' : ''}">${h}</th>`).join('') + '</tr>';
    const label = { affiliate: 'Affiliate', ads: 'Iklan', clicks: 'Klik' };
    $('tblUploads').querySelector('tbody').innerHTML = ups.length ? ups.map(u => `<tr>
      <td>${new Date(u.uploaded_at).toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' })}</td>
      <td style="max-width:250px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(u.file_name)}">${esc(u.file_name)}</td>
      <td><span class="pill">${esc(label[u.kind] || u.kind)}</span></td>
      <td class="num">${nf(u.rows)}</td><td class="num pos">${nf(u.added)}</td>
      <td class="num">${nf(u.updated)}</td><td class="num">${u.duplicates ? nf(u.duplicates) : '—'}</td>
      <td>${u.period_start ? esc(u.period_start) + ' — ' + esc(u.period_end) : '—'}</td></tr>`).join('')
      : '<tr><td colspan="8" style="text-align:center;color:var(--text-mute);padding:26px">Belum ada unggahan tersimpan.</td></tr>';
  }

  /* One row per date, one column per report. Three separate tables made you
     compare three date lists by eye; side by side on one row, a missing cell
     is the thing you notice first. */
  const KIND=[['affiliate','Laporan Komisi'],['ads','Meta Ads'],['clicks','Laporan Klik']];
  async function renderDayIndex(){
    const tb=$('tblDayIdx');
    if(!ACCT){tb.querySelector('tbody').innerHTML='';$('dayIdxNote').textContent='';return}
    const account=ACCT, idx={};
    await Promise.all(KIND.map(async ([k])=>{idx[k]=await STORE.dailyIndex(account.id,k)}));
    if(ACCT!==account || account.name!==shopeeName())return;
    const map={};
    KIND.forEach(([k])=>{map[k]={};idx[k].forEach(r=>map[k][r.date]=r)});
    const all=new Set(); KIND.forEach(([k])=>idx[k].forEach(r=>all.add(r.date)));
    const days=[...all].sort().reverse();

    tb.querySelector('thead').innerHTML='<tr><th>Tanggal</th>'+
      KIND.map(([,l])=>`<th class="num">${l}</th>`).join('')+'<th class="num">Status</th></tr>';

    if(!days.length){
      tb.querySelector('tbody').innerHTML='<tr><td colspan="5" class="tbl-empty">Belum ada data tersimpan untuk akun ini.</td></tr>';
      $('dayIdxNote').textContent='belum ada data tersimpan';
      return;
    }
    let full=0;
    tb.querySelector('tbody').innerHTML=days.map(d=>{
      const have=KIND.filter(([k])=>map[k][d]).length;
      if(have===KIND.length)full++;
      const cells=KIND.map(([k,l])=>{
        const r=map[k][d];
        return r
          ? `<td class="num"><span class="cellhas">${nf(r.rows)} baris
               <button class="cellx" data-del-day="${k}|${d}" title="Hapus ${l} ${d}" aria-label="Hapus ${l} ${d}">×</button></span></td>`
          : `<td class="num"><span class="cellno">belum ada</span></td>`;
      }).join('');
      return `<tr class="${have===KIND.length?'':'partial'}"><td><b>${d}</b></td>${cells}
        <td class="num">${have===KIND.length
          ? '<span class="pill ok-pill">Lengkap</span>'
          : `<span class="pill warn-pill">${KIND.length-have} kurang</span>`}</td></tr>`;
    }).join('');
    $('dayIdxNote').textContent=`${days.length} tanggal · ${full} lengkap · ${days.length-full} belum lengkap`;

    tb.querySelectorAll('[data-del-day]').forEach(b=>b.onclick=async()=>{
      const [k,d]=b.dataset.delDay.split('|');
      const label=KIND.find(x=>x[0]===k)[1];
      if(!confirm(`Hapus data ${label} tanggal ${d}?\n\nAngka di dashboard tidak berubah — yang dihapus hanya yang tersimpan. Unggah ulang filenya untuk mengembalikan.`))return;
      try{
        const n=await STORE.deleteDay(account.id,k,d);
        if(ACCT!==account)return;
        await refreshCoverage(); await renderDayIndex(); await renderStored(); await buildPlan();
        toast(`${nf(n)} baris ${label} ${d} dihapus`);
      }catch(e){toast('Gagal menghapus: '+e.message)}
    });
  }

  /* ── Wire into the dashboard ────────────────────────────────────────────── */
  // app.js calls this once it has parsed and analysed the CSVs — the right
  // moment to compute the ingest plan, because rowsData is available then.
  window.onDashboardData = ({ files }) => {
    FILES_SNAP = files || [];
    run(async () => { await buildPlan(); await renderStored(); });
  };
  const origReset = window.reset;
  window.reset = function () {
    origReset.apply(this, arguments);
    PLAN = null; FILES_SNAP = []; ++PLAN_REV; ++STORED_REV;
    cancelBackup();
    $('ingestPlan').classList.add('hidden');
    $('savedNote').classList.add('hidden');
  };

  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
    // Charts need a real layout box, so render once the panel is visible.
    requestAnimationFrame(() => {
      if (t.dataset.tab === 'tersimpan') run(renderStored);
      else if (t.dataset.tab === 'unggahan') run(renderUploads);
    });
  }));

  $('btnSkipSave').onclick = () => {
    $('ingestPlan').classList.add('hidden');
    toast('Dilewati — tidak disimpan ke riwayat');
  };

  $('btnSaveAll').onclick = async () => {
    const btn = $('btnSaveAll');
    if (btn.dataset.mode === 'close') { $('ingestPlan').classList.add('hidden'); return; }
    if (SAVING || RESTORING || !PLAN || !ACCT || PLAN.acct !== ACCT || PLAN.acct.name !== shopeeName()) return;
    const plan = PLAN, account = plan.acct;
    const replacement = btn.dataset.mode === 'replace' ? plan.replacement : null;
    if (btn.dataset.mode === 'replace' && (!replacement || !$('replaceIntent').checked)) return;
    if (replacement && !confirm(`Ganti data akun ${account.name}?\n\n${replacement.lines.join('\n')}\n\nData lama pada rentang terpilih akan diganti seluruhnya.`)) return;
    SAVING = true;
    btn.disabled = true; btn.textContent = 'Menyimpan...';
    let added = 0, updated = 0, skipped = 0, committed = false;
    try {
      const items = (replacement ? plan.items.filter(item => replacement.ranges.some(range => range.kind === item.kind)) : plan.items)
        .map(item => ({ ...item, fileName: item.file }));
      const result = await STORE.saveBatch(account.id, items, { replacementRanges: replacement ? replacement.ranges : [] });
      committed = true;
      added = result.added; updated = result.updated; skipped = result.skipped;
      if (ACCT !== account || account.name !== shopeeName()) return;
      await refreshCoverage(); await renderStored(); await renderUploads(); await renderDayIndex(); await buildPlan();
      $('ingestPlan').classList.add('hidden');
      $('savedNote').innerHTML = `<b>Tersimpan ke ${esc(account.name)}</b> — ${nf(added)} baris baru, ${nf(updated)} diperbarui`
        + (skipped ? `, ${skipped} file dilewati karena sudah pernah diunggah` : '')
        + `. Buka tab <b>Data Tersimpan</b> untuk melihat trennya.`;
      $('savedNote').classList.remove('hidden');
      toast('Tersimpan: ' + nf(added) + ' baris baru');
    } catch (e) {
      toast((committed ? 'Data tersimpan, tetapi tampilan gagal diperbarui: ' : 'Gagal menyimpan; seluruh riwayat sebelumnya tetap utuh: ') + e.message);
      if (ACCT === account && account.name === shopeeName()) await run(buildPlan);
    } finally {
      SAVING = false;
      btn.disabled = false;
    }
  };

  $('btnRange').onclick = () => run(renderStored);
  ['ppn', 'pendingFactor'].forEach(id => $(id).addEventListener('change', () => run(renderStored)));

  // app.js assigns .onchange directly; addEventListener stacks after it, so its
  // reset() runs first and this re-syncs against the account it switched to.
  $('account').addEventListener('change', () => run(async () => {
    await refreshAccounts(); await buildPlan(); await renderStored(); await renderUploads(); await renderDayIndex();
  }));
  $('btnNewAcct').addEventListener('click', () => {
    setTimeout(() => run(async () => {
      await refreshAccounts(); await buildPlan(); await renderStored(); await renderUploads(); await renderDayIndex();
    }), 0);
  });
  const adsField = $('adsAcctName');
  if (adsField) adsField.addEventListener('change', () => run(async () => {
    const v = adsField.value.trim();
    try { v ? localStorage.setItem(adsKey(shopeeName()), v) : localStorage.removeItem(adsKey(shopeeName())); } catch (e) {}
    await refreshAccounts();
    toast(v ? 'Akun iklan: ' + v : 'Nama akun iklan dikosongkan');
  }));
  $('btnExportAcct').onclick = () => run(async () => {
    if (!STORE || !ACCT || ACCT.name !== shopeeName()) return toast('Pilih akun dulu');
    const account = ACCT, revision = BACKUP_REV;
    const parameters = window.Engine.normalizeOptions(window.opts ? window.opts() : {});
    const data = await STORE.exportAccount(account.id, parameters);
    if (ACCT !== account || account.name !== shopeeName() || revision !== BACKUP_REV) return;
    // Refuse to advertise a backup that the same app cannot restore.
    const blob = new Blob([DailyStore.serializeBackup(data)], { type: 'application/json' });
    window.downloadBlob(blob, `harian-${account.name.replace(/[^\p{L}\p{N}_-]+/gu, '-')}-${new Date().toISOString().slice(0, 10)}.json`);
    toast('Cadangan lengkap akun diunduh');
  });

  function cancelBackup() {
    ++BACKUP_REV;
    BACKUP = null;
    if ($('backupPreview')) $('backupPreview').classList.add('hidden');
    if ($('backupPreviewSummary')) $('backupPreviewSummary').textContent = '';
    if ($('importAcctFile')) $('importAcctFile').value = '';
  }
  if ($('btnImportAcct')) $('btnImportAcct').onclick = () => {
    if (!STORE || !ACCT || ACCT.name !== shopeeName()) return toast('Penyimpanan akun belum siap');
    if (RESTORING || SAVING) return toast('Tunggu penyimpanan selesai');
    cancelBackup();
    $('importAcctFile').click();
  };
  if ($('btnCancelRestore')) $('btnCancelRestore').onclick = cancelBackup;
  if ($('importAcctFile')) $('importAcctFile').onchange = async event => {
    const file = event.target.files[0];
    cancelBackup();
    if (!file) return;
    const account = ACCT, revision = BACKUP_REV;
    const current = () => revision === BACKUP_REV && ACCT === account && account && account.name === shopeeName();
    try {
      if (!STORE || !account || RESTORING || SAVING) throw new Error('Tunggu penyimpanan akun siap');
      if (!/\.json$/i.test(file.name)) throw new Error('Pilih berkas cadangan .json');
      if (file.size > DailyStore.MAX_BACKUP_BYTES) throw new Error('Ukuran cadangan maksimal 50 MiB');
      const text = await file.text();
      if (!current()) return;
      let parsed;
      try { parsed = JSON.parse(text); } catch (_) { throw new Error('Isi berkas bukan JSON yang valid'); }
      const validated = DailyStore.validateBackup(parsed);
      const coverage = await STORE.coverage(account.id);
      if (!current()) return;
      BACKUP = { account, revision, ...validated };
      const s = validated.summary;
      const existing = Object.values(coverage).reduce((sum, value) => sum + value.rows, 0);
      $('backupPreviewSummary').textContent = `Cadangan dari akun “${s.source}” akan dipulihkan ke akun aktif “${account.name}”. `
        + `${nf(s.days)} tanggal${s.start ? ` (${s.start} — ${s.end})` : ''}; ${nf(s.counts.affiliate)} agregat komisi, `
        + `${nf(s.counts.ads)} agregat iklan, ${nf(s.counts.clicks)} agregat klik, ${nf(s.counts.uploads)} unggahan. `
        + `Seluruh ${nf(existing)} agregat harian, fingerprint, dan riwayat unggahan akun ini akan diganti. `
        + 'Akun lain tetap aman. Parameter dalam cadangan hanya referensi; pengaturan analisis saat ini tetap digunakan. '
        + 'Unduh cadangan akun ini terlebih dahulu jika riwayat lama masih diperlukan.';
      $('backupPreview').classList.remove('hidden');
      $('btnRestoreAcct').focus();
    } catch (error) {
      if (current()) toast('Gagal membaca cadangan: ' + error.message);
    }
  };
  if ($('btnRestoreAcct')) $('btnRestoreAcct').onclick = async () => {
    const backup = BACKUP;
    if (RESTORING || SAVING || !backup || backup.account !== ACCT ||
        backup.revision !== BACKUP_REV || backup.account.name !== shopeeName()) return;
    const button = $('btnRestoreAcct'), oldText = button.textContent;
    RESTORING = true;
    let committed = false;
    button.disabled = true;
    button.textContent = 'Memulihkan...';
    try {
      await STORE.importAccount(backup.account.id, backup.data, { replace: true });
      committed = true;
      if (ACCT !== backup.account || backup.account.name !== shopeeName()) return;
      cancelBackup();
      ++STORED_REV; ++PLAN_REV;
      await refreshCoverage(); await renderStored(); await renderUploads(); await renderDayIndex(); await buildPlan();
      toast('Cadangan dipulihkan ke ' + backup.account.name);
    } catch (error) {
      toast((committed ? 'Cadangan tersimpan, tetapi tampilan gagal diperbarui: ' :
        'Pemulihan gagal; riwayat sebelumnya tetap utuh: ') + error.message);
    } finally {
      RESTORING = false;
      button.disabled = false;
      button.textContent = oldText;
    }
  };

  (async () => {
    try {
      STORE = await DailyStore.open();
      window.__dailyStore = STORE;
      await refreshAccounts();
      await buildPlan();
      await renderStored();
      await renderUploads();
      await renderDayIndex();
    } catch (e) {
      toast('Gagal membuka penyimpanan: ' + e.message);
    }
  })();
})();
