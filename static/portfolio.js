/* Portfolio: money summary, open / pending / closed paper trades, equity curve, capital and fee settings. */
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const num = (v, d = 2) => (v == null || Number.isNaN(v) ? '—' : Number(v).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d }));
  const rs = (v, d = 2) => (v == null || Number.isNaN(v) ? '—' : (v < 0 ? '−₹' : '₹') + num(Math.abs(v), d));
  const pnl = (v, d = 2) => `<span class="${v > 0 ? 'up' : v < 0 ? 'down' : ''}">${v > 0 ? '+' : ''}${rs(v, d)}</span>`;
  const when = (iso) => (iso ? new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
  const ini = (s) => esc(String(s || '?').replace(/\.(NS|BO)$/, '').replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase());
  const name = (s) => esc(String(s).replace(/\.(NS|BO)$/, ''));
  const side = (t) => t.side === 'short' ? '<span class="bdg sell">SHORT</span>' : '<span class="bdg buy">LONG</span>';
  const REASON = { stop: ['stop', 'sell'], target: ['target', 'buy'], deadline: ['time exit', 'amber'], manual: ['manual', 'mute'], squareoff: ['square-off', 'sell'], expired: ['expired', 'mute'], cancelled: ['cancelled', 'mute'] };

  function status(msg, kind) {
    const el = $('#status');
    el.hidden = !msg; if (!msg) return;
    el.textContent = msg; el.className = 'status' + (kind === 'info' ? ' info' : '');
  }
  async function api(path, opts = {}) {
    const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
    if (res.status === 401) { location.href = '/login?next=/portfolio'; throw new Error('Not signed in'); }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.detail || res.statusText);
    return body;
  }

  // ------------------------------------------------------------ equity chart (follows the theme)
  let chart = null, series = null, lastCurve = null;
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const chartTheme = () => ({ layout: { background: { type: 'solid', color: 'rgba(0,0,0,0)' }, textColor: css('--muted'), fontFamily: 'Manrope, system-ui, sans-serif' },
    grid: { vertLines: { color: css('--line') }, horzLines: { color: css('--line') } }, rightPriceScale: { borderColor: css('--line') }, timeScale: { borderColor: css('--line'), timeVisible: true } });
  function renderEquity(curve, capital, ret) {
    lastCurve = [curve, capital, ret];
    if (!chart) {
      chart = LightweightCharts.createChart($('#equity-chart'), { autoSize: true, ...chartTheme() });
      series = chart.addAreaSeries({ lineWidth: 2, priceLineVisible: false });
    }
    const col = ret < 0 ? css('--red') : css('--green');
    series.applyOptions({ lineColor: col, topColor: col + '40', bottomColor: col + '00' });
    const pts = []; let lastT = 0;
    const start = curve.length ? Math.floor(new Date(curve[0].time).getTime() / 1000) - 3600 : Math.floor(Date.now() / 1000) - 3600;
    pts.push({ time: start, value: capital }); lastT = start;
    for (const c of curve) { let t = Math.floor(new Date(c.time).getTime() / 1000); if (t <= lastT) t = lastT + 1; pts.push({ time: t, value: c.equity }); lastT = t; }
    series.setData(pts); chart.timeScale().fitContent();
  }
  window.addEventListener('tb-theme', () => { if (chart) { chart.applyOptions(chartTheme()); if (lastCurve) renderEquity(...lastCurve); } });

  // ------------------------------------------------------------ render
  function openRow(t) {
    const lo = Math.min(t.stop ?? t.fill_price, t.target ?? t.fill_price), hi = Math.max(t.stop ?? t.fill_price, t.target ?? t.fill_price);
    const pos = (v) => hi > lo ? Math.max(0, Math.min(100, (v - lo) / (hi - lo) * 100)) : 50;
    const stopLeft = t.side !== 'short';                          // long: stop on the left, short: stop on the right
    const m = stopLeft ? pos(t.last_price ?? t.fill_price) : 100 - pos(t.last_price ?? t.fill_price);
    const e = stopLeft ? pos(t.fill_price) : 100 - pos(t.fill_price);
    const bar = t.stop && t.target ? `<div class="slt"><div class="row"><span>Stop <b class="num">${num(t.stop)}</b></span><span>Target <b class="num">${num(t.target)}</b></span></div>
        <div class="slbar"><div class="s" style="width:${e}%"></div><div class="t" style="width:${100 - e}%"></div><div class="m" style="left:calc(${m}% - 1px)"></div></div>
        <div class="row"><span>Last <b class="num">${num(t.last_price)}</b></span><span>${t.progress == null ? '' : t.progress + '% to target'}</span></div></div>` : '<span class="muted">no stop / target</span>';
    return `<div class="lrow g-open"><div class="who"><span class="av">${ini(t.symbol)}</span><div><b>${name(t.symbol)}</b><small>${esc(t.mode)} · ${when(t.entry_time)}</small></div></div>
      <div>${side(t)}</div><div class="r num">${t.qty}</div><div class="r num">${num(t.fill_price)}</div><div>${bar}</div>
      <div class="r num"><b>${pnl(t.unrealised)}</b><small style="display:block" class="${t.unrealised_pct > 0 ? 'up' : t.unrealised_pct < 0 ? 'down' : ''}">${t.unrealised_pct > 0 ? '+' : ''}${t.unrealised_pct ?? '—'}%</small></div>
      <div class="r"><button class="btn small r" data-close="${t.id}">Close</button></div></div>
      <div class="mcard"><div class="top"><span class="av">${ini(t.symbol)}</span><div class="who"><div><b>${name(t.symbol)}</b><small>${t.qty} @ ${num(t.fill_price)} · ${esc(t.mode)}</small></div></div>${side(t)}<div class="px">${pnl(t.unrealised)}</div></div>
        ${bar}<button class="btn r" data-close="${t.id}">Close now</button></div>`;
  }
  function pendingRow(t) {
    return `<div class="lrow g-open"><div class="who"><span class="av">${ini(t.symbol)}</span><div><b>${name(t.symbol)}</b><small>${esc(t.mode)} · placed ${when(t.created_at)}</small></div></div>
      <div>${side(t)}</div><div class="r num">${t.qty}</div><div class="r num">${t.entry_type === 'sl' ? 'SL ' : ''}${num(t.entry_price)}</div>
      <div class="muted">Stop ${num(t.stop)} · target ${num(t.target)}</div><div class="r muted" style="font-size:12px">${t.deadline ? 'until ' + when(t.deadline) : t.mode === 'intraday' ? 'until square-off' : 'good till cancelled'}</div>
      <div class="r"><button class="btn small" data-close="${t.id}">Cancel</button></div></div>
      <div class="mcard"><div class="top"><span class="av">${ini(t.symbol)}</span><div class="who"><div><b>${name(t.symbol)}</b><small>${t.qty} @ ${num(t.entry_price)} · ${esc(t.mode)}</small></div></div>${side(t)}</div>
        <button class="btn" data-close="${t.id}">Cancel order</button></div>`;
  }
  function closedRow(t) {
    const [label, cls] = REASON[t.exit_reason] || [t.exit_reason || '—', 'mute'];
    const netPct = t.fill_price ? t.net_pnl / (t.fill_price * t.qty) * 100 : null;
    return `<div class="lrow g-closed"><div class="who"><span class="av">${ini(t.symbol)}</span><div><b>${name(t.symbol)}</b><small>${when(t.exit_time)}</small></div></div>
      <div>${side(t)}</div><div class="r num">${t.qty}</div><div class="num">${num(t.fill_price)} → ${num(t.exit_price)}</div><div><span class="bdg ${cls}">${label}</span></div>
      <div class="r num">${pnl(t.gross_pnl)}</div><div class="r num">${rs(t.charges)}</div><div class="r num"><b>${pnl(t.net_pnl)}</b>${netPct == null ? '' : `<small style="display:block">${netPct > 0 ? '+' : ''}${netPct.toFixed(2)}%</small>`}</div></div>
      <div class="mcard"><div class="top"><span class="av">${ini(t.symbol)}</span><div class="who"><div><b>${name(t.symbol)}</b><small>${when(t.exit_time)} · ${num(t.fill_price)} → ${num(t.exit_price)}</small></div></div><span class="bdg ${cls}">${label}</span><div class="px">${pnl(t.net_pnl)}</div></div></div>`;
  }

  function render(p) {
    const s = p.stats;
    const kpi = (k, v) => `<div class="kpi"><div class="k">${k}</div><div class="v num">${v}</div></div>`;
    $('#kpis').innerHTML = kpi('Equity', rs(p.equity)) + kpi('Cash', rs(p.cash)) + kpi('Invested', rs(p.invested)) + kpi('Unrealised', pnl(p.unrealised))
      + kpi('Realised P&amp;L', pnl(s.net_pnl)) + kpi('Return', s.return_pct == null ? '—' : `<span class="${s.return_pct > 0 ? 'up' : s.return_pct < 0 ? 'down' : ''}">${s.return_pct > 0 ? '+' : ''}${s.return_pct}%</span>`)
      + kpi('Win rate', s.win_rate == null ? '—' : Math.round(s.win_rate * 100) + '%') + kpi('Charges paid', rs(s.charges)) + kpi('Trades', s.trades);
    $('#n-open').textContent = p.open.length; $('#n-pending').textContent = p.pending.length; $('#n-closed').textContent = p.closed.length;
    $('#open-meta').textContent = `limit ${p.settings.max_positions} at a time`;
    $('#open').innerHTML = p.open.length ? `<div class="lhead g-open"><span>Stock</span><span>Side</span><span class="r">Qty</span><span class="r">Bought</span><span>Stop → target</span><span class="r">Unrealised</span><span></span></div>
      <div style="display:flex;flex-direction:column;gap:8px;margin-top:8px">${p.open.map(openRow).join('')}</div>` : '<div class="empty">No open positions. Pick one from <a href="/">Ready</a>.</div>';
    $('#pending').innerHTML = p.pending.length ? `<div style="display:flex;flex-direction:column;gap:8px">${p.pending.map(pendingRow).join('')}</div>` : '<div class="empty">No pending orders.</div>';
    $('#closed').innerHTML = p.closed.length ? `<div class="lhead g-closed"><span>Stock</span><span>Side</span><span class="r">Qty</span><span>Bought → sold</span><span>Exit</span><span class="r">Gross</span><span class="r">Charges</span><span class="r">Net</span></div>
      <div style="display:flex;flex-direction:column;gap:8px;margin-top:8px">${p.closed.map(closedRow).join('')}</div>` : '<div class="empty">No closed trades yet.</div>';
    $('#eq-ret').innerHTML = s.return_pct == null ? '' : `<span class="${s.return_pct >= 0 ? 'up' : 'down'}">${s.return_pct > 0 ? '+' : ''}${s.return_pct}%</span>`;
    $('#stats').innerHTML = `<div class="sec-h" style="margin:0 0 8px">Track record</div>
      <div class="kvr"><span>Profit factor</span><b>${s.profit_factor ?? '—'}</b></div><div class="kvr"><span>Expectancy / trade</span><b>${s.expectancy == null ? '—' : pnl(s.expectancy)}</b></div>
      <div class="kvr"><span>Average win</span><b>${s.avg_win == null ? '—' : pnl(s.avg_win)}</b></div><div class="kvr"><span>Average loss</span><b>${s.avg_loss == null ? '—' : pnl(s.avg_loss)}</b></div>
      <div class="kvr"><span>Max drawdown</span><b>${s.max_drawdown_pct}%</b></div>`;
    $$('[data-close]').forEach((b) => b.addEventListener('click', async () => {
      const id = +b.dataset.close;
      if (!confirm(`Close / cancel paper trade #${id} at the current price?`)) return;
      try { await api(`/api/trades/${id}/close`, { method: 'POST', body: '{}' }); await load(); } catch (e) { status(e.message); }
    }));
    renderEquity(p.equity_curve, p.capital, s.return_pct || 0);
  }

  // ------------------------------------------------------------ settings
  function fillSettings(st) {
    const sel = $('#broker');
    if (st.brokers) sel.innerHTML = st.brokers.map((b) => `<option value="${b.key}">${b.name}</option>`).join('');
    $('#fee-broker').textContent = st.fees ? st.fees.broker : '';
    $$('#settings-form [name]').forEach((inp) => {
      let v = st; for (const k of inp.name.split('.')) v = v == null ? undefined : v[k];
      if (inp.type === 'checkbox') inp.checked = !!v; else inp.value = v == null ? '' : v;
    });
  }
  function readSettings() {
    const out = { fees: {} };
    $$('#settings-form [name]').forEach((inp) => {
      const v = inp.type === 'checkbox' ? inp.checked : (inp.type === 'number' ? Number(inp.value) : inp.value);
      if (inp.name.startsWith('fees.')) out.fees[inp.name.slice(5)] = v; else out[inp.name] = v;
    });
    return out;
  }
  // switching broker loads that broker's published schedule straight away (the fee fields below belong to the old one)
  $('#broker').addEventListener('change', async (e) => {
    try {
      fillSettings(await api('/api/settings', { method: 'PUT', body: JSON.stringify({ broker: e.target.value }) }));
      fetch('/api/ready/rescan', { method: 'POST' }).catch(() => {});
      $('#settings-msg').textContent = `Switched to ${$('#fee-broker').textContent} charges. The Ready list is re-planning with them now.`; await load();
    } catch (err) { status(err.message); }
  });
  $('#save').addEventListener('click', async () => {
    try {
      fillSettings(await api('/api/settings', { method: 'PUT', body: JSON.stringify(readSettings()) }));
      fetch('/api/ready/rescan', { method: 'POST' }).catch(() => {});          // the ready list re-plans with the new capital / fees
      $('#settings-msg').textContent = 'Saved. The Ready list is re-planning with it now.'; await load();
    }
    catch (e) { status(e.message); }
  });
  $('#reset').addEventListener('click', async () => {
    if (!confirm('Reset capital, risk and every fee to the defaults?')) return;
    try { fillSettings(await api('/api/settings/reset', { method: 'POST', body: '{}' })); $('#settings-msg').textContent = 'Defaults restored.'; await load(); }
    catch (e) { status(e.message); }
  });
  $('#check').addEventListener('click', async () => {
    try { const r = await api('/api/trades/check', { method: 'POST', body: '{}' }); status(`Checked: ${r.filled.length} filled, ${r.closed.length} closed.`, 'info'); setTimeout(() => status(null), 4000); await load(); }
    catch (e) { status(e.message); }
  });

  let loading = false;
  async function load() {
    if (loading) return; loading = true;
    try { render(await api('/api/portfolio')); status(null); } catch (e) { status(e.message); } finally { loading = false; }
  }
  (async () => {
    try { fillSettings(await api('/api/settings')); } catch (e) { status(e.message); }
    await load();
    if (location.hash === '#settings') $('#settings').scrollIntoView({ behavior: 'smooth' });
    setInterval(load, 30000);
  })();
})();
