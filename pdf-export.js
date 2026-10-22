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
    const r = result.range, k = result.kpi, o = result.options || {}, b = result.breakdown || {}, a = result.actions || {};
    // Every page says which PPN produced the numbers. decimal(), not
    // integer(): 11,5 must not print as 12.
    const ppnPct = decimal(amount(o.ppn), Number.isInteger(amount(o.ppn)) ? 0 : 2) + '%';
    const ppnText = amount(o.ppn) > 0 ? 'Termasuk PPN ' + ppnPct : 'Tanpa PPN';
    // Keep real commission even when a zero pending weight makes its effective
    // value zero. Only omit tags whose cost and both commission values are zero.
    const omittedTags = new Set(result.tags.filter(t => t.spend === 0 && t.comm === 0 && t.commEff === 0).map(t => t.tag));
    const tags = result.tags.filter(t => !omittedTags.has(t.tag));
    const units = array(result.adUnits).filter(u => !omittedTags.has(u.tag)), daily = array(result.daily);
    if (!root.DashboardPDFCharts) throw new Error('Pustaka grafik PDF belum siap. Muat ulang lalu coba lagi.');
    const charts = root.DashboardPDFCharts.create(doc, { font, text, colors: COLORS });
    const statusColors = { scale: COLORS.accent, pantau: [142, 97, 13], stop: COLORS.danger,
      organik: [77, 113, 157], evaluasi: [85, 104, 115] };
    const statusNames = { scale: 'Scale', pantau: 'Pantau', stop: 'Stop', organik: 'Organik', evaluasi: 'Belum cukup data' };
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
        styles: { font, fontSize: options.fontSize || 8, cellPadding: options.fontSize ? 1.6 : 2.3, overflow: 'linebreak', valign: 'top',
          textColor: COLORS.ink, lineColor: COLORS.line, lineWidth: { bottom: 0.15 } },
        headStyles: { fillColor: COLORS.accent, textColor: COLORS.white, fontStyle: 'bold', fontSize: options.fontSize || 8 },
        alternateRowStyles: { fillColor: COLORS.pale }, columnStyles,
        didParseCell: data => {
          // oneLine tables shrink a too-wide body value (down to 5pt) rather
          // than wrap it, so "Rp 1.500.000" never reads as two numbers.
          if (options.oneLine && data.section === 'body') {
            const cell = data.cell, size = cell.styles.fontSize;
            const room = columnStyles[data.column.index].cellWidth - 2 * cell.styles.cellPadding - 0.2;
            doc.setFont(font, 'normal');
            const wide = Math.max(...cell.text.map(line => doc.getStringUnitWidth(line) * size / doc.internal.scaleFactor));
            if (wide > room) cell.styles.fontSize = Math.max(5, Math.floor(size * room / wide * 10) / 10);
          }
          if (options.statuses && data.section === 'body' && data.column.index === 1) {
            data.cell.styles.textColor = statusColors[options.statuses[data.row.index]] || COLORS.muted;
            data.cell.styles.fontStyle = 'bold';
          }
        },
      });
      y = doc.lastAutoTable.finalY + 6;
    }
    function fitLine(value, width, size) {
      doc.setFontSize(size);
      let line = text(value);
      if (doc.getTextWidth(line) <= width) return line;
      const chars = Array.from(line);
      while (chars.length && doc.getTextWidth(chars.join('') + '...') > width) chars.pop();
      return chars.join('') + '...';
    }
    function summaryMetric(label, value, note, x, top, width, negative) {
      doc.setFillColor(...COLORS.pale); doc.roundedRect(x, top, width, 24, 1.4, 1.4, 'F');
      doc.setFont(font, 'normal'); doc.setFontSize(8); doc.setTextColor(...COLORS.muted);
      doc.text(fitLine(label, width - 8, 8), x + 4, top + 6);
      doc.setFont(font, 'bold'); doc.setTextColor(...(negative ? COLORS.danger : COLORS.ink));
      let size = 13; doc.setFontSize(size);
      while (doc.getTextWidth(text(value)) > width - 8 && size > 7) { size -= 0.25; doc.setFontSize(size); }
      doc.text(text(value), x + 4, top + 14);
      doc.setFont(font, 'normal'); doc.setFontSize(7); doc.setTextColor(...COLORS.muted);
      doc.text(fitLine(note, width - 8, 7), x + 4, top + 21);
    }
    function metricGrid(metrics, columns) {
      const width = (WIDTH - (columns - 1) * 4) / columns;
      for (let index = 0; index < metrics.length; index += columns) {
        ensure(24);
        metrics.slice(index, index + columns).forEach((metric, column) =>
          summaryMetric(metric[0], metric[1], metric[2], M + column * (width + 4), y, width, metric[3]));
        y += 27;
      }
    }
    function decisionBoard() {
      const statuses = ['scale', 'pantau', 'stop', 'organik'], width = (WIDTH - 4) / 2;
      ensure(57); // keep both rows of the board on one page
      statuses.forEach((status, index) => {
        if (index % 2 === 0) ensure(27);
        const x = M + (index % 2) * (width + 4), top = y;
        const group = tags.filter(t => t.status === status).sort((l, r) => status === 'organik'
          ? amount(r.comm) - amount(l.comm) : status === 'scale' ? amount(r.roasEff) - amount(l.roasEff) : amount(l.roasEff) - amount(r.roasEff));
        doc.setFillColor(...COLORS.pale); doc.roundedRect(x, top, width, 27, 1.4, 1.4, 'F');
        doc.setFillColor(...statusColors[status]); doc.rect(x, top, 1, 27, 'F');
        doc.setFont(font, 'bold'); doc.setFontSize(8); doc.setTextColor(...statusColors[status]);
        doc.text(statusNames[status] + ' (' + integer(group.length) + ')', x + 4, top + 5.5);
        doc.setFont(font, 'normal'); doc.setTextColor(...COLORS.ink);
        if (!group.length) { doc.setFontSize(7); doc.text('Belum ada tag', x + 4, top + 13); }
        group.slice(0, 3).forEach((t, row) => {
          const value = status === 'organik' ? money(t.comm) : ratio(t.roasEff, amount(t.spend) > 0);
          doc.setFontSize(7);
          const valueWidth = doc.getTextWidth(text(value));
          doc.text(fitLine(t.tag, width - valueWidth - 12, 7), x + 4, top + 10.5 + row * 4);
          doc.text(text(value), x + width - 4, top + 10.5 + row * 4, { align: 'right' });
        });
        doc.setTextColor(...COLORS.muted); doc.setFontSize(6.5);
        const basis = status === 'organik' ? 'Komisi laporan' : 'ROAS periode';
        doc.text(basis + (group.length > 3 ? ' | +' + integer(group.length - 3) + ' tag di tabel' : ''), x + 4, top + 24);
        if (index % 2 === 1) y += 30;
      });
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

    /* Platform & placement, as in the dashboard card: real numbers per
       platform, estimated commission per placement, the Other referrers and
       the tags they landed on. Only when a placement export is loaded. */
    function placementSection() {
      const P = result.placement;
      if (!P || !array(P.platforms).length) return;
      const OTHER = 'Other (bukan FB/IG)', rp = v => amount(v) ? 'Rp ' + integer(Math.round(amount(v))) : '-', count = v => amount(v) ? integer(v) : '-';
      const sources = list => list.slice(0, 4).map(o => o.source + ' ' + integer(o.shopeeClicks)).join(', ') + (list.length > 4 ? ', +' + integer(list.length - 4) + ' lain' : '');
      const allSources = sources(array(P.otherSources));
      section('Platform dan placement', 'Periode file placement ' + P.range.start + ' s/d ' + P.range.end + (P.daily ? ' (ikut filter tanggal)' : ' (satu periode)') + '. '
        + 'Per platform semua angka nyata: biaya dan klik dari Meta, klik Shopee dari kolom Perujuk, pesanan dan komisi dari kolom Platform laporan komisi. '
        + 'Hanya tag yang punya iklan di file placement yang dihitung. Other = perujuk selain Facebook/Instagram.');
      const platRow = p => [p.platform === OTHER ? 'Other' : p.platform,
        rp(p.spend), P.total.spend ? percent(amount(p.spend) / P.total.spend * 100) : '-', count(p.clicks), count(p.shopeeClicks),
        p.platform === OTHER || !P.hasClicks ? '-' : lost(p.lost), count(p.orders), rp(p.comm), ratio(p.roas, amount(p.spend) > 0), amount(p.spend) ? (p.net < 0 ? '-' : '') + rp(Math.abs(p.net)) : '-'];
      table(['Platform', 'Biaya', '% biaya', 'Klik Meta', 'Klik Shopee', 'Klik hilang', 'Pesanan', 'Komisi', 'ROAS', 'Laba'],
        array(P.platforms).map(platRow).concat([platRow(P.total)]), [30, 22, 13, 15, 15, 14, 14, 22, 13, 24],
        { numeric: [1, 2, 3, 4, 5, 6, 7, 8, 9], fontSize: 7, oneLine: true });
      if (allSources) paragraph('Sumber Other: ' + allSources + '.', { size: 7, gap: 1 });
      if (P.unmatchedSpend) paragraph(money(P.unmatchedSpend) + ' biaya berasal dari iklan yang belum cocok ke tag.', { size: 7, gap: 1 });
      if (!P.hasOrderPlatform) paragraph('Laporan komisi tanpa kolom Platform: komisi per platform kosong.', { size: 7, gap: 1 });

      const big = array(P.placements).filter(p => p.share >= 0.5);
      const places = mode === 'lengkap' ? array(P.placements) : big;
      const other = array(P.platforms).find(p => p.platform === OTHER);
      section('Per placement', 'Shopee tidak tahu placement Meta, jadi komisi per placement adalah estimasi: komisi tiap tag di platform itu dibagi menurut porsi klik Meta tiap placement. '
        + (places.length < array(P.placements).length ? integer(array(P.placements).length - places.length) + ' placement di bawah 0,5% biaya tidak ditampilkan (ada di PDF Lengkap). ' : '')
        + 'Baris Other memakai komisi nyata.');
      table(['Platform', 'Placement', 'Biaya', '% biaya', 'Klik Meta', 'CTR', 'CPC Meta', 'CPC vs rata-rata', 'Estimasi komisi', 'Estimasi ROAS'],
        places.map(p => [p.platform, p.placement, rp(p.spend), percent(p.share), count(p.clicks), percent(p.ctr, finite(p.ctr)),
          p.cpc == null ? '-' : rp(p.cpc), finite(p.cpcVsAvg) ? (p.cpcVsAvg > 0 ? '+' : '') + p.cpcVsAvg.toFixed(0) + '%' : '-', rp(p.estComm), ratio(p.estRoas, amount(p.spend) > 0)])
          .concat(other && (amount(other.shopeeClicks) || amount(other.comm)) ? [['Other', 'Bukan placement Meta', '-', '-', '-', '-', '-', '-', rp(other.comm), '-']] : []),
        [17, 34, 20, 13, 14, 12, 18, 16, 22, 16], { numeric: [2, 3, 4, 5, 6, 7, 8, 9], fontSize: 7, oneLine: true });
      if (other && amount(other.shopeeClicks)) paragraph('Other: ' + integer(other.shopeeClicks) + ' klik Shopee dan ' + integer(other.orders) + ' pesanan dari perujuk selain Facebook/Instagram; komisinya nyata, bukan estimasi.', { size: 7, gap: 1 });

      const otherTags = array(P.otherTags), cut = mode === 'ringkas' ? 10 : mode === 'standar' ? 25 : otherTags.length;
      if (otherTags.length) {
        section('Tag asal klik Other', 'Klik dan pesanan dengan perujuk selain Facebook/Instagram, per tag. Biasanya link yang dibagikan ulang, bukan klik iklan.'
          + (otherTags.length > cut ? ' ' + integer(cut) + ' dari ' + integer(otherTags.length) + ' tag, urut klik terbanyak.' : ''));
        table(['Tag', 'Klik Shopee', 'Pesanan', 'Komisi', 'Sumber'], otherTags.slice(0, cut).map(t => [t.tag, count(t.shopeeClicks), count(t.orders), rp(t.comm), sources(array(t.sources))]),
          [50, 22, 18, 28, 64], { numeric: [1, 2, 3] });
      }

      if (mode !== 'ringkas') {
        const pf = (t, key) => (t.platforms && t.platforms[key]) || { spend: 0, comm: 0, roas: null };
        const tagCut = mode === 'lengkap' ? array(P.tags).length : 15;
        section('Per tag: Facebook vs Instagram', 'ROAS per platform nyata. Platform dengan biaya di bawah Rp10.000 terlalu kecil untuk dibandingkan.'
          + (array(P.tags).length > tagCut ? ' ' + integer(tagCut) + ' dari ' + integer(array(P.tags).length) + ' tag dengan biaya terbesar.' : ''));
        table(['Tag', 'Biaya FB', 'Komisi FB', 'ROAS FB', 'Biaya IG', 'Komisi IG', 'ROAS IG', 'Komisi Lainnya + Other', 'Lebih untung di'],
          array(P.tags).slice(0, tagCut).map(t => {
            const fb = pf(t, 'Facebook'), ig = pf(t, 'Instagram'), rest = amount(pf(t, 'Lainnya').comm) + amount(pf(t, OTHER).comm);
            const ok = x => amount(x.spend) >= 10000 && finite(x.roas);
            const best = !amount(fb.comm) && !amount(ig.comm) ? 'Belum ada komisi' : ok(fb) && ok(ig) ? (Math.abs(fb.roas - ig.roas) < 0.1 ? 'Setara' : fb.roas > ig.roas ? 'Facebook' : 'Instagram') : '-';
            return [t.tag, rp(fb.spend), rp(fb.comm), ratio(fb.roas, amount(fb.spend) > 0), rp(ig.spend), rp(ig.comm), ratio(ig.roas, amount(ig.spend) > 0), rp(rest), best];
          }), [36, 19, 19, 13, 19, 19, 13, 22, 22], { numeric: [1, 2, 3, 4, 5, 6, 7], fontSize: 7, oneLine: true });
      }
    }

    doc.setFillColor(...COLORS.accent); doc.rect(M, y - 2, 8, 2, 'F'); y += 7;
    paragraph('AFFILIATE DASHBOARD / ' + MODES[mode].toUpperCase(), { size: 9, color: COLORS.accent, bold: true });
    paragraph(title, { size: 21, color: COLORS.ink, bold: true, gap: 3 });
    paragraph(account, { size: 11, color: COLORS.ink, bold: true, gap: 1 });
    paragraph('Periode ' + period + '  |  Dibuat ' + made + '  |  PPN biaya iklan ' + ppnPct + (settings.version ? '  |  Versi ' + settings.version : ''), { size: 8, gap: 3 });
    section('Dashboard utama');
    metricGrid([
      ['Komisi Efektif', money(k.commEff), 'Total ' + money(k.comm) + ' | ' + integer(k.orders) + ' pesanan'],
      ['Spend Iklan', money(k.spend), ppnText],
      ['Laba Bersih', money(k.netEff), amount(o.ppn) > 0 ? 'Komisi efektif - (biaya + PPN ' + ppnPct + ')' : 'Komisi efektif - biaya iklan', amount(k.netEff) < 0],
      ['ROAS Gabungan', ratio(k.roasEff, amount(k.spend) > 0), 'Iklan berbayar ' + ratio(k.paidRoas, amount(k.paidSpend) > 0)],
    ], 2);
    // Use the same matched tag/window totals as the main dashboard, rather
    // than comparing all Meta clicks with all Shopee clicks across different dates.
    const clickTags = result.tags.filter(t => t.leak && finite(t.leak.pct));
    const metaClicks = clickTags.reduce((sum, t) => sum + amount(t.leak.metaClicks), 0);
    const shopeeClicks = clickTags.reduce((sum, t) => sum + amount(t.leak.shopeeClicks), 0);
    const lostClicks = clickTags.reduce((sum, t) => sum + Math.max(0, amount(t.leak.metaClicks) - amount(t.leak.shopeeClicks)), 0);
    // The per-tag sum stays the headline; the net is printed beside it because
    // a surplus on one tag may or may not be another tag's misrouted clicks.
    const netLost = Math.max(0, metaClicks - shopeeClicks);
    const hasClickComparison = clickTags.length > 0;
    const hasAds = amount(result.counts && result.counts.ads) > 0;
    // With a Perujuk column the leak compares Meta clicks with Facebook and
    // Instagram arrivals only; every other arrival is shown beside it.
    const bySource = clickTags.some(t => t.shopeeSrc);
    const arrived = clickTags.reduce((sum, t) => sum + amount(t.shopeeClicks), 0);
    const otherArrived = clickTags.reduce((sum, t) => sum + (t.shopeeSrc ? amount(t.shopeeSrc.other) : 0), 0);
    section('Klik Meta dan Shopee', bySource ? 'Klik hilang membandingkan klik Meta dengan klik Shopee yang perujuknya Facebook/Instagram. Klik dari sumber lain (Others, Websites, ...) dihitung terpisah sebagai Other.' : null);
    metricGrid([
      ['Klik Meta', hasAds ? integer(hasClickComparison ? metaClicks : k.clicks) : '-', hasClickComparison ? 'Pada jendela klik' : 'Pada periode analisis'],
      ['Klik Masuk Shopee', hasClickComparison ? integer(arrived) : '-', bySource ? 'FB+IG ' + integer(shopeeClicks) + ' | Other ' + integer(otherArrived) : 'Jendela dan tag sama'],
      ['Klik Hilang', hasClickComparison ? integer(lostClicks) : '-', hasClickComparison ? 'Per tag; bersih ' + integer(netLost) : 'Jumlah per tag', lostClicks > 0],
      ['% Klik Masuk Shopee', percent(metaClicks > 0 ? shopeeClicks / metaClicks * 100 : null, hasClickComparison && metaClicks > 0), bySource ? 'Shopee FB+IG / Meta' : 'Shopee / Meta'],
    ], 4);
    section('Prioritas anggaran');
    // Paid tags not judged yet: same definition as the dashboard card. Their
    // net is real money, so it gets a card rather than only a count.
    const unjudged = tags.filter(t => t.status === 'evaluasi' && amount(t.spend) > 0);
    const unjudgedNet = finite(a.evalNet) ? a.evalNet : unjudged.reduce((sum, t) => sum + amount(t.netEff), 0);
    const unjudgedSpend = finite(a.evalSpend) ? a.evalSpend : unjudged.reduce((sum, t) => sum + amount(t.spend), 0);
    metricGrid([
      ['Hemat dari Turunkan Bid', money(a.bidSaving), integer(a.overbidCount) + ' tag di atas CPC ideal'],
      // Gross STOP spend is in 'Prioritas tindakan'; here it would not fit a 4-column card.
      ['Rugi di Tag STOP', money(a.stopLoss), integer(a.stopCount) + ' tag'],
      ['Potensi perbaikan laba', money(a.maxGain), 'Batas atas: bid + rugi STOP'],
      ['Tag belum cukup data', money(unjudgedNet), integer(unjudged.length) + ' tag | laba efektif', unjudgedNet < 0],
    ], 4);
    ensure(70); // heading and both board rows together
    section('Keputusan utama');
    decisionBoard();
    y += 2;
    const coverage = [
      [daily.filter(d => d.hasAffiliate === false).length, 'affiliate'],
      [daily.filter(d => d.hasAds === false).length, 'iklan'],
    ].filter(([count]) => count > 0).map(([count, source]) => integer(count) + ' hari tanpa baris ' + source);
    if (coverage.length) paragraph('Cakupan: ' + coverage.join('; ') + '. Laba memakai data yang tersedia.',
      { size: 7, color: COLORS.ink, bold: true, gap: 1 });
    paragraph('Keputusan sampai ' + (r.matureUntil || '-') + '. '
      + (unjudged.length ? integer(unjudged.length) + ' tag berbiaya belum cukup data (biaya ' + money(unjudgedSpend) + '); lihat tabel. ' : '')
      + 'Jendela klik: ' + (r.clickStart ? r.clickStart + ' s/d ' + r.clickEnd : 'belum tersedia') + '.', { size: 7, gap: 0 });

    // A new page only when the trend chart would not fit under the board.
    ensure(100);
    section('Tren biaya dan komisi');
    ensure(76);
    // Commission on its click day, as on screen. A day without commission rows
    // and without click commission stays a gap, so the gap sentence holds.
    const bc = result.byClick || {}, byClick = !!bc.available;
    charts.trend({ x: M, y, width: WIDTH, height: 76, matureUntil: byClick ? bc.matureUntil : r.matureUntil,
      commLabel: byClick ? 'Komisi efektif (tanggal klik)' : 'Komisi efektif',
      rows: daily.map(d => ({ date: d.date, spend: d.hasAds === false ? null : d.spend,
        comm: byClick
          ? (!finite(d.commEffByClick) || (d.hasAffiliate === false && !amount(d.commByClick)) ? null : d.commEffByClick)
          : (d.hasAffiliate === false || !finite(d.commEff) ? null : d.commEff) })) });
    y += 78;
    paragraph((byClick ? 'Komisi efektif dicatat pada tanggal klik, jadi setiap hari membandingkan biaya hari itu dengan komisi dari klik hari itu. '
      + (amount(bc.beforeEff) ? money(bc.beforeEff) + ' dari klik sebelum ' + (r.start || '-') + ' tidak tampil. ' : '')
      + (amount(bc.missingEff) ? money(bc.missingEff) + ' tanpa tanggal klik tidak tampil. ' : '')
      + (daily.some(d => d.matureByClick === false) ? 'Area berwarna: belum matang, angkanya masih bisa naik. ' : '')
      : 'Komisi efektif dicatat pada tanggal pesanan. ')
      + 'Garis terputus berarti tidak ada baris sumber; bukan bukti nilai nol.', { size: 7, gap: 1 });
    section('Peta keputusan', integer(tags.length) + ' tag pada periode ini. Keputusan memakai hari matang sampai ' + (r.matureUntil || '-') + '.');
    ensure(35);
    charts.decisions({ x: M, y, width: WIDTH, height: 35,
      items: Object.keys(statusNames).map(status => ({ label: statusNames[status],
        count: tags.filter(t => t.status === status).length, color: statusColors[status] })) });
    y += 38;

    ensure(75); // heading with the money flow and its two cards
    section('Bagaimana laba terbentuk');
    moneyFlow();
    // Completed-only ROAS is a floor: it treats every pending order as cancelled.
    metricGrid([
      ['Komisi organik efektif', money(k.organicComm), 'Termasuk Komisi Efektif'],
      ['Komisi tertunda', money(k.commPending), percent(k.pendingPct) + ' dari komisi laporan'],
      ['Komisi selesai', money(k.commDone), 'ROAS hanya selesai ' + ratio(k.roasDone, amount(k.spend) > 0)],
      ['Pesanan batal', percent(k.cancelRate), 'Menurut nilai ' + percent(k.cancelValueRate)],
    ], 4);

    ensure(118); // heading, note and the bar chart together
    const topTags = tags.slice().sort((a, b) => amount(b.spend) - amount(a.spend) || amount(b.commEff) - amount(a.commEff)).slice(0, 6);
    section('Biaya dan komisi per tag', integer(topTags.length) + ' dari ' + integer(tags.length) + ' tag, diurutkan dari biaya terbesar. Tabel memuat semua tag dengan biaya atau komisi.');
    ensure(93);
    charts.pairedBars({ x: M, y, width: WIDTH, height: 93, leftLabel: 'Biaya + PPN', rightLabel: 'Komisi efektif',
      rows: topTags.map(t => ({ label: t.tag, left: t.spend, right: t.commEff })) });
    y += 99;
    section('Keputusan setiap tag', 'ROAS matang = dasar keputusan. "di batas" = ROAS matang dalam 10% dari ambang yang menentukan vonis. Tanda "-" berarti biaya pembagi tidak tersedia.');
    // A few orders could flip a verdict sitting on its threshold; say so beside it.
    const verdictName = t => (statusNames[t.status] || t.label) + (finite(t.borderAt) ? '\ndi batas' : '');
    table(['Tag', 'Keputusan', 'Biaya + PPN', 'Komisi efektif', 'Laba efektif', 'ROAS matang'], tags.map(t => [
      t.tag, verdictName(t), money(t.spend), money(t.commEff), money(t.netEff), ratio(t.matureRoasEff, amount(t.matureSpend) > 0),
    ]), [45, 25, 30, 30, 30, 22], { numeric: [2, 3, 4, 5], statuses: tags.map(t => t.status) });

    section('Prioritas tindakan');
    table(['Periksa', 'Tag', 'Nilai terkait'], [
      ['Tag berstatus Stop', integer(tags.filter(t => t.status === 'stop').length), money(a.stopLoss) + ' rugi | biaya ' + money(a.stopSpend)
        + (amount(a.leakStopCount) ? ' | ' + integer(a.leakStopCount) + ' tag cek link dulu' : '')],
      ['Bid di atas target', integer(a.overbidCount), money(a.bidSaving) + ' selisih terhadap CPC ideal'],
      // Leaking STOP tags are already counted in the Stop row above.
      ['Link perlu dicek (di luar Stop)', integer(a.leakLiveCount), money(a.leakWasteLive) + ' biaya klik kurang (maks.)'],
    ], [74, 20, 88], { numeric: [1] });
    paragraph('Nilai tindakan adalah batas atas dari data historis. Pada kampanye dengan beberapa iklan, mematikan satu iklan belum tentu mengurangi biaya.', { size: 7 });

    section('Kandidat iklan dari organik', 'Maksimal 8 kandidat seperti pada dashboard. Komisi laporan sebelum bobot tertunda; batas biaya per pesanan memakai komisi efektif dan target ROI.');
    table(['Tag', 'Komisi laporan', 'Pesanan', 'Maks biaya / pesanan', 'Kanal utama'], array(a.organicCandidates).filter(c => !omittedTags.has(c.tag)).map(c => [
      c.tag, money(c.comm), integer(c.orders), amount(c.orders) > 0 ? money(c.maxCpa) : '-', c.topPlatform || '-',
    ]), [46, 36, 20, 40, 40], { numeric: [1, 2, 3], empty: 'Belum ada kandidat organik dengan komisi.' });
    const c = a.concentration, pareto = c ? array(c.groups) : [];
    if (pareto.length && c.rest) {
      const last = pareto[pareto.length - 1], commKnown = amount(c.paidComm) > 0;
      section('Konsentrasi biaya vs komisi', 'Tag diurutkan dari biaya terbesar. Porsi komisi dari komisi efektif tag berbayar; komisi organik tidak dihitung.');
      table(['Kelompok', 'Porsi biaya', 'Porsi komisi efektif', 'ROAS efektif'], pareto.map(g => [
        g.n === 1 ? '1 tag teratas: ' + c.topTag : integer(g.n) + ' tag teratas', percent(g.spendShare),
        percent(g.commShare, commKnown), ratio(g.roasEff, amount(g.spend) > 0),
      ]).concat([[integer(c.rest.n) + ' tag di luar ' + integer(last.n) + ' teratas', percent(c.rest.spendShare),
        percent(c.rest.commShare, commKnown), ratio(c.rest.roasEff, amount(c.rest.spend) > 0)]]),
      [80, 34, 40, 28], { numeric: [1, 2, 3] });
      if (c.noComm && c.noComm.n) paragraph(integer(c.noComm.n) + ' nama iklan berbiaya (' + percent(c.noComm.spendShare)
        + ' biaya) tidak ada di laporan komisi dan dihitung berkomisi 0.', { size: 7 });
    } else if (a.concentration) {
      section('Risiko konsentrasi anggaran');
      metricGrid([
        ['Porsi tag terbesar', percent(a.concentration.topShare), a.concentration.topTag],
        ['Porsi dua tag terbesar', percent(a.concentration.top2Share), 'Dari ' + integer(a.concentration.count) + ' tag berbayar'],
      ], 2);
      y += 2;
      paragraph('Tag terbesar: ' + a.concentration.topTag + ' | ROAS periode ' + ratio(a.concentration.topRoas) + '.', { size: 8 });
    }

    // Direct vs indirect orders (Shopee "Tipe Pesanan"), as in the dashboard card.
    const attribution = result.attribution || {};
    section('Pesanan langsung vs tidak langsung', attribution.column
      ? 'Langsung = produk dari toko yang dipromosikan; tidak langsung = pembeli belanja di toko lain setelah klik link. Komisi laporan (Selesai + Tertunda), tanpa batal dan belum dibayar.'
      : null);
    if (!attribution.column || !attribution.total) {
      paragraph('Laporan komisi periode ini tidak punya kolom Tipe Pesanan, jadi pesanan belum bisa dipisah.');
    } else {
      const at = attribution.total, split = x => amount(x.direct.comm) + amount(x.indirect.comm);
      const share = x => split(x) > 0 ? percent(amount(x.indirect.comm) / split(x) * 100) : '-';
      metricGrid([
        ['Pesanan langsung', integer(at.direct.orders), money(at.direct.comm) + ' komisi'],
        ['Pesanan tidak langsung', integer(at.indirect.orders), money(at.indirect.comm) + ' komisi'],
        ['Porsi komisi tidak langsung', share(at), at.unknown.rows ? integer(at.unknown.orders) + ' pesanan tanpa tipe' : 'Semua baris bertipe'],
      ], 3);
      const attrTags = result.tags.filter(t => t.attr && (t.attr.direct.rows || t.attr.indirect.rows || t.attr.unknown.rows))
        .sort((x, z) => amount(z.comm) - amount(x.comm) || String(x.tag).localeCompare(String(z.tag)));
      table(['Tag', 'Pesanan langsung', 'Komisi langsung', 'Pesanan tidak langsung', 'Komisi tidak langsung', 'Porsi tidak langsung'],
        attrTags.map(t => [t.tag, integer(t.attr.direct.orders), money(t.attr.direct.comm), integer(t.attr.indirect.orders), money(t.attr.indirect.comm), share(t.attr)])
          .concat([['Total akun', integer(at.direct.orders), money(at.direct.comm), integer(at.indirect.orders), money(at.indirect.comm), share(at)]]),
        [50, 24, 28, 26, 28, 26], { numeric: [1, 2, 3, 4, 5] });
      if (mode === 'lengkap') {
        section('Produk terjual per tag, langsung dan tidak langsung', 'Lima produk teratas per jenis menurut komisi laporan; sisanya dijumlah di baris "produk lain".');
        const kindName = { direct: 'Langsung', indirect: 'Tidak langsung', unknown: 'Tanpa tipe' };
        const body = [];
        attrTags.forEach(t => ['direct', 'indirect', 'unknown'].forEach(kind => {
          const items = array(t.attrProducts && t.attrProducts[kind]);
          items.slice(0, 5).forEach(p => body.push([t.tag + '\n' + kindName[kind], p.name + (p.shop ? '\n' + p.shop : ''), integer(p.orders), money(p.comm)]));
          if (items.length > 5) body.push([t.tag + '\n' + kindName[kind], '+' + integer(items.length - 5) + ' produk lain', '-', money(items.slice(5).reduce((sum, p) => sum + amount(p.comm), 0))]);
        }));
        table(['Tag / jenis', 'Produk / toko', 'Pesanan', 'Komisi'], body, [40, 98, 20, 24], { numeric: [2, 3] });
      }
    }

    /* One row per tag with every click cost, the clicks lost before Shopee
       and the direct/indirect split, in every mode: this is the table the
       account owner reads tag by tag. */
    section('Klik, biaya per klik, dan komisi per tag', 'Semua tag dengan biaya atau komisi; nilai uang (Rp) dibulatkan ke rupiah terdekat. Klik masuk Shopee = semua perujuk pada jendela laporan klik. CPC Shopee dan klik hilang memakai jendela itu; klik hilang = klik Meta yang tidak tercatat sebagai klik Shopee' + (bySource ? ' dari Facebook/Instagram' : '') + ', tanda + berarti Shopee mencatat lebih banyak. LP view hanya informasi: Meta jarang melihat aplikasi Shopee terbuka. Langsung/tidak langsung: jumlah pesanan (order) dan komisi laporan menurut kolom Tipe Pesanan.');
    // One value per cell, money as whole rupiah with Rp and counts plain, so every row stays on one line.
    // Rounded from the arriving share itself, like the link note, so the two add up to 100.
    // Takes a tag's leak or a platform's lost share. Both round from the
    // arriving share, as the dashboard does, so "hanya 8%" sits beside 92%.
    const lost = v => {
      const arrived = v && typeof v === 'object' ? v.pct : finite(v) ? 100 - v : null;
      if (!finite(arrived)) return '-';
      const r = 100 - Math.round(arrived);
      return r < 0 ? '+' + integer(-r) + '%' : integer(r) + '%';
    };
    const rupiah = (v, ok = true) => (ok && amount(v) !== 0 ? 'Rp ' + integer(Math.round(amount(v))) : '-');
    const split = attribution.column;
    table(['Tag', 'Klik Meta', 'Klik masuk Shopee', 'CPC Meta', 'LP view', 'Biaya / LP', 'CPC Shopee', 'Klik hilang',
      'Order langsung', 'Komisi langsung', 'Order tidak langsung', 'Komisi tidak langsung'], tags.map(t => [
      t.tag, integer(t.clicks), r.clickStart ? integer(t.shopeeClicks) : '-', rupiah(t.cpc, amount(t.clicks) > 0 && amount(t.spend) > 0),
      amount(t.lpv) > 0 ? integer(t.lpv) : '-', rupiah(t.cpLpv),
      rupiah(t.cpcShopee, amount(t.shopeeClicks) > 0 && amount(t.winSpend) > 0),
      lost(t.leak),
      split && t.attr ? integer(t.attr.direct.orders) : '-', split && t.attr ? rupiah(t.attr.direct.comm) : '-',
      split && t.attr ? integer(t.attr.indirect.orders) : '-', split && t.attr ? rupiah(t.attr.indirect.comm) : '-',
    ]), [31, 12, 13, 13, 10, 14, 14, 12, 15, 16, 15, 17], { numeric: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], fontSize: 7, oneLine: true });

    placementSection();

    if (mode !== 'ringkas') {
      section('Rincian iklan', 'Komisi, pesanan, dan klik Shopee dibagi proporsional dari tag berdasarkan biaya; ini estimasi atribusi. Keputusan mengikuti tag induk.');
      // Copies of one ad in other campaigns share its name; only then is the campaign printed.
      const seenName = new Set(), twin = new Set();
      units.forEach(u => (seenName.has(u.adName) ? twin.add(u.adName) : seenName.add(u.adName)));
      table(['Iklan / tag', 'Penayangan / keputusan', 'Biaya + PPN', 'Komisi efektif / laba', 'Klik / CPC Meta'], units.map(u => [
        u.adName + (twin.has(u.adName) ? '\n' + ([u.campaign, u.adId ? 'Ad ID ' + u.adId : ''].filter(Boolean).join(' · ') || 'tanpa Ad ID') : '') + '\nTag: ' + u.tag, (u.delivery || 'Status tidak tersedia') + '\n' + (u.label || u.status || '-'),
        money(u.spend), money(u.commEff) + '\n' + money(u.netEff), integer(u.clicks) + '\n' + (amount(u.clicks) > 0 ? money(u.cpc) : '-'),
      ]), [51, 31, 31, 38, 31], { numeric: [2, 3, 4], empty: 'Tidak ada iklan pada hasil analisis periode ini.' });

      section('Kinerja harian', 'Tanggal = tanggal pesanan. Angka memakai bobot efektif seperti ringkasan. Tanda "-" berarti tidak ada baris sumber atau pembagi; bukan bukti nilai nol. Laba dan ROAS harian memerlukan baris iklan serta affiliate.');
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
      table(['Tag', 'Keputusan', 'Alasan / langkah berikutnya'], tags.map(t => [t.tag, verdictName(t),
        [t.reason, t.linkNote, t.bidHint].filter(Boolean).join('\n') || '-']), [47, 25, 110], { statuses: tags.map(t => t.status) });
      section('Pencocokan nama iklan dan tag', 'Kandidat pada kecocokan lemah belum dianggap cocok. Periksa pemetaan manual sebelum mengandalkan keputusan tag tersebut.');
      table(['Nama iklan', 'Tag hasil / kandidat', 'Metode / keyakinan', 'Biaya + PPN'], array(result.matchLog).filter(m => !omittedTags.has(m.tag)).map(m => [
        m.adName, m.tag + (m.candidateTag ? '\nKandidat: ' + ((m.candidates && m.candidates.length) ? m.candidates.join(' / ') : m.candidateTag) : ''), m.method + '\n' + percent(amount(m.confidence) * 100), money(m.spend),
      ]), [57, 52, 37, 36], { numeric: [3] });

      section('Perbandingan klik Meta dan Shopee', r.clickStart ? 'Jendela ' + r.clickStart + ' s/d ' + r.clickEnd + '. Selisih positif dapat mencakup klik tambahan di luar iklan; selisih negatif perlu diperiksa.' : 'Tidak tersedia laporan klik pada periode ini.');
      const leaks = tags.filter(t => t.leak && finite(t.leak.pct));
      table(['Tag', 'Klik Meta', bySource ? 'Shopee FB+IG' : 'Klik Shopee', 'Shopee Other', 'Selisih', 'Masuk', 'Biaya klik kurang (maks.)'], leaks.map(t => [
        t.tag, integer(t.leak.metaClicks), integer(t.leak.shopeeClicks), t.shopeeSrc ? integer(t.shopeeSrc.other) : '-',
        integer(amount(t.leak.shopeeClicks) - amount(t.leak.metaClicks)),
        // Same link-health flags as the dashboard; small samples are not judged.
        percent(t.leak.pct) + (t.leak.reliable ? ({ bad: '\ncek link', over: '\nROAS batas atas' }[t.leak.severity] || '') : '\ndata sedikit'),
        money(t.leak.wasted),
      ]), [46, 21, 23, 22, 20, 20, 30], { numeric: [1, 2, 3, 4, 5, 6], empty: 'Perbandingan klik belum dapat dihitung.' });

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

      // The offer row credits each product's whole commission to its offer
      // label, so 'Komisi XTRA' there includes Shopee's base commission.
      section('Sumber komisi', 'Komisi laporan sebelum bobot tertunda. Daftar toko dan kategori terbatas pada 10 teratas sesuai ringkasan mesin; kategori lain tidak dijumlahkan sebagai nol.'
        + ' Baris tipe penawaran menjumlahkan seluruh komisi produk yang dijual dengan penawaran itu, termasuk komisi dasar Shopee; angka ini bukan besar komisi XTRA.');
      const groups = [['Platform', b.platform], ['Toko (top 10)', b.shop], ['Kategori L1 (top 10)', b.category],
        ['Kategori L2 (top 10)', b.category2], ['Tipe penawaran (seluruh komisi produk)', b.offerType], ['Tipe konten', b.contentType]];
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
      + 'Dikecualikan: ' + integer(excluded.cancelled) + ' baris batal (' + integer(excluded.cancelledOrders) + ' pesanan, nilai pesanan '
      + money(excluded.cancelledValue) + (amount(excluded.cancelledMax) > 0 ? '; terbesar ' + money(excluded.cancelledMax) : '')
      + ') dan ' + integer(excluded.unpaid) + ' baris belum dibayar.', { size: 8 });
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
      doc.text(period + ' | PPN biaya iklan ' + ppnPct + ' | Semua nilai uang dalam IDR', M, 288);
      doc.text('Halaman ' + page + ' / ' + totalPages, 196, 288, { align: 'right' });
    }
    return doc;
  }

  return Object.freeze({ create, modes: MODES });
});
