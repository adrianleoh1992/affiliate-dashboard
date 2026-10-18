/* ── Shared database (Supabase) ──────────────────────────────────────────────
   Optional. With no SUPABASE_CONFIG, or while signed out, the dashboard keeps
   working exactly as before on the browser's own IndexedDB.

   While signed in, the shared database is the source of truth and IndexedDB
   is its cache, so every tab keeps reading what it already reads:

     - the browser keeps the revision of the shared account its cache mirrors;
     - a save runs the same DailyAgg steps as the browser store against that
       cache (deduplicate, aggregate, check the days, keep what changes) and
       sends only those records plus fingerprints to daily_ingest, which
       merges like DailyAgg.mergeDaily and refuses the write if the revision
       moved;
     - after every write the cache fetches only the rows changed since its
       revision (daily_changes), checks its record counts against the
       database, and reloads the whole account when they differ.

   Raw CSV rows, buyer data and clear order IDs never leave the browser.
   Only the public anon/publishable key is used here; the database exposes
   nothing but the daily_* functions, which check team membership. */
'use strict';
const CloudStore = (() => {
  const KINDS = ['affiliate', 'ads', 'clicks'];
  const SESSION_KEY = 'adash_supabase_session_v1';
  const FRESH_MS = 3000;
  const agg = () => typeof DailyAgg !== 'undefined' ? DailyAgg : require('./daily-agg');
  const daily = () => typeof DailyStore !== 'undefined' ? DailyStore : require('./daily-store');

  class CloudError extends Error {
    constructor(message, status, code) { super(message); this.name = 'CloudError'; this.status = status; this.code = code; }
  }

  function readJSON(storage, key) {
    try { const raw = storage && storage.getItem(key); return raw ? JSON.parse(raw) : null; } catch (_) { return null; }
  }
  function writeJSON(storage, key, value) {
    try { value == null ? storage.removeItem(key) : storage.setItem(key, JSON.stringify(value)); return true; } catch (_) { return false; }
  }

  /* Supabase Auth (password sign-in) and PostgREST RPC over fetch. Accounts
     are created by the project owner; there is no sign-up path here.
     localStorage holds the session so every tab uses the same, latest tokens. */
  class Client {
    constructor({ url, anonKey, fetch: fetchImpl, storage, timeoutMs, onSession } = {}) {
      this.url = String(url || '').replace(/\/+$/, '');
      this.anonKey = String(anonKey || '');
      this.fetch = fetchImpl || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
      this.storage = storage || null;
      this.timeoutMs = timeoutMs || 60000;
      this.onSession = onSession || (() => {});
      this.memory = readJSON(this.storage, SESSION_KEY);
      this.refreshing = null;
    }
    get configured() { return /^https:\/\/[^/\s]+$/.test(this.url) && !!this.anonKey && !!this.fetch; }
    // Re-read on every use: another tab may have signed in, out, or rotated tokens.
    get current() { return this.storage && !this.storageFailed ? readJSON(this.storage, SESSION_KEY) : this.memory; }
    get user() { const session = this.current; return session ? session.user : null; }
    get signedIn() { const session = this.current; return !!(session && session.access_token); }

    async request(path, { method = 'POST', body, token, retry = true } = {}) {
      if (!this.configured) throw new CloudError('Database bersama belum dikonfigurasi', 0, 'config');
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : null;
      let response, text;
      try {
        response = await this.fetch(this.url + path, {
          method, signal: controller ? controller.signal : undefined,
          // Publishable keys (sb_publishable_…) are not JWTs: they go in apikey
          // only, and Authorization carries the signed-in user's token.
          headers: { apikey: this.anonKey, ...(token ? { Authorization: 'Bearer ' + token } : {}),
            'Content-Type': 'application/json', Accept: 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        text = await response.text();
      } catch (error) {
        throw new CloudError('Database bersama tidak dapat dihubungi. Periksa koneksi internet.', 0, 'network');
      } finally { if (timer) clearTimeout(timer); }
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch (_) { data = { message: text }; }
      if (response.status === 401 && retry && token) {
        return this.request(path, { method, body, token: await this.refresh(token), retry: false });
      }
      if (!response.ok) {
        const message = data && (data.msg || data.error_description || data.message || data.error) || ('HTTP ' + response.status);
        throw new CloudError(message, response.status, data && (data.code || data.error_code || data.error));
      }
      return data;
    }
    remember(data) {
      if (!data || !data.access_token) throw new CloudError('Respons masuk tidak valid', 0, 'auth');
      const prior = this.current;
      const session = { access_token: data.access_token, refresh_token: data.refresh_token,
        expires_at: data.expires_at || Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
        user: data.user ? { id: data.user.id, email: data.user.email } : (prior && prior.user) };
      this.memory = session;
      this.storageFailed = !writeJSON(this.storage, SESSION_KEY, session);
      if (!prior || !prior.user || !session.user || prior.user.id !== session.user.id) this.onSession(session);
    }
    forget() {
      const had = this.signedIn;
      this.memory = null; this.storageFailed = false;
      writeJSON(this.storage, SESSION_KEY, null);
      if (had) this.onSession(null);
    }
    async signIn(email, password) {
      try {
        this.remember(await this.request('/auth/v1/token?grant_type=password', { body: { email, password } }));
      } catch (error) {
        if (error.status === 400) throw new CloudError('Email atau kata sandi salah', 400, 'auth');
        throw error;
      }
      return this.user;
    }
    // One refresh at a time. If another tab already rotated the tokens, use
    // its session instead of replaying a refresh token Supabase has retired.
    // Only an answer that the refresh token itself is invalid signs out; a
    // network error, 429 or 5xx keeps the session for the next attempt.
    refresh(failedToken) {
      if (this.refreshing) return this.refreshing;
      this.refreshing = (async () => {
        const session = this.current;
        if (!session || !session.refresh_token) { this.forget(); throw new CloudError('Sesi berakhir. Masuk lagi.', 401, 'auth'); }
        if (failedToken && session.access_token !== failedToken && session.expires_at - 60 > Date.now() / 1000) return session.access_token;
        try {
          this.remember(await this.request('/auth/v1/token?grant_type=refresh_token', { body: { refresh_token: session.refresh_token }, retry: false }));
        } catch (error) {
          if (error.status === 400 || error.status === 401) {
            const latest = this.current;
            if (latest && latest.refresh_token !== session.refresh_token) return latest.access_token;
            this.forget();
            throw new CloudError('Sesi berakhir. Masuk lagi.', 401, 'auth');
          }
          throw error.code === 'network' ? error : new CloudError('Layanan login sedang bermasalah (' + error.message + '). Coba lagi sebentar.', error.status, 'network');
        }
        return this.current.access_token;
      })().finally(() => { this.refreshing = null; });
      return this.refreshing;
    }
    async signOut() {
      const session = this.current;
      this.forget();
      if (session && session.access_token) await this.request('/auth/v1/logout', { token: session.access_token, retry: false }).catch(() => {});
    }
    async token() {
      const session = this.current;
      if (!session || !session.access_token) throw new CloudError('Belum masuk ke database bersama', 401, 'auth');
      if (session.expires_at - 60 < Date.now() / 1000) return this.refresh(session.access_token);
      return session.access_token;
    }
    async rpc(name, args) {
      return this.request('/rest/v1/rpc/' + name, { body: args || {}, token: await this.token() });
    }
  }

  /* The cache mirrors one shared revision per account. A local write made
     while signed out marks it dirty, so it is never silently overwritten.
     Kept in memory too, so a full localStorage cannot lose the revision. */
  class SyncState {
    constructor(storage, url) { this.storage = storage; this.prefix = 'adash_cloud_v1|' + url + '|'; this.memory = new Map(); }
    get(name) { return readJSON(this.storage, this.prefix + name) || this.memory.get(name) || null; }
    set(name, value) { this.memory.set(name, value); writeJSON(this.storage, this.prefix + name, value); }
    dirty(name) { const value = this.get(name); if (value && !value.dirty) this.set(name, { ...value, dirty: true }); }
  }

  const PASSTHROUGH = ['close', 'transaction', 'listAccounts', 'renameAccount', 'deleteAccount', 'range',
    'forgetUpload', 'dailyIndex', 'coverage', 'uploadHistory', 'exportAccount', 'estimate', 'applyChanges', 'counts'];
  const META = ['revision', 'reset_revision', 'totals', 'deletions', 'reset'];
  const backupPart = snapshot => Object.fromEntries(Object.entries(snapshot).filter(([key]) => !META.includes(key)));

  // The shared database keeps only history whose days can be merged safely:
  // rows from before order identities and dated fingerprints were stored
  // (DAILY-STORE.md, "Migrasi") cannot be merged and must be re-uploaded.
  function legacyDates(data) {
    const dates = new Set();
    for (const kind of KINDS) for (const row of data[kind]) {
      if (row.merge_version === 2) continue;
      if (row.merge_version !== 1 || (kind === 'affiliate' && !Array.isArray(row.order_keys))) dates.add(row.date);
    }
    if (data.rowhashes.some(row => !row.date)) dates.add('tanpa tanggal');
    return [...dates].sort();
  }

  /* Same interface as DailyStore's Store, so daily-layer.js needs no second
     code path. States per account name:
       local     not configured or signed out: IndexedDB only
       checking  comparing the cache with the shared revision
       synced    cache equals the shared account; writes go to the database
       unlinked  the shared account does not exist or was never written; the
                 first save (or "Kirim riwayat lokal") uploads this history
       conflict  both sides hold history and this cache is not a revision of
                 the shared account; the user chooses which side to keep
       error     the database could not be reached or refused the cache;
                 shared writes are refused */
  class Shared {
    constructor(local, client, { storage, onChange } = {}) {
      this.local = local; this.client = client;
      this.state = new SyncState(storage, client.url);
      this.onChange = onChange || (() => {});
      this.statuses = new Map(); this.pending = new Map(); this.checked = new Map();
      for (const name of PASSTHROUGH) if (typeof local[name] === 'function') this[name] = local[name].bind(local);
    }
    get enabled() { return this.client.configured && this.client.signedIn; }
    status(name) {
      if (!this.client.configured) return { state: 'local', reason: 'config' };
      if (!this.client.signedIn) return { state: 'local', reason: 'signed-out' };
      return this.statuses.get(name) || { state: 'checking' };
    }
    setStatus(name, status) { this.statuses.set(name, status); this.onChange({ name, status, data: false }); }
    sessionChanged() { this.statuses.clear(); this.checked.clear(); this.onChange({ name: null, status: null, data: false }); }

    async localAccount(name) {
      const found = (await this.local.listAccounts('shopee')).find(account => account.name === name);
      return found || this.local.ensureAccount('shopee', name);
    }
    async localName(accountId) {
      const found = (await this.local.listAccounts('shopee')).find(account => account.id === accountId);
      if (!found) throw new Error('Akun tidak ditemukan');
      return found.name;
    }
    async localRows(accountId) {
      return Object.values(await this.local.coverage(accountId)).reduce((sum, value) => sum + value.rows, 0);
    }
    async remoteAccount(name) {
      return ((await this.client.rpc('daily_list_accounts')) || []).find(account => account.name === name) || null;
    }

    async ensureAccount(kind, name, meta) {
      const account = await this.local.ensureAccount(kind, name, meta);
      if (kind === 'shopee' && this.enabled) this.sync(account.name).catch(() => {});
      return account;
    }

    // Serialized per account: a save waits for the check the account switch began.
    sync(name) {
      const prior = this.pending.get(name) || Promise.resolve();
      const next = prior.catch(() => {}).then(() => this.check(name));
      this.pending.set(name, next);
      next.finally(() => { if (this.pending.get(name) === next) this.pending.delete(name); }).catch(() => {});
      return next;
    }
    async check(name) {
      if (!this.enabled) return this.status(name);
      if (!this.statuses.has(name)) this.statuses.set(name, { state: 'checking' });
      try {
        const local = await this.localAccount(name);
        const [remote, rows] = await Promise.all([this.remoteAccount(name), this.localRows(local.id)]);
        const cached = this.state.get(name);
        const trusted = !!(remote && cached && cached.remoteId === remote.id && !cached.dirty);
        if (!remote) {
          this.setStatus(name, { state: 'unlinked', remote: null, localRows: rows });
        } else if (trusted && cached.revision === remote.revision) {
          this.setStatus(name, { state: 'synced', remote, revision: remote.revision });
        } else if (trusted || !rows) {
          // A trusted cache follows every change, deletions included.
          await this.pull(name, remote.id);
        } else if (!remote.revision) {
          this.setStatus(name, { state: 'unlinked', remote, localRows: rows });
        } else {
          this.setStatus(name, { state: 'conflict', remote, localRows: rows });
        }
        this.checked.set(name, Date.now());
      } catch (error) {
        this.setStatus(name, { state: 'error', message: error.message });
      }
      return this.status(name);
    }
    // Plans read the cache; make sure it is current before they do.
    async fresh(accountId) {
      if (!this.enabled) return;
      const name = await this.localName(accountId);
      if (this.pending.has(name) || Date.now() - (this.checked.get(name) || 0) > FRESH_MS) await this.sync(name);
    }
    async seenFile(accountId, fileHash, kind) { await this.fresh(accountId); return this.local.seenFile(accountId, fileHash, kind); }
    async knownRowHashes(accountId, kind) { await this.fresh(accountId); return this.local.knownRowHashes(accountId, kind); }
    async existingKeys(accountId, kind) { await this.fresh(accountId); return this.local.existingKeys(accountId, kind); }

    // Bring this browser's copy to the shared account's latest revision:
    // changed rows when the cache is a known revision, otherwise everything.
    async pull(name, remoteId) {
      const local = await this.localAccount(name);
      const cached = this.state.get(name);
      let revision = null;
      if (cached && cached.remoteId === remoteId && !cached.dirty && Number.isSafeInteger(cached.revision)) {
        const changes = await this.client.rpc('daily_changes', { p_account_id: remoteId, p_since: cached.revision });
        if (!changes.reset) {
          if (changes.revision !== cached.revision) await this.local.applyChanges(local.id, backupPart(changes), changes.deletions);
          const counts = await this.local.counts(local.id);
          if (Object.keys(changes.totals).every(key => counts[key] === changes.totals[key])) revision = changes.revision;
        }
      }
      if (revision === null) {
        const snapshot = await this.client.rpc('daily_export_account', { p_account_id: remoteId });
        await this.local.importAccount(local.id, backupPart(snapshot), { replace: true, maxRecords: Number.MAX_SAFE_INTEGER });
        revision = snapshot.revision;
      }
      this.state.set(name, { remoteId, revision, dirty: false });
      this.statuses.set(name, { state: 'synced', remote: { id: remoteId, name, revision }, revision });
      this.checked.set(name, Date.now());
      this.onChange({ name, status: this.statuses.get(name), data: true });
    }
    // After a committed write, a failed refresh must not read as a failed write.
    async pullAfterWrite(name, remoteId) {
      try { await this.pull(name, remoteId); return true; } catch (error) {
        this.setStatus(name, { state: 'error', message: 'Tersimpan di database bersama, tetapi salinan di browser ini belum diperbarui: ' + error.message });
        return false;
      }
    }

    // Replace the shared account with this browser's copy. expectedRevision is
    // the revision the decision was made on (0 for an account never written);
    // the database refuses if anyone wrote since.
    async push(name, expectedRevision) {
      if (!Number.isSafeInteger(expectedRevision)) throw new Error('Periksa status database bersama terlebih dahulu');
      const local = await this.localAccount(name);
      const { data } = daily().validateBackup(await this.local.exportAccount(local.id), { maxRecords: Number.MAX_SAFE_INTEGER });
      const legacy = legacyDates(data);
      if (legacy.length) throw new Error('Riwayat lama di browser ini belum bisa dibagikan karena disimpan sebelum format penggabungan baru: '
        + legacy.slice(0, 8).join(', ') + (legacy.length > 8 ? ', …' : '') + '. Hapus tanggal tersebut di Data Tersimpan lalu unggah ulang CSV-nya.');
      const remote = await this.client.rpc('daily_ensure_account', { p_name: name });
      let result;
      try {
        result = await this.client.rpc('daily_replace_account', { p_account_id: remote.id, p_expected_revision: expectedRevision, p_backup: data });
      } catch (error) {
        if (error.code !== 'PT409') throw error;
        await this.sync(name);
        throw new Error('Database bersama berubah sejak diperiksa; tidak ada yang diganti. Periksa status terbaru lalu ulangi.');
      }
      this.state.set(name, { remoteId: remote.id, revision: result.revision, dirty: false });
      this.setStatus(name, { state: 'synced', remote: { ...remote, revision: result.revision }, revision: result.revision });
    }
    async usePulled(name) {
      const remote = await this.remoteAccount(name);
      if (!remote) throw new Error('Akun belum ada di database bersama');
      const cached = this.state.get(name);
      if (cached) this.state.set(name, { ...cached, dirty: true });
      await this.pull(name, remote.id);
    }

    // Writes that need the shared account; resolves its id and cached revision.
    async ready(name, { create = false } = {}) {
      await this.sync(name);
      const status = this.status(name);
      if (status.state === 'conflict') throw new Error('Riwayat di browser ini berbeda dengan database bersama. Buka Data Tersimpan → Database bersama dan pilih data yang dipakai. Belum ada yang disimpan.');
      if (status.state === 'error') throw new Error(status.message + ' Belum ada yang disimpan.');
      if (status.state === 'local') throw new Error('Sesi database bersama berakhir. Masuk lagi; belum ada yang disimpan.');
      if (status.state === 'unlinked') {
        if (!create) return null;
        await this.push(name, status.remote ? status.remote.revision : 0);
      }
      return this.state.get(name);
    }

    async saveDaily(accountId, kind, records, opts) {
      if (!this.enabled) {
        const result = await this.local.saveDaily(accountId, kind, records, opts);
        this.state.dirty(await this.localName(accountId));
        return result;
      }
      const o = opts || {}, A = agg();
      if (!KINDS.includes(kind)) throw new Error('Jenis laporan tidak dikenal');
      if (!Array.isArray(o.rawRows)) throw new Error('Penyimpanan bersama memerlukan baris sumber');
      const name = await this.localName(accountId);
      let result = null, link = null;
      for (let attempt = 0; attempt < 2 && !result; attempt++) {
        link = await this.ready(name, { create: true });
        // Exactly what DailyStore.saveDaily decides, against the cache at link.revision.
        const prep = A.prepare(kind, o.rawRows, await this.local.knownRowHashes(accountId, kind));
        const days = new Map();
        for (const date of new Set(prep.records.map(r => r.date))) days.set(date, await this.local.range(accountId, kind, date, date));
        A.checkDays(kind, prep.records, days);
        const diff = A.changes(kind, prep.records, new Map([...days.values()].flat().map(r => [A.recordKey(kind, r), r])));
        try {
          result = await this.client.rpc('daily_ingest', {
            p_account_id: link.remoteId, p_kind: kind, p_expected_revision: link.revision,
            p_records: diff.write, p_hashes: prep.hashes,
            p_upload: { file_hash: o.fileHash || A.hashRows(o.rawRows), file_name: o.fileName || '',
              rows: o.sourceRows || o.rawRows.length, duplicates: prep.duplicates + diff.duplicates,
              period_start: prep.period ? prep.period.start : null, period_end: prep.period ? prep.period.end : null },
          });
        } catch (error) {
          // Someone else saved first: refresh the cache and dedupe again once.
          if (error.code !== 'PT409' || attempt) throw error;
          await this.pull(name, link.remoteId);
        }
      }
      if (!result.skipped) await this.pullAfterWrite(name, link.remoteId);
      return { added: result.added, updated: result.updated, duplicates: result.duplicates, ...(result.skipped ? { skipped: true } : {}) };
    }

    async deleteDay(accountId, kind, date) {
      const name = await this.localName(accountId);
      if (!this.enabled) {
        const removed = await this.local.deleteDay(accountId, kind, date);
        this.state.dirty(name);
        return removed;
      }
      const link = await this.ready(name);
      if (!link) return this.local.deleteDay(accountId, kind, date);
      const result = await this.client.rpc('daily_delete_day', { p_account_id: link.remoteId, p_kind: kind, p_date: date });
      await this.pullAfterWrite(name, link.remoteId);
      return result.deleted;
    }

    // Restoring a backup while signed in replaces the shared account: that is
    // what "Ganti data harian akun ini" means once the history is shared.
    async importAccount(accountId, input, options = {}) {
      if (!this.enabled) {
        const summary = await this.local.importAccount(accountId, input, options);
        this.state.dirty(await this.localName(accountId));
        return summary;
      }
      if (options.replace !== true) throw new Error('Konfirmasi penggantian riwayat akun diperlukan');
      const name = await this.localName(accountId);
      const { data, summary } = daily().validateBackup(input);
      const legacy = legacyDates(data);
      if (legacy.length) throw new Error('Cadangan ini berisi riwayat format lama (' + legacy.slice(0, 8).join(', ')
        + ') yang tidak bisa dibagikan. Pulihkan saat belum masuk, hapus tanggal tersebut, lalu unggah ulang CSV-nya.');
      // The user confirmed replacing whatever the account holds right now.
      const remote = await this.client.rpc('daily_ensure_account', { p_name: name });
      let result;
      try {
        result = await this.client.rpc('daily_replace_account', { p_account_id: remote.id, p_expected_revision: remote.revision, p_backup: data });
      } catch (error) {
        if (error.code !== 'PT409') throw error;
        throw new Error('Anggota tim lain baru saja menyimpan ke akun ini; tidak ada yang diganti. Ulangi pemulihan.');
      }
      // The cache must reload whole: its rows are not a revision of the new history.
      this.state.set(name, { remoteId: remote.id, revision: null, dirty: false });
      await this.pullAfterWrite(name, remote.id);
      return { ...summary, target: name, revision: result.revision };
    }
  }

  function config() {
    const value = typeof window !== 'undefined' && window.SUPABASE_CONFIG;
    return value && typeof value === 'object' ? value : {};
  }
  function storage() { try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch (_) { return null; } }

  // daily-layer.js calls this with its opened Store. Without configuration the
  // original store is returned untouched.
  function attach(local, options = {}) {
    const cfg = options.config || config(), store = options.storage || storage();
    let shared = null;
    const client = options.client || new Client({ url: cfg.url, anonKey: cfg.anonKey, storage: store, fetch: options.fetch });
    if (!client.configured) return local;
    shared = new Shared(local, client, { storage: store, onChange: options.onChange });
    client.onSession = () => shared.sessionChanged();
    if (typeof window !== 'undefined') {
      window.__cloudStore = shared;
      // Another tab signed in or out: follow it. Rotated tokens need nothing,
      // the client reads the stored session on every request.
      const userOf = value => { try { const s = JSON.parse(value); return s && s.user ? s.user.id : null; } catch (_) { return null; } };
      window.addEventListener('storage', event => {
        if (event.key === SESSION_KEY && userOf(event.oldValue) !== userOf(event.newValue)) shared.sessionChanged();
      });
    }
    return shared;
  }

  return { attach, Client, Shared, CloudError, SESSION_KEY };
})();
if (typeof window !== 'undefined') window.CloudStore = CloudStore;
if (typeof module !== 'undefined' && module.exports) module.exports = CloudStore;
