/* Offline, selectable-text PDF reports. Rendering never reads or changes the UI. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(globalThis);
  else root.DashboardPDF = factory(root);
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  const MODES = Object.freeze({ ringkas: 'Ringkas', standar: 'Standar', lengkap: 'Lengkap' });
  const COLORS = { ink: [27, 42, 52], muted: [88, 105, 113], accent: [16, 111, 107], cost: [210, 112, 64],
    line: [218, 227, 230], pale: [241, 247, 247], white: [255, 255, 255], danger: [169, 50, 53] };
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const amount = value => finite(value) ? value : 0;
  const integer = value => new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 }).format(amount(value));
  // Keep fractions produced by PPN / attribution; never abbreviate money as rb/jt.
  const money = value => 'Rp ' + new Intl.NumberFormat('id-ID', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(amount(value));
  const decimal = (value, digits = 2) => new Intl.NumberFormat('id-ID', {
    minimumFractionDigits: digits, maximumFractionDigits: digits,
  }).format(amount(value));
  const ratio = (value, available = true) => available && finite(value) ? decimal(value) + 'x' : '-';
  const percent = (value, available = true) => available && finite(value) ? decimal(value) + '%' : '-';
  const array = value => Array.isArray(value) ? value : [];
  const own = (value, key) => value && Object.prototype.hasOwnProperty.call(value, key);

  function create(result, settings = {}) {
    if (!result || !result.kpi || !result.range || !Array.isArray(result.tags)) {
      throw new Error('Hasil analisis belum tersedia untuk diekspor.');
    }
    const mode = settings.mode || 'standar';
    if (!own(MODES, mode)) throw new Error('Pilihan laporan PDF tidak valid.');
    const JsPDF = root.jspdf && root.jspdf.jsPDF;
    if (typeof JsPDF !== 'function') throw new Error('Pustaka PDF belum siap. Muat ulang halaman lalu coba lagi.');
    const doc = new JsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true, putOnlyUsedFonts: true });
    if (typeof doc.autoTable !== 'function') throw new Error('Pustaka tabel PDF belum siap. Muat ulang halaman lalu coba lagi.');

    const suppliedFont = root.DashboardPDFFont;
    let font = 'helvetica';
    if (suppliedFont && (typeof suppliedFont === 'string' || suppliedFont.normal || suppliedFont.regular)) {
      doc.addFileToVFS('DashboardSans.ttf', typeof suppliedFont === 'string' ? suppliedFont : suppliedFont.normal || suppliedFont.regular);
      doc.addFont('DashboardSans.ttf', 'DashboardSans', 'normal');
      // A regular face is registered under bold too when only one font is bundled.
      if (suppliedFont.bold) doc.addFileToVFS('DashboardSans-Bold.ttf', suppliedFont.bold);
      doc.addFont(suppliedFont.bold ? 'DashboardSans-Bold.ttf' : 'DashboardSans.ttf', 'DashboardSans', 'bold');
      font = 'DashboardSans';
    }
    doc.setFont(font, 'normal');
    const glyphs = doc.getFont().metadata && doc.getFont().metadata.cmap;
    const glyphMap = glyphs && glyphs.unicode && glyphs.unicode.codeMap;
    const unsupported = new Set();
    function text(value) {
      const raw = String(value == null ? '' : value).normalize('NFC')
        .replace(/[\u2010-\u2015\u2212]/g, '-').replace(/[\u2018\u2019]/g, "'")
        .replace(/[\u201c\u201d]/g, '"').replace(/\u00a0/g, ' ')
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
      return Array.from(raw, ch => {
        const code = ch.codePointAt(0);
        const supported = code === 10 || code === 13 || (glyphMap ? !!glyphMap[code] : code >= 32 && code <= 255);
        if (supported) return ch;
        // Preserve the identity of names outside the bundled font's repertoire.
        // Silent missing glyphs could make two different tags look identical.
        const token = 'U+' + code.toString(16).toUpperCase();
        unsupported.add(token);
        return '[' + token + ']';
      }).join('');
    }
    const M = 14, WIDTH = 182, TOP = 24, BOTTOM = 279;
    const r = result.range, k = result.kpi, o = result.options || {}, b = result.breakdown || {};
    // Keep real commission even when a zero pending weight makes its effective
    // value zero. Only omit tags whose cost and both commission values are zero.
    const omittedTags = new Set(result.tags.filter(t => t.spend === 0 && t.comm === 0 && t.commEff === 0).map(t => t.tag));
    const tags = result.tags.filter(t => !omittedTags.has(t.tag));
    const units = array(result.adUnits).filter(u => !omittedTags.has(u.tag)), daily = array(result.daily);
    if (!root.DashboardPDFCharts) throw new Error('Pustaka grafik PDF belum siap. Muat ulang lalu coba lagi.');
    const charts = root.DashboardPDFCharts.create(doc, { font, text, colors: COLORS });
    const statusColors = { scale: COLORS.accent, pantau: [142, 97, 13], stop: COLORS.danger,
      organik: [77, 113, 157], evaluasi: [85, 104, 115] };
    const statusNames = { scale: 'Scale', pantau: 'Pantau', stop: 'Stop', organik: 'Organik', evaluasi: 'Evaluasi' };
    const account = text(settings.account || 'Akun aktif');
    const title = text(settings.title || 'Laporan kinerja affiliate');
    const generated = settings.generatedAt == null ? new Date() : new Date(settings.generatedAt);
    if (!Number.isFinite(generated.getTime())) throw new Error('Waktu pembuatan PDF tidak valid.');
    const made = new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium', timeStyle: 'short',
      timeZone: 'Asia/Jakarta' }).format(generated) + ' WIB';
    const period = text((r.start || '-') + ' s/d ' + (r.end || '-'));
    doc.setCreationDate(generated);
    doc.setProperties({ title: title + ' - ' + account, subject: 'Analisis affiliate ' + period,
      author: 'Affiliate Dashboard', creator: 'Affiliate Dashboard / PDF lokal', keywords: 'affiliate, laporan, ' + mode });
    let y = 18, sectionNumber = 0;
    function nextPage() { doc.addPage(); y = TOP; }
    function ensure(height) { if (y + height > BOTTOM) nextPage(); }
    function paragraph(value, options = {}) {
      const size = options.size || 9, lineHeight = size * 0.43;
      doc.setFont(font, options.bold ? 'bold' : 'normal');
      doc.setFontSize(size); doc.setTextColor(...(options.color || COLORS.muted));
      const lines = doc.splitTextToSize(text(value), WIDTH);
      for (const line of lines) {
        ensure(lineHeight + 2);
        doc.text(line, M, y); y += lineHeight;
      }
      y += options.gap == null ? 3 : options.gap;
    }
    function section(label, note) {
      ensure(32); y += 4;
      sectionNumber++;
      doc.setFont(font, 'bold'); doc.setFontSize(11); doc.setTextColor(...COLORS.accent);
      doc.text(String(sectionNumber).padStart(2, '0') + '  ' + text(label), M, y); y += 6;
      if (note) paragraph(note, { size: 8, gap: 2 });
    }
    function table(head, body, widths, options = {}) {
      if (!body.length) { paragraph(options.empty || 'Tidak ada data pada periode ini.'); return; }
      ensure(18);
      const columnStyles = {};
      widths.forEach((width, index) => { columnStyles[index] = {
        cellWidth: width, halign: (options.numeric || []).includes(index) ? 'right' : 'left',
      }; });
      doc.autoTable({ startY: y, head: [head.map(text)], body: body.map(row => row.map(text)),
        margin: { top: TOP, right: M, bottom: 18, left: M }, tableWidth: WIDTH,
        theme: 'plain', showHead: 'everyPage', rowPageBreak: 'avoid',
        styles: { font, fontSize: 8, cellPadding: 2.3, overflow: 'linebreak', valign: 'top',
          textColor: COLORS.ink, lineColor: COLORS.line, lineWidth: { bottom: 0.15 } },
        headStyles: { fillColor: COLORS.accent, textColor: COLORS.white, fontStyle: 'bold', fontSize: 8 },
        alternateRowStyles: { fillColor: COLORS.pale }, columnStyles,
        didParseCell: data => {
          if (options.statuses && data.section === 'body' && data.column.index === 1) {
            data.cell.styles.textColor = statusColors[options.statuses[data.row.index]] || COLORS.muted;
            data.cell.styles.fontStyle = 'bold';
          }
        },
      });
      y = doc.lastAutoTable.finalY + 6;
    }
    function summaryMetric(label, value, note, x, top, width, negative) {
      doc.setFillColor(...COLORS.pale); doc.roundedRect(x, top, width, 24, 1.4, 1.4, 'F');
      doc.setFont(font, 'normal'); doc.setFontSize(8); doc.setTextColor(...COLORS.muted);
      doc.text(text(label), x + 4, top + 6);
      doc.setFont(font, 'bold'); doc.setTextColor(...(negative ? COLORS.danger : COLORS.ink));
      let size = 13; doc.setFontSize(size);
      while (doc.getTextWidth(text(value)) > width - 8 && size > 7) { size -= 0.25; doc.setFontSize(size); }
      doc.text(text(value), x + 4, top + 14);
      doc.setFont(font, 'normal'); doc.setFontSize(7); doc.setTextColor(...COLORS.muted);
      doc.text(text(note), x + 4, top + 21);
    }

    function moneyFlow() {
      ensure(33);
      const values = [['Komisi efektif', k.commEff, COLORS.accent], ['Biaya + PPN', k.spend, COLORS.cost],
        ['Laba efektif', k.netEff, amount(k.netEff) < 0 ? COLORS.danger : COLORS.ink]];
      values.forEach(([label, value, color], i) => {
        const x = M + i * 63;
        doc.setFillColor(...COLORS.pale); doc.roundedRect(x, y, 56, 28, 1, 1, 'F');
        doc.setFillColor(...color); doc.rect(x, y, 56, 1.1, 'F');
        doc.setFont(font, 'normal'); doc.setFontSize(8); doc.setTextColor(...COLORS.muted);
        doc.text(label, x + 3, y + 8);
        let size = 11; doc.setFont(font, 'bold'); doc.setFontSize(size);
        while (doc.getTextWidth(money(value)) > 50 && size > 7) { size -= 0.25; doc.setFontSize(size); }
        doc.setTextColor(...(i === 1 ? [153, 68, 29] : color)); doc.text(money(value), x + 3, y + 19);
        if (i < 2) { doc.setTextColor(...COLORS.muted); doc.setFontSize(13); doc.text(i === 0 ? '-' : '=', x + 59.5, y + 16, { align: 'center' }); }
      });
      y += 34;
    }

    doc.setFillColor(...COLORS.accent); doc.rect(M, y - 2, 8, 2, 'F'); y += 7;
    paragraph('AFFILIATE DASHBOARD / ' + MODES[mode].toUpperCase(), { size: 9, color: COLORS.accent, bold: true });
    paragraph(title, { size: 23, color: COLORS.ink, bold: true, gap: 4 });
    paragraph(account, { size: 11, color: COLORS.ink, bold: true, gap: 1 });
    paragraph('Periode ' + period + '  |  Dibuat ' + made, { size: 8, gap: 6 });
    ensure(54);
    const metrics = [
      ['Biaya iklan termasuk PPN', money(k.spend), 'PPN ' + decimal(amount(o.ppn)) + '%'],
      ['Komisi efektif', money(k.commEff), 'Termasuk komisi organik'],
      ['Laba efektif', money(k.netEff), 'Komisi efektif dikurangi biaya', amount(k.netEff) < 0],
      ['ROAS iklan berbayar', ratio(k.paidRoas, amount(k.paidSpend) > 0), 'Komisi tag berbayar / biaya iklan'],
      ['Pesanan unik', integer(k.orders), 'Tidak termasuk batal / belum dibayar'],
      ['Komisi tertunda', money(k.commPending), percent(k.pendingPct) + ' dari komisi laporan'],
    ];
    metrics.forEach((metric, index) => summaryMetric(metric[0], metric[1], metric[2],
      M + (index % 3) * 62, y + Math.floor(index / 3) * 27, 58, metric[3]));
    y += 58;
    const coverage = [
      [daily.filter(d => d.hasAffiliate === false).length, 'affiliate'],
      [daily.filter(d => d.hasAds === false).length, 'iklan'],
    ].filter(([count]) => count > 0).map(([count, source]) => integer(count) + ' hari tanpa baris ' + source);
    if (coverage.length) paragraph('Cakupan: ' + coverage.join('; ') + '. Laba memakai data yang tersedia.',
      { size: 8, color: COLORS.ink, bold: true, gap: 2 });
    section('Tren biaya dan komisi');
    ensure(76);
    charts.trend({ x: M, y, width: WIDTH, height: 76, matureUntil: r.matureUntil,
      rows: daily.map(d => ({ date: d.date, spend: d.hasAds === false ? null : d.spend,
        comm: d.hasAffiliate === false || !finite(d.commEff) ? null : d.commEff })) });
    y += 78;
    paragraph('Komisi memakai bobot efektif. Garis terputus berarti tidak ada baris sumber; bukan bukti nilai nol.', { size: 7, gap: 1 });
    section('Peta keputusan', integer(tags.length) + ' tag pada periode ini. Keputusan memakai hari matang sampai ' + (r.matureUntil || '-') + '.');
    ensure(35);
    charts.decisions({ x: M, y, width: WIDTH, height: 35,
      items: Object.keys(statusNames).map(status => ({ label: statusNames[status],
        count: tags.filter(t => t.status === status).length, color: statusColors[status] })) });
    y += 38;

    nextPage();
    section('Bagaimana laba terbentuk');
    moneyFlow();
    const topTags = tags.slice().sort((a, b) => amount(b.spend) - amount(a.spend) || amount(b.commEff) - amount(a.commEff)).slice(0, 6);
    section('Biaya dan komisi per tag', integer(topTags.length) + ' dari ' + integer(tags.length) + ' tag, diurutkan dari biaya terbesar. Tabel memuat semua tag dengan biaya atau komisi.');
    ensure(93);
    charts.pairedBars({ x: M, y, width: WIDTH, height: 93, leftLabel: 'Biaya + PPN', rightLabel: 'Komisi efektif',
      rows: topTags.map(t => ({ label: t.tag, left: t.spend, right: t.commEff })) });
    y += 99;
    section('Keputusan setiap tag', 'ROAS matang = dasar keputusan. Tanda "-" berarti biaya pembagi tidak tersedia.');
    table(['Tag', 'Keputusan', 'Biaya + PPN', 'Komisi efektif', 'Laba efektif', 'ROAS matang'], tags.map(t => [
      t.tag, statusNames[t.status] || t.label, money(t.spend), money(t.commEff), money(t.netEff), ratio(t.matureRoasEff, amount(t.matureSpend) > 0),
    ]), [45, 25, 30, 30, 30, 22], { numeric: [2, 3, 4, 5], statuses: tags.map(t => t.status) });

    const a = result.actions || {};
    section('Prioritas tindakan');
    table(['Periksa', 'Tag', 'Nilai terkait'], [
      ['Tag berstatus Stop', integer(tags.filter(t => t.status === 'stop').length), money(a.stopSpend) + ' biaya periode ini'],
      ['Bid di atas target', integer(a.overbidCount), money(a.bidSaving) + ' selisih terhadap CPC ideal'],
      ['Selisih klik berat', integer(tags.filter(t => t.leak && t.leak.severity === 'bad').length), money(a.leakWaste) + ' estimasi biaya terkait'],
    ], [74, 20, 88], { numeric: [1] });
    paragraph('Nilai tindakan memakai biaya historis, bukan jaminan penghematan.', { size: 7 });

    if (mode !== 'ringkas') {
      section('Efisiensi tag', 'CPC Shopee memakai biaya pada jendela laporan klik. Pesanan dapat muncul pada lebih dari satu tag; gunakan pesanan unik portofolio untuk total.');
      table(['Tag', 'Klik Meta / CPC', 'Klik Shopee / CPC', 'Pesanan / biaya', 'ROAS / ROI'], tags.map(t => [
        t.tag, integer(t.clicks) + '\n' + (amount(t.clicks) > 0 && amount(t.spend) > 0 ? money(t.cpc) : '-'),
        (r.clickStart ? integer(t.shopeeClicks) : '-') + '\n' + (amount(t.shopeeClicks) > 0 && amount(t.winSpend) > 0 ? money(t.cpcShopee) : '-'),
        integer(t.orders) + '\n' + (amount(t.orders) > 0 && amount(t.spend) > 0 ? money(t.costPerOrder) : '-'),
        ratio(t.roasEff, amount(t.spend) > 0) + '\n' + percent(t.roi, amount(t.spend) > 0),
      ]), [46, 34, 36, 36, 30]);

      section('Rincian iklan', 'Komisi, pesanan, dan klik Shopee dibagi proporsional dari tag berdasarkan biaya; ini estimasi atribusi. Keputusan mengikuti tag induk.');
      table(['Iklan / tag', 'Penayangan / keputusan', 'Biaya + PPN', 'Komisi efektif / laba', 'Klik / CPC Meta'], units.map(u => [
        u.adName + '\nTag: ' + u.tag, (u.delivery || 'Status tidak tersedia') + '\n' + (u.label || u.status || '-'),
        money(u.spend), money(u.commEff) + '\n' + money(u.netEff), integer(u.clicks) + '\n' + (amount(u.clicks) > 0 ? money(u.cpc) : '-'),
      ]), [51, 31, 31, 38, 31], { numeric: [2, 3, 4], empty: 'Tidak ada iklan pada hasil analisis periode ini.' });

      section('Kinerja harian', 'Angka memakai bobot efektif seperti ringkasan. Tanda "-" berarti tidak ada baris sumber atau pembagi; bukan bukti nilai nol. Laba dan ROAS harian memerlukan baris iklan serta affiliate.');
      table(['Tanggal / kematangan', 'Biaya + PPN', 'Komisi efektif', 'Laba efektif', 'ROAS efektif', 'Pesanan'], daily.map(d => {
        const hasAds = d.hasAds !== false, hasAffiliate = d.hasAffiliate !== false;
        return [d.date + '\n' + (d.mature ? 'Matang' : 'Belum matang'), hasAds ? money(d.spend) : '-',
          hasAffiliate && finite(d.commEff) ? money(d.commEff) : '-',
          hasAds && hasAffiliate && finite(d.netEff) ? money(d.netEff) : '-',
          ratio(d.roasEff, hasAds && hasAffiliate && amount(d.spend) > 0), hasAffiliate ? integer(d.orders) : '-'];
      }), [36, 35, 35, 35, 21, 20], { numeric: [1, 2, 3, 4, 5] });
    }

    if (mode === 'lengkap') {
      section('Alasan keputusan', 'Rincian penjelasan untuk penelusuran setiap tag.');
      table(['Tag', 'Keputusan', 'Alasan / langkah berikutnya'], tags.map(t => [t.tag, statusNames[t.status] || t.label,
        [t.reason, t.bidHint].filter(Boolean).join('\n') || '-']), [47, 25, 110], { statuses: tags.map(t => t.status) });
      section('Pencocokan nama iklan dan tag', 'Kandidat pada kecocokan lemah belum dianggap cocok. Periksa pemetaan manual sebelum mengandalkan keputusan tag tersebut.');
      table(['Nama iklan', 'Tag hasil / kandidat', 'Metode / keyakinan', 'Biaya + PPN'], array(result.matchLog).filter(m => !omittedTags.has(m.tag)).map(m => [
        m.adName, m.tag + (m.candidateTag ? '\nKandidat: ' + m.candidateTag : ''), m.method + '\n' + percent(amount(m.confidence) * 100), money(m.spend),
      ]), [57, 52, 37, 36], { numeric: [3] });

      section('Perbandingan klik Meta dan Shopee', r.clickStart ? 'Jendela ' + r.clickStart + ' s/d ' + r.clickEnd + '. Selisih positif dapat mencakup klik tambahan di luar iklan; selisih negatif perlu diperiksa.' : 'Tidak tersedia laporan klik pada periode ini.');
      const leaks = tags.filter(t => t.leak && finite(t.leak.pct));
      table(['Tag', 'Klik Meta', 'Klik Shopee', 'Selisih', 'Masuk', 'Estimasi biaya selisih'], leaks.map(t => [
        t.tag, integer(t.leak.metaClicks), integer(t.leak.shopeeClicks), integer(amount(t.leak.shopeeClicks) - amount(t.leak.metaClicks)),
        percent(t.leak.pct), money(t.leak.wasted),
      ]), [50, 25, 25, 22, 24, 36], { numeric: [1, 2, 3, 4, 5], empty: 'Perbandingan klik belum dapat dihitung.' });

      section('Status pesanan per hari', 'Jumlah adalah pesanan per status, bukan baris produk. Pesanan yang tercatat pada beberapa status dapat dihitung pada setiap statusnya.');
      table(['Tanggal', 'Selesai', 'Tertunda', 'Belum dibayar', 'Dibatalkan', 'Lainnya'], array(result.statusDaily).map(d => [
        d.date, integer(d.done), integer(d.pending), integer(d.unpaid), integer(d.cancelled), integer(d.other),
      ]), [37, 28, 28, 32, 31, 26], { numeric: [1, 2, 3, 4, 5] });

      section('Produk dengan komisi terbesar', 'Daftar mengikuti ringkasan mesin: maksimal 15 produk teratas. Komisi adalah komisi laporan sebelum bobot tertunda; daftar ini bukan seluruh baris produk sumber.');
      table(['Produk', 'Komisi laporan', 'Nilai pembelian', 'Pesanan', 'Unit'], array(b.productByComm).map(p => [
        p.name, money(p.comm), money(p.gmv), integer(p.orders), integer(p.qty),
      ]), [68, 39, 39, 18, 18], { numeric: [1, 2, 3, 4] });
      section('Produk terlaris', 'Maksimal 15 produk teratas berdasarkan unit, sehingga produk dengan volume tinggi tetap terlihat meski komisinya kecil.');
      table(['Produk', 'Unit', 'Pesanan', 'Komisi laporan', 'Nilai pembelian'], array(b.productByQty).map(p => [
        p.name, integer(p.qty), integer(p.orders), money(p.comm), money(p.gmv),
      ]), [68, 18, 18, 39, 39], { numeric: [1, 2, 3, 4] });

      section('Sumber komisi', 'Komisi laporan sebelum bobot tertunda. Daftar toko dan kategori terbatas pada 10 teratas sesuai ringkasan mesin; kategori lain tidak dijumlahkan sebagai nol.');
      const groups = [['Platform', b.platform], ['Toko (top 10)', b.shop], ['Kategori L1 (top 10)', b.category],
        ['Kategori L2 (top 10)', b.category2], ['Tipe penawaran', b.offerType], ['Tipe konten', b.contentType]];
      table(['Dimensi', 'Nama', 'Komisi laporan'], groups.flatMap(([label, rows]) => array(rows).map(row => [label, row.name || '(tanpa nama)', money(row.comm)])),
        [43, 97, 42], { numeric: [2] });

      section('Sumber klik', 'Baris sumber mencakup ringkasan perujuk; wilayah dibatasi 8 teratas sesuai hasil analisis.');
      table(['Dimensi', 'Nama', 'Klik'], [['Perujuk', b.clickSource], ['Wilayah (top 8)', b.clickRegion]]
        .flatMap(([label, rows]) => array(rows).map(row => [label, row.name || '(tanpa nama)', integer(row.count)])), [43, 109, 30], { numeric: [2] });
    }

    section('Parameter dan cakupan');
    const counts = result.counts || {}, excluded = k.excluded || {};
    table(['Parameter', 'Nilai', 'Parameter', 'Nilai'], [
      ['PPN', percent(amount(o.ppn)), 'Bobot tertunda', percent(amount(o.pendingFactor) * 100)],
      ['Lag atribusi', integer(o.lagDays) + ' hari', 'Target ROI', percent(amount(o.targetROI))],
      ['Ambang Scale', decimal(amount(o.thScale)) + 'x', 'Ambang Pantau', decimal(amount(o.thPantau)) + 'x'],
      ['Minimum biaya', money(o.minSpend), 'Minimum produksi', integer(o.minDays) + ' hari matang'],
      ['Streak rugi', integer(o.streakDays) + ' hari', 'Komisi organik', money(k.organicComm)],
    ], [44, 47, 44, 47]);
    paragraph(integer(tags.length) + ' tag / ' + integer(units.length) + ' iklan / ' + integer(daily.length) + ' hari. '
      + 'Baris aktif: affiliate ' + integer(counts.affiliate) + ', iklan ' + integer(counts.ads) + ', klik ' + integer(counts.clicks) + '. '
      + 'Dikecualikan: ' + integer(excluded.cancelled) + ' baris batal dan ' + integer(excluded.unpaid) + ' belum dibayar.', { size: 8 });
    if (omittedTags.size) paragraph(integer(omittedTags.size) + ' tag dengan biaya dan komisi sama-sama nol tidak ditampilkan pada laporan ini.', { size: 8 });
    paragraph('Jendela klik: ' + (r.clickStart ? r.clickStart + ' s/d ' + r.clickEnd : 'tidak tersedia') + '.', { size: 8 });
    const quality = settings.quality == null ? [] : Array.isArray(settings.quality) ? settings.quality : [settings.quality];
    const qualityRows = quality.map(item => {
      let value = typeof item === 'string' ? item : [item.label, item.message, item.detail].filter(Boolean).join(' - ');
      value = value.replace(/\s+Contoh:\s*/, ' ').replace(/Baris \d+:\s*/, '');
      const repeat = value.search(/\s+Baris \d+:/);
      return [repeat >= 0 ? value.slice(0, repeat) : value];
    }).filter(row => row[0]);
    if (qualityRows.length) table(['Catatan kualitas data'], qualityRows, [WIDTH]);

    if (unsupported.size) {
      section('Karakter khusus dalam nama');
      paragraph('Karakter yang tidak tersedia pada font PDF ditulis sebagai kode Unicode [U+XXXX] agar identitas tag tetap dapat dibedakan: '
        + [...unsupported].join(', ') + '. Nama asli tetap tersedia di dashboard dan ekspor CSV.', { size: 8 });
    }
    const totalPages = doc.getNumberOfPages();
    const shortAccount = account.length > 80 ? account.slice(0, 77) + '...' : account;
    for (let page = 1; page <= totalPages; page++) {
      doc.setPage(page);
      doc.setFont(font, 'normal'); doc.setFontSize(7); doc.setTextColor(...COLORS.muted);
      if (page > 1) {
        doc.text('AFFILIATE DASHBOARD / ' + MODES[mode].toUpperCase(), M, 11);
        doc.text(doc.splitTextToSize(shortAccount, 88)[0], 196, 11, { align: 'right' });
        doc.setDrawColor(...COLORS.line); doc.setLineWidth(0.2); doc.line(M, 15, 196, 15);
      }
      doc.setDrawColor(...COLORS.line); doc.setLineWidth(0.2); doc.line(M, 283, 196, 283);
      doc.text(period + ' | Semua nilai uang dalam IDR', M, 288);
      doc.text('Halaman ' + page + ' / ' + totalPages, 196, 288, { align: 'right' });
    }
    return doc;
  }

  return Object.freeze({ create, modes: MODES });
});
