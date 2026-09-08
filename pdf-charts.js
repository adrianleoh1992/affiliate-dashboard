/* Small vector charts for offline PDF reports. All coordinates use the document's units (mm). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DashboardPDFCharts = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DAY = 86400000;
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
  const DEFAULT_COLORS = { accent: [16, 111, 107], cost: [210, 112, 64], muted: [88, 105, 113],
    line: [218, 227, 230], ink: [27, 42, 52], pale: [241, 247, 247] };
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const format = (value, digits = 1) => new Intl.NumberFormat('id-ID', {
    minimumFractionDigits: 0, maximumFractionDigits: digits,
  }).format(Object.is(value, -0) ? 0 : value);

  function dateDay(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const instant = Date.parse(value + 'T00:00:00Z');
    if (!Number.isFinite(instant) || new Date(instant).toISOString().slice(0, 10) !== value) return null;
    return instant / DAY;
  }

  function unitFor(values) {
    const largest = values.reduce((max, value) => finite(value) ? Math.max(max, Math.abs(value)) : max, 0);
    if (largest >= 1e12) return { value: 1e12, label: 'Rp triliun', short: ' T' };
    if (largest >= 1e9) return { value: 1e9, label: 'Rp miliar', short: ' M' };
    if (largest >= 1e6) return { value: 1e6, label: 'Rp juta', short: ' jt' };
    if (largest >= 1e3) return { value: 1e3, label: 'Rp ribu', short: ' rb' };
    return { value: 1, label: 'Rp', short: '' };
  }

  function shortMoney(value) {
    if (!finite(value)) return '-';
    const unit = unitFor([value]);
    return 'Rp ' + format(value / unit.value, 1) + unit.short;
  }

  function contrastingText(rgb) {
    const linear = rgb.map(value => {
      const s = Math.max(0, Math.min(255, value)) / 255;
      return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    const luminance = linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
    return (luminance + 0.05) / 0.05 >= 1.05 / (luminance + 0.05) ? [0, 0, 0] : [255, 255, 255];
  }

  function niceStep(value) {
    const power = Math.pow(10, Math.floor(Math.log10(value)));
    const magnitude = value / power;
    return (magnitude <= 1 ? 1 : magnitude <= 2 ? 2 : magnitude <= 2.5 ? 2.5 : magnitude <= 5 ? 5 : 10) * power;
  }

  // Includes zero, pads to readable ticks, and still works for only negative or zero values.
  function numberDomain(values) {
    let low = 0, high = 0;
    for (const value of values) if (finite(value)) { low = Math.min(low, value); high = Math.max(high, value); }
    if (low === high) return { min: 0, max: 1, ticks: [0, 0.25, 0.5, 0.75, 1] };
    const scale = Math.max(Math.abs(low), Math.abs(high));
    const step = niceStep((high - low) / 4);
    let min = Math.floor(low / step + 1e-12) * step;
    let max = Math.ceil(high / step - 1e-12) * step;
    if (!finite(step) || !finite(min) || !finite(max) || !finite(max - min) || step === 0) {
      min = low; max = high;
      return { min, max, ticks: [0, 0.25, 0.5, 0.75, 1].map(t => min * (1 - t) + max * t) };
    }
    const count = Math.round((max - min) / step);
    const ticks = Array.from({ length: count + 1 }, (_, index) => {
      const tick = min + step * index;
      return Math.abs(tick / scale) < 1e-12 ? 0 : Number(tick.toPrecision(12));
    });
    min = ticks[0]; max = ticks[ticks.length - 1];
    return { min, max, ticks };
  }

  function project(value, domain) {
    // Divide first, since subtracting two large finite values can overflow.
    const scale = Math.max(Math.abs(domain.min), Math.abs(domain.max), Number.MIN_VALUE);
    return (value / scale - domain.min / scale) / (domain.max / scale - domain.min / scale);
  }

  function prepareTrend(rows) {
    const points = (Array.isArray(rows) ? rows : []).map(row => ({
      date: row && row.date, day: dateDay(row && row.date),
      spend: row && finite(row.spend) ? row.spend : null,
      comm: row && finite(row.comm) ? row.comm : null,
    })).filter(row => row.day !== null).sort((a, b) => a.day - b.day);
    const start = points.length ? points[0].day : null;
    const end = points.length ? points[points.length - 1].day : null;
    points.forEach(point => { point.position = start === end ? 0.5 : (point.day - start) / (end - start); });
    const segments = { spend: [], comm: [] };
    for (const key of ['spend', 'comm']) {
      let segment = [];
      for (const point of points) {
        if (!finite(point[key])) {
          if (segment.length) segments[key].push(segment);
          segment = [];
        } else {
          // A missing day is a genuine gap, never an implied straight-line daily result.
          if (segment.length && point.day - segment[segment.length - 1].day !== 1) {
            segments[key].push(segment); segment = [];
          }
          segment.push(point);
        }
      }
      if (segment.length) segments[key].push(segment);
    }
    return { points, start, end, segments };
  }

  function create(doc, settings = {}) {
    const font = settings.font || 'helvetica';
    const clean = typeof settings.text === 'function' ? settings.text : value => String(value == null ? '' : value);
    const colors = { ...DEFAULT_COLORS, ...settings.colors };
    const matureFill = [249, 244, 236];

    function color(value, fallback = colors.accent) {
      return Array.isArray(value) && value.length === 3 && value.every(finite)
        ? value.map(part => Math.max(0, Math.min(255, part))) : fallback;
    }
    function label(value, x, y, options = {}) {
      doc.setFont(font, options.bold ? 'bold' : 'normal');
      doc.setFontSize(options.size || 7.5);
      doc.setTextColor(...color(options.color, colors.muted));
      doc.text(clean(value), x, y, { align: options.align || 'left' });
    }
    function stroke(value, width = 0.2) { doc.setDrawColor(...color(value)); doc.setLineWidth(width); }
    function fill(value) { doc.setFillColor(...color(value)); }
    function line(x1, y1, x2, y2, value, width) { stroke(value, width); doc.line(x1, y1, x2, y2); }
    function box(options, minimumHeight) {
      const { x, y, width, height } = options;
      if (![x, y, width, height].every(finite) || width < 70 || height < minimumHeight) {
        throw new Error('Ukuran grafik PDF tidak valid.');
      }
      return { x, y, width, height };
    }
    function clipped(value, width, size = 7.5, maxLines = 1) {
      doc.setFont(font, 'normal'); doc.setFontSize(size);
      const text = clean(value).replace(/[\r\n\t]+/g, ' ').trim();
      const lines = doc.splitTextToSize(text, width);
      if (lines.length <= maxLines) return lines.length ? lines : [''];
      const result = lines.slice(0, maxLines);
      let chars = Array.from(result[maxLines - 1].trimEnd());
      while (chars.length && doc.getTextWidth(chars.join('') + '...') > width) chars.pop();
      result[maxLines - 1] = chars.join('').trimEnd() + '...';
      return result;
    }
    function legend(value, x, y, swatch, width) {
      line(x, y - 0.8, x + 5, y - 0.8, swatch, 0.75);
      label(clipped(value, width - 8, 7.5)[0], x + 7, y);
    }
    function empty(message, x, y, width, height) {
      fill(colors.pale); doc.rect(x, y, width, height, 'F');
      const lines = clipped(message, width - 12, 8, 2);
      lines.forEach((value, index) => label(value, x + width / 2, y + height / 2 + index * 3.4,
        { align: 'center', size: 8 }));
    }
    function scaledLabel(value, unit, domain) {
      const span = domain.max / unit.value - domain.min / unit.value;
      const digits = span < 0.1 ? 3 : span < 1 ? 2 : span < 10 ? 1 : 0;
      return format(value / unit.value, digits);
    }

    function trend(options) {
      const { x, y, width, height } = box(options, 44);
      const model = prepareTrend(options.rows);
      const third = width / 3;
      legend('Biaya + PPN', x, y + 4, colors.cost, third);
      legend('Komisi efektif', x + third, y + 4, colors.accent, third);
      const mature = dateDay(options.matureUntil);
      const hasRecent = mature !== null && model.points.some(point => point.day > mature);
      if (hasRecent) {
        fill(matureFill); doc.rect(x + third * 2, y + 1.3, 4, 3, 'F');
        label(clipped('Belum matang', third - 7, 7.5)[0], x + third * 2 + 6, y + 4);
      }
      const left = x + 18, top = y + 14, plotWidth = width - 23, plotHeight = height - 25;
      if (!model.points.some(point => finite(point.spend) || finite(point.comm))) {
        empty('Data harian belum tersedia.', x, y + 11, width, height - 13);
        return model;
      }
      const values = model.points.flatMap(point => [point.spend, point.comm]);
      const domain = numberDomain(values), unit = unitFor(values);
      label(unit.label, x, y + 10.5, { size: 7 });
      if (hasRecent) {
        const fraction = model.start === model.end ? 0 : Math.max(0, Math.min(1,
          (mature + 0.5 - model.start) / (model.end - model.start)));
        fill(matureFill); doc.rect(left + plotWidth * fraction, top, plotWidth * (1 - fraction), plotHeight, 'F');
      }
      for (const tick of domain.ticks) {
        const ty = top + plotHeight * (1 - project(tick, domain));
        line(left, ty, left + plotWidth, ty, tick === 0 ? colors.muted : colors.line, tick === 0 ? 0.3 : 0.15);
        label(scaledLabel(tick, unit, domain), left - 2, ty + 0.8, { align: 'right', size: 7 });
      }
      const candidates = [];
      const maxLabels = Math.max(2, Math.min(7, Math.floor(plotWidth / 22)));
      for (let index = 0; index < maxLabels; index++) {
        const target = index / (maxLabels - 1);
        const nearest = model.points.reduce((best, point) =>
          Math.abs(point.position - target) < Math.abs(best.position - target) ? point : best, model.points[0]);
        if (!candidates.includes(nearest)) candidates.push(nearest);
      }
      let previousLabelRight = -Infinity;
      for (const point of candidates) {
        const date = new Date(point.day * DAY), stamp = date.getUTCDate() + ' ' + MONTHS[date.getUTCMonth()];
        const tx = left + point.position * plotWidth;
        doc.setFontSize(7);
        const halfWidth = doc.getTextWidth(clean(stamp)) / 2;
        if (tx - halfWidth < previousLabelRight + 2) continue;
        line(tx, top + plotHeight, tx, top + plotHeight + 1, colors.line, 0.2);
        label(stamp, tx, top + plotHeight + 4.8, { align: 'center', size: 7 });
        previousLabelRight = tx + halfWidth;
      }
      for (const key of ['spend', 'comm']) {
        const swatch = key === 'spend' ? colors.cost : colors.accent;
        for (const segment of model.segments[key]) {
          for (let index = 1; index < segment.length; index++) {
            const previous = segment[index - 1], point = segment[index];
            line(left + previous.position * plotWidth, top + plotHeight * (1 - project(previous[key], domain)),
              left + point.position * plotWidth, top + plotHeight * (1 - project(point[key], domain)), swatch, 0.7);
          }
          fill(swatch);
          for (const point of segment) doc.circle(left + point.position * plotWidth,
            top + plotHeight * (1 - project(point[key], domain)), model.points.length > 45 ? 0.4 : 0.65, 'F');
        }
      }
      return { ...model, domain };
    }

    function pairedBars(options) {
      const { x, y, width, height } = box(options, 38);
      const rows = (Array.isArray(options.rows) ? options.rows : []).map(row => ({
        label: row && row.label || '(tanpa tag)',
        left: row && finite(row.left) ? row.left : null,
        right: row && finite(row.right) ? row.right : null,
      }));
      legend(options.leftLabel || 'Biaya + PPN', x, y + 4, colors.cost, width / 2);
      legend(options.rightLabel || 'Komisi efektif', x + width / 2, y + 4, colors.accent, width / 2);
      if (!rows.length) {
        empty('Belum ada tag untuk dibandingkan.', x, y + 11, width, height - 13);
        return { rows, domain: numberDomain([]) };
      }
      const values = rows.flatMap(row => [row.left, row.right]);
      const domain = numberDomain(values), unit = unitFor(values);
      const labelWidth = Math.min(46, Math.max(24, width * 0.27));
      const left = x + labelWidth, top = y + 15, plotWidth = width - labelWidth - 7;
      const plotHeight = height - 25, rowHeight = plotHeight / rows.length;
      const origin = left + plotWidth * project(0, domain);
      label(unit.label, left + plotWidth, y + 10.5, { size: 7, align: 'right' });
      for (const tick of domain.ticks) {
        const tx = left + plotWidth * project(tick, domain);
        line(tx, top, tx, top + plotHeight, tick === 0 ? colors.muted : colors.line, tick === 0 ? 0.35 : 0.15);
        label(scaledLabel(tick, unit, domain), tx, top + plotHeight + 4.8, { size: 7, align: 'center' });
      }
      rows.forEach((row, index) => {
        const center = top + rowHeight * (index + 0.5);
        const name = clipped(row.label, labelWidth - 4, 7.2, 2);
        name.forEach((value, lineIndex) => label(value, x, center + (lineIndex - (name.length - 1) / 2) * 3 + 0.8,
          { size: 7.2, color: colors.ink }));
        const barHeight = Math.min(2.6, rowHeight * 0.29), gap = Math.min(0.8, rowHeight * 0.09);
        ['left', 'right'].forEach((key, seriesIndex) => {
          const swatch = seriesIndex === 0 ? colors.cost : colors.accent;
          const barY = center + (seriesIndex === 0 ? -barHeight - gap / 2 : gap / 2);
          if (!finite(row[key])) {
            label('-', Math.min(origin + 1.1, left + plotWidth - 2), barY + barHeight / 2 + 0.8,
              { size: 7, color: colors.muted });
            return;
          }
          const end = left + plotWidth * project(row[key], domain), barWidth = Math.abs(end - origin);
          if (barWidth > 0) { fill(swatch); doc.rect(Math.min(origin, end), barY, barWidth, barHeight, 'F'); }
          const value = scaledLabel(row[key], unit, domain);
          doc.setFontSize(7);
          const valueWidth = doc.getTextWidth(clean(value));
          let tx, align, textColor;
          if (barWidth > valueWidth + 3) {
            tx = end + (row[key] < 0 ? 1.1 : -1.1); align = row[key] < 0 ? 'left' : 'right'; textColor = contrastingText(swatch);
          } else if (row[key] < 0) {
            tx = Math.max(left + valueWidth + 1, end - 1.1); align = 'right'; textColor = colors.ink;
          } else {
            tx = Math.min(left + plotWidth - valueWidth - 1, end + 1.1); align = 'left'; textColor = colors.ink;
          }
          label(value, tx, barY + barHeight / 2 + 0.8, { align, size: 7, color: textColor });
        });
      });
      return { rows, domain, origin };
    }

    function decisions(options) {
      const { x, y, width, height } = box(options, 27);
      const items = (Array.isArray(options.items) ? options.items : []).map(item => ({
        label: item && item.label || 'Lainnya',
        count: item && finite(item.count) && item.count > 0 ? Math.trunc(item.count) : 0,
        color: color(item && item.color),
      }));
      const total = items.reduce((sum, item) => sum + item.count, 0);
      const barY = y + 1, barHeight = 6;
      fill(colors.pale); doc.rect(x, barY, width, barHeight, 'F');
      let start = x;
      if (total > 0) items.forEach(item => {
        const segmentWidth = width * (item.count / total);
        if (segmentWidth > 0) {
          fill(item.color); doc.rect(start, barY, segmentWidth, barHeight, 'F');
          doc.setFontSize(8);
          const value = format(item.count, 0);
          if (doc.getTextWidth(clean(value)) + 3 <= segmentWidth) {
            label(value, start + segmentWidth / 2, barY + 4.1,
              { align: 'center', size: 8, bold: true, color: contrastingText(item.color) });
          }
        }
        start += segmentWidth;
      });
      else label('Belum ada tag', x + width / 2, barY + 4.1, { align: 'center', size: 8 });
      const columns = width >= 125 ? 3 : 2;
      const cellWidth = width / columns, rowCount = Math.ceil(items.length / columns);
      const rowHeight = Math.min(8, (height - 12) / Math.max(1, rowCount));
      items.forEach((item, index) => {
        const cellX = x + (index % columns) * cellWidth;
        const cellY = y + 14 + Math.floor(index / columns) * rowHeight;
        const value = format(item.count, 0);
        doc.setFont(font, 'bold'); doc.setFontSize(8);
        const numberWidth = doc.getTextWidth(clean(value));
        fill(item.color); doc.rect(cellX, cellY - 2, 2.2, 2.2, 'F');
        label(clipped(item.label, cellWidth - numberWidth - 11, 7.5)[0], cellX + 4.2, cellY,
          { size: 7.5, color: colors.ink });
        label(value, cellX + cellWidth - 5, cellY, { size: 8, bold: true, align: 'right', color: colors.ink });
      });
      return { items, total };
    }

    return { trend, pairedBars, decisions };
  }

  return { create, numberDomain, prepareTrend, shortMoney, dateDay, contrastingText };
});
