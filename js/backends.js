// Storage backends. Both expose the same async API, so the rest of the app doesn't care which is active:
//   listUsers() -> [{id, name, color, hasPin}]
//   createUser({name, pin, color}) / login(userId, pin) -> {token, user}
//   loadData(token) -> {data, updatedAt} | null
//   saveData(token, data, rows, baseRev) -> {updatedAt} | {conflict: true, data, updatedAt}
//   getSharing(token) -> {viewers: [id], sharedWithMe: [id], access: {viewerId: A}, sharedAccess: {ownerId: A}}
//     where A = {<topic id> | '*': 'view' | 'edit'} (a share saved before per-topic sharing is {'*': 'view'})
//   setAccess(token, {viewerId: A}) / setViewers(token, ids)
//   loadUserData(token, ownerId) -> {data (only the topics shared with me), updatedAt, access}
//   saveUserData(token, ownerId, {topicId: data}, baseRev, rows) -> like saveData, for topics I can edit
//   revs(token, ownerIds) -> {id: updatedAt} for me and the owners who share with me
// A save with a baseRev older than what's stored is refused with {conflict} and the stored version, so
// the caller can merge (see sync.js) and save again; nobody's changes get overwritten.
(function () {
  function fail(message, code) {
    const e = new Error(message);
    e.code = code;
    return e;
  }

  function publicUser(u) {
    return { id: u.id, name: u.name, color: u.color, hasPin: !!u.pinHash };
  }

  // ---------- Per-topic access (same rules as apps-script/Code.gs) ----------
  const LEVELS = ['view', 'edit'];
  function cleanAccess(a) {
    const out = {};
    Object.keys(a && typeof a === 'object' ? a : {}).slice(0, 20).forEach((k) => {
      if (/^([\w-]{1,40}|\*)$/.test(k) && LEVELS.includes(a[k])) out[k] = a[k];
    });
    return out;
  }
  const accessOf = (share) => (share.access && Object.keys(share.access).length ? share.access : { '*': 'view' });
  const levelOf = (access, topic) => (access && (access[topic] || access['*'])) || 'none';
  // Someone else's data as a viewer may see it: only the topics shared with them.
  function visible(data, access) {
    const d = data && typeof data === 'object' ? data : {};
    const topics = {};
    Object.keys(d.topics || {}).forEach((t) => { if (levelOf(access, t) !== 'none') topics[t] = d.topics[t]; });
    return { version: 2, settings: d.settings || {}, topics };
  }
  const nextRev = (prev) => Math.max(Date.now(), (Number(prev) || 0) + 1);

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

    async saveData(token, data, rows, baseRev) {
      const d = db();
      const cur = d.data[token];
      if (baseRev != null && (cur ? cur.updatedAt : 0) !== baseRev) return { conflict: true, data: cur ? cur.data : null, updatedAt: cur ? cur.updatedAt : 0 };
      const updatedAt = nextRev(cur && cur.updatedAt);
      d.data[token] = { data, updatedAt };
      put(d);
      return { updatedAt };
    },

    async getSharing(token) {
      const s = db().shares;
      return {
        viewers: s.filter((x) => x.ownerId === token).map((x) => x.viewerId),
        sharedWithMe: s.filter((x) => x.viewerId === token).map((x) => x.ownerId),
        access: Object.fromEntries(s.filter((x) => x.ownerId === token).map((x) => [x.viewerId, accessOf(x)])),
        sharedAccess: Object.fromEntries(s.filter((x) => x.viewerId === token).map((x) => [x.ownerId, accessOf(x)])),
      };
    },

    async setAccess(token, access) {
      const d = db();
      const next = Object.keys(access || {})
        .filter((id) => id !== token && d.users.some((u) => u.id === id))
        .map((viewerId) => ({ ownerId: token, viewerId, access: cleanAccess(access[viewerId]) }))
        .filter((x) => Object.keys(x.access).length);
      d.shares = d.shares.filter((x) => x.ownerId !== token).concat(next);
      put(d);
      return { access: Object.fromEntries(next.map((x) => [x.viewerId, x.access])) };
    },

    // Older callers: keeps each kept viewer's per-topic access; new viewers can view everything.
    async setViewers(token, ids) {
      const d = db();
      const valid = ids.filter((id) => id !== token && d.users.some((u) => u.id === id));
      const old = new Map(d.shares.filter((x) => x.ownerId === token).map((x) => [x.viewerId, x]));
      d.shares = d.shares.filter((x) => x.ownerId !== token)
        .concat(valid.map((viewerId) => ({ ownerId: token, viewerId, access: old.has(viewerId) ? accessOf(old.get(viewerId)) : { '*': 'view' } })));
      put(d);
    },

    async loadUserData(token, ownerId) {
      const d = db();
      const share = d.shares.find((x) => x.ownerId === ownerId && x.viewerId === token);
      if (!share) throw fail('This is not shared with you.', 'FORBIDDEN');
      const cur = d.data[ownerId];
      return { data: visible(cur && cur.data, accessOf(share)), updatedAt: cur ? cur.updatedAt : 0, access: accessOf(share) };
    },

    async saveUserData(token, ownerId, topics, baseRev) {
      const d = db();
      const share = d.shares.find((x) => x.ownerId === ownerId && x.viewerId === token);
      if (!share) throw fail('This is not shared with you.', 'FORBIDDEN');
      const ids = Object.keys(topics || {});
      if (ids.some((t) => levelOf(accessOf(share), t) !== 'edit')) throw fail('You can only view this, not edit it.', 'FORBIDDEN');
      const cur = d.data[ownerId];
      if (baseRev != null && (cur ? cur.updatedAt : 0) !== baseRev) {
        return { conflict: true, data: visible(cur && cur.data, accessOf(share)), updatedAt: cur ? cur.updatedAt : 0 };
      }
      const next = cur && cur.data ? JSON.parse(JSON.stringify(cur.data)) : { version: 2, settings: { currency: 'ILS' }, topics: {} };
      if (!next.topics) next.topics = {};
      ids.forEach((t) => { next.topics[t] = topics[t]; });
      const updatedAt = nextRev(cur && cur.updatedAt);
      d.data[ownerId] = { data: next, updatedAt };
      put(d);
      return { updatedAt };
    },

    async revs(token, ids) {
      const d = db();
      const out = {};
      [token].concat(ids || []).forEach((id) => {
        if (id === token || d.shares.some((x) => x.ownerId === id && x.viewerId === token)) out[id] = d.data[id] ? d.data[id].updatedAt : 0;
      });
      return out;
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
      if (!body.ok) {
        if (body.error === 'Unknown action.') {
          throw fail('The Google Sheet script is an older version. Update Code.gs in Apps Script and deploy a new version (see SETUP.md).', 'OLD_SCRIPT');
        }
        throw fail(body.error || 'Something went wrong.', body.code);
      }
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
      saveData: (token, data, rows, baseRev) => call('saveData', { token, data, rows, baseRev }),
      getSharing: (token) => call('getSharing', { token }),
      setAccess: (token, access) => call('setAccess', { token, access }),
      setViewers: (token, viewerIds) => call('setViewers', { token, viewerIds }),
      loadUserData: (token, ownerId) => call('loadUserData', { token, ownerId }),
      saveUserData: (token, ownerId, topics, baseRev, rows) => call('saveUserData', { token, ownerId, topics, baseRev, rows }),
      revs: (token, ids) => call('revs', { token, ids }),
      // Fire-and-forget save for when the page is closing (action: saveData or saveUserData).
      beacon(action, payload) {
        if (navigator.sendBeacon) navigator.sendBeacon(url, JSON.stringify({ action, ...payload }));
      },
    };
  }

  window.Backends = { local, sheets };
})();
