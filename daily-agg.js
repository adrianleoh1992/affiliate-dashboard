/* ── Daily aggregation: pure functions, no DOM, no IndexedDB ────────────────
   Split out from storage on purpose. These functions turn raw CSV rows into
   deduped daily records that can be verified in Node against the real files,
   before any of it reaches a database. Storage bugs are recoverable; wrong
   numbers written to a server are not.

   Grain:
     affiliate → (date, tag)      from (order, product) transaction rows,
                                  holding one part per order (order_parts)
     ads       → (date, ad_key)   already daily in Meta's export; ad_key is
                                  the Ad ID when the row has one, else the name
     clicks    → (date, tag)      from individual click rows

   Two ways a later upload meets saved history (merge_version):
     2  Revisions replace. A commission report lists every item of each order
        it contains, so an order in a new file replaces that order's saved
        part: Tertunda → Selesai updates, it never adds the order again.
        An ad row with an Ad ID replaces the saved (date, Ad ID) row, so a
        re-pull of recent days takes Meta's corrected numbers.
     1  Unseen rows add. Clicks are immutable events and Meta exports without
        IDs have nothing stable to replace by, so rows are deduplicated by a
        fingerprint of the WHOLE row and only unseen rows are added. A
        composite key like order+product+time+commission looks reasonable but
        silently drops 1.408 legitimate rows in the reference data — one order
        carries several products at different prices, and those rows collide
        on every "obvious" key.
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

  // Meta ad IDs are digit strings. Spreadsheets keep 15 significant digits,
  // so a longer ID whose tail is all zeros was probably rounded and could
  // stand for several ads; such a row is keyed by name, like an export
  // without IDs. That fallback is the safe direction: it never merges ads.
  function adIdOf(r) {
    const id = String(r['Ad ID'] == null ? '' : r['Ad ID']).trim();
    if (!/^\d{6,20}$/.test(id)) return '';
    return id.length > 15 && /^0+$/.test(id.slice(15)) ? '' : id;
  }
  // Rows whose saved history adds rather than replaces carry fingerprints.
  const fingerprinted = (kind, r) => kind === 'clicks' || (kind === 'ads' && !adIdOf(r));
  const mergeVersion = (kind, record) =>
    kind === 'affiliate' ? (record.order_parts ? 2 : 1) : kind === 'ads' && record.ad_id ? 2 : 1;

  /* One part per order: [comm, comm_done, comm_pending, gmv, qty, refund,
     excluded, rows]. Rows without an order ID get a part of their own, keyed
     by their fingerprint. Totals are always summed over the parts in key
     order, so the browser and the database get bit-identical numbers. */
  const ORDER_KEY = /^[0-9a-f]{16}$/, PART_KEY = /^(?:r:)?[0-9a-f]{16}$/;
  const AMOUNTS = ['comm', 'comm_done', 'comm_pending', 'gmv', 'qty', 'refund'];
  function sortedParts(parts) {
    const out = {};
    for (const key of Object.keys(parts).sort()) out[key] = parts[key];
    return out;
  }
  function partsTotals(parts) {
    const totals = { comm: 0, comm_done: 0, comm_pending: 0, gmv: 0, qty: 0, refund: 0, orders: 0, excluded: 0, rows: 0 };
    for (const key of Object.keys(parts).sort()) {
      const part = parts[key];
      AMOUNTS.forEach((name, i) => { totals[name] += part[i]; });
      totals.excluded += part[6];
      totals.rows += part[7];
      if (ORDER_KEY.test(key) && part[7] > part[6]) totals.orders++;
    }
    return totals;
  }

  /* Drop rows whose full-content hash was already seen. Returns the survivors
     plus the hashes, so a caller can persist them for cross-file dedup. */
  function dedupe(rows, seenHashes) {
    const seen = seenHashes instanceof Set ? seenHashes : new Set(seenHashes || []);
    const kept = [], hashes = [];
    let duplicates = 0;
    for (const r of rows) {
      const h = hashRow(r);
      // The validated reader normalizes numeric cells/headers. Old v2 row
      // guards hash the original strings, so test that exact source shape as
      // well. Only new canonical hashes are persisted: there remains exactly
      // one fingerprint per aggregate source row, including after backup.
      const source = r[Symbol.for('affiliate-dashboard.source-row')];
      const sourceHash = source ? hashRow(source) : h;
      const duplicate = seen.has(h) || seen.has(sourceHash);
      seen.add(h); seen.add(sourceHash);
      if (duplicate) { duplicates++; continue; }
      kept.push(r); hashes.push(h);
    }
    return { kept, hashes, duplicates, total: rows.length };
  }

  /* affiliate transactions → one record per (date, tag), one part per order

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
      if (!b) { b = { date, tag, parts: new Map() }; by.set(key, b); }
      const orderId = String(r['ID Pemesanan'] || '').trim();
      const id = orderId ? hashRow({ orderId }) : 'r:' + hashRow(r);
      let part = b.parts.get(id);
      if (!part) { part = [0, 0, 0, 0, 0, 0, 0, 0]; b.parts.set(id, part); }
      part[7]++;
      if (EXCLUDE.has(status)) { part[6]++; continue; }
      const comm = num(pick(r, ['Total Komisi per Produk(Rp)', 'Total Komisi per Pesanan(Rp)', 'Komisi Bersih Affiliate (Rp)']));
      part[0] += comm;
      if (status === 'Selesai') part[1] += comm;
      else if (status === 'Tertunda') part[2] += comm;
      part[3] += num(r['Nilai Pembelian(Rp)']);
      part[4] += num(r['Jumlah']);
      part[5] += num(r['Jumlah Pengembalian Dana(Rp)']);
    }
    return [...by.values()].map(b => {
      const order_parts = sortedParts(Object.fromEntries(b.parts));
      return { date: b.date, tag: b.tag, ...partsTotals(order_parts), order_parts };
    }).sort((a, b) => a.date.localeCompare(b.date) || a.tag.localeCompare(b.tag));
  }

  /* Meta ads export → one record per (date, ad_key): the Ad ID when the row
     has a usable one, else the ad name (ad_unit is the name either way).
     Already daily, but the same ad can appear on several rows per day. */
  function aggregateAds(rows) {
    const by = new Map();
    for (const r of rows) {
      const date = day(r['Reporting starts']);
      if (!isDate(date)) continue;
      const unit = String(pick(r, ['Ad name', 'Campaign name', 'Ad set name'])).trim() || '(tanpa nama)';
      const id = adIdOf(r), adKey = id ? 'id:' + id : 'name:' + unit;
      const key = date + '|' + adKey;
      let b = by.get(key);
      if (!b) {
        b = { date, ad_id: id, ad_key: adKey, ad_unit: unit, spend: 0, impressions: 0, reach: 0, clicks: 0,
              shop_clicks: 0, lpv: 0, results: 0, delivery: '', rows: 0 };
        by.set(key, b);
      }
      if (id) b.ad_unit = unit;
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
    })).sort((a, b) => a.date.localeCompare(b.date) || a.ad_key.localeCompare(b.ad_key));
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

  /* The one ingestion path, shared by the browser store and the shared
     database: drop invalid dates, deduplicate, aggregate. Rows that replace
     (orders, ad IDs) are deduplicated within the file only; fingerprinted
     rows also against the fingerprints already saved (known). */
  function prepare(kind, rows, known) {
    const saved = known instanceof Set ? known : new Set(known || []);
    const valid = rows.filter(r => isDate(rowDate(r, kind)));
    const seen = new Set(), kept = [], hashes = [];
    let duplicates = 0;
    for (const r of valid) {
      // The validated reader normalizes numeric cells/headers. Old v2 row
      // guards hash the original strings, so test that exact source shape too.
      const h = hashRow(r), source = r[Symbol.for('affiliate-dashboard.source-row')];
      const sourceHash = source ? hashRow(source) : h, fp = fingerprinted(kind, r);
      const duplicate = seen.has(h) || seen.has(sourceHash) || (fp && (saved.has(h) || saved.has(sourceHash)));
      seen.add(h); seen.add(sourceHash);
      if (duplicate) { duplicates++; continue; }
      kept.push(r);
      if (fp) hashes.push({ hash: h, date: rowDate(r, kind) });
    }
    const dates = valid.map(r => rowDate(r, kind)).sort();
    return { records: aggregate(kind, kept), hashes, duplicates, invalid: rows.length - valid.length,
      period: dates.length ? { start: dates[0], end: dates[dates.length - 1] } : null };
  }

  const recordKey = (kind, r) => r.date + '|' + (kind === 'ads' ? r.ad_key || 'name:' + r.ad_unit : r.tag);
  const AD_FIELDS = ['ad_unit', 'spend', 'impressions', 'reach', 'clicks', 'shop_clicks', 'lpv', 'results', 'rows'];
  const samePart = (a, b) => Array.isArray(a) && a.length === b.length && a.every((value, i) => value === b[i]);

  /* What the incoming records change. stored maps recordKey → saved record.
     Order parts and ID rows identical to what is saved are left out and
     counted as duplicate rows; an affiliate record keeps only its changed
     parts, which the store (or the database) merges into the saved record. */
  function changes(kind, records, stored) {
    const write = [];
    let duplicates = 0;
    for (const r of records) {
      const saved = stored.get(recordKey(kind, r));
      if (kind === 'affiliate' && r.order_parts && saved && saved.order_parts) {
        const parts = {};
        for (const [key, part] of Object.entries(r.order_parts)) {
          if (samePart(saved.order_parts[key], part)) duplicates += part[7];
          else parts[key] = part;
        }
        if (Object.keys(parts).length) write.push({ ...r, ...partsTotals(parts), order_parts: parts });
      } else if (kind === 'ads' && r.ad_id && saved && AD_FIELDS.every(f => saved[f] === r[f]) &&
          (!r.delivery || r.delivery === saved.delivery)) {
        duplicates += r.rows;
      } else write.push(r);
    }
    return { write, duplicates };
  }

  /* Day-level rules before anything is written. days maps each incoming date
     to every saved record of that kind and date. Returns the dates whose
     fingerprints the write removes (affiliate days converted to order parts).
       - An affiliate day saved in the fingerprint format (merge_version 1)
         converts only as a whole: every such record of the day must be in
         the file, with all of its orders. Otherwise its fingerprints and the
         new parts would disagree.
       - One ad must not be saved twice for a day, once from an export without
         IDs (by name) and once with its Ad ID: that is the same spend. */
  function checkDays(kind, records, days) {
    const clear = [];
    if (kind === 'affiliate') {
      for (const [date, saved] of days) {
        const incoming = new Map(records.filter(r => r.date === date).map(r => [r.tag, r]));
        const v1 = saved.filter(r => r.merge_version === 1);
        const touched = v1.filter(r => incoming.has(r.tag));
        if (!touched.length) continue;
        const missing = v1.filter(r => !incoming.has(r.tag) || !(r.order_keys || []).every(key => key in incoming.get(r.tag).order_parts));
        if (missing.length) throw new Error(`Riwayat komisi ${date} tersimpan dalam format lama dan file ini tidak memuat semua pesanannya `
          + `(${missing.slice(0, 3).map(r => r.tag).join(', ')}). Riwayat lama tanggal itu perlu dihapus lalu diunggah ulang dengan laporan lengkapnya.`);
        clear.push(date);
      }
    } else if (kind === 'ads') {
      const clashes = [];
      for (const [date, saved] of days) {
        const mine = records.filter(r => r.date === date), all = saved.concat(mine);
        const byName = new Set(all.filter(r => !r.ad_id).map(r => r.ad_unit)), byId = new Set(all.filter(r => r.ad_id).map(r => r.ad_unit));
        for (const r of mine) if ((r.ad_id ? byName : byId).has(r.ad_unit)) clashes.push(`${date} (${r.ad_unit})`);
      }
      if (clashes.length) throw new Error('Iklan ini sudah tersimpan dari sumber lain pada tanggal yang sama, sekali tanpa Ad ID (ekspor CSV) dan sekali dengan Ad ID: '
        + [...new Set(clashes)].slice(0, 5).join(', ') + '. Hapus tanggal itu di Data Tersimpan lalu simpan lagi agar biaya tidak terhitung dua kali.');
    }
    return clear;
  }

  function aggregate(kind, rows) {
    if (kind === 'affiliate') return aggregateAffiliate(rows);
    if (kind === 'ads') return aggregateAds(rows);
    if (kind === 'clicks') return aggregateClicks(rows);
    throw new Error('Jenis laporan tidak dikenal');
  }

  // Saved record + incoming record for the same key. Order parts and ad rows
  // with an ID replace (merge_version 2); otherwise incoming records hold only
  // unseen source rows, so their contributions add instead of overwriting the
  // stored day with a partial total.
  function mergeDaily(kind, previous, incoming) {
    if (kind === 'affiliate' && incoming.order_parts) {
      if (!previous.order_parts && !(Array.isArray(previous.order_keys) && previous.order_keys.every(key => key in incoming.order_parts))) {
        throw new Error(`Riwayat lama ${incoming.date} (${incoming.tag}) perlu dihapus lalu diunggah ulang sebelum digabung`);
      }
      const order_parts = sortedParts({ ...(previous.order_parts || {}), ...incoming.order_parts });
      const result = { ...previous, ...incoming, ...partsTotals(order_parts), order_parts };
      delete result.order_keys;
      return result;
    }
    if (kind === 'ads' && incoming.ad_id) return { ...previous, ...incoming, delivery: incoming.delivery || previous.delivery || '' };
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
    hashRow, hashRows, dedupe, prepare, changes, checkDays, recordKey,
    aggregateAffiliate, aggregateAds, aggregateClicks, adIdOf, fingerprinted, mergeVersion,
    partsTotals, sortedParts, ORDER_KEY, PART_KEY, AMOUNTS,
    planIngest, num, day, isDate, rowDate, aggregate, mergeDaily,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = DailyAgg;
if (typeof window !== 'undefined') window.DailyAgg = DailyAgg;
