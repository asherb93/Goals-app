// Session + data store. Holds the signed-in person's data in memory, caches it locally,
// and saves it to the active backend (immediately on this device, debounced for Google Sheets).
(function () {
  const DEVICE_KEY = 'goals:device';
  const SAVE_DELAY = 1200;
  const RETRY_DELAY = 10000;

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

  let backend = makeBackend();
  let me = null;
  let blob = null;
  let dirty = false;
  let saving = false;
  let timer = null;
  let status = 'saved';
  let notice = '';
  const listeners = [];

  function makeBackend() {
    return device.backend.mode === 'sheets' && device.backend.url
      ? Backends.sheets(device.backend.url)
      : Backends.local;
  }

  function cacheKey() { return `goals:cache:${backend.mode}:${me.id}`; }

  function writeCache() {
    localStorage.setItem(cacheKey(), JSON.stringify({ data: blob, pending: dirty }));
  }

  function setStatus(s, detail) {
    status = s;
    listeners.forEach((fn) => fn(s, detail));
  }

  function rows() {
    return Store.rowsProvider ? Store.rowsProvider(blob) : {};
  }

  async function flush() {
    clearTimeout(timer);
    if (!dirty || !me) return;
    if (saving) { timer = setTimeout(flush, SAVE_DELAY); return; }
    saving = true;
    dirty = false;
    setStatus('saving');
    try {
      await backend.saveData(device.session.token, blob, rows());
      writeCache();
      setStatus(dirty ? 'pending' : 'saved');
    } catch (e) {
      dirty = true;
      writeCache();
      setStatus('error', e.message);
      if (e.code === 'AUTH') { Store.onAuthLost && Store.onAuthLost(); return; }
      timer = setTimeout(flush, RETRY_DELAY);
    } finally {
      saving = false;
    }
  }

  addEventListener('pagehide', () => {
    if (dirty && me && backend.beacon) backend.beacon(device.session.token, blob, rows());
  });

  async function startSession(result) {
    me = result.user;
    device.session = { token: result.token, user: me };
    saveDevice();
    await loadMine();
  }

  async function loadMine() {
    const cached = readJSON(cacheKey());
    let remote;
    try {
      remote = await backend.loadData(device.session.token);
    } catch (e) {
      if (e.code === 'OFFLINE' && cached) {
        blob = normalize(cached.data);
        dirty = !!cached.pending;
        setStatus('error', e.message);
        return;
      }
      throw e;
    }
    // Unsaved changes from this device win over what the server has.
    if (cached && cached.pending) {
      blob = normalize(cached.data);
      dirty = true;
      flush();
      return;
    }
    // First time on Google Sheets: bring this person's numbers over from this device.
    const remoteEmpty = !remote || !remote.data || !Object.keys(remote.data.topics || {}).length;
    const local = backend.mode === 'sheets' && remoteEmpty && Backends.local.dataForName(me.name);
    if (local && Object.keys(local.topics || {}).length) {
      blob = normalize(local);
      dirty = true;
      notice = `Copied ${me.name}'s numbers from this device to Google Sheets.`;
      flush();
    } else {
      blob = normalize(remote && remote.data);
      dirty = false;
      writeCache();
      setStatus('saved');
    }
  }

  window.Store = {
    device,
    saveDevice,
    rowsProvider: null, // set by App: blob -> readable rows for the Google Sheet
    onAuthLost: null,

    get backend() { return backend; },
    get me() { return me; },
    get data() { return blob; },
    get settings() { return blob.settings; },
    get status() { return status; },

    topic(id) {
      if (!blob.topics[id]) blob.topics[id] = {};
      return blob.topics[id];
    },

    onStatus(fn) { listeners.push(fn); },

    // One-time message for the UI (e.g. data was copied over), cleared once read.
    takeNotice() { const n = notice; notice = ''; return n; },

    // Call after any change to the signed-in person's data.
    changed() {
      dirty = true;
      writeCache();
      clearTimeout(timer);
      if (backend.mode === 'local') flush();
      else { setStatus('pending'); timer = setTimeout(flush, SAVE_DELAY); }
    },

    flush,

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
      clearTimeout(timer);
      if (dirty && me) backend.saveData(device.session.token, blob, rows()).catch(() => {});
      me = null;
      blob = null;
      dirty = false;
      device.session = null;
      saveDevice();
    },

    listUsers() { return backend.listUsers(); },
    getSharing() { return backend.getSharing(device.session.token); },
    setViewers(ids) { return backend.setViewers(device.session.token, ids); },

    async loadUser(ownerId) {
      const r = await backend.loadUserData(device.session.token, ownerId);
      return normalize(r && r.data);
    },

    exportJSON() {
      return JSON.stringify({ app: 'goals', exportedAt: new Date().toISOString(), owner: me.name, data: blob }, null, 2);
    },

    importJSON(text) {
      const raw = JSON.parse(text);
      // Accept both this format and backups from the first (single-user) version.
      const data = raw && raw.data && raw.data.topics ? raw.data : raw;
      if (!data || typeof data !== 'object' || !data.topics) throw new Error('This file is not a Goals backup.');
      blob = normalize(data);
      this.changed();
    },

    resetData() {
      blob = normalize({ settings: { currency: blob.settings.currency } });
      this.changed();
    },
  };
})();
