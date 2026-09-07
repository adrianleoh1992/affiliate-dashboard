/* Validated CSV/TSV ingestion. Pure module: no DOM, storage, or network access. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine'), require('papaparse'));
  else root.DashboardImport = factory(root.Engine, root.Papa);
})(typeof self !== 'undefined' ? self : this, function (E, defaultPapa) {
  'use strict';

  const MAX_ISSUES = 200;
  // Compatibility evidence stays in memory and is never serialized with a
  // normalized row. DailyAgg uses it only to recognize exact pre-validation
  // CSV fingerprints already stored by the prior reader.
  const SOURCE_ROW = Symbol.for('affiliate-dashboard.source-row');
  const TYPES = { affiliate: 'aff', ads: 'ads', clicks: 'clk' };
  const EMPTY_MARKERS = /^(?:-{1,2}|—|–|n\/?a|null)$/i;
  const STATUSES = new Map(['Selesai', 'Tertunda', 'Dibatalkan', 'Belum Dibayar'].map(x => [x.toLowerCase(), x]));
  const headerKey = value => String(value).normalize('NFKC').toLowerCase().replace(/[^a-z0-9]/g, '');
  const cleanHeader = value => String(value).replace(/^\uFEFF/, '').trim().replace(/\s+/g, ' ');
  const aliases = new Map();
  Object.values(E.COL).forEach(group => Object.values(group).forEach(names => names.forEach(name => aliases.set(headerKey(name), name))));
  ['Reporting ends', 'Currency', 'Account currency', 'Klik ID'].forEach(name => aliases.set(headerKey(name), name));

  function strictNumber(input, options) {
    options = options || {};
    const raw = String(input == null ? '' : input).trim();
    if (!raw || EMPTY_MARKERS.test(raw)) return { empty: true, valid: false };
    let text = raw.replace(/\u00a0|\u202f/g, ' '), negative = false;
    if (/^\(.*\)$/.test(text)) { negative = true; text = text.slice(1, -1).trim(); }
    const currency = /^(?:rp\.?|idr)\s*/i.test(text);
    text = text.replace(/^(?:rp\.?|idr)\s*/i, '');
    if (options.percent) text = text.replace(/%$/, '').trim();
    // Only correctly grouped spaces are accepted. Never strip arbitrary text:
    // strings such as "12O00", "Rp 1oops" or formula cells must fail validation.
    if (/^[+\-]?\d{1,3}( \d{3})+(?:[.,]\d+)?$/.test(text)) text = text.replace(/ /g, '');
    let normalized = text, ambiguous = false;
    const comma = text.lastIndexOf(','), dot = text.lastIndexOf('.');
    if (comma >= 0 && dot >= 0) {
      if (comma > dot && /^[+\-]?\d{1,3}(\.\d{3})*,\d+$/.test(text)) normalized = text.replace(/\./g, '').replace(',', '.');
      else if (dot > comma && /^[+\-]?\d{1,3}(,\d{3})*\.\d+$/.test(text)) normalized = text.replace(/,/g, '');
      else return { valid: false };
    } else if (comma >= 0) {
      if (/^[+\-]?\d{1,3}(,\d{3})+$/.test(text)) {
        // A single separator followed by three digits is ambiguous. Surface
        // the interpretation; semicolon exports conventionally use decimals.
        const single = text.indexOf(',') === comma;
        ambiguous = single;
        normalized = single && options.delimiter === ';' ? text.replace(',', '.') : text.replace(/,/g, '');
      } else if (/^[+\-]?(?:\d+,\d+|,\d+)$/.test(text)) normalized = text.replace(',', '.');
      else return { valid: false };
    } else if (dot >= 0 && (currency || text.indexOf('.') !== dot)) {
      if (/^[+\-]?\d{1,3}(\.\d{3})+$/.test(text)) {
        ambiguous = text.indexOf('.') === dot;
        normalized = text.replace(/\./g, '');
      }
    }
    if (!/^[+\-]?(?:\d+\.?\d*|\.\d+)(?:e[+\-]?\d+)?$/i.test(normalized)) return { valid: false };
    let value = Number(normalized);
    if (negative) value = -Math.abs(value);
    return { valid: Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER, value, ambiguous };
  }

  function validTimestamp(value) {
    const text = String(value == null ? '' : value).trim();
    const match = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+\-](\d{2}):(\d{2}))?)?$/.exec(text);
    return !!(match && E.isDate(match[1]) && (match[2] == null || (Number(match[2]) < 24 && Number(match[3]) < 60 && Number(match[4] || 0) < 60 && Number(match[5] || 0) <= 14 && Number(match[6] || 0) < 60)));
  }

  function parseText(input, options) {
    options = options || {};
    const result = { ok: false, fatal: false, type: 'unknown', rows: [], fields: [], issues: [], stats: { total: 0, accepted: 0, rejected: 0 }, period: null, delimiter: '', fileName: options.fileName || '' };
    let issueCount = 0, errors = 0, warnings = 0;
    const errorIssues = [], warningGroups = new Map();
    const issue = (severity, code, message, evidence) => {
      issueCount++;
      const entry = Object.assign({ severity, code, message }, evidence || {});
      if (severity === 'error') {
        errors++;
        if (errorIssues.length < MAX_ISSUES) errorIssues.push(entry);
      } else {
        warnings++;
        const key = JSON.stringify([code, entry.column || '']);
        if (!warningGroups.has(key)) warningGroups.set(key, { ...entry, count: 0, examples: [] });
        const group = warningGroups.get(key);
        group.count++;
        if (group.examples.length < 3) group.examples.push(entry);
      }
    };
    function finish(fatal) {
      if (fatal) { result.fatal = true; result.rows = []; result.period = null; }
      result.stats.accepted = result.rows.length;
      result.stats.rejected = result.stats.total - result.stats.accepted;
      result.stats.errors = errors; result.stats.warnings = warnings;
      result.ok = !result.fatal && result.stats.accepted > 0;
      const grouped = [...warningGroups.values()].map(group => {
        if (group.count === 1) return group;
        // Counts retain every occurrence; examples keep the summary useful
        // without thousands of routine missing-value notices hiding errors.
        const { row, value, ...summary } = group;
        summary.message = `${group.count} catatan${group.column ? ' pada ' + group.column : ''}. Contoh: `
          + group.examples.map(example => example.message).join(' ');
        return summary;
      });
      result.issues = [...errorIssues, ...grouped].slice(0, MAX_ISSUES);
      const represented = result.issues.reduce((sum, entry) => sum + (entry.count || 1), 0);
      if (issueCount > represented) result.issues.push({ severity: 'warning', code: 'issues_truncated', message: `${issueCount - represented} temuan tambahan tidak ditampilkan. Perbaiki sumber lalu impor ulang. Jumlah baris ditolak tetap lengkap.` });
      return result;
    }
    const Papa = options.Papa || defaultPapa;
    if (!Papa || typeof Papa.parse !== 'function') {
      issue('error', 'parser_unavailable', 'Pembaca CSV belum tersedia. Muat ulang halaman lalu coba kembali.');
      return finish(true);
    }
    if (typeof input !== 'string' || !input.trim()) {
      issue('error', 'empty_file', 'File kosong. Ekspor laporan yang berisi header dan data.');
      return finish(true);
    }
    if (input.includes('\0') || input.includes('\uFFFD')) {
      issue('error', 'invalid_encoding', 'Teks file tidak terbaca utuh. Ekspor ulang sebagai CSV UTF-8, bukan file Excel yang hanya diganti ekstensi.');
      return finish(true);
    }
    let text = input.replace(/^\uFEFF/, '').replace(/^(?:[ \t]*\r?\n)+/, '');
    let forcedDelimiter = '';
    const directive = /^sep=([,;\t])\s*\r?\n/i.exec(text);
    if (directive) { forcedDelimiter = directive[1]; text = text.slice(directive[0].length); }
    let parsed;
    try {
      parsed = Papa.parse(text, { header: false, skipEmptyLines: 'greedy', delimiter: forcedDelimiter, delimitersToGuess: [',', ';', '\t'] });
    } catch (error) {
      issue('error', 'parse_failed', 'File gagal dibaca: ' + String(error.message || error));
      return finish(true);
    }
    result.delimiter = parsed.meta && parsed.meta.delimiter || forcedDelimiter;
    const records = parsed.data || [];
    result.stats.total = Math.max(0, records.length - 1);
    for (const error of parsed.errors || []) {
      issue('error', 'csv_structure', 'Struktur CSV rusak: ' + error.message + '. Ekspor ulang agar pemisah dan tanda kutip konsisten.', Number.isInteger(error.row) ? { row: error.row + 1 } : {});
    }
    if ((parsed.errors || []).length) return finish(true);
    if (!records.length) { issue('error', 'empty_file', 'Tidak ada header atau data dalam file.'); return finish(true); }
    const headerCells = records.shift();
    const sourceFields = headerCells.map(value => String(value).replace(/^\uFEFF/, '').trim());
    const rawFields = headerCells.map(cleanHeader);
    result.fields = rawFields.map(field => aliases.get(headerKey(field)) || field);
    const seen = new Set();
    result.fields.forEach((field, i) => {
      const key = headerKey(field);
      if (!key) issue('error', 'empty_header', `Kolom ${i + 1} tidak memiliki nama. Isi atau hapus kolom kosong sebelum impor.`, { row: 1 });
      else if (seen.has(key)) issue('error', 'duplicate_header', `Header "${field}" muncul lebih dari sekali. Sisakan satu kolom agar data tidak tertimpa.`, { row: 1, column: field });
      seen.add(key);
    });
    records.forEach((cells, i) => {
      if (cells.length !== result.fields.length) issue('error', 'column_count', `Baris ${i + 2} memiliki ${cells.length} kolom; header memiliki ${result.fields.length}. Periksa tanda kutip dan pemisah CSV.`, { row: i + 2 });
    });
    if (errors) return finish(true);
    const fields = result.fields;
    const hasAny = names => names.some(name => fields.includes(name));
    // Affiliate exports also contain click timestamps. Order/status signatures
    // take precedence, while a standalone Tag_link1 click export is supported.
    if (hasAny(E.COL.aff.orderId) || hasAny(E.COL.aff.orderAt) || hasAny(E.COL.aff.status) || hasAny(E.COL.aff.comm)) result.type = 'affiliate';
    else if (hasAny(E.COL.ads.date) || hasAny(E.COL.ads.spend) || hasAny(E.COL.ads.name)) result.type = 'ads';
    else if (hasAny(E.COL.clk.time) && hasAny(E.COL.clk.tag)) result.type = 'clicks';
    else result.type = E.detectFileType(fields);
    if (!TYPES[result.type]) {
      issue('error', 'unknown_report', 'Jenis laporan tidak dikenali. Gunakan laporan Affiliate Shopee, Meta Ads harian (IDR), atau Klik Shopee dengan header asli.');
      return finish(true);
    }
    const col = E.COL[TYPES[result.type]];
    const required = result.type === 'affiliate' ? ['orderId', 'status', 'orderAt', 'comm'] : result.type === 'ads' ? ['date', 'name', 'spend'] : ['time', 'tag'];
    for (const key of required) if (!hasAny(col[key])) {
      issue('error', 'missing_column', `Kolom wajib tidak ditemukan: ${col[key].join(' / ')}.${result.type === 'ads' && key === 'spend' ? ' Ekspor biaya iklan dalam IDR.' : ' Gunakan header asli laporan.'}`, { row: 1, column: col[key][0] });
    }
    if (errors) return finish(true);
    if (!records.length) { issue('error', 'no_rows', 'Header terbaca, tetapi laporan tidak berisi baris data.'); return finish(true); }
    const optional = result.type === 'affiliate' ? ['gmv', 'qty', 'tag', 'clickAt'] : result.type === 'ads' ? ['clicks', 'impr', 'reach', 'lpv'] : [];
    const missing = optional.filter(key => !hasAny(col[key])).map(key => col[key][0]);
    if (missing.length) issue('warning', 'optional_columns_missing', `Kolom pelengkap tidak tersedia: ${missing.join(', ')}. Metrik terkait belum lengkap; sertakan kolom ini pada ekspor berikutnya.`);
    if (result.type === 'ads' && !fields.includes('Reporting ends')) issue('warning', 'daily_grain_unverified', 'Kolom Reporting ends tidak tersedia. Pastikan laporan Meta Ads diekspor dengan breakdown Waktu → Hari, sehingga setiap baris mewakili satu hari.');
    const numericKeys = result.type === 'affiliate' ? ['comm', 'commNet', 'gmv', 'refund', 'price', 'qty', 'rate'] : result.type === 'ads' ? ['spend', 'clicks', 'impr', 'reach', 'freq', 'cpm', 'ctr', 'lpv', 'results', 'shopClicks', 'allClicks'] : [];
    const numeric = new Map();
    numericKeys.forEach(key => col[key].filter(name => fields.includes(name)).forEach(name => numeric.set(name, key)));
    const countKeys = new Set(['qty', 'clicks', 'impr', 'reach', 'lpv', 'results', 'shopClicks', 'allClicks']);
    let start = '', end = '', nonDaily = false;
    records.forEach((cells, index) => {
      const rowNumber = index + 2;
      const row = Object.fromEntries(fields.map((field, i) => [field, String(cells[i] == null ? '' : cells[i]).trim()]));
      const before = errors;
      const evidence = (column, value) => ({ row: rowNumber, column, value: String(value).slice(0, 160) });
      const rowIssue = (severity, code, message, column, value) => issue(severity, code, `Baris ${rowNumber}: ${message}`, evidence(column, value));
      let excluded = false;
      if (result.type === 'affiliate') {
        const status = E.pick(row, col.status) || '';
        const normalized = STATUSES.get(status.toLowerCase().replace(/\s+/g, ' '));
        if (!normalized) rowIssue('error', 'invalid_status', `status pesanan "${status}" tidak dikenali. Gunakan Selesai, Tertunda, Dibatalkan, atau Belum Dibayar.`, col.status[0], status);
        else { row[col.status[0]] = normalized; excluded = normalized === 'Dibatalkan' || normalized === 'Belum Dibayar'; }
        if (!E.pick(row, col.orderId)) rowIssue('error', 'missing_order_id', 'ID Pemesanan kosong; jumlah pesanan tidak dapat dihitung dengan benar.', col.orderId[0], '');
      }
      if (result.type === 'ads' && !E.pick(row, col.name)) rowIssue('error', 'missing_ad_name', 'nama iklan/kampanye kosong. Hapus baris total dari laporan atau isi nama aslinya.', col.name[0], '');
      const primaryDate = result.type === 'affiliate' ? col.orderAt : result.type === 'ads' ? col.date : col.time;
      const dateValue = E.pick(row, primaryDate) || '';
      if (!validTimestamp(dateValue)) rowIssue('error', 'invalid_date', `tanggal "${dateValue}" tidak valid. Gunakan YYYY-MM-DD atau YYYY-MM-DD HH:mm:ss.`, primaryDate[0], dateValue);
      const day = E.dayOnly(dateValue);
      if (result.type === 'clicks' && !Object.hasOwn(row, 'Waktu Klik')) row['Waktu Klik'] = dateValue;
      if (result.type === 'clicks' && !E.pick(row, ['Perujuk']) && E.pick(row, col.src)) row.Perujuk = E.pick(row, col.src);
      if (result.type === 'affiliate') for (const dateKey of ['clickAt', 'doneAt']) {
        const value = E.pick(row, col[dateKey]);
        if (value && !EMPTY_MARKERS.test(value) && !validTimestamp(value)) rowIssue('error', 'invalid_date', `tanggal ${col[dateKey][0]} "${value}" tidak valid. Gunakan YYYY-MM-DD HH:mm:ss.`, col[dateKey][0], value);
      }
      if (result.type === 'ads' && fields.includes('Reporting ends')) {
        const until = row['Reporting ends'];
        if (!validTimestamp(until)) rowIssue('error', 'invalid_date', 'Reporting ends kosong atau tidak valid. Ekspor ulang laporan Meta Ads harian.', 'Reporting ends', until);
        else if (E.isDate(day) && E.dayOnly(until) !== day) {
          nonDaily = true;
          rowIssue('error', 'non_daily_ads', `Reporting starts (${day}) berbeda dengan Reporting ends (${E.dayOnly(until)}). Seluruh file ditolak agar biaya beberapa hari tidak masuk ke satu tanggal. Ekspor ulang Meta Ads dengan breakdown Waktu → Hari (Time → Day).`, 'Reporting ends', until);
        }
      }
      if (result.type === 'ads') for (const field of ['Currency', 'Account currency']) {
        if (row[field] && row[field].toUpperCase() !== 'IDR') rowIssue('error', 'unsupported_currency', `mata uang ${row[field]} bukan IDR. Gunakan laporan IDR agar biaya tidak tercampur.`, field, row[field]);
      }
      for (const [field, key] of numeric) {
        const raw = row[field], number = strictNumber(raw, { delimiter: result.delimiter, percent: key === 'rate' || key === 'ctr' });
        const essential = key === 'spend' || key === 'comm' && field === col.comm.find(name => row[name] && !EMPTY_MARKERS.test(row[name]));
        if (number.empty) {
          if (essential && !excluded) rowIssue('error', 'missing_amount', `${field} kosong. Isi angka yang benar (0 jika benar-benar nol), lalu impor ulang.`, field, raw);
          else if (!excluded && (key === 'gmv' || key === 'price')) rowIssue('error', 'missing_amount', `${field} kosong. Isi 0 jika nilainya nol agar nilai uang tidak diasumsikan.`, field, raw);
          else { row[field] = ''; rowIssue('warning', 'empty_optional_number', `${field} tidak tersedia${excluded ? '; pesanan tetap dicatat sebagai ' + row[col.status[0]] + ' dan dikecualikan dari ROI' : '; metrik terkait mungkin belum lengkap'}.`, field, raw); }
        } else if (!number.valid || countKeys.has(key) && (!Number.isInteger(number.value) || number.value < 0) || !['comm', 'commNet'].includes(key) && number.value < 0) {
          rowIssue('error', 'invalid_number', `${field} berisi angka tidak valid "${raw}". Perbaiki nilainya; baris ini tidak dimasukkan.`, field, raw);
        } else {
          row[field] = number.value;
          if (number.ambiguous) rowIssue('warning', 'ambiguous_number', `${field} "${raw}" dibaca sebagai ${number.value}. Verifikasi pemisah desimal/ribuan pada sumber; gunakan format tanpa pemisah ribuan untuk menghilangkan ambiguitas.`, field, raw);
        }
      }
      // A commission column may be present but every alternative is empty.
      if (result.type === 'affiliate' && !excluded && !col.comm.some(name => typeof row[name] === 'number')) rowIssue('error', 'missing_commission', 'komisi kosong atau tidak valid. Isi komisi yang benar, termasuk angka 0 jika nol.', col.comm[0], E.pick(row, col.comm) || '');
      if (col.tag && !E.pick(row, col.tag)) rowIssue('warning', 'untagged_row', `tag kosong; ${result.type === 'affiliate' ? 'pesanan masuk kelompok (tanpa tag)' : 'klik tetap masuk total, tetapi tidak dapat dicocokkan ke tag'}.`, col.tag[0], '');
      if (errors === before) {
        Object.defineProperty(row, SOURCE_ROW, { value: Object.fromEntries(sourceFields.map((field, i) =>
          [field, String(cells[i] == null ? '' : cells[i])])) });
        result.rows.push(row);
        if (!start || day < start) start = day;
        if (!end || day > end) end = day;
      }
    });
    if (start) result.period = { start, end };
    if (!result.rows.length && !nonDaily) issue('error', 'no_valid_rows', 'Tidak ada baris valid yang bisa dimuat. Perbaiki temuan di atas lalu impor ulang.');
    return finish(nonDaily);
  }

  return { parseText, strictNumber, validTimestamp };
});
