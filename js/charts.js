// Reusable chart builders. Each returns an HTML string. Marks follow the dataviz spec:
// 2px surface gaps between fills, 4px rounded data ends, ink-colored text, hover tooltips
// via data-tip, a legend, and a "Show as table" fallback.
(function () {
  const { money, pct, esc } = Fmt;
  const sum = (arr) => arr.reduce((a, b) => a + b, 0);

  function tipAttrs(title, sub) {
    return `tabindex="0" data-tip="${esc(title)}"${sub ? ` data-tip-sub="${esc(sub)}"` : ''}`;
  }

  function table(headers, rows) {
    return `
      <details class="table-toggle">
        <summary>Show as table</summary>
        <table>
          <thead><tr>${headers.map((h, i) => `<th${i ? ' class="num"' : ''}>${esc(h)}</th>`).join('')}</tr></thead>
          <tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td${i ? ' class="num"' : ''}>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody>
        </table>
      </details>`;
  }

  // items: {name, color, value?, sub?, dashed?}
  function legend(items, cls) {
    return `
      <ul class="legend ${cls || ''}">
        ${items.map((i) => `
          <li><span class="swatch${i.dashed ? ' dashed' : ''}" style="${i.dashed ? `border-color:${i.color}` : `background:${i.color}`}"></span>
            <span class="legend-name" dir="auto">${esc(i.name)}</span>
            ${i.value != null ? `<span class="legend-value">${esc(i.value)}</span>` : ''}
            ${i.sub != null ? `<span class="legend-sub">${esc(i.sub)}</span>` : ''}</li>`).join('')}
      </ul>`;
  }

  // One horizontal 100% bar. segs: {name, amount, color}; base = the 100% reference (e.g. salary).
  function stackBar(segs, { base, baseLabel, markerLabel }) {
    segs = segs.filter((s) => s.amount > 0);
    const total = sum(segs.map((s) => s.amount));
    if (!total) return '';
    const denom = Math.max(total, base || 0);
    const share = (a) => (base > 0 ? pct(a / base) : '–');
    const overflow = base > 0 && total > base + 0.005;
    return `
      <div class="stack-bar-wrap${overflow ? ' has-marker' : ''}">
        <div class="stack-bar" style="width:${(total / denom) * 100}%">
          ${segs.map((s) => `<div class="seg" style="flex-grow:${s.amount};background:${s.color}"
            ${tipAttrs(s.name, money(s.amount) + (base > 0 ? ` · ${share(s.amount)} of ${baseLabel}` : ''))}></div>`).join('')}
        </div>
        ${overflow ? `<div class="bar-marker" style="left:${(base / denom) * 100}%"><span>${esc(markerLabel)}</span></div>` : ''}
      </div>
      ${legend(segs.map((s) => ({ name: s.name, color: s.color, value: money(s.amount), sub: share(s.amount) })), 'legend-grid')}
      ${table(['Part', 'Amount', `% of ${baseLabel}`], segs.map((s) => [s.name, money(s.amount), share(s.amount)]))}`;
  }

  // "+3 more" under a capped list; the table view always has every row.
  function moreNote(n) { return `<p class="more-note" data-more="${n}"${n > 0 ? '' : ' hidden'}>+${n} more in the table view</p>`; }

  // Ranked horizontal bars. items: {name, amount, color, tag?}; limit caps the visible rows.
  function barList(items, { basis, basisLabel, empty, limit }) {
    const all = items.filter((i) => i.amount > 0).sort((a, b) => b.amount - a.amount);
    if (!all.length) return `<p class="empty">${esc(empty)}</p>`;
    const shown = limit ? all.slice(0, limit) : all;
    const max = Math.max(...shown.map((i) => i.amount));
    const share = (a) => (basis > 0 ? pct(a / basis) : '–');
    return `
      <div class="bar-list">
        ${shown.map((i) => `
          <div class="bar-row" ${tipAttrs(i.name, money(i.amount) + (basis > 0 ? ` · ${share(i.amount)} of ${basisLabel}` : '') + (i.tag ? ` · ${i.tag}` : ''))}>
            <span class="bar-name"><span dir="auto">${esc(i.name)}</span>${i.tag ? `<span class="bar-tag"><span class="swatch" style="background:${i.color}"></span>${esc(i.tag)}</span>` : ''}</span>
            <span class="bar-track"><span class="bar" style="width:${(i.amount / max) * 100}%;background:${i.color}"></span></span>
            <span class="bar-value">${money(i.amount)}</span>
          </div>`).join('')}
      </div>
      ${moreNote(all.length - shown.length)}
      ${table(['Name', 'Amount', `% of ${basisLabel}`], all.map((i) => [i.name + (i.tag ? ` (${i.tag})` : ''), money(i.amount), share(i.amount)]))}`;
  }

  // Donut for part-to-whole at a glance. Items keep their given (entity) order around the ring;
  // the legend lists them by size. Keep to <= 6 segments: fold the rest before calling.
  function donut(items, { centerLabel, empty }) {
    items = items.filter((i) => i.amount > 0);
    const total = sum(items.map((i) => i.amount));
    if (!total) return `<p class="empty">${esc(empty)}</p>`;
    const S = 200, cx = 100, cy = 100, R = 92, r = 60;
    const pt = (rad, a) => [cx + rad * Math.sin(a), cy - rad * Math.cos(a)];
    let a0 = 0;
    const arcs = items.map((i) => {
      const a1 = a0 + (i.amount / total) * Math.PI * 2;
      const tip = tipAttrs(i.name, `${money(i.amount)} · ${pct(i.amount / total)}`);
      let shape;
      if (items.length === 1) {
        shape = `<circle cx="${cx}" cy="${cy}" r="${(R + r) / 2}" fill="none" stroke="${i.color}" stroke-width="${R - r}"/>`;
      } else {
        const large = a1 - a0 > Math.PI ? 1 : 0;
        const [x0, y0] = pt(R, a0), [x1, y1] = pt(R, a1), [x2, y2] = pt(r, a1), [x3, y3] = pt(r, a0);
        shape = `<path d="M${x0},${y0}A${R},${R} 0 ${large} 1 ${x1},${y1}L${x2},${y2}A${r},${r} 0 ${large} 0 ${x3},${y3}Z" fill="${i.color}"/>`;
      }
      a0 = a1;
      return `<g class="donut-seg" ${tip}>${shape}</g>`;
    }).join('');
    const ranked = [...items].sort((a, b) => b.amount - a.amount);
    return `
      <div class="donut-wrap">
        <div class="donut">
          <svg viewBox="0 0 ${S} ${S}" role="img" aria-label="${esc(centerLabel)}">${arcs}</svg>
          <div class="donut-center"><span class="donut-total">${money(total)}</span><span class="donut-label">${esc(centerLabel)}</span></div>
        </div>
        ${legend(ranked.map((i) => ({ name: i.name, color: i.color, value: money(i.amount), sub: pct(i.amount / total) })), 'legend-list')}
      </div>
      ${table(['Category', 'Amount', 'Share'], ranked.map((i) => [i.name, money(i.amount), pct(i.amount / total)]))}`;
  }

  function niceTicks(max, count) {
    const raw = (max || 1) / count;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map((s) => s * mag).find((s) => s >= raw);
    const ticks = [];
    for (let v = 0; v < max + step * 0.999; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
    if (ticks.length < 2) ticks.push(step);
    return ticks;
  }

  // Path for a column segment; only the top end is rounded when `round` is set.
  function colPath(x, w, yTop, yBottom, round) {
    const r = round ? Math.min(4, w / 2, yBottom - yTop) : 0;
    return `M${x},${yBottom}V${yTop + r}Q${x},${yTop} ${x + r},${yTop}H${x + w - r}Q${x + w},${yTop} ${x + w},${yTop + r}V${yBottom}Z`;
  }

  // Stacked columns over time. points: {label, segments: [{name, value, color}], marker?, tip, tipSub, selected, note?}
  // width/height: the box to draw into, in px, so labels stay true size when a card is resized.
  function columns(points, { legendItems, ariaLabel, tableHeaders, tableRows, width, height }) {
    const W = Math.max(320, Math.round(width || 640)), H = Math.max(110, Math.round(height || 240));
    const padL = 52, padR = 8, padT = 26, padB = 28;
    const max = Math.max(1, ...points.map((p) => Math.max(sum(p.segments.map((s) => s.value)), p.marker || 0)));
    const ticks = niceTicks(max, 4);
    const hi = ticks[ticks.length - 1];
    const y = (v) => padT + (1 - v / hi) * (H - padT - padB);
    const band = (W - padL - padR) / points.length;
    const bw = Math.min(44, band * 0.62);
    const GAP = 2;

    const grid = ticks.map((t) => `
      <line x1="${padL}" x2="${W - padR}" y1="${y(t)}" y2="${y(t)}" class="${t === 0 ? 'axis' : 'grid'}"/>
      <text x="${padL - 8}" y="${y(t)}" class="tick" text-anchor="end" dominant-baseline="middle">${Fmt.compactMoney(t)}</text>`).join('');

    const cols = points.map((p, i) => {
      const x = padL + band * i + (band - bw) / 2;
      const cx = x + bw / 2;
      const segs = p.segments.filter((s) => s.value > 0);
      let base = 0;
      const shapes = segs.map((s, k) => {
        const top = y(base + s.value);
        const bottom = y(base) - (k > 0 ? GAP : 0);
        base += s.value;
        return bottom - top > 0.5 ? `<path d="${colPath(x, bw, top, bottom, k === segs.length - 1)}" fill="${s.color}"/>` : '';
      }).join('');
      const marker = p.marker ? `<line x1="${x - 4}" x2="${x + bw + 4}" y1="${y(p.marker)}" y2="${y(p.marker)}" class="col-marker"/>` : '';
      const note = p.note ? `<text x="${cx}" y="${y(base) - 7}" class="value-label" text-anchor="middle">${esc(p.note)}</text>` : '';
      return `
        <g class="col${p.selected ? ' selected' : ''}" ${tipAttrs(p.tip, p.tipSub)}>
          <rect x="${padL + band * i}" y="${padT - 20}" width="${band}" height="${H - padT - padB + 20}" class="hit"/>
          ${shapes}${marker}${note}
          <text x="${cx}" y="${H - 8}" class="tick${p.selected ? ' strong' : ''}" text-anchor="middle">${esc(p.label)}</text>
        </g>`;
    }).join('');

    return `
      ${legend(legendItems, 'legend-inline')}
      <svg class="columns" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(ariaLabel)}">${grid}${cols}</svg>
      ${table(tableHeaders, tableRows)}`;
  }

  // Target vs actual per row: the bar is actual, the dashed tick is the target. items: {name, actual, planned, color}
  function bulletList(items, { empty, planLabel = 'Target', noPlan = 'No target', limit }) {
    // Rows with a target first (that's the comparison people came for), then by size.
    const all = items.filter((i) => i.actual > 0 || i.planned > 0)
      .sort((a, b) => (b.planned > 0) - (a.planned > 0) || Math.max(b.actual, b.planned) - Math.max(a.actual, a.planned));
    if (!all.length) return `<p class="empty">${esc(empty)}</p>`;
    const shown = limit ? all.slice(0, limit) : all;
    const max = Math.max(...shown.map((i) => Math.max(i.actual, i.planned)));
    const status = (i) => {
      if (i.status) return { text: i.status, cls: 'muted' };
      if (!i.planned) return { text: noPlan, cls: 'muted' };
      const d = i.actual - i.planned;
      if (d > 0.005) return { text: `⚠ ${money(d)} over`, cls: 'negative' };
      return { text: `${money(-d)} left`, cls: 'muted' };
    };
    return `
      ${legend([{ name: 'Actual', color: 'var(--ink-2)' }, { name: planLabel, color: 'var(--ink)', dashed: true }], 'legend-inline')}
      <div class="bullet-list">
        ${shown.map((i) => {
          const s = status(i);
          return `
          <div class="bullet-row" ${tipAttrs(i.name, i.status ? `${planLabel} ${money(i.planned)} · ${i.status}` : `Actual ${money(i.actual)} · ${planLabel} ${i.planned ? money(i.planned) : '–'}`)}>
            <span class="bar-name"><span class="swatch" style="background:${i.color}"></span> <span dir="auto">${esc(i.name)}</span></span>
            <span class="bullet-track">
              ${i.actual > 0 ? `<span class="bar" style="width:${(i.actual / max) * 100}%;background:${i.color}"></span>` : ''}
              ${i.planned ? `<span class="bullet-plan" style="left:${(i.planned / max) * 100}%"></span>` : ''}
            </span>
            <span class="bullet-values"><strong>${money(i.actual)}</strong><span class="muted"> / ${i.planned ? money(i.planned) : '–'}</span>
              <span class="bullet-status ${s.cls}">${esc(s.text)}</span></span>
          </div>`;
        }).join('')}
      </div>
      ${moreNote(all.length - shown.length)}
      ${table(['Category', 'Actual', planLabel, 'Difference'], all.map((i) => [i.name, i.status ? '–' : money(i.actual), i.planned ? money(i.planned) : '–', i.status || (i.planned ? money(i.actual - i.planned) : '–')]))}`;
  }

  window.Charts = { table, legend, stackBar, barList, bulletList, donut, columns };
})();
