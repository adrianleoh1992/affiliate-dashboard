/* ── Daily aggregation: pure functions, no DOM, no IndexedDB ────────────────
   Split out from storage on purpose. These functions turn raw CSV rows into
   deduped daily records that can be verified in Node against the real files,
   before any of it reaches a database. Storage bugs are recoverable; wrong
   numbers written to a server are not.

   Grain:
     affiliate → (date, tag)      from (order, product) transaction rows
     ads       → (date, ad_unit)  already daily in Meta's export
     clicks    → (date, tag)      from individual click rows

   Dedup key is a hash of the WHOLE row. A composite key like
   order+product+time+commission looks reasonable but silently drops 1.408
   legitimate rows in the reference data — one order carries several products
   at different prices, and those rows collide on every "obvious" key.
*/
'use strict';

const DailyAgg = (() => {

  /* Stable stringify: key order must not affect the hash. */
  function canonical(row) {
    return JSON.stringify(Object.keys(row).sort().map(k => [k, row[k]]));
  }

  /* Two deterministic 32-bit fingerprints, retained for compatibility with
     existing row guards. This is a non-cryptographic content fingerprint;
     order hashes avoid storing clear IDs but are not an encryption boundary. */
  function hashRow(row) {
    const s = canonical(row);
    let h1 = 0x811c9dc5, h2 = 0x01000193;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      h1 ^= c; h1 = Math.imul(h1, 0x01000193) >>> 0;
      h2 = (h2 + c) >>> 0; h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
    }
    return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
  }

  function hashRows(rows) {
    let h1 = 0x811c9dc5, h2 = 0x01000193;
    for (const r of rows) {
      const s = hashRow(r);
      for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        h1 ^= c; h1 = Math.imul(h1, 0x01000193) >>> 0;
        h2 = (h2 + c) >>> 0; h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
      }
    }
    return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
  }

  function num(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
    if (v == null) return 0;
    const raw = String(v).trim();
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
  const day = v => String(v == null ? '' : v).trim().split(/[ T]/)[0];
  const dateValidity = new Map();
  function isDate(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    if (dateValidity.has(s)) return dateValidity.get(s);
    const d = new Date(s + 'T00:00:00Z');
    const valid = Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s;
    if (dateValidity.size >= 1024) dateValidity.clear();
    dateValidity.set(s, valid);
    return valid;
  }
  const cleanTag = v => String(v || '').trim().replace(/-+$/, '').trim() || '(tanpa tag)';
  const pick = (r, names) => {
    for (const name of names) if (r[name] != null && String(r[name]).trim() !== '') return r[name];
    return '';
  };
  const rowDate = (r, kind) => day(r[kind === 'affiliate' ? 'Waktu Pemesanan' : kind === 'ads' ? 'Reporting starts' : 'Waktu Klik']);

  /* Drop rows whose full-content hash was already seen. Returns the survivors
     plus the hashes, so a caller can persist them for cross-file dedup. */
  function dedupe(rows, seenHashes) {
    const seen = seenHashes instanceof Set ? seenHashes : new Set(seenHashes || []);
    const kept = [], hashes = [];
    let duplicates = 0;
    for (const r of rows) {
      const h = hashRow(r);
      if (seen.has(h)) { duplicates++; continue; }
      seen.add(h); kept.push(r); hashes.push(h);
    }
    return { kept, hashes, duplicates, total: rows.length };
  }

  /* affiliate transactions → one record per (date, tag)

     Excluded from realized figures: "Dibatalkan" and "Belum Dibayar". The
     dashboard's engine.js drops both, and a daily store that kept unpaid
     orders would quietly disagree with the decision screen by a few orders. */
  function aggregateAffiliate(rows) {
    const EXCLUDE = new Set(['Dibatalkan', 'Belum Dibayar']);
    const by = new Map();
    for (const r of rows) {
      const date = day(r['Waktu Pemesanan']);
      if (!isDate(date)) continue;
      const tag = cleanTag(r['Tag_link1']);
      const status = String(r['Status Pesanan'] || '').trim();
      const key = date + '|' + tag;
      let b = by.get(key);
      if (!b) {
        b = { date, tag, comm: 0, comm_done: 0, comm_pending: 0, gmv: 0, qty: 0,
              refund: 0, orders: new Set(), excluded: 0, rows: 0 };
        by.set(key, b);
      }
      const comm = num(pick(r, ['Total Komisi per Produk(Rp)', 'Total Komisi per Pesanan(Rp)', 'Komisi Bersih Affiliate (Rp)']));
      b.rows++;
      if (EXCLUDE.has(status)) { b.excluded++; continue; }
      b.comm += comm;
      if (status === 'Selesai') b.comm_done += comm;
      else if (status === 'Tertunda') b.comm_pending += comm;
      b.gmv += num(r['Nilai Pembelian(Rp)']);
      b.qty += num(r['Jumlah']);
      b.refund += num(r['Jumlah Pengembalian Dana(Rp)']);
      const orderId = String(r['ID Pemesanan'] || '').trim();
      if (orderId) b.orders.add(hashRow({ orderId }));
    }
    return [...by.values()].map(b => ({
      date: b.date, tag: b.tag,
      comm: b.comm, comm_done: b.comm_done, comm_pending: b.comm_pending,
      gmv: b.gmv, qty: b.qty, refund: b.refund,
      orders: b.orders.size, order_keys: [...b.orders], excluded: b.excluded, rows: b.rows,
    })).sort((a, b) => a.date.localeCompare(b.date) || a.tag.localeCompare(b.tag));
  }

  /* Meta ads export → one record per (date, ad_unit).
     Already daily, but the same ad can appear on several rows per day. */
  function aggregateAds(rows) {
    const by = new Map();
    for (const r of rows) {
      const date = day(r['Reporting starts']);
      if (!isDate(date)) continue;
      const unit = String(pick(r, ['Ad name', 'Campaign name', 'Ad set name'])).trim() || '(tanpa nama)';
      const key = date + '|' + unit;
      let b = by.get(key);
      if (!b) {
        b = { date, ad_unit: unit, spend: 0, impressions: 0, reach: 0, clicks: 0,
              shop_clicks: 0, lpv: 0, results: 0, delivery: '', rows: 0 };
        by.set(key, b);
      }
      b.rows++;
      b.spend += num(pick(r, ['Amount spent (IDR)', 'Amount spent']));
      b.impressions += num(r['Impressions']);
      b.reach += num(r['Reach']);
      b.clicks += num(r['Link clicks']);
      b.shop_clicks += num(r['shop_clicks']);
      b.lpv += num(r['Landing page views']);
      b.results += num(r['Results']);
      if (r['Ad delivery']) b.delivery = String(r['Ad delivery']).trim();
    }
    // Derived rates are computed from the summed totals, never averaged from
    // per-row rates — averaging CPM across rows is not the day's CPM.
    return [...by.values()].map(b => ({
      ...b,
      cpm: b.impressions > 0 ? b.spend / b.impressions * 1000 : 0,
      cpc: b.clicks > 0 ? b.spend / b.clicks : 0,
      ctr: b.impressions > 0 ? b.clicks / b.impressions * 100 : 0,
    })).sort((a, b) => a.date.localeCompare(b.date) || a.ad_unit.localeCompare(b.ad_unit));
  }

  /* click report → one record per (date, tag), with breakdowns kept compact */
  function aggregateClicks(rows) {
    const by = new Map();
    for (const r of rows) {
      const date = day(r['Waktu Klik']);
      if (!isDate(date)) continue;
      const tag = cleanTag(pick(r, ['Tag_link', 'Tag_link1']));
      const key = date + '|' + tag;
      let b = by.get(key);
      if (!b) { b = { date, tag, clicks: 0, by_region: Object.create(null), by_source: Object.create(null) }; by.set(key, b); }
      b.clicks++;
      const reg = String(r['Wilayah Klik'] || '-').trim() || '-';
      const src = String(r['Perujuk'] || '-').trim() || '-';
      b.by_region[reg] = (b.by_region[reg] || 0) + 1;
      b.by_source[src] = (b.by_source[src] || 0) + 1;
    }
    return [...by.values()].sort((a, b) =>
      a.date.localeCompare(b.date) || a.tag.localeCompare(b.tag));
  }

  /* Compare incoming daily records against what is already stored, so the user
     is told what will change BEFORE anything is written. */
  function planIngest(incoming, existingKeys, keyFields) {
    const keyOf = r => keyFields.map(f => r[f]).join('|');
    const have = existingKeys instanceof Set ? existingKeys : new Set(existingKeys || []);
    const fresh = [], overlap = [];
    for (const r of incoming) (have.has(keyOf(r)) ? overlap : fresh).push(r);
    const dates = incoming.map(r => r.date).filter(isDate).sort();
    return {
      fresh, overlap,
      newCount: fresh.length, updateCount: overlap.length,
      period: dates.length ? { start: dates[0], end: dates[dates.length - 1] } : null,
      days: new Set(dates).size,
    };
  }

  function aggregate(kind, rows) {
    if (kind === 'affiliate') return aggregateAffiliate(rows);
    if (kind === 'ads') return aggregateAds(rows);
    if (kind === 'clicks') return aggregateClicks(rows);
    throw new Error('Jenis laporan tidak dikenal');
  }

  // Incoming records contain only unseen source rows. Add their contributions
  // instead of overwriting the already stored day with a partial total.
  function mergeDaily(kind, previous, incoming) {
    const result = { ...previous, ...incoming };
    const fields = kind === 'affiliate'
      ? ['comm', 'comm_done', 'comm_pending', 'gmv', 'qty', 'refund', 'excluded', 'rows']
      : kind === 'ads'
        ? ['spend', 'impressions', 'reach', 'clicks', 'shop_clicks', 'lpv', 'results', 'rows']
        : ['clicks'];
    fields.forEach(f => { result[f] = num(previous[f]) + num(incoming[f]); });
    if (kind === 'affiliate') {
      result.order_keys = [...new Set([...(previous.order_keys || []), ...(incoming.order_keys || [])])];
      result.orders = result.order_keys.length;
    } else if (kind === 'ads') {
      result.cpm = result.impressions ? result.spend / result.impressions * 1000 : 0;
      result.cpc = result.clicks ? result.spend / result.clicks : 0;
      result.ctr = result.impressions ? result.clicks / result.impressions * 100 : 0;
      result.delivery = incoming.delivery || previous.delivery || '';
    } else {
      for (const f of ['by_region', 'by_source']) {
        result[f] = Object.assign(Object.create(null), previous[f] || {});
        Object.entries(incoming[f] || {}).forEach(([key, value]) => { result[f][key] = num(result[f][key]) + num(value); });
      }
    }
    return result;
  }

  return {
    hashRow, hashRows, dedupe,
    aggregateAffiliate, aggregateAds, aggregateClicks,
    planIngest, num, day, isDate, rowDate, aggregate, mergeDaily,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = DailyAgg;
if (typeof window !== 'undefined') window.DailyAgg = DailyAgg;
