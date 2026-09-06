/* Account-isolated daily history. Every write, dedup guard and upload log
   commits in one IndexedDB transaction; raw CSV rows are never persisted. */
'use strict';
const DailyStore = (() => {
  const DB_NAME = 'affiliate_daily', VERSION = 2;
  const KINDS = ['affiliate', 'ads', 'clicks'];
  const agg = () => typeof DailyAgg !== 'undefined' ? DailyAgg : require('./daily-agg');
  const kindOf = kind => {
    if (!KINDS.includes(kind)) throw new Error('Jenis laporan tidak dikenal');
    return kind;
  };
  const bounds = id => IDBKeyRange.bound([id, '0000-00-00'], [id, '9999-99-99']);
  const rq = r => new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, VERSION);
      let blocked = false;
      req.onerror = () => reject(req.error);
      req.onblocked = () => { blocked = true; reject(new Error('Database terkunci oleh tab lain; tutup tab lama lalu muat ulang')); };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => db.close();
        if (blocked) db.close(); else resolve(db);
      };
      req.onupgradeneeded = () => {
        const db = req.result, tx = req.transaction;
        if (!db.objectStoreNames.contains('accounts')) {
          db.createObjectStore('accounts', { keyPath: 'id', autoIncrement: true })
            .createIndex('kind_name', ['kind', 'name'], { unique: true });
        }
        for (const kind of KINDS) {
          if (!db.objectStoreNames.contains(kind)) {
            const s = db.createObjectStore(kind, { keyPath: 'id', autoIncrement: true });
            const field = kind === 'ads' ? 'unit' : 'tag';
            s.createIndex('acct_date_' + field, ['account_id', 'date', kind === 'ads' ? 'ad_unit' : 'tag'], { unique: true });
            s.createIndex('acct_date', ['account_id', 'date']);
          }
        }
        let uploads;
        if (!db.objectStoreNames.contains('uploads')) {
          uploads = db.createObjectStore('uploads', { keyPath: 'id', autoIncrement: true });
          uploads.createIndex('acct', 'account_id');
        } else uploads = tx.objectStore('uploads');
        // Report kinds must not share a file guard. Keep the old lookup API.
        if (uploads.indexNames.contains('acct_hash')) uploads.deleteIndex('acct_hash');
        uploads.createIndex('acct_hash', ['account_id', 'file_hash']);
        if (!uploads.indexNames.contains('acct_kind_hash')) uploads.createIndex('acct_kind_hash', ['account_id', 'kind', 'file_hash'], { unique: true });
        let hashes;
        if (!db.objectStoreNames.contains('rowhashes')) {
          hashes = db.createObjectStore('rowhashes', { keyPath: 'id', autoIncrement: true });
          hashes.createIndex('acct_kind_hash', ['account_id', 'kind', 'hash'], { unique: true });
          hashes.createIndex('acct_kind', ['account_id', 'kind']);
        } else hashes = tx.objectStore('rowhashes');
        if (!hashes.indexNames.contains('acct_kind_date')) hashes.createIndex('acct_kind_date', ['account_id', 'kind', 'date']);
      };
    });
  }

  class Store {
    constructor(db) { this.db = db; }
    static async open() { return new Store(await openDB()); }
    close() { this.db.close(); }

    async transaction(names, mode, work) {
      const tx = this.db.transaction(names, mode);
      // Attach completion listeners BEFORE issuing requests, including no-ops.
      const completion = new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onabort = () => reject(tx.error || new Error('Transaksi dibatalkan'));
        tx.onerror = () => {}; // onabort carries the final transaction outcome.
      });
      completion.catch(() => {});
      try {
        const result = await work(tx);
        await completion;
        return result;
      } catch (error) {
        try { tx.abort(); } catch (_) {}
        await completion.catch(() => {});
        throw error;
      }
    }
    async listAccounts(kind) {
      return this.transaction('accounts', 'readonly', async tx => {
        const rows = await rq(tx.objectStore('accounts').getAll());
        return kind ? rows.filter(a => a.kind === kind) : rows;
      });
    }
    async ensureAccount(kind, name, meta) {
      name = String(name || '').trim();
      if (!name) throw new Error('Nama akun kosong');
      if (!['shopee', 'ads'].includes(kind)) throw new Error('Jenis akun tidak dikenal');
      return this.transaction('accounts', 'readwrite', async tx => {
        const s = tx.objectStore('accounts');
        const found = await rq(s.index('kind_name').get([kind, name]));
        if (found) return found;
        const rec = { ...(meta || {}), kind, name, created: new Date().toISOString() };
        delete rec.id;
        rec.id = await rq(s.add(rec));
        return rec;
      });
    }
    async renameAccount(id, name) {
      name = String(name || '').trim();
      if (!name) throw new Error('Nama akun kosong');
      return this.transaction('accounts', 'readwrite', async tx => {
        const s = tx.objectStore('accounts'), rec = await rq(s.get(id));
        if (!rec) throw new Error('Akun tidak ditemukan');
        rec.name = name;
        await rq(s.put(rec));
        return rec;
      });
    }
    async deleteAccount(id) {
      return this.transaction(['accounts', ...KINDS, 'uploads', 'rowhashes'], 'readwrite', async tx => {
        tx.objectStore('accounts').delete(id);
        for (const kind of KINDS) {
          const s = tx.objectStore(kind);
          (await rq(s.index('acct_date').getAllKeys(bounds(id)))).forEach(key => s.delete(key));
          const hs = tx.objectStore('rowhashes');
          (await rq(hs.index('acct_kind').getAllKeys([id, kind]))).forEach(key => hs.delete(key));
        }
        const ups = tx.objectStore('uploads');
        (await rq(ups.index('acct').getAllKeys(id))).forEach(key => ups.delete(key));
      });
    }
    async seenFile(accountId, fileHash, kind) {
      return this.transaction('uploads', 'readonly', async tx => {
        const s = tx.objectStore('uploads');
        return (await rq(kind ? s.index('acct_kind_hash').get([accountId, kindOf(kind), fileHash])
          : s.index('acct_hash').get([accountId, fileHash]))) || null;
      });
    }
    async knownRowHashes(accountId, kind) {
      kindOf(kind);
      return this.transaction('rowhashes', 'readonly', async tx => new Set(
        (await rq(tx.objectStore('rowhashes').index('acct_kind').getAll([accountId, kind]))).map(r => r.hash)));
    }
    async existingKeys(accountId, kind) {
      const field = kindOf(kind) === 'ads' ? 'ad_unit' : 'tag';
      return new Set((await this.range(accountId, kind)).map(r => `${r.date}|${r[field]}`));
    }

    // New ingestion passes rawRows for transactional row dedup. They are used
    // only in memory; the store retains daily figures, hashed order IDs and
    // dated row fingerprints. The older aggregate API remains a replacement.
    async saveDaily(accountId, kind, records, opts) {
      kindOf(kind);
      const o = opts || {}, A = agg(), field = kind === 'ads' ? 'ad_unit' : 'tag';
      const indexName = kind === 'ads' ? 'acct_date_unit' : 'acct_date_tag';
      return this.transaction(['accounts', kind, 'rowhashes', 'uploads'], 'readwrite', async tx => {
        if (!await rq(tx.objectStore('accounts').get(accountId))) throw new Error('Akun tidak ditemukan');
        const uploads = tx.objectStore('uploads');
        if (o.fileHash && await rq(uploads.index('acct_kind_hash').get([accountId, kind, o.fileHash]))) {
          return { added: 0, updated: 0, duplicates: o.sourceRows || 0, skipped: true };
        }
        const hs = tx.objectStore('rowhashes');
        const knownRows = await rq(hs.index('acct_kind').getAll([accountId, kind]));
        const known = new Map(knownRows.map(r => [r.hash, r]));
        let hashes = [], duplicates = o.duplicates || 0, period = o.period;
        const incremental = Array.isArray(o.rawRows);
        if (incremental) {
          const valid = o.rawRows.filter(r => A.isDate(A.rowDate(r, kind)));
          const dates = valid.map(r => A.rowDate(r, kind)).sort();
          period = dates.length ? { start: dates[0], end: dates[dates.length - 1] } : null;
          const dedup = A.dedupe(valid, new Set(known.keys()));
          duplicates = dedup.duplicates;
          records = A.aggregate(kind, dedup.kept);
          hashes = dedup.kept.map((r, i) => ({ hash: dedup.hashes[i], date: A.rowDate(r, kind) }));
        } else {
          hashes = [...new Set(o.rowHashes || [])].filter(h => !known.has(h)).map(hash => ({ hash,
            date: records.length && records.every(r => r.date === records[0].date) ? records[0].date : null }));
        }
        const store = tx.objectStore(kind), idx = store.index(indexName);
        let added = 0, updated = 0;
        for (const r of records || []) {
          if (!A.isDate(r.date) || typeof r[field] !== 'string' || !r[field]) throw new Error('Record harian tidak valid');
          const found = await rq(idx.get([accountId, r.date, r[field]]));
          if (incremental && found && found.merge_version !== 1) {
            throw new Error(`Riwayat lama ${r.date} perlu dihapus lalu diunggah ulang sebelum digabung`);
          }
          const rec = incremental && found ? A.mergeDaily(kind, found, r) : { ...r };
          delete rec.id;
          rec.account_id = accountId;
          if (incremental) rec.merge_version = 1;
          if (found) {
            await rq(store.put({ ...rec, id: found.id, created_at: found.created_at, updated_at: new Date().toISOString() }));
            updated++;
          } else {
            await rq(store.add({ ...rec, created_at: new Date().toISOString() }));
            added++;
          }
        }
        // No caught ConstraintError: duplicate guards were checked in this
        // same serialized transaction. Other failures must roll everything back.
        await Promise.all(hashes.map(h => rq(hs.add({ ...h, account_id: accountId, kind }))));
        if (o.fileHash) await rq(uploads.add({
          account_id: accountId, kind, file_hash: o.fileHash, file_name: o.fileName || '',
          rows: o.sourceRows || 0, added, updated, duplicates,
          period_start: period ? period.start : null, period_end: period ? period.end : null,
          uploaded_at: new Date().toISOString(),
        }));
        return { added, updated, duplicates };
      });
    }
    async range(accountId, kind, start, end) {
      kindOf(kind);
      const A = agg();
      if ((start && !A.isDate(start)) || (end && !A.isDate(end))) throw new Error('Tanggal tidak valid');
      if (start && end && start > end) throw new Error('Tanggal mulai harus sebelum tanggal akhir');
      return this.transaction(kind, 'readonly', tx => rq(tx.objectStore(kind).index('acct_date')
        .getAll(IDBKeyRange.bound([accountId, start || '0000-00-00'], [accountId, end || '9999-99-99']))));
    }
    async deleteDay(accountId, kind, date) {
      kindOf(kind);
      if (!agg().isDate(date)) throw new Error('Tanggal tidak valid');
      return this.transaction([kind, 'rowhashes', 'uploads'], 'readwrite', async tx => {
        const s = tx.objectStore(kind), keys = await rq(s.index('acct_date').getAllKeys([accountId, date]));
        keys.forEach(key => s.delete(key));
        const hs = tx.objectStore('rowhashes');
        const hashes = await rq(hs.index('acct_kind').getAll([accountId, kind]));
        // Legacy fingerprints have no date. Clear these too; saveDaily refuses
        // to append to legacy aggregates, so retained history cannot double count.
        hashes.filter(h => h.date === date || !h.date).forEach(h => hs.delete(h.id));
        const ups = tx.objectStore('uploads');
        const uploads = await rq(ups.index('acct').getAll(accountId));
        uploads.filter(u => u.kind === kind && (!u.period_start || !u.period_end ||
          (u.period_start <= date && u.period_end >= date))).forEach(u => ups.delete(u.id));
        return keys.length;
      });
    }
    // Forgetting an upload only clears its file guard. Row dedup still protects
    // existing daily totals; deleteDay is the supported correction workflow.
    async forgetUpload(id) {
      return this.transaction('uploads', 'readwrite', async tx => {
        const s = tx.objectStore('uploads'), rec = await rq(s.get(id));
        if (rec) s.delete(id);
        return rec || null;
      });
    }
    async dailyIndex(accountId, kind) {
      const by = new Map();
      for (const r of await this.range(accountId, kind)) {
        const b = by.get(r.date) || { date: r.date, rows: 0, updated: '' };
        b.rows++;
        b.updated = [b.updated, r.updated_at || r.created_at || ''].sort().pop();
        by.set(r.date, b);
      }
      return [...by.values()].sort((a, b) => b.date.localeCompare(a.date));
    }
    async coverage(accountId) {
      const entries = await Promise.all(KINDS.map(async kind => {
        const rows = await this.range(accountId, kind), dates = [...new Set(rows.map(r => r.date))].sort();
        return [kind, { rows: rows.length, days: dates.length, start: dates[0] || null, end: dates[dates.length - 1] || null }];
      }));
      return Object.fromEntries(entries);
    }
    async uploadHistory(accountId, limit) {
      return this.transaction('uploads', 'readonly', async tx => {
        const rows = await rq(tx.objectStore('uploads').index('acct').getAll(accountId));
        rows.sort((a, b) => String(b.uploaded_at).localeCompare(String(a.uploaded_at)) || b.id - a.id);
        return limit > 0 ? rows.slice(0, limit) : rows;
      });
    }
    async exportAccount(accountId) {
      return this.transaction(['accounts', ...KINDS, 'uploads'], 'readonly', async tx => {
        const [account, affiliate, ads, clicks, uploads] = await Promise.all([
          rq(tx.objectStore('accounts').get(accountId)),
          ...KINDS.map(kind => rq(tx.objectStore(kind).index('acct_date').getAll(bounds(accountId)))),
          rq(tx.objectStore('uploads').index('acct').getAll(accountId)),
        ]);
        return { version: VERSION, exported_at: new Date().toISOString(), account, affiliate, ads, clicks, uploads };
      });
    }
    async estimate() {
      if (typeof navigator === 'undefined' || !navigator.storage || !navigator.storage.estimate) return null;
      const e = await navigator.storage.estimate();
      return { usage: e.usage, quota: e.quota, pct: e.quota ? e.usage / e.quota * 100 : 0 };
    }
  }
  return { open: () => Store.open(), DB_NAME };
})();
if (typeof window !== 'undefined') window.DailyStore = DailyStore;
if (typeof module !== 'undefined' && module.exports) module.exports = DailyStore;
