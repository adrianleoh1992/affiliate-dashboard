/* ── Shared database (Supabase) ──────────────────────────────────────────────
   Optional. With no SUPABASE_CONFIG, or while signed out, the dashboard keeps
   working exactly as before on the browser's own IndexedDB.

   While signed in, the shared database is the source of truth and IndexedDB
   is its cache, so every tab keeps reading what it already reads:

     - the browser keeps the revision of the shared account its cache mirrors;
     - a save deduplicates against that cache, aggregates with DailyAgg (the
       one calculation path), and sends only aggregates plus fingerprints to
       daily_ingest, which refuses the write if the revision moved;
     - after every shared write the cache is replaced by a fresh snapshot,
       validated by DailyStore.validateBackup like any backup.

   Raw CSV rows, buyer data and clear order IDs never leave the browser.
   Only the public anon key is used here; access is enforced by RLS. */
'use strict';
const CloudStore = (() => {
  const KINDS = ['affiliate', 'ads', 'clicks'];
  const SESSION_KEY = 'adash_supabase_session_v1';
  const agg = () => typeof DailyAgg !== 'undefined' ? DailyAgg : require('./daily-agg');
  const daily = () => typeof DailyStore !== 'undefined' ? DailyStore : require('./daily-store');

  class CloudError extends Error {
    constructor(message, status, code) { super(message); this.name = 'CloudError'; this.status = status; this.code = code; }
  }

  function readJSON(storage, key) {
    try { const raw = storage && storage.getItem(key); return raw ? JSON.parse(raw) : null; } catch (_) { return null; }
  }
  function writeJSON(storage, key, value) {
    try { value == null ? storage.removeItem(key) : storage.setItem(key, JSON.stringify(value)); } catch (_) {}
  }

  /* Supabase Auth (password sign-in) and PostgREST RPC over fetch. Accounts
     are created by the project owner; there is no sign-up path here. */
  class Client {
    constructor({ url, anonKey, fetch: fetchImpl, storage, timeoutMs } = {}) {
      this.url = String(url || '').replace(/\/+$/, '');
      this.anonKey = String(anonKey || '');
      this.fetch = fetchImpl || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
      this.storage = storage || null;
      this.timeoutMs = timeoutMs || 60000;
      this.current = readJSON(this.storage, SESSION_KEY);
    }
    get configured() { return /^https:\/\/[^/\s]+$/.test(this.url) && !!this.anonKey && !!this.fetch; }
    get user() { return this.current ? this.current.user : null; }
    get signedIn() { return !!(this.current && this.current.access_token); }

    async request(path, { method = 'POST', body, token, retry = true } = {}) {
      if (!this.configured) throw new CloudError('Database bersama belum dikonfigurasi', 0, 'config');
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : null;
      let response;
      try {
        response = await this.fetch(this.url + path, {
          method, signal: controller ? controller.signal : undefined,
          // Publishable keys (sb_publishable_…) are not JWTs: they go in apikey
          // only, and Authorization carries the signed-in user's token.
          headers: { apikey: this.anonKey, ...(token ? { Authorization: 'Bearer ' + token } : {}),
            'Content-Type': 'application/json', Accept: 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (error) {
        throw new CloudError('Database bersama tidak dapat dihubungi. Periksa koneksi internet.', 0, 'network');
      } finally { if (timer) clearTimeout(timer); }
      const text = await response.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch (_) { data = { message: text }; }
      if (response.status === 401 && retry && token && this.current && this.current.refresh_token) {
        await this.refresh();
        return this.request(path, { method, body, token: this.current.access_token, retry: false });
      }
      if (!response.ok) {
        const message = data && (data.msg || data.error_description || data.message || data.error) || ('HTTP ' + response.status);
        throw new CloudError(message, response.status, data && (data.code || data.error_code || data.error));
      }
      return data;
    }
    remember(data) {
      if (!data || !data.access_token) throw new CloudError('Respons masuk tidak valid', 0, 'auth');
      this.current = { access_token: data.access_token, refresh_token: data.refresh_token,
        expires_at: data.expires_at || Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
        user: data.user ? { id: data.user.id, email: data.user.email } : (this.current && this.current.user) };
      writeJSON(this.storage, SESSION_KEY, this.current);
    }
    forget() { this.current = null; writeJSON(this.storage, SESSION_KEY, null); }
    async signIn(email, password) {
      try {
        this.remember(await this.request('/auth/v1/token?grant_type=password', { body: { email, password } }));
      } catch (error) {
        if (error.status === 400) throw new CloudError('Email atau kata sandi salah', 400, 'auth');
        throw error;
      }
      return this.user;
    }
    async refresh() {
      const token = this.current && this.current.refresh_token;
      try {
        this.remember(await this.request('/auth/v1/token?grant_type=refresh_token', { body: { refresh_token: token }, retry: false }));
      } catch (error) {
        if (error.code !== 'network') this.forget();
        throw error.code === 'network' ? error : new CloudError('Sesi berakhir. Masuk lagi.', 401, 'auth');
      }
    }
    async signOut() {
      const token = this.current && this.current.access_token;
      this.forget();
      if (token) await this.request('/auth/v1/logout', { token, retry: false }).catch(() => {});
    }
    async token() {
      if (!this.signedIn) throw new CloudError('Belum masuk ke database bersama', 401, 'auth');
      if (this.current.expires_at - 60 < Date.now() / 1000) await this.refresh();
      return this.current.access_token;
    }
    async rpc(name, args) {
      return this.request('/rest/v1/rpc/' + name, { body: args || {}, token: await this.token() });
    }
  }

  /* The cache mirrors one shared revision per account. A local write made
     while signed out marks it dirty, so it is never silently overwritten. */
  class SyncState {
    constructor(storage, url) { this.storage = storage; this.prefix = 'adash_cloud_v1|' + url + '|'; }
    get(name) { return readJSON(this.storage, this.prefix + name); }
    set(name, value) { writeJSON(this.storage, this.prefix + name, value); }
    dirty(name) { const value = this.get(name); if (value && !value.dirty) this.set(name, { ...value, dirty: true }); }
  }

  const PASSTHROUGH = ['close', 'transaction', 'listAccounts', 'renameAccount', 'deleteAccount', 'seenFile',
    'knownRowHashes', 'existingKeys', 'range', 'forgetUpload', 'dailyIndex', 'coverage', 'uploadHistory',
    'exportAccount', 'estimate'];

  /* Same interface as DailyStore's Store, so daily-layer.js needs no second
     code path. States per account name:
       local     not configured or signed out: IndexedDB only
       checking  comparing the cache with the shared revision
       synced    cache equals the shared account; writes go to the database
       unlinked  the shared account is missing or empty; the first save (or
                 "Kirim riwayat lokal") uploads this browser's history
       conflict  both sides have data and the cache is not a known revision;
                 the user chooses which side to keep
       error     the database could not be reached; shared writes refused */
  class Shared {
    constructor(local, client, { storage, onChange } = {}) {
      this.local = local; this.client = client;
      this.state = new SyncState(storage, client.url);
      this.onChange = onChange || (() => {});
      this.statuses = new Map(); this.pending = new Map();
      for (const name of PASSTHROUGH) if (typeof local[name] === 'function') this[name] = local[name].bind(local);
    }
    get enabled() { return this.client.configured && this.client.signedIn; }
    status(name) {
      if (!this.client.configured) return { state: 'local', reason: 'config' };
      if (!this.client.signedIn) return { state: 'local', reason: 'signed-out' };
      return this.statuses.get(name) || { state: 'checking' };
    }
    setStatus(name, status) { this.statuses.set(name, status); this.onChange({ name, status, data: false }); }

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
        if (!remote || !remote.aggregates) {
          // An empty shared account still pulls when this cache is empty, so
          // its revision (and any upload log) is mirrored before the first save.
          if (remote && !rows) { await this.pull(name, remote.id); return this.status(name); }
          this.setStatus(name, { state: 'unlinked', remote, localRows: rows });
          return this.status(name);
        }
        const trusted = cached && cached.remoteId === remote.id && !cached.dirty;
        if (trusted && cached.revision === remote.revision) {
          this.setStatus(name, { state: 'synced', remote, revision: remote.revision });
        } else if (trusted || !rows) {
          await this.pull(name, remote.id);
        } else {
          this.setStatus(name, { state: 'conflict', remote, localRows: rows });
        }
      } catch (error) {
        this.setStatus(name, { state: 'error', message: error.message });
      }
      return this.status(name);
    }

    // Replace this browser's copy with the shared account.
    async pull(name, remoteId) {
      const snapshot = await this.client.rpc('daily_export_account', { p_account_id: remoteId });
      const revision = snapshot.revision;
      delete snapshot.revision;
      const local = await this.localAccount(name);
      await this.local.importAccount(local.id, snapshot, { replace: true });
      this.state.set(name, { remoteId, revision, dirty: false });
      this.statuses.set(name, { state: 'synced', remote: { id: remoteId, name, revision }, revision });
      this.onChange({ name, status: this.statuses.get(name), data: true });
    }
    // Replace the shared account with this browser's copy.
    async push(name) {
      const local = await this.localAccount(name);
      const { data } = daily().validateBackup(await this.local.exportAccount(local.id));
      const remote = await this.client.rpc('daily_ensure_account', { p_name: name });
      const current = await this.remoteAccount(name);
      const result = await this.client.rpc('daily_replace_account', { p_account_id: remote.id,
        p_expected_revision: current ? current.revision : remote.revision, p_backup: data });
      this.state.set(name, { remoteId: remote.id, revision: result.revision, dirty: false });
      this.setStatus(name, { state: 'synced', remote: { ...remote, revision: result.revision }, revision: result.revision });
    }
    async usePulled(name) {
      const remote = await this.remoteAccount(name);
      if (!remote) throw new Error('Akun belum ada di database bersama');
      await this.pull(name, remote.id);
    }

    // Writes that need the shared account; resolves its id and cached revision.
    async ready(name, { create = false } = {}) {
      await this.sync(name);
      const status = this.status(name);
      if (status.state === 'conflict') throw new Error('Riwayat di browser ini berbeda dengan database bersama. Buka Data Tersimpan → Database bersama dan pilih data yang dipakai. Belum ada yang disimpan.');
      if (status.state === 'error') throw new Error(status.message + ' Belum ada yang disimpan.');
      if (status.state === 'unlinked') {
        if (!create) return null;
        await this.push(name);
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
      let result = null;
      for (let attempt = 0; attempt < 2 && !result; attempt++) {
        const link = await this.ready(name, { create: true });
        const known = await this.local.knownRowHashes(accountId, kind);
        const valid = o.rawRows.filter(row => A.isDate(A.rowDate(row, kind)));
        const dates = valid.map(row => A.rowDate(row, kind)).sort();
        const dedup = A.dedupe(valid, known);
        const aggregates = A.aggregate(kind, dedup.kept);
        try {
          result = await this.client.rpc('daily_ingest', {
            p_account_id: link.remoteId, p_kind: kind, p_expected_revision: link.revision,
            p_records: aggregates,
            p_hashes: dedup.kept.map((row, index) => ({ hash: dedup.hashes[index], date: A.rowDate(row, kind) })),
            p_upload: { file_hash: o.fileHash || A.hashRows(o.rawRows), file_name: o.fileName || '',
              rows: o.sourceRows || o.rawRows.length, duplicates: dedup.duplicates,
              period_start: dates[0] || null, period_end: dates[dates.length - 1] || null },
          });
        } catch (error) {
          // Someone else saved first: refresh the cache and dedupe again once.
          if (error.code !== 'PT409' || attempt) throw error;
          await this.pull(name, link.remoteId);
        }
      }
      if (!result.skipped) await this.pull(name, this.state.get(name).remoteId);
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
      await this.pull(name, link.remoteId);
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
      const remote = await this.client.rpc('daily_ensure_account', { p_name: name });
      const current = await this.remoteAccount(name);
      await this.client.rpc('daily_replace_account', { p_account_id: remote.id,
        p_expected_revision: current ? current.revision : remote.revision, p_backup: data });
      await this.pull(name, remote.id);
      return { ...summary, target: name };
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
    const cfg = options.config || config();
    const client = options.client || new Client({ url: cfg.url, anonKey: cfg.anonKey, storage: options.storage || storage(), fetch: options.fetch });
    if (!client.configured) return local;
    const shared = new Shared(local, client, { storage: options.storage || storage(), onChange: options.onChange });
    if (typeof window !== 'undefined') window.__cloudStore = shared;
    return shared;
  }

  return { attach, Client, Shared, CloudError };
})();
if (typeof window !== 'undefined') window.CloudStore = CloudStore;
if (typeof module !== 'undefined' && module.exports) module.exports = CloudStore;
