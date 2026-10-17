// Formatting and small shared helpers.
(function () {
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

  let currency = 'ILS';
  const formatters = {};

  function moneyFormatter(decimals) {
    const k = currency + decimals;
    if (!formatters[k]) {
      formatters[k] = new Intl.NumberFormat('en-US', {
        style: 'currency', currency, minimumFractionDigits: decimals, maximumFractionDigits: decimals,
      });
    }
    return formatters[k];
  }

  window.Fmt = {
    // The app sets this to the currency of whoever's data is on screen.
    setCurrency(c) { currency = c || 'ILS'; },

    num(v) {
      const n = typeof v === 'number' ? v : parseFloat(v);
      return Number.isFinite(n) ? n : 0;
    },

    money(n) {
      n = Math.round(Fmt.num(n) * 100) / 100;
      if (Object.is(n, -0)) n = 0;
      return moneyFormatter(Number.isInteger(n) ? 0 : 2).format(n);
    },

    // ₪12.5K style, for axis ticks and tight labels.
    compactMoney(n) {
      const a = Math.abs(n);
      const s = a >= 1e6 ? +(a / 1e6).toFixed(1) + 'M' : a >= 1e3 ? +(a / 1e3).toFixed(1) + 'K' : String(Math.round(a));
      return (n < 0 ? '−' : '') + Fmt.currencySymbol() + s;
    },

    currencySymbol() {
      const part = moneyFormatter(0).formatToParts(0).find((p) => p.type === 'currency');
      return part ? part.value : currency;
    },

    // ratio 0..1 -> "12%" (one decimal below 10%)
    pct(ratio) {
      if (!Number.isFinite(ratio)) return '–';
      const p = ratio * 100;
      return (Math.abs(p) < 9.95 && p !== 0 ? p.toFixed(1) : Math.round(p)) + '%';
    },

    monthKey(date) {
      return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0');
    },

    shiftMonth(key, delta) {
      const [y, m] = key.split('-').map(Number);
      return Fmt.monthKey(new Date(y, m - 1 + delta, 1));
    },

    monthLabel(key, short) {
      const [y, m] = key.split('-').map(Number);
      return short ? MONTHS[m - 1].slice(0, 3) + ' ' + String(y).slice(2) : MONTHS[m - 1] + ' ' + y;
    },

    monthName(key) {
      return MONTHS[Number(key.split('-')[1]) - 1];
    },

    initials(name) {
      const parts = String(name || '?').trim().split(/\s+/);
      return ((parts[0] || '?')[0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
    },

    uid() {
      return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    },

    esc(s) {
      return String(s ?? '').replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
      ));
    },
  };
})();
