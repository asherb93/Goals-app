/**
 * Goals: Google Sheets backend.
 *
 * Paste this whole file into Extensions → Apps Script of the Google Sheet you want to use,
 * then deploy it as a web app (see SETUP.md). The script runs as the sheet owner, so it
 * enforces who can read what: people only get their own data plus dashboards shared with them.
 *
 * Sheets it creates and maintains:
 *   Users   – one row per person (passcodes are stored as salted hashes)
 *   Data    – each person's app data as JSON (split across columns when large)
 *   Shares  – owner → viewer pairs (view-only)
 *   Monthly Balance / Expenses / Leftover Plan – readable copies of everyone's numbers
 */

const TOKEN_DAYS = 90;
const MAX_FAILS = 5;
const LOCK_MINUTES = 15;
const CHUNK = 45000; // Sheets cells hold up to 50,000 characters
const MAX_DATA = 1500000;
const RESERVED = ['Users', 'Data', 'Shares'];
const USERS = ['id', 'name', 'color', 'salt', 'pinHash', 'createdAt'];
const SHARES = ['ownerId', 'viewerId', 'createdAt'];

function doGet() {
  return out({ ok: true, result: { app: 'goals', version: 1 } });
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
  ping: () => ({ app: 'goals', version: 1 }),

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
    const json = JSON.stringify(req.data || {});
    if (json.length > MAX_DATA) throw new Error('Your data is too large to save.');
    const updatedAt = Date.now();
    const parts = [];
    // Each part gets a leading "j" so Sheets never reads it as a number, date or formula.
    for (let i = 0; i < json.length; i += CHUNK) parts.push('j' + json.slice(i, i + CHUNK));
    const sh = sheet('Data', ['userId', 'updatedAt', 'json']);
    const ids = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().map((r) => r[0]) : [];
    const idx = ids.indexOf(user.id);
    const row = idx >= 0 ? idx + 2 : sh.getLastRow() + 1;
    const width = 2 + parts.length;
    if (sh.getMaxColumns() < width) sh.insertColumnsAfter(sh.getMaxColumns(), width - sh.getMaxColumns());
    sh.getRange(row, 1, 1, sh.getMaxColumns()).clearContent();
    writeText(sh.getRange(row, 1, 1, width), [[user.id, String(updatedAt)].concat(parts)]);
    writeReadable(user, req.rows || {});
    return { updatedAt };
  },

  getSharing: (req) => {
    const user = auth(req.token);
    const shares = rows('Shares', SHARES);
    return {
      viewers: shares.filter((s) => s.ownerId === user.id).map((s) => s.viewerId),
      sharedWithMe: shares.filter((s) => s.viewerId === user.id).map((s) => s.ownerId),
    };
  },

  setViewers: (req) => {
    const user = auth(req.token);
    const ids = new Set(users().map((u) => u.id));
    const wanted = (req.viewerIds || []).filter((id) => id !== user.id && ids.has(id));
    const now = new Date().toISOString();
    const kept = rows('Shares', SHARES).filter((s) => s.ownerId !== user.id);
    const next = kept.concat(wanted.map((viewerId) => ({ ownerId: user.id, viewerId, createdAt: now })));
    rewrite(sheet('Shares', SHARES), SHARES, next.map((s) => SHARES.map((k) => s[k])), true);
    return { viewers: wanted };
  },

  loadUserData: (req) => {
    const user = auth(req.token);
    const shared = rows('Shares', SHARES).some((s) => s.ownerId === req.ownerId && s.viewerId === user.id);
    if (!shared) throw err('This dashboard is not shared with you.', 'FORBIDDEN');
    return readData(req.ownerId);
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

function readData(userId) {
  const sh = sheet('Data', ['userId', 'updatedAt', 'json']);
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
  Object.keys(sheets).slice(0, 6).forEach((name) => {
    if (!/^[A-Za-z][A-Za-z0-9 ]{0,30}$/.test(name) || RESERVED.indexOf(name) >= 0) return;
    const spec = sheets[name] || {};
    const headers = ['Person'].concat((spec.headers || []).map(String)).concat(['Person ID']);
    const last = headers.length - 1;
    const sh = sheet(name, headers);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    const existing = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, headers.length).getValues() : [];
    const idOf = (r) => String(r[last]).replace(/^'/, '');
    const others = existing.filter((r) => idOf(r) && idOf(r) !== user.id).map((r) => r.map(cell));
    const mine = (spec.rows || []).map((r) =>
      [cell(user.name)].concat(headers.slice(1, -1).map((_, i) => cell(r[i]))).concat([cell(user.id)]));
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
