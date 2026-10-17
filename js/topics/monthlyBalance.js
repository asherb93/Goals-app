// Topic: Monthly Balance. Net salary -> custom expenses (with categories) -> what's left -> custom leftover plan.
(function () {
  const ID = 'monthly-balance';
  const { num, money, pct, esc } = Fmt;
  const sum = (arr) => arr.reduce((a, b) => a + b, 0);

  // Color roles. Expenses vs money left use an adjacent, validated pair (orange, aqua).
  // Destinations follow orange in the salary bar, in an order validated for adjacent CVD separation.
  const EXPENSE_COLOR = 'var(--s2)';
  const LEFT_COLOR = 'var(--s3)';
  const ALLOC_COLORS = ['var(--s1)', 'var(--s6)', 'var(--s5)', 'var(--s4)', 'var(--s3)', 'var(--s7)', 'var(--s8)'];
  const DONUT_SLICES = 5; // + "Other" = 6 segments max

  const DEFAULT_CATEGORIES = [
    ['housing', 'Housing'], ['food', 'Food & groceries'], ['transport', 'Transport'],
    ['bills', 'Bills & utilities'], ['health', 'Health'], ['kids', 'Kids & family'],
    ['fun', 'Fun & dining out'], ['subs', 'Subscriptions'], ['other', 'Other'],
  ].map(([id, name]) => ({ id, name }));

  const EXPENSE_HINTS = ['Rent', 'Groceries', 'Car', 'Electricity', 'Phone', 'Netflix', 'Insurance'];
  const ALLOC_HINTS = ['Savings', 'Investments', 'Fun', 'Vacation', 'Emergency fund'];

  // ---------- Data ----------

  function topicData(ctx) {
    const d = ctx.data;
    if (ctx.isMe) {
      if (!d.months) d.months = {};
      if (!d.categories) d.categories = DEFAULT_CATEGORIES.map((c) => ({ ...c }));
    }
    return { months: d.months || {}, categories: d.categories || DEFAULT_CATEGORIES };
  }

  function blank() { return { salary: '', expenses: [], allocations: [] }; }

  function hasContent(m) {
    return !!m && (num(m.salary) > 0 || m.expenses.length > 0 || m.allocations.length > 0);
  }

  function filledMonths(months) { return Object.keys(months).filter((k) => hasContent(months[k])).sort(); }

  function categoryColor(categories, id) {
    const i = categories.findIndex((c) => c.id === id);
    return i >= 0 && i < 8 ? `var(--s${i + 1})` : 'var(--other)';
  }

  function categoryName(categories, id) {
    const c = categories.find((x) => x.id === id);
    return c ? c.name : 'Uncategorized';
  }

  function compute(m) {
    const salary = num(m.salary);
    const totalExpenses = sum(m.expenses.map((e) => num(e.amount)));
    const left = salary - totalExpenses;
    const pool = Math.max(left, 0);
    const allocs = m.allocations.map((a, i) => ({
      ...a,
      label: a.name.trim() || `Destination ${i + 1}`,
      amount: a.mode === 'percent' ? pool * num(a.value) / 100 : num(a.value),
      color: ALLOC_COLORS[i] || 'var(--other)',
    }));
    const totalAllocated = sum(allocs.map((a) => a.amount));
    return { salary, totalExpenses, left, pool, allocs, totalAllocated, unallocated: left - totalAllocated };
  }

  // Destinations past the color slots fold into one "Other" entry.
  function foldAllocs(allocs) {
    const shown = allocs.slice(0, ALLOC_COLORS.length).map((a) => ({ name: a.label, amount: a.amount, color: a.color }));
    const rest = allocs.slice(ALLOC_COLORS.length);
    if (rest.length) shown.push({ name: `Other (${rest.length})`, amount: sum(rest.map((a) => a.amount)), color: 'var(--other)' });
    return shown;
  }

  function byCategory(m, categories) {
    const totals = new Map();
    m.expenses.forEach((e) => {
      const id = categories.some((c) => c.id === e.category) ? e.category : '';
      totals.set(id, (totals.get(id) || 0) + num(e.amount));
    });
    // Keep category-list order (stable colors and ring position); gray ones fold into "Other".
    const colored = [], gray = [];
    categories.forEach((c) => {
      const amount = totals.get(c.id) || 0;
      if (amount <= 0) return;
      const item = { name: c.name, amount, color: categoryColor(categories, c.id) };
      (item.color === 'var(--other)' ? gray : colored).push(item);
    });
    if (totals.get('') > 0) gray.push({ name: 'Uncategorized', amount: totals.get(''), color: 'var(--other)' });
    const keep = new Set([...colored].sort((a, b) => b.amount - a.amount).slice(0, DONUT_SLICES));
    const shown = colored.filter((i) => keep.has(i));
    const folded = colored.filter((i) => !keep.has(i)).concat(gray);
    if (folded.length === 1) shown.push(folded[0]);
    else if (folded.length) shown.push({ name: 'Other', amount: sum(folded.map((i) => i.amount)), color: 'var(--other)' });
    return shown;
  }

  // Readable rows written to the Google Sheet next to the raw data.
  function exportRows(data) {
    const months = (data && data.months) || {};
    const categories = (data && data.categories) || DEFAULT_CATEGORIES;
    const keys = filledMonths(months);
    return {
      'Monthly Balance': {
        headers: ['Month', 'Net salary', 'Expenses', 'Left', 'Planned', 'Unallocated'],
        rows: keys.map((k) => {
          const c = compute(months[k]);
          return [k, c.salary, c.totalExpenses, c.left, round(c.totalAllocated), round(c.unallocated)];
        }),
      },
      'Expenses': {
        headers: ['Month', 'Expense', 'Category', 'Amount'],
        rows: keys.flatMap((k) => months[k].expenses.map((e) => [k, e.name, categoryName(categories, e.category), num(e.amount)])),
      },
      'Leftover Plan': {
        headers: ['Month', 'Destination', 'Type', 'Value', 'Amount'],
        rows: keys.flatMap((k) => compute(months[k]).allocs.map((a) => [k, a.label, a.mode === 'percent' ? '% of leftover' : 'Fixed', num(a.value), round(a.amount)])),
      },
    };
  }

  function round(n) { return Math.round(n * 100) / 100; }

  // ---------- Shared pieces ----------

  function monthBar(ctx) {
    const el = document.createElement('div');
    el.className = 'month-bar';
    const key = ctx.ui.month;
    const isCurrent = key === Fmt.monthKey(new Date());
    el.innerHTML = `
      <button class="icon-btn round" data-step="-1" aria-label="Previous month">‹</button>
      <h1>${Fmt.monthLabel(key)}</h1>
      <button class="icon-btn round" data-step="1" aria-label="Next month">›</button>
      ${isCurrent ? '' : '<button class="link-btn" data-today>Back to this month</button>'}`;
    el.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      ctx.ui.month = btn.hasAttribute('data-today') ? Fmt.monthKey(new Date()) : Fmt.shiftMonth(key, Number(btn.dataset.step));
      ctx.rerender();
    });
    return el;
  }

  function warning(text) {
    return `<div class="alert" role="status"><span class="alert-icon" aria-hidden="true">⚠</span><span>${esc(text)}</span></div>`;
  }

  function cardHead(icon, color, title, extra) {
    return `
      <div class="card-head">
        <h2 class="card-title"><span class="badge" style="--tint:${color}" aria-hidden="true">${icon}</span>${title}</h2>
        ${extra || ''}
      </div>`;
  }

  // ---------- Input screen ----------

  function renderInput(root, ctx) {
    const td = topicData(ctx);
    const key = ctx.ui.month;
    const m = td.months[key] || blank();
    const sym = esc(Fmt.currencySymbol());
    const prior = filledMonths(td.months).filter((k) => k < key);
    const prev = !hasContent(m) && prior.length ? prior[prior.length - 1] : null;
    let editingCategories = false;

    function persist() {
      if (hasContent(m)) td.months[key] = m;
      else delete td.months[key];
      ctx.changed();
    }

    root.append(monthBar(ctx));
    const view = document.createElement('div');
    view.className = 'stack';
    view.innerHTML = `
      ${prev ? `
      <div class="banner">
        <span>This month is empty. Start from ${Fmt.monthLabel(prev)}'s salary, expenses and plan?</span>
        <button class="btn btn-primary" data-action="copy">Copy from ${Fmt.monthLabel(prev, true)}</button>
      </div>` : ''}

      <section class="card">
        ${cardHead(sym, 'var(--s6)', '<label for="salary">Net salary</label>')}
        <p class="hint">Your take-home pay (neto) for this month.</p>
        <div class="money-field big">
          <span class="affix">${sym}</span>
          <input id="salary" type="number" inputmode="decimal" min="0" step="any" placeholder="0" value="${esc(m.salary)}">
        </div>
      </section>

      <section class="card">
        ${cardHead('↓', EXPENSE_COLOR, 'Expenses', `
          <div class="head-actions">
            <span class="muted">Total <strong id="exp-total" class="figure"></strong></span>
            <button class="btn btn-small" data-action="toggle-categories" aria-expanded="false">Edit categories</button>
          </div>`)}
        <div id="cat-editor" class="cat-editor" hidden></div>
        <div id="exp-list" class="rows"></div>
        <button class="add-btn" data-action="add-expense">+ Add expense</button>
      </section>

      <section class="result" id="left-card">
        <div>
          <div class="result-kicker">Left after expenses</div>
          <div id="left-val" class="result-value"></div>
        </div>
        <div id="left-sub" class="result-sub"></div>
      </section>

      <section class="card">
        ${cardHead('◎', 'var(--s7)', 'Leftover plan', '<span class="muted">Unallocated <strong id="unalloc" class="figure"></strong></span>')}
        <p class="hint">Decide what to do with what's left. Use a fixed amount or a % of the leftover.</p>
        <div id="alloc-list" class="rows"></div>
        <button class="add-btn" data-action="add-alloc">+ Add destination</button>
        <div id="alloc-warn"></div>
      </section>`;
    root.append(view);

    const $ = (sel) => view.querySelector(sel);

    function categoryOptions(selected) {
      return `<option value=""${selected ? '' : ' selected'}>No category</option>` + td.categories.map((c) =>
        `<option value="${esc(c.id)}"${c.id === selected ? ' selected' : ''}>${esc(c.name)}</option>`).join('');
    }

    function renderExpenses(focusId) {
      $('#exp-list').innerHTML = m.expenses.length ? m.expenses.map((e, i) => `
        <div class="row expense-row" data-kind="expense" data-id="${e.id}">
          <span class="swatch" style="background:${categoryColor(td.categories, e.category)}" aria-hidden="true"></span>
          <input class="name-input" data-field="name" aria-label="Expense name" placeholder="e.g. ${EXPENSE_HINTS[i % EXPENSE_HINTS.length]}" value="${esc(e.name)}">
          <select class="select" data-field="category" aria-label="Category">${categoryOptions(e.category)}</select>
          <div class="money-field">
            <span class="affix">${sym}</span>
            <input data-field="amount" type="number" inputmode="decimal" min="0" step="any" aria-label="Amount" placeholder="0" value="${esc(e.amount)}">
          </div>
          <button class="icon-btn del" data-action="delete" aria-label="Remove expense">✕</button>
        </div>`).join('')
        : '<p class="empty">No expenses yet. Add things like rent, groceries or bills.</p>';
      focusRow(focusId);
    }

    function renderCategoryEditor(focusId) {
      const el = $('#cat-editor');
      el.hidden = !editingCategories;
      $('[data-action="toggle-categories"]').setAttribute('aria-expanded', editingCategories);
      $('[data-action="toggle-categories"]').textContent = editingCategories ? 'Done' : 'Edit categories';
      if (!editingCategories) return;
      el.innerHTML = `
        <p class="hint">Rename, remove or add categories. The first eight get their own color.</p>
        <div class="cat-grid">
          ${td.categories.map((c) => `
            <div class="cat-item" data-cat="${esc(c.id)}">
              <span class="swatch" style="background:${categoryColor(td.categories, c.id)}"></span>
              <input class="name-input" data-cat-field="name" value="${esc(c.name)}" aria-label="Category name">
              <button class="icon-btn del" data-action="delete-category" aria-label="Remove category">✕</button>
            </div>`).join('')}
        </div>
        <button class="add-btn" data-action="add-category">+ Add category</button>`;
      if (focusId) {
        const input = el.querySelector(`[data-cat="${focusId}"] input`);
        if (input) input.focus();
      }
    }

    function renderAllocs(focusId) {
      const c = compute(m);
      $('#alloc-list').innerHTML = m.allocations.length ? c.allocs.map((a, i) => `
        <div class="row alloc-row" data-kind="alloc" data-id="${a.id}">
          <span class="swatch" style="background:${a.color}" aria-hidden="true"></span>
          <input class="name-input" data-field="name" aria-label="Destination name" placeholder="e.g. ${ALLOC_HINTS[i % ALLOC_HINTS.length]}" value="${esc(a.name)}">
          <div class="segmented" role="group" aria-label="Amount type">
            <button data-action="mode" data-mode="amount" aria-pressed="${a.mode !== 'percent'}">${sym}</button>
            <button data-action="mode" data-mode="percent" aria-pressed="${a.mode === 'percent'}">%</button>
          </div>
          <div class="money-field">
            ${a.mode === 'percent' ? '' : `<span class="affix">${sym}</span>`}
            <input data-field="value" type="number" inputmode="decimal" min="0" step="any" aria-label="${a.mode === 'percent' ? 'Percent of leftover' : 'Amount'}" placeholder="0" value="${esc(a.value)}">
            ${a.mode === 'percent' ? '<span class="affix">%</span>' : ''}
          </div>
          <span class="computed figure" data-computed></span>
          <button class="icon-btn del" data-action="delete" aria-label="Remove destination">✕</button>
        </div>`).join('')
        : '<p class="empty">Nothing planned yet. Add savings, investments, fun money…</p>';
      focusRow(focusId);
    }

    function focusRow(id) {
      if (!id) return;
      const input = view.querySelector(`[data-id="${id}"] .name-input`);
      if (input) input.focus();
    }

    function updateTotals() {
      const c = compute(m);
      $('#exp-total').textContent = money(c.totalExpenses);
      $('#left-val').textContent = money(c.left);
      $('#left-card').classList.toggle('bad', c.left < 0);
      $('#left-sub').innerHTML = c.left < 0
        ? `<span aria-hidden="true">⚠ </span>Expenses are ${esc(money(-c.left))} more than your salary.`
        : c.salary > 0 ? `${pct(c.left / c.salary)} of your salary` : 'Enter your salary to get started';

      const un = $('#unalloc');
      un.textContent = money(c.unallocated);
      un.classList.toggle('negative', c.unallocated < -0.005);

      view.querySelectorAll('.alloc-row').forEach((row, i) => {
        const a = c.allocs[i];
        row.querySelector('[data-computed]').textContent = a.mode === 'percent' ? '= ' + money(a.amount) : '';
      });

      let warn = '';
      if (m.allocations.length && c.left <= 0) warn = warning('There is nothing left to allocate this month.');
      else if (c.unallocated < -0.005) warn = warning(`Your plan is ${money(-c.unallocated)} more than what's left.`);
      $('#alloc-warn').innerHTML = warn;
    }

    function findItem(row) {
      const list = row.dataset.kind === 'expense' ? m.expenses : m.allocations;
      return { list, item: list.find((x) => x.id === row.dataset.id) };
    }

    function onEdit(e) {
      const t = e.target;
      if (t.id === 'salary') {
        m.salary = t.value === '' ? '' : num(t.value);
      } else if (t.dataset.catField) {
        const cat = td.categories.find((c) => c.id === t.closest('[data-cat]').dataset.cat);
        cat.name = t.value;
        ctx.changed();
        if (e.type === 'change') renderExpenses();
        return;
      } else {
        const row = t.closest('.row');
        if (!row || !t.dataset.field) return;
        const { item } = findItem(row);
        const f = t.dataset.field;
        item[f] = f === 'name' || f === 'category' ? t.value : (t.value === '' ? '' : num(t.value));
        if (f === 'category') row.querySelector('.swatch').style.background = categoryColor(td.categories, t.value);
      }
      persist();
      updateTotals();
    }

    view.addEventListener('input', onEdit);
    view.addEventListener('change', (e) => { if (e.target.dataset.catField) onEdit(e); });

    view.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;

      if (action === 'copy') {
        const copy = JSON.parse(JSON.stringify(td.months[prev]));
        copy.expenses.forEach((x) => { x.id = Fmt.uid(); });
        copy.allocations.forEach((x) => { x.id = Fmt.uid(); });
        td.months[key] = copy;
        ctx.changed();
        ctx.rerender();
        return;
      }
      if (action === 'toggle-categories') {
        editingCategories = !editingCategories;
        renderCategoryEditor();
        if (!editingCategories) renderExpenses();
        return;
      }
      if (action === 'add-category') {
        const id = Fmt.uid();
        td.categories.push({ id, name: 'New category' });
        ctx.changed();
        renderCategoryEditor(id);
        renderExpenses();
        return;
      }
      if (action === 'delete-category') {
        const id = btn.closest('[data-cat]').dataset.cat;
        const used = Object.values(td.months).some((mm) => mm.expenses.some((x) => x.category === id));
        if (used && !confirm('Expenses in this category will become "No category". Remove it?')) return;
        td.categories.splice(td.categories.findIndex((c) => c.id === id), 1);
        Object.values(td.months).forEach((mm) => mm.expenses.forEach((x) => { if (x.category === id) x.category = ''; }));
        ctx.changed();
        renderCategoryEditor();
        renderExpenses();
        return;
      }
      if (action === 'add-expense') {
        const id = Fmt.uid();
        m.expenses.push({ id, name: '', category: '', amount: '' });
        renderExpenses(id);
      } else if (action === 'add-alloc') {
        const id = Fmt.uid();
        m.allocations.push({ id, name: '', mode: 'amount', value: '' });
        renderAllocs(id);
      } else {
        const row = btn.closest('.row');
        if (!row) return;
        const { list, item } = findItem(row);
        if (action === 'delete') {
          list.splice(list.indexOf(item), 1);
          row.dataset.kind === 'expense' ? renderExpenses() : renderAllocs();
        } else if (action === 'mode' && item.mode !== btn.dataset.mode) {
          // Convert so the amount stays the same when switching between fixed and %.
          const pool = compute(m).pool;
          const v = num(item.value);
          if (item.value !== '') {
            item.value = btn.dataset.mode === 'percent'
              ? (pool > 0 ? Math.round(v / pool * 10000) / 100 : 0)
              : Math.round(pool * v) / 100;
          }
          item.mode = btn.dataset.mode;
          renderAllocs();
        }
      }
      persist();
      updateTotals();
    });

    renderExpenses();
    renderAllocs();
    updateTotals();
  }

  // ---------- Dashboard ----------

  function kpi(icon, color, label, value, sub, bad) {
    return `
      <div class="kpi" style="--tint:${color}">
        <span class="badge" aria-hidden="true">${icon}</span>
        <div>
          <div class="kpi-label">${label}</div>
          <div class="kpi-value${bad ? ' negative' : ''}">${bad ? '<span aria-hidden="true">⚠ </span>' : ''}${esc(value)}</div>
          <div class="kpi-sub">${sub}</div>
        </div>
      </div>`;
  }

  function hero(ctx, c) {
    const month = Fmt.monthName(ctx.ui.month);
    const whose = ctx.isMe ? '' : `${esc(ctx.owner.name)}'s `;
    const spent = c.salary > 0 ? Math.min(c.totalExpenses / c.salary, 1) : 0;
    const planned = c.pool > 0 ? Math.min(c.totalAllocated / c.pool, 1) : 0;
    return `
      <section class="hero${c.left < 0 ? ' bad' : ''}">
        <div class="hero-main">
          <div class="hero-kicker">${whose}${ctx.isMe ? 'Money' : 'money'} left in ${month}</div>
          <div class="hero-value">${c.left < 0 ? '<span aria-hidden="true">⚠ </span>' : ''}${esc(money(c.left))}</div>
          <div class="hero-sub">${c.left < 0
            ? `Expenses are ${esc(money(-c.left))} over the salary`
            : c.salary > 0 ? `${pct(c.left / c.salary)} of ${esc(money(c.salary))} net salary` : 'No salary entered'}</div>
        </div>
        <div class="hero-meters">
          <div class="meter-row"><span>Spent of salary</span><strong>${c.salary > 0 ? pct(c.totalExpenses / c.salary) : '–'}</strong></div>
          <div class="meter"><span style="width:${spent * 100}%"></span></div>
          <div class="meter-row"><span>Leftover planned</span><strong>${c.pool > 0 ? pct(c.totalAllocated / c.pool) : '–'}</strong></div>
          <div class="meter"><span style="width:${planned * 100}%"></span></div>
        </div>
      </section>`;
  }

  function expensesVsLeft(months, selectedKey) {
    const keys = filledMonths(months).slice(-12);
    const points = keys.map((k) => {
      const c = compute(months[k]);
      const over = c.left < 0;
      return {
        label: Fmt.monthLabel(k, true),
        selected: k === selectedKey,
        segments: [
          { name: 'Expenses', value: c.totalExpenses, color: EXPENSE_COLOR },
          { name: 'Money left', value: Math.max(c.left, 0), color: LEFT_COLOR },
        ],
        marker: over ? c.salary : 0,
        note: k === selectedKey ? (over ? '⚠ Over' : Fmt.compactMoney(c.left) + ' left') : '',
        tip: Fmt.monthLabel(k),
        tipSub: `Expenses ${money(c.totalExpenses)} · Left ${money(c.left)} · Salary ${money(c.salary)}`,
      };
    });
    const anyOver = points.some((p) => p.marker);
    return Charts.columns(points, {
      legendItems: [
        { name: 'Expenses', color: EXPENSE_COLOR },
        { name: 'Money left', color: LEFT_COLOR },
        ...(anyOver ? [{ name: 'Salary (when overspent)', color: 'var(--ink)', dashed: true }] : []),
      ],
      ariaLabel: 'Expenses and money left, by month',
      tableHeaders: ['Month', 'Salary', 'Expenses', 'Money left'],
      tableRows: keys.map((k) => {
        const c = compute(months[k]);
        return [Fmt.monthLabel(k), money(c.salary), money(c.totalExpenses), money(c.left)];
      }),
    });
  }

  function renderDashboard(root, ctx) {
    const td = topicData(ctx);
    const key = ctx.ui.month;
    const m = td.months[key];
    root.append(monthBar(ctx));
    const view = document.createElement('div');
    view.className = 'stack';
    root.append(view);

    const trend = filledMonths(td.months).length ? `
      <section class="card">
        ${cardHead('▥', LEFT_COLOR, 'Expenses vs money left')}
        ${expensesVsLeft(td.months, key)}
      </section>` : '';

    if (!hasContent(m)) {
      view.innerHTML = `
        <section class="card empty-state">
          <div class="empty-illustration" aria-hidden="true">₪</div>
          <p>${ctx.isMe ? 'No numbers' : `${esc(ctx.owner.name)} hasn't added numbers`} for ${Fmt.monthLabel(key)} yet.</p>
          ${ctx.isMe ? `<a class="btn btn-primary" href="#/${ID}/input">Enter this month's numbers</a>` : ''}
        </section>${trend}`;
      return;
    }

    const c = compute(m);
    const share = (v) => (c.salary > 0 ? pct(v / c.salary) + ' of salary' : '&nbsp;');
    const categories = byCategory(m, td.categories);
    const alerts = [];
    if (c.left >= 0 && c.unallocated < -0.005) alerts.push(warning(`The leftover plan is ${money(-c.unallocated)} more than what's left.`));

    view.innerHTML = `
      ${hero(ctx, c)}
      <div class="kpi-row">
        ${kpi(esc(Fmt.currencySymbol()), 'var(--s6)', 'Net salary', money(c.salary), 'This month')}
        ${kpi('↓', EXPENSE_COLOR, 'Expenses', money(c.totalExpenses), share(c.totalExpenses))}
        ${kpi('◎', 'var(--s7)', 'Planned', money(c.totalAllocated), c.pool > 0 ? pct(c.totalAllocated / c.pool) + ' of leftover' : 'Nothing left to plan')}
        ${c.left < 0
          ? kpi('✦', 'var(--s1)', 'Unallocated', money(0), 'Nothing left to plan')
          : kpi('✦', 'var(--s1)', 'Unallocated', money(c.unallocated), c.unallocated < -0.005 ? 'Over-planned' : (c.pool > 0 ? pct(Math.max(c.unallocated, 0) / c.pool) + ' of leftover' : '&nbsp;'), c.unallocated < -0.005)}
      </div>
      ${alerts.join('')}

      <section class="card">
        ${cardHead('▤', 'var(--s1)', 'Where the salary goes')}
        ${Charts.stackBar([
          { name: 'Expenses', amount: c.totalExpenses, color: EXPENSE_COLOR },
          ...foldAllocs(c.allocs),
          { name: 'Unallocated', amount: Math.max(c.unallocated, 0), color: 'var(--neutral)' },
        ], { base: c.salary, baseLabel: 'salary', markerLabel: 'Salary' }) || '<p class="empty">Add your salary and expenses to see where your money goes.</p>'}
      </section>

      <div class="two-col">
        <section class="card">
          ${cardHead('◔', EXPENSE_COLOR, 'Expenses by category')}
          ${Charts.donut(categories, { centerLabel: 'total expenses', empty: 'No expenses entered.' })}
        </section>
        <section class="card">
          ${cardHead('◎', 'var(--s7)', 'Leftover plan')}
          ${Charts.barList([...foldAllocs(c.allocs), { name: 'Unallocated', amount: Math.max(c.unallocated, 0), color: 'var(--neutral)' }],
            { basis: c.pool, basisLabel: 'leftover', empty: c.left > 0 ? 'No plan for the leftover yet.' : 'Nothing left to plan this month.' })}
        </section>
      </div>

      ${trend}

      <section class="card">
        ${cardHead('↓', EXPENSE_COLOR, 'All expenses')}
        ${Charts.barList(m.expenses.map((e, i) => ({
          name: e.name.trim() || `Expense ${i + 1}`,
          amount: num(e.amount),
          color: categoryColor(td.categories, e.category),
          tag: categoryName(td.categories, e.category),
        })), { basis: c.salary, basisLabel: 'salary', empty: 'No expenses entered.' })}
      </section>`;
  }

  App.register({ id: ID, title: 'Monthly Balance', icon: '₪', renderInput, renderDashboard, exportRows });
})();
