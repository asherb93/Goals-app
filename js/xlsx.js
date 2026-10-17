// Minimal .xlsx / .csv reader with no dependencies. Unzips with the browser's DecompressionStream,
// parses the sheet XML with DOMParser, and returns plain rows:
//   Xlsx.read(arrayBuffer) -> { sheets: [{ name, rows: [[cell, ...], ...] }] }
// Cells are strings, numbers, booleans, null, or Date (for cells with a date number format).
(function () {
  const utf8 = new TextDecoder('utf-8');
  const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

  // ---------- zip ----------

  function zipIndex(buf) {
    const dv = new DataView(buf);
    let eocd = -1;
    for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('This file is not an .xlsx workbook.');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const files = {};
    for (let n = 0; n < count && dv.getUint32(p, true) === 0x02014b50; n++) {
      const nameLen = dv.getUint16(p + 28, true);
      files[utf8.decode(new Uint8Array(buf, p + 46, nameLen))] = {
        method: dv.getUint16(p + 10, true),
        size: dv.getUint32(p + 20, true),
        offset: dv.getUint32(p + 42, true),
      };
      p += 46 + nameLen + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
    }
    return files;
  }

  async function entryText(buf, files, name) {
    const e = files[name];
    if (!e) return null;
    const dv = new DataView(buf);
    const start = e.offset + 30 + dv.getUint16(e.offset + 26, true) + dv.getUint16(e.offset + 28, true);
    let bytes = new Uint8Array(buf, start, e.size);
    if (e.method === 8) {
      if (typeof DecompressionStream === 'undefined') throw new Error('This browser is too old to read .xlsx files. Save the file as .csv instead.');
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    } else if (e.method !== 0) {
      throw new Error('Unsupported .xlsx compression.');
    }
    return utf8.decode(bytes);
  }

  // ---------- xml helpers ----------

  const parseXml = (text) => new DOMParser().parseFromString(text, 'application/xml');
  const els = (node, name) => Array.from(node.getElementsByTagNameNS('*', name));

  function textOf(node) {
    // Rich text: join <t> runs, skipping phonetic hints (<rPh>).
    return els(node, 't').filter((t) => !(t.parentNode && t.parentNode.localName === 'rPh')).map((t) => t.textContent).join('');
  }

  const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);

  function dateStyles(stylesXml) {
    if (!stylesXml) return new Set();
    const doc = parseXml(stylesXml);
    const custom = {};
    els(doc, 'numFmt').forEach((f) => { custom[f.getAttribute('numFmtId')] = f.getAttribute('formatCode') || ''; });
    const isDate = (id) => {
      if (BUILTIN_DATE_FORMATS.has(Number(id))) return true;
      const code = (custom[id] || '').replace(/"[^"]*"|\[[^\]]*\]|\\./g, '');
      return /[dmy]/i.test(code) && !/general/i.test(code);
    };
    const xfs = els(doc, 'cellXfs')[0];
    const out = new Set();
    if (xfs) Array.from(xfs.children).forEach((xf, i) => { if (isDate(xf.getAttribute('numFmtId'))) out.add(i); });
    return out;
  }

  function colIndex(ref) {
    let n = 0;
    for (const ch of ref.replace(/\d+/g, '')) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  }

  function excelDate(serial) {
    const d = new Date(Math.round((serial - 25569) * 86400000));
    return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  }

  function readSheet(xml, shared, dates) {
    const rows = [];
    els(parseXml(xml), 'row').forEach((rowEl, i) => {
      const r = Number(rowEl.getAttribute('r')) || i + 1;
      const row = [];
      els(rowEl, 'c').forEach((c, j) => {
        const ref = c.getAttribute('r');
        const col = ref ? colIndex(ref) : j;
        const t = c.getAttribute('t');
        const v = els(c, 'v')[0];
        let value = null;
        if (t === 's') value = v ? shared[Number(v.textContent)] : null;
        else if (t === 'inlineStr') value = textOf(c);
        else if (t === 'str') value = v ? v.textContent : '';
        else if (t === 'b') value = v ? v.textContent === '1' : null;
        else if (t === 'e') value = null;
        else if (v) {
          const n = parseFloat(v.textContent);
          value = dates.has(Number(c.getAttribute('s'))) && Number.isFinite(n) ? excelDate(n) : n;
        }
        row[col] = value;
      });
      rows[r - 1] = row;
    });
    for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
    return rows;
  }

  async function read(buf) {
    const files = zipIndex(buf);
    const wb = await entryText(buf, files, 'xl/workbook.xml');
    if (!wb) throw new Error('This file is not an .xlsx workbook.');
    const relsXml = await entryText(buf, files, 'xl/_rels/workbook.xml.rels');
    const rels = {};
    if (relsXml) els(parseXml(relsXml), 'Relationship').forEach((r) => { rels[r.getAttribute('Id')] = r.getAttribute('Target'); });
    const sharedXml = await entryText(buf, files, 'xl/sharedStrings.xml');
    const shared = sharedXml ? els(parseXml(sharedXml), 'si').map(textOf) : [];
    const dates = dateStyles(await entryText(buf, files, 'xl/styles.xml'));

    const sheets = [];
    for (const s of els(parseXml(wb), 'sheet')) {
      const rid = s.getAttributeNS(REL_NS, 'id') || s.getAttribute('r:id');
      const target = rels[rid];
      if (!target) continue;
      const path = target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '');
      const xml = await entryText(buf, files, path);
      if (xml) sheets.push({ name: s.getAttribute('name'), rows: readSheet(xml, shared, dates) });
    }
    return { sheets };
  }

  // ---------- csv ----------

  function readCsv(text) {
    const rows = [];
    let row = [], cell = '', quoted = false;
    const delim = (text.split('\n')[0].match(/;/g) || []).length > (text.split('\n')[0].match(/,/g) || []).length ? ';' : ',';
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quoted) {
        if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
        else if (ch === '"') quoted = false;
        else cell += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === delim) { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += ch;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return { sheets: [{ name: 'CSV', rows: rows.map((r) => r.map((c) => (c.trim() === '' ? null : c.trim()))) }] };
  }

  async function readFile(file) {
    const buf = await file.arrayBuffer();
    const head = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
    if (head[0] === 0x50 && head[1] === 0x4b) return read(buf);
    if (head[0] === 0xd0 && head[1] === 0xcf) throw new Error('This is an old-style .xls file. Open it in Excel or Numbers and save it as .xlsx or .csv.');
    let text = new TextDecoder('utf-8').decode(buf);
    if (text.includes('�')) text = new TextDecoder('windows-1255').decode(buf); // Hebrew CSVs from Excel
    return readCsv(text.replace(/^﻿/, ''));
  }

  window.Xlsx = { read, readCsv, readFile };
})();
