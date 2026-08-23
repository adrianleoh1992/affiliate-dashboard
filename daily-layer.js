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
  let STORE = null, ACCT = null, AD_ACCT = null, PLAN = null;
  const DCHARTS = {};

  /* app.js declares these as top-level `function`, which does land on window.
     Its state (`FILES`, `RESULT`) is declared with `let`, which does NOT, so a
     window lookup would be permanently undefined. The wrapped finish() below
     captures what this layer needs at the moment app.js has it. */
  const rp = window.rp, nf = n => Math.round(n || 0).toLocaleString('id-ID');
  const rx = window.rx, esc = window.Engine.escapeHtml;
  const toast = window.toast;
  let FILES_SNAP = [], OPTS_SNAP = {};

  /* ── Accounts ───────────────────────────────────────────────────────────── */
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

  async function refreshCoverage() {
    if (!ACCT) { $('covStrip').innerHTML = '<span class="chip empty">Belum ada akun dipilih</span>'; return; }
    const c = await STORE.coverage(ACCT.id);
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
    if (!ACCT || !FILES_SNAP.length) {
      $('ingestPlan').classList.add('hidden');
      return;
    }
    const plan = { acct: ACCT, items: [], total: { added: 0, updated: 0, dup: 0 } };
    for (const f of FILES_SNAP) {
      if (!['affiliate', 'ads', 'clicks'].includes(f.type)) continue;
      const rows = f.rowsData || [];
      if (!rows.length) continue;
      const fileHash = A.hashRows(rows);
      const seen = await STORE.seenFile(ACCT.id, fileHash);
      const known = await STORE.knownRowHashes(ACCT.id, f.type);
      const dedup = A.dedupe(rows, known);
      const agg = f.type === 'affiliate' ? A.aggregateAffiliate(dedup.kept)
        : f.type === 'ads' ? A.aggregateAds(dedup.kept)
        : A.aggregateClicks(dedup.kept);
      const keyFields = f.type === 'ads' ? ['date', 'ad_unit'] : ['date', 'tag'];
      const existing = await STORE.existingKeys(ACCT.id, f.type);
      const ing = A.planIngest(agg, existing, keyFields);
      plan.items.push({
        file: f.name, kind: f.type, fileHash, seenBefore: seen,
        sourceRows: rows.length, duplicates: dedup.duplicates,
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
              (!it.added && !it.updated) ? '<span class="plan-pill dup">tidak ada perubahan</span>' : '',
            ].join('');
        const per = it.period
          ? `<span class="plan-period">${it.days} hari · ${it.period.start} — ${it.period.end}</span>` : '';
        return `<div class="plan-row"><div class="plan-kind">${label[it.kind] || it.kind}</div>
          <div class="plan-nums">${pills}${per}</div></div>`;
      }).join('');
    }

    $('ingestPlan').querySelector('.ingest-head').classList.toggle('hidden', allSeen);
    const btn = $('btnSaveAll');
    // Stays clickable either way: a disabled button cannot dismiss the panel,
    // and "nothing to save" is a status, not an action.
    btn.disabled = false;
    btn.dataset.mode = writable ? 'save' : 'close';
    btn.textContent = writable
      ? `Simpan ${nf(PLAN.total.added)} baru · ${nf(PLAN.total.updated)} perbarui`
      : 'Tutup';
    btn.classList.toggle('primary', writable);
    btn.classList.toggle('ghost', !writable);
    $('btnSkipSave').classList.toggle('hidden', !writable);
    $('ingestPlan').classList.remove('hidden');
    $('savedNote').classList.add('hidden');
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
    if (!ACCT) return;
    const aff = await STORE.range(ACCT.id, 'affiliate', $('dsStart').value || null, $('dsEnd').value || null);
    const ads = await STORE.range(ACCT.id, 'ads', $('dsStart').value || null, $('dsEnd').value || null);
    const clk = await STORE.range(ACCT.id, 'clicks', $('dsStart').value || null, $('dsEnd').value || null);

    if (!aff.length) {
      $('storedNote').textContent = 'Belum ada data tersimpan';
      $('storedStrip').innerHTML = '';
      $('tblStored').querySelector('thead').innerHTML = '';
      $('tblStored').querySelector('tbody').innerHTML =
        '<tr><td style="text-align:center;color:var(--text-mute);padding:26px">Unggah CSV lalu tekan Simpan ke Riwayat.</td></tr>';
      return;
    }

    const byDay = new Map();
    const touch = d => {
      if (!byDay.has(d)) byDay.set(d, { date: d, comm: 0, pending: 0, orders: 0, gmv: 0,
        spend: 0, clicks: 0, impr: 0, shopeeClicks: 0 });
      return byDay.get(d);
    };
    aff.forEach(r => { const b = touch(r.date); b.comm += r.comm || 0; b.pending += r.comm_pending || 0;
      b.orders += r.orders || 0; b.gmv += r.gmv || 0; });
    ads.forEach(r => { const b = touch(r.date); b.spend += r.spend || 0; b.clicks += r.clicks || 0;
      b.impr += r.impressions || 0; });
    clk.forEach(r => { const b = touch(r.date); b.shopeeClicks += r.clicks || 0; });

    const days = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
    // Same two adjustments engine.js makes, or the tabs disagree: Meta reports
    // spend without VAT, and pending commission is discounted.
    const ppn = 1 + (OPTS_SNAP.ppn != null ? OPTS_SNAP.ppn : 11) / 100;
    const pf = OPTS_SNAP.pendingFactor != null ? OPTS_SNAP.pendingFactor : 0.95;
    days.forEach(d => {
      d.spendPpn = d.spend * ppn;
      d.commEff = (d.comm - d.pending) + d.pending * pf;
      d.net = d.commEff - d.spendPpn;
      d.roas = d.spendPpn > 0 ? d.commEff / d.spendPpn : 0;
      d.cpc = d.clicks > 0 ? d.spendPpn / d.clicks : 0;
      d.leak = d.clicks > 0 ? d.shopeeClicks / d.clicks * 100 : null;
    });

    const sum = f => days.reduce((s, d) => s + (d[f] || 0), 0);
    const totComm = sum('commEff'), totSpend = sum('spendPpn');
    $('storedNote').textContent = `${days.length} hari · ${days[0].date} — ${days[days.length - 1].date}`;
    if (!$('dsStart').value) { $('dsStart').value = days[0].date; $('dsEnd').value = days[days.length - 1].date; }

    const paidDays = days.filter(d => d.spendPpn > 0);
    $('storedStrip').innerHTML = [
      ['Hari Tersimpan', nf(days.length)],
      ['Komisi Total', rp(totComm)],
      ['Biaya Total', rp(totSpend)],
      ['Laba Total', rp(totComm - totSpend)],
      ['ROAS Rata', rx(totSpend > 0 ? totComm / totSpend : 0)],
      ['Hari ROAS < 1', nf(paidDays.filter(d => d.roas < 1).length) + ' / ' + nf(paidDays.length)],
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

    const cols = ['Tanggal', 'Komisi Efektif', 'Biaya+PPN', 'Laba', 'ROAS', 'Order', 'Klik Meta', 'Klik Shopee', '% Masuk', 'CPC'];
    $('tblStored').querySelector('thead').innerHTML = '<tr>' +
      cols.map((h, i) => `<th class="${i ? 'num' : ''}">${h}</th>`).join('') + '</tr>';
    $('tblStored').querySelector('tbody').innerHTML = days.slice().reverse().map(d => `<tr>
      <td><b>${d.date}</b></td><td class="num">${rp(d.commEff)}</td><td class="num">${rp(d.spendPpn)}</td>
      <td class="num ${d.net >= 0 ? 'pos' : 'neg'}">${rp(d.net)}</td>
      <td class="num">${d.spendPpn > 0 ? d.roas.toFixed(2) : '—'}</td>
      <td class="num">${nf(d.orders)}</td><td class="num">${nf(d.clicks)}</td>
      <td class="num">${d.shopeeClicks ? nf(d.shopeeClicks) : '—'}</td>
      <td class="num ${d.leak != null && d.leak < 70 ? 'neg' : ''}">${d.leak != null ? d.leak.toFixed(0) + '%' : '—'}</td>
      <td class="num">${d.clicks ? nf(d.cpc) : '—'}</td></tr>`).join('');
  }

  async function renderUploads() {
    if (!ACCT) return;
    const ups = await STORE.uploadHistory(ACCT.id, 80);
    const cols = ['Waktu', 'File', 'Jenis', 'Baris Sumber', 'Baru', 'Diperbarui', 'Duplikat', 'Periode'];
    $('tblUploads').querySelector('thead').innerHTML = '<tr>' +
      cols.map((h, i) => `<th class="${i > 2 && i < 7 ? 'num' : ''}">${h}</th>`).join('') + '</tr>';
    const label = { affiliate: 'Affiliate', ads: 'Iklan', clicks: 'Klik' };
    $('tblUploads').querySelector('tbody').innerHTML = ups.length ? ups.map(u => `<tr>
      <td>${new Date(u.uploaded_at).toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' })}</td>
      <td style="max-width:250px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(u.file_name)}">${esc(u.file_name)}</td>
      <td><span class="pill">${label[u.kind] || u.kind}</span></td>
      <td class="num">${nf(u.rows)}</td><td class="num pos">${nf(u.added)}</td>
      <td class="num">${nf(u.updated)}</td><td class="num">${u.duplicates ? nf(u.duplicates) : '—'}</td>
      <td>${u.period_start ? u.period_start + ' — ' + u.period_end : '—'}</td></tr>`).join('')
      : '<tr><td colspan="8" style="text-align:center;color:var(--text-mute);padding:26px">Belum ada unggahan tersimpan.</td></tr>';
  }

  /* ── Wire into the dashboard ────────────────────────────────────────────── */
  // app.js calls this once it has parsed and analysed the CSVs — the right
  // moment to compute the ingest plan, because rowsData is available then.
  window.onDashboardData = ({ files, result }) => {
    FILES_SNAP = files || [];
    OPTS_SNAP = (result && result.options) || {};
    buildPlan();
  };
  const origReset = window.reset;
  window.reset = function () {
    origReset.apply(this, arguments);
    PLAN = null; FILES_SNAP = [];
    $('ingestPlan').classList.add('hidden');
    $('savedNote').classList.add('hidden');
  };

  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
    // Charts need a real layout box, so render once the panel is visible.
    requestAnimationFrame(() => {
      if (t.dataset.tab === 'tersimpan') renderStored();
      else if (t.dataset.tab === 'unggahan') renderUploads();
    });
  }));

  $('btnSkipSave').onclick = () => {
    $('ingestPlan').classList.add('hidden');
    toast('Dilewati — tidak disimpan ke riwayat');
  };

  $('btnSaveAll').onclick = async () => {
    const btn = $('btnSaveAll');
    if (btn.dataset.mode === 'close') { $('ingestPlan').classList.add('hidden'); return; }
    if (!PLAN || !ACCT) return;
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
        + `. Buka tab <b>Data Tersimpan</b> untuk melihat trennya.`;
      $('savedNote').classList.remove('hidden');
      await refreshCoverage(); await renderStored(); await renderUploads(); await buildPlan();
      toast('Tersimpan: ' + nf(added) + ' baris baru');
    } catch (e) {
      toast('Gagal menyimpan: ' + e.message);
      btn.disabled = false; renderPlan();
    }
  };

  $('btnRange').onclick = () => renderStored();

  $('selShopee').onchange = async () => { await refreshAccounts($('selShopee').value); await buildPlan(); await renderStored(); await renderUploads(); };
  $('selAds').onchange = async () => {
    const ads = await STORE.listAccounts('ads');
    AD_ACCT = ads.find(a => String(a.id) === $('selAds').value) || null;
  };
  $('btnShopeeAdd').onclick = async () => {
    const n = prompt('Nama akun Shopee (mis. "BBA Utama")');
    if (!n || !n.trim()) return;
    try {
      const a = await STORE.ensureAccount('shopee', n.trim());
      await refreshAccounts(a.id); await buildPlan(); await renderStored(); await renderUploads();
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
      $('selAds').value = String(a.id); AD_ACCT = a;
      toast('Akun iklan dibuat: ' + a.name);
    } catch (e) { toast('Gagal: ' + e.message); }
  };
  $('btnExportAcct').onclick = async () => {
    if (!ACCT) return toast('Pilih akun dulu');
    const data = await STORE.exportAccount(ACCT.id);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url;
    a.download = `harian-${ACCT.name.replace(/\s+/g, '-')}-${new Date().toISOString().slice(0, 10)}.json`;
    a.click(); URL.revokeObjectURL(url);
    toast('Riwayat akun diekspor');
  };

  (async () => {
    try {
      STORE = await DailyStore.open();
      window.__dailyStore = STORE;
      await refreshAccounts();
      await renderUploads();
    } catch (e) {
      toast('Gagal membuka penyimpanan: ' + e.message);
    }
  })();
})();
