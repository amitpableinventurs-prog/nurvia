// Small RFC 4180 CSV reader and writer for imports and exports. Quoted fields may hold commas,
// quotes ("") and line breaks. A byte-order mark at the start (Excel adds one) is ignored.

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

// Rows as objects keyed by the header row, header names trimmed and lower-cased. `line` is the
// row's line number in the file (header = 1), for error reports.
export function parseCsvObjects(text) {
  const [header, ...rows] = parseCsv(text);
  if (!header) return [];
  const keys = header.map((h) => h.trim().toLowerCase());
  return rows.map((r, i) => ({ line: i + 2, ...Object.fromEntries(keys.map((k, j) => [k, (r[j] ?? '').trim()])) }));
}

const cell = (v) => {
  if (v === null || v === undefined) return '';
  const s = v instanceof Date ? v.toISOString() : String(v);
  // A leading = + - @ would run as a formula in a spreadsheet, so it is prefixed with '.
  const safe = /^[=+\-@]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function toCsv(columns, rows) {
  return [columns.map((c) => cell(c.label)).join(','), ...rows.map((r) => columns.map((c) => cell(typeof c.value === 'function' ? c.value(r) : r[c.value])).join(','))].join('\r\n') + '\r\n';
}

export function sendCsv(res, filename, columns, rows) {
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${filename}"`);
  res.send('﻿' + toCsv(columns, rows));
}
