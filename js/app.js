// App shell: sign-in, topic registry, hash router (#/<topic>/<input|dashboard>[/<personId>]),
// people switcher, sharing, settings, storage, tooltip.
(function () {
  const topics = [];
  const ui = {};             // per-topic view state on this device (e.g. selected month)
  const othersCache = {};    // personId -> {blob, at}
  const OTHERS_TTL = 60000;
  const AVATAR_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#e87ba4', '#4a3aa7', '#008300', '#e34948', '#c98500'];
  const VIEWS = [{ id: 'input', label: 'Input' }, { id: 'dashboard', label: 'Dashboard' }];
  const { esc } = Fmt;

  let people = [];        // everyone with a profile in the current storage
  let sharedWithMe = [];  // people whose dashboards I can see
  let myViewers = [];     // ids of people who can see mine
  let renderSeq = 0;

  const $ = (id) => document.getElementById(id);

  function avatar(person, size) {
    return `<span class="avatar${size ? ' ' + size : ''}" style="background:${esc(person.color || AVATAR_COLORS[0])}" aria-hidden="true">${esc(Fmt.initials(person.name))}</span>`;
  }

  // ---------- Routing ----------

  function route() {
    const m = location.hash.match(/^#\/([\w-]+)\/(input|dashboard)(?:\/([\w-]+))?$/);
    const topic = (m && topics.find((t) => t.id === m[1])) || topics[0];
    const view = m && topic.id === m[1] ? m[2] : 'dashboard';
    const person = view === 'dashboard' && m && m[3] && m[3] !== Store.me.id ? m[3] : null;
    return { topic, view, person };
  }

  function href(topic, view, person) {
    return `#/${topic.id}/${view}${person ? '/' + person : ''}`;
  }

  async function render() {
    if (!Store.me) return;
    const seq = ++renderSeq;
    const { topic, view, person } = route();
    const expected = href(topic, view, person);
    if (location.hash !== expected) history.replaceState(null, '', expected);

    $('topic-nav').innerHTML = topics.map((t) =>
      `<a href="${href(t, view)}"${t === topic ? ' aria-current="page"' : ''}>${esc(t.title)}</a>`).join('');
    $('view-tabs').innerHTML = VIEWS.map((v) =>
      `<a href="${href(topic, v.id)}"${v.id === view && !(v.id === 'dashboard' && person) ? ' aria-current="page"' : ''}>${v.id === 'input' ? 'My numbers' : 'My dashboard'}</a>`).join('');

    const main = $('main');
    main.innerHTML = '';
    hideTooltip();
    document.title = `${topic.title} · Goals`;
    if (!ui[topic.id]) ui[topic.id] = { month: Fmt.monthKey(new Date()) };

    if (view === 'dashboard') main.append(peopleBar(topic, person));
    const body = document.createElement('div');
    main.append(body);

    if (!person) {
      Fmt.setCurrency(Store.settings.currency);
      const ctx = {
        data: Store.topic(topic.id), isMe: true, readOnly: false, owner: Store.me, ui: ui[topic.id],
        changed: () => Store.changed(), rerender: render,
      };
      view === 'input' ? topic.renderInput(body, ctx) : topic.renderDashboard(body, ctx);
      return;
    }

    const owner = sharedWithMe.find((p) => p.id === person);
    if (!owner) {
      body.innerHTML = `<section class="card empty-state"><p>This dashboard isn't shared with you.</p></section>`;
      return;
    }
    let blob;
    const cached = othersCache[person];
    if (cached && Date.now() - cached.at < OTHERS_TTL) {
      blob = cached.blob;
    } else {
      body.innerHTML = '<div class="loading">Loading…</div>';
      try {
        blob = await Store.loadUser(person);
        othersCache[person] = { blob, at: Date.now() };
      } catch (e) {
        if (seq !== renderSeq) return;
        body.innerHTML = `<section class="card empty-state"><p>${esc(e.message)}</p><button class="btn" id="retry-other">Try again</button></section>`;
        $('retry-other').onclick = render;
        return;
      }
      if (seq !== renderSeq) return;
      body.innerHTML = '';
    }
    Fmt.setCurrency(blob.settings.currency);
    topic.renderDashboard(body, {
      data: blob.topics[topic.id] || {}, isMe: false, readOnly: true, owner, ui: ui[topic.id],
      changed() {}, rerender: render,
    });
  }

  function peopleBar(topic, person) {
    const el = document.createElement('div');
    el.className = 'people-bar';
    const pill = (p, isMe) => {
      const active = isMe ? !person : person === p.id;
      return `<a class="person-pill${active ? ' active' : ''}" href="${href(topic, 'dashboard', isMe ? null : p.id)}"${active ? ' aria-current="page"' : ''}>
        ${avatar(p, 'sm')}<span>${isMe ? 'Me' : esc(p.name)}</span></a>`;
    };
    el.innerHTML = `
      <div class="people-pills">${pill(Store.me, true)}${sharedWithMe.map((p) => pill(p, false)).join('')}</div>
      <div class="people-actions">
        ${person ? '<span class="view-only">View only</span><button class="btn btn-small" data-refresh>Refresh</button>' : ''}
        <button class="btn btn-small" data-share>${myViewers.length ? `Shared with ${myViewers.length}` : 'Share my dashboard'}</button>
      </div>`;
    el.querySelector('[data-share]').onclick = openSharing;
    const refresh = el.querySelector('[data-refresh]');
    if (refresh) refresh.onclick = () => { delete othersCache[person]; render(); };
    return el;
  }

  async function refreshPeople() {
    try {
      const [all, sharing] = await Promise.all([Store.listUsers(), Store.getSharing()]);
      people = all;
      myViewers = sharing.viewers;
      sharedWithMe = all.filter((p) => sharing.sharedWithMe.includes(p.id));
    } catch (e) {
      // Keep whatever we had; the dashboard still works for the signed-in person.
    }
  }

  // ---------- Sign-in screen ----------

  function showScreen(name) {
    $('boot').hidden = name !== 'boot';
    $('auth').hidden = name !== 'auth';
    $('app').hidden = name !== 'app';
  }

  async function showAuth(message) {
    showScreen('auth');
    const sheets = Store.backend.mode === 'sheets';
    $('auth').innerHTML = `
      <div class="auth-card">
        <div class="brand-mark big">G</div>
        <h1>Who's using Goals?</h1>
        <p class="muted">Data: ${esc(Store.backend.label)} · <button class="link-btn" data-storage>Change</button></p>
        ${message ? `<div class="alert"><span class="alert-icon" aria-hidden="true">⚠</span><span>${esc(message)}</span></div>` : ''}
        <div id="auth-body"><div class="loading">Loading…</div></div>
      </div>`;
    $('auth').querySelector('[data-storage]').onclick = openStorage;

    let users;
    try {
      users = await Store.listUsers();
    } catch (e) {
      $('auth-body').innerHTML = `
        <div class="alert"><span class="alert-icon" aria-hidden="true">⚠</span><span>${esc(e.message)}</span></div>
        <div class="btn-row center"><button class="btn" id="auth-retry">Try again</button></div>`;
      $('auth-retry').onclick = () => showAuth();
      return;
    }

    const body = $('auth-body');
    const showPicker = () => {
      body.innerHTML = `
        <div class="profile-grid">
          ${users.map((u) => `<button class="profile" data-user="${esc(u.id)}">${avatar(u, 'xl')}<span>${esc(u.name)}</span></button>`).join('')}
          <button class="profile add" data-add><span class="avatar xl add-avatar" aria-hidden="true">+</span><span>Add person</span></button>
        </div>
        ${users.length ? '' : `<p class="hint center">Add yourself to start. Family members ${sheets ? 'can join from their own devices using the same Google Sheet link' : 'can add themselves on this device'}.</p>`}`;
      body.querySelectorAll('[data-user]').forEach((b) => {
        b.onclick = () => showLogin(users.find((u) => u.id === b.dataset.user));
      });
      body.querySelector('[data-add]').onclick = showCreate;
    };

    const showLogin = async (u) => {
      if (!u.hasPin) return submit(() => Store.signIn(u.id, ''));
      body.innerHTML = `
        <form class="auth-form" id="login-form">
          <div class="center">${avatar(u, 'xl')}<h2>${esc(u.name)}</h2></div>
          <label class="field"><span>Passcode</span>
            <input class="text-input" id="login-pin" type="password" autocomplete="current-password" required></label>
          <div class="form-error" id="form-error"></div>
          <div class="btn-row"><button type="button" class="btn" data-back>Back</button><button class="btn btn-primary grow">Sign in</button></div>
        </form>`;
      body.querySelector('[data-back]').onclick = showPicker;
      $('login-pin').focus();
      $('login-form').onsubmit = (e) => { e.preventDefault(); submit(() => Store.signIn(u.id, $('login-pin').value)); };
    };

    const showCreate = () => {
      const used = new Set(users.map((u) => u.color));
      const color = AVATAR_COLORS.find((c) => !used.has(c)) || AVATAR_COLORS[0];
      body.innerHTML = `
        <form class="auth-form" id="create-form">
          <h2>Add a person</h2>
          <label class="field"><span>Name</span><input class="text-input" id="new-name" maxlength="30" required autocomplete="given-name"></label>
          <div class="field"><span>Color</span>
            <div class="color-pick">${AVATAR_COLORS.map((c) => `
              <label><input type="radio" name="color" value="${c}"${c === color ? ' checked' : ''}><span style="background:${c}"></span></label>`).join('')}</div>
          </div>
          <label class="field"><span>Passcode${sheets ? '' : ' (optional)'}</span>
            <input class="text-input" id="new-pin" type="password" autocomplete="new-password" ${sheets ? 'required minlength="4"' : ''}>
            <span class="hint">${sheets ? 'At least 4 characters. You will need it on every new device.' : 'Stops others on this computer from opening your profile.'}</span></label>
          <div class="form-error" id="form-error"></div>
          <div class="btn-row">${users.length ? '<button type="button" class="btn" data-back>Back</button>' : ''}<button class="btn btn-primary grow">Create</button></div>
        </form>`;
      const back = body.querySelector('[data-back]');
      if (back) back.onclick = showPicker;
      $('new-name').focus();
      $('create-form').onsubmit = (e) => {
        e.preventDefault();
        const pin = $('new-pin').value;
        if (sheets && pin.length < 4) { $('form-error').textContent = 'Passcode needs at least 4 characters.'; return; }
        submit(() => Store.createUser({ name: $('new-name').value, pin, color: body.querySelector('[name=color]:checked').value }));
      };
    };

    async function submit(action) {
      const btn = body.querySelector('.btn-primary');
      if (btn) { btn.disabled = true; btn.textContent = 'One moment…'; }
      try {
        await action();
        enterApp();
      } catch (e) {
        const err = $('form-error');
        if (err) err.textContent = e.message;
        else showAuth(e.message);
        if (btn) { btn.disabled = false; btn.textContent = 'Try again'; }
      }
    }

    users.length ? showPicker() : showCreate();
  }

  async function enterApp() {
    showScreen('app');
    $('user-btn').innerHTML = `${avatar(Store.me, 'sm')}<span class="user-name">${esc(Store.me.name)}</span><span aria-hidden="true">▾</span>`;
    $('menu-head').innerHTML = `${avatar(Store.me)}<div><strong>${esc(Store.me.name)}</strong><div class="muted">${esc(Store.backend.label)}</div></div>`;
    updateSync(Store.status);
    await refreshPeople();
    render();
    const notice = Store.takeNotice();
    if (notice) toast(notice);
  }

  function toast(message) {
    const el = $('toast');
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { el.hidden = true; }, 7000);
  }

  function signOut(message) {
    Store.signOut();
    people = []; sharedWithMe = []; myViewers = [];
    Object.keys(othersCache).forEach((k) => delete othersCache[k]);
    Object.keys(ui).forEach((k) => delete ui[k]);
    history.replaceState(null, '', '#/');
    showAuth(message);
  }

  // ---------- Header: sync status + user menu ----------

  function updateSync(status, detail) {
    const el = $('sync');
    const local = Store.backend.mode === 'local';
    const text = {
      saved: local ? 'Saved on this device' : 'Saved to Google Sheets',
      pending: 'Saving soon…',
      saving: 'Saving…',
      error: 'Not saved yet, retrying',
    }[status] || '';
    el.textContent = text;
    el.className = 'sync ' + status;
    el.title = detail || '';
  }

  function initMenu() {
    const btn = $('user-btn');
    const menu = $('user-menu');
    const close = () => { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
    btn.onclick = (e) => {
      e.stopPropagation();
      menu.hidden = !menu.hidden;
      btn.setAttribute('aria-expanded', String(!menu.hidden));
    };
    document.addEventListener('click', (e) => { if (!menu.contains(e.target)) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    menu.addEventListener('click', (e) => {
      const item = e.target.closest('[data-menu]');
      if (!item) return;
      close();
      if (item.dataset.menu === 'sharing') openSharing();
      if (item.dataset.menu === 'settings') openSettings();
      if (item.dataset.menu === 'switch') signOut();
    });
  }

  // ---------- Sharing dialog ----------

  async function openSharing() {
    const dlg = $('sharing');
    const body = $('sharing-body');
    body.innerHTML = '<div class="loading">Loading…</div>';
    dlg.showModal();
    await refreshPeople();
    const others = people.filter((p) => p.id !== Store.me.id);
    const sheets = Store.backend.mode === 'sheets';
    body.innerHTML = `
      ${others.length ? `
        <h3 class="dialog-sub">Who can see my dashboards</h3>
        <div class="share-list">
          ${others.map((p) => `
            <label class="share-row">${avatar(p)}<span class="grow">${esc(p.name)}</span>
              <input type="checkbox" class="switch" value="${esc(p.id)}"${myViewers.includes(p.id) ? ' checked' : ''}></label>`).join('')}
        </div>` : `
        <p class="empty">Nobody else has a profile yet. ${sheets
          ? 'Send them the web app URL below; they open Goals, choose Google Sheets storage, paste it and add themselves.'
          : 'They can add themselves from the sign-in screen (Switch person → Add person).'}</p>`}
      <h3 class="dialog-sub">Shared with me</h3>
      ${sharedWithMe.length
        ? `<div class="share-list">${sharedWithMe.map((p) => `<div class="share-row">${avatar(p)}<span class="grow">${esc(p.name)}</span><span class="muted">can view</span></div>`).join('')}</div>`
        : '<p class="empty">Nobody has shared their dashboard with you yet.</p>'}
      ${sheets ? `
        <h3 class="dialog-sub">Invite family</h3>
        <div class="inline-row"><input class="text-input grow" readonly value="${esc(Store.device.backend.url)}" id="invite-url">
          <button type="button" class="btn btn-small" id="copy-invite">Copy</button></div>` : ''}
      <div class="form-error" id="sharing-error"></div>`;
    const copy = $('copy-invite');
    if (copy) copy.onclick = () => { navigator.clipboard.writeText($('invite-url').value); copy.textContent = 'Copied'; };
    $('sharing-save').hidden = !others.length;
  }

  function initSharing() {
    $('sharing-save').addEventListener('click', async (e) => {
      e.preventDefault();
      const ids = Array.from($('sharing-body').querySelectorAll('input[type=checkbox]:checked'), (c) => c.value);
      const btn = $('sharing-save');
      btn.disabled = true;
      try {
        await Store.setViewers(ids);
        myViewers = ids;
        $('sharing').close();
        render();
      } catch (err) {
        $('sharing-error').textContent = err.message;
      } finally {
        btn.disabled = false;
      }
    });
  }

  // ---------- Storage dialog ----------

  function openStorage() {
    const dlg = $('storage');
    const form = $('storage-form');
    form.mode.value = Store.device.backend.mode;
    $('sheets-url').value = Store.device.backend.url;
    $('sheets-test-result').textContent = '';
    syncStorageForm();
    if ($('settings').open) $('settings').close();
    dlg.showModal();
  }

  function syncStorageForm() {
    const sheets = $('storage-form').mode.value === 'sheets';
    $('sheets-url-field').hidden = !sheets;
    $('sheets-test').hidden = !sheets;
  }

  function initStorage() {
    const form = $('storage-form');
    form.addEventListener('change', syncStorageForm);
    const validUrl = (u) => /^https:\/\/script\.google\.com\/.+\/exec$/.test(u.trim());

    $('sheets-test').onclick = async () => {
      const url = $('sheets-url').value.trim();
      const out = $('sheets-test-result');
      if (!validUrl(url)) { out.textContent = 'The URL should start with https://script.google.com/ and end with /exec.'; return; }
      out.textContent = 'Testing…';
      try {
        await Backends.sheets(url).ping();
        out.textContent = '✓ Connected.';
      } catch (e) {
        out.textContent = '⚠ ' + e.message;
      }
    };

    $('storage-save').addEventListener('click', (e) => {
      e.preventDefault();
      const mode = form.mode.value;
      const url = $('sheets-url').value.trim();
      if (mode === 'sheets' && !validUrl(url)) {
        $('sheets-test-result').textContent = 'Paste the web app URL (it ends with /exec).';
        return;
      }
      $('storage').close();
      const same = mode === Store.device.backend.mode && (mode === 'local' || url === Store.device.backend.url);
      if (same) return;
      Store.setBackend(mode, url);
      signOut();
    });
  }

  // ---------- Settings dialog ----------

  function openSettings() {
    $('set-currency').value = Store.settings.currency;
    $('set-theme').value = Store.device.theme;
    $('storage-label').textContent = Store.backend.label;
    $('settings').showModal();
  }

  function applyTheme() {
    const t = Store.device.theme;
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
    else delete document.documentElement.dataset.theme;
  }

  function initSettings() {
    const file = $('import-file');
    $('set-currency').onchange = () => {
      Store.settings.currency = $('set-currency').value;
      Store.changed();
      render();
    };
    $('set-theme').onchange = () => {
      Store.device.theme = $('set-theme').value;
      Store.saveDevice();
      applyTheme();
    };
    $('open-storage').onclick = openStorage;
    $('export-data').onclick = () => {
      const blob = new Blob([Store.exportJSON()], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `goals-${Store.me.name.toLowerCase().replace(/\W+/g, '-')}-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    };
    $('import-data').onclick = () => file.click();
    file.onchange = async () => {
      if (!file.files[0]) return;
      try {
        if (!confirm('Importing replaces all of your current data. Continue?')) return;
        Store.importJSON(await file.files[0].text());
        $('settings').close();
        render();
      } catch (e) {
        alert('Could not import: ' + e.message);
      } finally {
        file.value = '';
      }
    };
    $('reset-data').onclick = () => {
      if (!confirm('Erase all of your numbers? This cannot be undone.')) return;
      Store.resetData();
      $('settings').close();
      render();
    };
  }

  // ---------- Tooltip: any element with data-tip (title) and optional data-tip-sub ----------

  const tip = $('tooltip');

  function showTooltip(el, x, y) {
    tip.querySelector('.tooltip-title').textContent = el.dataset.tip;
    tip.querySelector('.tooltip-sub').textContent = el.dataset.tipSub || '';
    tip.hidden = false;
    const pad = 12;
    const r = tip.getBoundingClientRect();
    let left = x + pad;
    let top = y + pad;
    if (left + r.width > innerWidth - 8) left = x - r.width - pad;
    if (top + r.height > innerHeight - 8) top = y - r.height - pad;
    tip.style.left = Math.max(8, left) + 'px';
    tip.style.top = Math.max(8, top) + 'px';
  }

  function hideTooltip() { tip.hidden = true; }

  function initTooltip() {
    document.addEventListener('pointermove', (e) => {
      const el = e.target.closest && e.target.closest('[data-tip]');
      if (el) showTooltip(el, e.clientX, e.clientY);
      else hideTooltip();
    });
    document.addEventListener('focusin', (e) => {
      const el = e.target.closest && e.target.closest('[data-tip]');
      if (!el) return hideTooltip();
      const r = el.getBoundingClientRect();
      showTooltip(el, r.left + r.width / 2, r.bottom);
    });
    document.addEventListener('scroll', hideTooltip, true);
  }

  window.App = {
    register(topic) { topics.push(topic); },
    rerender: render,
    async start() {
      applyTheme();
      initMenu();
      initSharing();
      initStorage();
      initSettings();
      initTooltip();
      Store.onStatus(updateSync);
      Store.onAuthLost = () => signOut('Please sign in again.');
      Store.rowsProvider = (blob) => Object.assign({}, ...topics.map((t) => (t.exportRows ? t.exportRows(blob.topics[t.id]) : {})));
      addEventListener('hashchange', render);

      if (!Store.hasSession()) return showAuth();
      try {
        await Store.resume();
        enterApp();
      } catch (e) {
        if (e.code === 'OFFLINE') return showAuth(e.message);
        signOut(e.code === 'AUTH' ? 'Please sign in again.' : e.message);
      }
    },
  };
})();
