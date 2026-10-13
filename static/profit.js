// Profit model page (GET /api/profit): the independent "would this trade make money after charges?" model -
// its meter, current decisions, per-stock report and live record.  Read only: nothing here places or changes anything.
(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const num = (v, d = 2) => (v == null || !isFinite(v) ? '—' : Number(v).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d }));
  const pct = (v, d = 0) => (v == null ? '—' : (v * 100).toFixed(d) + '%');
  const net = (v) => (v == null ? '—' : `<span class="${v > 0 ? 'up' : v < 0 ? 'down' : ''}">${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}%</span>`);
  const netTxt = (v) => (v == null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}% / trade`);
  const cls = (o) => (!o || o.avg_net == null ? '' : o.avg_net > 0 ? 'good' : 'bad');
  const name = (s) => esc(String(s || '').replace(/\.(NS|BO)$/, ''));
  const timeIST = (iso) => (iso ? new Date(iso.endsWith('Z') || iso.includes('+') ? iso : iso + 'Z').toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : '—');
  const ago = (sec) => (sec == null ? '' : sec < 90 ? 'just now' : sec < 3600 ? Math.round(sec / 60) + ' min ago' : Math.round(sec / 3600) + ' h ago');
  const gauge = (...a) => (window.tbGauge ? window.tbGauge(...a) : '');
  const chart = (s, itv) => `/?symbol=${encodeURIComponent(s)}&exchange=NSE&interval=${itv || '15m'}`;
  const decision = (d) => d === 'LONG' ? '<span class="bdg buy">TAKE LONG</span>' : d === 'SHORT' ? '<span class="bdg sell">TAKE SHORT</span>' : '<span class="bdg mute">SKIP</span>';

  let data = null, tab = (location.hash || '').slice(1) || 'take';

  function status(s) {
    const el = $('#pm-status');
    if (!s || s.enabled === false) { el.textContent = 'Paused'; el.className = 'pill'; return; }
    if (!s.alive) { el.textContent = s.heartbeat ? `Stopped · last seen ${ago(s.heartbeat_age)}` : 'Starting…'; el.className = 'pill'; return; }
    el.className = 'pill up';
    el.textContent = s.running ? `● Scanning ${s.done || 0} / ${s.total || 0}${s.current ? ' · ' + name(s.current) : ''}` : `● Idle · last pass ${timeIST(s.pass_finished)}`;
  }

  function meter(d) {
    const b = d.baseline || {}, m = d.model || {}, c = d.chosen || {}, L = d.live || {};
    if (!d.charts) {
      $('#pm-meter').innerHTML = `<div class="empty"><b>Training the first stocks.</b> The first pass trains every stock on the Ready list (about 20 s each, at idle priority so
        nothing else slows down). Results appear here as they finish.</div>`;
      return;
    }
    $('#pm-meter').innerHTML = `<div class="pm-grid">
      ${gauge('Every trade', b.win, null, netTxt(b.avg_net), `Every replayed trade after charges, long and short: ${b.n || 0} trades. The bar to beat.`, cls(b))}
      ${gauge('Model picks', m.win, b.win, netTxt(m.avg_net), `Out-of-sample trades the model would have taken (P(win) ≥ 50%): ${m.n || 0} trades. No level chosen in hindsight.`, cls(m))}
      ${gauge('Best level', c.win, b.win, c.n ? netTxt(c.avg_net) : 'none found', `Each stock's best tested probability level (${c.n || 0} trades). Optimistic: the level was picked after seeing these results.`, cls(c))}
      ${gauge('Live', L.win, null, L.n ? netTxt(L.avg_net) : `${L.pending || 0} pending`, `Its own TAKE calls graded like the training trades: ${L.n || 0} finished, ${L.pending || 0} pending.`, cls(L))}
    </div>
    <div class="pm-kv"><span>Stocks trained <b>${d.charts}</b></span><span>Sides with a tested edge <b>${d.validated_sides} / ${d.sides}</b></span>
      <span>Take now <b>${d.take_now}</b></span><span>Win rate can sit below 50% and still pay: the target is 1.5× the stop</span></div>`;
    const note = $('#pm-note');
    note.hidden = !(m.n && b.n);
    if (!note.hidden) {
      const better = m.avg_net != null && b.avg_net != null && m.avg_net > b.avg_net;
      note.className = 'note' + (m.avg_net > 0 ? '' : ' amber');
      note.innerHTML = `<span><b>${m.avg_net > 0 ? 'The model\'s picks made money after charges' : better ? 'The model\'s picks lost less than trading every bar, but still lost money' : 'The model\'s picks did not beat trading every bar'}</b>
        on bars it never trained on: ${netTxt(m.avg_net)} over ${m.n} trades, against ${netTxt(b.avg_net)} for taking every trade. It only says TAKE where a probability level made money out-of-sample on that stock.</span>`;
    }
  }

  const tested = (side) => side ? `${side.model.n} · ${pct(side.model.win)} · ${net(side.model.avg_net)}` : '—';
  function rowsTake(list) {
    if (!list.length) return '<div class="empty">No TAKE decisions on the latest candle. That is the common case: it only says TAKE where a probability level made money after charges on that stock\'s own history.</div>';
    return `<div class="card table-wrap"><table class="table pm-table"><thead><tr><th>Stock</th><th>Decision</th><th class="r">P(win)</th><th class="r">Tested net / trade</th>
      <th class="r">Price</th><th class="r">Stop</th><th class="r">Target</th><th class="r">Charges</th><th>Candle</th></tr></thead><tbody>
      ${list.map((p) => { const s = p[p.decision.toLowerCase()]; return `<tr><td><a href="${chart(p.symbol, p.interval)}"><b>${name(p.symbol)}</b></a></td><td>${decision(p.decision)}</td>
        <td class="r">${pct(s.p_win)}</td><td class="r">${net(s.exp_net_pct)} <small class="muted">(${pct(s.exp_win)} won)</small></td><td class="r">${num(p.price)}</td>
        <td class="r down">${num(s.stop)}</td><td class="r up">${num(s.target)}</td><td class="r">${num(s.cost_pct)}%</td><td>${timeIST(p.bar_time)}</td></tr>`; }).join('')}
      </tbody></table></div>`;
  }
  function rowsAll(d) {
    const latest = Object.fromEntries((d.latest || []).map((p) => [p.symbol, p]));
    if (!d.reports.length) return '<div class="empty">No stocks trained yet.</div>';
    return `<div class="card table-wrap"><table class="table pm-table"><thead><tr><th>Stock</th><th>Now</th><th class="r">P(win) long / short</th>
      <th class="r">Long: every trade</th><th class="r">Long: model picks (n · won · net)</th><th class="r">Short: every trade</th><th class="r">Short: model picks</th><th>Edge</th></tr></thead><tbody>
      ${d.reports.map((r) => { const p = latest[r.symbol] || {}, lv = (s) => r[s] && r[s].chosen ? `${s} ≥ ${pct(r[s].chosen.threshold)}` : null;
        const edge = [lv('long'), lv('short')].filter(Boolean).join(', ');
        return `<tr><td><a href="${chart(r.symbol, r.interval)}"><b>${name(r.symbol)}</b></a><small class="blk muted">${r.rows} bars</small></td><td>${decision(p.decision)}</td>
          <td class="r">${pct((p.long || {}).p_win)} / ${pct((p.short || {}).p_win)}</td>
          <td class="r">${net(r.long.baseline.avg_net)}</td><td class="r">${tested(r.long)}</td>
          <td class="r">${net(r.short.baseline.avg_net)}</td><td class="r">${tested(r.short)}</td><td>${edge ? `<span class="bdg buy">${edge}</span>` : '<span class="muted">none</span>'}</td></tr>`; }).join('')}
      </tbody></table></div>`;
  }
  function rowsLive(calls) {
    if (!calls.length) return '<div class="empty">No live calls yet. A TAKE decision during market hours is recorded here and graded when its trade would have finished.</div>';
    return `<div class="card table-wrap"><table class="table pm-table"><thead><tr><th>Candle</th><th>Stock</th><th>Side</th><th class="r">P(win)</th><th class="r">Entry</th>
      <th class="r">Exit</th><th>How</th><th class="r">Net</th></tr></thead><tbody>
      ${calls.map((c) => `<tr><td>${timeIST(c.bar_time)}</td><td><a href="${chart(c.symbol, c.interval)}"><b>${name(c.symbol)}</b></a></td><td>${decision(c.side)}</td>
        <td class="r">${pct(c.p_win)}</td><td class="r">${num(c.entry_price)}</td><td class="r">${num(c.exit_price)}</td>
        <td>${c.status === 'pending' ? '<span class="bdg amber">open</span>' : c.status === 'void' ? '<span class="bdg mute">no entry</span>' : esc(c.exit_reason)}</td>
        <td class="r">${c.status === 'resolved' ? net(c.net_pct) : '—'}</td></tr>`).join('')}</tbody></table></div>`;
  }
  const HOW = `<div class="card pm-how">
    <p><b>The question.</b> The main model asks “will the price be higher in 16 bars?”. This one asks “if I enter on the next candle, does the trade make money after charges?”.</p>
    <p><b>Training trades.</b> Every past 15-minute bar is replayed twice (long and short): entry at the next bar's open, target 1.5 × ATR, stop 1 × ATR, out after 16 bars
      or at 15:10 IST, no entries after 14:45. If one candle touches both, the stop counts. Your broker's charges and slippage are subtracted.</p>
    <p><b>Honest testing.</b> The newest 60% of history is split into 5 blocks; each is predicted by models trained only on earlier bars, with a 16-bar gap.
      “Model picks” are those out-of-sample trades where P(win) ≥ 50%. “Best level” picks each stock's best probability level afterwards, so it flatters the model.</p>
    <p><b>When it says TAKE.</b> Only when the current P(win) reaches a level that made money out-of-sample on that stock (≥ 30 trades, average net above zero
      by at least one standard error), before 14:45. Each TAKE is stored and graded like the training trades: that is the live record.</p>
    <p><b>Independent.</b> It runs as its own low-priority process, reads prices the app already has, and writes only its own files
      (data/profit.db, data/cache/profit). It cannot change the main model's calls, the Ready list, trade plans, settings or paper trades.</p></div>`;

  function render() {
    if (!data) return;
    const take = (data.latest || []).filter((p) => p.decision !== 'SKIP');
    const T = [['take', 'Take now', take.length], ['all', 'All stocks', data.reports.length], ['live', 'Live record', (data.calls || []).length], ['how', 'How it works', null]];
    $('#pm-tabs').innerHTML = T.map(([k, l, n]) => `<button data-tab="${k}" class="${tab === k ? 'on' : ''}">${l}${n == null ? '' : `<span class="n">${n}</span>`}</button>`).join('');
    $('#pm-tabs').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { tab = b.dataset.tab; history.replaceState(null, '', '#' + tab); render(); }));
    $('#pm-body').innerHTML = tab === 'take' ? rowsTake(take) : tab === 'all' ? rowsAll(data) : tab === 'live' ? rowsLive(data.calls || []) : HOW;
  }

  async function load() {
    try {
      data = await (await fetch('/api/profit')).json();
      status(data.status); meter(data); render();
    } catch (e) { $('#pm-meter').innerHTML = `<div class="empty">Could not load the profit model: ${esc(e.message)}</div>`; }
  }
  load();
  setInterval(load, 60000);
})();
