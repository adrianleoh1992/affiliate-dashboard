/* ═══════════════════════════════════════════════════════════════════════════
   AFFILIATE DECISION ENGINE v3
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
  lagCoverage: 90,     // % order yang harus sudah masuk untuk menyarankan lag
  streakDays: 3,       // ROAS<1 sekian hari produksi berturut => STOP
  pendingFactor: 0.95, // bobot komisi berstatus Tertunda
  targetROI: 80,       // % target ROI untuk hitung CPC Ideal
};

/* ── Utils ───────────────────────────────────────────────────────────────── */
function num(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (v == null) return 0;
  const raw = String(v).trim();
  // CSV exports normally contain machine decimals; avoid locale parsing for
  // the common case while still rejecting partial numeric strings.
  if (/^[+\-]?(?:\d+\.?\d*|\.\d+)(?:e[+\-]?\d+)?$/i.test(raw)) {
    const plain = Number(raw);
    return Number.isFinite(plain) ? plain : 0;
  }
  const negative = /^\(.*\)$/.test(raw);
  let value = raw.replace(/[^0-9.,+\-]/g, '');
  const comma = value.lastIndexOf(','), dot = value.lastIndexOf('.');
  if (comma >= 0 && dot >= 0) {
    const decimal = comma > dot ? ',' : '.';
    const grouping = decimal === ',' ? /\./g : /,/g;
    value = value.replace(grouping, '').replace(decimal, '.');
  } else if (comma >= 0) {
    value = /^[+\-]?\d{1,3}(,\d{3})+$/.test(value)
      ? value.replace(/,/g, '') : value.replace(',', '.');
  } else if (dot >= 0 && (value.indexOf('.') !== dot || /^rp\.?\s*\d/i.test(raw))) {
    if (/^[+\-]?\d{1,3}(\.\d{3})+$/.test(value)) value = value.replace(/\./g, '');
  }
  const n = Number(value);
  return Number.isFinite(n) ? (negative ? -Math.abs(n) : n) : 0;
}
function int(v) { return Math.round(num(v)); }
function normalize(s) { return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, ''); }
function tokens(s) {
  return [...new Set(String(s == null ? '' : s).toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 3))];
}
function dayOnly(s) { return String(s == null ? '' : s).trim().split(/[ T]/)[0]; }
function hourOf(s) {
  const m = /[ T](\d{2}):/.exec(String(s == null ? '' : s));
  const h = m ? Number(m[1]) : -1;
  return h >= 0 && h < 24 ? h : null;
}
const dateValidity = new Map();
function isDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  if (dateValidity.has(s)) return dateValidity.get(s);
  const d = new Date(s + 'T00:00:00Z');
  const valid = Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s;
  // Dates repeat thousands of times in an export. Bound the cache so repeated
  // imports cannot accumulate an unbounded history in a long-lived tab.
  if (dateValidity.size >= 1024) dateValidity.clear();
  dateValidity.set(s, valid);
  return valid;
}
function addDays(iso, n) {
  if (!isDate(iso) || !Number.isFinite(Number(n))) return '';
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + Number(n));
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : '';
}
function diffDays(a, b) {
  if (!isDate(a) || !isDate(b)) return NaN;
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}
function dict() { return Object.create(null); }
function normalizeOptions(options) {
  const input = options || {}, out = Object.assign({}, DEFAULTS, input);
  const bounds = {
    ppn: [0, 100], thScale: [0, Infinity], thPantau: [0, Infinity],
    minSpend: [0, Infinity], minDays: [0, Infinity], lagDays: [0, 365],
    lagCoverage: [1, 100], streakDays: [1, Infinity], pendingFactor: [0, 1], targetROI: [0, Infinity],
  };
  Object.keys(bounds).forEach(k => {
    const value = input[k];
    const n = value == null || value === '' ? NaN : Number(value);
    out[k] = Number.isFinite(n) ? Math.max(bounds[k][0], Math.min(bounds[k][1], n)) : DEFAULTS[k];
  });
  ['minDays', 'lagDays', 'streakDays'].forEach(k => { out[k] = Math.round(out[k]); });
  out.thScale = Math.max(out.thScale, out.thPantau);
  return out;
}
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function topOf(obj, n) {
  return Object.keys(obj || {}).map(k => ({ name: k, value: obj[k] }))
    .sort((a, b) => b.value - a.value).slice(0, n || 99);
}

/* ── Column resolution (defensive against header drift) ──────────────────── */
const COL = {
  aff: {
    orderId:  ['ID Pemesanan'],
    status:   ['Status Pesanan'],
    orderAt:  ['Waktu Pemesanan'],
    doneAt:   ['Waktu Terselesaikan'],
    clickAt:  ['Waktu Klik'],
    comm:     ['Total Komisi per Produk(Rp)', 'Total Komisi per Pesanan(Rp)', 'Komisi Bersih Affiliate (Rp)'],
    commNet:  ['Komisi Bersih Affiliate (Rp)'],
    gmv:      ['Nilai Pembelian(Rp)'],
    refund:   ['Jumlah Pengembalian Dana(Rp)'],
    price:    ['Harga(Rp)'],
    qty:      ['Jumlah'],
    tag:      ['Tag_link1'],
    platform: ['Platform'],
    product:  ['Nama Barange', 'Nama Barang'],
    shop:     ['Nama Toko'],
    shopType: ['Tipe toko.', 'Tipe toko'],
    cat:      ['L1 Kategori Global'],
    cat2:     ['L2 Kategori Global'],
    rate:     ['Persentase Komisi Shopee pada Produk'],
    offer:    ['Tipe Penawaran'],
    content:  ['Content Type'],
  },
  ads: {
    date:    ['Reporting starts'],
    name:    ['Ad name', 'Campaign name', 'Ad set name'],
    campaign:['Campaign name'],
    spend:   ['Amount spent (IDR)', 'Amount spent'],
    clicks:  ['Link clicks'],
    impr:    ['Impressions'],
    reach:   ['Reach'],
    freq:    ['Frequency'],
    cpm:     ['CPM (cost per 1,000 impressions) (IDR)'],
    ctr:     ['CTR (link click-through rate)'],
    lpv:     ['Landing page views'],
    results: ['Results'],
    delivery:['Ad delivery'],
    quality: ['Quality ranking'],
    engage:  ['Engagement rate ranking'],
    convRank:['Conversion rate ranking'],
    shopClicks:['shop_clicks'],
    allClicks:['Clicks (all)'],
  },
  clk: {
    time:   ['Waktu Klik', 'click_time', 'Click Time'],
    tag:    ['Tag_link', 'Tag_link1'],
    src:    ['Perujuk', 'Referrer'],
    region: ['Wilayah Klik'],
  },
};
function pick(row, keys) {
  if (!row) return undefined;
  for (const k of keys) if (Object.prototype.hasOwnProperty.call(row, k) && row[k] != null && String(row[k]).trim() !== '') return row[k];
  return undefined;
}
function cleanTag(t) { return String(t == null ? '' : t).trim().replace(/-+$/, '').trim(); }

/* ── File type detection ─────────────────────────────────────────────────── */
function detectFileType(headers) {
  const h = (headers || []).map(x => String(x || '').toLowerCase().trim());
  const has = s => h.some(x => x.includes(s));
  const exact = s => h.some(x => x === s);

  // Click report first — most specific signature, and its headers collide
  // with the affiliate report ("waktu klik" exists in both).
  if (exact('tag_link') || (has('klik id') && has('tag_link'))) return 'clicks';
  if (has('wilayah klik') || has('click_time')) return 'clicks';

  if (has('id pemesanan') || has('total komisi per pesanan') || has('total komisi per produk') || has('tag_link1')) return 'affiliate';
  if (has('waktu pemesanan') || has('status pesanan')) return 'affiliate';

  if (has('reporting starts') || has('amount spent')) return 'ads';
  if (has('ad name') || has('campaign name')) return 'ads';

  return 'unknown';
}

/* ── Ad name → affiliate tag matching ────────────────────────────────────────
   Replaces the old 5-char substring fallback, which could silently bind an ad
   to an unrelated tag (e.g. any two names sharing "video"). Every match now
   carries a method + confidence so the UI can surface weak ones for review.
   ─────────────────────────────────────────────────────────────────────────── */
function extractPipeTag(name) {
  const p = String(name == null ? '' : name).split('|').map(s => s.trim());
  return p.length >= 3 ? p[2] : '';
}

function matchAdToTag(adName, affiliateTags, tagMap) {
  const raw = String(adName == null ? '' : adName);
  const n = normalize(raw);
  if (!n) return { tag: raw, method: 'kosong', confidence: 0 };

  // An explicit correction wins over an embedded pipe tag. Manual mappings
  // apply to the full normalized ad name, never unrelated substring names.
  const map = tagMap || {};
  const manual = Object.keys(map).find(k => normalize(k) === n && String(map[k] || '').trim());
  if (manual !== undefined) return { tag: cleanTag(map[manual]), method: 'Manual', confidence: 1 };

  const piped = extractPipeTag(raw);
  if (piped) {
    const hit = (affiliateTags || []).find(t => normalize(t) === normalize(piped));
    return { tag: hit || cleanTag(piped), method: 'Pipe', confidence: hit ? 1 : 0.8 };
  }

  for (const t of affiliateTags || []) {
    if (normalize(t) === n) return { tag: t, method: 'Exact', confidence: 1 };
  }

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

  const at = tokens(raw);
  if (at.length) {
    let tb = null;
    for (const t of affiliateTags || []) {
      const tt = tokens(t);
      if (!tt.length) continue;
      let shared = 0;
      for (const a of at) {
        // A short fragment such as 'solid' inside 'HelmRsixSolid' is only
        // partial evidence, never the equivalent of a full token match.
        let overlap = 0;
        for (const b of tt) {
          if (b === a) overlap = 1;
          else if ((a.length >= 5 && b.includes(a)) || (b.length >= 5 && a.includes(b))) {
            overlap = Math.max(overlap, Math.min(a.length, b.length) / Math.max(a.length, b.length));
          }
        }
        shared += overlap;
      }
      if (!shared) continue;
      const conf = shared / Math.max(at.length, tt.length);
      if (!tb || conf > tb.confidence) tb = { tag: t, method: 'Token', confidence: conf };
    }
    if (tb && tb.confidence >= 0.5) return tb;
    if (tb && tb.confidence >= 0.3) return { tag: raw, candidateTag: tb.tag, method: 'Lemah', confidence: tb.confidence };
  }

  if (best) return { tag: raw, candidateTag: best.tag, method: 'Lemah', confidence: best.confidence };
  return { tag: raw, method: 'Tidak cocok', confidence: 0 };
}

/* ── Main analysis ───────────────────────────────────────────────────────── */
function analyze(data, options) {
  const o = normalizeOptions(options);
  data = data || {};
  const aff = data.affiliate || [];
  const ads = data.ads || [];
  const clk = data.clicks || [];
  const tagMap = data.tagMap || {};
  const ppnMult = 1 + o.ppn / 100;

  /* Date range: explicit, else auto from data */
  let ds = isDate(o.dateStart) ? o.dateStart : '', de = isDate(o.dateEnd) ? o.dateEnd : '';
  if (!ds || !de) {
    const all = [];
    aff.forEach(r => { const d = dayOnly(pick(r, COL.aff.orderAt)); if (isDate(d)) all.push(d); });
    ads.forEach(r => { const d = dayOnly(pick(r, COL.ads.date)); if (isDate(d)) all.push(d); });
    clk.forEach(r => { const d = dayOnly(pick(r, COL.clk.time)); if (isDate(d)) all.push(d); });
    all.sort();
    ds = ds || all[0] || '';
    de = de || all[all.length - 1] || '';
  }
  if (ds && de && ds > de) [ds, de] = [de, ds];
  const inRange = d => isDate(d) && d >= ds && d <= de;

  /* ── Filter source rows ─────────────────────────────────────────────── */
  const EXCLUDED = { 'Dibatalkan': 1, 'Belum Dibayar': 1 };
  const fAff = [], excluded = { cancelled: 0, unpaid: 0, cancelledValue: 0 };
  const statusCount = dict();
  /* Status per day, counted in ORDERS not product rows — one order carrying
     eight products is one pending order, not eight. Cancelled and unpaid rows
     are dropped from every other calculation, so this is the only place that
     sees them; how much is still hanging is exactly the question it answers. */
  const SKEY = { 'Selesai': 'done', 'Tertunda': 'pending', 'Belum Dibayar': 'unpaid', 'Dibatalkan': 'cancelled' };
  const statusDay = dict();
  aff.forEach(r => {
    const d = dayOnly(pick(r, COL.aff.orderAt));
    if (!inRange(d)) return;
    const st = String(pick(r, COL.aff.status) || '').trim();
    statusCount[st] = (statusCount[st] || 0) + 1;
    const key = Object.prototype.hasOwnProperty.call(SKEY, st) ? SKEY[st] : 'lainnya';
    if (!statusDay[d]) statusDay[d] = {
      date: d, comm: 0, qty: 0,
      done: new Set(), pending: new Set(), unpaid: new Set(), cancelled: new Set(), lainnya: new Set(),
      commBy: { done: 0, pending: 0, unpaid: 0, cancelled: 0, lainnya: 0 },
    };
    const sd = statusDay[d], id = String(pick(r, COL.aff.orderId) || '').trim();
    if (id) sd[key].add(id);
    const c = num(pick(r, COL.aff.comm));
    sd.commBy[key] += c;
    if (key !== 'cancelled') { sd.comm += c; sd.qty += num(pick(r, COL.aff.qty)); }
    if (Object.prototype.hasOwnProperty.call(EXCLUDED, st)) {
      if (st === 'Dibatalkan') { excluded.cancelled++; excluded.cancelledValue += num(pick(r, COL.aff.comm)); }
      else excluded.unpaid++;
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

  /* ── Buckets ────────────────────────────────────────────────────────── */
  const T = dict();
  function bucket(t) {
    if (!T[t]) T[t] = {
      tag: t, comm: 0, commDone: 0, commPending: 0, gmv: 0, qty: 0, refund: 0,
      orders: new Set(), doneOrders: new Set(), pendingOrders: new Set(),
      spend: 0, clicks: 0, impr: 0, reach: 0, lpv: 0, allClicks: 0,
      days: new Set(), daily: dict(), shopeeClicks: 0, metaClicksWindow: 0, spendWindow: 0,
      adNames: dict(), delivery: dict(), quality: dict(), platforms: dict(), shops: dict(), products: dict(),
    };
    return T[t];
  }

  const dailyAll = dict();
  const platform = dict(), category = dict(), category2 = dict(), product = dict(), shop = dict();
  const hourly = new Array(24).fill(0), hourlyOrders = Array.from({ length: 24 }, () => new Set());
  const offerType = dict(), contentType = dict();

  fAff.forEach(r => {
    const t = cleanTag(pick(r, COL.aff.tag)) || '(tanpa tag)';
    const b = bucket(t);
    const c = num(pick(r, COL.aff.comm));
    const g = num(pick(r, COL.aff.gmv));
    const q = int(pick(r, COL.aff.qty));
    const rf = num(pick(r, COL.aff.refund));
    const d = dayOnly(pick(r, COL.aff.orderAt));
    const st = String(pick(r, COL.aff.status) || '').trim();
    const id = String(pick(r, COL.aff.orderId) || '').trim();

    b.comm += c; b.gmv += g; b.qty += q; b.refund += rf;
    if (id) b.orders.add(id);
    if (st === 'Tertunda') { b.commPending += c; if (id) b.pendingOrders.add(id); }
    else { b.commDone += c; if (id) b.doneOrders.add(id); }

    if (!b.daily[d]) b.daily[d] = { comm: 0, spend: 0, clicks: 0, orders: new Set(), gmv: 0 };
    b.daily[d].comm += c; b.daily[d].gmv += g;
    b.daily[d].commEff = (b.daily[d].commEff || 0) + (st === 'Tertunda' ? c * o.pendingFactor : c);
    if (id) b.daily[d].orders.add(id);

    if (!dailyAll[d]) dailyAll[d] = { date: d, comm: 0, spend: 0, clicks: 0, gmv: 0, impr: 0, orders: new Set() };
    dailyAll[d].comm += c; dailyAll[d].gmv += g;
    if (id) dailyAll[d].orders.add(id);

    const h = hourOf(pick(r, COL.aff.orderAt));
    if (h != null) { hourly[h] += c; if (id) hourlyOrders[h].add(id); }

    const pf = String(pick(r, COL.aff.platform) || 'Lainnya');
    platform[pf] = (platform[pf] || 0) + c;
    b.platforms[pf] = (b.platforms[pf] || 0) + c;

    const ct = String(pick(r, COL.aff.cat) || 'Lainnya');
    category[ct] = (category[ct] || 0) + c;
    const ct2 = String(pick(r, COL.aff.cat2) || '');
    if (ct2) category2[ct2] = (category2[ct2] || 0) + c;

    const sh = String(pick(r, COL.aff.shop) || '');
    if (sh) { shop[sh] = (shop[sh] || 0) + c; b.shops[sh] = (b.shops[sh] || 0) + c; }

    const ot = String(pick(r, COL.aff.offer) || '');
    if (ot) offerType[ot] = (offerType[ot] || 0) + c;
    const cty = String(pick(r, COL.aff.content) || '');
    if (cty) contentType[cty] = (contentType[cty] || 0) + c;

    const pn = String(pick(r, COL.aff.product) || '');
    if (pn) {
      if (!product[pn]) product[pn] = { name: pn, comm: 0, gmv: 0, qty: 0, orders: new Set(), tag: t };
      product[pn].comm += c; product[pn].gmv += g; product[pn].qty += q;
      if (id) product[pn].orders.add(id);
      b.products[pn] = (b.products[pn] || 0) + c;
    }
  });

  const affiliateTags = Object.keys(T).filter(t => t && t !== '(tanpa tag)');

  /* ── Ads aggregation + matching (also per ad unit) ──────────────────── */
  const units = dict();
  const matchCache = new Map();
  fAds.forEach(r => {
    const rawName = String(pick(r, COL.ads.name) || '');
    if (!matchCache.has(rawName)) matchCache.set(rawName, matchAdToTag(rawName, affiliateTags, tagMap));
    const m = matchCache.get(rawName);
    const t = m.tag || '(tanpa tag)';
    const b = bucket(t);

    const sp = num(pick(r, COL.ads.spend));
    const spPPN = sp * ppnMult;
    const cl = int(pick(r, COL.ads.clicks));
    const im = int(pick(r, COL.ads.impr));
    const rc = int(pick(r, COL.ads.reach));
    const lp = int(pick(r, COL.ads.lpv));
    const ac = int(pick(r, COL.ads.allClicks));
    const d = dayOnly(pick(r, COL.ads.date));
    const dv = String(pick(r, COL.ads.delivery) || '').trim();
    const ql = String(pick(r, COL.ads.quality) || '').trim();

    b.spend += sp; b.clicks += cl; b.impr += im; b.reach += rc; b.lpv += lp; b.allClicks += ac;
    if (sp > 0 && isDate(d)) b.days.add(d);
    b.adNames[rawName] = (b.adNames[rawName] || 0) + spPPN;
    if (dv) b.delivery[dv] = (b.delivery[dv] || 0) + 1;
    if (ql && ql !== '-') b.quality[ql] = (b.quality[ql] || 0) + 1;

    if (!b.daily[d]) b.daily[d] = { comm: 0, spend: 0, clicks: 0, orders: new Set(), gmv: 0 };
    b.daily[d].spend += spPPN;
    b.daily[d].clicks += cl;

    if (!dailyAll[d]) dailyAll[d] = { date: d, comm: 0, spend: 0, clicks: 0, gmv: 0, impr: 0, orders: new Set() };
    dailyAll[d].spend += spPPN;
    dailyAll[d].clicks += cl;
    dailyAll[d].impr += im;

    if (clkStart && d >= clkStart && d <= clkEnd) { b.metaClicksWindow += cl; b.spendWindow += spPPN; }

    // Per ad unit — the reference dashboard's primary grain
    if (!units[rawName]) units[rawName] = {
      adName: rawName, tag: t, candidateTag: m.candidateTag || '', method: m.method, confidence: m.confidence,
      spend: 0, clicks: 0, impr: 0, reach: 0, lpv: 0, days: new Set(),
      delivery: dict(), quality: dict(), daily: dict(), latestDelivery: null,
    };
    const u = units[rawName];
    u.spend += spPPN; u.clicks += cl; u.impr += im; u.reach += rc; u.lpv += lp;
    if (isDate(d)) {
      if (!u.daily[d]) u.daily[d] = { spend: 0, clicks: 0, impr: 0 };
      u.daily[d].spend += spPPN; u.daily[d].clicks += cl; u.daily[d].impr += im;
    }
    if (sp > 0 && isDate(d)) u.days.add(d);
    if (dv) {
      u.delivery[dv] = (u.delivery[dv] || 0) + 1;
      if (!u.latestDelivery || d >= u.latestDelivery.date) u.latestDelivery = { date: d, name: dv };
    }
    if (ql && ql !== '-') u.quality[ql] = (u.quality[ql] || 0) + 1;
  });

  /* ── Shopee click report ────────────────────────────────────────────── */
  const clickSrc = dict(), clickRegion = dict(), clickDaily = dict();
  fClk.forEach(r => {
    const t = cleanTag(pick(r, COL.clk.tag));
    const d = dayOnly(pick(r, COL.clk.time));
    if (t) {
      const b = bucket(t);
      b.shopeeClicks++;
      // Per tag AND per day, so a single date can be opened up to show which
      // tag lost its clicks that day rather than only the month-wide total.
      if (isDate(d)) {
        if (!b.daily[d]) b.daily[d] = { comm: 0, spend: 0, clicks: 0, orders: new Set(), gmv: 0 };
        b.daily[d].shopeeClicks = (b.daily[d].shopeeClicks || 0) + 1;
      }
    }
    const s = String(pick(r, COL.clk.src) || 'Lainnya');
    clickSrc[s] = (clickSrc[s] || 0) + 1;
    const rg = String(pick(r, COL.clk.region) || '');
    if (rg) clickRegion[rg] = (clickRegion[rg] || 0) + 1;
    if (isDate(d)) {
      clickDaily[d] = (clickDaily[d] || 0) + 1;
      if (!dailyAll[d]) dailyAll[d] = { date: d, comm: 0, spend: 0, clicks: 0, gmv: 0, impr: 0, orders: new Set() };
    }
  });

  /* ── Attribution maturity ───────────────────────────────────────────── */
  const matureUntil = de ? addDays(de, -o.lagDays) : '';
  const isMature = d => !matureUntil || d <= matureUntil;

  const lagHist = dict(), lagOrders = new Set();
  let lagTotal = 0;
  fAff.forEach(r => {
    const ck = dayOnly(pick(r, COL.aff.clickAt));
    const od = dayOnly(pick(r, COL.aff.orderAt));
    if (!isDate(ck) || !isDate(od)) return;
    const g = diffDays(ck, od);
    if (g >= 0 && g <= 30) {
      const id = String(pick(r, COL.aff.orderId) || '').trim();
      if (!id || lagOrders.has(id)) return;
      lagOrders.add(id);
      lagHist[g] = (lagHist[g] || 0) + 1; lagTotal++;
    }
  });
  const lagProfile = Object.keys(lagHist).map(Number).sort((a, b) => a - b)
    .map(d => ({ day: d, count: lagHist[d], pct: lagTotal ? lagHist[d] / lagTotal * 100 : 0 }));
  let cum = 0;
  lagProfile.forEach(x => { cum += x.pct; x.cumulative = cum; });

  /* Lag calibration — the single most decision-changing setting, so derive it
     from the data instead of leaving it to a guessed default. suggested is the
     day by which `lagCoverage`% of orders have landed; anything more recent is
     still filling in and must not drive a STOP. */
  const coverage = o.lagCoverage || 90;
  const covered = lagProfile.find(x => x.cumulative + 1e-9 >= coverage);
  const suggestedLag = covered ? covered.day : (lagProfile.length ? lagProfile[lagProfile.length - 1].day : 0);
  const lagCal = {
    suggested: suggestedLag,
    current: o.lagDays,
    coverage,
    matches: suggestedLag === o.lagDays,
    sameDayPct: lagHist[0] ? lagHist[0] / lagTotal * 100 : 0,
    fullPct: lagProfile.length ? lagProfile[lagProfile.length - 1].day : 0,
    sampleSize: lagTotal,
  };

  /* Settlement curve: how pending resolves as orders age */
  const ageBuckets = dict();
  fAff.forEach(r => {
    const od = dayOnly(pick(r, COL.aff.orderAt));
    if (!isDate(od) || !de) return;
    const age = diffDays(od, de);
    if (age < 0 || age > 30) return;
    const id = String(pick(r, COL.aff.orderId) || '').trim();
    if (!id) return;
    if (!ageBuckets[age]) ageBuckets[age] = { pending: new Set(), total: new Set() };
    ageBuckets[age].total.add(id);
    if (String(pick(r, COL.aff.status) || '').trim() === 'Tertunda') ageBuckets[age].pending.add(id);
  });
  const settlement = Object.keys(ageBuckets).map(Number).sort((a, b) => a - b).map(a => ({
    age: a, pendingPct: ageBuckets[a].total.size ? ageBuckets[a].pending.size / ageBuckets[a].total.size * 100 : 0,
    n: ageBuckets[a].total.size,
  }));

  /* ── Per-tag verdicts ───────────────────────────────────────────────── */
  const targetMult = 1 + o.targetROI / 100;

  function verdictFor(spend, commEff, daysProd, dailyRows, leak, hasPaidSpend) {
    let streak = 0;
    dailyRows.forEach(r => { if (r.roas < 1) streak++; else streak = 0; });
    const streakStop = streak >= o.streakDays;
    const roasEff = spend > 0 ? commEff / spend : (commEff > 0 ? Infinity : 0);

    let status = 'evaluasi', label = 'Belum cukup data', reason = '';
    const qualified = spend > 0 && spend >= o.minSpend && daysProd > 0 && daysProd >= o.minDays;

    if (!hasPaidSpend && commEff > 0) {
      status = 'organik'; label = 'ORGANIK'; reason = 'Komisi tanpa biaya iklan';
    } else if (!qualified) {
      const need = [];
      if (spend <= 0 || spend < o.minSpend) need.push('spend matang belum cukup');
      if (daysProd <= 0 || daysProd < o.minDays) need.push(`baru ${daysProd} hari produksi matang`);
      reason = need.join(', ');
    } else if (streakStop) {
      status = 'stop'; label = 'STOP';
      reason = `ROAS di bawah 1 selama ${streak} hari produksi berturut`;
    } else if (roasEff >= o.thScale) {
      status = 'scale'; label = 'SCALE';
      reason = `ROAS efektif matang ${roasEff.toFixed(2)}x di atas target ${o.thScale}x`;
    } else if (roasEff >= o.thPantau) {
      status = 'pantau'; label = 'PANTAU';
      reason = `ROAS efektif matang ${roasEff.toFixed(2)}x, belum layak scale`;
    } else {
      status = 'stop'; label = 'STOP';
      reason = `ROAS efektif matang ${roasEff.toFixed(2)}x di bawah titik impas`;
    }
    if (leak && leak.severity === 'bad' && status === 'stop') {
      reason = `hanya ${Math.round(leak.pct)}% klik sampai Shopee — cek link sebelum dimatikan`;
    }
    return { status, label, reason, streak };
  }

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
    const margin = commEff > 0 ? netEff / commEff * 100 : 0;

    const cpc = b.clicks > 0 ? spend / b.clicks : 0;
    const cpm = b.impr > 0 ? spend / b.impr * 1000 : 0;
    const ctr = b.impr > 0 ? b.clicks / b.impr * 100 : 0;
    const freq = b.reach > 0 ? b.impr / b.reach : 0;
    const lpvRate = b.clicks > 0 ? b.lpv / b.clicks * 100 : 0;
    const commPerClick = b.clicks > 0 ? commEff / b.clicks : 0;
    const cpcIdeal = b.clicks > 0 ? commPerClick / targetMult : 0;
    const cpcGap = cpcIdeal - cpc;
    const convRate = b.clicks > 0 ? orders / b.clicks * 100 : 0;
    const costPerOrder = orders > 0 ? spend / orders : 0;
    const avgComm = orders > 0 ? b.comm / orders : 0;
    const avgOrder = orders > 0 ? b.gmv / orders : 0;
    const commRate = b.gmv > 0 ? b.comm / b.gmv * 100 : 0;

    const winSpend = b.spendWindow, winClicks = b.metaClicksWindow;
    let leak = null;
    if (clkStart && b.metaClicksWindow > 0) {
      const shopee = b.shopeeClicks;
      const pct = shopee / b.metaClicksWindow * 100;
      const failed = Math.max(b.metaClicksWindow - shopee, 0);
      const wasted = (winSpend / b.metaClicksWindow) * failed;
      leak = {
        metaClicks: b.metaClicksWindow, shopeeClicks: shopee, pct, failed, wasted,
        severity: pct >= 90 ? 'ok' : pct >= 70 ? 'warn' : 'bad',
      };
    }

    const prodDays = Object.keys(b.daily)
      .filter(d => isDate(d) && b.daily[d].spend > 0 && isMature(d)).sort();
    const dailyRows = prodDays.map(d => {
      const dd = b.daily[d];
      return {
        date: d, comm: dd.comm, commEff: dd.commEff || 0, spend: dd.spend, gmv: dd.gmv,
        roas: dd.spend > 0 ? (dd.commEff || 0) / dd.spend : 0,
        orders: dd.orders.size, clicks: dd.clicks,
      };
    });
    /* dailyRows above is deliberately filtered to mature days that had spend,
       because that is what the STOP verdict may look at. Opening one date in
       the daily table needs the opposite: every day this tag did anything. */
    const byDate = dict();
    Object.keys(b.daily).filter(isDate).forEach(d => {
      const dd = b.daily[d];
      const sh = dd.shopeeClicks || 0;
      if (!dd.spend && !dd.comm && !dd.clicks && !dd.orders.size && !sh) return;
      byDate[d] = {
        date: d, comm: dd.comm, spend: dd.spend, gmv: dd.gmv,
        orders: dd.orders.size, clicks: dd.clicks, shopeeClicks: sh,
      };
    });

    const matureDaysProd = prodDays.length;
    const matureSpend = dailyRows.reduce((sum, row) => sum + row.spend, 0);
    const matureCommEff = Object.keys(b.daily).filter(isMature).reduce((sum, d) => sum + (b.daily[d].commEff || 0), 0);
    const matureRoasEff = matureSpend > 0 ? matureCommEff / matureSpend : 0;
    const v = spend > 0
      ? verdictFor(matureSpend, matureCommEff, matureDaysProd, dailyRows, leak, true)
      : verdictFor(spend, commEff, daysProd, dailyRows, leak, false);

    let bidHint = '';
    if (v.status !== 'organik' && v.status !== 'evaluasi' && b.clicks > 0) {
      bidHint = cpcGap > 0 ? `Ruang naik bid s/d ${Math.round(cpcIdeal)}` : `Turunkan bid ke ${Math.round(cpcIdeal)}`;
    }

    /* The click report usually spans fewer days than the ads export. Dividing
       full-range spend by window-only Shopee clicks reads far too high, so the
       Shopee-side cost is matched to the click window on both sides. */
    const shopeeClicks = b.shopeeClicks;
    const cpcShopee = shopeeClicks > 0 && winSpend > 0 ? winSpend / shopeeClicks : 0;

    const activeUnits = Object.keys(b.adNames).length;
    const delivery = topOf(b.delivery, 1)[0];

    return {
      tag: k, comm: b.comm, commDone: b.commDone, commPending: b.commPending, commEff,
      spend, net, netEff, roas, roasEff, roi, margin,
      orders, doneOrders: b.doneOrders.size, pendingOrders: b.pendingOrders.size,
      qty: b.qty, gmv: b.gmv, refund: b.refund,
      clicks: b.clicks, impr: b.impr, reach: b.reach, lpv: b.lpv, lpvRate,
      shopeeClicks, cpcShopee, winSpend, winClicks,
      daysProd, matureDaysProd, matureSpend, matureCommEff, matureRoasEff, cpc, cpm, ctr, freq, cpcIdeal, cpcGap, commPerClick,
      convRate, costPerOrder, avgComm, avgOrder, commRate,
      leak, status: v.status, label: v.label, reason: v.reason, streak: v.streak, bidHint,
      dailyRows, byDate, activeUnits, delivery: delivery ? delivery.name : '',
      topPlatform: topOf(b.platforms, 1)[0] || null,
      topShop: topOf(b.shops, 1)[0] || null,
      adNames: Object.keys(b.adNames),
    };
  }).sort((a, b) => b.spend - a.spend || b.comm - a.comm);

  const tagIndex = dict();
  tags.forEach(t => { tagIndex[t.tag] = t; });

  /* ── Per ad unit rows (reference-style grain) ───────────────────────── */
  const adUnits = Object.keys(units).map(k => {
    const u = units[k];
    const parent = tagIndex[u.tag];
    // Commission is only known at tag level; attribute it to units by spend share.
    const tagSpend = parent ? parent.spend : 0;
    const share = tagSpend > 0 ? u.spend / tagSpend : 0;
    const commEff = parent ? parent.commEff * share : 0;
    const orders = parent ? Math.round(parent.orders * share) : 0;
    const cpc = u.clicks > 0 ? u.spend / u.clicks : 0;
    const cpm = u.impr > 0 ? u.spend / u.impr * 1000 : 0;
    const ctr = u.impr > 0 ? u.clicks / u.impr * 100 : 0;
    const cpcIdeal = u.clicks > 0 ? (commEff / u.clicks) / targetMult : 0;
    /* Shopee only reports clicks per tag. Split them by the same spend share
       used for commission, and carry the tag's Shopee CPC unchanged — two ads
       on one tag cannot be told apart by anything in the data. */
    const shopeeClicks = parent ? Math.round((parent.shopeeClicks || 0) * share) : 0;
    const cpcShopee = parent ? parent.cpcShopee : 0;
    const byDate = dict();
    Object.keys(u.daily).forEach(d => {
      const ud = u.daily[d], pd = parent && parent.byDate ? parent.byDate[d] : null;
      const dayShare = pd && pd.spend > 0 ? ud.spend / pd.spend : 0;
      byDate[d] = {
        date: d, spend: ud.spend, clicks: ud.clicks, impr: ud.impr,
        comm: pd ? pd.comm * dayShare : 0,
        gmv: pd ? pd.gmv * dayShare : 0,
        orders: pd ? Math.round(pd.orders * dayShare) : 0,
        shopeeClicks: pd ? Math.round((pd.shopeeClicks || 0) * dayShare) : 0,
        estimated: dayShare > 0 && dayShare < 1,
      };
    });
    const roasEff = u.spend > 0 ? commEff / u.spend : 0;
    const dv = u.latestDelivery || topOf(u.delivery, 1)[0];
    const active = dv ? /^(active|aktif)$/i.test(dv.name.trim()) : false;
    return {
      adName: k, tag: u.tag, candidateTag: u.candidateTag, method: u.method, confidence: u.confidence,
      spend: u.spend, clicks: u.clicks, impr: u.impr, reach: u.reach, lpv: u.lpv,
      shopeeClicks, cpcShopee, byDate,
      days: u.days.size, cpc, cpm, ctr, cpcIdeal, cpcGap: cpcIdeal - cpc,
      commEff, orders, roasEff, netEff: commEff - u.spend,
      roi: u.spend > 0 ? (commEff - u.spend) / u.spend * 100 : 0,
      convRate: u.clicks > 0 ? orders / u.clicks * 100 : 0,
      costPerOrder: orders > 0 ? u.spend / orders : 0,
      delivery: dv ? dv.name : '', active,
      quality: topOf(u.quality, 1)[0] ? topOf(u.quality, 1)[0].name : '',
      status: parent ? parent.status : 'evaluasi',
      label: parent ? parent.label : 'Belum cukup data',
      estimated: share > 0 && share < 1,
    };
  }).sort((a, b) => b.spend - a.spend);

  const matchLog = adUnits.map(u => ({
    adName: u.adName, tag: u.tag, candidateTag: u.candidateTag, method: u.method, confidence: u.confidence,
    spend: u.spend, clicks: u.clicks,
  }));

  /* ── Portfolio totals ───────────────────────────────────────────────── */
  const sum = f => tags.reduce((s, t) => s + (isFinite(f(t)) ? f(t) : 0), 0);
  const totalSpend = sum(t => t.spend);
  const totalComm = sum(t => t.comm);
  const totalEff = sum(t => t.commEff);
  const totalImpr = sum(t => t.impr);
  const totalClicks = sum(t => t.clicks);
  const allOrders = new Set();
  fAff.forEach(r => { const id = String(pick(r, COL.aff.orderId) || '').trim(); if (id) allOrders.add(id); });

  const paid = tags.filter(t => t.spend > 0);
  const paidSpend = paid.reduce((s, t) => s + t.spend, 0);
  const paidComm = paid.reduce((s, t) => s + t.commEff, 0);
  const organicComm = tags.filter(t => t.status === 'organik').reduce((s, t) => s + t.commEff, 0);

  const kpi = {
    spend: totalSpend,
    comm: totalComm,
    commEff: totalEff,
    commPending: sum(t => t.commPending),
    pendingPct: totalComm > 0 ? sum(t => t.commPending) / totalComm * 100 : 0,
    net: totalComm - totalSpend,
    netEff: totalEff - totalSpend,
    roas: totalSpend > 0 ? totalComm / totalSpend : 0,
    roasEff: totalSpend > 0 ? totalEff / totalSpend : 0,
    roi: totalSpend > 0 ? (totalEff - totalSpend) / totalSpend * 100 : 0,
    paidSpend, paidComm,
    paidRoas: paidSpend > 0 ? paidComm / paidSpend : 0,
    paidNet: paidComm - paidSpend,
    organicComm,
    organicShare: totalEff > 0 ? organicComm / totalEff * 100 : 0,
    orders: allOrders.size,
    gmv: sum(t => t.gmv),
    qty: sum(t => t.qty),
    refund: sum(t => t.refund),
    clicks: totalClicks,
    impr: totalImpr,
    reach: sum(t => t.reach),
    lpv: sum(t => t.lpv),
    cpc: totalClicks > 0 ? totalSpend / totalClicks : 0,
    cpm: totalImpr > 0 ? totalSpend / totalImpr * 1000 : 0,
    ctr: totalImpr > 0 ? totalClicks / totalImpr * 100 : 0,
    convRate: totalClicks > 0 ? allOrders.size / totalClicks * 100 : 0,
    costPerOrder: allOrders.size > 0 ? totalSpend / allOrders.size : 0,
    avgComm: allOrders.size > 0 ? totalComm / allOrders.size : 0,
    avgOrder: allOrders.size > 0 ? sum(t => t.gmv) / allOrders.size : 0,
    commRate: sum(t => t.gmv) > 0 ? totalComm / sum(t => t.gmv) * 100 : 0,
    shopeeClicks: fClk.length,
    wasted: tags.reduce((s, t) => s + (t.leak ? t.leak.wasted : 0), 0),
    leakTags: tags.filter(t => t.leak && t.leak.severity === 'bad').length,
    excluded, statusCount,
    counts: { scale: 0, pantau: 0, stop: 0, organik: 0, evaluasi: 0 },
  };
  tags.forEach(t => { kpi.counts[t.status] = (kpi.counts[t.status] || 0) + 1; });

  const daily = Object.keys(dailyAll).filter(isDate).sort().map(d => {
    const v = dailyAll[d];
    return {
      date: d, comm: v.comm, spend: v.spend, gmv: v.gmv, clicks: v.clicks, impr: v.impr,
      shopeeClicks: clickDaily[d] || 0,
      orders: v.orders.size, net: v.comm - v.spend,
      roas: v.spend > 0 ? v.comm / v.spend : 0,
      roi: v.spend > 0 ? (v.comm - v.spend) / v.spend * 100 : 0,
      cpc: v.clicks > 0 ? v.spend / v.clicks : 0,
      convRate: v.clicks > 0 ? v.orders.size / v.clicks * 100 : 0,
      mature: isMature(d),
    };
  });

  /* ── Actions: turn the verdicts into money, not just labels ─────────────
     The dashboard used to say "turunkan bid" six times without ever adding it
     up. These are the numbers that make the advice worth acting on. */
  const overbid = tags.filter(t => t.status !== 'stop' && t.status !== 'evaluasi' && t.spend > 0 && t.clicks > 0 && t.cpcGap < 0);
  const bidSaving = overbid.reduce((s, t) => s + Math.abs(t.cpcGap) * t.clicks, 0);
  const stopTags = tags.filter(t => t.status === 'stop');
  const stopSpend = stopTags.reduce((s, t) => s + t.spend, 0);
  const stopLoss = Math.abs(stopTags.reduce((s, t) => s + Math.min(t.netEff, 0), 0));
  const leakWaste = tags.reduce((s, t) => s + (t.leak && t.leak.severity === 'bad' ? t.leak.wasted : 0), 0);

  /* Organic tags earn with zero ad spend — the strongest ad candidates in the
     account, previously shown only as a purple badge with no suggestion. */
  const organicCandidates = tags
    .filter(t => t.status === 'organik' && t.comm > 0 && t.tag !== '(tanpa tag)')
    .sort((a, b) => b.comm - a.comm).slice(0, 8)
    .map(t => ({
      tag: t.tag, comm: t.comm, orders: t.orders, gmv: t.gmv, avgComm: t.avgComm,
      // Organic orders supply a cost-per-order ceiling. A CPC ceiling would
      // also require an observed paid click-to-order conversion rate.
      maxCpa: t.orders > 0 ? (t.commEff / t.orders) / targetMult : 0,
      topPlatform: t.topPlatform ? t.topPlatform.name : '',
    }));

  /* Concentration: one product carrying most of the budget is a risk even when
     its ROAS looks acceptable. */
  const paidSorted = paid.slice().sort((a, b) => b.spend - a.spend);
  const concentration = paidSorted.length ? {
    topTag: paidSorted[0].tag,
    topShare: paidSpend > 0 ? paidSorted[0].spend / paidSpend * 100 : 0,
    topRoas: paidSorted[0].roasEff,
    top2Share: paidSpend > 0 ? paidSorted.slice(0, 2).reduce((s, t) => s + t.spend, 0) / paidSpend * 100 : 0,
    count: paidSorted.length,
  } : null;

  const actions = {
    bidSaving, overbidCount: overbid.length,
    stopSpend, stopLoss, stopCount: stopTags.length,
    leakWaste, reclaimable: bidSaving + stopSpend,
    organicCandidates, concentration,
  };

  return {
    range: { start: ds, end: de, matureUntil, clickStart: clkStart, clickEnd: clkEnd },
    options: o,
    kpi, tags, adUnits, daily, matchLog, lagProfile, lagCal, settlement, actions,
    statusDaily: Object.keys(statusDay).filter(isDate).sort().map(d => {
      const v = statusDay[d];
      const done = v.done.size, pending = v.pending.size, unpaid = v.unpaid.size,
            cancelled = v.cancelled.size, other = v.lainnya.size;
      return {
        date: d, done, pending, unpaid, cancelled, other,
        orders: done + pending + unpaid + cancelled + other,
        open: pending + unpaid,
        comm: v.comm, qty: v.qty, commBy: v.commBy,
        settled: done > 0 && pending === 0 && unpaid === 0,
      };
    }),
    breakdown: {
      platform: topOf(platform).map(x => ({ name: x.name, comm: x.value })),
      category: topOf(category, 10).map(x => ({ name: x.name, comm: x.value })),
      category2: topOf(category2, 10).map(x => ({ name: x.name, comm: x.value })),
      shop: topOf(shop, 10).map(x => ({ name: x.name, comm: x.value })),
      offerType: topOf(offerType).map(x => ({ name: x.name, comm: x.value })),
      contentType: topOf(contentType).map(x => ({ name: x.name, comm: x.value })),
      clickSource: topOf(clickSrc).map(x => ({ name: x.name, count: x.value })),
      clickRegion: topOf(clickRegion, 8).map(x => ({ name: x.name, count: x.value })),
      hourly: hourly.map((c, h) => ({ hour: h, comm: c, orders: hourlyOrders[h].size })),
      productByComm: Object.values(product).map(p => ({ ...p, orders: p.orders.size }))
        .sort((a, b) => b.comm - a.comm).slice(0, 15),
      productByQty: Object.values(product).map(p => ({ ...p, orders: p.orders.size }))
        .sort((a, b) => b.qty - a.qty).slice(0, 15),
    },
    counts: { affiliate: fAff.length, ads: fAds.length, clicks: fClk.length },
  };
}

/* ── Verdict stability ──────────────────────────────────────────────────────
   The lag setting is the single most decision-changing input: on the reference
   data, moving it from 0 to 7 flips the STOP count from 5 to 6 and the PANTAU
   count from 1 to 0. A verdict that survives every plausible lag is solid; one
   that flips is worth flagging before money moves. Runs analyze() a few times,
   so call it once per render, not per row. */
function stability(data, options, lags) {
  const probes = lags && lags.length ? lags : [0, 3, 5, 7];
  const runs = probes.map(l => ({
    lag: l,
    result: analyze(data, Object.assign({}, options, { lagDays: l })),
  }));
  const byTag = dict();
  runs.forEach(r => {
    r.result.tags.forEach(t => {
      if (t.spend <= 0) return;
      if (!byTag[t.tag]) byTag[t.tag] = { tag: t.tag, seen: dict(), order: [] };
      byTag[t.tag].seen[t.status] = (byTag[t.tag].seen[t.status] || 0) + 1;
      byTag[t.tag].order.push({ lag: r.lag, status: t.status });
    });
  });
  const tags = Object.keys(byTag).map(k => {
    const b = byTag[k];
    const distinct = Object.keys(b.seen);
    const dominant = distinct.sort((x, y) => b.seen[y] - b.seen[x])[0];
    return {
      tag: k, stable: distinct.length === 1, dominant,
      statuses: distinct, byLag: b.order,
      confidence: b.seen[dominant] / probes.length,
    };
  });
  const counts = runs.map(r => ({ lag: r.lag, counts: r.result.kpi.counts }));
  return {
    probes, tags, counts,
    unstable: tags.filter(t => !t.stable).length,
    total: tags.length,
  };
}
function toSnapshot(result, meta) {
  return {
    id: (meta && meta.id) || Date.now(),
    account: (meta && meta.account) || 'default',
    saved: (meta && meta.saved) || new Date().toISOString().slice(0, 19).replace('T', ' '),
    range: result.range,
    options: result.options,
    kpi: {
      spend: result.kpi.spend, comm: result.kpi.comm, commEff: result.kpi.commEff,
      commPending: result.kpi.commPending, netEff: result.kpi.netEff,
      roasEff: result.kpi.roasEff, roi: result.kpi.roi,
      paidRoas: result.kpi.paidRoas, paidSpend: result.kpi.paidSpend, paidNet: result.kpi.paidNet,
      organicComm: result.kpi.organicComm, organicShare: result.kpi.organicShare,
      orders: result.kpi.orders, gmv: result.kpi.gmv, clicks: result.kpi.clicks,
      cpc: result.kpi.cpc, convRate: result.kpi.convRate, costPerOrder: result.kpi.costPerOrder,
      wasted: result.kpi.wasted, leakTags: result.kpi.leakTags, counts: result.kpi.counts,
    },
    tags: result.tags.filter(t => t.spend > 0 || t.comm > 0).map(t => ({
      tag: t.tag, status: t.status, label: t.label, reason: t.reason,
      spend: t.spend, commEff: t.commEff, netEff: t.netEff, roasEff: t.roasEff, roi: t.roi,
      cpc: t.cpc, cpcIdeal: t.cpcIdeal, orders: t.orders, convRate: t.convRate,
      leakPct: t.leak ? t.leak.pct : null,
    })),
  };
}

/* Build a comparable series from saved snapshots of ONE account.
   Snapshots are deduped by account and full date range so distinct windows
   ending on the same day are retained; the newest save for a period wins. */
function buildTrend(snapshots, account) {
  const rows = (snapshots || [])
    .filter(s => !account || (s.account || 'default') === account)
    .slice()
    .sort((a, b) => String(a.saved).localeCompare(String(b.saved)));

  const byPeriod = dict();
  rows.forEach(s => {
    const range = s.range || {};
    const key = JSON.stringify([range.end || s.saved, range.start || '', s.account || 'default']);
    byPeriod[key] = s;
  });

  const series = Object.keys(byPeriod).sort().map(k => {
    const s = byPeriod[k];
    return {
      period: s.range && s.range.end ? s.range.end : s.saved, saved: s.saved,
      start: s.range ? s.range.start : '', end: s.range ? s.range.end : '',
      spend: s.kpi.spend || 0,
      commEff: s.kpi.commEff || 0,
      netEff: s.kpi.netEff || 0,
      roasEff: s.kpi.roasEff || 0,
      paidRoas: s.kpi.paidRoas || 0,
      organicComm: s.kpi.organicComm || 0,
      organicShare: s.kpi.organicShare || 0,
      orders: s.kpi.orders || 0,
      cpc: s.kpi.cpc || 0,
      convRate: s.kpi.convRate || 0,
      wasted: s.kpi.wasted || 0,
      counts: s.kpi.counts || {},
      tags: s.tags || [],
    };
  });

  // Per-tag trajectory: how each tag's verdict and ROAS moved between saves
  const tagTrend = dict();
  series.forEach((pt, i) => {
    (pt.tags || []).forEach(t => {
      if (!tagTrend[t.tag]) tagTrend[t.tag] = { tag: t.tag, points: [] };
      tagTrend[t.tag].points.push({
        period: pt.period, roasEff: t.roasEff, status: t.status,
        spend: t.spend, netEff: t.netEff, cpc: t.cpc, cpcIdeal: t.cpcIdeal,
      });
    });
  });

  const movers = Object.values(tagTrend).map(tt => {
    const p = tt.points;
    if (p.length < 2) return null;
    const first = p[p.length - 2], last = p[p.length - 1];
    return {
      tag: tt.tag, from: first.roasEff, to: last.roasEff,
      delta: (last.roasEff || 0) - (first.roasEff || 0),
      fromStatus: first.status, toStatus: last.status,
      changed: first.status !== last.status,
      points: p,
    };
  }).filter(Boolean).sort((a, b) => a.delta - b.delta);

  const latest = series[series.length - 1] || null;
  const prev = series.length > 1 ? series[series.length - 2] : null;
  const delta = latest && prev ? {
    spend: latest.spend - prev.spend,
    netEff: latest.netEff - prev.netEff,
    roasEff: latest.roasEff - prev.roasEff,
    paidRoas: latest.paidRoas - prev.paidRoas,
    orders: latest.orders - prev.orders,
    wasted: latest.wasted - prev.wasted,
  } : null;

  return { series, tagTrend, movers, latest, prev, delta };
}

return {
  DEFAULTS, normalizeOptions, analyze, stability, detectFileType, matchAdToTag, toSnapshot, buildTrend,
  normalize, escapeHtml, num, int, dayOnly, hourOf, isDate, addDays, diffDays,
  cleanTag, COL, pick, topOf,
};
});
