/* Platform & placement breakdown.

   Meta can export spend and clicks per platform (Facebook, Instagram, …) and
   per placement (Feed, Reels, Stories, …). Shopee knows nothing about Meta
   placements, but it does record where each click and order came from: the
   click report's "Perujuk" and the commission report's "Platform" say
   Facebook, Instagram, Others, … So:

   - per PLATFORM, spend, clicks and commission are all real, and ROAS is real;
   - per PLACEMENT, only Meta's numbers are real. Commission is an estimate:
     each tag's platform commission split by that placement's share of the
     tag's link clicks on that platform (spend share when there are no clicks).

   A placement export is usually one row per ad × placement for the whole
   period, not per day, so it never feeds the main spend totals; it only feeds
   this breakdown, scoped to its own period.
   ───────────────────────────────────────────────────────────────────────── */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine'));
  else root.Placement = factory(root.Engine);
})(typeof self !== 'undefined' ? self : this, function (E) {
  'use strict';

  const META = { facebook: 'Facebook', instagram: 'Instagram' };
  // Meta platforms beyond the two big ones are small and their Shopee
  // referrers spell them differently, so they share one row.
  function metaPlatform(v) {
    return META[String(v || '').trim().toLowerCase()] || 'Lainnya';
  }
  // Shopee's "Others", "Websites", "Google Search", … cannot be tied to a Meta
  // platform; they stay visible but are never split onto placements.
  const SHOPEE_META = { facebook: 'Facebook', instagram: 'Instagram', threads: 'Lainnya', whatsapp: 'Lainnya', messenger: 'Lainnya' };
  function shopeePlatform(v) {
    return SHOPEE_META[String(v || '').trim().toLowerCase()] || 'Tidak diketahui';
  }
  const ORDER = ['Facebook', 'Instagram', 'Lainnya', 'Tidak diketahui'];
  const UNMATCHED = '(iklan belum cocok)';

  function isPlacementExport(fields) {
    return (fields || []).includes('Placement');
  }

  // matchLog has one entry per ad unit; a name shared by several ads takes the
  // tag that carries most of its spend.
  function tagByAdName(matchLog) {
    const best = new Map();
    for (const u of matchLog || []) {
      if (!u || !u.adName || !u.tag) continue;
      const prev = best.get(u.adName);
      if (!prev || (u.spend || 0) > prev.spend) best.set(u.adName, { tag: u.tag, spend: u.spend || 0 });
    }
    return name => (best.get(name) || {}).tag || '';
  }

  function blank() {
    return { spend: 0, impr: 0, clicks: 0, shopeeClicks: 0, orders: new Set(), comm: 0 };
  }

  function analyze(input) {
    // Daily rows follow the dashboard's date filter; a whole-period row cannot
    // be cut, so it stays as exported.
    const want = input.range || {};
    const rows = (input.placement || []).filter(r => {
      const s = E.dayOnly(r['Reporting starts']), e = E.dayOnly(r['Reporting ends'] || r['Reporting starts']);
      return s !== e || !want.start || !want.end || (s >= want.start && s <= want.end);
    });
    if (!rows.length) return null;
    const tagOf = tagByAdName(input.matchLog);
    let start = '', end = '';
    for (const r of rows) {
      const s = E.dayOnly(r['Reporting starts']), e = E.dayOnly(r['Reporting ends'] || r['Reporting starts']);
      if (E.isDate(s) && (!start || s < start)) start = s;
      if (E.isDate(e) && (!end || e > end)) end = e;
    }
    const inRange = d => E.isDate(d) && d >= start && d <= end;

    /* Meta side: per tag × platform, and per tag × platform × placement. */
    const tp = new Map(), tpp = new Map(), adTags = new Set();
    const cell = (map, key) => { if (!map.has(key)) map.set(key, blank()); return map.get(key); };
    for (const r of rows) {
      const name = String(r['Ad name'] || '').trim();
      const tag = tagOf(name) || UNMATCHED;
      const plat = metaPlatform(r.Platform);
      const place = String(r.Placement || '').trim() || 'Tanpa placement';
      const spend = E.num(E.pick(r, E.COL.ads.spend)), impr = E.num(r.Impressions), clicks = E.num(r['Link clicks']);
      adTags.add(tag);
      for (const c of [cell(tp, tag + '\u0000' + plat), cell(tpp, tag + '\u0000' + plat + '\u0000' + place)]) {
        c.spend += spend; c.impr += impr; c.clicks += clicks;
      }
    }

    /* Shopee side, limited to tags that have ads in the file: organic tags
       would otherwise lift every platform's ROAS. */
    const affTags = new Set();
    for (const r of input.affiliate || []) { const t = E.cleanTag(E.pick(r, E.COL.aff.tag)); if (t) affTags.add(t); }
    const known = E.tagLookup([...affTags]);
    const shopee = new Map();
    for (const r of input.clicks || []) {
      if (!inRange(E.dayOnly(E.pick(r, E.COL.clk.time)))) continue;
      const tag = E.resolveClickTag(E.pick(r, E.COL.clk.tag), known);
      if (!adTags.has(tag)) continue;
      cell(shopee, tag + '\u0000' + shopeePlatform(E.pick(r, E.COL.clk.src))).shopeeClicks++;
    }
    let hasOrderPlatform = false;
    for (const r of input.affiliate || []) {
      if (!inRange(E.dayOnly(E.pick(r, E.COL.aff.orderAt)))) continue;
      const st = String(E.pick(r, E.COL.aff.status) || '').trim();
      if (st === 'Dibatalkan' || st === 'Belum Dibayar') continue;
      const tag = E.cleanTag(E.pick(r, E.COL.aff.tag));
      if (!adTags.has(tag)) continue;
      const pf = E.pick(r, E.COL.aff.platform);
      if (pf) hasOrderPlatform = true;
      const c = cell(shopee, tag + '\u0000' + shopeePlatform(pf));
      c.comm += E.num(E.pick(r, E.COL.aff.comm));
      const id = String(E.pick(r, E.COL.aff.orderId) || '').trim();
      if (id) c.orders.add(id);
    }

    const finish = (o, extra) => {
      const orders = o.orders instanceof Set ? o.orders.size : o.orders;
      return Object.assign({
        spend: o.spend, impr: o.impr, clicks: o.clicks, shopeeClicks: o.shopeeClicks, orders, comm: o.comm,
        cpc: o.clicks ? o.spend / o.clicks : null,
        ctr: o.impr ? o.clicks / o.impr * 100 : null,
        cpm: o.impr ? o.spend / o.impr * 1000 : null,
        cpcShopee: o.shopeeClicks ? o.spend / o.shopeeClicks : null,
        lost: o.clicks ? 100 - o.shopeeClicks / o.clicks * 100 : null,
        roas: o.spend ? o.comm / o.spend : null,
        net: o.comm - o.spend,
      }, extra);
    };

    /* Per tag rows: Meta and Shopee joined on tag × platform. */
    const tagRows = new Map();
    const tagRow = tag => {
      if (!tagRows.has(tag)) tagRows.set(tag, { tag, platforms: {} });
      return tagRows.get(tag);
    };
    const merged = new Map();
    for (const [k, v] of tp) merged.set(k, Object.assign(blank(), { spend: v.spend, impr: v.impr, clicks: v.clicks }));
    for (const [k, v] of shopee) {
      const m = merged.get(k) || blank();
      m.shopeeClicks += v.shopeeClicks; m.comm += v.comm;
      v.orders.forEach(id => m.orders.add(id));
      merged.set(k, m);
    }
    const platTotals = new Map();
    for (const [k, v] of merged) {
      const [tag, plat] = k.split('\u0000');
      tagRow(tag).platforms[plat] = finish(v);
      const t = cell(platTotals, plat);
      t.spend += v.spend; t.impr += v.impr; t.clicks += v.clicks; t.shopeeClicks += v.shopeeClicks; t.comm += v.comm;
      // An order ID belongs to one tag, so tag-qualified IDs never collide.
      v.orders.forEach(id => t.orders.add(tag + '\u0000' + id));
    }
    const tags = [...tagRows.values()].map(t => {
      const all = Object.values(t.platforms);
      const spend = all.reduce((s, p) => s + p.spend, 0), comm = all.reduce((s, p) => s + p.comm, 0);
      return Object.assign(t, { spend, comm, roas: spend ? comm / spend : null });
    }).sort((a, b) => b.spend - a.spend || b.comm - a.comm);

    /* Placement rows: Meta numbers plus estimated commission. */
    const places = new Map();
    for (const [k, v] of tpp) {
      const [tag, plat, place] = k.split('\u0000');
      const pt = tp.get(tag + '\u0000' + plat);
      const share = pt.clicks ? v.clicks / pt.clicks : pt.spend ? v.spend / pt.spend : 0;
      const comm = ((merged.get(tag + '\u0000' + plat) || {}).comm || 0) * share;
      const key = plat + '\u0000' + place;
      const p = places.get(key) || { platform: plat, placement: place, spend: 0, impr: 0, clicks: 0, estComm: 0 };
      p.spend += v.spend; p.impr += v.impr; p.clicks += v.clicks; p.estComm += comm;
      places.set(key, p);
    }
    const totalSpend = [...places.values()].reduce((s, p) => s + p.spend, 0);
    const totalClicks = [...places.values()].reduce((s, p) => s + p.clicks, 0);
    const avgCpc = totalClicks ? totalSpend / totalClicks : null;
    const placements = [...places.values()].map(p => Object.assign(p, {
      share: totalSpend ? p.spend / totalSpend * 100 : 0,
      cpc: p.clicks ? p.spend / p.clicks : null,
      ctr: p.impr ? p.clicks / p.impr * 100 : null,
      cpm: p.impr ? p.spend / p.impr * 1000 : null,
      estRoas: p.spend ? p.estComm / p.spend : null,
      cpcVsAvg: p.clicks && avgCpc ? (p.spend / p.clicks / avgCpc - 1) * 100 : null,
    })).sort((a, b) => b.spend - a.spend);

    const platforms = ORDER.filter(p => platTotals.has(p)).map(p => finish(platTotals.get(p), { platform: p }));
    const total = finish([...platTotals.values()].reduce((s, v) => {
      s.spend += v.spend; s.impr += v.impr; s.clicks += v.clicks; s.shopeeClicks += v.shopeeClicks; s.comm += v.comm;
      v.orders.forEach(id => s.orders.add(id));
      return s;
    }, blank()), { platform: 'Total' });

    return {
      range: { start, end }, platforms, total, placements, tags, avgCpc,
      unmatchedSpend: tags.filter(t => t.tag === UNMATCHED).reduce((s, t) => s + t.spend, 0),
      daily: rows.every(r => E.dayOnly(r['Reporting starts']) === E.dayOnly(r['Reporting ends'] || r['Reporting starts'])),
      hasClicks: (input.clicks || []).length > 0, hasOrderPlatform,
    };
  }

  return { analyze, isPlacementExport, metaPlatform, shopeePlatform, UNMATCHED };
});
