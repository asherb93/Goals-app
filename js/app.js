// App shell: sign-in, topic registry, hash router (#/<topic>/<input|dashboard>[/<personId>]),
// people switcher, sharing (per topic: can view / can edit), settings, storage, tooltip.
(function () {
  const topics = [];
  const ui = {};             // per-topic view state on this device (e.g. selected month)
  const LEVEL_LABELS = { none: 'No access', view: 'Can view', edit: 'Can edit' };
  const AVATAR_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#e87ba4', '#4a3aa7', '#008300', '#e34948', '#c98500'];
  const VIEWS = [{ id: 'input', label: 'Input' }, { id: 'dashboard', label: 'Dashboard' }];
  const { esc } = Fmt;

  let people = [];        // everyone with a profile in the current storage
  let sharedWithMe = [];  // people who share at least one topic with me
  let myViewers = [];     // ids of people I share at least one topic with
  let myAccess = {};      // viewerId -> {topicId | '*': 'view' | 'edit'}
  let sharedAccess = {};  // ownerId -> what they let me do, same shape
  let renderSeq = 0;
  let remotePending = false;

  const levelOf = (access, topicId) => (access && (access[topicId] || access['*'])) || 'none';
  const levelFor = (personId, topicId) => levelOf(sharedAccess[personId], topicId);

  const $ = (id) => document.getElementById(id);

  function avatar(person, size) {
    return `<span class="avatar${size ? ' ' + size : ''}" style="background:${esc(person.color || AVATAR_COLORS[0])}" aria-hidden="true">${esc(Fmt.initials(person.name))}</span>`;
  }

  // ---------- Routing ----------

  function route() {
    const m = location.hash.match(/^#\/([\w-]+)\/(input|dashboard)(?:\/([\w-]+))?$/);
    const topic = (m && topics.find((t) => t.id === m[1])) || topics[0];
    const view = m && topic.id === m[1] ? m[2] : 'dashboard';
    const person = m && topic.id === m[1] && m[3] && m[3] !== Store.me.id ? m[3] : null;
    return { topic, view, person };
  }

  // Whose data a link to this topic/view should open: the person on screen if they allow it, else mine.
  function personFor(topic, view, person) {
    if (!person) return null;
    const level = levelFor(person, topic.id);
    return (view === 'input' ? level === 'edit' : level !== 'none') ? person : null;
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

    const label = (v, who) => esc((topic.labels && topic.labels[v.id])
      || (who ? (v.id === 'input' ? 'Numbers' : 'Dashboard') : (v.id === 'input' ? 'My numbers' : 'My dashboard')));
    $('topic-nav').innerHTML = topics.map((t) =>
      `<a href="${href(t, view, personFor(t, view, person))}"${t === topic ? ' aria-current="page"' : ''}>${esc(t.title)}</a>`).join('');
    $('view-tabs').innerHTML = VIEWS.map((v) => {
      const who = personFor(topic, v.id, person);
      return `<a href="${href(topic, v.id, who)}"${v.id === view && who === person ? ' aria-current="page"' : ''}>${label(v, who)}</a>`;
    }).join('');

    const main = $('main');
    main.innerHTML = '';
    main.className = 'main';
    hideTooltip();
    remotePending = false;
    document.title = `${topic.title} · Goals`;
    // View state is kept per topic and per person, so e.g. a half-done statement import on someone
    // else's data never shows up on mine. The selected month carries over.
    const uiKey = person ? `${topic.id}:${person}` : topic.id;
    if (!ui[uiKey]) ui[uiKey] = { month: (ui[topic.id] && ui[topic.id].month) || Fmt.monthKey(new Date()) };

    const editors = sharedWithMe.filter((p) => levelFor(p.id, topic.id) === 'edit');
    if (view === 'dashboard' || editors.length) main.append(peopleBar(topic, view, person));
    const body = document.createElement('div');
    main.append(body);
    Store.watch(person);

    if (!person) {
      Fmt.setCurrency(Store.settings.currency);
      const ctx = {
        data: Store.topic(topic.id), isMe: true, readOnly: false, owner: Store.me, ui: ui[uiKey], storage: Store.backend.mode,
        inputHref: href(topic, 'input'), changed: () => Store.changed(), rerender: render,
      };
      view === 'input' ? topic.renderInput(body, ctx) : topic.renderDashboard(body, ctx);
      return;
    }

    const owner = sharedWithMe.find((p) => p.id === person);
    let level = levelFor(person, topic.id);
    if (!owner || level === 'none') {
      body.innerHTML = `<section class="card empty-state"><p>${owner ? `${esc(owner.name)} doesn't share ${esc(topic.title)} with you.` : "This isn't shared with you."}</p></section>`;
      return;
    }
    if (view === 'input' && level !== 'edit') {
      body.innerHTML = `<section class="card empty-state"><p>${esc(owner.name)} shares ${esc(topic.title)} with you as view only.</p>
        <a class="btn btn-primary" href="${href(topic, 'dashboard', person)}">See ${esc(owner.name)}'s ${esc(label({ id: 'dashboard' }, person).toLowerCase())}</a></section>`;
      return;
    }
    let doc = Store.doc(person);
    if (!doc || !doc.ready) {
      body.innerHTML = '<div class="loading">Loading…</div>';
      try {
        doc = await Store.openDoc(person, sharedAccess[person]);
      } catch (e) {
        if (seq !== renderSeq) return;
        body.innerHTML = `<section class="card empty-state"><p>${esc(e.message)}</p><button class="btn" id="retry-other">Try again</button></section>`;
        $('retry-other').onclick = render;
        return;
      }
      if (seq !== renderSeq) return;
      body.innerHTML = '';
    }
    // The server just told us what this person allows; it wins over the sharing list we had.
    if (doc.access && !Sync.equal(doc.access, sharedAccess[person])) {
      sharedAccess[person] = doc.access;
      return render();
    }
    level = doc.level(topic.id);
    Fmt.setCurrency(doc.blob.settings.currency);
    const ctx = {
      data: level === 'edit' ? doc.topic(topic.id) : doc.blob.topics[topic.id] || {},
      isMe: false, readOnly: level !== 'edit', owner, ui: ui[uiKey], storage: Store.backend.mode,
      inputHref: href(topic, 'input', level === 'edit' ? person : null),
      changed: level === 'edit' ? () => doc.changed() : () => {}, rerender: render,
    };
    view === 'input' ? topic.renderInput(body, ctx) : topic.renderDashboard(body, ctx);
  }

  // On the dashboard: me + everyone who shares this topic with me. On the input screen: me + the
  // people who let me edit it.
  function peopleBar(topic, view, person) {
    const el = document.createElement('div');
    el.className = 'people-bar';
    const level = person ? levelFor(person, topic.id) : 'edit';
    const shown = sharedWithMe.filter((p) => (view === 'input' ? levelFor(p.id, topic.id) === 'edit' : levelFor(p.id, topic.id) !== 'none'));
    const pill = (p, isMe) => {
      const active = isMe ? !person : person === p.id;
      const edit = !isMe && levelFor(p.id, topic.id) === 'edit';
      return `<a class="person-pill${active ? ' active' : ''}" href="${href(topic, view, isMe ? null : p.id)}"${active ? ' aria-current="page"' : ''}
          ${edit ? `title="${esc(p.name)} lets you edit ${esc(topic.title)}"` : ''}>
        ${avatar(p, 'sm')}<span>${isMe ? 'Me' : esc(p.name)}</span>${edit ? '<span class="pill-edit" aria-label="(can edit)">✎</span>' : ''}</a>`;
    };
    el.innerHTML = `
      <div class="people-pills">${pill(Store.me, true)}${shown.map((p) => pill(p, false)).join('')}</div>
      <div class="people-actions">
        ${person && level !== 'none' ? `${level === 'edit'
          ? `<span class="can-edit">✎ ${view === 'input' ? `Editing ${esc((sharedWithMe.find((p) => p.id === person) || {}).name || '')}'s ${esc(topic.title)}` : 'You can edit this'}</span>`
          : '<span class="view-only">View only</span>'}<button class="btn btn-small" data-refresh>Refresh</button>` : ''}
        <button class="btn btn-small" data-share>${myViewers.length ? `Shared with ${myViewers.length}` : 'Share'}</button>
      </div>`;
    el.querySelector('[data-share]').onclick = openSharing;
    const refresh = el.querySelector('[data-refresh]');
    if (refresh) {
      refresh.onclick = async () => {
        refresh.disabled = true;
        await refreshPeople();
        const doc = Store.doc(person);
        try { if (doc) await doc.refresh(); } catch (e) { toast(e.message); }
        render();
      };
    }
    return el;
  }

  async function refreshPeople() {
    try {
      const [all, sharing] = await Promise.all([Store.listUsers(), Store.getSharing()]);
      const before = JSON.stringify([myAccess, sharedAccess]);
      people = all;
      myAccess = sharing.access;
      sharedAccess = sharing.sharedAccess;
      myViewers = Object.keys(myAccess);
      sharedWithMe = all.filter((p) => sharedAccess[p.id]);
      // Changed permissions: their data is loaded again (newly shared topics come in from the server).
      Object.keys(Object.assign({}, JSON.parse(before)[1], sharedAccess)).forEach((id) => Store.accessChanged(id, sharedAccess[id]));
      Store.setCollab(Object.values(myAccess).some((a) => Object.values(a).includes('edit')));
      return before !== JSON.stringify([myAccess, sharedAccess]);
    } catch (e) {
      // Keep whatever we had; the dashboard still works for the signed-in person.
      return false;
    }
  }

  // Someone else's changes were merged into the data on screen: redraw, but not under someone typing.
  const typing = () => {
    const a = document.activeElement;
    return !!a && $('main').contains(a) && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && !/^(checkbox|radio|button)$/.test(a.type)));
  };
  function remoteRender() {
    if (typing()) { remotePending = true; return; }
    render();
    toast('Updated with the latest saved changes.');
  }
  function onRemote(doc) {
    if (!Store.me) return;
    const { person } = route();
    if (person ? doc === Store.doc(person) : doc.mine) remoteRender();
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
    remotePending = false;
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
    people = []; sharedWithMe = []; myViewers = []; myAccess = {}; sharedAccess = {};
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
      blocked: 'Not saved',
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
    $('sharing-save').hidden = true;
    dlg.showModal();
    await refreshPeople();
    if (!dlg.open) return;
    const others = people.filter((p) => p.id !== Store.me.id);
    const sheets = Store.backend.mode === 'sheets';
    const options = (level) => Object.keys(LEVEL_LABELS).map((l) => `<option value="${l}"${l === level ? ' selected' : ''}>${LEVEL_LABELS[l]}</option>`).join('');
    const select = (p, t) => `<label class="topic-access"><span>${esc(t.title)}</span>
      <select class="select access-select" data-viewer="${esc(p.id)}" data-topic="${esc(t.id)}" aria-label="${esc(p.name)}: ${esc(t.title)}">${options(levelOf(myAccess[p.id], t.id))}</select></label>`;
    // One choice for all of my data, unless the person was given different access per topic.
    const overall = (p) => {
      const levels = new Set(topics.map((t) => levelOf(myAccess[p.id], t.id)));
      return levels.size === 1 ? [...levels][0] : 'custom';
    };
    const theirs = (p) => {
      const levels = topics.map((t) => ({ t, level: levelFor(p.id, t.id) }));
      if (new Set(levels.map((x) => x.level)).size === 1) return levels[0].level === 'edit' ? '<strong>can edit everything</strong>' : 'can view everything';
      return levels.filter((x) => x.level !== 'none').map((x) => `${esc(x.t.title)}: ${x.level === 'edit' ? '<strong>can edit</strong>' : 'can view'}`).join(' · ');
    };
    body.innerHTML = `
      ${others.length ? `
        <h3 class="dialog-sub">What others can see and change</h3>
        <p class="hint">“Can edit” lets them work in your data with you: plan meals, add recipes, tick groceries, enter numbers. Changes you both make are merged when they're saved.</p>
        <div class="access-list">${others.map((p) => {
          const o = overall(p);
          return `<div class="access-person" data-person="${esc(p.id)}">
            <div class="access-main"><span class="share-person">${avatar(p)}<span>${esc(p.name)}</span></span>
              <select class="select access-all" data-viewer="${esc(p.id)}" aria-label="${esc(p.name)}: all my data">
                ${options(o === 'custom' ? '' : o).replace(/Can view</, 'Can view everything<').replace(/Can edit</, 'Can edit everything<')}
                <option value="custom"${o === 'custom' ? ' selected' : ''}>Choose per topic…</option></select></div>
            <div class="access-topics"${o === 'custom' ? '' : ' hidden'}>${topics.map((t) => select(p, t)).join('')}</div>
          </div>`;
        }).join('')}</div>` : `
        <p class="empty">Nobody else has a profile yet. ${sheets
          ? 'Send them the web app URL below; they open Goals, choose Google Sheets storage, paste it and add themselves.'
          : 'They can add themselves from the sign-in screen (Switch person → Add person).'}</p>`}
      <h3 class="dialog-sub">Shared with me</h3>
      ${sharedWithMe.length
        ? `<div class="share-list">${sharedWithMe.map((p) => `<div class="share-row">${avatar(p)}<span class="grow">${esc(p.name)}</span>
            <span class="muted share-levels">${theirs(p)}</span></div>`).join('')}</div>`
        : '<p class="empty">Nobody has shared anything with you yet.</p>'}
      ${sheets ? `
        <h3 class="dialog-sub">Invite family</h3>
        <div class="inline-row"><input class="text-input grow" readonly value="${esc(Store.device.backend.url)}" id="invite-url">
          <button type="button" class="btn btn-small" id="copy-invite">Copy</button></div>` : ''}
      <div class="form-error" id="sharing-error"></div>`;
    body.querySelectorAll('.access-all').forEach((sel) => {
      sel.onchange = () => {
        const box = sel.closest('.access-person').querySelector('.access-topics');
        box.hidden = sel.value !== 'custom';
        if (sel.value !== 'custom') box.querySelectorAll('.access-select').forEach((x) => { x.value = sel.value; });
      };
    });
    const copy = $('copy-invite');
    if (copy) copy.onclick = () => { navigator.clipboard.writeText($('invite-url').value); copy.textContent = 'Copied'; };
    $('sharing-save').hidden = !others.length;
  }

  function initSharing() {
    $('sharing-save').addEventListener('click', async (e) => {
      e.preventDefault();
      if (!$('sharing-body').querySelector('.access-list')) return;
      // "Everything" is saved as '*', so topics added later are shared the same way.
      const access = {};
      $('sharing-body').querySelectorAll('.access-person').forEach((row) => {
        const id = row.dataset.person;
        const all = row.querySelector('.access-all').value;
        if (all === 'view' || all === 'edit') { access[id] = { '*': all }; return; }
        if (all !== 'custom') return;
        row.querySelectorAll('.access-select').forEach((sel) => {
          if (sel.value !== 'none') (access[id] = access[id] || {})[sel.dataset.topic] = sel.value;
        });
      });
      const btn = $('sharing-save');
      btn.disabled = true;
      try {
        await Store.setAccess(access);
        myAccess = access;
        myViewers = Object.keys(access);
        Store.setCollab(Object.values(access).some((a) => Object.values(a).includes('edit')));
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
    $('sheets-url').value = Store.device.backend.url || Store.DEFAULT_SHEETS_URL;
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
    toast,
    async start() {
      applyTheme();
      initMenu();
      initSharing();
      initStorage();
      initSettings();
      initTooltip();
      Store.onStatus(updateSync);
      Store.onRemote(onRemote);
      Store.onAuthLost = () => signOut('Please sign in again.');
      Store.rowsProvider = (blob) => Object.assign({}, ...topics.map((t) => (t.exportRows ? t.exportRows(blob.topics[t.id]) : {})));
      Store.topicRowsProvider = (id, data) => { const t = topics.find((x) => x.id === id); return t && t.exportRows ? t.exportRows(data) : {}; };
      addEventListener('hashchange', render);
      // A remote update that waited for typing to finish.
      $('main').addEventListener('focusout', () => setTimeout(() => { if (remotePending && !typing()) remoteRender(); }, 250));
      // Coming back to the app: pick up sharing changes (e.g. someone just let me edit their Food).
      document.addEventListener('visibilitychange', async () => {
        if (document.hidden || !Store.me) return;
        if (await refreshPeople()) render();
      });

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
