// App shell for every page: icon rail (desktop), top bar (search, market status, cash, theme), bottom dock (phone).
// Pages include static/theme.js in <head> and this script at the end of <body>, with <body data-page="...">.
(() => {
  const I = {
    ready: '<path d="M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.6 6.6 19.5l1.2-6L3.3 9.3l6.1-.7z"/>',
    movers: '<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
    chart: '<path d="M4 19V5"/><path d="M4 19h16"/><path d="M8 15v-4M12 15V8M16 15v-6"/>',
    portfolio: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5h8v2"/>',
    today: '<path d="M12 3v18"/><path d="M5 10l7-7 7 7"/>',
    map: '<rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="5" rx="1.5"/><rect x="13" y="10" width="8" height="11" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
    out: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
    wallet: '<rect x="2" y="6" width="20" height="14" rx="2"/><path d="M16 13h2"/><path d="M2 10h20"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
    profit: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.2"/>',
    more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
  };
  const svg = (k, s = 20) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${I[k]}</svg>`;
  const MAIN = [['ready', '/', 'Ready'], ['movers', '/movers', 'Movers'], ['chart', '/chart', 'Chart'], ['portfolio', '/portfolio', 'Portfolio']];
  const MORE = [['today', '/overextended', 'Today · overextended'], ['map', '/screener', 'Market map'], ['profit', '/profit', 'Profit model']];
  const page = document.body.dataset.page || '';
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  if (!document.querySelector('link[data-shell-font]')) {
    const f = document.createElement('link');
    f.rel = 'stylesheet'; f.dataset.shellFont = '1';
    f.href = 'https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&display=swap';
    document.head.appendChild(f);
  }

  // ---- rail
  const ri = ([k, href, label]) => `<a class="sh-ri${k === page ? ' on' : ''}" href="${href}" aria-label="${label}">${svg(k)}<span class="tip">${label}</span></a>`;
  const rail = document.createElement('nav');
  rail.className = 'sh-rail';
  rail.innerHTML = `<a class="sh-logo" href="/" aria-label="TradeBot home"><i></i></a>${MAIN.map(ri).join('')}<div class="sep"></div>${MORE.map(ri).join('')}
    <div class="grow"></div><a class="sh-ri" href="/portfolio#settings" aria-label="Capital and fees">${svg('settings')}<span class="tip">Capital &amp; fees</span></a>
    <button class="sh-ri" id="sh-out" aria-label="Sign out" hidden>${svg('out')}<span class="tip">Sign out</span></button>`;

  // ---- top bar
  const top = document.createElement('header');
  top.className = 'sh-top';
  top.innerHTML = `<a class="sh-brand" href="/">TRADEBOT</a>
    <div class="sh-search">${svg('search', 18)}<input id="sh-q" type="search" placeholder="Search NSE stocks…" autocomplete="off" aria-label="Search stocks"><div class="sh-sugg" id="sh-sugg" hidden></div></div>
    <div class="grow"></div>
    <div class="sh-mm"><button class="sh-chip sh-mm-btn" id="sh-mm" aria-expanded="false" aria-controls="sh-mm-panel" title="Model meter: how often the models are right">
      <span class="sh-mm-mini"></span><span class="full">Models</span><b class="sh-mm-v">—</b></button>
      <div class="sh-mm-panel" id="sh-mm-panel" hidden></div></div>
    <span class="sh-chip" id="sh-market"><i></i><span class="full">Market</span><span class="short">Market</span></span>
    <a class="sh-chip cash" id="sh-cash" href="/portfolio">${svg('wallet', 17)}<span class="num">₹—</span></a>
    <button class="sh-icon" id="sh-theme" aria-label="Switch theme"></button>`;

  // ---- phone dock + more sheet
  const dock = document.createElement('nav');
  dock.className = 'sh-dock';
  const moreOn = MORE.some(([k]) => k === page);
  dock.innerHTML = MAIN.map(([k, href, label]) => `<a href="${href}" class="${k === page ? 'on' : ''}"><i>${svg(k)}</i>${label}</a>`).join('') +
    `<button id="sh-more" class="${moreOn ? 'on' : ''}"><i>${svg('more')}</i>More</button>`;
  const sheet = document.createElement('div');
  sheet.className = 'sh-sheet'; sheet.hidden = true;
  sheet.innerHTML = `<div class="sh-sheet-card">${MORE.map(([k, href, label]) => `<a href="${href}">${svg(k)}${label}</a>`).join('')}
    <a href="/portfolio#settings">${svg('settings')}Capital &amp; fees</a><button id="sh-out-m" hidden>${svg('out')}Sign out</button></div>`;

  document.body.prepend(top);
  document.body.prepend(rail);
  document.body.append(dock, sheet);
  document.body.classList.add('has-shell');
  dock.querySelector('#sh-more').addEventListener('click', () => { sheet.hidden = !sheet.hidden; });
  sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.hidden = true; });

  // ---- theme
  const themeBtn = top.querySelector('#sh-theme');
  const paintTheme = () => {
    const t = document.documentElement.getAttribute('data-theme') || 'dark';
    themeBtn.innerHTML = svg(t === 'dark' ? 'sun' : 'moon', 18);
    themeBtn.title = t === 'dark' ? 'Light theme' : 'Dark theme';
  };
  themeBtn.addEventListener('click', () => {
    const t = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem('tb.theme', t); } catch {}
    paintTheme();
    window.dispatchEvent(new CustomEvent('tb-theme', { detail: t }));   // charts recolour themselves
  });
  paintTheme();

  // ---- search: NSE symbols -> chart
  const q = top.querySelector('#sh-q'), sugg = top.querySelector('#sh-sugg');
  let timer = null, hits = [], hl = -1;
  const go = (sym) => { location.href = `/?symbol=${encodeURIComponent(sym)}&exchange=NSE&interval=15m`; };
  const paintSugg = () => {
    sugg.hidden = !hits.length;
    sugg.innerHTML = hits.map((h, i) => `<a href="#" data-s="${esc(h.symbol)}" class="${i === hl ? 'hl' : ''}"><b>${esc(h.symbol.replace(/\.(NS|BO)$/, ''))}</b><small>${esc(h.name || h.exchange || '')}</small></a>`).join('');
    sugg.querySelectorAll('a').forEach((a) => a.addEventListener('mousedown', (e) => { e.preventDefault(); go(a.dataset.s); }));
  };
  q.addEventListener('input', () => {
    clearTimeout(timer);
    const v = q.value.trim();
    if (!v) { hits = []; paintSugg(); return; }
    timer = setTimeout(async () => {
      try { hits = (await (await fetch('/api/search?q=' + encodeURIComponent(v))).json()).slice(0, 7); } catch { hits = []; }
      hl = -1; paintSugg();
    }, 220);
  });
  q.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { hl = Math.min(hits.length - 1, hl + 1); paintSugg(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { hl = Math.max(-1, hl - 1); paintSugg(); e.preventDefault(); }
    else if (e.key === 'Enter') { const v = hl >= 0 ? hits[hl].symbol : q.value.trim().toUpperCase(); if (v) go(v); }
    else if (e.key === 'Escape') { hits = []; paintSugg(); }
  });
  q.addEventListener('blur', () => setTimeout(() => { sugg.hidden = true; }, 150));

  // ---- live bits: market status, cash, sign-out
  async function market() {
    try {
      const m = await (await fetch('/api/market')).json();
      const el = top.querySelector('#sh-market');
      el.className = 'sh-chip ' + m.state;
      el.title = m.state === 'open' ? 'NSE is open' : 'Next session: ' + m.next_open_label;
      el.querySelector('.full').textContent = m.state === 'open' ? 'Market open' : m.label;
      el.querySelector('.short').textContent = { open: 'Open', holiday: 'Holiday', weekend: 'Weekend', pre: 'Pre-open', closed: 'Closed' }[m.state] || 'Market';
    } catch {}
  }
  async function cash() {
    try {
      const p = await (await fetch('/api/portfolio')).json();
      top.querySelector('#sh-cash span').textContent = '₹' + Number(p.cash).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    } catch {}
  }
  async function session() {
    try {
      const s = await (await fetch('/api/session')).json();
      if (!s.auth) return;
      for (const b of [rail.querySelector('#sh-out'), sheet.querySelector('#sh-out-m')]) {
        b.hidden = false;
        b.addEventListener('click', async () => { await fetch('/api/logout', { method: 'POST' }); location.href = '/login'; });
      }
    } catch {}
  }
  // ---- model meter: live record of real calls + every learner's walk-forward accuracy across the trained charts
  // Gauge scale 30-80%: the solid tick is a coin flip (50%), the dashed tick the drift baseline (always calling the prevailing direction).
  const MM_LO = 0.3, MM_HI = 0.8;
  const mmPct = (v, d = 0) => v == null ? '—' : (v * 100).toFixed(d) + '%';
  const mmCls = (v, base) => v == null ? '' : v < 0.5 ? 'bad' : v >= Math.max(0.55, (base || 0) + 0.01) ? 'good' : 'mid';
  const mmAng = (v) => Math.PI * Math.max(0, Math.min(1, (v - MM_LO) / (MM_HI - MM_LO)));
  const mmAt = (v, r) => { const a = mmAng(v); return [(50 - r * Math.cos(a)).toFixed(1), (46 - r * Math.sin(a)).toFixed(1)]; };
  const mmArc = (v0, v1) => { const [x0, y0] = mmAt(v0, 36), [x1, y1] = mmAt(v1, 36); return `M${x0} ${y0}A36 36 0 0 1 ${x1} ${y1}`; };
  const mmTick = (v, cls) => { const [x0, y0] = mmAt(v, 28), [x1, y1] = mmAt(v, 44); return `<line class="${cls}" x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}"/>`; };
  const mmBar = (v, base) => v == null ? '' : `<path class="mm-val ${mmCls(v, base)}" d="${mmArc(MM_LO, Math.max(MM_LO + 0.002, v))}"/>`;
  // `cls` overrides the colour (the profit model colours by money made, not by hit rate)
  function mmGauge(label, v, base, sub, tip, cls) {
    const bar = v == null ? '' : `<path class="mm-val ${cls || mmCls(v, base)}" d="${mmArc(MM_LO, Math.max(MM_LO + 0.002, v))}"/>`;
    return `<div class="mm-g" title="${esc(tip)}"><svg viewBox="0 0 100 54" aria-hidden="true"><path class="mm-trk" d="${mmArc(MM_LO, MM_HI)}"/>${bar}
      ${mmTick(0.5, 'mm-coin')}${base != null ? mmTick(base, 'mm-base') : ''}<text x="50" y="44" text-anchor="middle">${mmPct(v)}</text></svg>
      <div class="mm-l">${esc(label)}</div><div class="mm-s">${esc(sub)}</div></div>`;
  }
  const mmBtn = top.querySelector('#sh-mm'), mmPanel = top.querySelector('#sh-mm-panel');
  const MM_ORDER = [['logistic_regression', 'Logistic'], ['random_forest', 'Random forest'], ['gradient_boosting', 'Boosting'], ['stacked_votes', 'Stacked votes'], ['wf_ensemble', 'Ensemble']];
  function paintMeter(d) {
    const L = d.live || {}, base = d.base_rate, M = d.models || {};
    const rec = (b) => { const n = b ? b.correct + b.incorrect + (b.partial || 0) : 0; return n ? { v: (b.correct + 0.5 * (b.partial || 0)) / n, n } : { v: null, n: 0 }; };
    const up = rec((L.by_direction || {}).UP), dn = rec((L.by_direction || {}).DOWN);
    mmBtn.querySelector('.sh-mm-v').textContent = mmPct(L.accuracy);
    mmBtn.querySelector('.sh-mm-mini').innerHTML = `<svg viewBox="0 0 100 54" aria-hidden="true"><path class="mm-trk" d="${mmArc(MM_LO, MM_HI)}"/>${mmBar(L.accuracy)}</svg>`;
    mmBtn.title = `Model meter: real calls right ${mmPct(L.accuracy)} of the time (${L.calls || 0} graded)`;
    const models = MM_ORDER.filter(([k]) => M[k]).map(([k, label]) => mmGauge(label, M[k].accuracy, base, `beats drift on ${mmPct(M[k].beats_drift)}`,
      `${M[k].name}: right ${mmPct(M[k].accuracy, 1)} on past bars it never trained on, averaged over ${M[k].charts} charts. It beat simply following the drift (${mmPct(base, 1)}) on ${mmPct(M[k].beats_drift)} of them.`
      + (k === 'wf_ensemble' ? ` ${mmPct(M[k].validated)} of charts have a validated calling level.` : ''))).join('');
    mmPanel.innerHTML = `<div class="mm-h"><b>Live record</b><span>${L.calls || 0} real calls graded · ${L.no_call || 0} no-calls · ${L.pending || 0} pending</span></div>
      <div class="mm-grid">${mmGauge('All calls', L.accuracy, null, `${L.calls || 0} calls`, 'Saved calls graded against what the price actually did next (no-calls excluded). This is the number that matters.')}
        ${mmGauge('UP calls', up.v, null, `${up.n} calls`, 'Buy-side calls: right when the price closed higher at the horizon or touched the target.')}
        ${mmGauge('DOWN calls', dn.v, null, `${dn.n} calls`, 'Sell-side calls: right when the price closed lower at the horizon or touched the target.')}</div>
      <div class="mm-h"><b>Models (walk-forward)</b><span>average over ${d.charts || 0} trained charts${d.intervals && d.intervals.length ? ' · ' + d.intervals.join(', ') : ''}</span></div>
      ${models ? `<div class="mm-grid">${models}</div>` : '<p class="mm-s">No trained charts yet. Open a chart or let the Ready scanner run.</p>'}
      <div class="mm-key"><span><i></i>50% coin flip</span>${base != null ? `<span><i class="k-base"></i>drift ${mmPct(base)}: always calling the prevailing direction</span>` : ''}</div>
      <div id="sh-pm"></div>`;
    profitSection();
  }
  // the independent profit model has its own section, loaded separately: if it is off or fails, the section just stays empty
  const pmNet = (v) => v == null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}% / trade`;
  const pmCls = (o) => !o || o.avg_net == null ? '' : o.avg_net > 0 ? 'good' : 'bad';
  async function profitSection() {
    const el = mmPanel.querySelector('#sh-pm'); if (!el) return;
    try {
      const d = await (await fetch('/api/profit/summary')).json();
      if (!d.charts && !(d.live && d.live.n)) { el.innerHTML = `<div class="mm-h mm-pm"><b>Profit model</b><span>${d.status && d.status.enabled === false ? 'paused' : 'training… (first pass takes a while)'} · <a href="/profit">open</a></span></div>`; return; }
      const b = d.baseline || {}, m = d.model || {}, L = d.live || {};
      el.innerHTML = `<div class="mm-h mm-pm"><b>Profit model <small>independent</small></b><span>made money after fees? · ${d.charts} stocks · <a href="/profit">open</a></span></div>
        <div class="mm-grid">${mmGauge('Every trade', b.win, null, pmNet(b.avg_net), `Every replayed trade, long and short, after charges: wins ${mmPct(b.win, 1)}, average ${pmNet(b.avg_net)} over ${b.n || 0} trades. The bar to beat.`, pmCls(b))}
          ${mmGauge('Model picks', m.win, b.win, pmNet(m.avg_net), `Out-of-sample trades the model would have taken (P(win) ≥ 50%): wins ${mmPct(m.win, 1)}, average ${pmNet(m.avg_net)} over ${m.n || 0} trades. Dashed tick: every trade.`, pmCls(m))}
          ${mmGauge('Live', L.win, null, L.n ? pmNet(L.avg_net) : `${L.pending || 0} pending`, `Its own live TAKE calls, graded like the training trades: ${L.n || 0} finished, ${L.pending || 0} pending.`, pmCls(L))}</div>`;
    } catch { el.innerHTML = ''; }
  }
  window.tbGauge = mmGauge;           // shared with the profit-model page
  window.tbGaugeKeys = { pct: mmPct };
  async function meter() {
    try { paintMeter(await (await fetch('/api/model-scores')).json()); } catch {}
  }
  const mmClose = () => { mmPanel.hidden = true; mmBtn.setAttribute('aria-expanded', 'false'); };
  mmBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    mmPanel.hidden = !mmPanel.hidden; mmBtn.setAttribute('aria-expanded', String(!mmPanel.hidden));
    if (!mmPanel.hidden) meter();
  });
  document.addEventListener('click', (e) => { if (!mmPanel.hidden && !mmPanel.contains(e.target)) mmClose(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !mmPanel.hidden) { mmClose(); mmBtn.focus(); } });

  market(); cash(); session(); meter();
  setInterval(market, 60000); setInterval(cash, 60000); setInterval(meter, 300000);
})();
