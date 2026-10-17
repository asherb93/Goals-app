// Merging for shared editing. Two people (or one person on two devices) can change the same data
// between saves. The store keeps the last version both sides agreed on ("base") and merges three ways:
//   Sync.merge3(base, mine, theirs) -> both sides' changes. When both changed the same value, mine (the
//     save being made now) wins; a value deleted on one side but changed on the other is kept.
//     Lists of objects with an id (recipes, expenses, transactions…) are merged item by item.
//   Sync.patchInPlace(target, source) -> makes target equal to source but keeps target's objects where
//     they still exist, so a screen holding references into the data keeps editing the live data.
(function () {
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

  function equal(a, b) {
    if (a === b) return true;
    if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => equal(x, b[i]));
    if (isObj(a) && isObj(b)) {
      const ka = Object.keys(a).filter((k) => a[k] !== undefined);
      const kb = Object.keys(b).filter((k) => b[k] !== undefined);
      return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && equal(a[k], b[k]));
    }
    return false;
  }

  const hasId = (x) => isObj(x) && (typeof x.id === 'string' || typeof x.id === 'number') && x.id !== '';
  const idList = (v) => Array.isArray(v) && v.every(hasId) && new Set(v.map((x) => x.id)).size === v.length;

  function merge3(base, mine, theirs) {
    if (equal(mine, theirs)) return clone(mine);
    if (equal(base, mine)) return clone(theirs);
    if (equal(base, theirs)) return clone(mine);
    if (mine === undefined) return clone(theirs);
    if (theirs === undefined) return clone(mine);
    if (isObj(mine) && isObj(theirs)) {
      const b = isObj(base) ? base : {};
      const out = {};
      new Set([...Object.keys(b), ...Object.keys(mine), ...Object.keys(theirs)]).forEach((k) => {
        const v = merge3(b[k], mine[k], theirs[k]);
        if (v !== undefined) out[k] = v;
      });
      return out;
    }
    if (idList(mine) && idList(theirs)) return mergeList(idList(base) ? base : [], mine, theirs);
    return clone(mine);
  }

  // Items keep my order; items only the other side has go right after their neighbour in that list.
  function mergeList(base, mine, theirs) {
    const byId = (a) => new Map(a.map((x) => [x.id, x]));
    const B = byId(base), M = byId(mine), T = byId(theirs);
    const pick = (id) => merge3(B.get(id), M.get(id), T.get(id));
    const out = [];
    const seen = new Set();
    mine.forEach((m) => {
      seen.add(m.id);
      const v = pick(m.id);
      if (v !== undefined) out.push(v);
    });
    theirs.forEach((t, i) => {
      if (seen.has(t.id)) return;
      seen.add(t.id);
      const v = pick(t.id);
      if (v === undefined) return;
      let at = 0;
      for (let j = i - 1; j >= 0; j--) {
        const k = out.findIndex((x) => x.id === theirs[j].id);
        if (k >= 0) { at = k + 1; break; }
      }
      out.splice(at, 0, v);
    });
    return out;
  }

  function reuse(old, value) {
    if ((isObj(old) && isObj(value)) || (Array.isArray(old) && Array.isArray(value))) return patchInPlace(old, value);
    return clone(value);
  }

  function patchInPlace(target, source) {
    if (Array.isArray(target)) {
      let next;
      if (idList(target) && idList(source)) {
        const old = new Map(target.map((x) => [x.id, x]));
        next = source.map((x) => reuse(old.get(x.id), x));
      } else {
        next = source.map((x, i) => reuse(target[i], x));
      }
      target.length = 0;
      next.forEach((x) => target.push(x));
      return target;
    }
    Object.keys(target).forEach((k) => { if (!Object.prototype.hasOwnProperty.call(source, k)) delete target[k]; });
    Object.keys(source).forEach((k) => { target[k] = reuse(target[k], source[k]); });
    return target;
  }

  window.Sync = { merge3, patchInPlace, equal, clone };
})();
