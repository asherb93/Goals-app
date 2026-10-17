// Storage backends. Both expose the same async API, so the rest of the app doesn't care which is active:
//   listUsers() -> [{id, name, color, hasPin}]
//   createUser({name, pin, color}) / login(userId, pin) -> {token, user}
//   loadData(token) -> {data, updatedAt} | null       saveData(token, data, rows)
//   getSharing(token) -> {viewers: [id], sharedWithMe: [id]}
//   setViewers(token, ids)                            loadUserData(token, ownerId) -> {data, updatedAt} | null
(function () {
  function fail(message, code) {
    const e = new Error(message);
    e.code = code;
    return e;
  }

  function publicUser(u) {
    return { id: u.id, name: u.name, color: u.color, hasPin: !!u.pinHash };
  }

  function checkName(name) {
    name = String(name || '').trim();
    if (!name) throw fail('Please enter a name.');
    if (name.length > 30) throw fail('Names can be up to 30 characters.');
    return name;
  }

  // ---------- This device only (localStorage) ----------
  // Passcodes here only stop someone casually opening another person's profile on a shared computer.
  const LOCAL_KEY = 'goals:local:v2';
  const LEGACY_KEY = 'goals:v1';

  function db() {
    try {
      const d = JSON.parse(localStorage.getItem(LOCAL_KEY));
      if (d && Array.isArray(d.users)) return d;
    } catch (e) { /* fall through */ }
    return { users: [], data: {}, shares: [] };
  }

  function put(d) { localStorage.setItem(LOCAL_KEY, JSON.stringify(d)); }

  async function hashPin(salt, pin) {
    const text = salt + ':' + pin;
    if (window.crypto && crypto.subtle) {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
      return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
    }
    let h = 0;
    for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
    return 'h' + h;
  }

  // Data saved by the first version of the app (single user) goes to the first person created.
  function takeLegacyData() {
    try {
      const old = JSON.parse(localStorage.getItem(LEGACY_KEY));
      if (!old || !old.topics) return null;
      localStorage.setItem(LEGACY_KEY + ':migrated', localStorage.getItem(LEGACY_KEY));
      localStorage.removeItem(LEGACY_KEY);
      return { version: 2, settings: { currency: (old.settings && old.settings.currency) || 'ILS' }, topics: old.topics };
    } catch (e) {
      return null;
    }
  }

  const local = {
    mode: 'local',
    label: 'This device only',

    async listUsers() { return db().users.map(publicUser); },

    async createUser({ name, pin, color }) {
      const d = db();
      name = checkName(name);
      if (d.users.some((u) => u.name.toLowerCase() === name.toLowerCase())) throw fail('Someone with that name already exists.');
      const salt = Fmt.uid();
      const user = { id: Fmt.uid(), name, color, salt, pinHash: pin ? await hashPin(salt, pin) : '' };
      d.users.push(user);
      if (d.users.length === 1) {
        const legacy = takeLegacyData();
        if (legacy) d.data[user.id] = { data: legacy, updatedAt: Date.now() };
      }
      put(d);
      return { token: user.id, user: publicUser(user) };
    },

    async login(userId, pin) {
      const u = db().users.find((x) => x.id === userId);
      if (!u) throw fail('That person no longer exists.', 'AUTH');
      if (u.pinHash && (await hashPin(u.salt, pin || '')) !== u.pinHash) throw fail('Wrong passcode.');
      return { token: u.id, user: publicUser(u) };
    },

    async me(token) {
      const u = db().users.find((x) => x.id === token);
      if (!u) throw fail('Please sign in again.', 'AUTH');
      return publicUser(u);
    },

    async loadData(token) { return db().data[token] || null; },

    async saveData(token, data) {
      const d = db();
      const updatedAt = Date.now();
      d.data[token] = { data, updatedAt };
      put(d);
      return { updatedAt };
    },

    async getSharing(token) {
      const s = db().shares;
      return {
        viewers: s.filter((x) => x.ownerId === token).map((x) => x.viewerId),
        sharedWithMe: s.filter((x) => x.viewerId === token).map((x) => x.ownerId),
      };
    },

    async setViewers(token, ids) {
      const d = db();
      const valid = ids.filter((id) => id !== token && d.users.some((u) => u.id === id));
      d.shares = d.shares.filter((x) => x.ownerId !== token).concat(valid.map((viewerId) => ({ ownerId: token, viewerId })));
      put(d);
    },

    async loadUserData(token, ownerId) {
      const d = db();
      if (!d.shares.some((x) => x.ownerId === ownerId && x.viewerId === token)) throw fail('This dashboard is not shared with you.', 'FORBIDDEN');
      return d.data[ownerId] || null;
    },

    // Used when moving to Google Sheets: the numbers this device has for a person with this name.
    dataForName(name) {
      const d = db();
      const u = d.users.find((x) => x.name.toLowerCase() === String(name).trim().toLowerCase());
      if (u) return d.data[u.id] ? d.data[u.id].data : null;
      if (d.users.length) return null;
      try {
        const old = JSON.parse(localStorage.getItem(LEGACY_KEY));
        return old && old.topics ? { settings: { currency: (old.settings && old.settings.currency) || 'ILS' }, topics: old.topics } : null;
      } catch (e) {
        return null;
      }
    },
  };

  // ---------- Google Sheets (Apps Script web app, see apps-script/SETUP.md) ----------
  function sheets(url) {
    async function call(action, payload) {
      let res;
      try {
        // A plain-text body keeps this a "simple" CORS request, which Apps Script accepts.
        res = await fetch(url, { method: 'POST', body: JSON.stringify({ action, ...payload }) });
      } catch (e) {
        throw fail("Couldn't reach Google Sheets. Check your internet connection.", 'OFFLINE');
      }
      let body;
      try {
        body = await res.json();
      } catch (e) {
        throw fail('Google Sheets sent an unexpected reply. Check the web app URL and that access is set to "Anyone".', 'BAD_URL');
      }
      if (!body.ok) throw fail(body.error || 'Something went wrong.', body.code);
      return body.result;
    }

    return {
      mode: 'sheets',
      label: 'Google Sheets',
      ping: () => call('ping', {}),
      listUsers: () => call('listUsers', {}),
      createUser: (p) => call('createUser', p),
      login: (userId, pin) => call('login', { userId, pin }),
      me: (token) => call('me', { token }),
      loadData: (token) => call('loadData', { token }),
      saveData: (token, data, rows) => call('saveData', { token, data, rows }),
      getSharing: (token) => call('getSharing', { token }),
      setViewers: (token, viewerIds) => call('setViewers', { token, viewerIds }),
      loadUserData: (token, ownerId) => call('loadUserData', { token, ownerId }),
      // Fire-and-forget save for when the page is closing.
      beacon(token, data, rows) {
        if (navigator.sendBeacon) navigator.sendBeacon(url, JSON.stringify({ action: 'saveData', token, data, rows }));
      },
    };
  }

  window.Backends = { local, sheets };
})();
