// Ready to trade (GET /api/ready): the background scanner's list, as tabs of rows; a row opens an order bar.
(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const num = (v, d = 2) => (v == null || !isFinite(v) ? '—' : Number(v).toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d }));
  const rs = (v, d = 0) => (v == null ? '—' : (v < 0 ? '−₹' : '₹') + num(Math.abs(v), d));
  const pct = (v) => (v == null ? '—' : Math.round(v * 100) + '%');
  const ago = (iso) => {
    if (!iso) return '';
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    return s < 60 ? 'just now' : s < 3600 ? Math.round(s / 60) + ' min ago' : s < 86400 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' d ago';
  };
  const timeIST = (iso) => new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });
  const age = (r) => r.stale ? `<span class="bdg amber" title="Analysed on an older candle - re-analysis is queued">old · ${ago(r.analyzed_at)}</span>` : ago(r.analyzed_at);
  const liveDot = (r) => (r.live_at ? '<span class="ldot" title="Live price"></span>' : '');
  const ini = (n) => esc(String(n || '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase());
  const chartUrl = (r) => `/?symbol=${encodeURIComponent(r.symbol)}&exchange=NSE&interval=${r.interval || (data && data.config.interval) || '15m'}`;
  const signal = (r) => (r.side === 'BUY' || r.direction === 'UP') ? '<span class="bdg buy">BUY</span>'
    : (r.side === 'SELL' || r.direction === 'DOWN') ? '<span class="bdg sell">SELL</span>' : '<span class="bdg mute">NO CALL</span>';
  const callBadge = (r) => r.direction === 'UP' ? '<span class="bdg buy">UP</span>' : r.direction === 'DOWN' ? '<span class="bdg sell">DOWN</span>' : '<span class="bdg mute">NO CALL</span>';

  let data = null, timer = null, tab = null, open = null, busyCfg = false;
  const order = {};          // symbol -> {product, type, qty}
  const msgs = {};           // symbol -> {ok, text}

  // ------------------------------------------------------------ rows
  function tradeRow(r) {
    const buy = r.side === 'BUY', sel = open === r.symbol;
    const px = `<b class="num">₹${num(r.price)}</b>${liveDot(r)}${r.chg_1d != null ? `<small class="blk ${r.chg_1d >= 0 ? 'up' : 'down'}">${r.chg_1d >= 0 ? '+' : ''}${num(r.chg_1d)}%</small>` : ''}`;
    const btn = `<button class="btn ${buy ? 'g' : 'r'}" data-open="${esc(r.symbol)}">${r.verdict === 'wait' ? 'Limit' : buy ? 'Buy' : 'Sell'}</button>`;
    return `<div class="lrow g-ready click${sel ? ' sel open' : ''}${r.stale ? ' stale' : ''}" data-open="${esc(r.symbol)}">
        <div class="who"><span class="av">${ini(r.name)}</span><div><b>${esc(r.name)}</b><small>${esc(r.sector || 'NSE')} · ${age(r)}</small></div></div>
        <div>${signal(r)}</div><div>${px}</div>
        <div class="r num">${num(r.entry)}</div><div class="r num down">${num(r.stop)}</div><div class="r num up">${num(r.target)}</div>
        <div class="r num">${r.qty ?? '—'}</div>
        <div class="r num"><span class="up">+${rs(r.net_win)}</span> / <span class="down">${rs(r.net_loss)}</span></div>
        <div class="r num">${pct(r.p_target)}</div><div class="r num">${pct(r.accuracy)}</div>
        <div class="r">${btn}</div></div>
      <div class="mcard${sel ? ' sel' : ''}${r.stale ? ' stale' : ''}" data-open="${esc(r.symbol)}">
        <div class="top"><span class="av">${ini(r.name)}</span><div class="who"><div><b>${esc(r.name)}</b><small>Validated ${pct(r.accuracy)} · chance ${pct(r.p_target)}</small></div></div>
          ${signal(r)}<div class="px">${px}</div></div>
        <div class="lv"><div><span>${r.verdict === 'wait' ? 'Limit' : 'Entry'}</span><b class="num">${num(r.entry)}</b></div><div><span>Stop</span><b class="num down">${num(r.stop)}</b></div><div><span>Target</span><b class="num up">${num(r.target)}</b></div></div>
        <div class="kvr"><span>${r.qty ?? '—'} shares · win / loss</span><b><span class="up">+${rs(r.net_win)}</span> / <span class="down">${rs(r.net_loss)}</span></b></div>
        ${sel ? '' : `<button class="btn ${buy ? 'g' : 'r'}" data-open="${esc(r.symbol)}" style="padding:12px">${r.verdict === 'wait' ? 'Set limit order' : buy ? 'Buy' : 'Sell'}</button>`}</div>
      ${sel ? orderBar(r) : ''}`;
  }

  function orderBar(r) {
    const buy = r.side === 'BUY';
    const o = order[r.symbol] || (order[r.symbol] = { product: r.mode === 'overnight' ? 'overnight' : 'intraday', type: r.verdict === 'wait' ? 'limit' : 'market', qty: r.qty || 1 });
    const m = msgs[r.symbol];
    const sg = (key, opts) => `<div class="sg">${opts.map(([v, l]) => `<button data-set="${key}" data-v="${v}" class="${o[key] === v ? 'on' : ''}">${l}</button>`).join('')}</div>`;
    const value = (o.qty || 0) * (r.entry || 0);
    return `<div class="expand">
      <div><label>Product</label>${sg('product', [['intraday', 'Intraday'], ['overnight', 'Delivery']])}</div>
      <div><label>Order</label>${sg('type', [['market', 'Market'], ['limit', 'Limit']])}</div>
      <div><label for="qty-${esc(r.symbol)}">Quantity</label><input id="qty-${esc(r.symbol)}" type="number" min="1" step="1" value="${o.qty}" data-qty></div>
      <div><label>${o.type === 'limit' ? 'Limit price' : 'Entry'}</label><div class="val num">${num(r.entry)}</div></div>
      <div><label>Charges</label><div class="val num">${r.charges != null ? '₹' + num(r.charges) : '—'}</div></div>
      <div><label>Exit by</label><div class="val">${esc(r.deadline || '—')}</div></div>
      <div class="grow"></div>
      <a class="btn" href="${chartUrl(r)}">Open chart</a>
      <button class="btn ${buy ? 'g' : 'r'}" data-place="${esc(r.symbol)}" style="padding:12px 20px" ${(m && m.ok) || r.stale ? 'disabled' : ''}>Place ${buy ? 'Buy' : 'Sell'} Order · ₹${num(value, 0)}</button>
      ${m ? `<div class="msg ${m.ok ? 'up' : 'down'}">${esc(m.text)}</div>` : ''}</div>`;
  }

  function almostRow(r) {
    return `<div class="lrow g-almost${r.stale ? ' stale' : ''}">
        <div class="who"><span class="av">${ini(r.name)}</span><div><a href="${chartUrl(r)}"><b>${esc(r.name)}</b></a><small>${esc(r.sector || 'NSE')} · ${age(r)}</small></div></div>
        <div>${callBadge(r)}</div><div class="num"><b>₹${num(r.price)}</b>${liveDot(r)}</div><div class="r num">${pct(r.accuracy)}</div>
        <div class="why" title="${esc((r.reasons || []).join(' · '))}">${esc(r.reason_group || (r.reasons || [])[0] || '')}</div>
        <div class="r"><a class="btn small" href="${chartUrl(r)}">Chart</a></div></div>
      <div class="mcard${r.stale ? ' stale' : ''}"><div class="top"><span class="av">${ini(r.name)}</span><div class="who"><div><a href="${chartUrl(r)}"><b>${esc(r.name)}</b></a><small>₹${num(r.price)} · validated ${pct(r.accuracy)} · ${age(r)}</small></div></div>${callBadge(r)}</div>
        <div class="kvr"><span>${esc(r.reason_group || (r.reasons || [])[0] || '')}</span></div></div>`;
  }

  // ------------------------------------------------------------ render
  function lists() {
    const trade = data.ready.filter((r) => r.verdict === 'trade'), wait = data.ready.filter((r) => r.verdict === 'wait');
    return { trade, wait, almost: data.watch || [], others: data.others || [] };
  }

  function render() {
    const d = data, st = d.status || {}, mk = d.market || {}, L = lists();
    if (!tab) tab = L.trade.length ? 'trade' : L.wait.length ? 'wait' : 'almost';
    const total = st.total || 0, done = Math.min(st.done || 0, total);
    const refresh = mk.state === 'open' ? `${d.live_at ? 'live prices · ' : ''}next candle ${d.next_refresh ? timeIST(d.next_refresh) : ''}` : `${mk.label || 'closed'} · resumes ${mk.next_open_label || ''}`;
    const switching = st.running && (st.universe !== d.config.universe || st.interval !== d.config.interval);
    const progress = switching ? 'finishing the previous list, then switching' : st.running ? `scanning ${done} of ${total}` : `${d.analysed} analysed`;
    const old = d.stale ? ` · ${d.stale} from an older candle, updating` : '';
    $('#rd-sub').textContent = `${d.universe_name} · ${d.config.interval} candles · ${progress}${old} · ${refresh}`;
    const costs = [...L.others, ...L.almost].map((r) => r.cost_pct).filter((v) => v != null).sort((a, b) => a - b);
    const med = costs.length ? costs[Math.floor(costs.length / 2)] : null;
    const kpi = (k, v, c = '') => `<div class="kpi"><div class="k">${k}</div><div class="v num ${c}">${v}</div></div>`;
    $('#rd-kpis').innerHTML = kpi('Trade now', L.trade.length, L.trade.length ? 'up' : '') + kpi('Limit orders', L.wait.length) + kpi('Almost', L.almost.length)
      + kpi('Up to date', switching || !total ? `${d.analysed - (d.stale || 0)} / ${d.analysed}` : `${done} / ${total}`) + kpi('Charges / trade', med == null ? '—' : num(med) + '%') + kpi('Capital', '₹' + num(d.capital, 0));
    const banner = $('#rd-banner');
    banner.hidden = !(d.open_positions >= d.max_positions);
    if (!banner.hidden) banner.innerHTML = `<b>Position limit reached.</b> You have ${d.open_positions} open or pending (limit ${d.max_positions}). Close one on the <a href="/portfolio">Portfolio</a> page first.`;
    const costBlocked = L.others.filter((r) => /charges/i.test(r.reason_group || '')).length + L.almost.filter((r) => /charges/i.test(r.reason_group || '')).length;
    const hint = $('#rd-hint');
    hint.hidden = !(!d.ready.length && med != null && med >= 0.6 && costBlocked >= (L.others.length + L.almost.length) / 3);
    if (!hint.hidden) hint.innerHTML = `<span><b>Why nothing is ready:</b> at ₹${num(d.capital, 0)} a round trip costs about ${num(med)}% with ${d.broker || 'your broker'}'s charges,
      so a target must be roughly ${num(med * 2.5, 1)}% away. ${costBlocked} stocks failed on charges. <a href="/movers">Movers</a> lists the stocks that move that far.</span>`;

    const T = [['trade', 'Trade now', L.trade.length], ['wait', 'Limit orders', L.wait.length], ['almost', 'Almost', L.almost.length], ['others', 'Not tradable', L.others.length]];
    $('#rd-tabs').innerHTML = T.map(([k, l, n]) => `<button data-tab="${k}" class="${tab === k ? 'on' : ''}">${l}<span class="n">${n}</span></button>`).join('');
    const rows = L[tab] || [];
    let html = '';
    if (tab === 'trade' || tab === 'wait') {
      html = rows.length ? `<div class="lhead g-ready"><span>Stock</span><span>Signal</span><span>Price</span><span class="r">${tab === 'wait' ? 'Limit' : 'Entry'}</span><span class="r">Stop</span><span class="r">Target</span><span class="r">Qty</span><span class="r">Win / loss</span><span class="r">Chance</span><span class="r">Validated</span><span></span></div>`
        + `<div style="display:flex;flex-direction:column;gap:10px;margin-top:8px">${rows.map(tradeRow).join('')}</div>`
        : `<div class="empty">${st.running && !d.analysed ? 'Scanning…' : tab === 'trade'
          ? '<b>Nothing passes every check right now.</b><br>Most setups don\'t pay after charges — the list refreshes after every candle. See the <a href="#" data-tab="almost">Almost</a> tab.'
          : 'No limit-order setups right now.'}</div>`;
    } else {
      html = rows.length ? `<div class="lhead g-almost"><span>Stock</span><span>Call</span><span>Price</span><span class="r">Validated</span><span>Why not</span><span></span></div>`
        + `<div style="display:flex;flex-direction:column;gap:8px;margin-top:8px">${rows.map(almostRow).join('')}</div>`
        + (tab === 'others' && d.skipped && d.skipped.length ? `<p class="fine">Not scanned (${d.skipped.length}): ${esc(d.skipped.map((s) => s.symbol.replace('.NS', '') + ' — ' + s.reason).join('; '))}</p>` : '')
        : '<div class="empty">Nothing here.</div>';
    }
    $('#rd-list').innerHTML = html;
  }

  // ------------------------------------------------------------ events (delegated)
  document.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-tab]');
    if (t) { e.preventDefault(); tab = t.dataset.tab; open = null; render(); return; }
    const set = e.target.closest('[data-set]');
    if (set) { const r = findRow(open); if (r) { order[r.symbol][set.dataset.set] = set.dataset.v; render(); } return; }
    const pl = e.target.closest('[data-place]');
    if (pl) { place(pl.dataset.place, pl); return; }
    if (e.target.closest('a, input, .expand')) return;
    const op = e.target.closest('[data-open]');
    if (op) { open = open === op.dataset.open ? null : op.dataset.open; render(); }
  });
  document.addEventListener('input', (e) => {
    if (e.target.matches('[data-qty]')) {
      const r = findRow(open); if (!r) return;
      order[r.symbol].qty = Math.max(1, parseInt(e.target.value, 10) || 1);
      const btn = document.querySelector(`[data-place="${CSS.escape(r.symbol)}"]`);
      if (btn) btn.textContent = `Place ${r.side === 'BUY' ? 'Buy' : 'Sell'} Order · ₹${num(order[r.symbol].qty * r.entry, 0)}`;
    }
  });
  const findRow = (sym) => (data ? data.ready.find((x) => x.symbol === sym) : null);

  async function place(sym, btn) {
    const r = findRow(sym); if (!r) return;
    const o = order[sym];
    btn.disabled = true;
    const body = { symbol: r.symbol, exchange: 'NSE', interval: r.interval, side: r.side, product: o.product, order_type: o.type, qty: o.qty, stop: r.stop, target: r.target };
    if (o.type === 'limit') body.price = r.entry;
    try {
      const res = await fetch('/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await res.json();
      if (!res.ok) throw new Error(j.detail || res.statusText);
      const t = (j.trades || [])[0] || {};
      msgs[sym] = { ok: true, text: `Paper order placed${t.status ? ' (' + t.status + ')' : ''}${j.action ? ' — ' + j.action : ''}. Track it on the Portfolio page.` };
    } catch (err) {
      msgs[sym] = { ok: false, text: 'Order rejected: ' + err.message };
      setTimeout(() => { delete msgs[sym]; render(); }, 8000);
    }
    render();
  }

  // ------------------------------------------------------------ controls + polling
  function fillControls() {
    if (busyCfg) return;
    const u = $('#rd-universe');
    u.innerHTML = data.universes.map((x) => `<option value="${x.key}">${esc(x.name)}</option>`).join('');
    u.value = data.config.universe;
    $('#rd-interval').innerHTML = data.intervals.map((x) => `<button data-iv="${x}" class="${x === data.config.interval ? 'on' : ''}">${x}</button>`).join('');
    $('#rd-interval').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => setConfig({ interval: b.dataset.iv })));
  }
  async function setConfig(patch) {
    busyCfg = true;
    try { await fetch('/api/ready/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }); }
    finally { busyCfg = false; }
    tab = null; open = null; load();
  }
  async function load() {
    clearTimeout(timer);
    try {
      const r = await fetch('/api/ready');
      if (r.status === 401) { location.href = '/login?next=/'; return; }
      if (!r.ok) throw new Error((await r.json()).detail || r.statusText);
      data = await r.json();
      fillControls();
      if (!(document.activeElement && document.activeElement.matches('[data-qty]'))) render();
    } catch (e) {
      $('#rd-sub').textContent = 'Could not reach the server: ' + e.message;
    }
    timer = setTimeout(load, data && (data.market_open || (data.status && data.status.running)) ? 5000 : 20000);
  }
  $('#rd-universe').addEventListener('change', (e) => setConfig({ universe: e.target.value }));
  $('#rd-rescan').addEventListener('click', async () => { await fetch('/api/ready/rescan', { method: 'POST' }); load(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
  load();
})();
