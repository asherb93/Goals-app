// Session + data store. Holds the signed-in person's data and the data of people who share with them
// as "documents", caches unsaved changes locally, and saves to the active backend (immediately on this
// device, debounced for Google Sheets).
//
// A document keeps three things: blob (what the screens show and edit), base (the last version agreed
// with the server) and rev (that version's save time). Every save sends rev; if someone else saved in
// between, the backend answers with its newer version and the store merges base/blob/theirs (sync.js)
// and saves again. While someone can edit my data, or I'm looking at someone else's, the store also
// checks for newer saves every few seconds and merges them in.
(function () {
  const DEVICE_KEY = 'goals:device';
  const SAVE_DELAY = 1200;
  const RETRY_DELAY = 10000;
  const POLL_EVERY = 20000;

  function readJSON(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; }
  }

  const device = Object.assign(
    { theme: 'auto', backend: { mode: 'local', url: '' }, session: null },
    readJSON(DEVICE_KEY)
  );
  // Carry the theme over from the first version of the app.
  const legacy = readJSON('goals:v1');
  if (legacy && legacy.settings && legacy.settings.theme && !readJSON(DEVICE_KEY)) device.theme = legacy.settings.theme;

  function saveDevice() { localStorage.setItem(DEVICE_KEY, JSON.stringify(device)); }

  function normalize(raw) {
    const blob = raw && typeof raw === 'object' ? raw : {};
    return {
      version: 2,
      settings: Object.assign({ currency: 'ILS' }, blob.settings),
      topics: blob.topics && typeof blob.topics === 'object' ? blob.topics : {},
    };
  }

  const levelOf = (access, topic) => (access && (access[topic] || access['*'])) || 'none';

  let backend = makeBackend();
  let me = null;
  let mine = null;          // my document
  let docs = {};            // ownerId -> document of someone who shares with me
  let watched = null;       // ownerId of the document on screen, if it isn't mine
  let collab = false;       // someone can edit my data
  let notice = '';
  const statusListeners = [];
  const remoteListeners = [];

  function makeBackend() {
    return device.backend.mode === 'sheets' && device.backend.url
      ? Backends.sheets(device.backend.url)
      : Backends.local;
  }

  const token = () => device.session.token;
  const rowsOf = (blob) => (Store.rowsProvider ? Store.rowsProvider(blob) : {});
  const topicRows = (id, data) => (Store.topicRowsProvider ? Store.topicRowsProvider(id, data) : {});

  const ORDER = ['saved', 'pending', 'saving', 'error'];
  function overallStatus() {
    let worst = 'saved', detail = '';
    [mine].concat(Object.values(docs)).filter(Boolean).forEach((d) => {
      if (ORDER.indexOf(d.status) > ORDER.indexOf(worst)) { worst = d.status; detail = d.detail; }
    });
    return { status: worst, detail };
  }
  function emitStatus() {
    const s = overallStatus();
    statusListeners.forEach((fn) => fn(s.status, s.detail));
  }

  function Doc(ownerId, isMine) {
    this.ownerId = ownerId;
    this.mine = isMine;
    this.blob = normalize(null);
    this.base = null;
    this.rev = null;
    this.access = isMine ? null : {};
    this.dirty = false;
    this.timer = null;
    this.status = 'saved';
    this.detail = '';
    this.blocked = '';
    this.ready = false;
    this.queue = Promise.resolve();
  }

  Doc.prototype = {
    cacheKey() { return `goals:cache:${backend.mode}:${me.id}${this.mine ? '' : ':' + this.ownerId}`; },

    // My data is always cached (it's also the offline copy); someone else's only while it has unsaved changes.
    writeCache() {
      if (!this.mine && !this.dirty) { localStorage.removeItem(this.cacheKey()); return; }
      try {
        localStorage.setItem(this.cacheKey(), JSON.stringify({ data: this.blob, base: this.base, rev: this.rev, pending: this.dirty }));
      } catch (e) { /* storage full: the server copy still gets saved */ }
    },

    setStatus(s, detail) { this.status = s; this.detail = detail || ''; emitStatus(); },

    level(topic) { return this.mine ? 'edit' : levelOf(this.access, topic); },

    topic(id) {
      if (!this.blob.topics[id]) this.blob.topics[id] = {};
      return this.blob.topics[id];
    },

    // Topics of someone else's data this person may change.
    editable(blob) { return Object.keys(blob.topics).filter((t) => this.level(t) === 'edit'); },

    enqueue(fn) {
      this.queue = this.queue.catch(() => {}).then(fn);
      return this.queue;
    },

    // Fold a newer server version into what's on screen, keeping unsaved changes.
    merge(theirs, rev) {
      const merged = normalize(Sync.merge3(this.base || theirs, this.blob, theirs));
      const changed = !Sync.equal(merged, this.blob);
      Sync.patchInPlace(this.blob, merged);
      this.base = Sync.clone(theirs);
      this.rev = rev;
      if (changed) remoteListeners.forEach((fn) => fn(this));
      return changed;
    },

    async load() {
      const cached = readJSON(this.cacheKey());
      let remote;
      try {
        remote = this.mine ? await backend.loadData(token()) : await backend.loadUserData(token(), this.ownerId);
      } catch (e) {
        if (this.mine && e.code === 'OFFLINE' && cached) {
          this.blob = normalize(cached.data);
          this.base = cached.base ? normalize(cached.base) : null;
          this.rev = cached.rev == null ? null : cached.rev;
          this.dirty = !!cached.pending;
          this.ready = true;
          this.setStatus('error', e.message);
          return;
        }
        throw e;
      }
      if (!this.mine && remote && remote.access) this.access = remote.access;
      const theirs = normalize(remote && remote.data);
      const rev = remote && remote.updatedAt != null ? remote.updatedAt : null;
      this.ready = true;
      // Unsaved changes from this device: merge them into what the server has now.
      // (A cache from before versioned saves has no base; its changes then win, as they used to.)
      if (cached && cached.pending) {
        const base = cached.base ? normalize(cached.base) : theirs;
        this.blob = normalize(Sync.merge3(base, normalize(cached.data), theirs));
        this.base = Sync.clone(theirs);
        this.rev = rev;
        this.dirty = true;
        this.save();
        return;
      }
      // First time on Google Sheets: bring this person's numbers over from this device.
      const remoteEmpty = !Object.keys(theirs.topics).length;
      const local = this.mine && backend.mode === 'sheets' && remoteEmpty && Backends.local.dataForName(me.name);
      if (local && Object.keys(local.topics || {}).length) {
        this.blob = normalize(local);
        this.base = Sync.clone(theirs);
        this.rev = rev;
        this.dirty = true;
        notice = `Copied ${me.name}'s numbers from this device to Google Sheets.`;
        this.save();
        return;
      }
      this.blob = theirs;
      this.base = Sync.clone(theirs);
      this.rev = rev;
      this.dirty = false;
      this.writeCache();
      this.setStatus('saved');
    },

    changed() {
      this.dirty = true;
      this.writeCache();
      clearTimeout(this.timer);
      if (backend.mode === 'local') this.save();
      else { this.setStatus('pending'); this.timer = setTimeout(() => this.save(), SAVE_DELAY); }
    },

    save() { clearTimeout(this.timer); return this.enqueue(() => this.saveNow(0)); },

    async saveNow(attempt) {
      if (!this.dirty || !me || this.blocked) return;
      this.dirty = false;
      this.setStatus('saving');
      const sent = Sync.clone(this.blob);
      const topics = this.mine ? null : this.editable(sent);
      let res;
      try {
        if (this.mine) {
          res = await backend.saveData(token(), sent, rowsOf(sent), this.rev);
        } else {
          if (!topics.length) { this.setStatus('saved'); return; }
          const data = {}, rows = {};
          topics.forEach((t) => { data[t] = sent.topics[t]; Object.assign(rows, topicRows(t, sent.topics[t])); });
          res = await backend.saveUserData(token(), this.ownerId, data, this.rev, rows);
        }
      } catch (e) {
        this.dirty = true;
        this.writeCache();
        this.setStatus('error', e.message);
        if (e.code === 'AUTH') { if (Store.onAuthLost) Store.onAuthLost(); return; }
        // Access was taken away, or the sheet's script is too old to accept it: don't keep retrying.
        if (e.code === 'FORBIDDEN' || e.code === 'OLD_SCRIPT') { this.blocked = e.message; return; }
        this.timer = setTimeout(() => this.save(), RETRY_DELAY);
        return;
      }
      if (res && res.conflict) {
        // Someone saved first: merge their version with ours (including edits made meanwhile), then save again.
        this.merge(normalize(res.data), res.updatedAt);
        this.dirty = true;
        if (attempt < 3) return this.saveNow(attempt + 1);
        this.setStatus('pending');
        this.timer = setTimeout(() => this.save(), SAVE_DELAY);
        return;
      }
      if (this.mine) {
        this.base = sent;
      } else {
        const base = Sync.clone(this.base || normalize(null));
        topics.forEach((t) => { base.topics[t] = sent.topics[t]; });
        this.base = base;
      }
      this.rev = res && res.updatedAt != null ? res.updatedAt : this.rev;
      this.writeCache();
      this.setStatus(this.dirty ? 'pending' : 'saved');
    },

    // Get the newest saved version (if it changed) and merge it in.
    refresh() {
      return this.enqueue(async () => {
        if (this.dirty) return; // the pending save merges anyway
        const r = this.mine ? await backend.loadData(token()) : await backend.loadUserData(token(), this.ownerId);
        if (!this.mine && r && r.access) this.access = r.access;
        const rev = r && r.updatedAt != null ? r.updatedAt : null;
        if (rev === this.rev) return;
        this.merge(normalize(r && r.data), rev);
        this.writeCache();
      });
    },

    // Last-chance save when the page closes. If someone saved in between it is refused, but the
    // changes stay in the local cache and get merged the next time the app opens.
    beacon() {
      if (!this.dirty || !backend.beacon) return;
      if (this.mine) {
        backend.beacon('saveData', { token: token(), data: this.blob, rows: rowsOf(this.blob), baseRev: this.rev });
        return;
      }
      const data = {}, rows = {};
      this.editable(this.blob).forEach((t) => { data[t] = this.blob.topics[t]; Object.assign(rows, topicRows(t, this.blob.topics[t])); });
      if (Object.keys(data).length) backend.beacon('saveUserData', { token: token(), ownerId: this.ownerId, topics: data, baseRev: this.rev, rows });
    },
  };

  addEventListener('pagehide', () => {
    if (!me) return;
    [mine].concat(Object.values(docs)).filter(Boolean).forEach((d) => d.beacon());
  });

  // Notice other people's saves: my data while someone can edit it, and the other person's data on screen.
  async function poll(force) {
    if (!me || !mine || !mine.ready || document.hidden) return;
    const list = [];
    if (collab || force) list.push(mine);
    if (watched && docs[watched] && docs[watched].ready) list.push(docs[watched]);
    if (!list.length || !backend.revs) return;
    let revs;
    try {
      revs = await backend.revs(token(), list.filter((d) => !d.mine).map((d) => d.ownerId));
    } catch (e) {
      return; // offline, or an older sheet script: try again next time
    }
    list.forEach((d) => {
      const r = revs[d.ownerId];
      if (r == null || r === d.rev || (!r && d.rev == null)) return;
      d.refresh().catch(() => {});
    });
  }
  setInterval(() => poll(false), POLL_EVERY);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(true); });

  async function startSession(result) {
    me = result.user;
    device.session = { token: result.token, user: me };
    saveDevice();
    await loadMine();
  }

  async function loadMine() {
    docs = {};
    mine = new Doc(me.id, true);
    await mine.load();
  }

  window.Store = {
    device,
    saveDevice,
    rowsProvider: null,      // set by App: blob -> readable rows for the Google Sheet
    topicRowsProvider: null, // set by App: (topicId, topicData) -> that topic's readable rows
    onAuthLost: null,

    get backend() { return backend; },
    get me() { return me; },
    get data() { return mine.blob; },
    get settings() { return mine.blob.settings; },
    get status() { return overallStatus().status; },
    get mine() { return mine; },

    topic(id) { return mine.topic(id); },

    onStatus(fn) { statusListeners.push(fn); },

    // fn(doc) after someone else's changes were merged into a document.
    onRemote(fn) { remoteListeners.push(fn); },

    // One-time message for the UI (e.g. data was copied over), cleared once read.
    takeNotice() { const n = notice; notice = ''; return n; },

    // Call after any change to the signed-in person's data.
    changed() { mine.changed(); },

    flush() { return mine.save(); },

    // Someone else's data (only the topics they share with me). Loaded once, then kept up to date.
    async openDoc(ownerId, access) {
      let d = docs[ownerId];
      if (!d) {
        d = docs[ownerId] = new Doc(ownerId, false);
        if (access) d.access = access;
        d.loading = d.load().catch((e) => { if (docs[ownerId] === d) delete docs[ownerId]; throw e; });
      } else if (access) {
        d.access = access;
      }
      await d.loading;
      return d;
    },

    doc(ownerId) { return docs[ownerId] || null; },

    // The other person's document on screen (null for my own); it gets checked for their changes.
    watch(ownerId) {
      const was = watched;
      watched = ownerId || null;
      if (watched && watched !== was && docs[watched] && docs[watched].ready) docs[watched].refresh().catch(() => {});
    },

    setCollab(on) { collab = !!on; },

    setBackend(mode, url) {
      this.signOut();
      device.backend = { mode, url: url || '' };
      saveDevice();
      backend = makeBackend();
    },

    hasSession() { return !!device.session; },

    // Restore the session saved on this device.
    async resume() {
      me = device.session.user;
      try {
        me = await backend.me(device.session.token);
        device.session.user = me;
        saveDevice();
      } catch (e) {
        if (e.code !== 'OFFLINE') throw e;
      }
      await loadMine();
    },

    async signIn(userId, pin) { await startSession(await backend.login(userId, pin)); },

    async createUser(details) { await startSession(await backend.createUser(details)); },

    signOut() {
      const tok = device.session && device.session.token;
      if (me && tok) {
        [mine].concat(Object.values(docs)).filter((d) => d && d.dirty).forEach((d) => {
          clearTimeout(d.timer);
          if (d.mine) { backend.saveData(tok, d.blob, rowsOf(d.blob), d.rev).catch(() => {}); return; }
          const data = {};
          d.editable(d.blob).forEach((t) => { data[t] = d.blob.topics[t]; });
          if (Object.keys(data).length) backend.saveUserData(tok, d.ownerId, data, d.rev, {}).catch(() => {});
        });
      }
      me = null;
      mine = null;
      docs = {};
      watched = null;
      collab = false;
      device.session = null;
      saveDevice();
    },

    listUsers() { return backend.listUsers(); },

    // Who I share with and who shares with me, per topic. Fills in what an older sheet script leaves out.
    async getSharing() {
      const s = await backend.getSharing(device.session.token);
      const all = (ids) => Object.fromEntries((ids || []).map((id) => [id, { '*': 'view' }]));
      return {
        viewers: s.viewers || [],
        sharedWithMe: s.sharedWithMe || [],
        access: s.access || all(s.viewers),
        sharedAccess: s.sharedAccess || all(s.sharedWithMe),
      };
    },
    setViewers(ids) { return backend.setViewers(device.session.token, ids); },
    setAccess(access) { return backend.setAccess(device.session.token, access); },

    exportJSON() {
      return JSON.stringify({ app: 'goals', exportedAt: new Date().toISOString(), owner: me.name, data: mine.blob }, null, 2);
    },

    importJSON(text) {
      const raw = JSON.parse(text);
      // Accept both this format and backups from the first (single-user) version.
      const data = raw && raw.data && raw.data.topics ? raw.data : raw;
      if (!data || typeof data !== 'object' || !data.topics) throw new Error('This file is not a Goals backup.');
      Sync.patchInPlace(mine.blob, normalize(Sync.clone(data)));
      this.changed();
    },

    resetData() {
      Sync.patchInPlace(mine.blob, normalize({ settings: { currency: mine.blob.settings.currency } }));
      this.changed();
    },
  };
})();
