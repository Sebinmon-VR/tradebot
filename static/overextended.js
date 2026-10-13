/* Overextended page: stocks that ran too far, too fast (published overbought / exhaustion rules) as ranked cards */
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const fmt = (v, d = 2) => (v === null || v === undefined) ? '—' : Number(v).toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d });
  const signed = (v, d = 2) => (v === null || v === undefined) ? '—' : `${v > 0 ? '+' : ''}${Number(v).toFixed(d)}%`;
  const pct = (v, d = 0) => (v === null || v === undefined) ? '—' : `${(v * 100).toFixed(d)}%`;
  const cls = (v) => v > 0 ? 'pos' : v < 0 ? 'neg' : '';
  const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const REFRESH_S = 120;
  const state = { rows: [], all: [], sort: 'score', sortToday: 'peak', side: 'up', search: '', metaRetries: 0, rules: [], rulesToday: [], mode: 'today' };
  const MIN_OPTS = {
    today: [[50, '50+ · stretched'], [35, '35+ · extended'], [25, '25+ · warming up'], [10, '10+ · anything up']],
    daily: [[50, '50+ · stretched'], [35, '35+ · extended'], [20, '20+ · warming up'], [10, '10+ · closest to it']],
  };
  const MIN_DEFAULT = { today: 25, daily: 20 };

  function status(msg, kind = 'error') {
    const el = $('#status');
    if (!msg) { el.hidden = true; return; }
    el.textContent = msg; el.className = 'status ' + (kind === 'info' ? 'info' : ''); el.hidden = false;
  }
  async function api(path) {
    const res = await fetch(path); const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.detail || res.statusText);
    return body;
  }

  // ------------------------------------------------------------ sparkline: last 60 closes + 20-day SMA
  function spark(r) {
    const W = 240, H = 56, P = 3;
    const xs = r.spark || [], sma = r.spark_sma || [];
    if (xs.length < 2) return '';
    const all = xs.concat(sma.filter((v) => v != null));
    const lo = Math.min(...all), hi = Math.max(...all), span = hi - lo || 1;
    const px = (i) => (P + i * (W - 2 * P) / (xs.length - 1)).toFixed(1);
    const py = (v) => (H - P - (v - lo) / span * (H - 2 * P)).toFixed(1);
    const line = xs.map((v, i) => `${px(i)},${py(v)}`).join(' ');
    const smaPts = sma.map((v, i) => v == null ? null : `${px(i)},${py(v)}`).filter(Boolean).join(' ');
    const color = r.tier === 'stretched' ? '#d8433c' : r.tier === 'extended' ? '#b8800a' : '#2f6fed';
    return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-label="last 60 sessions">
      <polyline points="${smaPts}" fill="none" stroke="#9aa3b2" stroke-width="1" stroke-dasharray="3 3"/>
      <polyline points="${line}" fill="none" stroke="${color}" stroke-width="1.6"/>
      <circle cx="${px(xs.length - 1)}" cy="${py(xs[xs.length - 1])}" r="2.4" fill="${color}"/>
    </svg>`;
  }

  // ------------------------------------------------------------ cards
  const REVERSAL = new Set(['candle', 'divergence', 'climax']);
  function reversalPoints(r) { return r.rules.filter((f) => REVERSAL.has(f.key)).reduce((a, f) => a + f.points, 0); }
  function record(r) { const h = r.history; return h.episodes >= 3 && h.lower_share != null ? h.lower_share - (h.uncond_lower_share || 0.5) : -1; }
  function historyHtml(r) {
    const h = r.history;
    const on = h.on_for ? `<span class="badge mid" title="Sessions in a row with the score at or above ${h.threshold}">stretched ${h.on_for} session${h.on_for > 1 ? 's' : ''}</span> ` : '';
    if (!h.episodes) return `${on}<span class="muted">No previous episode above ${h.threshold} in the last 2 years.</span>`;
    const edge = h.lower_share - (h.uncond_lower_share == null ? 0.5 : h.uncond_lower_share);
    const verdict = h.episodes < 3 ? '<span class="badge">too few episodes to judge</span>'
      : edge >= 0.15 ? '<span class="badge bad" title="After previous runs like this the stock has usually pulled back">tends to pull back</span>'
      : edge <= -0.1 ? '<span class="badge ok" title="After previous runs like this the stock has usually kept going">tends to keep running</span>'
      : '<span class="badge mid">no clear pattern</span>';
    return `${on}${verdict} <span class="muted">${h.episodes} past episode${h.episodes > 1 ? 's' : ''} · lower after ${h.fwd_bars} sessions <b class="${edge >= 0.15 ? 'neg' : ''}">${pct(h.lower_share)}</b> (any bar: ${pct(h.uncond_lower_share)}) · avg <b class="${cls(h.avg_fwd_pct)}">${signed(h.avg_fwd_pct)}</b> · typical dip <b>${signed(h.median_dip_pct)}</b> within ${h.dip_bars} · range ${signed(h.worst_fwd_pct, 1)} to ${signed(h.best_fwd_pct, 1)}</span>`;
  }
  function card(r) {
    const stat = (k, v, title) => `<span title="${escapeHtml(title)}"><i>${k}</i>${v}</span>`;
    return `<div class="xcard ${r.tier || ''}" data-sym="${r.symbol}">
      <div class="x-head">
        <div class="x-name"><b>${escapeHtml(r.name)}</b><span class="muted">${escapeHtml(r.sector || '')}${r.via ? ' · NSE data' : ''}</span></div>
        <div class="x-score" title="Overextension score 0-100: ${r.rules.map((f) => `${f.label} ${f.points}`).join(', ') || 'no rule triggered'}"><span class="x-num">${r.score}</span><i class="x-bar"><b style="width:${r.score}%"></b></i><span class="x-tier">${r.tier || ''}</span></div>
      </div>
      <div class="x-price"><b>${fmt(r.price)}</b> <span class="${cls(r.chg_1d)}">${signed(r.chg_1d)}</span> <span class="muted">5d ${signed(r.chg_5d, 1)} · 20d ${signed(r.chg_20d, 1)} · ${r.dist_52w_high == null ? '' : `${signed(r.dist_52w_high, 1)} vs 52-wk high`}</span></div>
      ${spark(r)}
      <div class="x-stats">
        ${stat('RSI 14', r.rsi14 == null ? '—' : r.rsi14.toFixed(0), 'Wilder RSI-14; above 70 = overbought')}
        ${stat('RSI 2', r.rsi2 == null ? '—' : r.rsi2.toFixed(0), 'Connors RSI-2; above 90 = short-term extreme')}
        ${stat('%B', r.bb_pct == null ? '—' : r.bb_pct.toFixed(2), 'Bollinger %B; above 1 = close beyond the upper band')}
        ${stat('vs SMA20', r.stretch20 == null ? '—' : `${r.stretch20 > 0 ? '+' : ''}${r.stretch20.toFixed(1)} ATR`, 'Distance from the 20-day SMA in ATR units')}
        ${stat('streak', `${r.streak}↑`, 'Consecutive up closes')}
        ${stat('20d run', r.z20 == null ? '—' : `${r.z20.toFixed(1)}σ`, '20-day return divided by its own 20-day volatility')}
        ${stat('vol', r.vol_ratio == null ? '—' : `${r.vol_ratio.toFixed(1)}×`, "Today's volume versus the 20-day average")}
      </div>
      <div class="x-rules">${r.rules.map((f) => `<span class="badge ${REVERSAL.has(f.key) ? 'bad' : ''}" title="${escapeHtml(f.origin)}\n${escapeHtml(f.rule)}">${escapeHtml(f.label)} <b>${f.points}</b><span class="muted">/${f.max_points}</span> · ${escapeHtml(f.value)}</span>`).join('') || '<span class="muted">No rule triggered.</span>'}</div>
      <div class="x-hist">${historyHtml(r)}</div>
      <div class="x-foot"><span class="muted" title="The 20-day SMA is the mean these rules measure the stretch from; a pullback to it is the typical mean-reversion target">Mean (SMA20) ${fmt(r.sma20)} · ${signed(r.to_sma20_pct, 1)} away · ATR ${r.atr_pct == null ? '—' : r.atr_pct.toFixed(1) + '%'}</span><button class="btn small primary" data-go="${r.symbol}">Analyze</button></div>
    </div>`;
  }
  // ------------------------------------------------------------ Today view: run from the session open (5-minute bars)
  // Each row carries side = 'up' (ran above the open: R-pivots, the high) or 'down' (fell below it: S-pivots, the low).
  const WORDS = {
    up: { dir: 'above', ext: 'high', lv: 'R', rev: 'closed lower', run: 'run', faded: 'faded', fadeBadge: 'fading', fadeVerb: 'given back', running: 'still running' },
    down: { dir: 'below', ext: 'low', lv: 'S', rev: 'closed higher', run: 'fall', faded: 'bounced', fadeBadge: 'bouncing', fadeVerb: 'recovered', running: 'still falling' },
  };
  const W_ = (r) => WORDS[r.side || state.side] || WORDS.up;
  function sparkToday(r) {
    const W = 240, H = 64, P = 3;
    const xs = r.spark || [], vw = r.spark_vwap || [];
    if (xs.length < 2) return '';
    const L = r.levels || {}, pre = r.level_prefix || 'R';
    const lo0 = Math.min(...xs, r.open), hi0 = Math.max(...xs, r.open), pad = (hi0 - lo0) * 0.15;
    const lv = [[pre + '1', L.l1], [pre + '2', L.l2], [pre + '3', L.l3]].filter(([, v]) => v != null && v >= lo0 - pad && v <= hi0 + pad);
    const all = xs.concat(vw.filter((v) => v != null), [r.open], lv.map(([, v]) => v));
    const lo = Math.min(...all), hi = Math.max(...all), span = hi - lo || 1;
    const n = Math.max(xs.length, 75);   // a full session is 75 five-minute bars: the line fills as the day goes on
    const px = (i) => (P + i * (W - 2 * P) / (n - 1)).toFixed(1);
    const py = (v) => (H - P - (v - lo) / span * (H - 2 * P)).toFixed(1);
    const line = xs.map((v, i) => `${px(i)},${py(v)}`).join(' ');
    const vwPts = vw.map((v, i) => v == null ? null : `${px(i)},${py(v)}`).filter(Boolean).join(' ');
    const color = r.side === 'down' ? (r.tier === 'stretched' ? '#d8433c' : r.tier === 'extended' ? '#b8800a' : '#2f6fed')
      : r.phase === 'fading' || r.tier === 'stretched' ? '#d8433c' : r.tier === 'extended' ? '#b8800a' : '#2f6fed';
    const hline = (v, c, label) => `<line x1="0" x2="${W}" y1="${py(v)}" y2="${py(v)}" stroke="${c}" stroke-width="0.8" stroke-dasharray="3 3"/>` +
      `<text x="${W - 2}" y="${(+py(v) - 2).toFixed(1)}" text-anchor="end" font-size="8" fill="${c}">${label}</text>`;
    return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-label="today's 5-minute closes">
      ${hline(r.open, '#9aa3b2', 'open')}${lv.map(([k, v]) => hline(v, '#c98a1b', k)).join('')}
      <polyline points="${vwPts}" fill="none" stroke="#8a63d2" stroke-width="1" stroke-dasharray="3 2"/>
      <polyline points="${line}" fill="none" stroke="${color}" stroke-width="1.6"/>
      <circle cx="${px(xs.length - 1)}" cy="${py(xs[xs.length - 1])}" r="2.4" fill="${color}"/>
    </svg>`;
  }
  const tierOf = (score) => score >= 50 ? 'stretched' : score >= 35 ? 'extended' : score >= 25 ? 'warming' : '';
  function phaseBadge(r) {
    const w = W_(r);
    if (r.side === 'down') {
      if (r.phase === 'fading') return `<span class="badge mid" title="Fell 35+ today and has recovered half or more of the fall. In the 60-day test this did NOT close higher more often than not: a bounce under way is not evidence it continues">bouncing · ${r.giveback}% recovered</span>`;
      if (r.phase === 'running') return '<span class="badge mid" title="Still stretched below the open and still falling: in the 60-day test these closed higher only about as often as lower, so there is no measured bounce edge">still falling</span>';
      if (r.peak_today >= 35) return '<span class="badge" title="Fell to the extended line earlier today and has steadied, but has not recovered half the fall">steadied</span>';
      return '';
    }
    if (r.phase === 'fading') return `<span class="badge bad" title="Reached 35+ today and has given back half or more of the run from the open: the one version that closed lower more often than not in the 60-day test">fading · ${r.giveback}% given back</span>`;
    if (r.phase === 'running') return `<span class="badge mid" title="Still stretched and still pushing: historically these closed higher about as often as lower, so there is no edge in fading it yet">${w.running}</span>`;
    if (r.peak_today >= 35) return '<span class="badge" title="Reached the extended line earlier today and has cooled off, but has not given back half the run">cooled off</span>';
    return '';
  }
  function histToday(r) {
    const h = r.history, f = h.fade || {}, w = W_(r);
    if (!h.episodes && !f.episodes) return `<span class="muted">No session in the last ${h.sessions} reached ${h.threshold}+ ${w.dir} the open before 14:30.</span>`;
    const part = (name, x) => x.episodes ? `${name}: ${x.episodes}×, ${w.rev} <b class="${x.reversal_share >= 0.6 ? 'neg' : ''}">${pct(x.reversal_share)}</b>, avg to close <b class="${cls(x.avg_fwd_pct)}">${signed(x.avg_fwd_pct)}</b>` : `${name}: never`;
    return `<span class="muted">Own record, last ${h.sessions} sessions · ${part(`crossed ${h.threshold}`, h)} · ${part(w.faded, f)}</span>`;
  }
  function cardToday(r) {
    const stat = (k, v, title) => `<span title="${escapeHtml(title)}"><i>${k}</i>${v}</span>`;
    const t = tierOf(r.peak_today), L = r.levels || {}, w = W_(r), pre = r.level_prefix || 'R';
    const atr = (v) => v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(1)} ATR`;
    return `<div class="xcard ${r.side !== 'down' && r.phase === 'fading' ? 'stretched' : t}" data-sym="${r.symbol}">
      <div class="x-head">
        <div class="x-name"><b>${escapeHtml(r.name)}</b><span class="muted">${escapeHtml(r.sector || '')}</span></div>
        <div class="x-score" title="Peak intraday score today${r.peak_time ? ' at ' + r.peak_time : ''}; score now ${r.score}"><span class="x-num">${r.peak_today}</span><i class="x-bar"><b style="width:${r.peak_today}%"></b></i><span class="x-tier">${t}${r.peak_time ? ' @' + r.peak_time : ''}<br>now ${r.score}</span></div>
      </div>
      <div class="x-price"><b>${fmt(r.price)}</b> <span class="${cls(r.chg_open)}">${signed(r.chg_open)} from open</span> <span class="muted">${w.ext} ${signed(r.extreme_from_open, 1)} · vs prev close ${signed(r.chg_prev, 1)}${Math.abs(r.gap || 0) >= 0.5 ? ` · gap ${signed(r.gap, 1)}` : ''}</span></div>
      ${sparkToday(r)}
      <div class="x-stats">
        ${stat('from open', atr(r.run_atr), "Distance from today's open in units of the stock's daily ATR-14")}
        ${stat(w.ext, atr(r.extreme_atr), `Today's ${w.ext}, in ATR units from the open`)}
        ${stat('vs VWAP', r.vwap_z == null ? '—' : `${r.vwap_z > 0 ? '+' : ''}${r.vwap_z.toFixed(1)}σ`, `Session VWAP ${fmt(r.vwap)}; distance in volume-weighted standard deviations`)}
        ${stat('pivots', r.beyond ? `${r.side === 'down' ? '<' : '>'} ${r.beyond}` : `not past ${pre}1`, `Yesterday's floor pivots: P ${fmt(L.p)} · ${pre}1 ${fmt(L.l1)} · ${pre}2 ${fmt(L.l2)} · ${pre}3 ${fmt(L.l3)}`)}
        ${stat('RSI 5m', r.rsi == null ? '—' : r.rsi.toFixed(0), 'Wilder RSI-14 on 5-minute bars')}
        ${stat('rel vol', r.rvol == null ? '—' : `${r.rvol.toFixed(1)}×`, 'Volume so far today versus the usual by this time of day (20 sessions)')}
      </div>
      <div class="x-rules">${phaseBadge(r)}${r.rules.map((f) => `<span class="badge" title="${escapeHtml(f.origin)}\n${escapeHtml(f.rule)}">${escapeHtml(f.label)} <b>${f.points}</b><span class="muted">/${f.max_points}</span> · ${escapeHtml(f.value)}</span>`).join('') || (r.phase ? '' : '<span class="muted">No rule firing right now.</span>')}</div>
      <div class="x-hist">${histToday(r)}</div>
      <div class="x-foot"><span class="muted" title="Session VWAP and today's open are the usual reversion targets">VWAP ${fmt(r.vwap)} · open ${fmt(r.open)} · ${w.ext} ${fmt(r.extreme)} · ATR ${r.atr_pct == null ? '—' : r.atr_pct.toFixed(1) + '%'}</span><button class="btn small primary" data-go="${r.symbol}">Analyze</button></div>
    </div>`;
  }
  const dirSign = () => state.side === 'down' ? -1 : 1;   // "most" = furthest in the direction of the move
  const SORT_TODAY = {
    peak: (a, b) => b.peak_today - a.peak_today || b.score - a.score,
    fading: (a, b) => (b.phase === 'fading') - (a.phase === 'fading') || (b.giveback || 0) - (a.giveback || 0) || b.peak_today - a.peak_today,
    now: (a, b) => b.score - a.score || b.peak_today - a.peak_today,
    chg_open: (a, b) => dirSign() * ((b.chg_open || 0) - (a.chg_open || 0)),
    vwap_z: (a, b) => dirSign() * ((b.vwap_z || 0) - (a.vwap_z || 0)),
    rvol: (a, b) => (b.rvol || 0) - (a.rvol || 0),
  };
  const SORT = {
    score: (a, b) => b.score - a.score || (b.chg_20d || 0) - (a.chg_20d || 0),
    reversal: (a, b) => reversalPoints(b) - reversalPoints(a) || b.score - a.score,
    record: (a, b) => record(b) - record(a) || b.score - a.score,
    chg_20d: (a, b) => (b.chg_20d || 0) - (a.chg_20d || 0),
    rsi14: (a, b) => (b.rsi14 || 0) - (a.rsi14 || 0),
    stretch20: (a, b) => (b.stretch20 || 0) - (a.stretch20 || 0),
    vol_ratio: (a, b) => (b.vol_ratio || 0) - (a.vol_ratio || 0),
  };
  function render() {
    const minScore = +$('#min-score').value || 0;
    const today = state.mode === 'today';
    const val = (r) => today ? r.peak_today : r.score;
    let rows = state.all.filter((r) => val(r) >= minScore);
    let note = '';
    if (!rows.length && state.all.length) {
      rows = state.all.slice().sort((a, b) => val(b) - val(a)).slice(0, 12);
      note = `<div class="x-note muted">Nothing reaches ${minScore} ${today ? 'today' : 'right now'}: these are the ${rows.length} names closest to it, from ${val(rows[0])} down. ${today ? 'Early in the session, or on a flat or falling day, few stocks run far from the open.' : 'A quiet or falling market rarely has stretched names; check again after a strong up-day.'}</div>`;
    }
    if (state.search) { const q = state.search.toUpperCase(); rows = rows.filter((r) => r.symbol.toUpperCase().includes(q) || (r.sector || '').toUpperCase().includes(q)); }
    rows.sort(today ? (SORT_TODAY[state.sortToday] || SORT_TODAY.peak) : (SORT[state.sort] || SORT.score));
    $('#cards').innerHTML = note + (rows.map(today ? cardToday : card).join('') || `<div class="muted x-empty">No data yet.</div>`);
    $$('#cards [data-go]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); go(b.dataset.go); }));
    $$('#cards .xcard').forEach((c) => c.addEventListener('click', () => go(c.dataset.sym)));
    $('#meta').textContent = `${rows.length} shown of ${state.all.length}`;
  }
  function renderSummary(d) {
    const b = d.base_rate, c = d.counts || {}, T = Object.fromEntries((d.tiers || []).map((t) => [t.name, t.min]));
    const tile = (k, v, t) => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div>${t ? `<div class="muted" style="font-size:11px">${t}</div>` : ''}</div>`;
    const edge = b.lower_share != null && b.uncond_lower_share != null ? b.lower_share - b.uncond_lower_share : null;
    $('#summary').innerHTML = `<div class="stat-tiles ext-tiles">
      ${tile(`Stretched · ${T.stretched}+`, c.stretched || 0, 'several rules at extremes')}${tile(`Extended · ${T.extended}-${T.stretched - 1}`, c.extended || 0, 'clearly overbought')}${tile(`Warming up · ${T.warming}-${T.extended - 1}`, c.warming || 0, 'a rule or two firing')}${tile('Scanned', d.scanned, escapeHtml(d.name))}
    </div>
    <div class="ext-base">${b.episodes ? `<b>Base rate for ${escapeHtml(d.name)}, last ${b.years} years:</b> the score crossed ${b.threshold} <b>${b.episodes}</b> times; <b class="${edge >= 0.1 ? 'neg' : ''}">${pct(b.lower_share)}</b> of those were lower ${b.fwd_bars} sessions later (any bar: ${pct(b.uncond_lower_share)}), average ${signed(b.avg_fwd_pct)} versus ${signed(b.uncond_avg_fwd_pct)} for any bar, median dip ${signed(b.median_dip_pct)} within ${b.dip_bars} sessions. ${edge == null ? '' : edge >= 0.1 ? 'Stretched names in this list have, on average, given some of the run back.' : edge <= -0.05 ? 'Stretched names in this list have, on average, kept running: treat the score as a warning, not a signal.' : 'On average a stretched name here has done about the same as any other bar: the stock-by-stock record on each card matters more than the score.'}` : 'No history yet.'}</div>`;
  }
  function renderSummaryToday(d) {
    const b = d.base_rate, c = d.counts || {}, f = b.fade || {}, w = WORDS[d.side] || WORDS.up, down = d.side === 'down';
    const tile = (k, v, t) => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div>${t ? `<div class="muted" style="font-size:11px">${t}</div>` : ''}</div>`;
    const live = d.session === new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const rec = (x) => x.episodes ? `${w.rev} <b class="${x.reversal_share >= 0.58 ? 'neg' : ''}">${pct(x.reversal_share)}</b> of ${x.episodes} times, average ${signed(x.avg_fwd_pct)} to the close, after moving a further ${signed(x.median_further_pct)} first (median)` : 'had no episodes yet';
    const edge = f.reversal_share != null && b.uncond_reversal_share != null ? f.reversal_share - b.uncond_reversal_share : null;
    const verdict = down
      ? 'No version of "fell too far" has shown a reliable bounce in this data: falling stocks closed higher about as often as lower, and early big drops leaned towards falling further. Use this list to avoid catching a falling knife, not as buy signals.'
      : edge == null ? '' : edge >= 0.07 ? 'Fading names are the ones with an edge; a stock that is still running is not.'
      : 'In this universe even the fading version does not clearly beat the base rate: treat the list as a watchlist, not a signal.';
    $('#summary').innerHTML = `<div class="stat-tiles ext-tiles">
      ${tile(down ? 'Bouncing' : 'Fading', c.fading || 0, down ? 'fell 35+, recovered half' : 'hit 35+, gave back half')}${tile(down ? 'Still falling' : 'Still running', c.running || 0, 'score 35+ now')}${tile('Stretched today · 50+', c.stretched || 0, 'peak score')}${tile('Extended today · 35-49', c.extended || 0, 'peak score')}${tile('Scanned', d.scanned, `${escapeHtml(d.name)} · ${live ? 'live session' : 'last session ' + escapeHtml(d.session || '')}`)}
    </div>
    <div class="ext-base"><b>Pooled record, ${escapeHtml(d.name)}, last ~60 sessions (signals before 14:30):</b> after the score first crossed ${b.threshold} ${w.dir} the open, the stock ${rec(b)}. After it <b>${w.faded}</b> (${escapeHtml(b.fade_rule)}) it ${rec(f)}. Any bar of a ${down ? 'down' : 'up'}-session ${w.rev} ${pct(b.uncond_reversal_share)} of the time. ${verdict}</div>`;
  }
  function renderRules(rules, el = '#rules-list') {
    $(el).innerHTML = (rules || []).map((r) => `<div class="rule"><b>${escapeHtml(r.label)}</b> <span class="badge">${r.weight} pts</span><div class="muted">${escapeHtml(r.rule)}</div><div class="origin">${escapeHtml(r.origin)}</div></div>`).join('');
  }
  function go(symbol) {
    const exchange = symbol.toUpperCase().endsWith('.BO') ? 'BSE' : 'NSE';
    localStorage.setItem('tb.last', JSON.stringify({ symbol, exchange, interval: $('#interval').value, horizon: null }));
    window.location.href = `/?symbol=${encodeURIComponent(symbol)}&exchange=${exchange}&interval=${$('#interval').value}`;
  }

  // ------------------------------------------------------------ loading
  let metaTimer = null;
  async function load() {
    const u = $('#universe').value, wl = $('#watchlist').value.trim(), ms = $('#min-score').value;
    const mode = state.mode;
    saveState({ universe: u, watchlist: wl, ['minScore_' + mode]: ms, mode });
    const btn = $('#refresh'); btn.disabled = true; btn.textContent = 'Scanning…';
    try {
      const side = state.side;
      const d = await api(`/api/overextended${mode === 'today' ? `/intraday?side=${side}&` : '?'}universe=${u}&min_score=0${wl ? '&symbols=' + encodeURIComponent(wl) : ''}`);
      if (mode !== state.mode || (mode === 'today' && side !== state.side)) return;   // the view was switched while this scan ran
      state.all = d.rows; (mode === 'today' ? renderSummaryToday : renderSummary)(d); render();
      if (mode === 'today') renderRules(d.rules, '#rules-list-today');
      if (mode === 'daily' && !state.rules.length) { state.rules = d.rules; renderRules(d.rules); }
      status(d.missing.length ? `No data for: ${d.missing.join(', ')}` : null, 'info');
      $('#meta').textContent += ` · updated ${new Date(d.generated_at).toLocaleTimeString()} (${d.took_s}s)`;
      clearTimeout(metaTimer);
      if (d.meta_pending && state.metaRetries < 4) { state.metaRetries += 1; metaTimer = setTimeout(load, 8000); } else if (!d.meta_pending) state.metaRetries = 0;
    } catch (e) { status(e.message); } finally { btn.disabled = false; btn.textContent = 'Refresh'; }
  }

  function saveState(patch) {
    try { localStorage.setItem('tb.ext', JSON.stringify({ ...savedState(), ...patch })); } catch {}
  }
  function savedState() { try { return JSON.parse(localStorage.getItem('tb.ext') || '{}') || {}; } catch { return {}; } }
  function applyMode() {
    const today = state.mode === 'today';
    $('#chips-today').hidden = !today; $('#chips').hidden = today;
    $('#side-field').hidden = !today;
    const down = state.side === 'down';
    $$('#chips-today .chip').forEach((x) => { if (x.dataset[state.side]) x.textContent = x.dataset[state.side]; });
    $('#down-note').hidden = !(today && down);
    $('#rules-today').hidden = !today; $('#rules-daily').hidden = today;
    $('#min-score').innerHTML = MIN_OPTS[state.mode].map(([v, t]) => `<option value="${v}">${t}</option>`).join('');
    $('#min-score').value = String(savedState()['minScore_' + state.mode] || MIN_DEFAULT[state.mode]);
    if (!$('#min-score').value) $('#min-score').value = String(MIN_DEFAULT[state.mode]);
    $('.brand-sub').textContent = today
      ? (down ? "stocks that fell too far below today's open · 5-minute bars · still falling or bouncing · what happened by the close before"
        : "stocks that ran too far from today's open · 5-minute bars · still running or already fading · what happened by the close before")
      : 'stocks that ran too far, too fast · published overbought and exhaustion rules · what each stock did after its previous episodes';
    $$('#chips-today .chip').forEach((x) => x.classList.toggle('active', x.dataset.sort === state.sortToday));
    $$('#chips .chip').forEach((x) => x.classList.toggle('active', x.dataset.sort === state.sort));
  }

  // ------------------------------------------------------------ events
  $$('#chips .chip').forEach((c) => c.addEventListener('click', () => { state.sort = c.dataset.sort; saveState({ sort: state.sort }); applyMode(); render(); }));
  $$('#chips-today .chip').forEach((c) => c.addEventListener('click', () => { state.sortToday = c.dataset.sort; saveState({ sortToday: state.sortToday }); applyMode(); render(); }));
  $('#side').addEventListener('change', () => {
    state.side = $('#side').value; saveState({ side: state.side }); applyMode();
    state.all = []; $('#cards').innerHTML = '<div class="muted">Scanning…</div>'; $('#summary').innerHTML = '<span class="muted">Scanning…</span>';
    state.metaRetries = 0; load();
  });
  $('#mode').addEventListener('change', () => {
    state.mode = $('#mode').value; saveState({ mode: state.mode }); applyMode();
    state.all = []; $('#cards').innerHTML = '<div class="muted">Scanning…</div>'; $('#summary').innerHTML = '<span class="muted">Scanning…</span>';
    state.metaRetries = 0; load();
  });
  $('#search').addEventListener('input', () => { state.search = $('#search').value.trim(); render(); });
  $('#refresh').addEventListener('click', () => { state.metaRetries = 0; load(); });
  $('#universe').addEventListener('change', () => { state.metaRetries = 0; load(); });
  $('#min-score').addEventListener('change', () => { saveState({ ['minScore_' + state.mode]: $('#min-score').value }); render(); });
  $('#watchlist').addEventListener('change', () => { state.metaRetries = 0; load(); });
  let left = REFRESH_S, timer = null;
  $('#auto').addEventListener('change', () => {
    $('.live-toggle').classList.toggle('on', $('#auto').checked); clearInterval(timer); $('#auto-countdown').textContent = '';
    if (!$('#auto').checked) return;
    left = REFRESH_S; timer = setInterval(async () => { left -= 1; $('#auto-countdown').textContent = `${left}s`; if (left <= 0) { left = REFRESH_S; await load(); } }, 1000);
  });

  // ------------------------------------------------------------ boot
  (async () => {
    const us = await api('/api/universes');
    $('#universe').innerHTML = us.map((u) => `<option value="${u.key}">${u.name} (${u.count})</option>`).join('');
    const saved = savedState();
    if (saved.universe) $('#universe').value = saved.universe;
    $('#watchlist').value = saved.watchlist || '';
    if (saved.minScore && !saved.minScore_daily) saveState({ minScore_daily: saved.minScore });   // setting from before the Today view
    if (saved.sort && SORT[saved.sort]) state.sort = saved.sort;
    if (saved.sortToday && SORT_TODAY[saved.sortToday]) state.sortToday = saved.sortToday;
    const qs = new URLSearchParams(location.search);
    state.side = qs.get('side') === 'down' || (!qs.get('side') && saved.side === 'down') ? 'down' : 'up';
    $('#side').value = state.side;
    const qm = qs.get('mode');
    state.mode = qm === 'daily' || qm === 'today' ? qm : saved.mode === 'daily' ? 'daily' : 'today';
    $('#mode').value = state.mode;
    applyMode();
    if (!$('#universe').value) $('#universe').value = 'nifty100';
    load();
  })();
})();
