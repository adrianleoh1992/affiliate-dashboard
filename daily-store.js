/* Account-isolated daily history. Every write, dedup guard and upload log
   commits in one IndexedDB transaction; raw CSV rows are never persisted. */
'use strict';
const DailyStore = (() => {
  // Version 3: ads are keyed by ad_key (Ad ID, or the name when a row has none).
  const DB_NAME = 'affiliate_daily', VERSION = 3;
  const KINDS = ['affiliate', 'ads', 'clicks'];
  const BACKUP_FORMAT = 'affiliate-daily-backup', BACKUP_VERSION = 1;
  const MAX_BACKUP_RECORDS = 500000;
  const MAX_BACKUP_BYTES = 50 * 1024 * 1024;
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

  // Backups are untrusted input. Build new records from the supported schema,
  // never spread imported objects into IndexedDB records or account settings.
  // options.maxRecords raises the record cap for the shared-database cache;
  // options.partial validates a set of changed rows, so the whole-account
  // day checks (one fingerprint per aggregated row) are skipped.
  function validateBackup(input, options = {}) {
    const maxRecords = options.maxRecords || MAX_BACKUP_RECORDS;
    const bad = message => { throw new Error('Cadangan tidak valid: ' + message); };
    const object = (value, keys, label) => {
      if (!value || typeof value !== 'object' || Array.isArray(value) ||
          ![Object.prototype, null].includes(Object.getPrototypeOf(value))) bad(label + ' harus berupa objek');
      if (keys && Object.keys(value).some(key => !keys.includes(key))) bad(label + ' memuat kolom tidak dikenal');
      return value;
    };
    const string = (value, label, max = 2048, empty = false) => {
      // Quoted CSV cells legitimately contain tabs/newlines (for example an
      // ad label). Preserve those on roundtrip; reject other control bytes.
      if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) bad(label + ' tidak valid');
      return value;
    };
    const number = (value, label, count = false) => {
      if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER ||
          (count && (!Number.isSafeInteger(value) || value < 0))) bad(label + ' harus berupa angka valid');
      return value;
    };
    const date = (value, label) => { if (!agg().isDate(value)) bad(label + ' tidak valid'); return value; };
    const stamp = (value, label) => {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?Z$/.test(value) ||
          !agg().isDate(value.slice(0, 10)) || !Number.isFinite(Date.parse(value))) bad(label + ' tidak valid');
      return value;
    };
    object(input, ['format', 'version', 'database_version', 'exported_at', 'account', ...KINDS, 'uploads', 'rowhashes', 'parameters'], 'berkas');
    if (input.format !== BACKUP_FORMAT || input.version !== BACKUP_VERSION || ![2, VERSION].includes(input.database_version))
      bad('format/versi tidak didukung. Gunakan cadangan lengkap terbaru, bukan ekspor riwayat lama atau snapshot');
    stamp(input.exported_at, 'waktu ekspor');
    const source = object(input.account, ['id', 'kind', 'name', 'created'], 'akun');
    if (!Number.isSafeInteger(source.id) || source.id <= 0 || source.kind !== 'shopee') bad('identitas akun sumber');
    const account = { id: source.id, kind: source.kind, name: string(source.name, 'nama akun') };
    if (source.created !== undefined) account.created = stamp(source.created, 'waktu akun');
    const result = { format: BACKUP_FORMAT, version: BACKUP_VERSION, database_version: VERSION,
      exported_at: input.exported_at, account };
    let total = 0, duplicates = 0;
    const list = (key, fields, validate, identity) => {
      const rows = input[key];
      if (!Array.isArray(rows) || (total += rows.length) > maxRecords) bad('jumlah record terlalu besar atau daftar ' + key + ' hilang');
      const records = new Map(), ids = new Set();
      for (const row of rows) {
        object(row, ['id', 'account_id', ...fields], key);
        if (row.account_id !== source.id) bad(key + ' mengandung data akun lain');
        if (row.id !== undefined) {
          if (!Number.isSafeInteger(row.id) || row.id <= 0 || ids.has(row.id)) bad('ID ' + key + ' tidak valid atau duplikat');
          ids.add(row.id);
        }
        const clean = { account_id: source.id, ...validate(row) }, keyValue = identity(clean), prior = records.get(keyValue);
        if (prior) {
          if (JSON.stringify(prior) !== JSON.stringify(clean)) bad('kunci ' + key + ' duplikat dengan isi berbeda');
          duplicates++;
        } else records.set(keyValue, clean);
      }
      result[key] = [...records.values()];
    };
    const timestamps = (row, clean) => {
      for (const field of ['created_at', 'updated_at']) if (row[field] !== undefined) clean[field] = stamp(row[field], field);
      if (row.merge_version !== undefined) clean.merge_version = row.merge_version;
      return clean;
    };
    // Order parts of a merge_version 2 commission record (DailyAgg.partsTotals).
    const orderParts = value => {
      object(value, null, 'rincian pesanan');
      const entries = Object.entries(value);
      if (!entries.length || entries.length > MAX_BACKUP_RECORDS) bad('rincian pesanan tidak valid');
      const out = {};
      for (const [key, part] of entries) {
        if (!agg().PART_KEY.test(key) || !Array.isArray(part) || part.length !== 8) bad('rincian pesanan tidak valid');
        part.forEach((value, i) => number(value, 'rincian pesanan', i >= 6));
        if (part[7] < 1 || part[6] > part[7]) bad('rincian pesanan tidak valid');
        out[key] = [...part];
      }
      return agg().sortedParts(out);
    };
    const amounts = {
      affiliate: ['comm', 'comm_done', 'comm_pending', 'gmv', 'qty', 'refund', 'orders', 'excluded', 'rows'],
      ads: ['spend', 'impressions', 'reach', 'clicks', 'shop_clicks', 'lpv', 'results', 'rows', 'cpm', 'cpc', 'ctr'],
      clicks: ['clicks'],
    };
    for (const kind of KINDS) {
      const field = kind === 'ads' ? 'ad_unit' : 'tag';
      const extras = kind === 'affiliate' ? ['order_keys', 'order_parts'] : kind === 'ads' ? ['delivery', 'ad_id', 'ad_key'] : ['by_region', 'by_source'];
      list(kind, ['date', field, ...amounts[kind], ...extras, 'merge_version', 'created_at', 'updated_at'], row => {
        const clean = { date: date(row.date, 'tanggal ' + kind), [field]: string(row[field], field) };
        for (const name of amounts[kind]) clean[name] = number(row[name], kind + '.' + name, ['orders', 'excluded', 'rows'].includes(name) || kind === 'clicks');
        const version = row.merge_version;
        if (version !== undefined && version !== 1 && (version !== 2 || kind === 'clicks')) bad('versi agregasi tidak didukung');
        if (kind === 'affiliate' && version === 2) {
          if (row.order_keys !== undefined) bad('identitas order tidak konsisten');
          clean.order_parts = orderParts(row.order_parts);
          const totals = agg().partsTotals(clean.order_parts);
          if (amounts.affiliate.some(name => totals[name] !== clean[name])) bad('jumlah komisi tidak sesuai rincian pesanannya');
        } else if (kind === 'affiliate') {
          if (row.order_parts !== undefined) bad('rincian pesanan hanya untuk agregasi versi 2');
          if (row.order_keys !== undefined) {
            if (!Array.isArray(row.order_keys) || row.order_keys.length > MAX_BACKUP_RECORDS ||
                row.order_keys.some(key => typeof key !== 'string' || !/^[a-f0-9]{16}$/.test(key)) ||
                new Set(row.order_keys).size !== row.order_keys.length || row.orders !== row.order_keys.length) bad('identitas order tidak konsisten');
            clean.order_keys = [...row.order_keys];
          } else if (row.merge_version === 1) bad('identitas order untuk agregasi gabungan hilang');
          if (row.excluded > row.rows || row.orders > row.rows - row.excluded) bad('jumlah order/baris tidak konsisten');
        }
        if (kind === 'ads') {
          clean.delivery = string(row.delivery, 'status iklan', 256, true);
          const id = row.ad_id === undefined ? '' : row.ad_id;
          if (typeof id !== 'string' || (version === 2 ? !/^\d{6,20}$/.test(id) : id !== '')) bad('Ad ID tidak valid');
          const key = id ? 'id:' + id : 'name:' + clean.ad_unit;
          if (row.ad_key !== undefined && row.ad_key !== key) bad('kunci iklan tidak valid');
          clean.ad_id = id;
          clean.ad_key = key;
        } else if (kind === 'clicks') {
          for (const name of extras) {
            const values = object(row[name], null, name);
            // Object.fromEntries preserves literal CSV labels such as
            // __proto__ safely as own data keys, never as prototype setters.
            const entries = Object.entries(values).map(([key, value]) => [string(key, name, 2048), number(value, name, true)]);
            if (entries.reduce((sum, [, value]) => sum + value, 0) !== row.clicks) bad(name + ' tidak sesuai jumlah klik');
            clean[name] = Object.fromEntries(entries);
          }
        }
        return timestamps(row, clean);
      }, row => JSON.stringify([row.date, kind === 'ads' ? row.ad_key : row[field]]));
    }
    list('rowhashes', ['kind', 'hash', 'date'], row => {
      if (!KINDS.includes(row.kind)) bad('jenis fingerprint');
      const hash = string(row.hash, 'fingerprint', 256);
      return { kind: row.kind, hash, date: row.date == null ? null : date(row.date, 'tanggal fingerprint') };
    }, row => JSON.stringify([row.kind, row.hash]));
    list('uploads', ['kind', 'file_hash', 'file_name', 'rows', 'added', 'updated', 'duplicates', 'period_start', 'period_end', 'uploaded_at'], row => {
      if (!KINDS.includes(row.kind)) bad('jenis unggahan');
      const clean = { kind: row.kind, file_hash: string(row.file_hash, 'hash berkas', 256),
        file_name: string(row.file_name || '', 'nama berkas', 1024, true) };
      for (const field of ['rows', 'added', 'updated', 'duplicates']) clean[field] = number(row[field] === undefined ? 0 : row[field], 'unggahan.' + field, true);
      clean.period_start = row.period_start == null ? null : date(row.period_start, 'awal periode');
      clean.period_end = row.period_end == null ? null : date(row.period_end, 'akhir periode');
      if (!!clean.period_start !== !!clean.period_end || clean.period_start > clean.period_end) bad('rentang unggahan');
      if (row.uploaded_at !== undefined) clean.uploaded_at = stamp(row.uploaded_at, 'waktu unggahan');
      return clean;
    }, row => JSON.stringify([row.kind, row.file_hash]));
    // Dated fingerprints must belong to an aggregate date that uses them
    // (merge_version 2 records have none). Keeping orphan guards would
    // silently suppress a later valid CSV upload.
    if (!options.partial) for (const kind of KINDS) {
      const fingerprinted = result[kind].filter(row => row.merge_version !== 2);
      const dates = new Set(fingerprinted.map(row => row.date));
      if (result.rowhashes.some(row => row.kind === kind && row.date && !dates.has(row.date))) bad('fingerprint tanpa data harian');
      const guarded = new Set(result.rowhashes.filter(row => row.kind === kind && row.date).map(row => row.date));
      if (result[kind].some(row => row.merge_version === 1 && !guarded.has(row.date))) bad('fingerprint agregasi gabungan hilang');
      const rowsByDay = new Map(), hashesByDay = new Map();
      for (const row of fingerprinted) {
        const day = rowsByDay.get(row.date) || { count: 0, modern: true };
        day.count += kind === 'clicks' ? row.clicks : row.rows;
        day.modern = day.modern && row.merge_version === 1;
        rowsByDay.set(row.date, day);
      }
      for (const row of result.rowhashes) if (row.kind === kind && row.date)
        hashesByDay.set(row.date, (hashesByDay.get(row.date) || 0) + 1);
      for (const [date, day] of rowsByDay) if (day.modern && day.count !== hashesByDay.get(date))
        bad('jumlah fingerprint tidak sesuai baris agregasi gabungan');
    }
    if (input.parameters !== undefined) {
      const numeric = ['ppn', 'thScale', 'thPantau', 'minSpend', 'minDays', 'lagDays', 'lagCoverage', 'streakDays', 'pendingFactor', 'targetROI'];
      object(input.parameters, [...numeric, 'dateStart', 'dateEnd'], 'parameter');
      result.parameters = Object.fromEntries(Object.entries(input.parameters).map(([key, value]) =>
        [key, numeric.includes(key) ? number(value, 'parameter.' + key) : value === '' ? '' : date(value, key)]));
    }
    const dates = [...new Set(KINDS.flatMap(kind => result[kind].map(row => row.date)))].sort();
    const summary = { source: account.name, days: dates.length, start: dates[0] || null, end: dates[dates.length - 1] || null,
      counts: Object.fromEntries([...KINDS, 'uploads', 'rowhashes'].map(kind => [kind, result[kind].length])), duplicates };
    return { data: result, summary };
  }

  function serializeBackup(input) {
    // Export exactly the schema that restore accepts. Compact JSON saves
    // space, while the byte check includes multibyte labels/account names.
    const { data } = validateBackup(input);
    const text = JSON.stringify(data);
    if (new TextEncoder().encode(text).byteLength > MAX_BACKUP_BYTES)
      throw new Error('Ukuran cadangan melebihi batas 50 MiB yang dapat dipulihkan. Ekspor tidak dibuat; riwayat tetap tersimpan.');
    return text;
  }

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
      req.onupgradeneeded = event => {
        const db = req.result, tx = req.transaction;
        if (!db.objectStoreNames.contains('accounts')) {
          db.createObjectStore('accounts', { keyPath: 'id', autoIncrement: true })
            .createIndex('kind_name', ['kind', 'name'], { unique: true });
        }
        for (const kind of KINDS) {
          if (!db.objectStoreNames.contains(kind)) {
            const s = db.createObjectStore(kind, { keyPath: 'id', autoIncrement: true });
            if (kind === 'ads') s.createIndex('acct_date_key', ['account_id', 'date', 'ad_key'], { unique: true });
            else s.createIndex('acct_date_tag', ['account_id', 'date', 'tag'], { unique: true });
            s.createIndex('acct_date', ['account_id', 'date']);
          }
        }
        // v3: one ad name may now hold several Ad IDs on a day, so the unique
        // key moves from the name to ad_key. Saved rows are name-keyed.
        const ads = tx.objectStore('ads');
        if (!ads.indexNames.contains('acct_date_key')) {
          if (ads.indexNames.contains('acct_date_unit')) ads.deleteIndex('acct_date_unit');
          ads.createIndex('acct_date_key', ['account_id', 'date', 'ad_key'], { unique: true });
          ads.openCursor().onsuccess = e => {
            const cursor = e.target.result;
            if (!cursor) return;
            if (!cursor.value.ad_key) cursor.update({ ...cursor.value, ad_id: '', ad_key: 'name:' + cursor.value.ad_unit });
            cursor.continue();
          };
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
      kindOf(kind);
      return new Set((await this.range(accountId, kind)).map(r => agg().recordKey(kind, r)));
    }

    // New ingestion passes rawRows; DailyAgg.prepare/checkDays/changes decide
    // what a file changes, the same way for the shared database. Raw rows are
    // used only in memory; the store retains daily figures, order parts under
    // hashed order IDs and dated row fingerprints. The older aggregate API
    // (records + rowHashes) remains a replacement.
    async saveDaily(accountId, kind, records, opts) {
      kindOf(kind);
      const o = opts || {}, A = agg(), field = kind === 'ads' ? 'ad_unit' : 'tag';
      const incremental = Array.isArray(o.rawRows);
      return this.transaction(['accounts', kind, 'rowhashes', 'uploads'], 'readwrite', async tx => {
        if (!await rq(tx.objectStore('accounts').get(accountId))) throw new Error('Akun tidak ditemukan');
        const uploads = tx.objectStore('uploads');
        if (o.fileHash && await rq(uploads.index('acct_kind_hash').get([accountId, kind, o.fileHash]))) {
          return { added: 0, updated: 0, duplicates: o.sourceRows || 0, skipped: true };
        }
        const hs = tx.objectStore('rowhashes'), store = tx.objectStore(kind);
        const knownRows = await rq(hs.index('acct_kind').getAll([accountId, kind]));
        let hashes = [], duplicates = o.duplicates || 0, period = o.period, clear = [];
        if (incremental) {
          const prep = A.prepare(kind, o.rawRows, knownRows.map(r => r.hash));
          const days = new Map();
          for (const date of new Set(prep.records.map(r => r.date))) days.set(date, await rq(store.index('acct_date').getAll([accountId, date])));
          clear = A.checkDays(kind, prep.records, days);
          const diff = A.changes(kind, prep.records, new Map([...days.values()].flat().map(r => [A.recordKey(kind, r), r])));
          records = diff.write;
          hashes = prep.hashes;
          duplicates = prep.duplicates + diff.duplicates;
          period = prep.period;
        } else {
          const known = new Set(knownRows.map(r => r.hash));
          hashes = [...new Set(o.rowHashes || [])].filter(h => !known.has(h)).map(hash => ({ hash,
            date: records.length && records.every(r => r.date === records[0].date) ? records[0].date : null }));
        }
        const idx = store.index(kind === 'ads' ? 'acct_date_key' : 'acct_date_tag');
        let added = 0, updated = 0;
        for (const r of records || []) {
          if (!A.isDate(r.date) || typeof r[field] !== 'string' || !r[field]) throw new Error('Record harian tidak valid');
          const record = kind === 'ads' && !r.ad_key ? { ...r, ad_id: r.ad_id || '', ad_key: 'name:' + r.ad_unit } : r;
          const found = await rq(idx.get([accountId, record.date, kind === 'ads' ? record.ad_key : record.tag]));
          const rec = incremental && found ? A.mergeDaily(kind, found, record) : { ...record };
          delete rec.id;
          rec.account_id = accountId;
          if (incremental) rec.merge_version = A.mergeVersion(kind, rec);
          if (found) {
            await rq(store.put({ ...rec, id: found.id, created_at: found.created_at, updated_at: new Date().toISOString() }));
            updated++;
          } else {
            await rq(store.add({ ...rec, created_at: new Date().toISOString() }));
            added++;
          }
        }
        // Converted affiliate days keep no fingerprints: order parts replace them.
        for (const date of clear) {
          (await rq(hs.index('acct_kind_date').getAllKeys([accountId, kind, date]))).forEach(key => hs.delete(key));
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
    async exportAccount(accountId, parameters) {
      return this.transaction(['accounts', ...KINDS, 'uploads', 'rowhashes'], 'readonly', async tx => {
        const [account, affiliate, ads, clicks, uploads, ...hashes] = await Promise.all([
          rq(tx.objectStore('accounts').get(accountId)),
          ...KINDS.map(kind => rq(tx.objectStore(kind).index('acct_date').getAll(bounds(accountId)))),
          rq(tx.objectStore('uploads').index('acct').getAll(accountId)),
          ...KINDS.map(kind => rq(tx.objectStore('rowhashes').index('acct_kind').getAll([accountId, kind]))),
        ]);
        if (!account) throw new Error('Akun tidak ditemukan');
        const metadata = { id: account.id, kind: account.kind, name: account.name };
        if (account.created !== undefined) metadata.created = account.created;
        return { format: BACKUP_FORMAT, version: BACKUP_VERSION, database_version: VERSION,
          exported_at: new Date().toISOString(), account: metadata, affiliate, ads, clicks, uploads,
          rowhashes: hashes.flat(), ...(parameters ? { parameters } : {}) };
      });
    }
    async importAccount(accountId, input, options = {}) {
      if (options.replace !== true) throw new Error('Konfirmasi penggantian riwayat akun diperlukan');
      const { data, summary } = validateBackup(input, { maxRecords: options.maxRecords });
      return this.transaction(['accounts', ...KINDS, 'uploads', 'rowhashes'], 'readwrite', async tx => {
        const account = await rq(tx.objectStore('accounts').get(accountId));
        if (!account || account.kind !== 'shopee') throw new Error('Akun tujuan tidak ditemukan');
        // Every delete and add shares one transaction. A constraint, quota, or
        // browser failure rolls back the original account history in full.
        for (const kind of KINDS) {
          const s = tx.objectStore(kind);
          (await rq(s.index('acct_date').getAllKeys(bounds(accountId)))).forEach(key => s.delete(key));
          const hs = tx.objectStore('rowhashes');
          (await rq(hs.index('acct_kind').getAllKeys([accountId, kind]))).forEach(key => hs.delete(key));
        }
        const uploads = tx.objectStore('uploads');
        (await rq(uploads.index('acct').getAllKeys(accountId))).forEach(key => uploads.delete(key));
        for (const kind of [...KINDS, 'uploads', 'rowhashes']) {
          const s = tx.objectStore(kind), rows = data[kind];
          for (let offset = 0; offset < rows.length; offset += 500) {
            await Promise.all(rows.slice(offset, offset + 500).map(row =>
              rq(s.add({ ...row, account_id: accountId }))));
          }
        }
        return { ...summary, target: account.name };
      });
    }
    // Shared-database cache: apply the rows changed after the cached revision.
    // Deleted days go first, exactly as deleteDay removes them; then changed
    // rows replace the cached row with the same key. One transaction.
    async applyChanges(accountId, input, deletions = []) {
      const { data } = validateBackup(input, { partial: true, maxRecords: Number.MAX_SAFE_INTEGER });
      for (const d of deletions) { kindOf(d && d.kind); if (!agg().isDate(d.date)) throw new Error('Tanggal tidak valid'); }
      return this.transaction(['accounts', ...KINDS, 'uploads', 'rowhashes'], 'readwrite', async tx => {
        if (!await rq(tx.objectStore('accounts').get(accountId))) throw new Error('Akun tidak ditemukan');
        const hs = tx.objectStore('rowhashes'), ups = tx.objectStore('uploads');
        for (const { kind, date } of deletions) {
          const s = tx.objectStore(kind);
          (await rq(s.index('acct_date').getAllKeys([accountId, date]))).forEach(key => s.delete(key));
          (await rq(hs.index('acct_kind').getAll([accountId, kind])))
            .filter(h => h.date === date || !h.date).forEach(h => hs.delete(h.id));
          (await rq(ups.index('acct').getAll(accountId))).filter(u => u.kind === kind && (!u.period_start || !u.period_end ||
            (u.period_start <= date && u.period_end >= date))).forEach(u => ups.delete(u.id));
        }
        for (const kind of KINDS) {
          const field = kind === 'ads' ? 'ad_key' : 'tag';
          const s = tx.objectStore(kind), idx = s.index(kind === 'ads' ? 'acct_date_key' : 'acct_date_tag');
          for (const row of data[kind]) {
            const found = await rq(idx.get([accountId, row.date, row[field]]));
            await rq(s.put({ ...row, account_id: accountId, ...(found ? { id: found.id } : {}) }));
          }
        }
        for (const row of data.rowhashes) {
          const found = await rq(hs.index('acct_kind_hash').get([accountId, row.kind, row.hash]));
          await rq(hs.put({ ...row, account_id: accountId, ...(found ? { id: found.id } : {}) }));
        }
        for (const row of data.uploads) {
          const found = await rq(ups.index('acct_kind_hash').get([accountId, row.kind, row.file_hash]));
          await rq(ups.put({ ...row, account_id: accountId, ...(found ? { id: found.id } : {}) }));
        }
        // A commission day converted to order parts loses its fingerprints on
        // the server too (daily_ingest), which no change row reports.
        const aff = tx.objectStore('affiliate');
        for (const date of new Set(data.affiliate.filter(r => r.merge_version === 2).map(r => r.date))) {
          if ((await rq(aff.index('acct_date').getAll([accountId, date]))).some(r => r.merge_version !== 2)) continue;
          (await rq(hs.index('acct_kind_date').getAllKeys([accountId, 'affiliate', date]))).forEach(key => hs.delete(key));
        }
      });
    }
    // Record counts per list, compared with the database after applyChanges.
    async counts(accountId) {
      return this.transaction([...KINDS, 'uploads', 'rowhashes'], 'readonly', async tx => {
        const result = {};
        for (const kind of KINDS) result[kind] = await rq(tx.objectStore(kind).index('acct_date').count(bounds(accountId)));
        result.uploads = await rq(tx.objectStore('uploads').index('acct').count(accountId));
        result.rowhashes = 0;
        for (const kind of KINDS) result.rowhashes += await rq(tx.objectStore('rowhashes').index('acct_kind').count([accountId, kind]));
        return result;
      });
    }
    async estimate() {
      if (typeof navigator === 'undefined' || !navigator.storage || !navigator.storage.estimate) return null;
      const e = await navigator.storage.estimate();
      return { usage: e.usage, quota: e.quota, pct: e.quota ? e.usage / e.quota * 100 : 0 };
    }
  }
  return { open: () => Store.open(), DB_NAME, validateBackup, serializeBackup, BACKUP_FORMAT, BACKUP_VERSION, MAX_BACKUP_BYTES };
})();
if (typeof window !== 'undefined') window.DailyStore = DailyStore;
if (typeof module !== 'undefined' && module.exports) module.exports = DailyStore;
