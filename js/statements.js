// Credit card statement parsing: recognizes MAX and Cal exports (and generic files via a column
// mapping), and turns rows into transactions. Pure functions; nothing here touches storage.
//   Statements.analyze(book, templates) -> { profile, sheets: [{name, rows, headerRow, columns}], meta }
//   Statements.extract(analysis) -> [{ id, date, chargeDate, month, merchant, amount, card, source, ... }]
(function () {
  const norm = (h) => String(h == null ? '' : h).replace(/\s+/g, ' ').replace(/[״“”]/g, '"').trim();
  const lower = (s) => norm(s).toLowerCase();

  // Column roles and the header words that identify them (first match wins, in order).
  const GENERIC_COLUMNS = {
    date: ['תאריך עסקה', 'תאריך רכישה', 'transaction date', 'purchase date', 'תאריך', 'date'],
    merchant: ['שם בית העסק', 'שם בית עסק', 'בית עסק', 'שם העסק', 'תיאור', 'פירוט', 'merchant', 'description', 'payee', 'business'],
    amount: ['סכום חיוב', 'סכום לחיוב', 'סכום בש"ח', 'סכום בשח', 'סכום החיוב', 'סכום', 'charged amount', 'amount', 'charge'],
    chargeDate: ['תאריך חיוב', 'מועד חיוב', 'charge date', 'billing date', 'posting date'],
    category: ['קטגוריה', 'ענף', 'category'],
    card: ['4 ספרות', 'ספרות אחרונות', 'מספר כרטיס', 'card number', 'card'],
    type: ['סוג עסקה', 'type'],
    note: ['הערות', 'פרטים', 'notes', 'memo'],
    origAmount: ['סכום עסקה מקורי', 'סכום מקורי', 'original amount'],
    origCurrency: ['מטבע עסקה מקורי', 'מטבע מקור', 'original currency'],
  };

  const PROFILES = [
    {
      id: 'max', label: 'MAX',
      test: (h) => has(h, 'שם בית העסק') && has(h, 'סכום חיוב') && has(h, 'קטגוריה'),
    },
    {
      id: 'cal', label: 'Cal',
      test: (h) => has(h, 'שם בית עסק') && has(h, 'מועד חיוב') && (has(h, 'סכום בש"ח') || has(h, 'סכום בשח')),
    },
  ];

  function has(header, word) { return header.some((h) => lower(h).includes(word.toLowerCase())); }

  function findColumns(header) {
    const cols = {};
    const taken = new Set();
    Object.entries(GENERIC_COLUMNS).forEach(([role, words]) => {
      for (const w of words) {
        // Cal's "מזהה כרטיס בארנק דיגיטלי" is a wallet token, not the card number.
        const i = header.findIndex((h, idx) => !taken.has(idx) && lower(h).includes(w.toLowerCase()) && !(role === 'card' && /ארנק|wallet/i.test(h)));
        if (i >= 0) { cols[role] = i; taken.add(i); return; }
      }
    });
    // A plain "תאריך"/"date" match may have grabbed the charge-date column.
    if (cols.date != null && cols.date === cols.chargeDate) delete cols.chargeDate;
    return cols;
  }

  function signature(header) { return header.map(norm).filter(Boolean).join('|'); }

  // ---------- value parsing ----------

  function pad(n) { return String(n).padStart(2, '0'); }

  function toISO(v) {
    if (v instanceof Date && !isNaN(v)) return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
    if (typeof v === 'number' && v > 20000 && v < 80000) {
      const d = new Date(Math.round((v - 25569) * 86400000));
      return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    }
    const s = norm(v);
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
    m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/); // Israeli day-month-year
    if (m) {
      const y = m[3].length === 2 ? '20' + m[3] : m[3];
      if (Number(m[2]) >= 1 && Number(m[2]) <= 12 && Number(m[1]) >= 1 && Number(m[1]) <= 31) return `${y}-${pad(m[2])}-${pad(m[1])}`;
    }
    return null;
  }

  function toNum(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    let s = norm(v).replace(/[₪$€£\s,]/g, '').replace(/ש"ח|nis|ils/gi, '');
    if (!s) return null;
    let sign = 1;
    if (/^\(.*\)$/.test(s)) { sign = -1; s = s.slice(1, -1); }
    if (/-$/.test(s)) { sign = -1; s = s.slice(0, -1); }
    const n = parseFloat(s);
    return Number.isFinite(n) && /^-?[\d.]+$/.test(s) ? sign * n : null;
  }

  // ---------- merchant names ----------

  // Stable key for matching the same business across statements:
  // "Spotify P478C26B1A" -> "spotify", "PAYBOX     TEL AVIV   IL" -> "paybox", 'ספרינט מוטורוס בע"מ -  אי' -> "ספרינט מוטורוס"
  const SUFFIXES = new Set(['בעמ', 'בע"מ', 'ltd', 'ltd.', 'limited', 'inc', 'inc.', 'llc', 'co', 'sa', 'gmbh', '-']);

  function merchantKey(name) {
    let s = String(name == null ? '' : name).split(/\s{2,}/)[0];
    s = s.toLowerCase().replace(/[*_|]/g, ' ').replace(/["״׳']/g, '');
    const tokens = s.split(/\s+/).filter(Boolean).filter((t, i) => {
      if (i === 0) return true;
      if (/^[\d-]+$/.test(t)) return false;                     // pure numbers / ids
      if (/\d/.test(t) && /[a-z֐-׿]/i.test(t)) return false; // reference codes like p478c26b1a
      return !SUFFIXES.has(t);
    });
    return tokens.join(' ').replace(/^[-.,\s]+|[-.,\s]+$/g, '') || s.trim();
  }

  function displayName(name) {
    return String(name == null ? '' : name).split(/\s{2,}/)[0].trim().replace(/\s*-\s*$/, '');
  }

  // ---------- fingerprints ----------

  function hash(str, seed) {
    let h = seed >>> 0;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  // Same purchase in a re-imported or overlapping file gets the same id. Identical purchases on the
  // same day (two coffees) are told apart by their order within the file.
  function assignIds(txns) {
    const seen = {};
    txns.forEach((t) => {
      const base = [t.source, t.card, t.date, t.chargeDate, Math.round(t.amount * 100), merchantKey(t.merchant)].join('|');
      seen[base] = (seen[base] || 0) + 1;
      const full = base + '#' + seen[base];
      t.id = hash(full, 2166136261) + hash(full, 33554467);
    });
    return txns;
  }

  // ---------- analysis ----------

  function headerRowOf(rows) {
    for (let i = 0; i < Math.min(rows.length, 20); i++) {
      const header = (rows[i] || []).map(norm);
      const cols = findColumns(header);
      if (cols.date != null && cols.merchant != null && cols.amount != null) return { index: i, header, cols };
    }
    return null;
  }

  function titleText(rows, upto) {
    return rows.slice(0, upto).map((r) => (r || []).filter((c) => c != null).map(String).join(' ')).join('\n');
  }

  function analyze(book, templates) {
    const sheets = [];
    let profile = null;
    let meta = {};
    for (const s of book.sheets) {
      let found = null;
      const tpl = (templates || []).find((t) => s.rows.slice(0, 20).some((r) => signature((r || []).map(norm)) === t.signature));
      if (tpl) {
        const index = s.rows.findIndex((r) => signature((r || []).map(norm)) === tpl.signature);
        found = { index, header: s.rows[index].map(norm), cols: tpl.columns, template: tpl };
      } else {
        found = headerRowOf(s.rows);
      }
      if (!found) continue;
      const p = found.template
        ? { id: found.template.source || 'custom', label: found.template.label || 'Card statement' }
        : PROFILES.find((x) => x.test(found.header)) || { id: 'generic', label: 'Card statement' };
      if (!profile) profile = p;
      const title = titleText(s.rows, found.index);
      const card = (title.match(/(?:^|[^\d])(\d{4})(?![\d])/m) || [])[1] || '';
      const billing = title.match(/(?:^|\s)(\d{1,2})\/(\d{4})(?:\s|$)/);
      meta = {
        card: meta.card || card,
        billingMonth: meta.billingMonth || (billing ? `${billing[2]}-${pad(billing[1])}` : ''),
      };
      sheets.push({ name: s.name, rows: s.rows, headerRow: found.index, header: found.header, columns: found.cols });
    }
    return sheets.length ? { profile, sheets, meta } : null;
  }

  // For the column-mapping step when nothing was recognized: the most header-like row of the first sheet.
  function guessHeader(book) {
    const s = book.sheets.find((x) => x.rows.length) || book.sheets[0];
    if (!s) return null;
    let best = 0, bestScore = -1;
    s.rows.slice(0, 20).forEach((r, i) => {
      const score = (r || []).filter((c) => typeof c === 'string' && c.trim()).length;
      if (score > bestScore) { best = i; bestScore = score; }
    });
    return { sheet: s, headerRow: best, header: (s.rows[best] || []).map(norm), columns: findColumns((s.rows[best] || []).map(norm)) };
  }

  function extract(analysis) {
    const source = analysis.profile.id;
    const out = [];
    analysis.sheets.forEach((s) => {
      const c = s.columns;
      const cell = (r, role) => (c[role] != null ? r[c[role]] : null);
      s.rows.slice(s.headerRow + 1).forEach((r) => {
        if (!r) return;
        const date = toISO(cell(r, 'date'));
        const amount = toNum(cell(r, 'amount'));
        const merchant = norm(cell(r, 'merchant'));
        if (!date || amount === null || !merchant) return; // totals, blank and footer rows
        const chargeDate = toISO(cell(r, 'chargeDate')) || (analysis.meta.billingMonth ? analysis.meta.billingMonth + '-01' : date);
        const type = norm(cell(r, 'type'));
        const note = norm(cell(r, 'note'));
        const t = {
          date,
          chargeDate,
          month: chargeDate.slice(0, 7),
          merchant: String(cell(r, 'merchant')).trim(),
          amount: Math.round(amount * 100) / 100,
          card: norm(cell(r, 'card')).replace(/\D/g, '').slice(-4) || analysis.meta.card || '',
          source,
          kind: 'regular',
        };
        const srcCat = norm(cell(r, 'category'));
        if (srcCat) t.sourceCategory = srcCat;
        if (/זיכוי|החזר|refund|credit/i.test(type) || amount < 0) t.kind = 'refund';
        else if (/הוראת קבע|standing/i.test(type + ' ' + note)) t.kind = 'standing';
        const inst = (note + ' ' + type).match(/תשלום\s*(\d+)\s*מתוך\s*(\d+)/);
        if (inst) { t.kind = 'installment'; t.installment = `${inst[1]}/${inst[2]}`; }
        else if (/תשלומים/.test(type)) t.kind = 'installment';
        const origCur = norm(cell(r, 'origCurrency'));
        const origAmt = toNum(cell(r, 'origAmount'));
        if (origCur && origCur !== '₪' && origAmt !== null) t.original = `${origAmt} ${origCur}`;
        const inNote = note.match(/סכום העסקה הוא\s*([\d.,]+)\s*(\S+)/);
        if (!t.original && inNote) t.original = `${inNote[1]} ${inNote[2]}`;
        out.push(t);
      });
    });
    return assignIds(out);
  }

  window.Statements = { analyze, extract, guessHeader, findColumns, signature, merchantKey, displayName, toISO, toNum, ROLES: Object.keys(GENERIC_COLUMNS) };
})();
