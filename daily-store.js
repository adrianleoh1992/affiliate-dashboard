/* ── Daily storage on IndexedDB ─────────────────────────────────────────────
   Persists the deduped daily records produced by daily-agg.js, keyed per
   account so two Shopee accounts never mix.

   IndexedDB transactions auto-close at the end of the current microtask, so a
   transaction must never be held across an `await`. Every method here opens a
   transaction, does all its work inside request callbacks, and resolves only
   when the transaction itself completes.

   Accounts are user-declared, not detected: the CSVs carry no account identity
   at all (no Account name in the Meta export, and "Nama Toko" in the affiliate
   report is the seller's shop, not the user's account).
*/
'use strict';

const DailyStore = (() => {
  const DB_NAME = 'affiliate_daily';
  const VERSION = 1;

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('Database terkunci oleh tab lain'));
      req.onsuccess = () => resolve(req.result);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('accounts')) {
          const s = db.createObjectStore('accounts', { keyPath: 'id', autoIncrement: true });
          s.createIndex('kind_name', ['kind', 'name'], { unique: true });
        }
        if (!db.objectStoreNames.contains('affiliate')) {
          const s = db.createObjectStore('affiliate', { keyPath: 'id', autoIncrement: true });
          s.createIndex('acct_date_tag', ['account_id', 'date', 'tag'], { unique: true });
          s.createIndex('acct_date', ['account_id', 'date']);
        }
        if (!db.objectStoreNames.contains('ads')) {
          const s = db.createObjectStore('ads', { keyPath: 'id', autoIncrement: true });
          s.createIndex('acct_date_unit', ['account_id', 'date', 'ad_unit'], { unique: true });
          s.createIndex('acct_date', ['account_id', 'date']);
        }
        if (!db.objectStoreNames.contains('clicks')) {
          const s = db.createObjectStore('clicks', { keyPath: 'id', autoIncrement: true });
          s.createIndex('acct_date_tag', ['account_id', 'date', 'tag'], { unique: true });
          s.createIndex('acct_date', ['account_id', 'date']);
        }
        if (!db.objectStoreNames.contains('uploads')) {
          const s = db.createObjectStore('uploads', { keyPath: 'id', autoIncrement: true });
          s.createIndex('acct_hash', ['account_id', 'file_hash'], { unique: true });
          s.createIndex('acct', 'account_id');
        }
        if (!db.objectStoreNames.contains('rowhashes')) {
          const s = db.createObjectStore('rowhashes', { keyPath: 'id', autoIncrement: true });
          s.createIndex('acct_kind_hash', ['account_id', 'kind', 'hash'], { unique: true });
          s.createIndex('acct_kind', ['account_id', 'kind']);
        }
      };
    });
  }

  /* Promisify one request. */
  const rq = r => new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  /* Resolve when the whole transaction commits — the only safe "it is written". */
  const done = tx => new Promise((res, rej) => {
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error || new Error('Transaksi dibatalkan'));
  });

  class Store {
    constructor(db) { this.db = db; }
    static async open() { return new Store(await openDB()); }
    close() { try { this.db.close(); } catch (e) {} }

    /* ── Accounts ───────────────────────────────────────────────────────── */
    async listAccounts(kind) {
      const tx = this.db.transaction('accounts', 'readonly');
      const all = await rq(tx.objectStore('accounts').getAll());
      return kind ? all.filter(a => a.kind === kind) : all;
    }

    async ensureAccount(kind, name, meta) {
      name = String(name || '').trim();
      if (!name) throw new Error('Nama akun kosong');
      const tx = this.db.transaction('accounts', 'readwrite');
      const store = tx.objectStore('accounts');
      const found = await rq(store.index('kind_name').get([kind, name]));
      if (found) { await done(tx); return found; }
      const rec = { kind, name, created: new Date().toISOString(), ...(meta || {}) };
      rec.id = await rq(store.add(rec));
      await done(tx);
      return rec;
    }

    async renameAccount(id, name) {
      const tx = this.db.transaction('accounts', 'readwrite');
      const store = tx.objectStore('accounts');
      const rec = await rq(store.get(id));
      if (!rec) { await done(tx); throw new Error('Akun tidak ditemukan'); }
      rec.name = String(name).trim();
      await rq(store.put(rec));
      await done(tx);
      return rec;
    }

    /* Deleting an account must take its data with it, or the rows become
       orphans that still count toward storage and can resurface. */
    async deleteAccount(id) {
      const names = ['accounts', 'affiliate', 'ads', 'clicks', 'uploads', 'rowhashes'];
      const tx = this.db.transaction(names, 'readwrite');
      tx.objectStore('accounts').delete(id);
      for (const s of ['affiliate', 'ads', 'clicks']) {
        const idx = tx.objectStore(s).index('acct_date');
        const keys = await rq(idx.getAllKeys(IDBKeyRange.bound([id, '0000-00-00'], [id, '9999-99-99'])));
        keys.forEach(k => tx.objectStore(s).delete(k));
      }
      const upKeys = await rq(tx.objectStore('uploads').index('acct').getAllKeys(IDBKeyRange.only(id)));
      upKeys.forEach(k => tx.objectStore('uploads').delete(k));
      for (const kind of ['affiliate', 'ads', 'clicks']) {
        const hk = await rq(tx.objectStore('rowhashes').index('acct_kind').getAllKeys(IDBKeyRange.only([id, kind])));
        hk.forEach(k => tx.objectStore('rowhashes').delete(k));
      }
      await done(tx);
    }

    /* ── Upload guards ──────────────────────────────────────────────────── */
    async seenFile(accountId, fileHash) {
      const tx = this.db.transaction('uploads', 'readonly');
      return (await rq(tx.objectStore('uploads').index('acct_hash').get([accountId, fileHash]))) || null;
    }

    async knownRowHashes(accountId, kind) {
      const tx = this.db.transaction('rowhashes', 'readonly');
      const rows = await rq(tx.objectStore('rowhashes').index('acct_kind')
        .getAll(IDBKeyRange.only([accountId, kind])));
      return new Set(rows.map(r => r.hash));
    }

    async existingKeys(accountId, kind) {
      const storeName = kind === 'ads' ? 'ads' : kind;
      const tx = this.db.transaction(storeName, 'readonly');
      const rows = await rq(tx.objectStore(storeName).index('acct_date')
        .getAll(IDBKeyRange.bound([accountId, '0000-00-00'], [accountId, '9999-99-99'])));
      const field = kind === 'ads' ? 'ad_unit' : 'tag';
      return new Set(rows.map(r => `${r.date}|${r[field]}`));
    }

    /* ── Writing daily records ──────────────────────────────────────────── */
    /* One transaction covers the records, the row hashes, and the upload log,
       so a failure leaves nothing half-written. */
    async saveDaily(accountId, kind, records, opts) {
      const o = opts || {};
      const storeName = kind === 'ads' ? 'ads' : kind;
      const idxName = kind === 'ads' ? 'acct_date_unit' : 'acct_date_tag';
      const field = kind === 'ads' ? 'ad_unit' : 'tag';
      const tx = this.db.transaction([storeName, 'rowhashes', 'uploads'], 'readwrite');
      const store = tx.objectStore(storeName);
      const idx = store.index(idxName);

      let added = 0, updated = 0;
      for (const r of records) {
        const key = [accountId, r.date, r[field]];
        const found = await rq(idx.get(key));
        if (found) {
          await rq(store.put({ ...found, ...r, account_id: accountId, id: found.id,
            updated_at: new Date().toISOString() }));
          updated++;
        } else {
          await rq(store.add({ ...r, account_id: accountId,
            created_at: new Date().toISOString() }));
          added++;
        }
      }

      if (o.rowHashes && o.rowHashes.length) {
        const hs = tx.objectStore('rowhashes');
        for (const h of o.rowHashes) {
          // Unique index rejects repeats; that is the intent, so swallow it.
          try { await rq(hs.add({ account_id: accountId, kind, hash: h })); } catch (e) {}
        }
      }

      if (o.fileHash) {
        try {
          await rq(tx.objectStore('uploads').add({
            account_id: accountId, kind, file_hash: o.fileHash,
            file_name: o.fileName || '', rows: o.sourceRows || 0,
            added, updated, duplicates: o.duplicates || 0,
            period_start: o.period ? o.period.start : null,
            period_end: o.period ? o.period.end : null,
            uploaded_at: new Date().toISOString(),
          }));
        } catch (e) {}
      }

      await done(tx);
      return { added, updated };
    }

    /* ── Reading ────────────────────────────────────────────────────────── */
    async range(accountId, kind, start, end) {
      const storeName = kind === 'ads' ? 'ads' : kind;
      const tx = this.db.transaction(storeName, 'readonly');
      const lo = start || '0000-00-00', hi = end || '9999-99-99';
      return rq(tx.objectStore(storeName).index('acct_date')
        .getAll(IDBKeyRange.bound([accountId, lo], [accountId, hi])));
    }

    async coverage(accountId) {
      const out = {};
      for (const kind of ['affiliate', 'ads', 'clicks']) {
        const rows = await this.range(accountId, kind);
        const dates = [...new Set(rows.map(r => r.date))].sort();
        out[kind] = {
          rows: rows.length, days: dates.length,
          start: dates[0] || null, end: dates[dates.length - 1] || null,
        };
      }
      return out;
    }

    async uploadHistory(accountId, limit) {
      const tx = this.db.transaction('uploads', 'readonly');
      const rows = await rq(tx.objectStore('uploads').index('acct').getAll(IDBKeyRange.only(accountId)));
      rows.sort((a, b) => String(b.uploaded_at).localeCompare(String(a.uploaded_at)));
      return limit ? rows.slice(0, limit) : rows;
    }

    /* Export everything for one account, so history is never trapped in a
       browser profile. */
    async exportAccount(accountId) {
      const tx = this.db.transaction('accounts', 'readonly');
      const acct = await rq(tx.objectStore('accounts').get(accountId));
      return {
        version: 1, exported_at: new Date().toISOString(), account: acct,
        affiliate: await this.range(accountId, 'affiliate'),
        ads: await this.range(accountId, 'ads'),
        clicks: await this.range(accountId, 'clicks'),
        uploads: await this.uploadHistory(accountId),
      };
    }

    async estimate() {
      if (!navigator.storage || !navigator.storage.estimate) return null;
      const e = await navigator.storage.estimate();
      return { usage: e.usage, quota: e.quota, pct: e.quota ? e.usage / e.quota * 100 : 0 };
    }
  }

  return { open: () => Store.open(), DB_NAME };
})();

if (typeof window !== 'undefined') window.DailyStore = DailyStore;
