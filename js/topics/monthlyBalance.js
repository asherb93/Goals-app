// Topic: Monthly Balance. Income (net salary and any other sources) -> target expenses (the plan)
// -> actual expenses (entered by hand as direct or card, plus imported card statements) -> what's left
// -> leftover plan.
//
// Targets never count as spending; the dashboard compares them with actual spending by category.
// Expenses entered by hand are actual: "direct" (rent, bank transfer, cash) or "card" (card purchases
// that aren't in an imported statement). Imported card purchases count in the month they're charged.
// Shared helpers live on window.MB so the import/transactions screens (monthlyBalanceCards.js) can use them.
(function () {
  const ID = 'monthly-balance';
  const { num, money, pct, esc } = Fmt;
  const sum = (arr) => arr.reduce((a, b) => a + b, 0);

  // Color roles. Expenses vs money left use an adjacent, validated pair (orange, aqua).
  // Destinations follow orange in the income bar, in an order validated for adjacent CVD separation.
  const EXPENSE_COLOR = 'var(--s2)';
  const LEFT_COLOR = 'var(--s3)';
  const ALLOC_COLORS = ['var(--s1)', 'var(--s6)', 'var(--s5)', 'var(--s4)', 'var(--s3)', 'var(--s7)', 'var(--s8)'];
  const DONUT_SLICES = 5; // + "Other" = 6 segments max

  // The first eight get colors, so the usual big spenders come first.
  const DEFAULT_CATEGORIES = [
    ['housing', 'Housing'], ['food', 'Food & groceries'], ['transport', 'Transport'], ['fun', 'Fun & dining out'],
    ['shopping', 'Shopping'], ['bills', 'Bills & utilities'], ['health', 'Health'], ['travel', 'Travel'],
    ['insurance', 'Insurance'], ['kids', 'Kids & family'], ['subs', 'Subscriptions'], ['transfers', 'Transfers', true], ['other', 'Other'],
  ].map(([id, name, excluded]) => (excluded ? { id, name, excluded } : { id, name }));

  // Card-company categories (MAX) -> ours. People can change these; overrides live in topic data.
  const DEFAULT_SOURCE_MAP = {
    'מזון וצריכה': 'food', 'מסעדות, קפה וברים': 'fun', 'דלק, חשמל וגז': 'transport', 'תחבורה ורכבים': 'transport',
    'ביטוח': 'insurance', 'רפואה ובתי מרקחת': 'health', 'קוסמטיקה וטיפוח': 'shopping', 'פנאי, בידור וספורט': 'fun',
    'העברת כספים': 'transfers', 'אופנה': 'shopping', 'עיצוב הבית': 'shopping', 'טיסות ותיירות': 'travel',
    'שירותי תקשורת': 'bills', 'חשמל ומחשבים': 'shopping', 'עירייה וממשלה': 'bills', 'ספרים ודפוס': 'shopping',
    'ילדים': 'kids', 'חינוך': 'kids', 'בריאות': 'health', 'שונות': 'other',
  };

  const INCOME_HINTS = ['Net salary', 'Freelance', 'Rental income', 'Child allowance', 'Bonus'];
  const TARGET_HINTS = ['Groceries', 'Eating out', 'Shopping', 'Fuel', 'Kids'];
  const DIRECT_HINTS = ['Rent', 'Electricity', 'Arnona', 'Kindergarten', 'Cash'];
  const CARD_HINTS = ['Groceries', 'Fuel', 'Pharmacy', 'Clothes', 'Restaurant'];
  const ALLOC_HINTS = ['Savings', 'Investments', 'Fun', 'Vacation', 'Emergency fund'];

  // ---------- Data ----------

  // Version 2 of the category list adds Shopping/Travel/Insurance/Transfers and reorders defaults.
  function migratedCategories(list) {
    const byId = new Map((list || []).map((c) => [c.id, c]));
    const defaults = DEFAULT_CATEGORIES.map((c) => ({ ...c, ...(byId.get(c.id) || {}) }));
    const custom = (list || []).filter((c) => !DEFAULT_CATEGORIES.some((d) => d.id === c.id));
    return defaults.concat(custom);
  }

  const MODEL_VERSION = 4;

  // Model version 3 splits the old single expense list into targets (the plan) and expenses (actual).
  // Before, lines resolved to "card" were budgets and "direct" lines counted as spending. In a month
  // that was a plan (statements imported, or any card line), every old line becomes a target; the
  // direct lines always stay as monthly expenses, so actual spending is unchanged.
  function splitTargets(td) {
    const usedCards = td.transactions.length > 0;
    Object.entries(td.months).forEach(([key, m]) => {
      if (Array.isArray(m.targets)) return;
      const cardCats = new Set(usedCards
        ? td.transactions.filter((t) => t.month === key).map((t) => txnCategory(td, t).id).filter((id) => id && !isExcluded(td, id))
        : []);
      const lines = (m.expenses || []).map((e) => ({
        id: e.id || Fmt.uid(), name: e.name || '', category: e.category || '', amount: e.amount,
        paid: e.paidBy || (usedCards && e.category && cardCats.has(e.category) ? 'card' : 'direct'),
        guessed: !e.paidBy,
      }));
      // A card line was only ever a budget, so a month with one was a plan; keep it as targets so nothing
      // is lost. Lines in "not spending" categories make no sense as targets.
      const wasPlan = usedCards || lines.some((l) => l.paid === 'card');
      m.targets = wasPlan
        ? lines.filter((l) => !isExcluded(td, l.category)).map((l) => ({ id: Fmt.uid(), name: l.name, category: l.category, amount: l.amount }))
        : [];
      // `guessed`: v2 would have turned this line into a card budget once a statement had purchases in
      // its category. The import step offers to do the same (move it to targets).
      m.expenses = lines.filter((l) => l.paid === 'direct').map((l) => ({
        id: l.id, name: l.name, category: l.category, amount: l.amount, method: 'direct', repeat: true, ...(l.guessed ? { guessed: true } : {}),
      }));
      if (!m.allocations) m.allocations = [];
    });
  }

  // Model version 4 replaces the single `salary` number with a list of income sources.
  function salaryToIncomes(td) {
    Object.values(td.months).forEach((m) => {
      if (Array.isArray(m.incomes)) return;
      m.incomes = num(m.salary) > 0 ? [{ id: Fmt.uid(), name: 'Net salary', amount: m.salary, repeat: true }] : [];
      delete m.salary;
    });
  }

  function migrateMonths(td, from) {
    if (from < 3) splitTargets(td);
    if (from < 4) salaryToIncomes(td);
  }

  function topicData(ctx) {
    const d = ctx.data;
    if (ctx.isMe) {
      if (!d.months) d.months = {};
      if (!d.categories || d.catsVersion !== 2) { d.categories = migratedCategories(d.categories); d.catsVersion = 2; }
      if (!d.transactions) d.transactions = [];
      if (!d.rules) d.rules = [];
      if (!d.sourceMap) d.sourceMap = {};
      if (!d.imports) d.imports = [];
      if (!d.templates) d.templates = [];
      if ((d.modelVersion || 0) < MODEL_VERSION) { migrateMonths(d, d.modelVersion || 0); d.modelVersion = MODEL_VERSION; }
      return d;
    }
    // Someone else's (read-only) data: never mutate it; migrate a copy if it's from an older version.
    const td = {
      months: d.months || {},
      categories: d.catsVersion === 2 ? d.categories : migratedCategories(d.categories),
      transactions: d.transactions || [],
      rules: d.rules || [],
      sourceMap: d.sourceMap || {},
      imports: d.imports || [],
      templates: d.templates || [],
    };
    if ((d.modelVersion || 0) < MODEL_VERSION) {
      td.months = JSON.parse(JSON.stringify(td.months));
      migrateMonths(td, d.modelVersion || 0);
    }
    return td;
  }

  function blank() { return { incomes: [], targets: [], expenses: [], allocations: [] }; }

  function incomeTotal(m) { return sum((m.incomes || []).map((x) => num(x.amount))); }

  function hasContent(m) {
    return !!m && (incomeTotal(m) > 0 || (m.targets || []).length > 0 || (m.expenses || []).length > 0 || (m.allocations || []).length > 0);
  }

  // Months with typed-in numbers or charged card transactions.
  function monthKeys(td) {
    const keys = new Set(Object.keys(td.months).filter((k) => hasContent(td.months[k])));
    td.transactions.forEach((t) => keys.add(t.month));
    return [...keys].sort();
  }

  function categoryColor(td, id) {
    const i = td.categories.findIndex((c) => c.id === id);
    return i >= 0 && i < 8 ? `var(--s${i + 1})` : 'var(--other)';
  }

  function categoryName(td, id) {
    const c = td.categories.find((x) => x.id === id);
    return c ? c.name : 'Needs a category';
  }

  function isExcluded(td, id) {
    const c = td.categories.find((x) => x.id === id);
    return !!(c && c.excluded);
  }

  const known = (td, id) => !!id && td.categories.some((c) => c.id === id);

  // ---------- Card transaction categories ----------
  // Order: a choice made for this one transaction, then your rules, then the card company's category.

  const keyCache = new Map();
  function keyOf(t) {
    if (!keyCache.has(t.merchant)) keyCache.set(t.merchant, Statements.merchantKey(t.merchant));
    return keyCache.get(t.merchant);
  }

  function ruleFor(td, key) {
    const exact = td.rules.find((r) => r.match !== 'contains' && r.key === key);
    if (exact) return exact;
    return td.rules
      .filter((r) => r.match === 'contains' && r.key && key.includes(r.key.toLowerCase()))
      .sort((a, b) => b.key.length - a.key.length)[0] || null;
  }

  function sourceCategory(td, name, pending) {
    if (!name) return '';
    if (pending && name in pending) return pending[name];
    if (name in td.sourceMap) return td.sourceMap[name];
    return DEFAULT_SOURCE_MAP[name] || '';
  }

  // -> { id, by: 'manual' | 'rule' | 'card' | '' }
  function txnCategory(td, t, pending) {
    if (known(td, t.category)) return { id: t.category, by: 'manual' };
    const rule = ruleFor(td, keyOf(t));
    if (rule && known(td, rule.category)) return { id: rule.category, by: 'rule' };
    const src = sourceCategory(td, t.sourceCategory, pending);
    if (known(td, src)) return { id: src, by: 'card' };
    return { id: '', by: '' };
  }

  function upsertRule(td, key, category) {
    const existing = td.rules.find((r) => r.match !== 'contains' && r.key === key);
    if (existing) existing.category = category;
    else td.rules.push({ id: Fmt.uid(), key, match: 'exact', category });
  }

  // ---------- Month math ----------

  // The numbers for any set of incomes, targets, hand-entered lines and imported purchases. Shared by
  // a single month (compute) and by weeks and years (computePeriod), so every view adds up the same way.
  function tally(td, incomes, targets, lines, txns) {
    const income = sum(incomes.map((x) => x.amount));
    // Targets in "not spending" categories can never be met, so they don't count.
    const countedTargets = targets.filter((t) => t.counted && t.amount > 0);
    const targetTotal = sum(countedTargets.map((t) => t.amount));
    const counted = txns.filter((t) => !isExcluded(td, t.cat));
    const countedLines = lines.filter((l) => l.counted);
    const direct = sum(countedLines.filter((l) => l.method === 'direct').map((l) => l.amount));
    const manualCard = sum(countedLines.filter((l) => l.method === 'card').map((l) => l.amount));
    const importedCard = sum(counted.map((t) => t.amount));
    const card = manualCard + importedCard;
    const totalExpenses = direct + card;
    const byCategory = new Map();
    const addCat = (id, v) => byCategory.set(id, (byCategory.get(id) || 0) + v);
    countedLines.forEach((l) => addCat(known(td, l.category) ? l.category : '', l.amount));
    counted.forEach((t) => addCat(t.cat, t.amount));
    // A target is compared with spending in its own category; targets without a category can't be.
    const targetedIds = new Set(countedTargets.filter((t) => known(td, t.category)).map((t) => t.category));
    const targetedTarget = sum(countedTargets.filter((t) => targetedIds.has(t.category)).map((t) => t.amount));
    const targetedSpent = sum([...targetedIds].map((id) => byCategory.get(id) || 0));
    const left = income - totalExpenses;
    return {
      incomes, income, targets, countedTargets, targetTotal, hasTargets: targetTotal > 0,
      targetedTarget, targetedSpent, untargetedSpent: totalExpenses - targetedSpent,
      overTarget: targetedTarget > 0 && targetedSpent > targetedTarget + 0.005,
      uncategorizedTargets: countedTargets.filter((t) => !known(td, t.category)),
      lines, countedLines, byCategory, direct, manualCard, importedCard, card,
      txns, counted, hasCard: txns.length > 0, needsCategory: txns.filter((t) => !t.cat).length,
      totalExpenses, left, pool: Math.max(left, 0),
    };
  }

  function withAllocs(base, allocs) {
    const totalAllocated = sum(allocs.map((a) => a.amount));
    return { ...base, allocs, totalAllocated, unallocated: base.left - totalAllocated };
  }

  function compute(td, key, m) {
    m = m || td.months[key] || blank();
    const incomes = (m.incomes || []).map((x, i) => ({
      ...x, label: String(x.name || '').trim() || `Income ${i + 1}`, amount: num(x.amount),
    }));
    const targets = (m.targets || []).map((t, i) => ({
      ...t,
      label: String(t.name || '').trim() || (known(td, t.category) ? categoryName(td, t.category) : `Target ${i + 1}`),
      amount: num(t.amount),
      counted: !isExcluded(td, t.category),
    }));
    const lines = (m.expenses || []).map((e, i) => ({
      ...e,
      label: String(e.name || '').trim() || `Expense ${i + 1}`,
      amount: num(e.amount),
      method: e.method === 'card' ? 'card' : 'direct',
      counted: !isExcluded(td, e.category),
    }));
    const txns = td.transactions.filter((t) => t.month === key).map((t) => ({ ...t, cat: txnCategory(td, t).id }));
    const base = tally(td, incomes, targets, lines, txns);
    const allocs = (m.allocations || []).map((a, i) => ({
      ...a,
      label: String(a.name || '').trim() || `Destination ${i + 1}`,
      amount: a.mode === 'percent' ? base.pool * num(a.value) / 100 : num(a.value),
      color: ALLOC_COLORS[i] || 'var(--other)',
    }));
    return { m, ...withAllocs(base, allocs) };
  }

  // ---------- Weeks and years ----------
  // Data is entered per month. A year adds up its months. A week takes each month's income, targets,
  // hand-entered expenses and plan in proportion to its days in that month, and imported card purchases
  // by their purchase date (the day the money was actually spent).

  const pad2 = (n) => String(n).padStart(2, '0');
  const isoDay = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const dayOf = (iso) => { const [y, mo, d] = iso.split('-').map(Number); return new Date(y, mo - 1, d); };
  const daysIn = (key) => { const [y, mo] = key.split('-').map(Number); return new Date(y, mo, 0).getDate(); };
  const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // Weeks start on Sunday, as in Israel.
  function weekStart(date) {
    const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    d.setDate(d.getDate() - d.getDay());
    return d;
  }

  function makePeriod(kind, anchor) {
    if (kind === 'year') {
      const y = Number(String(anchor).slice(0, 4));
      return {
        kind, id: String(y), label: String(y), short: String(y), inLabel: `in ${y}`,
        parts: Array.from({ length: 12 }, (_, i) => ({ key: `${y}-${pad2(i + 1)}`, w: 1 })),
      };
    }
    if (kind === 'week') {
      const start = weekStart(dayOf(anchor));
      const days = Array.from({ length: 7 }, (_, i) => { const d = new Date(start); d.setDate(d.getDate() + i); return d; });
      const counts = {};
      days.forEach((d) => { const k = isoDay(d).slice(0, 7); counts[k] = (counts[k] || 0) + 1; });
      const a = days[0], b = days[6];
      const label = a.getMonth() === b.getMonth()
        ? `${a.getDate()}–${b.getDate()} ${SHORT_MONTHS[a.getMonth()]} ${b.getFullYear()}`
        : `${a.getDate()} ${SHORT_MONTHS[a.getMonth()]} – ${b.getDate()} ${SHORT_MONTHS[b.getMonth()]} ${b.getFullYear()}`;
      return {
        kind, id: isoDay(a), label, short: `${a.getDate()} ${SHORT_MONTHS[a.getMonth()]}`, inLabel: `${a.getDate()}–${b.getDate()} ${SHORT_MONTHS[b.getMonth()]}`,
        start: isoDay(a), end: isoDay(b),
        parts: Object.keys(counts).sort().map((k) => ({ key: k, w: counts[k] / daysIn(k) })),
      };
    }
    const key = String(anchor).slice(0, 7);
    return { kind: 'month', id: key, label: Fmt.monthLabel(key), short: Fmt.monthLabel(key, true), inLabel: `in ${Fmt.monthName(key)}`, parts: [{ key, w: 1 }] };
  }

  function shiftPeriod(p, n) {
    if (p.kind === 'year') return makePeriod('year', Number(p.id) + n);
    if (p.kind === 'week') { const d = dayOf(p.id); d.setDate(d.getDate() + 7 * n); return makePeriod('week', isoDay(d)); }
    return makePeriod('month', Fmt.shiftMonth(p.id, n));
  }

  // Rows with the same name (and kind) are combined; amounts are scaled by each month's weight.
  function mergeScaled(lists, identity) {
    const out = new Map();
    lists.forEach(({ rows, w }) => rows.forEach((x) => {
      const k = identity(x);
      const cur = out.get(k);
      if (cur) cur.amount += x.amount * w;
      else out.set(k, { ...x, amount: x.amount * w });
    }));
    return [...out.values()];
  }

  function computePeriod(td, p) {
    if (p.kind === 'month') return { ...compute(td, p.id), period: p };
    const cs = p.parts.map((x) => ({ c: compute(td, x.key), w: x.w }));
    const pick = (field) => cs.map(({ c, w }) => ({ rows: c[field], w }));
    const lower = (v) => String(v || '').toLowerCase();
    const incomes = mergeScaled(pick('incomes'), (x) => lower(x.label));
    const targets = mergeScaled(pick('targets'), (t) => `${lower(t.label)}|${t.category || ''}`);
    const lines = mergeScaled(pick('lines'), (l) => `${lower(l.label)}|${l.method}|${l.category || ''}`);
    const txns = p.kind === 'week'
      ? td.transactions.filter((t) => t.date >= p.start && t.date <= p.end).map((t) => ({ ...t, cat: txnCategory(td, t).id }))
      : cs.flatMap(({ c }) => c.txns);
    const allocs = mergeScaled(pick('allocs'), (a) => lower(a.label));
    return { m: null, ...withAllocs(tally(td, incomes, targets, lines, txns), allocs), period: p };
  }

  // Has anything been entered or imported for this period?
  function periodHasData(td, p, c) {
    if (p.kind === 'month') return hasContent(c.m) || c.hasCard;
    return p.parts.some((x) => hasContent(td.months[x.key])) || c.hasCard;
  }

  // Actual spending per category: expenses entered by hand + counted imported card purchases.
  function actualByCategory(td, c) { return c.byCategory; }

  // The '' bucket: uncategorized card purchases need a category; uncategorized typed lines just have none.
  function uncategorizedLabel(c) { return c.counted.some((t) => !t.cat) ? 'Needs a category' : 'No category'; }

  // Destinations past the color slots fold into one "Other" entry.
  function foldAllocs(allocs) {
    const shown = allocs.slice(0, ALLOC_COLORS.length).map((a) => ({ name: a.label, amount: a.amount, color: a.color }));
    const rest = allocs.slice(ALLOC_COLORS.length);
    if (rest.length) shown.push({ name: `Other (${rest.length})`, amount: sum(rest.map((a) => a.amount)), color: 'var(--other)' });
    return shown;
  }

  function donutItems(td, c) {
    const totals = actualByCategory(td, c);
    // Keep category-list order (stable colors and ring position); gray ones fold into "Other".
    const colored = [], gray = [];
    td.categories.forEach((cat) => {
      const amount = totals.get(cat.id) || 0;
      if (amount <= 0) return;
      const item = { name: cat.name, amount, color: categoryColor(td, cat.id) };
      (item.color === 'var(--other)' ? gray : colored).push(item);
    });
    // Uncategorized spending stays its own (lighter gray) slice: it's something to act on.
    const needs = totals.get('') > 0 ? { name: uncategorizedLabel(c), amount: totals.get(''), color: 'var(--neutral)' } : null;
    const keep = new Set([...colored].sort((a, b) => b.amount - a.amount).slice(0, DONUT_SLICES - (needs ? 1 : 0)));
    const shown = colored.filter((i) => keep.has(i));
    const folded = colored.filter((i) => !keep.has(i)).concat(gray);
    if (folded.length === 1) shown.push(folded[0]);
    else if (folded.length) shown.push({ name: 'Other', amount: sum(folded.map((i) => i.amount)), color: 'var(--other)' });
    if (needs) shown.push(needs);
    return shown;
  }

  // Categories where refunds outweigh purchases can't be a slice; say so, so the donut adds up.
  function refundNote(td, c) {
    const neg = [...c.byCategory.entries()].filter(([, v]) => v < -0.005);
    if (!neg.length) return '';
    const total = -sum(neg.map(([, v]) => v));
    const names = neg.map(([id]) => (id ? categoryName(td, id) : uncategorizedLabel(c))).join(', ');
    return `<p class="hint">Refunds of ${esc(money(total))} (${esc(names)}) aren't shown; net spending is ${esc(money(c.totalExpenses))}.</p>`;
  }

  // Readable rows written to the Google Sheet next to the raw data.
  function exportRows(data) {
    const td = topicData({ data: data || {}, isMe: false });
    const keys = monthKeys(td);
    const r2 = (n) => Math.round(n * 100) / 100;
    const catName = (id) => (known(td, id) ? categoryName(td, id) : 'No category');
    return {
      'Monthly Balance': {
        headers: ['Month', 'Income', 'Target', 'Actual expenses', 'Direct', 'Card', 'Left', 'Planned leftover', 'Unallocated'],
        rows: keys.map((k) => {
          const c = compute(td, k);
          return [k, r2(c.income), r2(c.targetTotal), r2(c.totalExpenses), r2(c.direct), r2(c.card), r2(c.left), r2(c.totalAllocated), r2(c.unallocated)];
        }),
      },
      'Income': {
        headers: ['Month', 'Source', 'Monthly', 'Amount'],
        rows: keys.flatMap((k) => compute(td, k).incomes.filter((x) => x.amount).map((x) => [k, x.label, x.repeat ? 'Yes' : '', x.amount])),
      },
      'Targets': {
        headers: ['Month', 'Target', 'Category', 'Amount'],
        rows: keys.flatMap((k) => compute(td, k).targets.map((t) => [k, t.label, catName(t.category), t.amount])),
      },
      'Expenses': {
        headers: ['Month', 'Expense', 'Category', 'Paid by', 'Monthly', 'Amount'],
        rows: keys.flatMap((k) => compute(td, k).lines.map((l) => [
          k, l.label, catName(l.category), l.method === 'card' ? 'Card' : 'Direct', l.repeat ? 'Yes' : '', l.amount,
        ])),
      },
      'Transactions': {
        headers: ['Month', 'Date', 'Charge date', 'Business', 'Category', 'Amount', 'Card', 'Type', 'Original amount', 'Source'],
        rows: td.transactions.slice().sort((a, b) => (a.date < b.date ? -1 : 1)).map((t) => [
          t.month, t.date, t.chargeDate, Statements.displayName(t.merchant), categoryName(td, txnCategory(td, t).id), t.amount,
          t.card, t.kind + (t.installment ? ' ' + t.installment : ''), t.original || '', t.source,
        ]),
      },
      'Leftover Plan': {
        headers: ['Month', 'Destination', 'Type', 'Value', 'Amount'],
        rows: keys.flatMap((k) => compute(td, k).allocs.map((a) => [k, a.label, a.mode === 'percent' ? '% of leftover' : 'Fixed', num(a.value), r2(a.amount)])),
      },
    };
  }

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

  // <option>s for a category <select>. "__new" lets people create a category on the spot.
  function categoryOptions(td, selected, { none = 'No category', allowNew = false } = {}) {
    return `<option value=""${selected ? '' : ' selected'}>${esc(none)}</option>`
      + td.categories.map((c) => `<option value="${esc(c.id)}"${c.id === selected ? ' selected' : ''}>${esc(c.name)}</option>`).join('')
      + (allowNew ? '<option value="__new">+ New category…</option>' : '');
  }

  // Handles the "+ New category…" choice. Returns the chosen category id ('' if cancelled).
  function resolveNewCategory(td, ctx, value) {
    if (value !== '__new') return value;
    const name = (prompt('Name for the new category:') || '').trim();
    if (!name) return '';
    const found = td.categories.find((c) => c.name.toLowerCase() === name.toLowerCase());
    if (found) return found.id;
    const id = Fmt.uid();
    td.categories.push({ id, name: name.slice(0, 40) });
    ctx.changed();
    return id;
  }

  // ---------- Input screen ----------

  function renderInput(root, ctx) {
    const td = topicData(ctx);
    if (ctx.ui.panel === 'import') return MB.renderImport(root, ctx, td);
    if (ctx.ui.panel === 'transactions') return MB.renderTransactions(root, ctx, td);

    const key = ctx.ui.month;
    const m = td.months[key] || blank();
    if (!m.targets) m.targets = [];
    if (!m.incomes) m.incomes = [];
    // A month without income shows a ready-made "Net salary" row. It only becomes part of the month
    // once it's used, so just looking at a month never changes it.
    let draft = m.incomes.length ? null : { id: Fmt.uid(), name: 'Net salary', amount: '', repeat: true };
    const adoptDraft = () => { if (draft) { m.incomes.push(draft); draft = null; } };
    const sym = esc(Fmt.currencySymbol());
    const earlier = Object.keys(td.months).filter((k) => hasContent(td.months[k]) && k < key).sort();
    // "Copy from" is offered only when an earlier month has something it would copy.
    const copyable = (k) => {
      const x = td.months[k];
      return (x.incomes || []).some((i) => i.repeat && num(i.amount) > 0) || (x.targets || []).length > 0
        || (x.expenses || []).some((e) => e.repeat) || (x.allocations || []).length > 0;
    };
    const prev = !hasContent(m) ? earlier.slice().reverse().find(copyable) || null : null;
    const prevTargets = earlier.slice().reverse().find((k) => (td.months[k].targets || []).length) || null;
    const prevSpent = monthKeys(td).filter((k) => k < key).reverse().find((k) => compute(td, k).totalExpenses > 0) || null;
    const prevPlan = earlier.slice().reverse().find((k) => (td.months[k].allocations || []).length) || null;
    let editingCategories = false;
    const TABS = [
      { id: 'income', icon: sym, label: 'Income' },
      { id: 'targets', icon: '🎯', label: 'Targets' },
      { id: 'direct', icon: '🏦', label: 'Direct' },
      { id: 'card', icon: '💳', label: 'Card' },
      { id: 'plan', icon: '◎', label: 'Leftover plan' },
    ];
    if (!TABS.some((t) => t.id === ctx.ui.inputTab)) ctx.ui.inputTab = 'income';
    const tab = ctx.ui.inputTab;

    function persist() {
      if (hasContent(m)) td.months[key] = m;
      else delete td.months[key];
      ctx.changed();
      const banner = view.querySelector('.banner');
      if (banner && hasContent(m)) { banner.remove(); renderStarts(); }
    }

    // Rows are recognized by what they're called, not by id or amount: copies get new ids, and a salary
    // or rent can change from month to month. Duplicates count, so two "Child allowance" rows stay two.
    // A row first pairs with one that has the same name and category, then with one of the same name
    // (its category may have changed); unnamed rows only pair by category. Direct vs card doesn't
    // matter, so an expense moved between the two tabs is still the same expense.
    const norm = (v) => String(v || '').trim().toLowerCase();
    const isBlankIncome = (x) => num(x.amount) <= 0 && ['', 'net salary'].includes(norm(x.name));
    function notYetIn(list, source) {
      const used = new Set();
      const free = (pred) => list.findIndex((y, i) => !used.has(i) && pred(y));
      const out = [];
      const pending = [];
      source.forEach((x) => {
        const i = free((y) => norm(y.name) === norm(x.name) && (y.category || '') === (x.category || ''));
        if (i >= 0) used.add(i); else pending.push(x);
      });
      pending.forEach((x) => {
        const i = norm(x.name) ? free((y) => norm(y.name) === norm(x.name)) : -1;
        if (i >= 0) used.add(i); else out.push(x);
      });
      return source.filter((x) => out.includes(x));
    }
    const copyRow = (x) => ({ ...JSON.parse(JSON.stringify(x)), id: Fmt.uid() });

    // What this month's imported statement already covers: a card expense with the same amount as a
    // counted purchase (each purchase covers one expense), or a guessed direct line in a category the
    // statement has purchases in (the old app treated that line as a budget, so it becomes a target).
    function splitCovered(rows) {
      const c = compute(td, key, m);
      const free = c.counted.filter((t) => t.amount > 0).map((t) => ({ t, used: false }));
      const cats = new Set(c.counted.map((t) => t.cat).filter(Boolean));
      const keep = [], covered = [], budgets = [];
      rows.forEach((x) => {
        if (x.method === 'card' && !isExcluded(td, x.category)) {
          const amount = num(x.amount);
          const same = (u) => !u.used && Math.abs(u.t.amount - amount) < 0.005;
          // A purchase in the same category first; a purchase in a different known category isn't the same thing.
          const hit = amount > 0 && (free.find((u) => same(u) && u.t.cat && u.t.cat === x.category)
            || free.find((u) => same(u) && (!x.category || !u.t.cat)));
          if (hit) { hit.used = true; covered.push(x); return; }
        } else if (x.method !== 'card' && x.guessed && x.category && cats.has(x.category) && !isExcluded(td, x.category)) {
          budgets.push(x);
          return;
        }
        keep.push(x);
      });
      return { keep, covered, budgets };
    }

    // A guessed line becomes a target only if the month has no target in its category yet.
    const newBudgets = (budgets) => budgets.filter((x, i) => !m.targets.some((t) => t.category === x.category && num(t.amount) > 0)
      && budgets.findIndex((y) => y.category === x.category) === i).map(asTarget);

    // ↻ rows from the latest earlier month that has real ones, minus what this month already has.
    function repeatCandidates(kind, method) {
      const real = (x) => x.repeat && (kind !== 'incomes' || !isBlankIncome(x))
        && (!method || (x.method === 'card' ? 'card' : 'direct') === method);
      const month = earlier.slice().reverse().find((k) => (td.months[k][kind] || []).some(real));
      if (!month) return { month: null, rows: [], covered: [], budgets: [] };
      const current = kind === 'incomes' ? m.incomes.filter((x) => !isBlankIncome(x)) : m[kind];
      const rows = notYetIn(current, td.months[month][kind].filter(real));
      if (kind !== 'expenses') return { month, rows, covered: [], budgets: [] };
      const split = splitCovered(rows);
      return { month, rows: split.keep, covered: split.covered, budgets: newBudgets(split.budgets) };
    }
    const asTarget = (x) => ({ name: x.name || '', category: x.category || '', amount: x.amount });

    root.append(monthBar(ctx));
    const view = document.createElement('div');
    view.className = 'stack';
    view.innerHTML = `
      ${prev ? `
      <div class="banner">
        <span>This month is empty. Start from ${Fmt.monthLabel(prev)}: ↻ monthly income and expenses, target expenses and the leftover plan?</span>
        <button class="btn btn-primary" data-action="copy">Copy from ${Fmt.monthLabel(prev, true)}</button>
      </div>` : ''}

      <div class="summary-strip" id="left-card">
        <div class="sum-item"><span class="sum-label">Income</span><strong class="figure" id="sum-income"></strong></div>
        <span class="sum-op" aria-hidden="true">−</span>
        <div class="sum-item"><span class="sum-label">Spent</span><strong class="figure" id="sum-spent"></strong><span class="sum-sub" id="sum-split"></span></div>
        <span class="sum-op" aria-hidden="true">=</span>
        <div class="sum-item sum-left"><span class="sum-label">Left</span><strong class="figure" id="left-val"></strong><span class="sum-sub" id="left-sub"></span></div>
      </div>

      <div class="input-tabs-row">
        <div class="input-tabs" role="tablist" aria-label="Sections">
          ${TABS.map((t) => `<button class="input-tab" role="tab" id="tab-${t.id}" data-tab="${t.id}" aria-controls="panel-${t.id}"
            aria-selected="${t.id === tab}" tabindex="${t.id === tab ? 0 : -1}"><span class="tab-icon" aria-hidden="true">${t.icon}</span>${t.label}<span class="tab-sum figure" id="tabsum-${t.id}"></span></button>`).join('')}
        </div>
        <button class="btn btn-small" data-action="toggle-categories" aria-expanded="false">Edit categories</button>
      </div>
      <div id="cat-editor" class="card cat-editor" hidden></div>

      <section class="card tab-panel" role="tabpanel" id="panel-income" aria-labelledby="tab-income" data-panel="income"${tab === 'income' ? '' : ' hidden'}>
        ${cardHead(sym, 'var(--s6)', 'Income', '<span class="muted">Total <strong id="income-total" class="figure"></strong></span>')}
        <p class="hint">Everything that comes in this month: your take-home pay (neto) and any other income, like freelance work, rent you receive or child allowance.</p>
        <div id="income-list" class="rows"></div>
        <div id="income-start" class="btn-row start-row" hidden></div>
        <button class="add-btn" data-action="add-income">+ Add income source</button>
      </section>

      <section class="card tab-panel" role="tabpanel" id="panel-targets" aria-labelledby="tab-targets" data-panel="targets"${tab === 'targets' ? '' : ' hidden'}>
        ${cardHead('🎯', 'var(--s4)', 'Target expenses', '<span class="muted" id="target-head"></span>')}
        <p class="hint">How much you aim to spend this month. Targets don't count as spending; the dashboard compares them with what you actually spent, by category.</p>
        <div id="target-list" class="rows"></div>
        <p class="hint target-note" id="target-note" hidden></p>
        <div id="target-start" class="btn-row start-row" hidden></div>
        <button class="add-btn" data-action="add-target">+ Add target</button>
      </section>

      <section class="card tab-panel" role="tabpanel" id="panel-direct" aria-labelledby="tab-direct" data-panel="direct"${tab === 'direct' ? '' : ' hidden'}>
        ${cardHead('🏦', EXPENSE_COLOR, 'Direct expenses', '<span class="muted">Total <strong id="direct-head" class="figure"></strong></span>')}
        <p class="hint">What you pay by bank transfer, standing order or cash: rent, arnona, kindergarten… Turn on <strong>↻ Monthly</strong> for ones that repeat, so new months start with them.</p>
        <div id="direct-list" class="rows"></div>
        <div id="direct-start" class="btn-row start-row" hidden></div>
        <button class="add-btn" data-action="add-direct">+ Add direct expense</button>
      </section>

      <section class="card tab-panel" role="tabpanel" id="panel-card" aria-labelledby="tab-card" data-panel="card"${tab === 'card' ? '' : ' hidden'}>
        ${cardHead('💳', 'var(--s1)', 'Card expenses', '<span class="muted">Total <strong id="card-head" class="figure"></strong></span>')}
        <p class="hint">Import your card statements below. Add card purchases by hand only if they aren't in an imported statement (for example, before the statement is out).</p>
        <div id="card-list" class="rows"></div>
        <div id="card-start" class="btn-row start-row" hidden></div>
        <button class="add-btn" data-action="add-card">+ Add card expense by hand</button>
        <div class="subsection" id="card-summary"></div>
      </section>

      <section class="card tab-panel" role="tabpanel" id="panel-plan" aria-labelledby="tab-plan" data-panel="plan"${tab === 'plan' ? '' : ' hidden'}>
        ${cardHead('◎', 'var(--s7)', 'Leftover plan', '<span class="muted">Unallocated <strong id="unalloc" class="figure"></strong></span>')}
        <p class="hint">Decide what to do with what's left. Use a fixed amount or a % of the leftover.</p>
        <div id="alloc-list" class="rows"></div>
        <div id="plan-start" class="btn-row start-row" hidden></div>
        <button class="add-btn" data-action="add-alloc">+ Add destination</button>
        <div id="alloc-warn"></div>
      </section>`;
    root.append(view);

    const $ = (sel) => view.querySelector(sel);

    function moneyInput(value, field, label) {
      return `<div class="money-field">
          <span class="affix">${sym}</span>
          <input data-field="${field}" type="number" inputmode="decimal" min="0" step="any" aria-label="${label}" placeholder="0" value="${esc(value)}">
        </div>`;
    }

    function renderIncomes(focusId) {
      $('#income-list').innerHTML = (draft ? [draft] : m.incomes).map((x, i) => `
        <div class="row income-row" data-kind="income" data-id="${esc(x.id)}">
          <input class="name-input" data-field="name" aria-label="Income source" placeholder="e.g. ${INCOME_HINTS[i % INCOME_HINTS.length]}" value="${esc(x.name)}">
          ${moneyInput(x.amount, 'amount', 'Income amount')}
          <button class="chip repeat${x.repeat ? ' on' : ''}" data-action="repeat" aria-pressed="${x.repeat ? 'true' : 'false'}"
            title="${x.repeat ? 'Repeats: copied into new months' : 'One-time (like a bonus). Click to repeat every month'}">↻ Monthly</button>
          <button class="icon-btn del" data-action="delete" aria-label="Remove income source">✕</button>
        </div>`).join('') || '<p class="empty">No income entered. Add your net salary and any other income.</p>';
      renderStarts();
      focusRow(focusId);
    }

    // "Add ↻ monthly … from <month>" buttons. Hidden while the whole-month "Copy from" banner shows.
    function renderStarts() {
      const show = !view.querySelector('.banner');
      const set = (sel, html) => { const el = $(sel); el.innerHTML = show ? html : ''; el.hidden = !el.innerHTML; };
      const inc = repeatCandidates('incomes');
      set('#income-start', inc.rows.length ? `<button class="btn btn-small" data-action="repeat-incomes">Add ↻ monthly income from ${Fmt.monthLabel(inc.month, true)} (${inc.rows.length})</button>` : '');
      ['direct', 'card'].forEach((method) => {
        const r = repeatCandidates('expenses', method);
        const what = [r.rows.length ? `${r.rows.length} expense${r.rows.length > 1 ? 's' : ''}` : '', r.budgets.length ? `${r.budgets.length} as target${r.budgets.length > 1 ? 's' : ''}` : ''].filter(Boolean).join(' + ');
        set(`#${method}-start`, what
          ? `<button class="btn btn-small" data-action="repeat-expenses" data-method="${method}">Add ↻ monthly ${method} expenses from ${Fmt.monthLabel(r.month, true)} (${what})</button>` : '');
      });
      set('#plan-start', !m.allocations.length && prevPlan ? `<button class="btn btn-small" data-action="copy-plan">Copy the leftover plan from ${Fmt.monthLabel(prevPlan, true)}</button>` : '');
    }

    function renderTargets(focusId) {
      $('#target-list').innerHTML = m.targets.length ? m.targets.map((t, i) => `
        <div class="row target-row${isExcluded(td, t.category) ? ' not-counted' : ''}" data-kind="target" data-id="${esc(t.id)}"${isExcluded(td, t.category) ? ' title="This category doesn’t count as spending, so it can’t be compared"' : ''}>
          <span class="swatch" style="background:${categoryColor(td, t.category)}" aria-hidden="true"></span>
          <input class="name-input" data-field="name" aria-label="Target name" placeholder="e.g. ${TARGET_HINTS[i % TARGET_HINTS.length]}" value="${esc(t.name)}">
          <select class="select" data-field="category" aria-label="Category">${categoryOptions(td, t.category)}</select>
          ${moneyInput(t.amount, 'amount', 'Target amount')}
          <button class="icon-btn del" data-action="delete" aria-label="Remove target">✕</button>
        </div>`).join('')
        : '<p class="empty">No targets yet. Set how much you want to spend on groceries, eating out, shopping…</p>';
      const starts = [];
      if (!m.targets.length && prevTargets) starts.push(`<button class="btn btn-small" data-action="copy-targets">Copy targets from ${Fmt.monthLabel(prevTargets, true)}</button>`);
      if (!m.targets.length && prevSpent) starts.push(`<button class="btn btn-small" data-action="targets-from-spending">Use ${Fmt.monthLabel(prevSpent, true)}'s spending as targets</button>`);
      $('#target-start').innerHTML = starts.join('');
      $('#target-start').hidden = !starts.length;
      focusRow(focusId);
    }

    function renderExpenses(focusId) {
      const c = compute(td, key, m);
      [['direct', DIRECT_HINTS, 'No direct expenses yet. Add rent, bills, kindergarten, cash…'],
        ['card', CARD_HINTS, 'No card expenses entered by hand. Imported statements are counted automatically.']].forEach(([method, hints, empty]) => {
        const lines = c.lines.map((l, i) => ({ l, i })).filter(({ l }) => l.method === method);
        $(`#${method}-list`).innerHTML = lines.length ? lines.map(({ l: e, i }, n) => `
          <div class="row expense-row${e.counted ? '' : ' not-counted'}" data-kind="expense" data-id="${esc(e.id)}"${e.counted ? '' : ' title="This category doesn’t count as spending"'}>
            <span class="swatch" style="background:${categoryColor(td, e.category)}" aria-hidden="true"></span>
            <input class="name-input" data-field="name" aria-label="Expense name" placeholder="e.g. ${hints[n % hints.length]}" value="${esc(e.name || '')}">
            <select class="select" data-field="category" aria-label="Category">${categoryOptions(td, e.category)}</select>
            ${moneyInput(m.expenses[i].amount, 'amount', 'Amount')}
            <button class="chip method" data-action="method" title="${method === 'card' ? 'Paid directly after all? Move it to Direct expenses' : 'Paid by card after all? Move it to Card expenses'}">${method === 'card' ? 'Move to 🏦' : 'Move to 💳'}</button>
            <button class="chip repeat${e.repeat ? ' on' : ''}" data-action="repeat" aria-pressed="${e.repeat ? 'true' : 'false'}"
              title="${e.repeat ? 'Repeats: copied into new months' : 'One-time. Click to repeat every month'}">↻ Monthly</button>
            <button class="icon-btn del" data-action="delete" aria-label="Remove expense">✕</button>
          </div>`).join('') : `<p class="empty">${empty}</p>`;
      });
      renderStarts();
      focusRow(focusId);
    }

    function renderCardSummary() {
      const c = compute(td, key, m);
      const usesCards = td.transactions.length > 0;
      $('#card-summary').innerHTML = `
        <div class="sub-head">
          <h3 class="sub-title">💳 Imported card statements</h3>
          ${c.hasCard ? `<span class="muted">Charged this month <strong class="figure">${money(c.importedCard)}</strong></span>` : ''}
        </div>
        ${c.hasCard
          ? `<p class="hint">${c.txns.length} transactions charged in ${Fmt.monthName(key)}${c.needsCategory ? ` · <strong class="negative">${c.needsCategory} need a category</strong>` : ' · all categorized ✓'}</p>`
          : `<p class="hint">${usesCards ? `No card charges in ${Fmt.monthLabel(key)} yet.` : 'Import your MAX, Cal or other credit card statement (.xlsx or .csv). Purchases count in the month they’re charged, and the app learns your categories.'}</p>`}
        <div class="btn-row">
          <button class="btn btn-primary" data-action="import">Import card statement</button>
          ${usesCards ? `<button class="btn" data-action="review">Review transactions${c.needsCategory ? ` (${c.needsCategory})` : ''}</button>` : ''}
        </div>`;
    }

    function renderCategoryEditor(focusId) {
      const el = $('#cat-editor');
      el.hidden = !editingCategories;
      $('[data-action="toggle-categories"]').setAttribute('aria-expanded', editingCategories);
      $('[data-action="toggle-categories"]').textContent = editingCategories ? 'Done' : 'Edit categories';
      if (!editingCategories) return;
      el.innerHTML = `
        <p class="hint">Rename, remove or add categories. The first eight get their own color. Untick “Spending” for money that just moves around (like transfers to friends).</p>
        <div class="cat-grid">
          ${td.categories.map((c) => `
            <div class="cat-item" data-cat="${esc(c.id)}">
              <span class="swatch" style="background:${categoryColor(td, c.id)}"></span>
              <input class="name-input" data-cat-field="name" value="${esc(c.name)}" aria-label="Category name">
              <label class="mini-check" title="Counts as spending"><input type="checkbox" data-cat-field="spending"${c.excluded ? '' : ' checked'}> Spending</label>
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
      const c = compute(td, key, m);
      $('#alloc-list').innerHTML = m.allocations.length ? c.allocs.map((a, i) => `
        <div class="row alloc-row" data-kind="alloc" data-id="${esc(a.id)}">
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

    function refocus(id, action) {
      const el = view.querySelector(`[data-id="${CSS.escape(id)}"] [data-action="${action}"]`);
      if (el) el.focus();
    }

    function focusRow(id) {
      if (!id) return;
      const input = view.querySelector(`[data-id="${id}"] .name-input`);
      if (input) input.focus();
    }

    function updateTotals() {
      renderStarts();
      const c = compute(td, key, m);
      $('#income-total').textContent = money(c.income);
      // The same pair of numbers that decides "over": spending vs targets in the targeted categories.
      $('#target-head').innerHTML = c.targetedTarget
        ? `<span class="${c.overTarget ? 'negative' : ''}">${c.overTarget ? '⚠ ' : ''}Spent <strong class="figure">${esc(money(c.targetedSpent))}</strong> of <strong class="figure">${esc(money(c.targetedTarget))}</strong></span>`
        : c.hasTargets ? 'Give targets a category to compare' : 'No targets';
      const notes = [];
      if (c.targetedTarget && c.untargetedSpent > 0.005) notes.push(`Compared with spending in the same categories. ${esc(money(c.untargetedSpent))} was spent in categories without a target.`);
      if (c.uncategorizedTargets.length) notes.push(`Choose a category for ${c.uncategorizedTargets.map((t) => `“${esc(t.label)}”`).join(', ')} so it can be compared with your spending.`);
      $('#target-note').innerHTML = notes.join(' ');
      $('#target-note').hidden = !notes.length;
      $('#direct-head').textContent = money(c.direct);
      $('#card-head').textContent = money(c.card);
      $('#sum-income').textContent = money(c.income);
      $('#sum-spent').textContent = money(c.totalExpenses);
      $('#sum-split').textContent = c.totalExpenses > 0 ? `🏦 ${money(c.direct)} · 💳 ${money(c.card)}` : '';
      const sums = { income: c.income, targets: c.targetTotal, direct: c.direct, card: c.card, plan: c.totalAllocated };
      Object.entries(sums).forEach(([id, v]) => { $(`#tabsum-${id}`).textContent = v ? money(v) : ''; });
      $('#left-val').textContent = money(c.left);
      $('#left-card').classList.toggle('bad', c.left < 0);
      $('#left-sub').innerHTML = c.left < 0
        ? `<span aria-hidden="true">⚠ </span>${esc(money(-c.left))} more than your income`
        : c.income > 0 ? `${pct(c.left / c.income)} of your income` : 'Enter your income to get started';

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

    const LISTS = { income: () => m.incomes, target: () => m.targets, expense: () => m.expenses, alloc: () => m.allocations };
    function findItem(row) {
      if (draft && row.dataset.id === draft.id) adoptDraft();
      const list = LISTS[row.dataset.kind]();
      return { list, item: list.find((x) => x.id === row.dataset.id) };
    }
    function rerenderList(kind) {
      if (kind === 'income') renderIncomes();
      else if (kind === 'target') renderTargets();
      else if (kind === 'expense') renderExpenses();
      else renderAllocs();
    }

    function onEdit(e) {
      const t = e.target;
      if (t.dataset.catField) {
        const cat = td.categories.find((c) => c.id === t.closest('[data-cat]').dataset.cat);
        if (t.dataset.catField === 'spending') {
          if (t.checked) delete cat.excluded; else cat.excluded = true;
        } else {
          cat.name = t.value;
        }
        ctx.changed();
        if (t.dataset.catField === 'name') {
          // Rename in place: rebuilding the lists here would swallow a click that caused this blur.
          view.querySelectorAll(`option[value="${CSS.escape(cat.id)}"]`).forEach((o) => { o.textContent = cat.name; });
        } else if (e.type === 'change') {
          renderTargets(); renderExpenses(); renderCardSummary(); updateTotals();
        }
        return;
      } else {
        const row = t.closest('.row');
        if (!row || !t.dataset.field) return;
        const { item } = findItem(row);
        const f = t.dataset.field;
        item[f] = f === 'name' || f === 'category' ? t.value : (t.value === '' ? '' : num(t.value));
        if (f === 'category') {
          row.querySelector('.swatch').style.background = categoryColor(td, t.value);
          if (row.dataset.kind === 'expense' || row.dataset.kind === 'target') {
            // An excluded category (e.g. Transfers) stops the line counting as spending.
            const counted = !isExcluded(td, t.value);
            row.classList.toggle('not-counted', !counted);
            row.title = counted ? '' : 'This category doesn’t count as spending';
          }
        }
      }
      persist();
      updateTotals();
    }

    view.addEventListener('input', (e) => { if (e.target.dataset.catField !== 'spending') onEdit(e); });
    view.addEventListener('change', (e) => { if (e.target.dataset.catField) onEdit(e); });

    const fresh = (list) => (list || []).map((x) => ({ ...JSON.parse(JSON.stringify(x)), id: Fmt.uid() }));

    function selectTab(id, focus) {
      ctx.ui.inputTab = id;
      view.querySelectorAll('[data-tab]').forEach((b) => {
        const on = b.dataset.tab === id;
        b.setAttribute('aria-selected', String(on));
        b.tabIndex = on ? 0 : -1;
        if (on && focus) b.focus();
      });
      view.querySelectorAll('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== id; });
    }

    view.querySelector('.input-tabs').addEventListener('keydown', (e) => {
      const ids = TABS.map((t) => t.id);
      const i = ids.indexOf(ctx.ui.inputTab);
      const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: ids.length - 1 }[e.key];
      if (next == null) return;
      e.preventDefault();
      selectTab(ids[(next + ids.length) % ids.length], true);
    });

    view.addEventListener('click', (e) => {
      const tabBtn = e.target.closest('[data-tab]');
      if (tabBtn) { selectTab(tabBtn.dataset.tab); return; }
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;

      if (action === 'import' || action === 'review') {
        ctx.ui.panel = action === 'import' ? 'import' : 'transactions';
        ctx.rerender();
        return;
      }
      if (['copy', 'repeat-incomes', 'repeat-expenses', 'copy-plan'].includes(action)) {
        // Adds to what's already typed instead of replacing it. Expenses this month's imported
        // statement already covers are skipped (or become targets) so nothing is counted twice.
        let covered = [], budgets = [];
        if (action === 'copy') {
          const src = td.months[prev];
          adoptDraft();
          m.incomes = m.incomes.filter((x) => !isBlankIncome(x));
          m.incomes.push(...notYetIn(m.incomes, (src.incomes || []).filter((x) => x.repeat && !isBlankIncome(x))).map(copyRow));
          m.targets.push(...notYetIn(m.targets, src.targets || []).map(copyRow));
          const split = splitCovered(notYetIn(m.expenses, (src.expenses || []).filter((x) => x.repeat)));
          m.expenses.push(...split.keep.map(copyRow));
          ({ covered } = split);
          budgets = newBudgets(split.budgets);
          m.allocations.push(...notYetIn(m.allocations, src.allocations || []).map(copyRow));
        } else if (action === 'repeat-incomes') {
          const r = repeatCandidates('incomes');
          adoptDraft();
          m.incomes = m.incomes.filter((x) => !isBlankIncome(x));
          m.incomes.push(...r.rows.map(copyRow));
        } else if (action === 'repeat-expenses') {
          const r = repeatCandidates('expenses', btn.dataset.method);
          m.expenses.push(...r.rows.map(copyRow));
          ({ covered, budgets } = r);
        } else {
          m.allocations.push(...notYetIn(m.allocations, td.months[prevPlan].allocations || []).map(copyRow));
        }
        const before = new Set([...m.incomes, ...m.targets, ...m.expenses, ...m.allocations].map((x) => x.id));
        m.targets.push(...budgets.map(copyRow));
        const added = [...m.incomes, ...m.targets, ...m.expenses, ...m.allocations].find((x) => !before.has(x.id));
        persist();
        ctx.ui.focusAfter = added ? added.id : 'tab';
        ctx.rerender();
        const notes = [];
        if (covered.length) notes.push(`${covered.map((x) => `“${String(x.name || '').trim() || 'Card expense'}”`).join(', ')} already in this month's imported statement`);
        if (budgets.length) notes.push(`${budgets.length} added as targets, since the statement has purchases in ${budgets.length > 1 ? 'their categories' : 'its category'}`);
        if (notes.length) App.toast(`Not added as expenses: ${notes.join('; ')}.`);
        return;
      }
      if (action === 'toggle-categories') {
        editingCategories = !editingCategories;
        renderCategoryEditor();
        if (!editingCategories) { renderTargets(); renderExpenses(); }
        return;
      }
      if (action === 'add-category') {
        const id = Fmt.uid();
        td.categories.push({ id, name: 'New category' });
        ctx.changed();
        renderCategoryEditor(id);
        renderTargets();
        renderExpenses();
        return;
      }
      if (action === 'delete-category') {
        const id = btn.closest('[data-cat]').dataset.cat;
        const inMonths = (fn) => Object.values(td.months).some((mm) => (mm.expenses || []).some(fn) || (mm.targets || []).some(fn));
        const used = inMonths((x) => x.category === id) || td.rules.some((r) => r.category === id)
          || td.transactions.some((t) => txnCategory(td, t).id === id);
        if (used && !confirm('Targets, expenses, card transactions and rules using this category will need a new category. Remove it?')) return;
        td.categories.splice(td.categories.findIndex((c) => c.id === id), 1);
        Object.values(td.months).forEach((mm) => [mm.expenses || [], mm.targets || []].forEach((list) => list.forEach((x) => { if (x.category === id) x.category = ''; })));
        td.transactions.forEach((t) => { if (t.category === id) delete t.category; });
        td.rules = td.rules.filter((r) => r.category !== id);
        Object.keys(td.sourceMap).forEach((k) => { if (td.sourceMap[k] === id) td.sourceMap[k] = ''; });
        ctx.changed();
        renderCategoryEditor();
        renderTargets();
        renderExpenses();
        renderCardSummary();
        updateTotals();
        return;
      }

      if (action === 'add-income') {
        adoptDraft();
        const id = Fmt.uid();
        m.incomes.push({ id, name: '', amount: '', repeat: true });
        renderIncomes(id);
      } else if (action === 'add-target') {
        const id = Fmt.uid();
        m.targets.push({ id, name: '', category: '', amount: '' });
        renderTargets(id);
      } else if (action === 'copy-targets') {
        m.targets = fresh(td.months[prevTargets].targets);
        renderTargets();
      } else if (action === 'targets-from-spending') {
        // One target per category, rounded up to the next ₪10, from the last month with spending.
        const totals = actualByCategory(td, compute(td, prevSpent));
        const ids = td.categories.map((c) => c.id).filter((id) => totals.get(id) > 0 && !isExcluded(td, id));
        m.targets = ids.map((id) => ({ id: Fmt.uid(), name: '', category: id, amount: Math.ceil(totals.get(id) / 10) * 10 }));
        renderTargets();
      } else if (action === 'add-direct' || action === 'add-card') {
        const id = Fmt.uid();
        m.expenses.push({ id, name: '', category: '', amount: '', method: action === 'add-card' ? 'card' : 'direct' });
        renderExpenses(id);
      } else if (action === 'add-alloc') {
        const id = Fmt.uid();
        m.allocations.push({ id, name: '', mode: 'amount', value: '' });
        renderAllocs(id);
      } else {
        const row = btn.closest('.row');
        if (!row) return;
        const { list, item } = findItem(row);
        if (!item) return;
        if (action === 'delete') {
          const next = row.nextElementSibling && row.nextElementSibling.dataset.id;
          const panel = row.closest('.tab-panel');
          list.splice(list.indexOf(item), 1);
          rerenderList(row.dataset.kind);
          const target = next && view.querySelector(`[data-id="${CSS.escape(next)}"] .name-input`);
          const fallback = panel && panel.querySelector('.add-btn');
          if (target || fallback) (target || fallback).focus();
        } else if (action === 'method') {
          const next = row.nextElementSibling && row.nextElementSibling.dataset.id;
          const panel = row.closest('.tab-panel');
          item.method = item.method === 'card' ? 'direct' : 'card';
          delete item.guessed;
          renderExpenses();
          const target = (next && view.querySelector(`[data-id="${CSS.escape(next)}"] [data-action="method"]`)) || (panel && panel.querySelector('.add-btn'));
          if (target) target.focus();
          App.toast(`Moved “${String(item.name || '').trim() || 'Expense'}” to ${item.method === 'card' ? 'Card' : 'Direct'} expenses.`);
        } else if (action === 'repeat') {
          if (item.repeat) delete item.repeat; else item.repeat = true;
          rerenderList(row.dataset.kind);
          refocus(item.id, action);
        } else if (action === 'mode' && item.mode !== btn.dataset.mode) {
          // Convert so the amount stays the same when switching between fixed and %.
          const pool = compute(td, key, m).pool;
          const v = num(item.value);
          if (item.value !== '') {
            item.value = btn.dataset.mode === 'percent'
              ? (pool > 0 ? Math.round(v / pool * 10000) / 100 : 0)
              : Math.round(pool * v) / 100;
          }
          item.mode = btn.dataset.mode;
          renderAllocs();
          const again = view.querySelector(`[data-id="${CSS.escape(item.id)}"] [data-mode="${btn.dataset.mode}"]`);
          if (again) again.focus();
        }
      }
      persist();
      updateTotals();
    });

    renderIncomes();
    renderTargets();
    renderExpenses();
    renderCardSummary();
    renderAllocs();
    updateTotals();
    // After a full redraw (Copy, ↻), put keyboard focus somewhere sensible instead of <body>.
    if (ctx.ui.focusAfter) {
      const id = ctx.ui.focusAfter;
      ctx.ui.focusAfter = null;
      const el = id === 'tab' ? view.querySelector('[role=tab][aria-selected=true]') : view.querySelector(`[data-id="${CSS.escape(id)}"] .name-input`);
      if (el) {
        const panel = el.closest('[data-panel]');
        if (panel && panel.hidden) selectTab(panel.dataset.panel);
        el.focus();
      }
    }
  }

  // ---------- Dashboard ----------
  // Built to fit one screen on desktop: KPI tiles, a slim "where the income goes" bar, then a
  // 3x2 grid of cards whose lists are capped (each card has a table view with everything).

  function kpi(icon, color, label, value, sub, opts = {}) {
    return `
      <div class="kpi${opts.accent ? ' accent' : ''}${opts.bad ? ' bad' : ''}" style="--tint:${color}"${opts.tip ? ` tabindex="0" data-tip="${esc(label)}" data-tip-sub="${esc(opts.tip)}"` : ''}>
        <span class="badge" aria-hidden="true">${icon}</span>
        <div>
          <div class="kpi-label">${label}</div>
          <div class="kpi-value">${opts.bad ? '<span aria-hidden="true">⚠ </span>' : ''}${esc(value)}</div>
          <div class="kpi-sub">${sub}</div>
        </div>
      </div>`;
  }

  // What the trend chart shows: the 8 weeks up to the week shown, the 12 months of the year shown,
  // or up to 12 months with data ending at the month shown.
  const trendUnit = (p) => (p.kind === 'week' ? 'week' : 'month');
  function trendPeriods(td, p) {
    if (p.kind === 'week') return Array.from({ length: 8 }, (_, i) => shiftPeriod(p, i - 7));
    if (p.kind === 'year') return p.parts.map((x) => makePeriod('month', x.key));
    const months = monthKeys(td);
    if (!months.includes(p.id)) months.push(p.id);
    return months.sort().filter((k) => k <= p.id).slice(-12).map((k) => makePeriod('month', k));
  }

  function expensesVsLeft(td, p, size) {
    const periods = trendPeriods(td, p);
    const cs = periods.map((q) => computePeriod(td, q));
    const points = periods.map((q, i) => {
      const c = cs[i];
      const over = c.left < 0;
      const selected = q.id === p.id || (p.kind === 'year' && q.id === p.focus);
      return {
        label: q.short,
        selected,
        segments: [
          { name: 'Expenses', value: c.totalExpenses, color: EXPENSE_COLOR },
          { name: 'Money left', value: Math.max(c.left, 0), color: LEFT_COLOR },
        ],
        marker: over ? c.income : 0,
        note: selected ? (over ? '⚠ Over' : Fmt.compactMoney(c.left) + ' left') : '',
        tip: q.label,
        tipSub: `Expenses ${money(c.totalExpenses)} (direct ${money(c.direct)} · card ${money(c.card)}) · Left ${money(c.left)} · Income ${money(c.income)}`
          + (c.hasTargets ? ` · Target ${money(c.targetTotal)}` : ''),
      };
    });
    const anyOver = points.some((x) => x.marker);
    const unit = trendUnit(p);
    return Charts.columns(points, {
      legendItems: [
        { name: 'Expenses', color: EXPENSE_COLOR },
        { name: 'Money left', color: LEFT_COLOR },
        ...(anyOver ? [{ name: 'Income (when overspent)', color: 'var(--ink)', dashed: true }] : []),
      ],
      ariaLabel: `Expenses and money left, by ${unit}`,
      width: size && size.width, height: size && size.height,
      tableHeaders: [unit[0].toUpperCase() + unit.slice(1), 'Income', 'Target', 'Expenses', 'Direct', 'Card', 'Money left'],
      tableRows: periods.map((q, i) => {
        const c = cs[i];
        return [q.label, money(c.income), c.hasTargets ? money(c.targetTotal) : '–', money(c.totalExpenses), money(c.direct), money(c.card), money(c.left)];
      }),
    });
  }

  function targetVsActual(td, c) {
    const actual = actualByCategory(td, c);
    const target = new Map();
    c.countedTargets.filter((t) => known(td, t.category))
      .forEach((t) => target.set(t.category, (target.get(t.category) || 0) + t.amount));
    const ids = new Set([...actual.keys(), ...target.keys()]);
    const items = [...ids].map((id) => ({
      name: id ? categoryName(td, id) : uncategorizedLabel(c),
      actual: actual.get(id) || 0,
      planned: target.get(id) || 0,
      color: id ? categoryColor(td, id) : 'var(--neutral)',
    })).filter((i) => i.actual > 0 || i.planned > 0);
    // Targets without a category keep their own row so they don't silently disappear.
    c.uncategorizedTargets.forEach((t) => items.push({
      name: t.label, actual: 0, planned: t.amount, color: 'var(--neutral)', status: 'Choose a category to compare',
    }));
    return Charts.bulletList(items, { empty: 'No targets or spending yet.', planLabel: 'Target', noPlan: 'No target', limit: 6 });
  }

  // "₪3,500 of ₪3,800 target" for the categories that have a target, plus what was spent elsewhere.
  // "₪3,500 of ₪3,800 target" for the categories that have a target, plus what was spent elsewhere.
  function targetSummary(c) {
    if (!c.targetedTarget) return 'Give your targets a category to compare them with spending';
    const diff = c.targetedSpent - c.targetedTarget;
    return `${c.overTarget ? `${money(diff)} over` : `${money(-diff)} under`} target in targeted categories`;
  }

  // Hand-entered expenses and imported purchases (grouped by business), biggest first.
  function biggestExpenses(td, c) {
    const byKey = new Map();
    c.counted.forEach((t) => {
      const k = keyOf(t);
      const cur = byKey.get(k) || { name: Statements.displayName(t.merchant), amount: 0, count: 0, cat: t.cat };
      cur.amount += t.amount;
      cur.count += 1;
      byKey.set(k, cur);
    });
    const items = [
      ...c.countedLines.map((l) => ({
        name: l.label, amount: l.amount, color: known(td, l.category) ? categoryColor(td, l.category) : 'var(--neutral)',
        tag: `${l.method === 'card' ? '💳' : '🏦'} ${known(td, l.category) ? categoryName(td, l.category) : 'No category'}`,
      })),
      ...[...byKey.values()].map((b) => ({
        name: b.name, amount: b.amount, color: b.cat ? categoryColor(td, b.cat) : 'var(--neutral)',
        tag: `💳 ${categoryName(td, b.cat)}${b.count > 1 ? ` ×${b.count}` : ''}`,
      })),
    ];
    return Charts.barList(items, { basis: c.totalExpenses, basisLabel: 'expenses', empty: 'No expenses yet.', limit: 5 });
  }

  const TABLE_BTN = '<button class="icon-btn table-btn" data-table aria-pressed="false" title="Show as table" aria-label="Show as table">⊞</button>';

  function dashCard(icon, color, title, body, extraClass) {
    return `
      <section class="card dash-card${extraClass ? ' ' + extraClass : ''}">
        ${cardHead(icon, color, title, body.includes('table-toggle') ? TABLE_BTN : '')}
        <div class="chart-body">${body}</div>
      </section>`;
  }

  // Lists in a fitted card show only the rows that fit; the rest are counted in "+N more".
  function trimLists(dash) {
    dash.querySelectorAll('.dash-card .chart-body').forEach((body) => {
      const list = body.querySelector('.bar-list, .bullet-list');
      if (!list) return;
      const rows = [...list.children];
      rows.forEach((r) => { r.hidden = false; });
      const note = body.querySelector('.more-note');
      const base = note ? Number(note.dataset.more) || 0 : 0;
      let hidden = 0;
      if (dash.classList.contains('fit') && !body.closest('.show-table')) {
        const noteH = 22;
        const bottom = body.getBoundingClientRect().bottom - noteH;
        for (let i = rows.length - 1; i > 0 && rows[i].getBoundingClientRect().bottom > bottom; i--) { rows[i].hidden = true; hidden += 1; }
      }
      if (note) {
        note.textContent = `+${base + hidden} more in the table view`;
        note.hidden = base + hidden === 0;
      }
    });
  }

  // Week / Month / Year switch plus ‹ period › navigation for the dashboard.
  const PERIOD_KINDS = [['week', 'Week'], ['month', 'Month'], ['year', 'Year']];

  function currentPeriod(ctx) {
    const kind = ['week', 'month', 'year'].includes(ctx.ui.period) ? ctx.ui.period : 'month';
    if (kind === 'week') {
      // A week touching the selected month: today's week in the current month, else the month's first.
      const p = ctx.ui.week && makePeriod('week', ctx.ui.week);
      if (!p || !p.parts.some((x) => x.key === ctx.ui.month)) {
        const today = isoDay(new Date());
        ctx.ui.week = today.slice(0, 7) === ctx.ui.month ? today : `${ctx.ui.month}-01`;
      }
      return makePeriod('week', ctx.ui.week);
    }
    return { ...makePeriod(kind, ctx.ui.month), focus: ctx.ui.month };
  }

  function periodBar(ctx, p) {
    const el = document.createElement('div');
    el.className = 'period-bar';
    const now = new Date();
    const here = makePeriod(p.kind, p.kind === 'week' ? isoDay(now) : Fmt.monthKey(now));
    el.innerHTML = `
      <div class="segmented period-kinds" role="group" aria-label="Show by">
        ${PERIOD_KINDS.map(([k, label]) => `<button data-kind="${k}" aria-pressed="${p.kind === k}">${label}</button>`).join('')}
      </div>
      <button class="icon-btn round" data-step="-1" aria-label="Previous ${p.kind}">‹</button>
      <h1 aria-live="polite">${esc(p.label)}</h1>
      <button class="icon-btn round" data-step="1" aria-label="Next ${p.kind}">›</button>
      ${p.id === here.id ? '' : `<button class="link-btn" data-today>This ${p.kind}</button>`}`;
    el.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      if (btn.dataset.kind) {
        ctx.ui.period = btn.dataset.kind;
        ctx.rerender();
        return;
      }
      const next = btn.hasAttribute('data-today') ? here : shiftPeriod(p, Number(btn.dataset.step));
      // The month stays in step so "My numbers" opens on the same time.
      if (next.kind === 'week') { ctx.ui.week = next.id; ctx.ui.month = next.parts[next.parts.length - 1].key; }
      else if (next.kind === 'year') ctx.ui.month = next.id === here.id && btn.hasAttribute('data-today') ? Fmt.monthKey(now) : `${next.id}-${ctx.ui.month.slice(5, 7)}`;
      else ctx.ui.month = next.id;
      ctx.rerender();
    });
    return el;
  }

  // Fill the rest of the window (desktop only; on small screens the cards just stack).
  // Same breakpoint as the 3-column grid in the CSS (narrower windows get the stacked layout).
  function fitToWindow(dash, redrawTrend) {
    const fit = () => {
      if (!dash.isConnected) { removeEventListener('resize', fit); return; }
      const wide = innerWidth > 1100 && innerHeight >= 620;
      dash.classList.toggle('fit', wide);
      dash.classList.toggle('short', wide && innerHeight < 900);
      dash.style.height = wide ? `${Math.max(520, innerHeight - dash.getBoundingClientRect().top - window.scrollY - 14)}px` : '';
      redrawTrend(wide);
      trimLists(dash);
    };
    addEventListener('resize', fit);
    fit();
    return fit;
  }

  function renderDashboard(root, ctx) {
    const td = topicData(ctx);
    const p = currentPeriod(ctx);
    // The period picker shares the row with the people switcher to save height.
    const bar = periodBar(ctx, p);
    const people = root.parentElement && root.parentElement.querySelector('.people-bar');
    if (people) people.prepend(bar); else root.append(bar);
    const main = root.closest('.main');
    if (main) main.classList.add('dash-main');

    const c = computePeriod(td, p);
    const view = document.createElement('div');
    root.append(view);

    if (!periodHasData(td, p, c)) {
      view.className = 'stack';
      view.innerHTML = `
        <section class="card empty-state">
          <div class="empty-illustration" aria-hidden="true">₪</div>
          <p>${ctx.isMe ? 'No numbers' : `${esc(ctx.owner.name)} hasn't added numbers`} for ${esc(p.label)} yet.</p>
          ${ctx.isMe ? `<a class="btn btn-primary" href="#/${ID}/input">Enter ${p.kind === 'month' ? "this month's" : 'your'} numbers</a>` : ''}
        </section>
        ${monthKeys(td).length ? `<section class="card empty-trend">${cardHead('▥', LEFT_COLOR, 'Expenses vs money left')}<div class="chart-body"></div></section>` : ''}`;
      const body = view.querySelector('.empty-trend .chart-body');
      if (body) body.innerHTML = expensesVsLeft(td, p, { width: body.clientWidth || 640, height: 240 });
      return;
    }

    const sources = c.incomes.filter((x) => x.amount);
    const flags = [];
    if (c.left >= 0 && c.unallocated < -0.005) flags.push(`<span class="flag bad">⚠ Leftover plan is ${esc(money(-c.unallocated))} over</span>`);
    if (ctx.isMe && c.needsCategory) flags.push(`<a class="flag" href="#/${ID}/input" data-review>💳 ${c.needsCategory} to categorize</a>`);
    if (p.kind === 'week') flags.push(`<span class="flag info" tabindex="0" data-tip="How a week is counted" data-tip-sub="Card purchases count on the day they were made. Income, targets, other expenses and the leftover plan are monthly, so the week gets its share by days.">ⓘ Monthly amounts split by days</span>`);

    const flow = Charts.stackBar([
      { name: 'Expenses', amount: c.totalExpenses, color: EXPENSE_COLOR },
      ...foldAllocs(c.allocs),
      { name: 'Unallocated', amount: Math.max(c.unallocated, 0), color: 'var(--neutral)' },
    ], { base: c.income, baseLabel: 'income', markerLabel: 'Income' });

    view.className = 'dash';
    view.innerHTML = `
      <div class="kpi-row">
        ${kpi(esc(Fmt.currencySymbol()), 'var(--s6)', 'Income', money(c.income), sources.length > 1 ? `${sources.length} sources` : `This ${p.kind}`,
          { tip: sources.map((x) => `${x.label} ${money(x.amount)}`).join(' · ') })}
        ${kpi('↓', EXPENSE_COLOR, 'Expenses', money(c.totalExpenses), `🏦 ${esc(money(c.direct))} · 💳 ${esc(money(c.card))}`,
          { tip: `Direct ${money(c.direct)} · Card ${money(c.card)}${c.hasCard ? ` (${money(c.importedCard)} from statements)` : ''}${c.income > 0 ? ` · ${pct(c.totalExpenses / c.income)} of income` : ''}` })}
        ${kpi(c.left < 0 ? '⚠' : '✓', LEFT_COLOR, `${ctx.isMe ? '' : esc(ctx.owner.name) + ' · '}Left ${esc(p.inLabel)}`, money(c.left),
          c.left < 0 ? 'More than the income' : c.income > 0 ? `${pct(c.left / c.income)} of income` : 'No income entered', { accent: true, bad: c.left < 0 })}
        ${c.hasTargets
          ? kpi('🎯', 'var(--s4)', 'Targets', money(c.targetTotal),
            c.targetedTarget ? `${esc(money(Math.abs(c.targetedSpent - c.targetedTarget)))} ${c.overTarget ? 'over' : 'under'}` : 'No category yet',
            { bad: c.overTarget, tip: targetSummary(c) })
          : kpi('◎', 'var(--s7)', 'Planned leftover', money(c.totalAllocated), c.pool > 0 ? pct(c.totalAllocated / c.pool) + ' of leftover' : 'Nothing left to plan')}
        ${kpi('✦', 'var(--s1)', 'Unallocated', money(c.left < 0 ? 0 : c.unallocated),
          c.left < 0 ? 'Nothing left to plan' : c.unallocated < -0.005 ? 'Over-planned' : (c.pool > 0 ? pct(Math.max(c.unallocated, 0) / c.pool) + ' of leftover' : '&nbsp;'),
          { bad: c.left >= 0 && c.unallocated < -0.005 })}
      </div>

      <section class="card dash-flow">
        <div class="flow-head">
          <h2 class="card-title">Where the income goes</h2>
          ${flags.join('')}
          ${flow ? TABLE_BTN : ''}
        </div>
        <div class="chart-body">
          ${flow || '<p class="empty">Add your income and expenses to see where your money goes.</p>'}
        </div>
      </section>

      <div class="dash-grid">
        ${dashCard('◔', EXPENSE_COLOR, 'Spending by category', Charts.donut(donutItems(td, c), { centerLabel: 'spent', empty: 'No expenses yet.' }) + refundNote(td, c))}
        ${c.hasTargets
          ? dashCard('🎯', 'var(--s4)', 'Target vs actual', targetVsActual(td, c))
          : dashCard(esc(Fmt.currencySymbol()), 'var(--s6)', 'Income sources', Charts.barList(sources.map((x) => ({ name: x.label, amount: x.amount, color: 'var(--s6)' })),
            { basis: c.income, basisLabel: 'income', empty: 'No income entered.', limit: 6 }))}
        ${dashCard('◎', 'var(--s7)', 'Leftover plan', Charts.barList([...foldAllocs(c.allocs), { name: 'Unallocated', amount: Math.max(c.unallocated, 0), color: 'var(--neutral)' }],
          { basis: c.pool, basisLabel: 'leftover', empty: c.left > 0 ? 'No plan for the leftover yet.' : 'Nothing left to plan this month.', limit: 6 }))}
        ${dashCard('▥', LEFT_COLOR, `Expenses vs money left, by ${trendUnit(p)}`, expensesVsLeft(td, p), 'wide trend')}
        ${dashCard('↓', EXPENSE_COLOR, 'Biggest expenses', biggestExpenses(td, c))}
      </div>`;

    let refit = null;
    view.querySelectorAll('[data-table]').forEach((btn) => {
      btn.onclick = () => {
        const card = btn.closest('.dash-card, .dash-flow');
        const on = !card.classList.contains('show-table');
        card.classList.toggle('show-table', on);
        btn.setAttribute('aria-pressed', String(on));
        btn.title = on ? 'Show as chart' : 'Show as table';
        card.querySelectorAll('.table-toggle').forEach((d) => { d.open = on; });
        if (refit) refit();
      };
    });
    const review = view.querySelector('[data-review]');
    if (review) review.onclick = () => { ctx.ui.panel = 'transactions'; ctx.ui.txFilter = { q: '', cat: 'none' }; };
    // The trend chart is drawn to its card's size so it fills the space with readable labels.
    const trendBody = view.querySelector('.trend .chart-body');
    const redrawTrend = (wide) => {
      if (!trendBody || trendBody.closest('.show-table')) return;
      const legendH = 26, tableBtn = trendBody.querySelector('.table-toggle');
      const size = wide ? { width: trendBody.clientWidth, height: trendBody.clientHeight - legendH } : { width: Math.max(320, trendBody.clientWidth) };
      const open = tableBtn && tableBtn.open;
      trendBody.innerHTML = expensesVsLeft(td, p, size);
      if (open) trendBody.querySelector('.table-toggle').open = true;
    };
    refit = fitToWindow(view, redrawTrend);
  }

  window.MB = {
    ID, topicData, compute, computePeriod, makePeriod, shiftPeriod, monthKeys, monthBar, cardHead, warning, categoryOptions, resolveNewCategory,
    categoryColor, categoryName, isExcluded, txnCategory, sourceCategory, upsertRule, keyOf, DEFAULT_SOURCE_MAP,
  };

  App.register({ id: ID, title: 'Monthly Balance', icon: '₪', renderInput, renderDashboard, exportRows });
})();
