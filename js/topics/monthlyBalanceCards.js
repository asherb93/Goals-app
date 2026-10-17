// Monthly Balance: importing card statements and reviewing/categorizing card transactions.
// Rendered inside the "My numbers" view (ctx.ui.panel = 'import' | 'transactions').
(function () {
  const { money, esc } = Fmt;
  const sum = (arr) => arr.reduce((a, b) => a + b, 0);
  const ROLE_LABELS = {
    date: 'Purchase date *', merchant: 'Business *', amount: 'Charged amount *', chargeDate: 'Charge date',
    category: 'Category', card: 'Card number', type: 'Transaction type', note: 'Notes',
  };

  function backBar(ctx, title) {
    const el = document.createElement('div');
    el.className = 'panel-bar';
    el.innerHTML = `<button class="btn btn-small" data-back>← My numbers</button><h1>${esc(title)}</h1>`;
    el.querySelector('[data-back]').onclick = () => { ctx.ui.panel = null; ctx.ui.importState = null; ctx.rerender(); };
    return el;
  }

  function kindBadges(t, showCard) {
    const b = [];
    if (t.kind === 'refund') b.push('<span class="tag good">Refund</span>');
    if (t.kind === 'standing') b.push('<span class="tag">Standing order</span>');
    if (t.kind === 'installment') b.push(`<span class="tag">Installment ${esc(t.installment || '')}</span>`);
    if (t.original) b.push(`<span class="tag">${esc(t.original)}</span>`);
    if (showCard && t.card) b.push(`<span class="tag">••${esc(t.card)}</span>`);
    return b.join('');
  }

  // First guesses for businesses the card company didn't categorize. Shown as "Suggested";
  // nothing is saved until the import is confirmed.
  const KEYWORDS = [
    [/hotel|booking|airbnb|ryanair|wizz|easyjet|aegean|airline|duty free|maritime|ferry|מלון|אל על|טיסה/i, 'travel'],
    [/דלק|פז |סונול|delek|shell|fuel|yellow|פנגו|pango|gett|freenow|uber|bolt|רכבת|מונית|חניה|parking|taxi/i, 'transport'],
    [/supermarket|super |carrefour|lidl|שופרסל|רמי לוי|טיב טעם|יוחננוף|ויקטורי|מעדני|ירקות|שוק|סופר |מכולת|קצביה|מאפ/i, 'food'],
    [/wolt|cafe|caffe|coffee|espresso|קפה|מסעד|restaurant|pizza|פיצה|burger|bar |taverna|catering|בר$|גלידה/i, 'fun'],
    [/פארם|pharm|כללית|מכבי|מאוחדת|לאומית|רופא|dental|שיניים|מרפאה/i, 'health'],
    [/spotify|netflix|apple\.com|itunes|google|youtube|disney|icloud|wix|chatgpt|openai/i, 'subs'],
    [/ביטוח|insurance|מנורה|הראל|מגדל|הפניקס|מבטחים/i, 'insurance'],
    [/temu|aliexpress|shein|zara|amazon|yesstyle|ikea|h&m|kiko|shop|store|outlet|fashion/i, 'shopping'],
    [/paybox|^bit\b|ביט /i, 'transfers'],
    [/עיריי|ארנונה|חברת החשמל|תאגיד מים|בזק|פרטנר|סלקום|hot |mobile|גז /i, 'bills'],
  ];

  function suggestCategory(td, key, name, history) {
    if (history.has(key)) return history.get(key);
    const hit = KEYWORDS.find(([re, id]) => re.test(name) && td.categories.some((c) => c.id === id));
    return hit ? hit[1] : '';
  }

  // Business key -> the category it already has elsewhere in your transactions.
  function categoryHistory(td) {
    const map = new Map();
    td.transactions.forEach((t) => {
      const id = MB.txnCategory(td, t).id;
      if (id) map.set(MB.keyOf(t), id);
    });
    return map;
  }

  function dayLabel(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  }

  // ---------- Import ----------

  function renderImport(root, ctx, td) {
    root.append(backBar(ctx, 'Import card statement'));
    const view = document.createElement('div');
    view.className = 'stack';
    root.append(view);
    const st = ctx.ui.importState || (ctx.ui.importState = { step: 'pick' });
    const redraw = () => { view.innerHTML = ''; draw(); };

    function draw() {
      if (st.step === 'pick') drawPick();
      else if (st.step === 'map') drawMap();
      else drawPreview();
    }

    // Step 1: choose a file
    function drawPick() {
      view.innerHTML = `
        <section class="card">
          <label class="dropzone" id="dropzone">
            <input type="file" id="statement-file" accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" hidden>
            <span class="dropzone-icon" aria-hidden="true">⬆</span>
            <strong>Drop a statement here or click to choose a file</strong>
            <span class="muted">MAX and Cal exports (.xlsx) are recognized automatically. Other cards (.xlsx or .csv): you match the columns once and the app remembers.</span>
          </label>
          ${st.error ? MB.warning(st.error) : ''}
          <p class="hint privacy">🔒 The file is read on this device only. Just the transactions are saved; names, ID and account numbers in the file are ignored.</p>
        </section>`;
      const input = view.querySelector('#statement-file');
      const zone = view.querySelector('#dropzone');
      input.onchange = () => input.files[0] && load(input.files[0]);
      zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
      zone.addEventListener('dragleave', () => zone.classList.remove('over'));
      zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('over'); if (e.dataTransfer.files[0]) load(e.dataTransfer.files[0]); });
    }

    async function load(file) {
      st.error = '';
      view.querySelector('.dropzone strong').textContent = 'Reading ' + file.name + '…';
      try {
        st.book = await Xlsx.readFile(file);
        st.fileName = file.name;
        const analysis = Statements.analyze(st.book, td.templates);
        if (analysis) prepare(analysis);
        else startMapping();
      } catch (e) {
        st.error = e.message || 'Could not read this file.';
        st.step = 'pick';
      }
      redraw();
    }

    function startMapping(analysis) {
      const g = analysis
        ? { sheet: st.book.sheets.find((s) => s.name === analysis.sheets[0].name), headerRow: analysis.sheets[0].headerRow, columns: { ...analysis.sheets[0].columns } }
        : Statements.guessHeader(st.book);
      if (!g) { st.error = 'This file has no rows.'; st.step = 'pick'; return; }
      st.map = {
        sheetName: g.sheet.name, headerRow: g.headerRow, columns: g.columns, label: analysis ? analysis.profile.label : '',
        source: analysis ? analysis.profile.id : '',
      };
      st.step = 'map';
    }

    // Step 1b: match columns for an unknown format
    function drawMap() {
      const sheet = st.book.sheets.find((s) => s.name === st.map.sheetName) || st.book.sheets[0];
      const header = (sheet.rows[st.map.headerRow] || []).map((h) => String(h == null ? '' : h).replace(/\s+/g, ' ').trim());
      const sample = sheet.rows.slice(st.map.headerRow + 1).filter((r) => r && r.some((c) => c != null)).slice(0, 5);
      const colOptions = (sel) => `<option value="">—</option>` + header.map((h, i) => `<option value="${i}"${sel === i ? ' selected' : ''}>${esc(h || `Column ${i + 1}`)}</option>`).join('');
      const show = (v) => (v instanceof Date ? Statements.toISO(v) : v == null ? '' : String(v));
      view.innerHTML = `
        <section class="card">
          ${MB.cardHead('⇆', 'var(--s4)', 'Match the columns')}
          <p class="hint">Tell the app which column is which. It remembers this format for next time.</p>
          <div class="map-grid">
            <label class="field"><span>Sheet</span><select class="select" data-map="sheet">${st.book.sheets.map((s) => `<option${s.name === sheet.name ? ' selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>
            <label class="field"><span>Header row</span><select class="select" data-map="headerRow">${sheet.rows.slice(0, 20).map((r, i) => `<option value="${i}"${i === st.map.headerRow ? ' selected' : ''}>Row ${i + 1}: ${esc((r || []).filter((c) => c != null).slice(0, 3).map(show).join(' · ').slice(0, 50))}</option>`).join('')}</select></label>
            ${Object.entries(ROLE_LABELS).map(([role, label]) => `
              <label class="field"><span>${label}</span><select class="select" data-role="${role}">${colOptions(st.map.columns[role])}</select></label>`).join('')}
            <label class="field"><span>Name this format</span><input class="text-input" data-map="label" placeholder="e.g. Isracard" value="${esc(st.map.label)}"></label>
          </div>
          <div class="table-scroll"><table class="preview-table">
            <thead><tr>${header.map((h) => `<th dir="auto">${esc(h)}</th>`).join('')}</tr></thead>
            <tbody>${sample.map((r) => `<tr>${header.map((_, i) => `<td dir="auto">${esc(show(r[i]))}</td>`).join('')}</tr>`).join('')}</tbody>
          </table></div>
          <div class="form-error" id="map-error"></div>
          <div class="btn-row"><button class="btn" data-cancel>Choose another file</button><button class="btn btn-primary" data-use>Use these columns</button></div>
        </section>`;
      view.querySelector('[data-map="sheet"]').onchange = (e) => {
        st.map.sheetName = e.target.value;
        const g = Statements.guessHeader({ sheets: [st.book.sheets.find((s) => s.name === e.target.value)] });
        st.map.headerRow = g.headerRow; st.map.columns = g.columns;
        redraw();
      };
      view.querySelector('[data-map="headerRow"]').onchange = (e) => {
        st.map.headerRow = Number(e.target.value);
        st.map.columns = Statements.findColumns((sheet.rows[st.map.headerRow] || []).map((h) => String(h == null ? '' : h)));
        redraw();
      };
      view.querySelectorAll('[data-role]').forEach((sel) => {
        sel.onchange = () => {
          if (sel.value === '') delete st.map.columns[sel.dataset.role];
          else st.map.columns[sel.dataset.role] = Number(sel.value);
        };
      });
      view.querySelector('[data-map="label"]').oninput = (e) => { st.map.label = e.target.value; };
      view.querySelector('[data-cancel]').onclick = () => { ctx.ui.importState = { step: 'pick' }; ctx.rerender(); };
      view.querySelector('[data-use]').onclick = () => {
        const c = st.map.columns;
        if (c.date == null || c.merchant == null || c.amount == null) {
          view.querySelector('#map-error').textContent = 'Choose the purchase date, business and amount columns.';
          return;
        }
        const tpl = {
          id: Fmt.uid(), signature: Statements.signature(header), columns: { ...c }, label: st.map.label.trim() || 'Card statement',
          // Adjusting a recognized MAX/Cal file keeps its source, so purchases keep the same ids and still dedupe.
          ...(st.map.source ? { source: st.map.source } : {}),
        };
        const analysis = Statements.analyze(st.book, [tpl]);
        if (!analysis || !Statements.extract(analysis).length) {
          view.querySelector('#map-error').textContent = 'No transactions found with these columns. Check the date, business and amount columns.';
          return;
        }
        td.templates = td.templates.filter((t) => t.signature !== tpl.signature).concat(tpl);
        ctx.changed();
        prepare(analysis);
        redraw();
      };
    }

    function prepare(analysis) {
      const txns = Statements.extract(analysis);
      const existing = new Set(td.transactions.map((t) => t.id));
      st.analysis = analysis;
      st.txns = txns.map((t) => ({ ...t, dup: existing.has(t.id) }));
      st.pendingMap = st.pendingMap || {};
      st.choices = st.choices || {};
      // A new set of transactions (e.g. after "Adjust columns") gets fresh default ticks and suggestions;
      // only choices the person made themselves are kept.
      st.removeManual = {};
      st.removeTouched = {};
      st.suggested = false;
      Object.keys(st.choices).forEach((k) => { if (!st.choices[k].touched) delete st.choices[k]; });
      st.step = txns.length ? 'preview' : 'pick';
      if (!txns.length) st.error = 'No transactions found in this file. If it is from a card company, try matching the columns.';
    }

    function groupsNeedingCategory(fresh) {
      const groups = new Map();
      fresh.forEach((t) => {
        if (MB.txnCategory(td, t, st.pendingMap).id) return;
        const key = MB.keyOf(t);
        const g = groups.get(key) || { key, name: Statements.displayName(t.merchant), count: 0, total: 0 };
        g.count += 1;
        g.total += t.amount;
        groups.set(key, g);
      });
      return [...groups.values()].sort((a, b) => b.total - a.total);
    }

    // Expenses typed in by hand that this statement may already cover, so they'd be counted twice:
    //  - 'card': a 💳 card expense in the month a purchase was made or charged. Same amount = probably
    //    that purchase (ticked); others may be on another card (left alone unless ticked).
    //  - 'budget': a line from before targets existed whose Direct/Card was only guessed. The old app
    //    turned such a line into a budget once a statement had purchases in its category; ticking it
    //    does the same now (it stops counting and stays as a target).
    function manualOverlaps(fresh) {
      const free = fresh.filter((t) => !MB.isExcluded(td, categoryOfTxn(t))).map((t) => ({ t, used: false }));
      const months = new Set();
      fresh.forEach((t) => { months.add(t.month); months.add(t.date.slice(0, 7)); });
      const categoryOf = categoryOfTxn;
      const same = (u, amount) => !u.used && amount > 0 && Math.abs(u.t.amount - amount) < 0.005;
      const cards = [], budgets = [];
      [...months].sort().forEach((k) => {
        ((td.months[k] && td.months[k].expenses) || []).forEach((e) => {
          const item = { month: k, id: e.id, name: String(e.name || '').trim() || 'Expense', amount: Fmt.num(e.amount) };
          if (e.method === 'card') { if (!MB.isExcluded(td, e.category)) cards.push({ ...item, kind: 'card', match: null }); }
          else if (e.guessed && e.category && !MB.isExcluded(td, e.category)
            && fresh.some((t) => t.month === k && categoryOf(t) === e.category && !MB.isExcluded(td, categoryOf(t)))) {
            budgets.push({ ...item, kind: 'budget', category: e.category });
          }
        });
      });
      // Pass 1: a purchase charged in a month covers a card expense typed into that month (the app
      // counts card purchases by charge month). Pass 2: leftovers may have been typed into the month
      // they were bought in; installments and standing orders aren't, so they're skipped here.
      cards.forEach((o) => {
        const hit = free.find((u) => same(u, o.amount) && u.t.month === o.month && u.t.date.slice(0, 7) === o.month)
          || free.find((u) => same(u, o.amount) && u.t.month === o.month);
        if (hit) { hit.used = true; o.match = hit.t; }
      });
      cards.filter((o) => !o.match).forEach((o) => {
        const hit = free.find((u) => same(u, o.amount) && u.t.date.slice(0, 7) === o.month && u.t.kind !== 'installment' && u.t.kind !== 'standing');
        if (hit) { hit.used = true; o.match = hit.t; }
      });
      return [...cards.filter((o) => o.match), ...budgets, ...cards.filter((o) => !o.match)];
    }

    // A statement purchase's category as the preview currently shows it (mappings and choices included).
    function categoryOfTxn(t) {
      return MB.txnCategory(td, t, st.pendingMap).id || (st.choices[MB.keyOf(t)] || {}).category || '';
    }

    // Step 2: preview, map card categories, categorize unknown businesses, confirm
    function drawPreview() {
      const fresh = st.txns.filter((t) => !t.dup);
      const dups = st.txns.length - fresh.length;
      const months = {};
      fresh.forEach((t) => { months[t.month] = (months[t.month] || 0) + 1; });
      const srcCats = [...new Set(fresh.map((t) => t.sourceCategory).filter(Boolean))].sort();
      const groups = groupsNeedingCategory(fresh);
      if (!st.suggested) {
        const history = categoryHistory(td);
        groups.forEach((g) => {
          const id = suggestCategory(td, g.key, g.name, history);
          if (id && !st.choices[g.key]) st.choices[g.key] = { category: id, remember: true, suggested: id };
        });
        st.suggested = true;
      }
      const overlaps = manualOverlaps(fresh);
      st.removeManual = st.removeManual || {};
      st.removeTouched = st.removeTouched || {};
      overlaps.forEach((o) => { if (!st.removeTouched[o.id]) st.removeManual[o.id] = o.kind === 'budget' || !!o.match; });
      st.overlaps = overlaps;
      const label = st.analysis.profile.label;
      const card = st.analysis.meta.card || (fresh[0] && fresh[0].card) || '';
      const effective = (t) => {
        const id = MB.txnCategory(td, t, st.pendingMap).id || st.choices[MB.keyOf(t)]?.category || '';
        return id;
      };

      view.innerHTML = `
        <section class="card">
          <div class="import-head">
            <span class="source-badge">${esc(label)}</span>
            <div><strong>${card ? `Card ••${esc(card)}` : esc(st.fileName)}</strong><div class="muted">${esc(st.fileName)}</div></div>
            <button class="btn btn-small" data-adjust>Adjust columns</button>
          </div>
          <div class="stat-tiles">
            <div class="stat"><strong>${fresh.length}</strong><span>new transactions</span></div>
            <div class="stat"><strong>${dups}</strong><span>already imported</span></div>
            <div class="stat${groups.length ? ' warn' : ''}"><strong>${groups.reduce((n, g) => n + g.count, 0)}</strong><span>not categorized by ${esc(st.analysis.profile.label)}</span></div>
            <div class="stat"><strong>${money(sum(fresh.map((t) => t.amount)))}</strong><span>total</span></div>
          </div>
          ${fresh.length ? `<p class="hint">Counted in the month they're charged: ${Object.keys(months).sort().map((k) => `<span class="tag">${Fmt.monthLabel(k)} · ${months[k]}</span>`).join(' ')}</p>` : '<p class="hint">Everything in this file was imported before. Nothing to add.</p>'}
        </section>

        ${overlaps.length ? `
        <section class="card">
          ${MB.cardHead('✎', 'var(--s2)', 'Expenses you entered by hand')}
          <p class="hint">This statement may already include these, so they'd be counted twice. Ticked ones are handled when you import;
            you can undo it by removing the statement later.</p>
          <div class="overlap-list">
            ${overlaps.map((o) => `
              <label class="overlap-row">
                <input type="checkbox" data-overlap="${esc(o.id)}"${st.removeManual[o.id] ? ' checked' : ''}>
                <span class="overlap-name"><strong dir="auto">${esc(o.name)}</strong><span class="muted">${o.kind === 'card' ? '💳 Card' : '🏦 Direct'} · ${Fmt.monthLabel(o.month)} · ${money(o.amount)}</span></span>
                ${o.kind === 'budget'
                  ? `<span class="tag">Stop counting it; keep it as a target, since the statement has ${esc(MB.categoryName(td, o.category))} purchases</span>`
                  : o.match
                    ? `<span class="tag">Remove: same amount as <span dir="auto">${esc(Statements.displayName(o.match.merchant))}</span>, ${dayLabel(o.match.date)}${o.match.month !== o.month ? `, counted in ${Fmt.monthLabel(o.match.month, true)}` : ''}</span>`
                    : '<span class="tag">Remove (no matching amount)</span>'}
              </label>`).join('')}
          </div>
        </section>` : ''}

        ${srcCats.length ? `
        <section class="card">
          ${MB.cardHead('⇆', 'var(--s4)', `${esc(label)} categories → your categories`)}
          <p class="hint">${esc(label)} already sorts purchases. Choose how its categories map to yours; this is remembered for every future import.</p>
          <div class="map-list">
            ${srcCats.map((s) => {
              const cur = MB.sourceCategory(td, s, st.pendingMap);
              return `<div class="map-row${cur ? '' : ' warn'}"><span dir="auto">${esc(s)}</span><span aria-hidden="true">→</span>
                <select class="select" data-src="${esc(s)}">${MB.categoryOptions(td, cur, { none: 'Choose…', allowNew: true })}</select></div>`;
            }).join('')}
          </div>
        </section>` : ''}

        ${groups.length ? `
        <section class="card">
          ${MB.cardHead('?', 'var(--critical)', 'Needs a category')}
          <p class="hint">Grouped by business, so you decide once. “Always” saves a rule for this business for future statements too.
            Some are pre-filled as <span class="tag">Suggested</span> from your past transactions or the business name; check them before importing. You can leave any for later.</p>
          <div class="group-list">
            ${groups.map((g) => {
              const ch = st.choices[g.key] || { category: '', remember: true };
              return `<div class="group-row" data-key="${esc(g.key)}">
                <div class="group-name"><strong dir="auto">${esc(g.name)}</strong><span class="muted">${g.count} × · ${money(g.total)}${ch.suggested && ch.suggested === ch.category ? ' <span class="tag">Suggested</span>' : ''}</span></div>
                <select class="select" data-group>${MB.categoryOptions(td, ch.category, { none: 'Choose a category…', allowNew: true })}</select>
                <label class="mini-check"><input type="checkbox" data-remember${ch.remember ? ' checked' : ''}> Always</label>
              </div>`;
            }).join('')}
          </div>
        </section>` : ''}

        <section class="card">
          <details>
            <summary class="details-summary">All ${st.txns.length} transactions in this file</summary>
            <div class="table-scroll"><table class="preview-table">
              <thead><tr><th>Date</th><th>Business</th><th>Category</th><th class="num">Amount</th><th>Status</th></tr></thead>
              <tbody>${st.txns.map((t) => `<tr${t.dup ? ' class="dim"' : ''}><td>${dayLabel(t.date)}</td><td dir="auto">${esc(Statements.displayName(t.merchant))} ${kindBadges(t)}</td>
                <td>${esc(effective(t) ? MB.categoryName(td, effective(t)) : '—')}</td><td class="num">${money(t.amount)}</td><td>${t.dup ? 'Already imported' : 'New'}</td></tr>`).join('')}</tbody>
            </table></div>
          </details>
        </section>

        <div class="btn-row sticky-actions">
          <button class="btn" data-cancel>Cancel</button>
          <button class="btn btn-primary" data-import${fresh.length ? '' : ' disabled'}>Import ${fresh.length} transaction${fresh.length === 1 ? '' : 's'}</button>
        </div>`;

      view.querySelector('[data-adjust]').onclick = () => { startMapping(st.analysis); redraw(); };
      view.querySelector('[data-cancel]').onclick = () => { ctx.ui.importState = { step: 'pick' }; ctx.rerender(); };
      view.querySelectorAll('[data-src]').forEach((sel) => {
        sel.onchange = () => {
          const v = MB.resolveNewCategory(td, ctx, sel.value);
          if (!(sel.value === '__new' && !v)) st.pendingMap[sel.dataset.src] = v;
          redraw();
        };
      });
      view.querySelectorAll('.group-row').forEach((row) => {
        const key = row.dataset.key;
        const ch = () => (st.choices[key] = st.choices[key] || { category: '', remember: true });
        row.querySelector('[data-group]').onchange = (e) => {
          const v = MB.resolveNewCategory(td, ctx, e.target.value);
          if (!(e.target.value === '__new' && !v)) { ch().category = v; ch().touched = true; } // cancelled "+ New category…" keeps the old choice
          // The category decides which hand-entered lines this statement covers, so redraw that too.
          redraw();
        };
        row.querySelector('[data-remember]').onchange = (e) => { ch().remember = e.target.checked; ch().touched = true; };
      });
      view.querySelectorAll('[data-overlap]').forEach((box) => {
        box.onchange = () => { st.removeManual[box.dataset.overlap] = box.checked; st.removeTouched[box.dataset.overlap] = true; };
      });
      view.querySelector('[data-import]').onclick = () => doImport(fresh);
    }

    function doImport(fresh) {
      // Card-category mapping: only store what differs from the built-in defaults.
      Object.entries(st.pendingMap).forEach(([src, id]) => {
        if ((MB.DEFAULT_SOURCE_MAP[src] || '') === id) delete td.sourceMap[src];
        else td.sourceMap[src] = id;
      });
      const importId = Fmt.uid();
      // Only businesses still shown under "Needs a category" use the choices made there; a card-company
      // mapping chosen meanwhile wins, and no hidden rules are saved.
      const open = new Set(groupsNeedingCategory(fresh).map((g) => g.key));
      const choices = {};
      Object.entries(st.choices).forEach(([key, ch]) => { if (open.has(key)) choices[key] = ch; });
      Object.entries(choices).forEach(([key, ch]) => { if (ch.category && ch.remember) MB.upsertRule(td, key, ch.category); });
      fresh.forEach((t) => {
        const { dup, ...clean } = t;
        const ch = choices[MB.keyOf(t)];
        if (ch && ch.category && !ch.remember) clean.category = ch.category;
        clean.importId = importId;
        td.transactions.push(clean);
      });
      td.imports.push({
        id: importId, at: new Date().toISOString(), label: st.analysis.profile.label,
        card: st.analysis.meta.card || (fresh[0] && fresh[0].card) || '', file: st.fileName, count: fresh.length,
      });
      // Hand-entered expenses the person chose to let this statement replace. Saved on the import
      // record so removing the statement brings them back.
      const undo = { expenses: [], targets: [] };
      (st.overlaps || []).filter((o) => st.removeManual[o.id]).forEach((o) => {
        const m = td.months[o.month];
        const i = m && m.expenses ? m.expenses.findIndex((e) => e.id === o.id) : -1;
        if (i < 0) return;
        const [e] = m.expenses.splice(i, 1);
        undo.expenses.push({ month: o.month, index: i, expense: e });
        if (o.kind === 'budget') {
          m.targets = m.targets || [];
          const same = m.targets.some((t) => t.category === e.category && String(t.name || '').trim().toLowerCase() === String(e.name || '').trim().toLowerCase());
          if (!same) {
            const target = { id: Fmt.uid(), name: e.name || '', category: e.category, amount: e.amount };
            m.targets.push(target);
            undo.targets.push({ month: o.month, id: target.id });
          }
        }
      });
      const removed = undo.expenses.length;
      if (removed) td.imports[td.imports.length - 1].undo = undo;
      ctx.changed();
      const months = [...new Set(fresh.map((t) => t.month))].sort();
      ctx.ui.month = months.includes(ctx.ui.month) ? ctx.ui.month : months[months.length - 1];
      ctx.ui.importState = null;
      ctx.ui.panel = 'transactions';
      ctx.ui.txFilter = { q: '', cat: 'all' };
      App.toast(`Imported ${fresh.length} transactions from ${st.analysis.profile.label}.`
        + (removed ? ` ${removed} expense${removed > 1 ? 's' : ''} you had entered by hand ${removed > 1 ? 'are' : 'is'} now covered by the statement.` : ''));
      ctx.rerender();
    }

    draw();
  }

  // ---------- Transactions ----------

  function renderTransactions(root, ctx, td) {
    root.append(backBar(ctx, 'Card transactions'));
    root.append(MB.monthBar(ctx));
    const view = document.createElement('div');
    view.className = 'stack';
    root.append(view);
    const filter = ctx.ui.txFilter || (ctx.ui.txFilter = { q: '', cat: 'all' });
    const key = ctx.ui.month;

    function draw() {
      const cards = new Set(td.transactions.map((t) => t.card).filter(Boolean));
      const all = td.transactions.filter((t) => t.month === key).map((t) => ({ t, cat: MB.txnCategory(td, t) }));
      const q = filter.q.trim().toLowerCase();
      const rows = all.filter(({ t, cat }) => {
        if (filter.cat === 'none' && cat.id) return false;
        if (filter.cat !== 'all' && filter.cat !== 'none' && cat.id !== filter.cat) return false;
        return !q || t.merchant.toLowerCase().includes(q) || String(t.amount).includes(q);
      }).sort((a, b) => (a.t.date < b.t.date ? 1 : a.t.date > b.t.date ? -1 : 0));
      const counted = all.filter(({ cat }) => !MB.isExcluded(td, cat.id));
      const needs = all.filter(({ cat }) => !cat.id).length;
      const sg = ctx.ui.txSuggest;
      const usedSrc = [...new Set(td.transactions.map((t) => t.sourceCategory).filter(Boolean))].sort();

      view.innerHTML = `
        ${sg ? `
        <div class="callout">
          <span>Always put <strong dir="auto">${esc(sg.name)}</strong> in <strong>${esc(MB.categoryName(td, sg.category))}</strong>?${sg.others ? ` That also updates ${sg.others} other transaction${sg.others > 1 ? 's' : ''}.` : ''}</span>
          <span class="btn-row"><button class="btn btn-small btn-primary" data-always>Always</button><button class="btn btn-small" data-dismiss>Just this one</button></span>
        </div>` : ''}

        <section class="card">
          <div class="tx-toolbar">
            <input class="text-input grow" type="search" placeholder="Search business or amount" value="${esc(filter.q)}" data-q>
            <select class="select" data-cat>
              <option value="all"${filter.cat === 'all' ? ' selected' : ''}>All categories</option>
              <option value="none"${filter.cat === 'none' ? ' selected' : ''}>Needs a category${needs ? ` (${needs})` : ''}</option>
              ${td.categories.map((c) => `<option value="${esc(c.id)}"${filter.cat === c.id ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}
            </select>
            <button class="btn btn-primary" data-import>Import statement</button>
          </div>
          <p class="hint">${all.length} transactions charged in ${Fmt.monthLabel(key)} · counted as spending <strong>${money(sum(counted.map(({ t }) => t.amount)))}</strong>${needs ? ` · <span class="negative">${needs} need a category</span>` : ''}</p>
          ${rows.length ? `
          <div class="tx-list">
            ${rows.map(({ t, cat }) => `
              <div class="tx-row${cat.id ? '' : ' needs'}" data-id="${esc(t.id)}">
                <span class="tx-date">${dayLabel(t.date)}</span>
                <span class="tx-name"><span dir="auto">${esc(Statements.displayName(t.merchant))}</span>${kindBadges(t, cards.size > 1)}</span>
                <span class="tx-cat">
                  <span class="swatch" style="background:${MB.categoryColor(td, cat.id)}"></span>
                  <select class="select" data-tx title="${cat.by === 'rule' ? 'From your rule' : cat.by === 'card' ? 'From the card company category' : cat.by === 'manual' ? 'Chosen for this transaction' : ''}">${MB.categoryOptions(td, cat.id, { none: 'Needs a category', allowNew: true })}</select>
                  ${cat.by && cat.by !== 'manual' ? `<span class="tx-by">${cat.by === 'rule' ? 'rule' : 'auto'}</span>` : ''}
                </span>
                <span class="tx-amount${t.amount < 0 ? ' refund' : ''}">${money(t.amount)}</span>
              </div>`).join('')}
          </div>` : `<p class="empty">${all.length ? 'No transactions match.' : `No card charges in ${Fmt.monthLabel(key)}.`}</p>`}
        </section>

        <section class="card">
          <details${ctx.ui.openRules ? ' open' : ''} data-rules>
            <summary class="details-summary">Saved rules (${td.rules.length})</summary>
            <p class="hint">Rules match the business name. “Name contains” catches variations, e.g. <em>wolt</em> or <em>paybox</em>.</p>
            ${td.rules.length ? `<div class="rule-list">${td.rules.map((r) => `
              <div class="rule-row" data-rule="${esc(r.id)}">
                <input class="text-input" dir="auto" data-rule-field="key" value="${esc(r.key)}" aria-label="Business name">
                <select class="select" data-rule-field="match"><option value="exact"${r.match !== 'contains' ? ' selected' : ''}>Exact name</option><option value="contains"${r.match === 'contains' ? ' selected' : ''}>Name contains</option></select>
                <select class="select" data-rule-field="category">${MB.categoryOptions(td, r.category, { none: 'Choose…' })}</select>
                <button class="icon-btn del" data-rule-delete aria-label="Delete rule">✕</button>
              </div>`).join('')}</div>` : '<p class="empty">No rules yet. Pick “Always” when you categorize a business.</p>'}
            <button class="add-btn" data-rule-add>+ Add rule</button>
          </details>
        </section>

        ${usedSrc.length ? `
        <section class="card">
          <details>
            <summary class="details-summary">Card company categories (${usedSrc.length})</summary>
            <div class="map-list">
              ${usedSrc.map((s) => `<div class="map-row"><span dir="auto">${esc(s)}</span><span aria-hidden="true">→</span>
                <select class="select" data-src="${esc(s)}">${MB.categoryOptions(td, MB.sourceCategory(td, s), { none: 'Needs a category', allowNew: true })}</select></div>`).join('')}
            </div>
          </details>
        </section>` : ''}

        ${td.imports.length ? `
        <section class="card">
          <details>
            <summary class="details-summary">Imported statements (${td.imports.length})</summary>
            <div class="import-list">${td.imports.slice().reverse().map((im) => `
              <div class="import-row"><span class="source-badge small">${esc(im.label)}</span>
                <span class="grow">${im.card ? `••${esc(im.card)} · ` : ''}${esc(im.file || '')}<br><span class="muted">${new Date(im.at).toLocaleDateString('en-GB')} · ${td.transactions.filter((t) => t.importId === im.id).length} transactions</span></span>
                <button class="btn btn-small btn-danger" data-undo="${esc(im.id)}">Remove</button></div>`).join('')}</div>
          </details>
        </section>` : ''}`;

      bind();
    }

    function bind() {
      const q = view.querySelector('[data-q]');
      q.oninput = () => {
        filter.q = q.value;
        const pos = q.selectionStart;
        draw();
        const again = view.querySelector('[data-q]');
        again.focus();
        again.setSelectionRange(pos, pos);
      };
      view.querySelector('[data-cat]').onchange = (e) => { filter.cat = e.target.value; draw(); };
      view.querySelector('[data-import]').onclick = () => { ctx.ui.panel = 'import'; ctx.ui.importState = { step: 'pick' }; ctx.rerender(); };

      view.querySelectorAll('[data-tx]').forEach((sel) => {
        sel.onchange = () => {
          const t = td.transactions.find((x) => x.id === sel.closest('[data-id]').dataset.id);
          const value = MB.resolveNewCategory(td, ctx, sel.value);
          if (sel.value === '__new' && !value) { draw(); return; }
          if (value) t.category = value; else delete t.category;
          ctx.changed();
          const k = MB.keyOf(t);
          const others = td.transactions.filter((x) => x !== t && MB.keyOf(x) === k && MB.txnCategory(td, x).id !== value).length;
          ctx.ui.txSuggest = value ? { key: k, name: Statements.displayName(t.merchant), category: value, others } : null;
          draw();
        };
      });

      const always = view.querySelector('[data-always]');
      if (always) {
        always.onclick = () => {
          const sg = ctx.ui.txSuggest;
          MB.upsertRule(td, sg.key, sg.category);
          // The rule now speaks for this business; drop one-off choices so it applies everywhere.
          td.transactions.forEach((x) => { if (MB.keyOf(x) === sg.key) delete x.category; });
          ctx.ui.txSuggest = null;
          ctx.changed();
          App.toast(`Saved: ${sg.name} → ${MB.categoryName(td, sg.category)}`);
          draw();
        };
        view.querySelector('[data-dismiss]').onclick = () => { ctx.ui.txSuggest = null; draw(); };
      }

      const rules = view.querySelector('[data-rules]');
      rules.ontoggle = () => { ctx.ui.openRules = rules.open; };
      view.querySelectorAll('[data-rule]').forEach((row) => {
        const rule = td.rules.find((r) => r.id === row.dataset.rule);
        row.querySelectorAll('[data-rule-field]').forEach((el) => {
          el.onchange = () => {
            rule[el.dataset.ruleField] = el.dataset.ruleField === 'key' ? el.value.trim().toLowerCase() : el.value;
            ctx.changed();
            draw();
          };
        });
        row.querySelector('[data-rule-delete]').onclick = () => {
          td.rules = td.rules.filter((r) => r !== rule);
          ctx.changed();
          draw();
        };
      });
      view.querySelector('[data-rule-add]').onclick = () => {
        td.rules.push({ id: Fmt.uid(), key: '', match: 'contains', category: '' });
        ctx.ui.openRules = true;
        ctx.changed();
        draw();
        const inputs = view.querySelectorAll('[data-rule-field="key"]');
        inputs[inputs.length - 1].focus();
      };

      view.querySelectorAll('[data-src]').forEach((sel) => {
        sel.onchange = () => {
          const v = MB.resolveNewCategory(td, ctx, sel.value);
          if (sel.value === '__new' && !v) { draw(); return; } // cancelled: keep the mapping
          if ((MB.DEFAULT_SOURCE_MAP[sel.dataset.src] || '') === v) delete td.sourceMap[sel.dataset.src];
          else td.sourceMap[sel.dataset.src] = v;
          ctx.changed();
          draw();
        };
      });

      view.querySelectorAll('[data-undo]').forEach((btn) => {
        btn.onclick = () => {
          const id = btn.dataset.undo;
          const n = td.transactions.filter((t) => t.importId === id).length;
          const im = td.imports.find((x) => x.id === id) || {};
          const back = im.undo ? im.undo.expenses.length : 0;
          if (!confirm(`Remove this statement and its ${n} transactions?${back ? ` The ${back} expense${back > 1 ? 's' : ''} it replaced will come back.` : ''} Your rules stay.`)) return;
          td.transactions = td.transactions.filter((t) => t.importId !== id);
          if (im.undo) {
            im.undo.targets.forEach((u) => {
              const m = td.months[u.month];
              if (m && m.targets) m.targets = m.targets.filter((t) => t.id !== u.id);
            });
            // Put back in reverse order so each recorded position is right again.
            im.undo.expenses.slice().reverse().forEach((u) => {
              const m = td.months[u.month] || (td.months[u.month] = { incomes: [], targets: [], expenses: [], allocations: [] });
              m.expenses = m.expenses || [];
              if (!m.expenses.some((e) => e.id === u.expense.id)) m.expenses.splice(Math.min(u.index, m.expenses.length), 0, u.expense);
            });
          }
          td.imports = td.imports.filter((x) => x.id !== id);
          ctx.changed();
          draw();
        };
      });
    }

    draw();
  }

  Object.assign(window.MB, { renderImport, renderTransactions });
})();
