'use strict';

// One look for every on-screen chart. app.js and daily-layer.js used to carry
// two copies of the same defaults, and each chart that passed its own `scales`
// replaced the whole block instead of adding to it: the click chart lost its
// left axis that way and drew all three lines against the order count.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ChartTheme = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  const isPlain = value => value && typeof value === 'object' && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;

  // Deep merge for option objects. Arrays and functions are replaced, not merged.
  function merge(target, ...sources) {
    for (const source of sources) {
      if (!isPlain(source)) continue;
      for (const [key, value] of Object.entries(source)) {
        target[key] = isPlain(value) ? merge(isPlain(target[key]) ? target[key] : {}, value) : value;
      }
    }
    return target;
  }

  // Indonesian decimals use a comma; the dashboard already writes 1.635 for
  // one thousand six hundred thirty-five, so "Rp1.2 jt" read as a thousand.
  const dec = (value, digits) => value.toFixed(digits).replace('.', ',');
  function money(value) {
    if (value == null || !Number.isFinite(value)) return '—';
    const a = Math.abs(value), s = value < 0 ? '-' : '';
    if (a >= 1e9) return s + 'Rp' + dec(a / 1e9, a >= 1e10 ? 0 : 1) + ' M';
    if (a >= 1e6) return s + 'Rp' + dec(a / 1e6, a >= 1e7 ? 0 : 1) + ' jt';
    if (a >= 1e3) return s + 'Rp' + Math.round(a / 1e3) + 'rb';
    return s + 'Rp' + Math.round(a);
  }
  const count = value => value == null || !Number.isFinite(value) ? '—' : Math.round(value).toLocaleString('id-ID');
  const ratio = value => value == null || !Number.isFinite(value) ? '—' : dec(value, 2) + 'x';
  const pct = value => value == null || !Number.isFinite(value) ? '—' : dec(value, value % 1 ? 1 : 0) + '%';
  const FORMAT = { money, count, ratio, pct };
  const fmt = name => FORMAT[name] || count;

  function css(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  // Chart.js falls back to its own font list, which on a machine without
  // Helvetica or Arial renders legends in a serif. Use whatever the page uses.
  function applyDefaults(Chart) {
    const body = getComputedStyle(document.body);
    Chart.defaults.font.family = body.fontFamily;
    Chart.defaults.font.size = 11;
    Chart.defaults.color = css('--text-dim');
    Chart.defaults.borderColor = css('--border');
    Chart.defaults.elements.line.tension = 0;
    Chart.defaults.elements.line.borderWidth = 2;
    Chart.defaults.elements.point.hoverRadius = 5;
    Chart.defaults.elements.bar.borderRadius = 3;
  }

  // Axis ticks drop trailing zeros: 0,5x and 2x, not 0,50x and 2,00x. Money
  // ticks keep the fraction too: a Rp500 step otherwise labels 1.500 and
  // 2.000 both "Rp2rb".
  const trim = value => String(Math.round(value * 100) / 100).replace('.', ',');
  function moneyTick(value) {
    const a = Math.abs(value), s = value < 0 ? '-' : '';
    if (a >= 1e9) return s + 'Rp' + trim(a / 1e9) + ' M';
    if (a >= 1e6) return s + 'Rp' + trim(a / 1e6) + ' jt';
    if (a >= 1e3) return s + 'Rp' + trim(a / 1e3) + 'rb';
    return s + 'Rp' + trim(a);
  }
  const TICK = { money: moneyTick, ratio: value => trim(value) + 'x', pct: value => trim(value) + '%' };

  // An axis that knows how to write its own numbers. Counts get whole steps
  // only; rounding 0,5 order to "1" put two gridlines under the same label.
  function axis(format, extra) {
    const ticks = { callback: value => (TICK[format] || fmt(format))(value) };
    if (format === 'count') ticks.precision = 0;
    return merge({ ticks }, extra || {});
  }

  // A flat dashed line across a chart: break-even, the scale target.
  function reference(label, value, length, color) {
    return { type: 'line', label, data: Array(length).fill(value), borderColor: color,
      borderWidth: 1.5, borderDash: [5, 4], pointRadius: 0, pointHoverRadius: 0, fill: false,
      fmt: 'ratio', order: 0, isReference: true };
  }

  // A one-day chart gives each reference line a single point, and a line of
  // one point draws nothing while the legend still lists it. Draw it across.
  const singleReference = {
    id: 'singleReference',
    afterDatasetsDraw(chart) {
      const { ctx, chartArea, scales } = chart;
      chart.data.datasets.forEach((ds, i) => {
        if (!ds.isReference || ds.data.length > 1 || !chart.isDatasetVisible(i)) return;
        const scale = scales[ds.yAxisID || 'y'], y = scale && scale.getPixelForValue(ds.data[0]);
        if (!Number.isFinite(y)) return;
        ctx.save();
        ctx.strokeStyle = ds.borderColor; ctx.lineWidth = ds.borderWidth; ctx.setLineDash(ds.borderDash || []);
        ctx.beginPath(); ctx.moveTo(chartArea.left, y); ctx.lineTo(chartArea.right, y); ctx.stroke();
        ctx.restore();
      });
    },
  };

  function baseOptions(type, labels) {
    const grid = css('--border'), text = css('--text-dim'), surface = css('--surface'), ink = css('--text');
    const radial = type === 'doughnut' || type === 'pie';
    const options = {
      responsive: true, maintainAspectRatio: false,
      interaction: radial ? { mode: 'nearest', intersect: true } : { mode: 'index', intersect: false },
      datasets: { bar: { maxBarThickness: 44, categoryPercentage: .72, barPercentage: .86 } },
      plugins: {
        legend: { position: radial ? 'right' : 'top', align: radial ? 'center' : 'end',
          labels: { color: text, usePointStyle: true, pointStyle: 'rectRounded', boxWidth: 9, boxHeight: 9, padding: 14 } },
        tooltip: {
          backgroundColor: ink, titleColor: surface, bodyColor: surface, footerColor: surface,
          padding: 10, cornerRadius: 8, boxPadding: 4, usePointStyle: true,
          filter: item => !item.dataset.isReference,
          callbacks: {
            label(ctx) {
              const ds = ctx.dataset, raw = radial ? ctx.parsed : (ctx.chart.options.indexAxis === 'y' ? ctx.parsed.x : ctx.parsed.y);
              let line = (ds.label || ctx.label || '') + ': ' + fmt(ds.fmt)(raw);
              if (radial) {
                const total = ds.data.reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
                if (total > 0) line = ctx.label + ': ' + fmt(ds.fmt)(raw) + ' (' + pct(raw / total * 100) + ')';
              }
              return line;
            },
          },
        },
      },
    };
    if (!radial) {
      // Long date runs wrapped to 45° and became unreadable; skip labels instead.
      const many = (labels || []).length > 16;
      options.scales = {
        x: { grid: { display: false }, border: { color: grid },
          ticks: { color: text, maxRotation: 0, autoSkip: true, autoSkipPadding: many ? 14 : 8 } },
        y: { grid: { color: grid }, border: { display: false }, ticks: { color: text, padding: 6 } },
      };
    }
    return options;
  }

  // Points help when there are a few dates; on a month they are just noise.
  function sizePoints(cfg) {
    const n = (cfg.data.labels || []).length;
    (cfg.data.datasets || []).forEach(ds => {
      const line = ds.type === 'line' || (!ds.type && cfg.type === 'line');
      if (line && ds.pointRadius == null) ds.pointRadius = n <= 1 ? 4 : n <= 14 ? 2.5 : 0;
    });
  }

  function create(Chart, canvas, cfg) {
    applyDefaults(Chart);
    sizePoints(cfg);
    cfg.options = merge(baseOptions(cfg.type, cfg.data.labels), cfg.options || {});
    // Index mode reads along x unless told otherwise, so a horizontal bar
    // chart showed whichever bar ended nearest the pointer, not its own row.
    if (cfg.options.indexAxis === 'y' && cfg.options.interaction && !cfg.options.interaction.axis) cfg.options.interaction.axis = 'y';
    cfg.plugins = (cfg.plugins || []).concat(singleReference);
    return new Chart(canvas, cfg);
  }

  return { merge, money, count, ratio, pct, axis, reference, create, css, singleReference };
}));
