// Topic: Food. Weekly meal-prep menu, recipes (with a video link), a household list of people with
// calorie/macro targets, portions scaled to each person's target, and a grocery list built from the
// menu (also written to the Google Sheet's "Groceries" tab when Sheets storage is used).
//
// Topic data: { people: [{id, name, kcal, protein, carbs, fat, scale: 'protein'|'kcal'|'none'}],
//   foods: [custom foods, per 100 g], recipes: [{id, name, video, steps, ingredients: [{food, grams}]}],
//   weeks: { 'YYYY-MM-DD' (Sunday): { meals: { 'd<0-6>:<slot>': recipeId }, checked: {key: true}, extra: [{id, name, amount, checked}] } } }
(function () {
  const ID = 'food';
  const { num, esc } = Fmt;
  const sum = (arr) => arr.reduce((a, b) => a + b, 0);
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const SLOTS = [['breakfast', 'Breakfast'], ['lunch', 'Lunch'], ['dinner', 'Dinner'], ['snack', 'Snack']];
  const MACROS = [['kcal', 'Calories', 'kcal'], ['protein', 'Protein', 'g'], ['carbs', 'Carbs', 'g'], ['fat', 'Fat', 'g']];
  const SCALE = [['protein', 'Protein target'], ['kcal', 'Calorie target'], ['none', "Don't scale (1 portion)"]];
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  // Person colors stay off the macro roles (protein --s1, carbs --s2, fat --s3, calories --s4).
  const PERSON_COLORS = ['var(--s7)', 'var(--s5)', 'var(--s8)', 'var(--s6)', 'var(--other)'];

  // ---------- Data ----------

  const STARTER_RECIPES = [
    { name: 'Chicken breast & rice', steps: 'Season the chicken, bake or pan-fry 6–7 min per side. Cook the rice. Steam the broccoli. Divide into boxes.',
      ingredients: [['b:chicken-breast-raw', 150], ['b:white-rice-dry', 75], ['b:broccoli', 100], ['b:olive-oil', 5]] },
    { name: 'Oats with yogurt & banana', steps: 'Mix oats with yogurt overnight, top with banana and honey.',
      ingredients: [['b:oats', 60], ['b:greek-yogurt-0', 150], ['b:banana', 120], ['b:honey', 10]] },
    { name: 'Tuna salad with pita', steps: 'Chop the vegetables, mix with tuna and olive oil, serve with pita.',
      ingredients: [['b:tuna-canned-in-water-drained', 112], ['b:cucumber', 100], ['b:tomato', 100], ['b:olive-oil', 10], ['b:pita', 60]] },
    { name: 'Omelette, cottage & bread', steps: 'Beat the eggs and fry. Serve with cottage cheese, bread and vegetables.',
      ingredients: [['b:eggs', 150], ['b:cottage-cheese-5', 100], ['b:whole-wheat-bread', 60], ['b:cucumber', 100], ['b:tomato', 100]] },
  ];

  function topicData(ctx) {
    const d = ctx.data;
    // Editable: my own data, or someone else's topic shared with me as "can edit".
    if (ctx.readOnly === undefined ? ctx.isMe : !ctx.readOnly) {
      if (!d.people) d.people = [];
      if (!d.foods) d.foods = [];
      if (!d.recipes) {
        d.recipes = STARTER_RECIPES.map((r) => ({
          id: Fmt.uid(), name: r.name, video: '', steps: r.steps,
          ingredients: r.ingredients.map(([food, grams]) => ({ id: Fmt.uid(), food, grams })),
        }));
      }
      if (!d.weeks) d.weeks = {};
      return d;
    }
    return { people: d.people || [], foods: d.foods || [], recipes: d.recipes || [], weeks: d.weeks || {} };
  }

  const allFoods = (td) => Foods.BUILTIN.concat(td.foods);
  const foodById = (td, id) => allFoods(td).find((f) => f.id === id) || null;

  // Per portion: each ingredient's grams × its values per 100 g.
  function recipeTotals(td, r) {
    const t = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
    ((r && r.ingredients) || []).forEach((i) => {
      const f = foodById(td, i.food);
      if (!f) return;
      MACROS.forEach(([k]) => { t[k] += num(f[k]) * num(i.grams) / 100; });
    });
    return t;
  }

  // ---------- Weeks ----------

  const pad2 = (n) => String(n).padStart(2, '0');
  const isoDay = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const dayOf = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); };
  function weekStart(date) { const d = new Date(date.getFullYear(), date.getMonth(), date.getDate()); d.setDate(d.getDate() - d.getDay()); return isoDay(d); }
  const addDays = (iso, n) => { const d = dayOf(iso); d.setDate(d.getDate() + n); return isoDay(d); };
  function weekLabel(id) {
    const a = dayOf(id), b = dayOf(addDays(id, 6));
    return a.getMonth() === b.getMonth()
      ? `${a.getDate()}–${b.getDate()} ${SHORT_MONTHS[b.getMonth()]} ${b.getFullYear()}`
      : `${a.getDate()} ${SHORT_MONTHS[a.getMonth()]} – ${b.getDate()} ${SHORT_MONTHS[b.getMonth()]} ${b.getFullYear()}`;
  }
  const dayLabel = (id, i) => { const d = dayOf(addDays(id, i)); return `${DAYS[i].slice(0, 3)} ${d.getDate()}`; };

  const blankWeek = () => ({ meals: {}, checked: {}, extra: [] });
  const weekHasContent = (w) => !!w && (Object.values(w.meals || {}).some(Boolean) || (w.extra || []).length > 0);
  function weekOf(td, id) {
    const w = td.weeks[id] || blankWeek();
    if (!w.meals) w.meals = {};
    if (!w.checked) w.checked = {};
    if (!w.extra) w.extra = [];
    return w;
  }

  // ---------- Portions ----------
  // Each person eats every planned meal. With a protein (or calorie) target, all of that day's
  // portions are scaled by the same factor so the day adds up to the target.

  function dayRecipes(td, w, i) {
    return SLOTS.map(([slot]) => td.recipes.find((r) => r.id === w.meals[`d${i}:${slot}`])).filter(Boolean);
  }

  function personDay(td, person, w, i) {
    const base = { kcal: 0, protein: 0, carbs: 0, fat: 0 };
    dayRecipes(td, w, i).forEach((r) => { const t = recipeTotals(td, r); MACROS.forEach(([k]) => { base[k] += t[k]; }); });
    const mode = person ? person.scale || 'protein' : 'none';
    const target = person && mode !== 'none' ? num(person[mode]) : 0;
    let factor = 1;
    if (target > 0 && base[mode] > 0) factor = Math.min(5, Math.max(0.25, Math.round((target / base[mode]) * 20) / 20));
    const totals = {};
    MACROS.forEach(([k]) => { totals[k] = base[k] * factor; });
    return { base, factor, totals, meals: dayRecipes(td, w, i).length };
  }

  // Grams of each food for the whole week: every meal × every person's portion factor for that day.
  function groceries(td, w) {
    const grams = new Map();
    for (let i = 0; i < 7; i++) {
      const eaters = td.people.length ? sum(td.people.map((p) => personDay(td, p, w, i).factor)) : 1;
      dayRecipes(td, w, i).forEach((r) => r.ingredients.forEach((ing) => {
        if (!foodById(td, ing.food)) return;
        grams.set(ing.food, (grams.get(ing.food) || 0) + num(ing.grams) * eaters);
      }));
    }
    return [...grams.entries()].map(([id, g]) => ({ food: foodById(td, id), grams: g }))
      .sort((a, b) => Foods.AISLES.indexOf(a.food.aisle) - Foods.AISLES.indexOf(b.food.aisle) || a.food.name.localeCompare(b.food.name));
  }

  function amountText(food, grams) {
    const g = Math.ceil(grams / 10) * 10;
    const weight = g >= 1000 ? `${Math.round(g / 100) / 10} kg` : `${g} g`;
    if (food.piece) {
      const n = Math.max(1, Math.ceil(grams / food.piece));
      return `${n} ${food.pieceName || 'pc'}${n > 1 ? 's' : ''} (${weight})`;
    }
    return weight;
  }

  const fmt1 = (v) => Math.round(v).toLocaleString('en-US');

  // Readable rows for the Google Sheet.
  function exportRows(data) {
    const td = topicData({ data: data || {}, isMe: false, readOnly: true });
    const today = weekStart(new Date());
    const weeks = Object.keys(td.weeks).filter((k) => weekHasContent(td.weeks[k]) && k >= addDays(today, -7 * 8)).sort();
    return {
      'Groceries': {
        headers: ['Week of', 'Item', 'Amount', 'Aisle', 'Bought'],
        rows: weeks.flatMap((k) => {
          const w = weekOf(td, k);
          return groceries(td, w).map((g) => [k, g.food.name, amountText(g.food, g.grams), g.food.aisle, w.checked[g.food.id] ? 'Yes' : ''])
            .concat(w.extra.map((x) => [k, x.name, x.amount || '', 'Other', x.checked ? 'Yes' : '']));
        }),
      },
      'Meal Plan': {
        headers: ['Week of', 'Day', 'Meal', 'Recipe'],
        rows: weeks.flatMap((k) => {
          const w = weekOf(td, k);
          return DAYS.flatMap((day, i) => SLOTS.map(([slot, label]) => {
            const r = td.recipes.find((x) => x.id === w.meals[`d${i}:${slot}`]);
            return r ? [k, `${day} ${addDays(k, i).slice(5)}`, label, r.name] : null;
          }).filter(Boolean));
        }),
      },
    };
  }

  // ---------- Shared pieces ----------

  function weekBar(ctx) {
    const el = document.createElement('div');
    el.className = 'period-bar food-week';
    const id = ctx.ui.week;
    const now = weekStart(new Date());
    el.innerHTML = `
      <button class="icon-btn round" data-step="-1" aria-label="Previous week">‹</button>
      <h1>${esc(weekLabel(id))}</h1>
      <button class="icon-btn round" data-step="1" aria-label="Next week">›</button>
      ${id === now ? '' : '<button class="link-btn" data-today>This week</button>'}`;
    el.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      ctx.ui.week = btn.hasAttribute('data-today') ? now : addDays(id, 7 * Number(btn.dataset.step));
      ctx.rerender();
      const again = document.querySelector(`.food-week [data-step="${btn.dataset.step || -1}"]`);
      if (again) again.focus();
    });
    return el;
  }

  function cardHead(icon, color, title, extra) {
    return `<div class="card-head"><h2 class="card-title"><span class="badge" style="--tint:${color}" aria-hidden="true">${icon}</span>${title}</h2>${extra || ''}</div>`;
  }

  function recipeOptions(td, selected, { none = '—' } = {}) {
    return `<option value=""${selected ? '' : ' selected'}>${esc(none)}</option>`
      + td.recipes.map((r) => `<option value="${esc(r.id)}"${r.id === selected ? ' selected' : ''}>${esc(r.name || 'Untitled recipe')}</option>`).join('');
  }

  function foodOptions(td, selected) {
    const groups = Foods.AISLES.map((aisle) => {
      const foods = allFoods(td).filter((f) => (f.aisle || 'Other') === aisle);
      return foods.length ? `<optgroup label="${esc(aisle)}">${foods.map((f) => `<option value="${esc(f.id)}"${f.id === selected ? ' selected' : ''}>${esc(f.name)}${f.builtin ? '' : ' ★'}</option>`).join('')}</optgroup>` : '';
    }).join('');
    return `<option value=""${selected ? '' : ' selected'}>Choose a food…</option>${groups}`;
  }

  const macroLine = (t) => `${fmt1(t.kcal)} kcal · P ${fmt1(t.protein)} g · C ${fmt1(t.carbs)} g · F ${fmt1(t.fat)} g`;

  // ---------- Look ----------
  // Slot tints and emoji are decoration only; every slot is also labelled in text.
  const SLOT_LOOK = {
    breakfast: { icon: '🍳', tint: 'var(--s4)' }, lunch: { icon: '🥗', tint: 'var(--s3)' },
    dinner: { icon: '🍲', tint: 'var(--s7)' }, snack: { icon: '🍎', tint: 'var(--s5)' },
  };
  const AISLE_ICON = {
    'Meat & fish': '🥩', 'Dairy & eggs': '🥛', 'Grains & bread': '🍞', 'Legumes & tofu': '🫘', 'Vegetables': '🥦',
    'Fruit': '🍎', 'Pantry': '🫙', 'Frozen': '🧊', 'Other': '🛍',
  };
  // Macro colors: three adjacent slots of the validated chart palette, always with labels.
  const MACRO_COLORS = { protein: 'var(--s1)', carbs: 'var(--s2)', fat: 'var(--s3)' };

  function recipeEmoji(r) {
    const n = String((r && r.name) || '').toLowerCase();
    const pairs = [[/chicken|עוף|turkey|הודו/, '🍗'], [/beef|steak|burger|meat|בשר/, '🥩'], [/salmon|tuna|fish|tilapia|דג|טונה/, '🐟'],
      [/shrimp/, '🦐'], [/egg|omelet|shakshuka|ביצ|שקשוקה/, '🍳'], [/oat|porridge|granola|שיבולת/, '🥣'], [/pasta|spaghetti|פסטה/, '🍝'],
      [/rice|אורז/, '🍚'], [/salad|סלט/, '🥗'], [/soup|מרק/, '🍲'], [/pizza/, '🍕'], [/wrap|tortilla|taco/, '🌯'], [/sandwich|toast|כריך/, '🥪'],
      [/smoothie|shake/, '🥤'], [/yogurt|יוגורט/, '🥛'], [/fruit|banana|apple/, '🍌']];
    const hit = pairs.find(([re]) => re.test(n));
    return hit ? hit[1] : '🍽';
  }

  // Calories from each macro (4/4/9 kcal per gram) as a split bar with labels.
  function macroSplit(t, { compact } = {}) {
    const parts = [['protein', 'Protein', t.protein * 4], ['carbs', 'Carbs', t.carbs * 4], ['fat', 'Fat', t.fat * 9]];
    const total = sum(parts.map((x) => x[2]));
    if (!total) return '';
    return `<div class="macro-split" role="img" aria-label="${parts.map(([k, l]) => `${l} ${fmt1(t[k])} g`).join(', ')}">
        ${parts.map(([k, l, kc]) => (kc > 0 ? `<span style="flex-grow:${kc};background:${MACRO_COLORS[k]}" title="${l} ${fmt1(t[k])} g"></span>` : '')).join('')}
      </div>
      ${compact ? '' : `<div class="macro-chips">${parts.map(([k, l, kc]) => `<span class="macro-chip"><i style="background:${MACRO_COLORS[k]}"></i>${l} <strong>${fmt1(t[k])} g</strong><em>${Math.round(kc / total * 100)}%</em></span>`).join('')}</div>`}`;
  }

  // A progress ring (meter): value against a target, with the number in the middle.
  function ring(value, target, label, unit, tint) {
    const r = 30, c = 2 * Math.PI * r;
    const share = target > 0 ? Math.min(value / target, 1) : 0;
    const over = target > 0 && value > target * 1.05;
    return `<div class="ring${over ? ' over' : ''}" style="--tint:${tint || 'var(--s3)'}" role="img" aria-label="${esc(label)}: ${fmt1(value)}${unit}${target ? ` of ${fmt1(target)}${unit}` : ''}${over ? ', over target' : ''}">
        <svg viewBox="0 0 72 72"><circle cx="36" cy="36" r="${r}" class="ring-track"/>
          ${target > 0 ? `<circle cx="36" cy="36" r="${r}" class="ring-fill" stroke-dasharray="${(share * c).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 36 36)"/>` : ''}</svg>
        <div class="ring-text"><strong>${fmt1(value)}</strong><span>${target > 0 ? `/ ${fmt1(target)}${unit.trim() === 'kcal' ? '' : unit}` : unit.trim()}</span></div>
        <div class="ring-label">${esc(label)}${over ? '<span class="over-tag">⚠ over</span>' : ''}</div>
      </div>`;
  }

  const personColor = (td, p) => PERSON_COLORS[Math.max(0, td.people.indexOf(p)) % PERSON_COLORS.length];
  const avatar = (name, color, cls) => `<span class="avatar ${cls || 'sm'}" style="background:${color}" aria-hidden="true">${esc(Fmt.initials(name || '?'))}</span>`;
  const isToday = (wid, i) => addDays(wid, i) === isoDay(new Date());

  // The week as a list of days with their planned meals (Plan → Week, and the Summary).
  function agendaHtml(td, w, wid, { interactive } = {}) {
    const tag = interactive ? 'button' : 'div';
    return `<ol class="agenda">${DAYS.map((day, i) => {
      const date = dayOf(addDays(wid, i));
      const meals = SLOTS.map(([slot, label]) => ({ slot, label, r: td.recipes.find((x) => x.id === w.meals[`d${i}:${slot}`]) })).filter((m) => m.r);
      const open = (label) => (interactive ? ` data-action="open-day" data-day="${i}" aria-label="${esc(label)}"` : '');
      return `<li class="agenda-day${isToday(wid, i) ? ' today' : ''}">
        <${tag} class="agenda-date"${open(`Open ${day} ${date.getDate()} ${MONTHS[date.getMonth()]}`)}><span>${day.slice(0, 3)}</span><strong>${date.getDate()}</strong>${isToday(wid, i) ? '<em>Today</em>' : ''}</${tag}>
        <div class="agenda-meals">
          ${meals.map((m) => `<${tag} class="agenda-meal" style="--tint:${SLOT_LOOK[m.slot].tint}"${open(`${day} ${m.label.toLowerCase()}: ${m.r.name || 'Untitled recipe'}`)}>
            <span class="am-emoji" aria-hidden="true">${recipeEmoji(m.r)}</span><span class="am-text"><small>${m.label}</small><span class="am-name">${esc(m.r.name || 'Untitled recipe')}</span></span></${tag}>`).join('')}
          ${meals.length ? '' : '<span class="agenda-free">Nothing planned</span>'}
          ${interactive && meals.length < SLOTS.length ? `<button class="agenda-add" data-action="open-day" data-day="${i}" aria-label="Plan ${day}">+ Plan</button>` : ''}
        </div>
        <div class="agenda-kcal">${meals.length ? td.people.map((p) => {
          const d = personDay(td, p, w, i);
          return `<span>${avatar(p.name, personColor(td, p), 'xs')}<span><strong>${esc(p.name || 'Unnamed')}</strong> ${fmt1(d.totals.kcal)} kcal · P ${fmt1(d.totals.protein)} g</span></span>`;
        }).join('') : ''}</div>
      </li>`;
    }).join('')}</ol>`;
  }

  // ---------- Plan screen ----------

  const TABS = [['menu', '🗓', 'Menu'], ['groceries', '🛒', 'Groceries'], ['recipes', '📖', 'Recipes'], ['people', '👥', 'People'], ['foods', '🥦', 'Foods']];

  function wideMain(root) { const main = root.closest('.main'); if (main) main.classList.add('food-main'); }

  function ensureWeek(ctx) { if (!ctx.ui.week) ctx.ui.week = weekStart(new Date()); }

  function renderInput(root, ctx) {
    const td = topicData(ctx);
    ensureWeek(ctx);
    const wid = ctx.ui.week;
    const w = weekOf(td, wid);
    if (!TABS.some(([id]) => id === ctx.ui.foodTab)) ctx.ui.foodTab = 'menu';
    const tab = ctx.ui.foodTab;

    const persistWeek = () => {
      if (weekHasContent(w) || Object.keys(w.checked).length) td.weeks[wid] = w;
      else delete td.weeks[wid];
      ctx.changed();
    };

    wideMain(root);
    root.append(weekBar(ctx));
    const view = document.createElement('div');
    view.className = 'stack';
    view.innerHTML = `
      <div class="input-tabs-row">
        <div class="input-tabs" role="tablist" aria-label="Food sections">
          ${TABS.map(([id, icon, label]) => `<button class="input-tab" role="tab" data-tab="${id}" aria-selected="${id === tab}" tabindex="${id === tab ? 0 : -1}"><span class="tab-icon" aria-hidden="true">${icon}</span>${label}</button>`).join('')}
        </div>
      </div>
      ${TABS.map(([id]) => `<section class="${id === 'menu' ? 'tab-panel planner' : 'card tab-panel'}" data-panel="${id}"${id === tab ? '' : ' hidden'}></section>`).join('')}`;
    root.append(view);
    const panel = (id) => view.querySelector(`[data-panel="${id}"]`);

    function selectTab(id, focus) {
      ctx.ui.foodTab = id;
      view.querySelectorAll('[data-tab]').forEach((b) => {
        const on = b.dataset.tab === id;
        b.setAttribute('aria-selected', String(on));
        b.tabIndex = on ? 0 : -1;
        if (on && focus) b.focus();
      });
      view.querySelectorAll('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== id; });
      draw(id);
    }
    view.querySelector('.input-tabs').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) selectTab(b.dataset.tab); });
    view.querySelector('.input-tabs').addEventListener('keydown', (e) => {
      const ids = TABS.map(([id]) => id);
      const i = ids.indexOf(ctx.ui.foodTab);
      const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: ids.length - 1 }[e.key];
      if (next == null) return;
      e.preventDefault();
      selectTab(ids[(next + ids.length) % ids.length], true);
    });

    function draw(id) { ({ menu: drawMenu, groceries: drawGroceries, recipes: drawRecipes, people: drawPeople, foods: drawFoods })[id](); }

    function newRecipe(name) {
      const r = { id: Fmt.uid(), name: name || '', video: '', steps: '', ingredients: [] };
      td.recipes.push(r);
      ctx.changed();
      return r;
    }

    // --- Menu ---
    // A strip of the 7 days, the chosen day's meals as cards (or the whole week as a list), and a side
    // panel with that day's calories/macros per person, the meal-prep quick fill and the week's progress.
    function dayIndex() {
      if (ctx.ui.foodDayWeek !== wid || !(ctx.ui.foodDay >= 0 && ctx.ui.foodDay <= 6)) {
        const today = DAYS.findIndex((_, i) => isToday(wid, i));
        const planned = DAYS.findIndex((_, i) => dayRecipes(td, w, i).length);
        ctx.ui.foodDay = today >= 0 ? today : Math.max(0, planned);
        ctx.ui.foodDayWeek = wid;
      }
      return ctx.ui.foodDay;
    }

    function prepState() {
      if (!ctx.ui.prep) ctx.ui.prep = { recipe: '', slot: 'lunch', days: [0, 1, 2] };
      if (ctx.ui.prep.recipe && !td.recipes.some((r) => r.id === ctx.ui.prep.recipe)) ctx.ui.prep.recipe = '';
      return ctx.ui.prep;
    }

    // Recipes to offer in an empty slot: the ones already on this week's menu (same meal first).
    function suggestions(slot) {
      const score = new Map();
      Object.entries(w.meals).forEach(([k, id]) => { if (id) score.set(id, (score.get(id) || 0) + (k.endsWith(':' + slot) ? 10 : 1)); });
      return td.recipes.slice().sort((a, b) => (score.get(b.id) || 0) - (score.get(a.id) || 0)).slice(0, 2);
    }

    const plannedCount = () => sum(DAYS.map((_, i) => dayRecipes(td, w, i).length));
    const portionText = (f) => (f === 1 ? '1 portion' : `${f} portions`);

    function weekStripHtml(sel) {
      return `<div class="week-strip" role="tablist" aria-label="Days of the week">${DAYS.map((day, i) => {
        const date = dayOf(addDays(wid, i));
        const filled = SLOTS.filter(([slot]) => td.recipes.some((r) => r.id === w.meals[`d${i}:${slot}`])).map(([slot]) => slot);
        const n = filled.length;
        const count = n ? `${n} meal${n > 1 ? 's' : ''}` : 'Not planned';
        return `<button class="day-pill${isToday(wid, i) ? ' today' : ''}" role="tab" data-action="pick-day" data-day="${i}" aria-selected="${i === sel}" tabindex="${i === sel ? 0 : -1}"
            aria-controls="day-plan" aria-label="${day} ${date.getDate()} ${MONTHS[date.getMonth()]}${isToday(wid, i) ? ', today' : ''}: ${count}">
          ${isToday(wid, i) ? '<span class="dp-today" aria-hidden="true">Today</span>' : ''}
          <span class="dp-dow" aria-hidden="true">${day.slice(0, 3)}</span>
          <span class="dp-num" aria-hidden="true">${date.getDate()}</span>
          <span class="dp-dots" aria-hidden="true">${SLOTS.map(([slot]) => (filled.includes(slot) ? `<i class="on" style="--tint:${SLOT_LOOK[slot].tint}"></i>` : '<i></i>')).join('')}</span>
          <span class="dp-meta" aria-hidden="true">${count}</span>
        </button>`;
      }).join('')}</div>`;
    }

    function amountsHtml(r, i) {
      const people = td.people.length ? td.people : [null];
      const factors = people.map((p) => personDay(td, p, w, i).factor);
      const all = sum(factors);
      const g = (food, grams) => {
        const n = food.piece ? Math.round((grams / food.piece) * 10) / 10 : 0;
        const v = grams <= 0 ? 0 : grams < 20 ? Math.max(1, Math.round(grams)) : Math.round(grams / 5) * 5;
        return `${fmt1(v)} g${n ? ` <span class="muted">· ${n} ${esc(food.pieceName || 'pc')}${n === 1 ? '' : 's'}</span>` : ''}`;
      };
      const rows = r.ingredients.map((ing) => ({ food: foodById(td, ing.food), grams: num(ing.grams) })).filter((x) => x.food);
      if (!rows.length) return '<div class="meal-amounts"><p class="empty">This recipe has no ingredients yet. Add them in the Recipes tab.</p></div>';
      return `<div class="meal-amounts">
        <table class="amounts-table">
          <thead><tr><th scope="col">Ingredient</th>${people.length > 1 ? '<th scope="col" class="num">Cook in total</th>' : ''}${people.map((p) => `<th scope="col" class="num">${p ? esc(p.name || 'Unnamed') : '1 portion'}</th>`).join('')}</tr></thead>
          <tbody>${rows.map((x) => `<tr><th scope="row">${esc(x.food.name)}</th>${people.length > 1 ? `<td class="num total">${g(x.food, x.grams * all)}</td>` : ''}${factors.map((f) => `<td class="num">${g(x.food, x.grams * f)}</td>`).join('')}</tr>`).join('')}</tbody>
        </table>
      </div>`;
    }

    function mealCardHtml(i, slot, label) {
      const key = `d${i}:${slot}`;
      const r = td.recipes.find((x) => x.id === w.meals[key]);
      const look = SLOT_LOOK[slot];
      const day = DAYS[i];
      if (!r) {
        const chips = td.recipes.length ? suggestions(slot) : [];
        return `<div class="meal-card empty" style="--tint:${look.tint}">
          <div class="meal-thumb" aria-hidden="true">${look.icon}</div>
          <div class="meal-main">
            <div class="meal-slot-name">${label}</div>
            <div class="meal-empty-text">Nothing planned yet</div>
            ${chips.length ? `<div class="suggest-chips">${chips.map((s) => `<button class="suggest-chip" data-action="quick-add" data-add-cell="${key}" data-recipe="${esc(s.id)}" aria-label="Add ${esc(s.name || 'Untitled recipe')} for ${day} ${label.toLowerCase()}"><span aria-hidden="true">${recipeEmoji(s)}</span><span class="sc-name" title="${esc(s.name || 'Untitled recipe')}">${esc(s.name || 'Untitled recipe')}</span></button>`).join('')}</div>` : ''}
          </div>
          <div class="meal-actions">
            <span class="select-wrap"><span class="btn btn-small select-btn add" aria-hidden="true">+ Add ${label.toLowerCase()}</span>
              <select class="slot-select" data-cell="${key}" aria-label="${day} ${label.toLowerCase()}: choose a recipe">${recipeOptions(td, '', { none: '— Nothing —' })}</select></span>
          </div>
        </div>`;
      }
      const t = recipeTotals(td, r);
      const yt = ytId(r.video);
      const hasVideo = /^https?:\/\//i.test(r.video || '');
      const open = !!(ctx.ui.openAmounts || {})[key];
      const name = esc(r.name || 'Untitled recipe');
      return `<article class="meal-card filled" style="--tint:${look.tint}" data-meal="${key}">
        <div class="meal-thumb${yt ? ' has-thumb' : ''}">
          ${yt ? `<img src="https://img.youtube.com/vi/${esc(yt)}/mqdefault.jpg" alt="" loading="lazy">` : `<span aria-hidden="true">${recipeEmoji(r)}</span>`}
          ${hasVideo ? `<a class="play-mini" href="${esc(r.video)}" target="_blank" rel="noopener noreferrer" aria-label="Watch the video for ${name}">▶</a>` : ''}
        </div>
        <div class="meal-main">
          <div class="meal-slot-name"><span aria-hidden="true">${look.icon}</span> ${label}</div>
          <h3 class="meal-title">${name}</h3>
          <div class="meal-facts">
            <span class="fact"><strong>${fmt1(t.kcal)}</strong> kcal</span>
            ${[['protein', 'Protein'], ['carbs', 'Carbs'], ['fat', 'Fat']].map(([k, l]) => `<span class="fact"><i style="background:${MACRO_COLORS[k]}" aria-hidden="true"></i>${l} <strong>${fmt1(t[k])} g</strong></span>`).join('')}
            <span class="fact-note">per portion</span>
          </div>
          <div class="meal-portions">
            ${td.people.map((p) => {
              const f = personDay(td, p, w, i).factor;
              return `<span class="portion">${avatar(p.name, personColor(td, p), 'xs')}<span><strong>${esc(p.name || 'Unnamed')}</strong> ${portionText(f).replace(' ', '&nbsp;')} · ${fmt1(t.kcal * f)}&nbsp;kcal · P&nbsp;${fmt1(t.protein * f)}&nbsp;g</span></span>`;
            }).join('')}
            <button class="link-btn amounts-btn" data-action="toggle-amounts" data-key="${key}" aria-expanded="${open}" aria-label="${open ? 'Hide amounts' : 'Amounts to cook'} for ${name}">${open ? 'Hide amounts' : 'Amounts to cook'}</button>
          </div>
        </div>
        <div class="meal-actions">
          <span class="select-wrap"><span class="btn btn-small select-btn" aria-hidden="true">⇄ Change</span>
            <select class="slot-select" data-cell="${key}" aria-label="${day} ${label.toLowerCase()}: ${name}. Change the recipe">${recipeOptions(td, r.id, { none: '— Nothing —' })}</select></span>
          <button class="btn btn-small" data-action="repeat-meal" data-slot="${slot}" data-recipe="${esc(r.id)}" aria-label="Repeat ${name} on other days"><span aria-hidden="true">↻</span> Repeat</button>
        </div>
        <button class="icon-btn del meal-del" data-action="clear-meal" data-key="${key}" aria-label="Remove ${name} from ${day} ${label.toLowerCase()}">✕</button>
        ${open ? amountsHtml(r, i) : ''}
      </article>`;
    }

    function nutriPersonHtml(p, i) {
      const d = personDay(td, p, w, i);
      const color = p ? personColor(td, p) : 'var(--other)';
      const mode = p ? p.scale || 'protein' : 'none';
      const rows = MACROS.map(([k, label, unit]) => {
        const target = p ? num(p[k]) : 0;
        const v = d.totals[k];
        const over = target > 0 && v > target * 1.05 && !(k === mode && d.factor > 0.25);
        const tint = k === 'kcal' ? 'var(--s4)' : MACRO_COLORS[k];
        return `<div class="nutri-row${over ? ' over' : ''}">
          <span class="nutri-label"><i style="background:${tint}" aria-hidden="true"></i>${label}</span>
          ${target > 0 ? `<span class="nutri-bar" role="img" aria-label="${label}: ${fmt1(v)} of ${fmt1(target)} ${unit}"><span style="width:${Math.min(v / target, 1) * 100}%;background:${tint}"></span></span>` : '<span class="nutri-bar none" aria-hidden="true"></span>'}
          <span class="nutri-val"><strong>${fmt1(v)}</strong>${target > 0 ? ` / ${fmt1(target)}` : ''} ${unit}${over ? ' <span class="over-tag">⚠ over</span>' : ''}</span>
        </div>`;
      }).join('');
      return `<div class="nutri-person">
        <div class="nutri-head">${avatar(p ? p.name : '1', color, 'xs')}<strong>${p ? esc(p.name || 'Unnamed') : '1 portion of each meal'}</strong>
          ${p ? `<span class="factor" title="Every meal of the day is scaled by this">${portionText(d.factor)}</span>` : ''}</div>
        ${rows}
      </div>`;
    }

    function sideHtml(sel, mode) {
      const pr = prepState();
      const date = dayOf(addDays(wid, sel));
      const planned = plannedCount();
      const list = groceries(td, w);
      const gTotal = list.length + w.extra.length;
      const gDone = list.filter((g) => w.checked[g.food.id]).length + w.extra.filter((x) => x.checked).length;
      const prev = td.weeks[addDays(wid, -7)];
      const nDays = pr.days.length;
      return `<aside class="planner-side">
        ${mode === 'day' ? `<section class="card side-card nutri-card">
          <h3 class="side-title">Nutrition <span class="muted">· ${DAYS[sel].slice(0, 3)} ${date.getDate()} ${SHORT_MONTHS[date.getMonth()]}</span></h3>
          ${dayRecipes(td, w, sel).length
            ? (td.people.length ? td.people.map((p) => nutriPersonHtml(p, sel)).join('') : `${nutriPersonHtml(null, sel)}<p class="hint side-hint">Add people in the People tab to scale portions to their targets.</p>`)
            : `<p class="muted side-empty">Plan a meal to see ${DAYS[sel]}'s calories and macros${td.people.length ? ' per person' : ''}.</p>`}
        </section>` : ''}
        <section class="card side-card prep-card" id="meal-prep">
          <h3 class="side-title"><span class="badge" style="--tint:var(--s4)" aria-hidden="true">⚡</span>Meal prep</h3>
          <p class="hint">Put the same meal on several days, like chicken & rice for lunch Sunday to Tuesday.</p>
          <label class="field"><span>Recipe</span><select class="select" data-fill="recipe">${recipeOptions(td, pr.recipe, { none: 'Choose a recipe…' })}</select></label>
          <label class="field"><span>Meal</span><select class="select" data-fill="slot">${SLOTS.map(([sl, l]) => `<option value="${sl}"${sl === pr.slot ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
          <fieldset class="field prep-days"><legend>Days</legend>
            <span class="day-chips">${DAYS.map((d, i) => `<label class="day-chip"><input type="checkbox" data-fill-day="${i}"${pr.days.includes(i) ? ' checked' : ''}><span>${d.slice(0, 3)}</span></label>`).join('')}</span>
          </fieldset>
          <button class="btn btn-primary prep-go" data-action="fill">${nDays ? `Add to ${nDays} day${nDays > 1 ? 's' : ''}` : 'Choose days'}</button>
        </section>
        <section class="card side-card week-card">
          <h3 class="side-title">This week</h3>
          <div class="week-meter"><span>Meals planned</span><strong>${planned} / ${7 * SLOTS.length}</strong></div>
          <div class="shop-bar" role="img" aria-label="${planned} of ${7 * SLOTS.length} meals planned"><span style="width:${(planned / (7 * SLOTS.length)) * 100}%"></span></div>
          <div class="week-meter"><span>Groceries bought</span><strong>${gDone} / ${gTotal}</strong></div>
          <div class="shop-bar" role="img" aria-label="${gDone} of ${gTotal} groceries bought"><span style="width:${gTotal ? (gDone / gTotal) * 100 : 0}%"></span></div>
          <div class="btn-row side-btns">
            <button class="btn btn-small" data-action="go-groceries">🛒 Grocery list</button>
            ${!weekHasContent(w) && prev && Object.values(prev.meals || {}).some((id) => td.recipes.some((r) => r.id === id)) ? '<button class="btn btn-small" data-action="copy-week">Copy last week</button>' : ''}
          </div>
        </section>
      </aside>`;
    }

    function drawMenu() {
      const el = panel('menu');
      const sel = dayIndex();
      const mode = ctx.ui.menuMode === 'week' ? 'week' : 'day';
      const date = dayOf(addDays(wid, sel));
      const n = dayRecipes(td, w, sel).length;
      el.innerHTML = `
        <div class="planner-top">
          <div class="segmented menu-modes" role="group" aria-label="Show">
            <button data-action="menu-mode" data-mode="day" aria-pressed="${mode === 'day'}">Day</button>
            <button data-action="menu-mode" data-mode="week" aria-pressed="${mode === 'week'}">Week</button>
          </div>
          <span class="pill-stat"><strong>${plannedCount()}</strong> of ${7 * SLOTS.length} meals planned</span>
        </div>
        ${mode === 'day' ? weekStripHtml(sel) : ''}
        <div class="planner-grid">
          ${mode === 'day' ? `<section class="card day-plan" id="day-plan" role="tabpanel" aria-labelledby="day-title">
            <div class="day-plan-head">
              <div>
                <div class="day-kicker">${isToday(wid, sel) ? 'Today · ' : ''}${n} of ${SLOTS.length} meals planned</div>
                <h2 class="day-title" id="day-title" tabindex="-1">${DAYS[sel]}, ${date.getDate()} ${MONTHS[date.getMonth()]}</h2>
              </div>
              <div class="day-steps">
                <button class="icon-btn round" data-action="day-step" data-step="-1" aria-label="Previous day">‹</button>
                <button class="icon-btn round" data-action="day-step" data-step="1" aria-label="Next day">›</button>
              </div>
            </div>
            <div class="meal-list">${SLOTS.map(([slot, label]) => mealCardHtml(sel, slot, label)).join('')}</div>
          </section>` : `<section class="card week-plan">
            ${cardHead('🗓', 'var(--s4)', 'Menu of the week', '<span class="muted">Pick a day to change its meals</span>')}
            ${agendaHtml(td, w, wid, { interactive: true })}
          </section>`}
          ${sideHtml(sel, mode)}
        </div>

        <details class="card totals-details"${ctx.ui.openTotals ? ' open' : ''}>
          <summary class="details-summary">Daily totals per person (table)${td.people.length ? '' : ' · add people in the People tab to scale portions'}</summary>
          <div id="day-totals"></div>
        </details>`;
      el.querySelector('.totals-details').ontoggle = (e) => { ctx.ui.openTotals = e.target.open; };
      drawTotals();
    }

    function redrawMenu(focusSel) {
      drawMenu();
      const again = focusSel && view.querySelector(focusSel);
      if (again) again.focus();
    }

    function stepDay(step) {
      const i = dayIndex() + step;
      if (i >= 0 && i <= 6) { ctx.ui.foodDay = i; redrawMenu(`[data-action="day-step"][data-step="${step}"]`); return; }
      ctx.ui.week = addDays(wid, step * 7);
      ctx.ui.foodDayWeek = ctx.ui.week;
      ctx.ui.foodDay = i < 0 ? 6 : 0;
      ctx.rerender();
      const again = document.querySelector(`[data-action="day-step"][data-step="${step}"]`);
      if (again) again.focus();
    }

    function drawTotals() {
      const box = view.querySelector('#day-totals');
      if (!box) return;
      const people = td.people.length ? td.people : [null];
      box.innerHTML = `<div class="table-scroll"><table class="preview-table totals-table">
        <thead><tr><th>Person</th>${DAYS.map((_, i) => `<th>${esc(dayLabel(wid, i))}</th>`).join('')}</tr></thead>
        <tbody>${people.map((p) => `<tr><th scope="row">${p ? esc(p.name || 'Unnamed') : '1 portion each'}${p && (p.scale || 'protein') !== 'none' && num(p[p.scale || 'protein']) ? `<span class="muted"> · ${fmt1(num(p[p.scale || 'protein']))}${p.scale === 'kcal' ? ' kcal' : ' g protein'}</span>` : ''}</th>
          ${DAYS.map((_, i) => {
            const d = personDay(td, p, w, i);
            if (!d.meals) return '<td class="muted">—</td>';
            return `<td><strong>${fmt1(d.totals.kcal)}</strong> kcal<br><span class="muted">P ${fmt1(d.totals.protein)} · C ${fmt1(d.totals.carbs)} · F ${fmt1(d.totals.fat)}</span>${d.factor !== 1 ? `<br><span class="tag">×${d.factor} portions</span>` : ''}</td>`;
          }).join('')}</tr>`).join('')}</tbody>
      </table></div>`;
    }

    // --- Groceries ---
    function drawGroceries() {
      const el = panel('groceries');
      const list = groceries(td, w);
      const byAisle = new Map();
      list.forEach((g) => { const a = g.food.aisle || 'Other'; if (!byAisle.has(a)) byAisle.set(a, []); byAisle.get(a).push(g); });
      const total = list.length + w.extra.length;
      const done = list.filter((g) => w.checked[g.food.id]).length + w.extra.filter((x) => x.checked).length;
      const share = total ? done / total : 0;
      el.innerHTML = `
        ${cardHead('🛒', 'var(--s3)', 'Grocery list', `<div class="btn-row head-btns"><button class="btn btn-small" data-action="copy-list">📋 Copy list</button>
          ${done ? '<button class="btn btn-small" data-action="clear-checks">Untick all</button>' : ''}</div>`)}
        <div class="shop-progress">
          <div class="shop-bar" role="progressbar" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${done}" aria-label="Bought"><span style="width:${share * 100}%"></span></div>
          <span><strong>${done}</strong> of ${total} bought${total && done === total ? ' 🎉' : ''}</span>
        </div>
        <p class="hint">Built from this week's menu: every meal × every person's portions, rounded up.
          ${ctx.storage === 'sheets' ? 'It’s also in the <strong>Groceries</strong> tab of your Google Sheet.' : 'Connect Google Sheets (Settings → Where data is stored) to get it in a sheet too.'}</p>
        ${list.length ? `<div class="aisle-grid">${[...byAisle.entries()].map(([aisle, items]) => `
          <section class="aisle-card">
            <h3 class="aisle-title"><span aria-hidden="true">${AISLE_ICON[aisle] || '🛍'}</span> ${esc(aisle)}<span class="aisle-count">${items.filter((g) => w.checked[g.food.id]).length}/${items.length}</span></h3>
            ${items.map((g) => `
              <label class="grocery-row${w.checked[g.food.id] ? ' done' : ''}"><input type="checkbox" data-buy="${esc(g.food.id)}"${w.checked[g.food.id] ? ' checked' : ''}>
                <span class="check-dot" aria-hidden="true"></span>
                <span class="grocery-name">${esc(g.food.name)}</span><span class="grocery-amount">${esc(amountText(g.food, g.grams))}</span></label>`).join('')}
          </section>`).join('')}</div>`
          : '<div class="empty-state small"><div class="empty-illustration" aria-hidden="true">🛒</div><p>Nothing yet. Plan some meals in the Menu tab and the list fills itself.</p></div>'}
        <section class="aisle-card other-card">
          <h3 class="aisle-title"><span aria-hidden="true">🛍</span> Other things to buy</h3>
          ${w.extra.map((x) => `
            <div class="grocery-row extra${x.checked ? ' done' : ''}" data-extra="${esc(x.id)}"><input type="checkbox" data-extra-check aria-label="Bought"${x.checked ? ' checked' : ''}>
              <input class="name-input" data-extra-field="name" value="${esc(x.name)}" placeholder="e.g. Dish soap" aria-label="Item">
              <input class="name-input amount-input" data-extra-field="amount" value="${esc(x.amount || '')}" placeholder="Amount" aria-label="Amount">
              <button class="icon-btn del" data-action="del-extra" aria-label="Remove item">✕</button></div>`).join('')}
          <button class="add-btn" data-action="add-extra">+ Add item</button>
        </section>`;
    }

    function listText() {
      const lines = [`Groceries — ${weekLabel(wid)}`];
      groceries(td, w).forEach((g) => { if (!w.checked[g.food.id]) lines.push(`☐ ${g.food.name} — ${amountText(g.food, g.grams)}`); });
      w.extra.forEach((x) => { if (!x.checked && x.name) lines.push(`☐ ${x.name}${x.amount ? ` — ${x.amount}` : ''}`); });
      return lines.join('\n');
    }

    // --- Recipes ---
    function ytId(url) { const m = String(url || '').match(/(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)([\w-]{6,})/); return m ? m[1] : ''; }

    function drawRecipes() {
      const el = panel('recipes');
      const used = (r) => Object.values(w.meals).filter((x) => x === r.id).length;
      el.innerHTML = `
        ${cardHead('📖', 'var(--s7)', 'Recipes', `<span class="muted">${td.recipes.length} recipes · amounts are for 1 portion</span>`)}
        <div class="recipe-grid">${td.recipes.map((r, idx) => {
          const open = ctx.ui.openRecipe === r.id;
          const t = recipeTotals(td, r);
          const yt = ytId(r.video);
          const hasVideo = /^https?:\/\//i.test(r.video || '');
          return `<article class="recipe-card${open ? ' open' : ''}" data-recipe="${esc(r.id)}" style="--tint:${PERSON_COLORS[idx % PERSON_COLORS.length]}">
            <div class="recipe-media${yt ? ' has-thumb' : ''}">
              ${yt ? `<img src="https://img.youtube.com/vi/${esc(yt)}/hqdefault.jpg" alt="" loading="lazy">` : `<span class="recipe-emoji" aria-hidden="true">${recipeEmoji(r)}</span>`}
              ${hasVideo ? `<a class="play-btn" href="${esc(r.video)}" target="_blank" rel="noopener noreferrer" aria-label="Watch the video for ${esc(r.name || 'this recipe')}">▶</a>` : ''}
              ${used(r) ? `<span class="used-tag">${used(r)}× this week</span>` : ''}
            </div>
            <div class="recipe-body">
              <div class="recipe-title-row">
                <h3 class="recipe-title">${esc(r.name || 'Untitled recipe')}</h3>
                <span class="recipe-kcal"><strong class="recipe-kcal-num">${fmt1(t.kcal)}</strong> kcal</span>
              </div>
              <div class="recipe-macros">${macroSplit(t)}</div>
              ${!open && r.steps ? `<p class="recipe-steps">${esc(r.steps)}</p>` : ''}
              <div class="recipe-actions">
                <button class="btn btn-small" data-action="toggle-recipe">${open ? 'Done' : '✎ Edit'}</button>
                ${hasVideo ? `<a class="btn btn-small" href="${esc(r.video)}" target="_blank" rel="noopener noreferrer">▶ Video</a>` : ''}
                <span class="muted ing-count">${r.ingredients.length} ingredient${r.ingredients.length === 1 ? '' : 's'}</span>
              </div>
            </div>
            ${open ? `
            <div class="recipe-edit">
              <div class="edit-grid">
                <label class="field"><span>Name</span><input class="text-input" data-r="name" value="${esc(r.name)}" placeholder="e.g. Chicken breast & rice"></label>
                <label class="field"><span>Video link</span><input class="text-input" data-r="video" type="url" value="${esc(r.video || '')}" placeholder="https://www.youtube.com/watch?v=…"></label>
              </div>
              <div class="field"><span>Ingredients (1 portion)</span>
                <div class="rows">${r.ingredients.map((i) => `
                  <div class="row ingredient-row" data-ing="${esc(i.id)}">
                    <select class="select" data-ing-field="food" aria-label="Food">${foodOptions(td, i.food)}</select>
                    <div class="money-field"><input data-ing-field="grams" type="number" min="0" step="any" value="${esc(i.grams)}" aria-label="Grams"><span class="affix">g</span></div>
                    <span class="muted ing-note">${(() => { const f = foodById(td, i.food); return f && f.piece ? `≈ ${Math.round(num(i.grams) / f.piece * 10) / 10} ${esc(f.pieceName)}` : ''; })()}</span>
                    <button class="icon-btn del" data-action="del-ing" aria-label="Remove ingredient">✕</button>
                  </div>`).join('') || '<p class="empty">No ingredients yet.</p>'}</div>
                <button class="add-btn" data-action="add-ing">+ Add ingredient</button>
              </div>
              <label class="field"><span>How to make it</span><textarea class="text-input" rows="3" data-r="steps" placeholder="Steps, tips…">${esc(r.steps || '')}</textarea></label>
              <div class="btn-row"><button class="btn btn-small btn-danger" data-action="del-recipe">Delete recipe</button></div>
            </div>` : ''}
          </article>`;
        }).join('')}
          <button class="recipe-card new-recipe" data-action="add-recipe"><span class="recipe-emoji" aria-hidden="true">＋</span><strong>New recipe</strong><span class="muted">Ingredients, steps and a video link</span></button>
        </div>`;
    }

    function refreshRecipeMacros(r) {
      const card = view.querySelector(`[data-recipe="${CSS.escape(r.id)}"]`);
      if (!card) return;
      const t = recipeTotals(td, r);
      card.querySelector('.recipe-macros').innerHTML = macroSplit(t);
      card.querySelector('.recipe-kcal-num').textContent = fmt1(t.kcal);
    }

    // --- People ---
    function drawPeople() {
      const el = panel('people');
      el.innerHTML = `
        ${cardHead('👥', 'var(--s1)', 'People', '')}
        <p class="hint">Everyone eats every meal on the menu. With a target, that person's portions for the day are scaled so the
          day adds up to it — e.g. 200 g protein a day gives bigger portions than 120 g. Targets are per day.</p>
        <div class="people-grid">${td.people.map((p) => `
          <div class="person-card" data-person="${esc(p.id)}" style="--tint:${personColor(td, p)}">
            <div class="person-top">
              ${avatar(p.name, personColor(td, p), '')}
              <input class="name-input person-name" data-p="name" value="${esc(p.name)}" placeholder="Name" aria-label="Name">
              <button class="icon-btn del" data-action="del-person" aria-label="Remove person">✕</button>
            </div>
            <div class="macro-grid">${MACROS.map(([k, label, unit]) => `<label class="macro-field" style="--tint:${k === 'kcal' ? 'var(--s4)' : MACRO_COLORS[k]}"><span>${label}</span>
              <div class="money-field"><input data-p="${k}" type="number" min="0" step="any" value="${esc(p[k] || '')}" placeholder="0" aria-label="${label} per day"><span class="affix">${unit}</span></div></label>`).join('')}</div>
            <label class="macro-field scale-field"><span>Scale portions to</span><select class="select" data-p="scale">${SCALE.map(([v, l]) => `<option value="${v}"${(p.scale || 'protein') === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
          </div>`).join('')}
          <button class="person-card new-person" data-action="add-person"><span class="avatar add-avatar" aria-hidden="true">+</span><strong>Add person</strong><span class="muted">Everyone you cook for</span></button>
        </div>`;
    }

    // --- Foods ---
    function drawFoods() {
      const el = panel('foods');
      const q = String(ctx.ui.foodQuery || '').toLowerCase();
      const shown = allFoods(td).filter((f) => !q || f.name.toLowerCase().includes(q));
      el.innerHTML = `
        ${cardHead('🥦', 'var(--s6)', 'Foods', `<span class="muted">${Foods.BUILTIN.length} built in · ${td.foods.length} yours (★)</span>`)}
        <p class="hint">Values are per 100 g (raw or dry unless the name says otherwise).</p>
        <div class="tx-toolbar"><input class="text-input grow" type="search" data-food-q placeholder="Filter foods" value="${esc(ctx.ui.foodQuery || '')}"></div>
        <div class="table-scroll food-table-wrap"><table class="preview-table">
          <thead><tr><th>Food</th><th>Aisle</th><th class="num">kcal</th><th class="num">Protein</th><th class="num">Carbs</th><th class="num">Fat</th><th></th></tr></thead>
          <tbody>${shown.map((f) => `<tr><td dir="auto">${esc(f.name)}${f.builtin ? '' : ' ★'}${f.piece ? `<span class="muted"> · 1 ${esc(f.pieceName)} ≈ ${f.piece} g</span>` : ''}</td><td>${esc(f.aisle || 'Other')}</td>
            <td class="num">${fmt1(f.kcal)}</td><td class="num">${f.protein}</td><td class="num">${f.carbs}</td><td class="num">${f.fat}</td>
            <td>${f.builtin ? '' : `<button class="icon-btn del" data-del-food="${esc(f.id)}" aria-label="Remove food">✕</button>`}</td></tr>`).join('')}</tbody>
        </table></div>

        <div class="subsection">
          <h3 class="sub-title">Add your own food</h3>
          <div class="food-form">
            <input class="text-input" data-new="name" placeholder="Name">
            <select class="select" data-new="aisle">${Foods.AISLES.map((a) => `<option>${esc(a)}</option>`).join('')}</select>
            ${MACROS.map(([k, label]) => `<input class="text-input" data-new="${k}" type="number" min="0" step="any" placeholder="${label}/100 g">`).join('')}
            <button class="btn btn-small btn-primary" data-action="add-food">Add</button>
          </div>
          <div class="form-error" id="food-error"></div>
        </div>

        <div class="subsection">
          <h3 class="sub-title">Search Open Food Facts</h3>
          <p class="hint">Free open database of packaged products (brands, supermarket items). Needs an internet connection.</p>
          <div class="tx-toolbar"><input class="text-input grow" data-off-q placeholder="e.g. Tnuva cottage, Yoplait protein" value="${esc(ctx.ui.offQuery || '')}">
            <button class="btn btn-small" data-action="off-search">Search</button></div>
          <div id="off-results">${ctx.ui.offResults || ''}</div>
        </div>`;
    }

    async function offSearch() {
      const q = String(ctx.ui.offQuery || '').trim();
      const box = view.querySelector('#off-results');
      if (!q) return;
      box.innerHTML = '<div class="loading">Searching…</div>';
      try {
        const found = await Foods.searchOpenFoodFacts(q);
        ctx.ui.offFound = found;
        ctx.ui.offResults = found.length ? `<div class="off-list">${found.map((f, i) => `
          <div class="off-row"><div><strong dir="auto">${esc(f.name)}</strong>${f.brand ? ` <span class="muted" dir="auto">· ${esc(f.brand)}</span>` : ''}
            <div class="muted">${fmt1(f.kcal)} kcal · P ${f.protein ?? '?'} · C ${f.carbs ?? '?'} · F ${f.fat ?? '?'} per 100 g</div></div>
            <button class="btn btn-small" data-off-add="${i}">Add</button></div>`).join('')}</div>` : '<p class="empty">No products found.</p>';
      } catch (e) {
        ctx.ui.offResults = `<div class="alert"><span class="alert-icon" aria-hidden="true">⚠</span><span>${esc(e.message)}</span></div>`;
      }
      if (box.isConnected) box.innerHTML = ctx.ui.offResults;
    }

    // --- events ---
    view.addEventListener('change', (e) => {
      const t = e.target;
      if (t.dataset.cell) {
        const v = t.value;
        if (v) w.meals[t.dataset.cell] = v; else delete w.meals[t.dataset.cell];
        persistWeek();
        redrawMenu(`.slot-select[data-cell="${t.dataset.cell}"]`);
        return;
      }
      if (t.dataset.fill || t.hasAttribute('data-fill-day')) {
        const pr = prepState();
        if (t.dataset.fill === 'recipe') pr.recipe = t.value;
        else if (t.dataset.fill === 'slot') pr.slot = t.value;
        else pr.days = [...view.querySelectorAll('[data-fill-day]:checked')].map((x) => Number(x.dataset.fillDay));
        const go = view.querySelector('[data-action="fill"]');
        if (go) go.textContent = pr.days.length ? `Add to ${pr.days.length} day${pr.days.length > 1 ? 's' : ''}` : 'Choose days';
        return;
      }
      if (t.dataset.buy) {
        if (t.checked) w.checked[t.dataset.buy] = true; else delete w.checked[t.dataset.buy];
        persistWeek();
        drawGroceries();
        return;
      }
      if (t.hasAttribute('data-extra-check')) {
        const x = w.extra.find((y) => y.id === t.closest('[data-extra]').dataset.extra);
        x.checked = t.checked;
        persistWeek();
        drawGroceries();
        return;
      }
      if (t.dataset.ingField === 'food') {
        const r = td.recipes.find((x) => x.id === t.closest('[data-recipe]').dataset.recipe);
        r.ingredients.find((i) => i.id === t.closest('[data-ing]').dataset.ing).food = t.value;
        ctx.changed();
        drawRecipes();
        return;
      }
      if (t.dataset.p === 'scale') {
        td.people.find((p) => p.id === t.closest('[data-person]').dataset.person).scale = t.value;
        ctx.changed();
      }
    });

    view.addEventListener('input', (e) => {
      const t = e.target;
      if (t.dataset.r) {
        const r = td.recipes.find((x) => x.id === t.closest('[data-recipe]').dataset.recipe);
        r[t.dataset.r] = t.value;
        ctx.changed();
        if (t.dataset.r === 'name') { const s = view.querySelector(`[data-recipe="${CSS.escape(r.id)}"] .recipe-title`); if (s) s.textContent = t.value || 'Untitled recipe'; }
        return;
      }
      if (t.dataset.ingField === 'grams') {
        const r = td.recipes.find((x) => x.id === t.closest('[data-recipe]').dataset.recipe);
        r.ingredients.find((i) => i.id === t.closest('[data-ing]').dataset.ing).grams = t.value === '' ? '' : num(t.value);
        ctx.changed();
        refreshRecipeMacros(r);
        return;
      }
      if (t.dataset.p && t.dataset.p !== 'scale') {
        const p = td.people.find((x) => x.id === t.closest('[data-person]').dataset.person);
        p[t.dataset.p] = t.dataset.p === 'name' ? t.value : (t.value === '' ? '' : num(t.value));
        ctx.changed();
        return;
      }
      if (t.dataset.extraField) {
        const x = w.extra.find((y) => y.id === t.closest('[data-extra]').dataset.extra);
        x[t.dataset.extraField] = t.value;
        persistWeek();
        return;
      }
      if (t.hasAttribute('data-food-q')) {
        ctx.ui.foodQuery = t.value;
        const pos = t.selectionStart;
        drawFoods();
        const again = view.querySelector('[data-food-q]');
        again.focus();
        again.setSelectionRange(pos, pos);
        return;
      }
      if (t.hasAttribute('data-off-q')) ctx.ui.offQuery = t.value;
    });

    view.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.hasAttribute('data-off-q')) { e.preventDefault(); offSearch(); }
      if (e.target.closest('.week-strip')) {
        const i = dayIndex();
        const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: 6 }[e.key];
        if (next == null) return;
        e.preventDefault();
        ctx.ui.foodDay = (next + 7) % 7;
        redrawMenu(`.day-pill[data-day="${ctx.ui.foodDay}"]`);
      }
    });

    view.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action], [data-off-add], [data-del-food]');
      if (!btn) return;
      const a = btn.dataset.action;
      if (btn.dataset.offAdd != null) {
        const f = (ctx.ui.offFound || [])[Number(btn.dataset.offAdd)];
        if (!f) return;
        td.foods.push({ id: 'off:' + (f.code || Fmt.uid()), name: f.brand ? `${f.name} (${f.brand})` : f.name, aisle: 'Other',
          kcal: f.kcal, protein: f.protein || 0, carbs: f.carbs || 0, fat: f.fat || 0, source: 'off' });
        td.foods = td.foods.filter((x, i, all) => all.findIndex((y) => y.id === x.id) === i);
        ctx.changed();
        App.toast(`Added “${f.name}” to your foods.`);
        btn.disabled = true;
        btn.textContent = 'Added';
        return;
      }
      if (btn.dataset.delFood) {
        const id = btn.dataset.delFood;
        const usedIn = td.recipes.filter((r) => r.ingredients.some((i) => i.food === id));
        if (usedIn.length && !confirm(`This food is used in ${usedIn.length} recipe${usedIn.length > 1 ? 's' : ''}. Remove it anyway?`)) return;
        td.foods = td.foods.filter((f) => f.id !== id);
        ctx.changed();
        drawFoods();
        return;
      }
      if (a === 'fill') {
        const recipe = view.querySelector('[data-fill="recipe"]').value;
        const slot = view.querySelector('[data-fill="slot"]').value;
        const days = [...view.querySelectorAll('[data-fill-day]:checked')].map((x) => x.dataset.fillDay);
        if (!recipe || !days.length) { App.toast('Choose a recipe and at least one day.'); return; }
        days.forEach((i) => { w.meals[`d${i}:${slot}`] = recipe; });
        Object.assign(prepState(), { recipe, slot, days: days.map(Number) });
        persistWeek();
        redrawMenu('[data-action="fill"]');
        App.toast(`Added to ${days.length} day${days.length > 1 ? 's' : ''}. The grocery list is updated.`);
      } else if (a === 'pick-day' || a === 'open-day') {
        ctx.ui.foodDay = Number(btn.dataset.day);
        ctx.ui.foodDayWeek = wid;
        ctx.ui.menuMode = 'day';
        redrawMenu(a === 'pick-day' ? `.day-pill[data-day="${ctx.ui.foodDay}"]` : '#day-title');
      } else if (a === 'day-step') {
        stepDay(Number(btn.dataset.step));
      } else if (a === 'menu-mode') {
        ctx.ui.menuMode = btn.dataset.mode;
        redrawMenu(`[data-action="menu-mode"][data-mode="${btn.dataset.mode}"]`);
      } else if (a === 'quick-add') {
        w.meals[btn.dataset.addCell] = btn.dataset.recipe;
        persistWeek();
        redrawMenu(`.slot-select[data-cell="${btn.dataset.addCell}"]`);
      } else if (a === 'clear-meal') {
        delete w.meals[btn.dataset.key];
        persistWeek();
        redrawMenu(`.slot-select[data-cell="${btn.dataset.key}"]`);
      } else if (a === 'toggle-amounts') {
        const open = ctx.ui.openAmounts || (ctx.ui.openAmounts = {});
        open[btn.dataset.key] = !open[btn.dataset.key];
        redrawMenu(`[data-action="toggle-amounts"][data-key="${btn.dataset.key}"]`);
      } else if (a === 'repeat-meal') {
        Object.assign(prepState(), { recipe: btn.dataset.recipe, slot: btn.dataset.slot });
        drawMenu();
        const card = view.querySelector('#meal-prep');
        card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        card.classList.add('flash');
        setTimeout(() => card.classList.remove('flash'), 1200);
        view.querySelector('[data-fill-day]').focus();
      } else if (a === 'go-groceries') {
        selectTab('groceries', true);
      } else if (a === 'copy-week') {
        const src = weekOf(td, addDays(wid, -7));
        Object.assign(w.meals, src.meals);
        persistWeek();
        redrawMenu('[data-action="go-groceries"]');
      } else if (a === 'add-extra') {
        w.extra.push({ id: Fmt.uid(), name: '', amount: '', checked: false });
        persistWeek();
        drawGroceries();
        const inputs = view.querySelectorAll('[data-extra-field="name"]');
        inputs[inputs.length - 1].focus();
      } else if (a === 'del-extra') {
        w.extra = w.extra.filter((x) => x.id !== btn.closest('[data-extra]').dataset.extra);
        persistWeek();
        drawGroceries();
      } else if (a === 'copy-list') {
        const text = listText();
        (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(
          () => App.toast('Copied. Paste it into WhatsApp or Notes.'),
          () => prompt('Copy the list:', text));
      } else if (a === 'clear-checks') {
        w.checked = {};
        w.extra.forEach((x) => { x.checked = false; });
        persistWeek();
        drawGroceries();
      } else if (a === 'add-recipe') {
        ctx.ui.openRecipe = newRecipe('').id;
        drawRecipes();
        const input = view.querySelector('[data-r="name"]');
        if (input) input.focus();
      } else if (a === 'toggle-recipe') {
        const id = btn.closest('[data-recipe]').dataset.recipe;
        ctx.ui.openRecipe = ctx.ui.openRecipe === id ? null : id;
        drawRecipes();
      } else if (a === 'del-recipe') {
        const id = btn.closest('[data-recipe]').dataset.recipe;
        const inWeeks = Object.values(td.weeks).filter((wk) => Object.values(wk.meals || {}).includes(id)).length;
        if (!confirm(`Delete this recipe?${inWeeks ? ` It's on the menu in ${inWeeks} week${inWeeks > 1 ? 's' : ''}; those meals will be cleared.` : ''}`)) return;
        td.recipes = td.recipes.filter((r) => r.id !== id);
        Object.values(td.weeks).forEach((wk) => Object.keys(wk.meals || {}).forEach((k) => { if (wk.meals[k] === id) delete wk.meals[k]; }));
        ctx.changed();
        drawRecipes();
      } else if (a === 'add-ing' || a === 'del-ing') {
        const r = td.recipes.find((x) => x.id === btn.closest('[data-recipe]').dataset.recipe);
        if (a === 'add-ing') r.ingredients.push({ id: Fmt.uid(), food: '', grams: 100 });
        else r.ingredients = r.ingredients.filter((i) => i.id !== btn.closest('[data-ing]').dataset.ing);
        ctx.changed();
        drawRecipes();
      } else if (a === 'add-person') {
        td.people.push({ id: Fmt.uid(), name: '', kcal: '', protein: '', carbs: '', fat: '', scale: 'protein' });
        ctx.changed();
        drawPeople();
        const inputs = view.querySelectorAll('[data-p="name"]');
        inputs[inputs.length - 1].focus();
      } else if (a === 'del-person') {
        td.people = td.people.filter((p) => p.id !== btn.closest('[data-person]').dataset.person);
        ctx.changed();
        drawPeople();
      } else if (a === 'add-food') {
        const get = (k) => view.querySelector(`[data-new="${k}"]`).value;
        const name = get('name').trim();
        if (!name) { view.querySelector('#food-error').textContent = 'Give the food a name.'; return; }
        if (get('kcal') === '') { view.querySelector('#food-error').textContent = 'Enter at least the calories per 100 g.'; return; }
        td.foods.push({ id: 'my:' + Fmt.uid(), name, aisle: get('aisle'), kcal: num(get('kcal')), protein: num(get('protein')), carbs: num(get('carbs')), fat: num(get('fat')) });
        ctx.changed();
        drawFoods();
        App.toast(`Added “${name}”.`);
      } else if (a === 'off-search') {
        offSearch();
      }
    });

    draw(tab);
  }

  // ---------- Summary screen ----------

  function renderDashboard(root, ctx) {
    const td = topicData(ctx);
    ensureWeek(ctx);
    const wid = ctx.ui.week;
    const w = weekOf(td, wid);
    wideMain(root);
    root.append(weekBar(ctx));
    const view = document.createElement('div');
    view.className = 'stack';
    root.append(view);
    const planned = Object.values(w.meals).filter((id) => td.recipes.some((r) => r.id === id));
    const meals = planned.length;
    if (!meals) {
      view.innerHTML = `<section class="card empty-state"><div class="empty-illustration" aria-hidden="true">🥗</div>
        <p>${ctx.isMe ? 'No meals planned' : `${esc(ctx.owner.name)} hasn't planned meals`} for ${esc(weekLabel(wid))}.</p>
        ${!ctx.readOnly ? `<a class="btn btn-primary" href="${ctx.inputHref || `#/${ID}/input`}">Plan the week</a>` : ''}</section>`;
      return;
    }
    const list = groceries(td, w);
    const total = list.length + w.extra.length;
    const bought = list.filter((g) => w.checked[g.food.id]).length + w.extra.filter((x) => x.checked).length;
    const people = td.people.length ? td.people : [null];
    const counts = {};
    planned.forEach((id) => { counts[id] = (counts[id] || 0) + 1; });
    const favorite = td.recipes.find((r) => r.id === Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0]);

    view.innerHTML = `
      <section class="hero food-hero">
        <div class="hero-main">
          <div class="hero-kicker">${ctx.isMe ? '' : `${esc(ctx.owner.name)}'s `}Meal prep · ${esc(weekLabel(wid))}</div>
          <div class="hero-value">${meals} meal${meals === 1 ? '' : 's'}</div>
          <div class="hero-sub">${favorite ? `Most planned: ${recipeEmoji(favorite)} ${esc(favorite.name)} (${counts[favorite.id]}×)` : ''}</div>
        </div>
        <div class="hero-meters">
          <div class="meter-row"><span>Meals planned</span><strong>${meals} / ${7 * SLOTS.length}</strong></div>
          <div class="meter"><span style="width:${(meals / (7 * SLOTS.length)) * 100}%"></span></div>
          <div class="meter-row"><span>Groceries bought</span><strong>${bought} / ${total}</strong></div>
          <div class="meter"><span style="width:${total ? (bought / total) * 100 : 0}%"></span></div>
        </div>
      </section>

      <div class="people-summary">
        ${people.map((p) => {
          const days = DAYS.map((_, i) => personDay(td, p, w, i)).filter((d) => d.meals);
          const avg = (k) => (days.length ? sum(days.map((d) => d.totals[k])) / days.length : 0);
          const mode = p && (p.scale || 'protein') !== 'none' ? (p.scale || 'protein') : 'protein';
          const items = DAYS.map((d, i) => ({ i, pd: personDay(td, p, w, i) })).filter((x) => x.pd.meals).map(({ i, pd }) => (
            { name: dayLabel(wid, i), actual: pd.totals[mode], planned: p ? num(p[mode]) : 0, color: mode === 'kcal' ? 'var(--s4)' : MACRO_COLORS.protein }));
          const unit = mode === 'kcal' ? ' kcal' : ' g';
          const avgTotals = { kcal: avg('kcal'), protein: avg('protein'), carbs: avg('carbs'), fat: avg('fat') };
          return `<section class="card person-summary" style="--tint:${p ? personColor(td, p) : 'var(--other)'}">
            <div class="ps-head">${avatar(p ? p.name : '1', p ? personColor(td, p) : 'var(--other)', '')}
              <div><h2 class="card-title">${p ? esc(p.name || 'Unnamed') : '1 portion each'}</h2><div class="muted">Average per planned day</div></div></div>
            <div class="ring-row">
              ${ring(avgTotals.kcal, p ? num(p.kcal) : 0, 'Calories', ' kcal', 'var(--s4)')}
              ${ring(avgTotals.protein, p ? num(p.protein) : 0, 'Protein', ' g', MACRO_COLORS.protein)}
              ${ring(avgTotals.carbs, p ? num(p.carbs) : 0, 'Carbs', ' g', MACRO_COLORS.carbs)}
              ${ring(avgTotals.fat, p ? num(p.fat) : 0, 'Fat', ' g', MACRO_COLORS.fat)}
            </div>
            <div class="ps-split">${macroSplit(avgTotals)}</div>
            <h3 class="sub-title">${mode === 'kcal' ? 'Calories' : 'Protein'} by day</h3>
            ${Charts.bulletList(items, { empty: 'No meals yet.', planLabel: 'Target', noPlan: 'No target', format: (v) => fmt1(v) + unit })}
          </section>`;
        }).join('')}
      </div>

      <section class="card">
        ${cardHead('🗓', 'var(--s4)', 'Menu of the week')}
        ${agendaHtml(td, w, wid)}
      </section>`;
  }

  window.FoodTopic = { topicData, recipeTotals, personDay, groceries, amountText, weekStart, exportRows };

  App.register({ id: ID, title: 'Food', icon: '🥗', labels: { input: 'Plan', dashboard: 'Summary' }, renderInput, renderDashboard, exportRows });
})();
