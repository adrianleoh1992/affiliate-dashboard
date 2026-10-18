/* Meta Marketing API → Meta Ads daily report.
   The browser calls graph.facebook.com directly with the user's own token; there
   is no backend, so the token never leaves this device except to Meta itself.
   The result is rendered as CSV text with the exact Ads Manager export headers
   and handed to the same import pipeline as an uploaded file, so validation,
   deduplication, matching and daily storage stay one code path. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('papaparse'));
  else root.MetaApi = factory(root.Papa);
})(typeof self !== 'undefined' ? self : this, function (Papa) {
  'use strict';

  const VERSION = 'v24.0';
  const BASE = 'https://graph.facebook.com/';
  // Short windows keep each synchronous Insights call well under Meta's
  // "reduce the amount of data" limit on large accounts.
  const CHUNK_DAYS = 14;
  const MAX_DAYS = 400;
  const PAGE_LIMIT = 500;
  const MAX_PAGES = 400;
  const INSIGHT_FIELDS = ['ad_id', 'ad_name', 'adset_name', 'campaign_name', 'account_currency', 'spend', 'impressions',
    'reach', 'frequency', 'inline_link_clicks', 'clicks', 'inline_link_click_ctr', 'cpm', 'actions',
    'quality_ranking', 'engagement_rate_ranking', 'conversion_rate_ranking'];
  const RANKING = {
    ABOVE_AVERAGE: 'Above average', AVERAGE: 'Average',
    BELOW_AVERAGE_35: 'Below average - Bottom 35% of ads', BELOW_AVERAGE_20: 'Below average - Bottom 20% of ads',
    BELOW_AVERAGE_10: 'Below average - Bottom 10% of ads',
  };

  class MetaApiError extends Error {
    constructor(message, info) { super(message); this.name = 'MetaApiError'; Object.assign(this, info || {}); }
  }

  const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
  const shift = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
  const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5) + 1;

  function normalizeAccountId(id) {
    const digits = String(id == null ? '' : id).trim().replace(/^act_/i, '');
    if (!/^\d{3,20}$/.test(digits)) throw new MetaApiError('ID akun iklan tidak valid. Gunakan angka ID akun iklan (contoh: act_1234567890).', { kind: 'input' });
    return 'act_' + digits;
  }

  function splitRange(since, until, size) {
    if (!isDate(since) || !isDate(until)) throw new MetaApiError('Tanggal harus berformat YYYY-MM-DD.', { kind: 'input' });
    if (since > until) throw new MetaApiError('Tanggal mulai harus sebelum tanggal akhir.', { kind: 'input' });
    if (daysBetween(since, until) > MAX_DAYS) throw new MetaApiError(`Rentang maksimal ${MAX_DAYS} hari per tarikan. Pecah menjadi beberapa periode.`, { kind: 'input' });
    const out = [];
    for (let start = since; start <= until; start = shift(start, size || CHUNK_DAYS)) {
      const end = shift(start, (size || CHUNK_DAYS) - 1);
      out.push({ since: start, until: end < until ? end : until });
    }
    return out;
  }

  /* Graph API error codes → what the user can actually do about it. */
  function describeError(body, status) {
    const e = (body && body.error) || {};
    const code = Number(e.code), sub = Number(e.error_subcode);
    const info = { code, subcode: sub, status, metaMessage: e.message || '', traceId: e.fbtrace_id || '' };
    if (code === 190 || code === 102 || code === 2500) {
      info.kind = 'token';
      return new MetaApiError(sub === 463 || sub === 467
        ? 'Token Meta sudah kedaluwarsa. Buat token baru (disarankan token System User yang tidak kedaluwarsa), lalu tempel ulang.'
        : 'Token Meta tidak valid atau sudah dicabut. Buat token baru dengan izin ads_read, lalu tempel ulang.', info);
    }
    if (code === 10 || code === 200 || code === 272 || (code >= 200 && code < 300)) {
      info.kind = 'permission';
      return new MetaApiError('Token tidak punya akses ke akun iklan ini. Pastikan token memiliki izin ads_read dan pengguna/System User ditugaskan ke akun iklan tersebut.', info);
    }
    if ([4, 17, 32, 341, 613].includes(code) || (code >= 80000 && code <= 80014)) {
      info.kind = 'rate';
      return new MetaApiError('Batas permintaan Meta API tercapai. Tunggu beberapa menit lalu tarik lagi, atau persempit rentang tanggal.', info);
    }
    if (code === 1 || code === 2) {
      info.kind = 'transient';
      return new MetaApiError('Meta sedang tidak dapat memproses permintaan (sering terjadi pada data besar). Coba lagi atau persempit rentang tanggal.', info);
    }
    info.kind = 'api';
    return new MetaApiError('Meta menolak permintaan' + (e.message ? ': ' + e.message : ` (HTTP ${status}).`), info);
  }

  function create(options) {
    options = options || {};
    const fetchImpl = options.fetch || (typeof fetch === 'function' ? fetch.bind(typeof self !== 'undefined' ? self : globalThis) : null);
    const version = options.version || VERSION;
    if (!fetchImpl) throw new Error('fetch tidak tersedia');

    async function get(url, token, signal) {
      let response, body;
      try {
        // access_token as a query parameter keeps this a simple CORS GET with no
        // preflight, the way Meta's own JS SDK calls the Graph API. It is added
        // only here, so errors and paging state never carry it.
        const target = new URL(url);
        target.searchParams.set('access_token', token);
        response = await fetchImpl(target.toString(), { method: 'GET', signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
      } catch (err) {
        if (err && err.name === 'AbortError') throw err;
        throw new MetaApiError('Tidak dapat menghubungi Meta. Periksa koneksi internet, lalu coba lagi.', { kind: 'network' });
      }
      try { body = await response.json(); } catch (err) { body = null; }
      if (!response.ok || !body || body.error) throw describeError(body, response.status);
      return body;
    }
    function url(path, params) {
      const u = new URL(BASE + version + '/' + path);
      Object.entries(params || {}).forEach(([k, v]) => u.searchParams.set(k, typeof v === 'string' ? v : JSON.stringify(v)));
      return u.toString();
    }
    // Paging links must stay on graph.facebook.com: the token is sent with
    // each follow-up request.
    function safeNext(next) {
      if (!next) return null;
      const u = new URL(next);
      if (u.protocol !== 'https:' || u.hostname !== 'graph.facebook.com') throw new MetaApiError('Link halaman berikutnya dari Meta tidak dikenali.', { kind: 'api' });
      u.searchParams.delete('access_token');
      return u.toString();
    }
    async function all(first, token, signal) {
      const out = [];
      let next = first, pages = 0;
      while (next) {
        if (++pages > MAX_PAGES) throw new MetaApiError('Data terlalu banyak untuk satu tarikan. Persempit rentang tanggal.', { kind: 'input' });
        const body = await get(next, token, signal);
        out.push(...(Array.isArray(body.data) ? body.data : []));
        next = safeNext(body.paging && body.paging.next);
      }
      return out;
    }
    function requireToken(token) {
      const t = String(token == null ? '' : token).trim();
      if (!t) throw new MetaApiError('Tempel token akses Meta terlebih dahulu.', { kind: 'input' });
      if (/\s/.test(t)) throw new MetaApiError('Token mengandung spasi. Salin ulang token tanpa spasi atau baris baru.', { kind: 'input' });
      return t;
    }

    async function listAdAccounts(token, signal) {
      token = requireToken(token);
      const rows = await all(url('me/adaccounts', { fields: 'name,account_id,currency,timezone_name,account_status', limit: '200' }), token, signal);
      return rows.map(a => ({
        id: 'act_' + String(a.account_id || String(a.id || '').replace(/^act_/, '')),
        name: String(a.name || a.account_id || a.id || ''), currency: String(a.currency || ''),
        timezone: String(a.timezone_name || ''), status: Number(a.account_status),
      })).filter(a => /^act_\d+$/.test(a.id)).sort((a, b) => a.name.localeCompare(b.name));
    }

    async function fetchDelivery(adIds, token, signal) {
      const out = new Map(), ids = [...new Set(adIds.filter(id => /^\d+$/.test(id)))];
      for (let i = 0; i < ids.length; i += 50) {
        const body = await get(url('', { ids: ids.slice(i, i + 50).join(','), fields: 'effective_status' }), token, signal);
        Object.entries(body || {}).forEach(([id, ad]) => { if (ad && ad.effective_status) out.set(id, String(ad.effective_status).toLowerCase()); });
      }
      return out;
    }

    /* Ad-level insights, one row per ad per day, in the ad account's timezone
       — the same grain as an Ads Manager export with breakdown Time → Day. */
    async function fetchDailyInsights(token, accountId, since, until, opts) {
      opts = opts || {};
      token = requireToken(token);
      const account = normalizeAccountId(accountId);
      const chunks = splitRange(since, until, opts.chunkDays);
      const rows = [];
      for (let i = 0; i < chunks.length; i++) {
        if (opts.onProgress) opts.onProgress({ step: i, total: chunks.length, range: chunks[i] });
        const part = await all(url(account + '/insights', {
          level: 'ad', time_increment: '1', fields: INSIGHT_FIELDS.join(','),
          time_range: { since: chunks[i].since, until: chunks[i].until }, limit: String(PAGE_LIMIT),
        }), token, opts.signal);
        rows.push(...part);
      }
      if (opts.onProgress) opts.onProgress({ step: chunks.length, total: chunks.length });
      let delivery = new Map();
      if (opts.delivery !== false && rows.length) {
        // Delivery status is a nice-to-have (it drives the "active" label);
        // failing to read it must not discard the spend that was fetched.
        try { delivery = await fetchDelivery(rows.map(r => String(r.ad_id || '')), token, opts.signal); }
        catch (err) { if (err && err.name === 'AbortError') throw err; }
      }
      return { account, since, until, rows, delivery };
    }

    return { version, listAdAccounts, fetchDailyInsights };
  }

  const action = (row, type) => {
    const hit = (Array.isArray(row.actions) ? row.actions : []).find(a => a && a.action_type === type);
    return hit ? hit.value : '';
  };
  const ranking = v => RANKING[String(v || '').toUpperCase()] || (v ? '-' : '');

  /* Insights rows → CSV text with Ads Manager export headers. Non-IDR accounts
     keep their currency column so the import pipeline refuses them visibly
     instead of mixing currencies. */
  function toCsv(result, currencyHint) {
    const rows = (result && result.rows) || [];
    const currency = String((rows[0] && rows[0].account_currency) || currencyHint || '').toUpperCase();
    const spendHeader = currency === 'IDR' ? 'Amount spent (IDR)' : 'Amount spent';
    const delivery = (result && result.delivery) || new Map();
    const data = rows.map(r => ({
      'Reporting starts': r.date_start, 'Reporting ends': r.date_stop,
      'Ad ID': r.ad_id || '', 'Ad name': r.ad_name || '', 'Ad set name': r.adset_name || '', 'Campaign name': r.campaign_name || '',
      'Account currency': r.account_currency || currency,
      [spendHeader]: r.spend == null || r.spend === '' ? '0' : r.spend,
      'Impressions': r.impressions || '0', 'Reach': r.reach || '', 'Frequency': r.frequency || '',
      'Link clicks': r.inline_link_clicks || '0', 'Clicks (all)': r.clicks || '0',
      'CTR (link click-through rate)': r.inline_link_click_ctr || '',
      'CPM (cost per 1,000 impressions) (IDR)': currency === 'IDR' ? (r.cpm || '') : '',
      'Landing page views': action(r, 'landing_page_view'),
      'Ad delivery': delivery.get(String(r.ad_id || '')) || '',
      'Quality ranking': ranking(r.quality_ranking), 'Engagement rate ranking': ranking(r.engagement_rate_ranking),
      'Conversion rate ranking': ranking(r.conversion_rate_ranking),
    }));
    const fields = ['Reporting starts', 'Reporting ends', 'Ad ID', 'Ad name', 'Ad set name', 'Campaign name', 'Account currency', spendHeader,
      'Impressions', 'Reach', 'Frequency', 'Link clicks', 'Clicks (all)', 'CTR (link click-through rate)',
      'CPM (cost per 1,000 impressions) (IDR)', 'Landing page views', 'Ad delivery', 'Quality ranking', 'Engagement rate ranking', 'Conversion rate ranking'];
    return Papa.unparse({ fields, data }, { escapeFormulae: true, newline: '\r\n' });
  }

  function fileName(result) {
    return `meta-api_${result.account}_${result.since}_${result.until}.csv`;
  }

  return { VERSION, CHUNK_DAYS, MAX_DAYS, MetaApiError, create, splitRange, normalizeAccountId, describeError, toCsv, fileName, shift, isDate };
});
