// 2% movers (GET /api/movers): where a big enough move is common; the direction comes from the scanner's call.
(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const num = (v, d = 2) => (v == null || !isFinite(v) ? '—' : Number(v).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d }));
  const pct0 = (v) => (v == null ? '—' : Math.round(v * 100) + '%');
  const signed = (v) => (v == null ? '—' : (v > 0 ? '+' : v < 0 ? '−' : '') + num(Math.abs(v)) + '%');
  const ini = (n) => esc(String(n || '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase());
  const FIRST = 30;
  let target = 2, filter = 'all', data = null, timer = null, showAll = false;
  try { target = +localStorage.getItem('tb.movers.target') || 2; } catch {}

  const meter = (v, cls) => `<span class="meter"><i><b class="${cls}" style="width:${Math.min(100, Math.round((v || 0) * 100 / 0.55))}%"></b></i><span class="num">${pct0(v)}</span></span>`;
  const call = (r) => {
    if (!r.call) return '<span class="bdg mute">not scanned</span>';
    const c = r.call === 'UP' ? '<span class="bdg buy">UP</span>' : r.call === 'DOWN' ? '<span class="bdg sell">DOWN</span>' : '<span class="bdg mute">NO CALL</span>';
    return c + (r.verdict === 'trade' ? ' <span class="bdg buy">TRADE</span>' : r.verdict === 'wait' ? ' <span class="bdg blue">LIMIT</span>' : '');
  };
  const today = (r) => r.from_open == null ? '<span class="pill">—</span>' : `<span class="pill ${r.from_open >= 0 ? 'up' : 'down'}"><span class="${r.from_open >= 0 ? 'up' : 'down'}">${signed(r.from_open)}</span></span>`;
  const url = (r) => `/?symbol=${encodeURIComponent(r.symbol)}&exchange=NSE&interval=15m`;

  function render() {
    const d = data, t = d.target, tl = num(t, t % 1 ? 1 : 0) + '%';
    $('#mv-title').textContent = `${tl} movers`;
    $('#mv-target').innerHTML = d.targets.map((x) => `<button data-t="${x}" class="${x === t ? 'on' : ''}">${x}%</button>`).join('');
    if (!d.ready) {
      $('#mv-kpis').innerHTML = `<div class="kpi"><div class="k">Measuring</div><div class="v">…</div></div>`;
      $('#mv-list').innerHTML = `<div class="empty">${d.error ? 'Could not measure: ' + esc(d.error) : 'Measuring 60 sessions of 5-minute candles for every affordable NSE stock — about a minute.'}</div>`;
      return;
    }
    const often = d.rows.filter((r) => r.up >= 0.25 || r.down >= 0.25).length;
    const costs = d.rows.map((r) => r.cost_pct).sort((a, b) => a - b), med = costs.length ? costs[Math.floor(costs.length / 2)] : null;
    const kpi = (k, v, c = '') => `<div class="kpi"><div class="k">${k}</div><div class="v num ${c}">${v}</div></div>`;
    $('#mv-kpis').innerHTML = kpi(`Move ${tl} often`, often, 'up') + kpi('Stocks measured', d.rows.length) + kpi('Sessions', d.sessions)
      + kpi('Buying blindly', `${signed(d.blind)} / trade`, 'down') + kpi('Your cost', med == null ? '—' : num(med) + '%') + kpi('Capital', '₹' + num(d.capital, 0));
    const note = $('#mv-note');
    note.hidden = d.blind == null;
    if (!note.hidden) note.innerHTML = `<span><b>They move both ways.</b> Buying them at 09:30 for +${tl} with a ${d.blind_stop}% stop returned ${signed(d.blind)} per trade after
      your charges over the last ${d.sessions} sessions. The list shows <i>where</i> a ${tl} move is likely — trade only with the scanner's call.</span>`;
    const half = t / 2;
    const live = !['holiday', 'weekend', 'pre'].includes((d.market || {}).state);   // no session yet today: the numbers are the last session's
    const dayLabel = live ? 'Today' : 'Last session';
    let rows = d.rows;
    const moving = d.rows.filter((r) => Math.max(Math.abs(r.high_from_open || 0), Math.abs(r.low_from_open || 0)) >= half);
    const called = d.rows.filter((r) => r.call === 'UP' || r.call === 'DOWN');
    if (filter === 'today') rows = moving;
    if (filter === 'call') rows = called;
    $('#mv-filter').innerHTML = [['all', 'All', d.rows.length], ['today', live ? 'Moving today' : 'Moved last session', moving.length], ['call', 'Has a call', called.length]]
      .map(([k, l, n]) => `<button data-f="${k}" class="${filter === k ? 'on' : ''}">${l}<span class="n">${n}</span></button>`).join('');
    if (!rows.length) { $('#mv-list').innerHTML = '<div class="empty">No stock matches this filter right now.</div>'; return; }
    const shown = showAll ? rows : rows.slice(0, FIRST);
    $('#mv-list').innerHTML = `<div class="lhead g-movers"><span>Stock</span><span>Reaches +${tl}</span><span>Falls −${tl}</span><span class="r">Range</span><span class="r">${dayLabel}</span><span>Call</span><span class="r">Cost</span></div>
      <div style="display:flex;flex-direction:column;gap:8px;margin-top:8px">${shown.map((r) => `
        <div class="lrow g-movers">
          <div class="who"><span class="av">${ini(r.name)}</span><div><a href="${url(r)}"><b>${esc(r.name)}</b></a><small class="num">₹${num(r.price)}</small></div></div>
          <div>${meter(r.up, '')}</div><div>${meter(r.down, 'dn')}</div>
          <div class="r num">${num(r.range, 1)}%</div><div class="r">${today(r)}</div><div>${call(r)}</div><div class="r num">${num(r.cost_pct)}%</div></div>
        <div class="mcard"><div class="top"><span class="av">${ini(r.name)}</span><div class="who"><div><a href="${url(r)}"><b>${esc(r.name)}</b></a><small>₹${num(r.price)} · range ${num(r.range, 1)}%</small></div></div><div class="px">${today(r)}</div></div>
          <div class="kvr"><span>Reaches +${tl}</span>${meter(r.up, '')}</div><div class="kvr"><span>Falls −${tl}</span>${meter(r.down, 'dn')}</div>
          <div class="kvr"><span>Call</span><span>${call(r)}</span></div></div>`).join('')}</div>
      ${rows.length > FIRST ? `<div style="text-align:center;margin-top:12px"><button class="btn" id="mv-more">${showAll ? 'Show top ' + FIRST : 'Show all ' + rows.length}</button></div>` : ''}`;
  }

  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-t]');
    if (t) { target = +t.dataset.t; try { localStorage.setItem('tb.movers.target', target); } catch {} load(); return; }
    const f = e.target.closest('[data-f]');
    if (f) { filter = f.dataset.f; if (data) render(); return; }
    if (e.target.closest('#mv-more')) { showAll = !showAll; render(); }
  });
  $('#mv-scan').addEventListener('click', async () => {
    await fetch('/api/ready/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ universe: 'movers' }) });
    location.href = '/';
  });
  async function load() {
    clearTimeout(timer);
    try {
      const r = await fetch('/api/movers?target=' + target);
      if (r.status === 401) { location.href = '/login?next=/movers'; return; }
      data = await r.json();
      render();
    } catch (e) {
      $('#mv-list').innerHTML = `<div class="empty">Could not reach the server: ${esc(e.message)}</div>`;
    }
    timer = setTimeout(load, data && (!data.ready || data.running) ? 5000 : 60000);
  }
  load();
})();
