/* ── Daily edition part 2: analysis, stored-history trend, upload log ─────── */
'use strict';

/* Analyse whatever was just uploaded, using the same engine as the dashboard so
   the numbers on screen and the numbers in storage cannot disagree. */
function runAnalysis() {
  const get = k => {
    const hits = PARSED.filter(p => p.kind === k);
    return hits.length ? hits.reduce((a, p) => a.concat(p.rows), []) : [];
  };
  const affiliate = get('affiliate');
  if (!affiliate.length) { $('main').classList.add('hidden'); return; }
  RESULT = E.analyze({ affiliate, ads: get('ads'), clicks: get('clicks'), tagMap: {} }, { ppn: 11 });
  $('main').classList.remove('hidden');
  renderKpi(); renderSynth(); renderMain(); renderDailyChart();
  renderStored(); renderUploads();
}

function renderKpi() {
  const k = RESULT.kpi;
  const arr = [
    ['Laba Bersih', rp(k.netEff), k.netEff >= 0 ? 'setelah biaya iklan' : 'rugi', k.netEff >= 0 ? 'good' : 'bad', 1],
    ['ROAS Berbayar', rx(k.paidRoas), 'tanpa komisi organik', k.paidRoas >= 1 ? 'good' : 'bad', 1],
    ['ROAS Gabungan', rx(k.roasEff), 'termasuk organik', '', 0],
    ['Komisi Efektif', rp(k.commEff), 'tertunda 95%', '', 0],
    ['Biaya Iklan', rp(k.spend), 'termasuk PPN', '', 0],
    ['Pesanan', nf(k.orders), nf(k.qty) + ' produk', '', 0],
  ];
  $('kpis').innerHTML = arr.map(x =>
    `<div class="kpi ${x[3]}${x[4] ? ' lead' : ''}"><div class="lbl">${x[0]}</div>
     <div class="val">${x[1]}</div><div class="sub">${x[2]}</div></div>`).join('');
}

function renderSynth() {
  const k = RESULT.kpi, st = k.counts.stop || 0;
  $('synth').innerHTML = k.spend
    ? `Periode ${RESULT.range.start} — ${RESULT.range.end}. Laba ${rp(k.netEff)}, ditopang komisi organik <b>${rp(k.organicComm)}</b>. Iklan berbayar ROAS <b>${rx(k.paidRoas)}</b>${st ? ` — ${st} tag sebaiknya dihentikan.` : '.'}`
    : `Periode ${RESULT.range.start} — ${RESULT.range.end}. Belum ada data biaya iklan.`;
}

function renderMain() {
  const cols = ['Tag / Keputusan', 'Biaya', 'Komisi Efektif', 'Laba', 'ROAS', 'CPC', 'CPC Ideal', 'Order'];
  $('tblMain').querySelector('thead').innerHTML = '<tr>' +
    cols.map((h, i) => `<th class="${i ? 'num' : ''}${h === 'CPC Ideal' ? ' col-ideal' : ''}">${h}</th>`).join('') + '</tr>';
  const rows = RESULT.tags.slice().sort((a, b) => (b.spend > 0) - (a.spend > 0) || b.spend - a.spend);
  $('tblMain').querySelector('tbody').innerHTML = rows.map(t => `<tr>
    <td><div class="tagcell"><span class="nm">${esc(t.tag)} <span class="badge ${t.status}">${t.label}</span></span>
    <span class="rs">${esc(t.reason)}</span></div></td>
    <td class="num">${rp(t.spend)}</td><td class="num">${rp(t.commEff)}</td>
    <td class="num ${t.netEff >= 0 ? 'pos' : 'neg'}">${rp(t.netEff)}</td>
    <td class="num">${rx(t.roasEff)}</td>
    <td class="num">${t.clicks ? nf(t.cpc) : '—'}</td>
    <td class="num col-ideal"><b>${t.clicks ? nf(t.cpcIdeal) : '—'}</b></td>
    <td class="num">${nf(t.orders)}</td></tr>`).join('');
}

/* ── Charts ───────────────────────────────────────────────────────────────── */
function cv(v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }
function mk(id, cfg) {
  const el = $(id); if (!el) return;
  // A canvas in a hidden tab has no layout box and would render blank.
  if (!el.offsetParent && !(el.offsetWidth && el.offsetHeight)) return;
  if (CHARTS[id]) CHARTS[id].destroy();
  const grid = cv('--border'), text = cv('--text-dim');
  cfg.options = Object.assign({
    responsive: true, maintainAspectRatio: false,
    datasets: { bar: { maxBarThickness: 40 } },
    plugins: { legend: { labels: { color: text, font: { family: 'Plus Jakarta Sans', size: 11 } } } },
    scales: { x: { grid: { color: grid }, ticks: { color: text, font: { size: 10 } } },
              y: { grid: { color: grid }, ticks: { color: text, font: { size: 10 } } } },
  }, cfg.options || {});
  CHARTS[id] = new Chart(el, cfg);
}

function renderDailyChart() {
  const d = RESULT.daily, lbl = d.map(x => x.date.slice(5));
  $('dailyNote').textContent = d.length + ' hari dari file yang diunggah';
  mk('chDaily', { type: 'line', data: { labels: lbl, datasets: [
    { label: 'Komisi', data: d.map(x => x.comm), borderColor: cv('--ok'), backgroundColor: cv('--ok') + '22', fill: true, tension: .3, pointRadius: 2 },
    { label: 'Biaya', data: d.map(x => x.spend), borderColor: cv('--accent'), backgroundColor: cv('--accent') + '18', fill: true, tension: .3, pointRadius: 2 },
  ]}});
}

/* ── Stored history: the point of the whole exercise ──────────────────────── */
async function renderStored() {
  if (!ACCT) return;
  const start = $('dsStart').value || null, end = $('dsEnd').value || null;
  const aff = await STORE.range(ACCT.id, 'affiliate', start, end);
  const ads = await STORE.range(ACCT.id, 'ads', start, end);
  const clk = await STORE.range(ACCT.id, 'clicks', start, end);

  if (!aff.length) {
    $('storedNote').textContent = 'Belum ada data tersimpan untuk akun ini';
    $('storedStrip').innerHTML = '';
    $('tblStored').querySelector('thead').innerHTML = '';
    $('tblStored').querySelector('tbody').innerHTML =
      '<tr><td style="text-align:center;color:var(--text-mute);padding:24px">Unggah CSV lalu tekan Simpan ke Riwayat.</td></tr>';
    return;
  }

  // Roll the per-tag rows up to one row per day.
  const byDay = new Map();
  const touch = d => {
    if (!byDay.has(d)) byDay.set(d, { date: d, comm: 0, commPending: 0, orders: 0, gmv: 0, spend: 0, clicks: 0, impr: 0, shopeeClicks: 0 });
    return byDay.get(d);
  };
  aff.forEach(r => { const b = touch(r.date); b.comm += r.comm || 0; b.commPending += r.comm_pending || 0; b.orders += r.orders || 0; b.gmv += r.gmv || 0; });
  ads.forEach(r => { const b = touch(r.date); b.spend += r.spend || 0; b.clicks += r.clicks || 0; b.impr += r.impressions || 0; });
  clk.forEach(r => { const b = touch(r.date); b.shopeeClicks += r.clicks || 0; });

  const days = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
  // Two adjustments the dashboard also makes, or the two screens disagree:
  // Meta reports spend without VAT, and pending commission is discounted
  // because part of it will be cancelled.
  const PPN = 1.11, PENDING = 0.95;
  days.forEach(d => {
    d.spendPpn = d.spend * PPN;
    d.commEff = (d.comm - d.commPending) + d.commPending * PENDING;
    d.net = d.commEff - d.spendPpn;
    d.roas = d.spendPpn > 0 ? d.commEff / d.spendPpn : 0;
  });

  const sum = f => days.reduce((s, d) => s + (d[f] || 0), 0);
  const totComm = sum('commEff'), totSpend = sum('spendPpn'), totOrders = sum('orders');
  $('storedNote').textContent = `${days.length} hari · ${days[0].date} — ${days[days.length - 1].date}`;
  if (!$('dsStart').value) { $('dsStart').value = days[0].date; $('dsEnd').value = days[days.length - 1].date; }

  // The KPI row above already shows the uploaded period. This strip is about
  // what is STORED, which can span far more than the current upload — so lead
  // with coverage and per-day averages instead of repeating the same totals.
  const avgRoasDays = days.filter(d => d.spendPpn > 0);
  $('storedStrip').innerHTML = [
    ['Hari Tersimpan', nf(days.length)],
    ['Rata Komisi/Hari', rp(totComm / days.length)],
    ['Rata Biaya/Hari', rp(totSpend / days.length)],
    ['Hari Untung', nf(days.filter(d => d.net > 0).length) + ' / ' + nf(days.length)],
    ['ROAS Rata', rx(totSpend > 0 ? totComm / totSpend : 0)],
    ['Hari ROAS < 1', nf(avgRoasDays.filter(d => d.roas < 1).length)],
  ].map(x => `<div class="s"><div class="l">${x[0]}</div><div class="v">${x[1]}</div></div>`).join('');

  const lbl = days.map(d => d.date.slice(5));
  mk('chStored', { type: 'line', data: { labels: lbl, datasets: [
    { label: 'Komisi Efektif', data: days.map(d => d.commEff), borderColor: cv('--ok'), backgroundColor: cv('--ok') + '22', fill: true, tension: .3, pointRadius: 2 },
    { label: 'Biaya + PPN', data: days.map(d => d.spendPpn), borderColor: cv('--accent'), backgroundColor: cv('--accent') + '18', fill: true, tension: .3, pointRadius: 2 },
  ]}});
  mk('chStoredRoas', { type: 'bar', data: { labels: lbl, datasets: [
    { label: 'ROAS', data: days.map(d => d.roas),
      backgroundColor: days.map(d => d.roas >= 2 ? cv('--ok') : d.roas >= 1 ? cv('--warn') : cv('--bad')) },
  ]}, options: { scales: { y: { beginAtZero: true } } } });
  mk('chStoredClk', { type: 'line', data: { labels: lbl, datasets: [
    { label: 'Klik Meta', data: days.map(d => d.clicks), borderColor: cv('--info'), tension: .3, pointRadius: 2 },
    { label: 'Klik Shopee', data: days.map(d => d.shopeeClicks), borderColor: cv('--warn'), tension: .3, pointRadius: 2 },
  ]}});

  const cols = ['Tanggal', 'Komisi Efektif', 'Biaya+PPN', 'Laba', 'ROAS', 'Order', 'Klik Meta', 'Klik Shopee'];
  $('tblStored').querySelector('thead').innerHTML = '<tr>' +
    cols.map((h, i) => `<th class="${i ? 'num' : ''}">${h}</th>`).join('') + '</tr>';
  $('tblStored').querySelector('tbody').innerHTML = days.slice().reverse().map(d => `<tr>
    <td><b>${d.date}</b></td><td class="num">${rp(d.commEff)}</td><td class="num">${rp(d.spendPpn)}</td>
    <td class="num ${d.net >= 0 ? 'pos' : 'neg'}">${rp(d.net)}</td>
    <td class="num">${d.spendPpn > 0 ? d.roas.toFixed(2) : '—'}</td>
    <td class="num">${nf(d.orders)}</td><td class="num">${nf(d.clicks)}</td>
    <td class="num">${d.shopeeClicks ? nf(d.shopeeClicks) : '—'}</td></tr>`).join('');
}

$('btnRange').onclick = () => renderStored();

/* ── Upload log: the audit trail for dedup ────────────────────────────────── */
async function renderUploads() {
  if (!ACCT) return;
  const ups = await STORE.uploadHistory(ACCT.id, 60);
  const cols = ['Waktu', 'File', 'Jenis', 'Baris Sumber', 'Baru', 'Diperbarui', 'Duplikat', 'Periode'];
  $('tblUploads').querySelector('thead').innerHTML = '<tr>' +
    cols.map((h, i) => `<th class="${i > 2 && i < 7 ? 'num' : ''}">${h}</th>`).join('') + '</tr>';
  const label = { affiliate: 'Affiliate', ads: 'Iklan', clicks: 'Klik' };
  $('tblUploads').querySelector('tbody').innerHTML = ups.length ? ups.map(u => `<tr>
    <td>${new Date(u.uploaded_at).toLocaleString('id-ID', { dateStyle: 'short', timeStyle: 'short' })}</td>
    <td style="max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(u.file_name)}">${esc(u.file_name)}</td>
    <td><span class="pill">${label[u.kind] || u.kind}</span></td>
    <td class="num">${nf(u.rows)}</td>
    <td class="num pos">${nf(u.added)}</td>
    <td class="num">${nf(u.updated)}</td>
    <td class="num">${u.duplicates ? nf(u.duplicates) : '—'}</td>
    <td>${u.period_start ? u.period_start + ' — ' + u.period_end : '—'}</td></tr>`).join('')
    : '<tr><td colspan="8" style="text-align:center;color:var(--text-mute);padding:24px">Belum ada unggahan tersimpan.</td></tr>';
}

/* ── Tabs ─────────────────────────────────────────────────────────────────── */
document.querySelectorAll('.tab').forEach(t => t.onclick = () => {
  document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
  document.querySelectorAll('.panel').forEach(x => x.classList.remove('active'));
  t.classList.add('active');
  document.querySelector(`[data-panel="${t.dataset.tab}"]`).classList.add('active');
  // Charts need a real layout box, so re-render once the panel is visible.
  requestAnimationFrame(() => {
    if (t.dataset.tab === 'riwayat') renderStored();
    else if (t.dataset.tab === 'keputusan' && RESULT) renderDailyChart();
  });
});
