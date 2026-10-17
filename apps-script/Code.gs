/**
 * Goals: Google Sheets backend.
 *
 * Paste this whole file into Extensions → Apps Script of the Google Sheet you want to use,
 * then deploy it as a web app (see SETUP.md). The script runs as the sheet owner, so it
 * enforces who can read and edit what: people get their own data plus the topics others shared with
 * them, and can change another person's topic only when it was shared with "can edit".
 * Saves carry the version they were based on; if someone saved in between, the save is refused with
 * the newer version so the app can merge both people's changes and save again.
 *
 * Sheets it creates and maintains:
 *   Users   – one row per person (passcodes are stored as salted hashes)
 *   Data    – each person's app data as JSON (split across columns when large)
 *   Shares  – owner → viewer pairs, with per-topic access as JSON ({"food": "edit", ...}; empty = view all)
 *   Monthly Balance / Income / Targets / Expenses / Transactions / Leftover Plan – readable copies of everyone's numbers
 */

const TOKEN_DAYS = 90;
const MAX_FAILS = 5;
const LOCK_MINUTES = 15;
const CHUNK = 45000; // Sheets cells hold up to 50,000 characters
const MAX_DATA = 1500000;
const RESERVED = ['Users', 'Data', 'Shares'];
const USERS = ['id', 'name', 'color', 'salt', 'pinHash', 'createdAt'];
const SHARES = ['ownerId', 'viewerId', 'createdAt', 'access'];
const LEVELS = ['view', 'edit'];
// Readable tabs each topic writes, so someone editing one topic can't write another topic's tabs.
const TOPIC_TABS = {
  'monthly-balance': ['Monthly Balance', 'Income', 'Targets', 'Expenses', 'Transactions', 'Leftover Plan'],
  'food': ['Groceries', 'Meal Plan'],
};
// Readable-tab columns that were renamed in a later app version, per tab: new name -> old names.
const RENAMED_HEADERS = {
  'Monthly Balance': {
    'Income': ['Net salary'], 'Actual expenses': ['Expenses'], 'Planned leftover': ['Planned'],
    'Target': ['Planned expenses'], 'Card': ['Card spending'],
  },
};

// Every name a column has had (new and old), so rows written by older and newer app versions both map.
function headerAliases(tab, h) {
  const map = RENAMED_HEADERS[tab] || {};
  if (map[h]) return [h].concat(map[h]);
  const now = Object.keys(map).find((k) => map[k].indexOf(h) >= 0);
  return now ? [h, now].concat(map[now].filter((x) => x !== h)) : [h];
}

function doGet() {
  return out({ ok: true, result: { app: 'goals', version: 2 } });
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(25000);
    const req = JSON.parse(e.postData.contents);
    const fn = ACTIONS[req.action];
    if (!fn) throw new Error('Unknown action.');
    return out({ ok: true, result: fn(req) });
  } catch (err) {
    return out({ ok: false, error: String((err && err.message) || err), code: err && err.code });
  } finally {
    try { lock.releaseLock(); } catch (ignored) { /* not held */ }
  }
}

const ACTIONS = {
  ping: () => ({ app: 'goals', version: 2 }),

  listUsers: () => users().map(publicUser),

  createUser: (req) => {
    const name = String(req.name || '').trim();
    if (!name) throw new Error('Please enter a name.');
    if (name.length > 30) throw new Error('Names can be up to 30 characters.');
    if (/^[=+\-@]/.test(name)) throw new Error("Names can't start with = + - or @.");
    const pin = String(req.pin || '');
    if (pin.length < 4) throw new Error('Passcode needs at least 4 characters.');
    if (users().some((u) => u.name.toLowerCase() === name.toLowerCase())) throw new Error('Someone with that name already exists.');
    const color = /^#[0-9a-f]{6}$/i.test(req.color) ? req.color : '#2a78d6';
    const salt = Utilities.getUuid();
    const user = { id: Utilities.getUuid(), name, color, salt, pinHash: hashPin(salt, pin), createdAt: new Date().toISOString() };
    const sh = sheet('Users', USERS);
    writeText(sh.getRange(sh.getLastRow() + 1, 1, 1, USERS.length), [USERS.map((k) => user[k])]);
    return { token: makeToken(user.id), user: publicUser(user) };
  },

  login: (req) => {
    const user = users().find((u) => u.id === req.userId);
    if (!user) throw err('That person no longer exists.', 'AUTH');
    const cache = CacheService.getScriptCache();
    const key = 'fails:' + user.id;
    const fails = Number(cache.get(key) || 0);
    if (fails >= MAX_FAILS) throw new Error(`Too many wrong passcodes. Try again in ${LOCK_MINUTES} minutes.`);
    if (hashPin(user.salt, String(req.pin || '')) !== user.pinHash) {
      cache.put(key, String(fails + 1), LOCK_MINUTES * 60);
      throw new Error('Wrong passcode.');
    }
    cache.remove(key);
    return { token: makeToken(user.id), user: publicUser(user) };
  },

  me: (req) => publicUser(auth(req.token)),

  loadData: (req) => readData(auth(req.token).id),

  saveData: (req) => {
    const user = auth(req.token);
    const rev = revOf(user.id);
    // A copy of the app from before shared editing saves without a version and would undo editors' changes.
    if (req.baseRev == null && rev && shares().some((s) => s.ownerId === user.id && Object.keys(s.access).some((t) => s.access[t] === 'edit'))) {
      throw err('This copy of Goals is out of date. Reload or update it to keep saving.', 'OLD_APP');
    }
    if (req.baseRev != null && rev !== Number(req.baseRev)) {
      const cur = readData(user.id);
      return { conflict: true, data: cur ? cur.data : null, updatedAt: cur ? cur.updatedAt : 0 };
    }
    const updatedAt = writeData(user.id, req.data || {}, rev);
    writeReadable(user, req.rows || {});
    return { updatedAt };
  },

  getSharing: (req) => {
    const user = auth(req.token);
    const all = shares();
    const mine = all.filter((s) => s.ownerId === user.id);
    const theirs = all.filter((s) => s.viewerId === user.id);
    return {
      viewers: mine.map((s) => s.viewerId),
      sharedWithMe: theirs.map((s) => s.ownerId),
      access: Object.fromEntries(mine.map((s) => [s.viewerId, s.access])),
      sharedAccess: Object.fromEntries(theirs.map((s) => [s.ownerId, s.access])),
    };
  },

  // access: {viewerId: {topicId: 'view' | 'edit'}}; people left out (or with nothing) lose access.
  setAccess: (req) => {
    const user = auth(req.token);
    const ids = new Set(users().map((u) => u.id));
    const wanted = req.access && typeof req.access === 'object' ? req.access : {};
    const now = new Date().toISOString();
    const old = shares();
    const created = (id) => (old.find((s) => s.ownerId === user.id && s.viewerId === id) || {}).createdAt || now;
    const mine = Object.keys(wanted)
      .filter((id) => id !== user.id && ids.has(id))
      .map((viewerId) => ({ ownerId: user.id, viewerId, createdAt: created(viewerId), access: cleanAccess(wanted[viewerId]) }))
      .filter((s) => Object.keys(s.access).length);
    writeShares(old.filter((s) => s.ownerId !== user.id).concat(mine));
    return { access: Object.fromEntries(mine.map((s) => [s.viewerId, s.access])) };
  },

  // From older app versions: keeps the per-topic access of people who stay; new people can view all.
  setViewers: (req) => {
    const user = auth(req.token);
    const ids = new Set(users().map((u) => u.id));
    const wanted = (req.viewerIds || []).filter((id) => id !== user.id && ids.has(id));
    const now = new Date().toISOString();
    const old = shares();
    const prev = (id) => old.find((s) => s.ownerId === user.id && s.viewerId === id);
    const next = old.filter((s) => s.ownerId !== user.id).concat(wanted.map((viewerId) => (
      prev(viewerId) || { ownerId: user.id, viewerId, createdAt: now, access: { '*': 'view' } })));
    writeShares(next);
    return { viewers: wanted };
  },

  loadUserData: (req) => {
    const user = auth(req.token);
    const share = shareFor(req.ownerId, user.id);
    const cur = readData(req.ownerId);
    return { data: visible(cur && cur.data, share.access), updatedAt: cur ? cur.updatedAt : 0, access: share.access };
  },

  // topics: {topicId: data} for topics shared with this person as "can edit".
  saveUserData: (req) => {
    const user = auth(req.token);
    const share = shareFor(req.ownerId, user.id);
    const sent = req.topics && typeof req.topics === 'object' ? req.topics : {};
    const ids = Object.keys(sent);
    if (!ids.length) throw new Error('Nothing to save.');
    if (ids.some((t) => levelOf(share.access, t) !== 'edit')) throw err('You can only view this, not edit it.', 'FORBIDDEN');
    const owner = users().find((u) => u.id === req.ownerId);
    if (!owner) throw err('That person no longer exists.', 'FORBIDDEN');
    const cur = readData(owner.id);
    if (req.baseRev != null && (cur ? cur.updatedAt : 0) !== Number(req.baseRev)) {
      return { conflict: true, data: visible(cur && cur.data, share.access), updatedAt: cur ? cur.updatedAt : 0 };
    }
    const next = cur && cur.data && typeof cur.data === 'object' ? cur.data : { version: 2, settings: { currency: 'ILS' }, topics: {} };
    if (!next.topics || typeof next.topics !== 'object') next.topics = {};
    ids.forEach((t) => { next.topics[t] = sent[t]; });
    const updatedAt = writeData(owner.id, next, cur ? cur.updatedAt : 0);
    const tabs = {};
    ids.forEach((t) => (TOPIC_TABS[t] || []).forEach((name) => { if (req.rows && req.rows[name]) tabs[name] = req.rows[name]; }));
    writeReadable(owner, tabs);
    return { updatedAt };
  },

  // Latest save time of my data and of the people who share with me, to notice their changes.
  revs: (req) => {
    const user = auth(req.token);
    const allowed = new Set([user.id].concat(shares().filter((s) => s.viewerId === user.id).map((s) => s.ownerId)));
    const result = {};
    [user.id].concat(Array.isArray(req.ids) ? req.ids : []).forEach((id) => { if (allowed.has(id)) result[id] = 0; });
    dataRevs().forEach((r) => { if (r.id in result) result[r.id] = r.rev; });
    return result;
  },
};

// ---------- Helpers ----------

function out(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function err(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function sheet(name, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function rows(name, headers) {
  const sh = sheet(name, headers);
  if (sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, headers.length).getValues()
    .filter((r) => r[0] !== '')
    .map((r) => Object.fromEntries(headers.map((h, i) => [h, String(r[i])])));
}

function rewrite(sh, headers, values, asText) {
  // Check before clearing, so a value Sheets would refuse can't leave the tab empty.
  if (values.some((r) => r.some((v) => String(v == null ? '' : v).length > 50000))) throw new Error('Too much to save in one cell.');
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, sh.getMaxColumns()).clearContent();
  if (!values.length) return;
  const range = sh.getRange(2, 1, values.length, values[0].length);
  if (asText) writeText(range, values);
  else range.setValues(values);
}

// Plain-text cells: ids, hashes and JSON must come back exactly as written.
function writeText(range, values) {
  range.setNumberFormat('@');
  range.setValues(values.map((r) => r.map((v) => String(v == null ? '' : v))));
}

function users() { return rows('Users', USERS); }

function publicUser(u) { return { id: u.id, name: u.name, color: u.color, hasPin: true }; }

// ---------- Data rows ----------

function dataSheet() { return sheet('Data', ['userId', 'updatedAt', 'json']); }

function dataRevs() {
  const sh = dataSheet();
  if (sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues().map((r) => ({ id: String(r[0]), rev: Number(r[1]) || 0 }));
}

function revOf(userId) {
  const r = dataRevs().find((x) => x.id === userId);
  return r ? r.rev : 0;
}

// Saves are versioned by time; a later save always gets a larger number, even within one millisecond.
function writeData(userId, data, prevRev) {
  const json = JSON.stringify(data || {});
  if (json.length > MAX_DATA) throw new Error('This data is too large to save.');
  const updatedAt = Math.max(Date.now(), (Number(prevRev) || 0) + 1);
  const parts = [];
  // Each part gets a leading "j" so Sheets never reads it as a number, date or formula.
  for (let i = 0; i < json.length; i += CHUNK) parts.push('j' + json.slice(i, i + CHUNK));
  const sh = dataSheet();
  const ids = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().map((r) => r[0]) : [];
  const idx = ids.indexOf(userId);
  const row = idx >= 0 ? idx + 2 : sh.getLastRow() + 1;
  const width = 2 + parts.length;
  if (sh.getMaxColumns() < width) sh.insertColumnsAfter(sh.getMaxColumns(), width - sh.getMaxColumns());
  sh.getRange(row, 1, 1, sh.getMaxColumns()).clearContent();
  writeText(sh.getRange(row, 1, 1, width), [[userId, String(updatedAt)].concat(parts)]);
  return updatedAt;
}

// ---------- Sharing ----------

function cleanAccess(a) {
  const result = {};
  Object.keys(a && typeof a === 'object' ? a : {}).slice(0, 20).forEach((k) => {
    if (/^([\w-]{1,40}|\*)$/.test(k) && LEVELS.indexOf(a[k]) >= 0) result[k] = a[k];
  });
  return result;
}

function parseAccess(text) {
  let a = {};
  try { a = cleanAccess(JSON.parse(text || '{}')); } catch (ignored) { a = {}; }
  // Rows saved before per-topic sharing have no access: they meant "can view everything".
  return Object.keys(a).length ? a : { '*': 'view' };
}

function levelOf(access, topic) { return (access && (access[topic] || access['*'])) || 'none'; }

function shares() {
  const sh = sheet('Shares', SHARES);
  if (String(sh.getRange(1, 4).getValues()[0][0]) !== 'access') sh.getRange(1, 1, 1, SHARES.length).setValues([SHARES]).setFontWeight('bold');
  return rows('Shares', SHARES).map((s) => Object.assign(s, { access: parseAccess(s.access) }));
}

function writeShares(list) {
  rewrite(sheet('Shares', SHARES), SHARES, list.map((s) => [s.ownerId, s.viewerId, s.createdAt, JSON.stringify(s.access)]), true);
}

function shareFor(ownerId, viewerId) {
  const share = shares().find((s) => s.ownerId === ownerId && s.viewerId === viewerId);
  if (!share) throw err('This is not shared with you.', 'FORBIDDEN');
  return share;
}

// Someone else's data as this viewer may see it: only the topics shared with them.
function visible(data, access) {
  const d = data && typeof data === 'object' ? data : {};
  const topics = {};
  Object.keys(d.topics || {}).forEach((t) => { if (levelOf(access, t) !== 'none') topics[t] = d.topics[t]; });
  return { version: 2, settings: d.settings || {}, topics };
}

function readData(userId) {
  const sh = dataSheet();
  if (sh.getLastRow() < 2) return null;
  const values = sh.getRange(2, 1, sh.getLastRow() - 1, sh.getMaxColumns()).getValues();
  const row = values.find((r) => r[0] === userId);
  if (!row) return null;
  const json = row.slice(2).filter((c) => c !== '').map((c) => String(c).slice(1)).join('');
  return { data: JSON.parse(json || '{}'), updatedAt: Number(row[1]) };
}

// Readable per-person rows: for each sheet the app sends, replace this person's rows.
function writeReadable(user, sheets) {
  // The leading apostrophe keeps text as text: no formulas, and "2026-10" doesn't turn into a date.
  const cell = (v) => (typeof v === 'number' && isFinite(v)) || v instanceof Date
    ? v
    : "'" + String(v == null ? '' : v).replace(/^'/, '').slice(0, 1000);
  Object.keys(sheets).slice(0, 10).forEach((name) => {
    if (!/^[A-Za-z][A-Za-z0-9 ]{0,30}$/.test(name) || RESERVED.indexOf(name) >= 0) return;
    const spec = sheets[name] || {};
    const headers = ['Person'].concat((spec.headers || []).map(String)).concat(['Person ID']);
    const sh = sheet(name, headers);
    const width = Math.max(sh.getLastColumn(), headers.length);
    const oldHeaders = sh.getRange(1, 1, 1, width).getValues()[0].map(String);
    const oldId = oldHeaders.indexOf('Person ID');
    const existing = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, width).getValues() : [];
    // Other people's rows may use an older column layout (written by an older app version), so each
    // value is carried over by its header name rather than its position.
    const others = oldId < 0 ? [] : existing
      .filter((r) => { const id = String(r[oldId]).replace(/^'/, ''); return id && id !== user.id; })
      .map((r) => headers.map((h) => {
        const j = headerAliases(name, h).map((x) => oldHeaders.indexOf(x)).find((x) => x >= 0);
        return cell(j != null ? r[j] : '');
      }));
    const mine = (spec.rows || []).map((r) =>
      [cell(user.name)].concat(headers.slice(1, -1).map((_, i) => cell(r[i]))).concat([cell(user.id)]));
    sh.getRange(1, 1, 1, width).clearContent();
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    rewrite(sh, headers, others.concat(mine));
  });
}

function hashPin(salt, pin) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + ':' + pin, Utilities.Charset.UTF_8);
  return bytes.map((b) => ((b + 256) % 256).toString(16).padStart(2, '0')).join('');
}

function secret() {
  const props = PropertiesService.getScriptProperties();
  let s = props.getProperty('TOKEN_SECRET');
  if (!s) {
    s = Utilities.getUuid() + Utilities.getUuid();
    props.setProperty('TOKEN_SECRET', s);
  }
  return s;
}

function sign(text) {
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(text, secret()));
}

function makeToken(userId) {
  const payload = userId + '.' + (Date.now() + TOKEN_DAYS * 864e5);
  return payload + '.' + sign(payload);
}

function auth(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw err('Please sign in again.', 'AUTH');
  const payload = parts[0] + '.' + parts[1];
  if (sign(payload) !== parts[2] || Number(parts[1]) < Date.now()) throw err('Please sign in again.', 'AUTH');
  const user = users().find((u) => u.id === parts[0]);
  if (!user) throw err('Please sign in again.', 'AUTH');
  return user;
}
