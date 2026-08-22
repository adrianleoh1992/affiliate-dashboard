/* ═══════════════════════════════════════════════════════════════════════════
   AFFILIATE DECISION ENGINE v2
   Pure calculation layer — no DOM. Runs in browser and in Node (for tests).
   ═══════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Engine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

/* ── Defaults ────────────────────────────────────────────────────────────── */
const DEFAULTS = {
  ppn: 11,             // % PPN atas biaya iklan
  thScale: 2.0,        // ROAS >= => SCALE
  thPantau: 1.0,       // ROAS >= => PANTAU
  minSpend: 50000,     // Rp minimum sebelum tag boleh divonis
  minDays: 3,          // hari produksi minimum sebelum tag boleh divonis
  lagDays: 3,          // hari terakhir dianggap "belum matang" (atribusi menyusul)
  streakDays: 3,       // ROAS<1 sekian hari produksi berturut => STOP
  pendingFactor: 0.95, // bobot komisi berstatus Tertunda
  targetROI: 80,       // % target ROI untuk hitung CPC Ideal
};

/* ── Utils ───────────────────────────────────────────────────────────────── */
function num(v) {
  if (v == null) return 0;
  const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return isFinite(n) ? n : 0;
}
function int(v) { return Math.round(num(v)); }
function normalize(s) { return (s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
function tokens(s) {
  return (s || '').toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 3);
}
function dayOnly(s) { return (s || '').trim().split(' ')[0]; }
function isDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s || ''); }
function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function diffDays(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* ── Column resolution (defensive against header drift) ──────────────────── */
const COL = {
  aff: {
    orderId:  ['ID Pemesanan'],
    status:   ['Status Pesanan'],
    orderAt:  ['Waktu Pemesanan'],
    clickAt:  ['Waktu Klik'],
    comm:     ['Total Komisi per Pesanan(Rp)', 'Komisi Bersih Affiliate (Rp)'],
    gmv:      ['Nilai Pembelian(Rp)'],
    qty:      ['Jumlah'],
    tag:      ['Tag_link1'],
    platform: ['Platform'],
    product:  ['Nama Barange', 'Nama Barang'],
    cat:      ['L1 Kategori Global'],
  },
  ads: {
    date:   ['Reporting starts'],
    name:   ['Ad name', 'Campaign name', 'Ad set name'],
    spend:  ['Amount spent (IDR)', 'Amount spent'],
    clicks: ['Link clicks'],
    impr:   ['Impressions'],
    status: ['Ad delivery'],
  },
  clk: {
    time: ['Waktu Klik', 'click_time', 'Click Time'],
    tag:  ['Tag_link', 'Tag_link1'],
    src:  ['Perujuk', 'Referrer'],
  },
};
function pick(row, keys) {
  for (const k of keys) if (row[k] !== undefined) return row[k];
  return undefined;
}
function cleanTag(t) { return String(t == null ? '' : t).replace(/-+$/, '').trim(); }

/* ── File type detection ─────────────────────────────────────────────────── */
function detectFileType(headers) {
  const h = (headers || []).map(x => String(x || '').toLowerCase().trim());
  const has = s => h.some(x => x.includes(s));
  const exact = s => h.some(x => x === s);

  // Click report first — most specific signature, and its headers collide
  // with the affiliate report ("waktu klik" exists in both).
  if (exact('tag_link') || (has('klik id') && has('tag_link'))) return 'clicks';
  if (has('wilayah klik') || has('click_time')) return 'clicks';

  // Affiliate commission report
  if (has('id pemesanan') || has('total komisi per pesanan') || has('tag_link1')) return 'affiliate';
  if (has('waktu pemesanan') || has('status pesanan')) return 'affiliate';

  // Meta ads report
  if (has('reporting starts') || has('amount spent')) return 'ads';
  if (has('ad name') || has('campaign name')) return 'ads';

  return 'unknown';
}

/* ── Ad name → affiliate tag matching ────────────────────────────────────────
   Replaces the old 5-char substring fallback, which could silently bind an ad
   to an unrelated tag (e.g. any two names sharing "video"). Now every match
   carries a method + confidence so the UI can surface weak ones for review.
   ─────────────────────────────────────────────────────────────────────────── */
function extractPipeTag(name) {
  const p = (name || '').split('|').map(s => s.trim());
  return p.length >= 3 ? p[2] : '';
}

function matchAdToTag(adName, affiliateTags, tagMap) {
  const raw = adName || '';
  const n = normalize(raw);
  if (!n) return { tag: raw, method: 'kosong', confidence: 0 };

  // 1. Pipe convention: "1204 | Mentok | TagName"
  const piped = extractPipeTag(raw);
  if (piped) {
    const hit = (affiliateTags || []).find(t => normalize(t) === normalize(piped));
    return { tag: hit || piped, method: 'Pipe', confidence: hit ? 1 : 0.8 };
  }

  // 2. User-managed mapping table — always wins
  const map = tagMap || {};
  if (map[n]) return { tag: map[n], method: 'Manual', confidence: 1 };
  for (const k of Object.keys(map)) {
    if (k && (n === k || n.includes(k) || k.includes(n))) {
      return { tag: map[k], method: 'Manual', confidence: 1 };
    }
  }

  // 3. Exact normalized match
  for (const t of affiliateTags || []) {
    if (normalize(t) === n) return { tag: t, method: 'Exact', confidence: 1 };
  }

  // 4. Full containment, longest tag wins (avoids short-tag hijack)
  let best = null;
  for (const t of affiliateTags || []) {
    const nt = normalize(t);
    if (nt.length < 4) continue;
    if (n.includes(nt) || nt.includes(n)) {
      const conf = Math.min(nt.length, n.length) / Math.max(nt.length, n.length);
      if (!best || conf > best.confidence) best = { tag: t, method: 'Contains', confidence: conf };
    }
  }
  if (best && best.confidence >= 0.55) return best;

  // 5. Token overlap — requires real shared words, not incidental substrings
  const at = tokens(raw);
  if (at.length) {
    let tb = null;
    for (const t of affiliateTags || []) {
      const tt = tokens(t);
      if (!tt.length) continue;
      let shared = 0;
      for (const a of at) {
        if (tt.some(b => b === a || (a.length >= 5 && b.includes(a)) || (b.length >= 5 && a.includes(b)))) shared++;
      }
      if (!shared) continue;
      const conf = shared / Math.max(at.length, tt.length);
      if (!tb || conf > tb.confidence) tb = { tag: t, method: 'Token', confidence: conf };
    }
    if (tb && tb.confidence >= 0.5) return tb;
    if (tb && tb.confidence >= 0.3) return { ...tb, method: 'Lemah' };
  }

  if (best) return { ...best, method: 'Lemah' };
  return { tag: raw, method: 'Tidak cocok', confidence: 0 };
}

/* ── Main analysis ───────────────────────────────────────────────────────── */
function analyze(data, options) {
  const o = Object.assign({}, DEFAULTS, options || {});
  const aff = data.affiliate || [];
  const ads = data.ads || [];
  const clk = data.clicks || [];
  const tagMap = data.tagMap || {};
  const ppnMult = 1 + o.ppn / 100;

  /* Date range: explicit, else auto from data */
  let ds = o.dateStart, de = o.dateEnd;
  if (!ds || !de) {
    const all = [];
    aff.forEach(r => { const d = dayOnly(pick(r, COL.aff.orderAt)); if (isDate(d)) all.push(d); });
    ads.forEach(r => { const d = dayOnly(pick(r, COL.ads.date)); if (isDate(d)) all.push(d); });
    all.sort();
    ds = ds || all[0] || '';
    de = de || all[all.length - 1] || '';
  }
  const inRange = d => d && d >= ds && d <= de;

  /* ── Filter source rows ─────────────────────────────────────────────── */
  const EXCLUDED = { 'Dibatalkan': 1, 'Belum Dibayar': 1 };
  const fAff = [], excluded = { cancelled: 0, unpaid: 0 };
  aff.forEach(r => {
    const d = dayOnly(pick(r, COL.aff.orderAt));
    if (!inRange(d)) return;
    const st = String(pick(r, COL.aff.status) || '');
    if (EXCLUDED[st]) {
      if (st === 'Dibatalkan') excluded.cancelled++; else excluded.unpaid++;
      return;
    }
    fAff.push(r);
  });
  const fAds = ads.filter(r => inRange(dayOnly(pick(r, COL.ads.date))));
  const fClk = clk.filter(r => inRange(dayOnly(pick(r, COL.clk.time))));

  /* Click report often covers a shorter window than ads — leakage must only
     be computed on the overlap, otherwise every tag looks like it is leaking. */
  let clkStart = '', clkEnd = '';
  if (fClk.length) {
    const cd = fClk.map(r => dayOnly(pick(r, COL.clk.time))).filter(isDate).sort();
    clkStart = cd[0]; clkEnd = cd[cd.length - 1];
  }

  /* ── Affiliate aggregation ──────────────────────────────────────────── */
  const T = {};
  function bucket(t) {
    if (!T[t]) T[t] = {
      tag: t, comm: 0, commDone: 0, commPending: 0, gmv: 0, qty: 0,
      orders: new Set(), spend: 0, clicks: 0, impr: 0, days: new Set(),
      daily: {}, shopeeClicks: 0, metaClicksWindow: 0,
    };
    return T[t];
  }
  const dailyAll = {};
  const platform = {}, category = {}, product = {};

  fAff.forEach(r => {
    const t = cleanTag(pick(r, COL.aff.tag)) || '(tanpa tag)';
    const b = bucket(t);
    const c = num(pick(r, COL.aff.comm));
    const g = num(pick(r, COL.aff.gmv));
    const d = dayOnly(pick(r, COL.aff.orderAt));
    const st = String(pick(r, COL.aff.status) || '');

    b.comm += c; b.gmv += g; b.qty += int(pick(r, COL.aff.qty));
    b.orders.add(pick(r, COL.aff.orderId));
    if (st === 'Tertunda') b.commPending += c; else b.commDone += c;

    if (!b.daily[d]) b.daily[d] = { comm: 0, spend: 0, clicks: 0, orders: new Set() };
    b.daily[d].comm += c;
    b.daily[d].orders.add(pick(r, COL.aff.orderId));

    if (!dailyAll[d]) dailyAll[d] = { date: d, comm: 0, spend: 0, clicks: 0, gmv: 0, orders: new Set() };
    dailyAll[d].comm += c; dailyAll[d].gmv += g;
    dailyAll[d].orders.add(pick(r, COL.aff.orderId));

    const pf = String(pick(r, COL.aff.platform) || 'Lainnya');
    platform[pf] = (platform[pf] || 0) + c;
    const ct = String(pick(r, COL.aff.cat) || 'Lainnya');
    category[ct] = (category[ct] || 0) + c;
    const pn = String(pick(r, COL.aff.product) || '');
    if (pn) {
      if (!product[pn]) product[pn] = { name: pn, comm: 0, gmv: 0, qty: 0 };
      product[pn].comm += c; product[pn].gmv += g;
      product[pn].qty += int(pick(r, COL.aff.qty));
    }
  });

  const affiliateTags = Object.keys(T).filter(t => t && t !== '(tanpa tag)');

  /* ── Ads aggregation + matching ─────────────────────────────────────── */
  const matchLog = [], seen = {};
  fAds.forEach(r => {
    const rawName = String(pick(r, COL.ads.name) || '');
    const m = matchAdToTag(rawName, affiliateTags, tagMap);
    if (rawName && !seen[rawName]) {
      seen[rawName] = 1;
      matchLog.push({ adName: rawName, tag: m.tag, method: m.method, confidence: m.confidence, spend: 0, clicks: 0 });
    }
    const entry = matchLog.find(x => x.adName === rawName);

    const t = m.tag || '(tanpa tag)';
    const b = bucket(t);
    const sp = num(pick(r, COL.ads.spend));
    const cl = int(pick(r, COL.ads.clicks));
    const im = int(pick(r, COL.ads.impr));
    const d = dayOnly(pick(r, COL.ads.date));

    b.spend += sp; b.clicks += cl; b.impr += im;
    if (sp > 0 && isDate(d)) b.days.add(d);
    if (entry) { entry.spend += sp * ppnMult; entry.clicks += cl; }

    if (!b.daily[d]) b.daily[d] = { comm: 0, spend: 0, clicks: 0, orders: new Set() };
    b.daily[d].spend += sp * ppnMult;
    b.daily[d].clicks += cl;

    if (!dailyAll[d]) dailyAll[d] = { date: d, comm: 0, spend: 0, clicks: 0, gmv: 0, orders: new Set() };
    dailyAll[d].spend += sp * ppnMult;
    dailyAll[d].clicks += cl;

    // Meta clicks restricted to the click-report window, for leakage parity
    if (clkStart && d >= clkStart && d <= clkEnd) b.metaClicksWindow += cl;
  });

  /* ── Shopee click report ────────────────────────────────────────────── */
  const clickSrc = {};
  fClk.forEach(r => {
    const t = cleanTag(pick(r, COL.clk.tag));
    if (t && T[t]) T[t].shopeeClicks++;
    else if (t) bucket(t).shopeeClicks++;
    const s = String(pick(r, COL.clk.src) || 'Lainnya');
    clickSrc[s] = (clickSrc[s] || 0) + 1;
  });

  /* ── Attribution maturity ───────────────────────────────────────────────
     Orders keep arriving for days after the click. Days inside the lag window
     are still filling in, so their ROAS reads artificially low and must never
     drive a STOP verdict. ──────────────────────────────────────────────── */
  const matureUntil = de ? addDays(de, -o.lagDays) : '';
  const isMature = d => !matureUntil || d <= matureUntil;

  /* Observed lag profile, straight from the data */
  const lagHist = {};
  let lagTotal = 0;
  fAff.forEach(r => {
    const ck = dayOnly(pick(r, COL.aff.clickAt));
    const od = dayOnly(pick(r, COL.aff.orderAt));
    if (!isDate(ck) || !isDate(od)) return;
    const g = diffDays(ck, od);
    if (g >= 0 && g <= 30) { lagHist[g] = (lagHist[g] || 0) + 1; lagTotal++; }
  });
  const lagProfile = Object.keys(lagHist).map(Number).sort((a, b) => a - b)
    .map(d => ({ day: d, count: lagHist[d], pct: lagTotal ? lagHist[d] / lagTotal * 100 : 0 }));
  let cum = 0;
  lagProfile.forEach(x => { cum += x.pct; x.cumulative = cum; });

  /* ── Per-tag verdicts ───────────────────────────────────────────────── */
  const targetMult = 1 + o.targetROI / 100;
  const tags = Object.keys(T).map(k => {
    const b = T[k];
    const spend = b.spend * ppnMult;
    const commEff = b.commDone + b.commPending * o.pendingFactor;
    const orders = b.orders.size;
    const daysProd = b.days.size;

    const roas = spend > 0 ? b.comm / spend : (b.comm > 0 ? Infinity : 0);
    const roasEff = spend > 0 ? commEff / spend : (commEff > 0 ? Infinity : 0);
    const net = b.comm - spend;
    const netEff = commEff - spend;
    const roi = spend > 0 ? (netEff / spend) * 100 : 0;

    const cpc = b.clicks > 0 ? spend / b.clicks : 0;
    const cpm = b.impr > 0 ? spend / b.impr * 1000 : 0;
    const commPerClick = b.clicks > 0 ? commEff / b.clicks : 0;
    // Highest CPC that still clears the ROI target at the current earn-rate
    const cpcIdeal = b.clicks > 0 ? commPerClick / targetMult : 0;
    const cpcGap = cpcIdeal - cpc;
    const convRate = b.clicks > 0 ? orders / b.clicks * 100 : 0;
    const costPerOrder = orders > 0 ? spend / orders : 0;
    const avgComm = orders > 0 ? b.comm / orders : 0;

    /* Click leakage — only meaningful when both sides cover the same window */
    let leak = null;
    if (clkStart && b.metaClicksWindow > 0) {
      const shopee = b.shopeeClicks;
      const pct = shopee / b.metaClicksWindow * 100;
      const failed = Math.max(b.metaClicksWindow - shopee, 0);
      const wasted = b.metaClicksWindow > 0 ? (spend / Math.max(b.clicks, 1)) * failed : 0;
      leak = {
        metaClicks: b.metaClicksWindow, shopeeClicks: shopee,
        pct, failed, wasted,
        severity: pct >= 90 ? 'ok' : pct >= 70 ? 'warn' : 'bad',
      };
    }

    /* Consecutive sub-1 ROAS streak over mature production days only */
    const prodDays = Object.keys(b.daily)
      .filter(d => isDate(d) && b.daily[d].spend > 0 && isMature(d))
      .sort();
    let streak = 0, worstStreak = 0, streakRun = [];
    const dailyRows = prodDays.map(d => {
      const dd = b.daily[d];
      const r = dd.spend > 0 ? dd.comm / dd.spend : 0;
      if (r < 1) { streak++; streakRun.push({ date: d, roas: r }); if (streak > worstStreak) worstStreak = streak; }
      else { streak = 0; streakRun = []; }
      return { date: d, comm: dd.comm, spend: dd.spend, roas: r, orders: dd.orders.size, clicks: dd.clicks };
    });
    const tailStreak = streak; // streak that is still running at the end
    const streakStop = tailStreak >= o.streakDays;

    /* Verdict — requires BOTH enough spend AND enough production days.
       The v1 engine used OR, which let a single big-spend day trigger STOP. */
    let status = 'evaluasi', label = 'Belum cukup data', reason = '';
    const qualified = spend >= o.minSpend && daysProd >= o.minDays;

    if (spend === 0 && b.comm > 0) {
      status = 'organik'; label = 'ORGANIK';
      reason = 'Komisi tanpa biaya iklan';
    } else if (!qualified) {
      const need = [];
      if (spend < o.minSpend) need.push('spend belum cukup');
      if (daysProd < o.minDays) need.push(`baru ${daysProd} hari produksi`);
      reason = need.join(', ');
    } else if (streakStop) {
      status = 'stop'; label = 'STOP';
      reason = `ROAS di bawah 1 ${tailStreak} hari produksi berturut`;
    } else if (roasEff >= o.thScale) {
      status = 'scale'; label = 'SCALE';
      reason = `ROAS efektif ${roasEff.toFixed(2)}x di atas target ${o.thScale}x`;
    } else if (roasEff >= o.thPantau) {
      status = 'pantau'; label = 'PANTAU';
      reason = `ROAS efektif ${roasEff.toFixed(2)}x, belum layak scale`;
    } else {
      status = 'stop'; label = 'STOP';
      reason = `ROAS efektif ${roasEff.toFixed(2)}x di bawah titik impas`;
    }

    /* Leakage overrides the diagnosis: the creative may be fine, the link is not */
    if (leak && leak.severity === 'bad' && status === 'stop') {
      reason = `${Math.round(leak.pct)}% klik sampai Shopee — cek link sebelum dimatikan`;
    }

    /* Bid guidance from CPC headroom */
    let bidHint = '';
    if (status !== 'organik' && status !== 'evaluasi' && b.clicks > 0) {
      if (cpcGap > 0) bidHint = `Ruang naik bid s/d ${Math.round(cpcIdeal)}`;
      else bidHint = `Turunkan bid ke ${Math.round(cpcIdeal)}`;
    }

    return {
      tag: k, comm: b.comm, commDone: b.commDone, commPending: b.commPending, commEff,
      spend, net, netEff, roas, roasEff, roi, orders, qty: b.qty, gmv: b.gmv,
      clicks: b.clicks, impr: b.impr, daysProd, cpc, cpm, cpcIdeal, cpcGap,
      commPerClick, convRate, costPerOrder, avgComm,
      leak, status, label, reason, bidHint,
      streak: tailStreak, worstStreak, streakRun, dailyRows,
    };
  }).sort((a, b) => b.spend - a.spend || b.comm - a.comm);

  /* ── Portfolio totals ───────────────────────────────────────────────── */
  const sum = f => tags.reduce((s, t) => s + (isFinite(f(t)) ? f(t) : 0), 0);
  const totalSpend = sum(t => t.spend);
  const totalComm = sum(t => t.comm);
  const totalEff = sum(t => t.commEff);
  const totalPending = sum(t => t.commPending);
  const allOrders = new Set();
  fAff.forEach(r => allOrders.add(pick(r, COL.aff.orderId)));

  const kpi = {
    spend: totalSpend,
    comm: totalComm,
    commEff: totalEff,
    commPending: totalPending,
    pendingPct: totalComm > 0 ? totalPending / totalComm * 100 : 0,
    net: totalComm - totalSpend,
    netEff: totalEff - totalSpend,
    roas: totalSpend > 0 ? totalComm / totalSpend : 0,
    roasEff: totalSpend > 0 ? totalEff / totalSpend : 0,
    roi: totalSpend > 0 ? (totalEff - totalSpend) / totalSpend * 100 : 0,
    orders: allOrders.size,
    gmv: sum(t => t.gmv),
    qty: sum(t => t.qty),
    clicks: sum(t => t.clicks),
    shopeeClicks: fClk.length,
    wasted: tags.reduce((s, t) => s + (t.leak ? t.leak.wasted : 0), 0),
    excluded,
  };

  const daily = Object.keys(dailyAll).filter(isDate).sort().map(d => {
    const v = dailyAll[d];
    return {
      date: d, comm: v.comm, spend: v.spend, gmv: v.gmv, clicks: v.clicks,
      orders: v.orders.size, net: v.comm - v.spend,
      roas: v.spend > 0 ? v.comm / v.spend : 0,
      mature: isMature(d),
    };
  });

  const rank = (obj, key) => Object.keys(obj)
    .map(k => (typeof obj[k] === 'object' ? obj[k] : { name: k, comm: obj[k] }))
    .sort((a, b) => (b[key] || b.comm) - (a[key] || a.comm)).slice(0, 10);

  return {
    range: { start: ds, end: de, matureUntil, clickStart: clkStart, clickEnd: clkEnd },
    options: o,
    kpi, tags, daily, matchLog, lagProfile,
    breakdown: {
      platform: Object.keys(platform).map(k => ({ name: k, comm: platform[k] })).sort((a, b) => b.comm - a.comm),
      category: Object.keys(category).map(k => ({ name: k, comm: category[k] })).sort((a, b) => b.comm - a.comm).slice(0, 10),
      productByComm: rank(product, 'comm'),
      productByQty: Object.values(product).sort((a, b) => b.qty - a.qty).slice(0, 10),
      clickSource: Object.keys(clickSrc).map(k => ({ name: k, count: clickSrc[k] })).sort((a, b) => b.count - a.count),
    },
    counts: { affiliate: fAff.length, ads: fAds.length, clicks: fClk.length },
  };
}

return {
  DEFAULTS, analyze, detectFileType, matchAdToTag,
  normalize, escapeHtml, num, int, dayOnly, isDate, addDays, diffDays, cleanTag, COL, pick,
};
});
