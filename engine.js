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
/* Link health (README 5.6): under 25% of paid clicks arriving means the link or
   sub_id is likely wrong; 25-70% is often just very cheap clicks; over 120% means
   the tag also gets traffic from outside its ads, so its ROAS is an upper bound.
   Judged only after enough paid clicks in the click window. */
const LINK = { low: 25, warn: 70, over: 120, minClicks: 300 };
// Comma decimals, matching the dashboard and PDF: 1,25x rather than 1.25x.
function ratioText(n) { return n.toFixed(2).replace('.', ','); }
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
    attr:     ['Tipe Atribusi', 'Jenis Atribusi', 'Atribusi', 'Attribution Type', 'Tipe Pesanan', 'Jenis Pesanan'],
  },
  ads: {
    date:    ['Reporting starts'],
    id:      ['Ad ID'],
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
/* Direct vs indirect order. Shopee marks each commission row as an order of
   the linked item/shop (langsung) or of something else the buyer bought after
   the click (tidak langsung). Shopee's report (Oct 2026) calls the column
   "Tipe Pesanan": "Pesanan Produk dari Toko yang Dipromosikan" (direct) and
   "Pesanan dari Toko yang tidak Dipromosikan" (indirect). Older or English
   exports may word it differently, so both are read leniently; anything that does not clearly say one or the
   other stays unknown rather than being guessed. "tidak langsung" contains
   "langsung", so the indirect test runs first. */
function attrKind(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (!s) return '';
  if (/tidak\s*langsung|tidak\s*dipromosikan|indirect|berbeda|different/.test(s)) return 'indirect';
  if (/langsung|dipromosikan|direct|sama|same/.test(s)) return 'direct';
  return '';
}
function attrColumn(rows) {
  const keys = new Set();
  for (const r of (rows || []).slice(0, 50)) Object.keys(r || {}).forEach(k => keys.add(k));
  for (const k of COL.aff.attr) if (keys.has(k)) return k;
  for (const k of keys) if (/atribusi|attribution/i.test(k)) return k;
  return '';
}

function cleanTag(t) { return String(t == null ? '' : t).trim().replace(/-+$/, '').trim(); }
/* Shopee Video traffic carries no sub_id: Shopee fills Platform (commission
   report) or Perujuk (click report) with "Shopeevideo-Shopee" and leaves the
   tag empty. It is its own channel, so it gets a name instead of "(tanpa tag)". */
const SHOPEE_VIDEO = 'Shopee Video';
function isShopeeVideo(v) { return /^shopee\s*video/i.test(String(v == null ? '' : v).trim()); }

/* Exact means the same letters in the same case. Shopee keeps
   "MaskerDuckbill" (an ad) and "Maskerduckbill" (an organic post) as two
   different sub_ids, and joining them case-blind put the ad's spend on the
   organic tag with a false "cek link". Spaces and punctuation still do not
   count, so "Isi 24 Pcs" is Isi24Pcs. */
function strictKey(s) { return String(s == null ? '' : s).replace(/[^A-Za-z0-9]/g, ''); }

/* Finds the tag a name spells exactly. A tag spelled identically wins; two
   tags that differ only in punctuation are a tie and resolve to nothing.
   With keepDash the "-" counts, for the click report, where it separates
   sub_id slots: "BantalTidur-2309A" is BantalTidur with 2309A in slot two,
   not the tag BantalTidur2309A. */
function tagLookup(tags) {
  const same = new Set(), byKey = new Map(), byDash = new Map();
  const add = (map, k, t) => { if (k) map.set(k, map.has(k) && map.get(k) !== t ? null : t); };
  for (const t of tags || []) {
    if (!t) continue;
    same.add(t);
    add(byKey, strictKey(t), t);
    add(byDash, dashKey(t), t);
  }
  return (s, keepDash) => (same.has(s) ? s : (keepDash ? byDash.get(dashKey(s)) : byKey.get(strictKey(s))) || '');
}
function dashKey(s) { return String(s == null ? '' : s).replace(/[^A-Za-z0-9-]/g, ''); }

/* The click report packs all five sub-id slots into ONE column, joined by
   dashes: "tag1-tag2-tag3-tag4-tag5". Stripping the trailing dashes leaves a
   second slot glued on, so "TelesinGripvideo2-promo" never joined the
   commission report's "TelesinGripvideo2": the tag showed 0 clicks and 0%
   arriving — a STOP verdict on a healthy ad — while a phantom tag held all
   7.226 of its clicks and no spend.

   The report always writes all five slots, so a value with exactly four
   dashes has none inside a slot and its first part is slot one. With more
   dashes some slot holds one, and slot one is only cut where a known tag
   ends. Values in any other shape (a single Tag_link1 column) are split at
   the first dash only when the commission report knows that part. `known` is
   a tagLookup() over the commission report's tags, and it follows the same
   case rule as the ad matching: both reports come from one tracking system,
   so a click spelled differently is a different sub_id. */
function resolveClickTag(raw, known) {
  const t = cleanTag(raw);
  if (!t) return t;
  const parts = String(raw).trim().split('-');
  // Exactly five slots means no slot holds a dash: slot one is certain.
  if (parts.length === 5 && parts[0].trim()) return known(parts[0].trim()) || parts[0].trim();
  const whole = known(t, true);
  if (whole) return whole;
  if (parts.length > 5) {
    // Slots two to five empty: everything before them is slot one.
    if (parts.slice(-4).every(x => !x.trim())) return t;
    // Otherwise slot one holds some of the extra dashes; the longest known
    // prefix it can be wins.
    for (let j = parts.length - 4; j >= 1; j--) {
      const hit = known(parts.slice(0, j).join('-').trim(), true);
      if (hit) return hit;
    }
    return t;
  }
  const first = t.split('-')[0].trim();
  return (first && known(first)) || t;
}

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
/* The number at the end of an ad name is not noise — it is the identity of the
   creative. "Telesin Video 1", "2" and "3" are three different ads, and the
   tokenizer drops anything shorter than three characters, so all three produced
   the identical token list ["telesin","video"] and every one of them matched
   TelesinGripvideo2 at full confidence. Three ads' spend collapsed onto one
   tag, and the two that were wrong looked as certain as the one that was right.

   So: when both names carry a number, the numbers have to agree. When only one
   side has one, it says nothing either way and the match proceeds. */
function variantOf(s) {
  const m = String(s || '').toLowerCase().match(/\d+/g);
  return m ? m[m.length - 1] : '';
}
function variantClash(a, b) {
  const va = variantOf(a), vb = variantOf(b);
  return !!va && !!vb && va !== vb;
}

/* Forgiving match for names typed a little differently from the tag —
   "Lemari Olympic" for OlymplastLemari, "Telesin video 2" for
   TelesinGripvideo2. This is what lets people skip setup, so it has to stay,
   but a single shared fragment must never be enough: "solid" alone may not
   take HelmRsixSolid's spend. So the overlap is measured from BOTH sides —
   most of the ad name has to be found in the tag, and most of the tag has to
   be accounted for by the ad name — and two near-equal tags is a tie, not a
   pick. Letters only; the trailing number is judged by variantClash. */
function wordsOf(s) {
  return [...new Set(String(s == null ? '' : s).replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase().split(/[^a-z]+/).filter(w => w.length >= 3))];
}
function longestCommon(a, b) {
  let best = 0;
  const prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let diag = 0;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j];
      prev[j] = a[i - 1] === b[j - 1] ? diag + 1 : 0;
      if (prev[j] > best) best = prev[j];
      diag = up;
    }
  }
  return best;
}
function overlapScore(raw, tag) {
  const words = wordsOf(raw), nt = normalize(tag).replace(/\d+/g, '');
  if (!words.length || !nt) return null;
  let found = 0, total = 0, hits = 0;
  for (const w of words) {
    total += w.length;
    const common = longestCommon(w, nt);
    // A fragment only counts when it is most of the word: "vid" of "vidio"
    // is a typo of "video", the "car" of "carpet" is not a car.
    if (common >= 3 && common / w.length >= 0.6) { found += common; hits++; }
  }
  if (!hits) return null;
  const nameCov = found / total, tagCov = Math.min(1, found / nt.length);
  return { nameCov, tagCov, hits, score: Math.min(nameCov, tagCov) };
}
function forgivingMatch(raw, affiliateTags) {
  const ranked = [];
  for (const t of affiliateTags || []) {
    if (variantClash(raw, t)) continue;
    const s = overlapScore(raw, t);
    if (s && s.nameCov >= 0.75 && s.tagCov >= 0.6 && (s.hits >= 2 || s.tagCov >= 0.8)) ranked.push({ tag: t, s });
  }
  if (!ranked.length) return null;
  ranked.sort((a, b) => b.s.score - a.s.score);
  const top = ranked[0];
  const confidence = Math.min(0.9, top.s.score);
  const tied = ranked.filter(r => top.s.score - r.s.score < 0.05);
  if (tied.length > 1) return ambiguous(raw, tied.map(r => ({ tag: r.tag, confidence: r.s.score })));
  return { tag: top.tag, method: 'Mirip', confidence };
}

/* A name that fits several tags equally well — "Atasan" against AtasanViolet,
   AtasanRebecca and AtasanFadfad — says nothing about which one it is. Taking
   whichever tag happened to come first put that ad's spend, and its verdict,
   on a product it may not be. Offer every fitting tag instead; the Matching
   tab turns each into a one-click mapping, so asking costs one click. */
function ambiguous(raw, ranked) {
  const list = ranked.slice().sort((a, b) => b.confidence - a.confidence);
  return { tag: raw, candidateTag: list[0].tag, candidates: list.slice(0, 5).map(x => x.tag),
           method: 'Ambigu', confidence: Math.min(0.45, list[0].confidence) };
}

function extractPipeTag(name) {
  const p = String(name == null ? '' : name).split('|').map(s => s.trim());
  return p.length >= 3 ? p[2] : '';
}

function matchAdToTag(adName, affiliateTags, tagMap, noPipe) {
  const raw = String(adName == null ? '' : adName);
  const n = normalize(raw);
  if (!n) return { tag: raw, method: 'kosong', confidence: 0 };

  // An explicit correction wins over an embedded pipe tag. Manual mappings
  // apply to the full ad name, never unrelated substring names. A mapping
  // holds for the spelling it was written in. One in lower case (as every
  // mapping saved before case mattered is) also holds for other spellings,
  // except one with an exact sub_id of its own: mapping "maskerduckbill"
  // must not take MaskerDuckbill off its tag.
  const find = tagLookup(affiliateTags);
  const map = tagMap || {}, key = strictKey(raw);
  const keys = Object.keys(map).filter(k => String(map[k] || '').trim());
  let manual = keys.find(k => strictKey(k) === key);
  if (manual === undefined && !find(raw)) manual = keys.find(k => strictKey(k) === normalize(k) && normalize(k) === n);
  if (manual !== undefined) return { tag: cleanTag(map[manual]), method: 'Manual', confidence: 1 };

  const piped = noPipe ? '' : extractPipeTag(raw);
  if (piped) {
    const hit = find(piped);
    if (hit) return { tag: hit, method: 'Pipe', confidence: 1 };
    /* No tag is spelled like the segment. Stopping here invented a tag out of
       the campaign's own words — "1604 | Mentok | Telesin Grip" became a tag
       called "Telesin Grip" sitting beside the real TelesinGripvideo2. Run the
       segment through the same matching as any other name instead, and cap the
       result: this is an inference two steps removed, never a certainty. */
    const deep = matchAdToTag(piped, affiliateTags, tagMap, true);
    if (deep.confidence > 0 && !deep.candidateTag) {
      return { tag: deep.tag, method: 'Pipe+' + deep.method,
               confidence: Math.min(deep.confidence, 0.85) };
    }
    /* Nothing in the Shopee data is named like this segment. Keeping it as its
       own tag is still the most useful answer — the spend has to land
       somewhere visible — but calling that 80% certain was wrong. It is a
       guess, and the Matching table should say so. */
    const guess = { tag: cleanTag(piped), method: 'Pipe tanpa tag', confidence: 0.4 };
    if (deep.candidateTag) guess.candidateTag = deep.candidateTag;
    if (deep.candidates) guess.candidates = deep.candidates;
    return guess;
  }

  const exact = find(raw);
  if (exact) return { tag: exact, method: 'Exact', confidence: 1 };

  /* Everything below only suggests. On the September data the near matches
     were wrong for 78% of the spend they moved: LanaInstanHijabVID and
     LanaInstanHijabVIDEO have sub_ids of their own, yet their spend went to
     LanaInstanHijab and dragged its ROAS from 0,70 to 0,49. The ad keeps its
     own name until someone picks a tag; picking is one click in the Matching
     tab and is remembered. Exact names already cover 89–99% of spend. */
  const cased = (affiliateTags || []).filter(t => normalize(t) === n);
  if (cased.length > 1) return ambiguous(raw, cased.map(t => ({ tag: t, confidence: 0.45 })));
  if (cased.length) return suggestion(raw, { tag: cased[0], method: 'Beda huruf', confidence: 0.45 });
  const loose = looseMatch(raw, n, affiliateTags);
  return loose ? suggestion(raw, loose) : { tag: raw, method: 'Tidak cocok', confidence: 0 };
}

// A near match offered for review: the spend stays on the ad's own name, and
// the confidence stays under 0.5, the line the app reads as "not assigned".
function suggestion(raw, m) {
  if (m.candidateTag) return Object.assign({}, m, { confidence: Math.min(0.45, m.confidence) });
  return { tag: raw, candidateTag: m.tag, method: m.method, confidence: Math.min(0.45, m.confidence) };
}

function looseMatch(raw, n, affiliateTags) {
  let best = null;
  const holders = [];   // tags that contain the whole ad name
  for (const t of affiliateTags || []) {
    const nt = normalize(t);
    if (nt.length < 4) continue;
    if (variantClash(raw, t)) continue;
    if (n.includes(nt) || nt.includes(n)) {
      const conf = Math.min(nt.length, n.length) / Math.max(nt.length, n.length);
      if (!best || conf > best.confidence) best = { tag: t, method: 'Contains', confidence: conf };
      if (nt.includes(n)) holders.push({ tag: t, confidence: conf });
    }
  }
  // A tag inside the ad name is specific; the ad name inside several tags is not.
  if (best && best.confidence >= 0.55) {
    return holders.length > 1 && holders.some(h => h.tag === best.tag) ? ambiguous(raw, holders) : best;
  }

  const near = forgivingMatch(raw, affiliateTags);
  const at = tokens(raw);
  if (at.length) {
    let tb = null;
    const scored = [];
    for (const t of affiliateTags || []) {
      if (variantClash(raw, t)) continue;
      const tt = tokens(t);
      if (!tt.length) continue;
      let shared = 0, sig = '';
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
        sig += overlap ? '1' : '0';
      }
      if (!shared) continue;
      const conf = shared / Math.max(at.length, tt.length);
      scored.push({ tag: t, confidence: conf, sig });
      if (!tb || conf > tb.confidence) tb = { tag: t, method: 'Token', confidence: conf, sig };
    }
    if (tb && tb.confidence >= 0.5) {
      // Rivals rest on exactly the same words of the ad name: nothing in the
      // name tells them apart, only how long each tag happens to be.
      const rivals = scored.filter(x => x.sig === tb.sig && x.confidence >= 0.3);
      if (rivals.length > 1) return ambiguous(raw, rivals);
      return { tag: tb.tag, method: 'Token', confidence: tb.confidence };
    }
    if (near) return near;
    if (tb && tb.confidence >= 0.3) return { tag: raw, candidateTag: tb.tag, method: 'Lemah', confidence: tb.confidence };
  }

  if (near) return near;
  if (best) return { tag: raw, candidateTag: best.tag, method: 'Lemah', confidence: best.confidence };
  return null;
}

/* An Ad ID that went through a spreadsheet comes back rounded to 15 digits —
   scientific notation, or trailing zeros — and two ads made minutes apart can
   round to the same number. Only an intact ID may identify an ad; a genuine
   ID that happens to end in zeros just falls back to its name. */
function intactAdId(v) {
  const id = String(v == null ? '' : v).trim();
  if (!/^\d{6,20}$/.test(id)) return '';
  return id.length > 15 && /^0+$/.test(id.slice(15)) ? '' : id;
}
/* Whether a damaged ID cell can be the intact `id`: the value it shows must
   round to the same number at the precision it kept — 15 significant digits
   for trailing zeros, the mantissa's digits for scientific notation. */
function idAgrees(cell, id) {
  const s = String(cell == null ? '' : cell).trim();
  let value, unit;
  const sci = /^(\d)(?:[.,](\d+))?e\+?(\d{1,2})$/i.exec(s);
  if (sci) {
    const frac = sci[2] || '', exp = Number(sci[3]);
    if (exp < frac.length) return false;
    value = BigInt(sci[1] + frac) * 10n ** BigInt(exp - frac.length);
    unit = 10n ** BigInt(exp - frac.length);
  } else if (/^\d{16,20}$/.test(s)) {
    value = BigInt(s); unit = 10n ** BigInt(s.length - 15);
  } else return false;
  const diff = BigInt(id) - value;
  return (diff < 0n ? -diff : diff) * 2n <= unit;
}

/* ── Main analysis ───────────────────────────────────────────────────────── */
function analyze(data, options) {
  const o = normalizeOptions(options);
  data = data || {};
  const aff = data.affiliate || [];
  const ads = data.ads || [];
  const clk = data.clicks || [];
  const tagMap = data.tagMap || {};
  const adIdMap = data.adIdMap || {};
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
  const fAff = [], excluded = { cancelled: 0, unpaid: 0, cancelledValue: 0, cancelledOrders: 0, cancelledMax: 0 };
  // Shopee zeroes commission on cancelled rows; what was lost is the order
  // value, which sits in the refund column or, for some rows, the purchase value.
  const cancelledByOrder = new Map();
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
      if (st === 'Dibatalkan') {
        const value = num(pick(r, COL.aff.refund)) + num(pick(r, COL.aff.gmv));
        excluded.cancelled++; excluded.cancelledValue += value;
        if (id) cancelledByOrder.set(id, (cancelledByOrder.get(id) || 0) + value);
      } else excluded.unpaid++;
      return;
    }
    fAff.push(r);
  });
  excluded.cancelledOrders = cancelledByOrder.size;
  cancelledByOrder.forEach(v => { if (v > excluded.cancelledMax) excluded.cancelledMax = v; });
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
      days: new Set(), daily: dict(), shopeeClicks: 0, shopeeSrc: { fb: 0, ig: 0, other: 0 }, metaClicksWindow: 0, spendWindow: 0,
      adNames: dict(), unitKeys: dict(), delivery: dict(), quality: dict(), platforms: dict(), shops: dict(), products: dict(),
      attr: attrBucket(), attrProducts: { direct: dict(), indirect: dict(), unknown: dict() },
    };
    return T[t];
  }

  const attrCol = attrColumn(fAff);
  const attrAll = attrBucket(), attrValues = dict();
  function attrBucket() {
    const part = () => ({ orders: new Set(), rows: 0, comm: 0, commEff: 0 });
    return { direct: part(), indirect: part(), unknown: part() };
  }
  function addAttr(a, kind, id, c, ce) {
    const p = a[kind];
    p.rows++; p.comm += c; p.commEff += ce;
    if (id) p.orders.add(id);
  }
  function attrOut(a) {
    const out = {};
    ['direct', 'indirect', 'unknown'].forEach(k => {
      out[k] = { orders: a[k].orders.size, rows: a[k].rows, comm: a[k].comm, commEff: a[k].commEff };
    });
    // One Shopee order can hold a linked item and another item; it then counts
    // under both, so the two order counts may add up to more than the total.
    let mixed = 0;
    a.direct.orders.forEach(id => { if (a.indirect.orders.has(id)) mixed++; });
    out.mixed = mixed;
    return out;
  }

  const dailyAll = dict();
  // The same commission re-bucketed on Waktu Klik, the day the ad money bought
  // it. What cannot sit on an in-range click day is counted, never dropped.
  const byClick = { placed: 0, placedEff: 0, before: 0, beforeEff: 0, missing: 0, missingEff: 0 };
  let clickRows = 0; // a row count, not a sum: zero-commission clicks still mean the column exists
  const platform = dict(), category = dict(), category2 = dict(), product = dict(), shop = dict();
  const hourly = new Array(24).fill(0), hourlyOrders = Array.from({ length: 24 }, () => new Set());
  const offerType = dict(), contentType = dict();

  fAff.forEach(r => {
    const t = cleanTag(pick(r, COL.aff.tag)) || (isShopeeVideo(pick(r, COL.aff.platform)) ? SHOPEE_VIDEO : '(tanpa tag)');
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

    const rawAttr = attrCol ? String(r[attrCol] == null ? '' : r[attrCol]).trim() : '';
    const kind = attrKind(rawAttr) || 'unknown';
    if (attrCol && kind === 'unknown') attrValues[rawAttr || '(kosong)'] = (attrValues[rawAttr || '(kosong)'] || 0) + 1;
    const ce = st === 'Tertunda' ? c * o.pendingFactor : c;
    addAttr(b.attr, kind, id, c, ce);
    // What was actually bought, per kind: an indirect order names the product
    // the buyer chose instead of the one in the link.
    if (attrCol) {
      const name = String(pick(r, COL.aff.product) || '(tanpa nama produk)'), shopName = String(pick(r, COL.aff.shop) || '');
      const key = name + '\u0000' + shopName, list = b.attrProducts[kind];
      if (!list[key]) list[key] = { name, shop: shopName, orders: new Set(), qty: 0, comm: 0, gmv: 0 };
      const p = list[key];
      p.qty += q; p.comm += c; p.gmv += g;
      if (id) p.orders.add(id);
    }
    addAttr(attrAll, kind, id, c, ce);

    if (!b.daily[d]) b.daily[d] = { comm: 0, spend: 0, clicks: 0, orders: new Set(), gmv: 0 };
    b.daily[d].comm += c; b.daily[d].gmv += g;
    b.daily[d].commEff = (b.daily[d].commEff || 0) + (st === 'Tertunda' ? c * o.pendingFactor : c);
    if (id) b.daily[d].orders.add(id);

    if (!dailyAll[d]) dailyAll[d] = { date: d, comm: 0, spend: 0, clicks: 0, gmv: 0, impr: 0, orders: new Set() };
    dailyAll[d].comm += c; dailyAll[d].gmv += g;
    dailyAll[d].commEff = (dailyAll[d].commEff || 0) + (st === 'Tertunda' ? c * o.pendingFactor : c);
    if (id) dailyAll[d].orders.add(id);

    const ck = dayOnly(pick(r, COL.aff.clickAt));
    const eff = st === 'Tertunda' ? c * o.pendingFactor : c;
    if (isDate(ck) && ck < ds) { byClick.before += c; byClick.beforeEff += eff; clickRows++; }
    else if (inRange(ck) && ck <= d) {
      clickRows++;
      if (!dailyAll[ck]) dailyAll[ck] = { date: ck, comm: 0, spend: 0, clicks: 0, gmv: 0, impr: 0, orders: new Set() };
      const a = dailyAll[ck];
      a.commByClick = (a.commByClick || 0) + c;
      a.commEffByClick = (a.commEffByClick || 0) + eff;
      if (st === 'Tertunda') a.pendingByClick = (a.pendingByClick || 0) + c;
      byClick.placed += c; byClick.placedEff += eff;
    } else { byClick.missing += c; byClick.missingEff += eff; }

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

  /* Candidate tags are every sub_id Shopee reported: the commission report
     AND the click report. A test ad whose link works but has not sold yet
     appears only in the click report, and used to be called "Tidak cocok".
     The commission report still decides how a click's joined slots split. */
  const commTags = Object.keys(T).filter(t => t && t !== '(tanpa tag)');
  const commKnown = tagLookup(commTags);
  const clickTagOf = fClk.map(r => resolveClickTag(pick(r, COL.clk.tag), commKnown)
    || (isShopeeVideo(pick(r, COL.clk.src)) ? SHOPEE_VIDEO : null));
  const affiliateTags = [...new Set(commTags.concat(clickTagOf.filter(Boolean)))];

  /* ── Ads aggregation + matching, per ad ─────────────────────────────────
     An ad is its Ad ID; the name is a label. Meta lets one name run in several
     campaigns (10% of spend in must, 14% in us, 79% in Rizqie), and grouping
     by name merged those copies into one unit nobody could judge on its own.
     Exports without an Ad ID column still group by name. A row without a
     usable ID joins the one ad that carries its name, so an uploaded export
     and a pull of later days stay one ad; a name several ads share cannot be
     split and stays a unit of its own. */
  /* A damaged ID (rounded by a spreadsheet, or a genuine one ending in zeros)
     joins the one intact ID with the same name that it can be: a value shown
     with six digits fits many ads, so the number alone proves nothing. Failing
     that, a digits-only one keeps its own unit (with its name) and anything
     else falls back to the name. */
  const unitOf = [], unitInfo = dict(), idsByName = dict(), fitCache = new Map();
  fAds.forEach(r => {
    const id = intactAdId(pick(r, COL.ads.id));
    if (!id) return;
    const name = String(pick(r, COL.ads.name) || '');
    (idsByName[name] = idsByName[name] || new Set()).add(id);
  });
  fAds.forEach((r, i) => {
    const name = String(pick(r, COL.ads.name) || '');
    const cell = String(pick(r, COL.ads.id) || '').trim();
    let id = intactAdId(cell), key = '';
    if (!id && cell) {
      const ck = cell + '|' + name;
      if (!fitCache.has(ck)) fitCache.set(ck, [...(idsByName[name] || [])].filter(x => idAgrees(cell, x)));
      const fits = fitCache.get(ck);
      if (fits.length === 1) id = fits[0];
      // Two ads can round to one value, so the name still has to agree.
      else if (/^\d+$/.test(cell)) key = 'raw:' + cell + '|' + name;
    }
    if (!id && !key && !cell && idsByName[name] && idsByName[name].size === 1) id = idsByName[name].values().next().value;
    key = id ? 'id:' + id : key || 'name:' + name;
    unitOf[i] = key;
    const d = dayOnly(pick(r, COL.ads.date));
    const s = unitInfo[key] || (unitInfo[key] = { adId: id, name, names: new Map(), campaign: '', date: '' });
    if (!(s.names.get(name) >= d)) s.names.set(name, d);
    // The newest row names the ad: a rename shows there first.
    if (d >= s.date) {
      s.date = d; s.name = name;
      const c = String(pick(r, COL.ads.campaign) || '').trim();
      s.campaign = c !== name ? c : '';
    }
  });

  /* The ad's tag, from its newest name. When that name decides nothing, an
     older name of the same ad in this data can (a rename inside the period),
     then the tag the Ad ID earned earlier. An exact name is remembered per Ad
     ID (learnedIds, stored by the app), so a renamed ad keeps its tag; a
     manual mapping drops a remembered tag that disagrees (forgetIds), so a
     correction is not undone by the next rename. */
  const unitMatch = dict(), learnedIds = {}, forgetIds = [];   // digit-only Ad IDs
  const isSure = x => x.confidence >= 0.85 && !x.candidateTag;
  Object.keys(unitInfo).forEach(key => {
    const u = unitInfo[key];
    // A choice made for one ad among several sharing its name is stored under
    // "id:<Ad ID>" and decides for that ad alone.
    const own = u.adId && Object.prototype.hasOwnProperty.call(tagMap, 'id:' + u.adId) ? cleanTag(tagMap['id:' + u.adId]) : '';
    let m = own ? { tag: own, method: 'Manual', confidence: 1 } : matchAdToTag(u.name, affiliateTags, tagMap), base = m.method;
    if (!isSure(m)) {
      const older = [...u.names].filter(([nm]) => nm !== u.name).sort((a, b) => (a[1] < b[1] ? 1 : a[1] > b[1] ? -1 : 0));
      for (const [nm] of older) {
        const o = matchAdToTag(nm, affiliateTags, tagMap);
        if (isSure(o)) { m = { tag: o.tag, method: o.method + ' (nama lama)', confidence: 0.9, oldName: nm }; base = o.method; break; }
      }
    }
    const kept = u.adId && Object.prototype.hasOwnProperty.call(adIdMap, u.adId) ? cleanTag(adIdMap[u.adId]) : '';
    if (u.adId && (base === 'Exact' || base === 'Pipe')) learnedIds[u.adId] = m.tag;
    else if (kept && /^(Pipe\+)?Manual$/.test(base) && kept !== m.tag) forgetIds.push(u.adId);
    if (!isSure(m) && kept) m = { tag: kept, method: 'Ad ID', confidence: 0.9 };
    unitMatch[key] = m;
  });

  const units = dict();
  fAds.forEach((r, i) => {
    const key = unitOf[i], info = unitInfo[key], m = unitMatch[key];
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
    b.adNames[info.name] = (b.adNames[info.name] || 0) + spPPN;
    b.unitKeys[key] = 1;
    if (dv) b.delivery[dv] = (b.delivery[dv] || 0) + 1;
    if (ql && ql !== '-') b.quality[ql] = (b.quality[ql] || 0) + 1;

    if (!b.daily[d]) b.daily[d] = { comm: 0, spend: 0, clicks: 0, orders: new Set(), gmv: 0 };
    b.daily[d].spend += spPPN;
    b.daily[d].clicks += cl;

    if (!dailyAll[d]) dailyAll[d] = { date: d, comm: 0, spend: 0, clicks: 0, gmv: 0, impr: 0, orders: new Set() };
    dailyAll[d].spend += spPPN;
    dailyAll[d].clicks += cl;
    dailyAll[d].impr += im;
    dailyAll[d].hasAds = true;

    if (clkStart && d >= clkStart && d <= clkEnd) { b.metaClicksWindow += cl; b.spendWindow += spPPN; }

    // Per ad unit — the reference dashboard's primary grain
    if (!units[key]) units[key] = {
      adName: info.name, adId: info.adId, campaign: info.campaign,
      tag: t, candidateTag: m.candidateTag || '', candidates: m.candidates || [], method: m.method, confidence: m.confidence,
      spend: 0, clicks: 0, impr: 0, reach: 0, lpv: 0, days: new Set(),
      delivery: dict(), quality: dict(), daily: dict(), latestDelivery: null,
    };
    const u = units[key];
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
  /* Shopee's "Perujuk" says where a click came from. Only Facebook and
     Instagram can be Meta ad clicks; Others, WhatsApp, websites, … are
     shares and organic posts, so they are counted apart. */
  const hasClickSrc = fClk.some(r => pick(r, COL.clk.src));
  const srcKind = v => { const x = String(v || '').trim().toLowerCase(); return x === 'facebook' ? 'fb' : x === 'instagram' ? 'ig' : 'other'; };
  fClk.forEach((r, i) => {
    const t = clickTagOf[i];
    const d = dayOnly(pick(r, COL.clk.time));
    if (t) {
      const b = bucket(t);
      b.shopeeClicks++;
      b.shopeeSrc[srcKind(pick(r, COL.clk.src))]++;
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
  /* By click date the newest days are still filling in twice over: orders from
     those clicks can still arrive after the export, and much of what arrived
     is still Tertunda. The lag counts back from where the commission report
     ends, not from the ads; click days after that end are unknown, not zero. */
  const clickKnown = clickRows > 0;
  const affEnd = Object.keys(statusDay).filter(isDate).sort().pop() || '';
  const clickBase = affEnd && affEnd < de ? affEnd : de;
  const clickLagUntil = clickBase ? addDays(clickBase, -o.lagDays) : '';
  const PENDING_BAND = 0.5; // a click day with half or more of its commission Tertunda is not settled yet
  let matureByClickUntil = clickLagUntil;
  if (clickKnown && clickLagUntil) {
    const dates = Object.keys(dailyAll).filter(isDate).sort();
    for (let i = dates.length - 1; i >= 0; i--) {
      const v = dailyAll[dates[i]], cc = v.commByClick || 0;
      const heavy = cc > 0 && (v.pendingByClick || 0) / cc >= PENDING_BAND;
      if (dates[i] > clickLagUntil || heavy) matureByClickUntil = addDays(dates[i], -1);
      else break;
    }
    // A gap in the dates must not move the band's start past the lag cut-off.
    if (matureByClickUntil > clickLagUntil) matureByClickUntil = clickLagUntil;
  }

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

  function verdictFor(spend, commEff, daysProd, dailyRows, hasPaidSpend) {
    let streak = 0;
    dailyRows.forEach(r => { if (r.roas < 1) streak++; else streak = 0; });
    const streakStop = streak >= o.streakDays;
    const roasEff = spend > 0 ? commEff / spend : (commEff > 0 ? Infinity : 0);

    let status = 'evaluasi', label = 'Belum cukup data', reason = '', borderAt = null;
    /* "di batas": the ROAS that decided the verdict sits within ±10% of the
       threshold it was compared with, so a few orders could flip it. Compared
       on the 2-decimal value the reason prints (toFixed, like ratioText; 1.105
       prints 1,10 but Math.round gives 1,11); the epsilon keeps 1,10x and 2,20x
       inside the band despite binary floating point. */
    const r2 = Number(roasEff.toFixed(2));
    const nearest = ths => ths.filter(th => th > 0 && Math.abs(r2 - th) <= th * 0.1 + 1e-9)
      .sort((x, y) => Math.abs(r2 - x) - Math.abs(r2 - y))[0] || null;
    const qualified = spend > 0 && spend >= o.minSpend && daysProd > 0 && daysProd >= o.minDays;

    if (!hasPaidSpend && commEff > 0) {
      status = 'organik'; label = 'ORGANIK'; reason = 'Komisi tanpa biaya iklan';
    } else if (!qualified) {
      const need = [];
      if (spend <= 0 || spend < o.minSpend) need.push('spend matang belum cukup');
      if (daysProd <= 0 || daysProd < o.minDays) need.push(`baru ${daysProd} hari produksi matang`);
      reason = need.join(', ');
    } else if (streakStop) {
      // The streak decided this STOP, not a threshold, so it is never "di batas".
      status = 'stop'; label = 'STOP';
      reason = `ROAS di bawah 1 selama ${streak} hari produksi berturut`;
    } else if (roasEff >= o.thScale) {
      status = 'scale'; label = 'SCALE'; borderAt = nearest([o.thScale]);
      reason = `ROAS efektif matang ${ratioText(roasEff)}x di atas target ${String(o.thScale).replace('.', ',')}x`;
    } else if (roasEff >= o.thPantau) {
      status = 'pantau'; label = 'PANTAU'; borderAt = nearest([o.thPantau, o.thScale]);
      reason = `ROAS efektif matang ${ratioText(roasEff)}x, belum layak scale`;
    } else {
      status = 'stop'; label = 'STOP'; borderAt = nearest([o.thPantau]);
      reason = `ROAS efektif matang ${ratioText(roasEff)}x di bawah titik impas`;
    }
    return { status, label, reason, streak, borderAt };
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
      // Only clicks Shopee attributes to Facebook or Instagram can come from a
      // Meta ad; shares (Others, WhatsApp, …) would otherwise hide a broken link.
      const shopee = hasClickSrc ? b.shopeeSrc.fb + b.shopeeSrc.ig : b.shopeeClicks;
      const pct = shopee / b.metaClicksWindow * 100;
      // Too many arrivals is judged on every source: the tag's commission
      // includes the orders shared and organic clicks bring, so its ROAS is an
      // upper bound whichever referrer they came through.
      const allPct = b.shopeeClicks / b.metaClicksWindow * 100;
      const failed = Math.max(b.metaClicksWindow - shopee, 0);
      const wasted = (winSpend / b.metaClicksWindow) * failed;
      leak = {
        metaClicks: b.metaClicksWindow, shopeeClicks: shopee, pct, allPct, failed, wasted,
        reliable: b.metaClicksWindow >= LINK.minClicks,
        severity: pct < LINK.low ? 'bad' : pct < LINK.warn ? 'warn' : allPct > LINK.over ? 'over' : 'ok',
      };
    }

    /* Click capture of the mapping: Shopee clicks on this tag ÷ Meta link
       clicks, counted only on days the ads ran inside the click report. Under
       ~25% (the 10th percentile in must) most of the traffic lands on another
       sub_id — the link is not the one the mapping assumes, even when the
       name matches exactly. Trusted from about 7 days and 300 clicks. */
    let capture = null;
    if (clkStart) {
      let metaClicks = 0, shopeeHits = 0, days = 0;
      Object.keys(b.daily).forEach(d => {
        const dd = b.daily[d];
        // A day with no click at all in the report is a missing file, not a
        // broken link: Rizqie's real outage still logged 36 clicks.
        if (!isDate(d) || d < clkStart || d > clkEnd || !(dd.spend > 0) || !clickDaily[d]) return;
        metaClicks += dd.clicks; shopeeHits += dd.shopeeClicks || 0; days++;
      });
      if (metaClicks > 0) {
        const pct = shopeeHits / metaClicks * 100;
        capture = { metaClicks, shopeeClicks: shopeeHits, days, pct,
                    low: pct < 25 && metaClicks >= 300 && days >= 7 };
      }
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
        date: d, comm: dd.comm, commEff: dd.commEff || 0, spend: dd.spend, gmv: dd.gmv,
        orders: dd.orders.size, clicks: dd.clicks, shopeeClicks: sh,
      };
    });

    const matureDaysProd = prodDays.length;
    const matureSpend = dailyRows.reduce((sum, row) => sum + row.spend, 0);
    const matureCommEff = Object.keys(b.daily).filter(isMature).reduce((sum, d) => sum + (b.daily[d].commEff || 0), 0);
    const matureRoasEff = matureSpend > 0 ? matureCommEff / matureSpend : 0;
    const v = spend > 0
      ? verdictFor(matureSpend, matureCommEff, matureDaysProd, dailyRows, true)
      : verdictFor(spend, commEff, daysProd, dailyRows, false);
    /* Kept apart from reason, so the real STOP/SCALE reason stays visible. Not
       stored in snapshots: validSnapshot accepts no extra string fields. */
    /* Period totals (leak) can look healthy while the days the ad ran do not:
       organic clicks on no-spend days fill the gap. capture counts only those
       days, so its "Klik masuk rendah" also earns the cek-link note, ahead of
       'over', which those same organic clicks would explain. Notes only; the
       money on the action cards stays on leak. */
    const checkFirst = v.status === 'stop' ? ' sebelum dimatikan' : '';
    const linkTone = leak && leak.reliable && leak.severity === 'bad' || capture && capture.low ? 'bad'
      : leak && leak.reliable && leak.severity === 'over' ? 'over' : '';
    const linkNote = linkTone === 'over' ? `klik Shopee ${Math.round(leak.allPct)}% dari klik iklan — ROAS memuat trafik lain, anggap batas atas`
      : linkTone !== 'bad' ? ''
      : leak && leak.reliable && leak.severity === 'bad' ? `hanya ${Math.round(leak.pct)}% klik sampai Shopee — cek link${checkFirst}`
      : `klik masuk rendah: hanya ${Math.round(capture.pct)}% klik iklan sampai Shopee selama iklan jalan — cek link${checkFirst}`;

    let bidHint = '';
    if (v.status !== 'organik' && v.status !== 'evaluasi' && b.clicks > 0) {
      bidHint = cpcGap > 0 ? `Ruang naik bid s/d ${Math.round(cpcIdeal)}` : `Turunkan bid ke ${Math.round(cpcIdeal)}`;
    }

    /* The click report usually spans fewer days than the ads export. Dividing
       full-range spend by window-only Shopee clicks reads far too high, so the
       Shopee-side cost is matched to the click window on both sides. */
    const shopeeClicks = b.shopeeClicks;
    const shopeeFromMeta = hasClickSrc ? b.shopeeSrc.fb + b.shopeeSrc.ig : null;
    const cpcShopee = shopeeClicks > 0 && winSpend > 0 ? winSpend / shopeeClicks : 0;

    /* Landing page views are shown with their cost but not used as a funnel
       step: a Shopee link opens the Shopee app, which Meta mostly cannot see
       load. In adrian's 20 Oct 2026 data Shopee logged 3-28x more clicks
       than Meta's LP views on most tags, so "clicks lost before the LP"
       would mostly measure Meta's blind spot. The loss that holds up is Meta
       link clicks → Shopee clicks in the click window (the leak above);
       negative when Shopee counted more than Meta sent. */
    const cpLpv = b.lpv > 0 ? spend / b.lpv : 0;
    const lostTotal = leak ? 100 - leak.pct : null;

    const activeUnits = Object.keys(b.unitKeys).length;
    const delivery = topOf(b.delivery, 1)[0];

    return {
      tag: k, comm: b.comm, commDone: b.commDone, commPending: b.commPending, commEff,
      // Meta's amount before PPN, so a PPN what-if needs no second analysis.
      spend, spendBase: b.spend, net, netEff, roas, roasEff, roi, margin,
      orders, doneOrders: b.doneOrders.size, pendingOrders: b.pendingOrders.size,
      qty: b.qty, gmv: b.gmv, refund: b.refund,
      clicks: b.clicks, impr: b.impr, reach: b.reach, lpv: b.lpv, lpvRate,
      shopeeClicks, shopeeFromMeta, shopeeSrc: hasClickSrc ? { ...b.shopeeSrc } : null, cpcShopee, winSpend, winClicks, cpLpv, lostTotal,
      daysProd, matureDaysProd, matureSpend, matureCommEff, matureRoasEff, cpc, cpm, ctr, freq, cpcIdeal, cpcGap, commPerClick,
      convRate, costPerOrder, avgComm, avgOrder, commRate,
      leak, capture, status: v.status, label: v.label, reason: v.reason, linkNote, linkTone, streak: v.streak, borderAt: v.borderAt, bidHint,
      dailyRows, byDate, activeUnits, delivery: delivery ? delivery.name : '',
      topPlatform: topOf(b.platforms, 1)[0] || null,
      topShop: topOf(b.shops, 1)[0] || null,
      adNames: Object.keys(b.adNames),
      attr: attrOut(b.attr),
      attrProducts: attrCol ? ['direct', 'indirect', 'unknown'].reduce((out, k) => {
        out[k] = Object.values(b.attrProducts[k]).map(p => ({ ...p, orders: p.orders.size }))
          .sort((x, y) => y.comm - x.comm || y.orders - x.orders || x.name.localeCompare(y.name));
        return out;
      }, {}) : null,
      // Flat copies for CSV export; empty, not 0, when the report has no
      // attribution column, so a missing split never reads as "no orders".
      attrDirectOrders: attrCol ? b.attr.direct.orders.size : null,
      attrDirectComm: attrCol ? b.attr.direct.comm : null,
      attrIndirectOrders: attrCol ? b.attr.indirect.orders.size : null,
      attrIndirectComm: attrCol ? b.attr.indirect.comm : null,
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
        commEff: pd ? (pd.commEff || 0) * dayShare : 0,
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
      key: k, adName: u.adName, adId: u.adId, campaign: u.campaign,
      tag: u.tag, candidateTag: u.candidateTag, candidates: u.candidates, method: u.method, confidence: u.confidence,
      capture: parent ? parent.capture : null,
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
    key: u.key, adName: u.adName, adId: u.adId, campaign: u.campaign,
    tag: u.tag, candidateTag: u.candidateTag, candidates: u.candidates, method: u.method, confidence: u.confidence,
    capture: u.capture, spend: u.spend, clicks: u.clicks,
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
  // Cancellation rate over Selesai, Tertunda and Dibatalkan orders; unpaid
  // orders never started, so they stay out of the base. An order with both kept
  // and cancelled items counts once, as cancelled.
  const cancelBase = new Set([...allOrders, ...cancelledByOrder.keys()]).size;
  const gmvKept = sum(t => t.gmv);

  const paid = tags.filter(t => t.spend > 0);
  const paidSpend = paid.reduce((s, t) => s + t.spend, 0);
  const paidComm = paid.reduce((s, t) => s + t.commEff, 0);
  const organicComm = tags.filter(t => t.status === 'organik').reduce((s, t) => s + t.commEff, 0);

  /* Per-tag shortfalls and surpluses on the click window. Part of one tag's
     missing clicks can land on another tag (wrong sub_id); part of a surplus is
     organic or other-account traffic. The data cannot tell which, so both ends
     are kept: the per-tag sum and the net. */
  const clickTags = tags.filter(t => t.leak);
  const winMeta = clickTags.reduce((s, t) => s + t.leak.metaClicks, 0);
  const winShopee = clickTags.reduce((s, t) => s + t.leak.shopeeClicks, 0);
  const lostClicks = clickTags.reduce((s, t) => s + t.leak.failed, 0);
  const gainClicks = clickTags.reduce((s, t) => s + Math.max(t.leak.shopeeClicks - t.leak.metaClicks, 0), 0);
  const netLostClicks = Math.max(winMeta - winShopee, 0);
  const wastedHigh = clickTags.reduce((s, t) => s + t.leak.wasted, 0);
  // One rule for "check the link", shared by the banner count and the link money.
  const linkBad = t => !!(t.leak && t.leak.reliable && t.leak.severity === 'bad');

  const kpi = {
    spend: totalSpend,
    spendBase: sum(t => t.spendBase),
    comm: totalComm,
    commEff: totalEff,
    commPending: sum(t => t.commPending),
    pendingPct: totalComm > 0 ? sum(t => t.commPending) / totalComm * 100 : 0,
    commDone: sum(t => t.commDone),
    // Lower bound: as if every pending order were cancelled. Same spend (with PPN) as roasEff.
    roasDone: totalSpend > 0 ? sum(t => t.commDone) / totalSpend : 0,
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
    // Kept apart from the Klik Shopee headline: Shopee Video never passes through Meta.
    shopeeVideoClicks: fClk.filter(r => isShopeeVideo(pick(r, COL.clk.src))).length,
    wasted: wastedHigh, // upper end; same meaning as before, stored in snapshots
    // Lower end: as if every surplus click were a misrouted paid click.
    wastedLow: lostClicks > 0 ? wastedHigh * netLostClicks / lostClicks : 0,
    lostClicks, gainClicks, netLostClicks,
    leakTags: tags.filter(linkBad).length,
    excluded, statusCount,
    cancelBase,
    cancelRate: cancelBase ? cancelledByOrder.size / cancelBase * 100 : 0,
    // Secondary: one large cancelled order moves this a lot, so it is shown next to the largest one.
    cancelValueRate: gmvKept + excluded.cancelledValue > 0 ? excluded.cancelledValue / (gmvKept + excluded.cancelledValue) * 100 : 0,
    counts: { scale: 0, pantau: 0, stop: 0, organik: 0, evaluasi: 0 },
  };
  tags.forEach(t => { kpi.counts[t.status] = (kpi.counts[t.status] || 0) + 1; });

  const daily = Object.keys(dailyAll).filter(isDate).sort().map(d => {
    const v = dailyAll[d];
    const commEff = v.commEff || 0;
    // Null means unknown: no Waktu Klik at all, or a day after the commission report ends.
    const known = clickKnown && !(affEnd && d > affEnd);
    const ce = known ? (v.commEffByClick || 0) : null;
    return {
      date: d, comm: v.comm, spend: v.spend, gmv: v.gmv, clicks: v.clicks, impr: v.impr,
      commEff, netEff: commEff - v.spend,
      roasEff: v.spend > 0 ? commEff / v.spend : 0,
      // A source row was observed on this date; these flags do not establish
      // whole-day report completeness. statusDay also includes excluded orders.
      hasAffiliate: Object.prototype.hasOwnProperty.call(statusDay, d), hasAds: !!v.hasAds,
      shopeeClicks: clickDaily[d] || 0,
      orders: v.orders.size, net: v.comm - v.spend,
      roas: v.spend > 0 ? v.comm / v.spend : 0,
      roi: v.spend > 0 ? (v.comm - v.spend) / v.spend * 100 : 0,
      cpc: v.clicks > 0 ? v.spend / v.clicks : 0,
      convRate: v.clicks > 0 ? v.orders.size / v.clicks * 100 : 0,
      mature: isMature(d),
      commByClick: known ? (v.commByClick || 0) : null,
      commEffByClick: ce,
      netEffByClick: known ? ce - v.spend : null,
      roasEffByClick: known ? (v.spend > 0 ? ce / v.spend : 0) : null,
      pendingPctByClick: known && v.commByClick > 0 ? (v.pendingByClick || 0) / v.commByClick * 100 : null,
      matureByClick: clickKnown ? (!matureByClickUntil || d <= matureByClickUntil) : null,
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
  const stopComm = stopTags.reduce((s, t) => s + t.commEff, 0);
  const stopProfitCount = stopTags.filter(t => t.netEff > 0).length;
  /* Most STOP tags are already off when the report is exported, so their loss
     is history rather than a saving still to make. Null without a delivery column. */
  const hasDelivery = adUnits.some(u => u.delivery);
  const liveTags = new Set(adUnits.filter(u => u.active).map(u => u.tag));
  const stopLiveCount = hasDelivery ? stopTags.filter(t => liveTags.has(t.tag)).length : null;
  /* A leaking STOP tag's spend is already inside stopSpend. Split the link money
     so the link card only claims tags where fixing the link is the action. */
  const leakWaste = tags.reduce((s, t) => s + (linkBad(t) ? t.leak.wasted : 0), 0);
  const leakWasteStop = stopTags.reduce((s, t) => s + (linkBad(t) ? t.leak.wasted : 0), 0);
  const leakStopCount = stopTags.filter(linkBad).length;
  /* Paid tags not judged yet are not neutral: their net is real money. Only
     tags with spend count, so click-only sub_ids and idle ad names (also
     evaluasi, nothing at stake) do not inflate it. Same netEff as the table's
     Laba column, so the filtered table adds up to evalNet. */
  const evalTags = tags.filter(t => t.status === 'evaluasi' && t.spend > 0);

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
  /* Pareto by spend: what the top N tags take of paid spend and earn of paid
     effective commission (the ROAS Iklan base; organic stays out). The largest
     tag alone rarely looks risky while a long tail quietly loses money. */
  const paretoShare = top => {
    const sp = top.reduce((s, t) => s + t.spend, 0), cm = top.reduce((s, t) => s + t.commEff, 0);
    return { spend: sp, commEff: cm, spendShare: paidSpend > 0 ? sp / paidSpend * 100 : 0,
      commShare: paidComm > 0 ? cm / paidComm * 100 : 0, roasEff: sp > 0 ? cm / sp : 0 };
  };
  // Paid ad names absent from the commission report count as commission 0;
  // some are naming mismatches, so the tail ROAS is a lower bound. commTags,
  // not affiliateTags: a sub_id seen only in the click report has no commission.
  const affSet = new Set(commTags);
  const noCommTags = paidSorted.filter(t => !affSet.has(t.tag));
  const noCommSpend = noCommTags.reduce((s, t) => s + t.spend, 0);
  const concentration = paidSorted.length ? {
    topTag: paidSorted[0].tag,
    topShare: paidSpend > 0 ? paidSorted[0].spend / paidSpend * 100 : 0,
    topRoas: paidSorted[0].roasEff,
    top2Share: paidSpend > 0 ? paidSorted.slice(0, 2).reduce((s, t) => s + t.spend, 0) / paidSpend * 100 : 0,
    count: paidSorted.length,
    paidComm,
    groups: [1, 3, 5, 10].filter(n => n < paidSorted.length)
      .map(n => ({ n, tags: paidSorted.slice(0, n).map(t => t.tag), ...paretoShare(paidSorted.slice(0, n)) })),
    noComm: { n: noCommTags.length, spend: noCommSpend, spendShare: paidSpend > 0 ? noCommSpend / paidSpend * 100 : 0 },
  } : null;
  // The complement of the last group, so nobody adds up the cumulative rows.
  if (concentration && concentration.groups.length) {
    const last = concentration.groups[concentration.groups.length - 1];
    concentration.rest = { n: paidSorted.length - last.n, ...paretoShare(paidSorted.slice(last.n)) };
  }

  const actions = {
    bidSaving, overbidCount: overbid.length,
    stopSpend, stopLoss, stopComm, stopProfitCount, stopLiveCount, stopCount: stopTags.length,
    evalCount: evalTags.length,
    evalSpend: evalTags.reduce((s, t) => s + t.spend, 0),
    evalComm: evalTags.reduce((s, t) => s + t.commEff, 0),
    evalNet: evalTags.reduce((s, t) => s + t.netEff, 0),
    leakWaste, leakWasteStop, leakWasteLive: leakWaste - leakWasteStop,
    leakStopCount, leakLiveCount: kpi.leakTags - leakStopCount,
    // Profit changes only: the bid gap plus this period's loss on STOP tags.
    maxGain: bidSaving + stopLoss,
    reclaimable: bidSaving + stopSpend, // legacy: gross budget, not savings; kept for JSON export readers
    organicCandidates, concentration,
  };

  return {
    range: { start: ds, end: de, matureUntil, clickStart: clkStart, clickEnd: clkEnd },
    options: o,
    // Outside range on purpose: toSnapshot copies range whole, and saved snapshots keep their shape.
    byClick: { ...byClick, available: clickKnown, matureUntil: clickKnown ? matureByClickUntil : '', dataEnd: affEnd },
    attribution: { column: attrCol, total: attrOut(attrAll), unknownValues: topOf(attrValues, 5).map(x => ({ value: x.name, rows: x.value })) },
    kpi, tags, adUnits, daily, matchLog, learnedIds, forgetIds, lagProfile, lagCal, settlement, actions,
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
      // Strict check: Number(null) is 0, which would print a false "PPN 0%".
      ppn: s.options && Number.isFinite(s.options.ppn) ? s.options.ppn : null,
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
  cleanTag, attrKind, attrColumn, resolveClickTag, strictKey, tagLookup, intactAdId, idAgrees, COL, pick, topOf, variantOf, variantClash, overlapScore,
  LINK,
};
});
