/* Market screener page: heat-map of tiles (squarified treemap, Bruls-Huizing-van Wijk 2000) + sortable table */
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const fmt = (v, d = 2) => (v === null || v === undefined) ? '—' : Number(v).toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d });
  const signed = (v, d = 2) => (v === null || v === undefined) ? '—' : `${v > 0 ? '+' : ''}${Number(v).toFixed(d)}%`;
  const cls = (v) => v > 0 ? 'pos' : v < 0 ? 'neg' : '';
  const crore = (v) => (v === null || v === undefined) ? '—' : v >= 1e12 ? `₹${(v / 1e12).toFixed(2)} L cr` : v >= 1e7 ? `₹${Math.round(v / 1e7).toLocaleString()} cr` : `₹${Math.round(v).toLocaleString()}`;
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const state = { rows: [], filter: 'all', sort: { key: 'chg_1d', dir: -1 }, search: '', view: 'map', colorBy: 'chg_1d', sizeBy: 'market_cap', groupBy: 'sector', metaRetries: 0 };

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

  // ------------------------------------------------------------ filters (shared by map and table)
  const FILTERS = {
    all: (r) => r, gainers: (r) => r.filter((x) => x.chg_1d > 0), losers: (r) => r.filter((x) => x.chg_1d < 0),
    active: (r) => r.filter((x) => x.vol_ratio !== null && x.vol_ratio >= 1.5), volatile: (r) => r.filter((x) => x.range_pct >= 3), quiet: (r) => r.filter((x) => Math.abs(x.chg_1d) < 0.5 && x.range_pct < 1.5),
    gap: (r) => r.filter((x) => Math.abs(x.gap) >= 1), oversold: (r) => r.filter((x) => x.rsi !== null && x.rsi < 30),
    overbought: (r) => r.filter((x) => x.rsi !== null && x.rsi > 70), high52: (r) => r.filter((x) => x.dist_52w_high >= -5),
    low52: (r) => r.filter((x) => x.pos_52w !== null && x.pos_52w <= 15), bull: (r) => r.filter((x) => x.bias >= 3), bear: (r) => r.filter((x) => x.bias <= -3),
    overextended: (r) => r.filter((x) => x.ext_score != null && x.ext_score >= 20),
  };
  const FILTER_SORT = { gainers: ['chg_1d', -1], losers: ['chg_1d', 1], active: ['vol_ratio', -1], volatile: ['range_pct', -1], quiet: ['range_pct', 1], gap: ['gap', -1], oversold: ['rsi', 1], overbought: ['rsi', -1], high52: ['dist_52w_high', -1], low52: ['pos_52w', 1], bull: ['bias', -1], bear: ['bias', 1], overextended: ['ext_score', -1] };
  // the chip that colours the map best
  const FILTER_COLOR = { gainers: 'chg_1d', losers: 'chg_1d', active: 'vol_ratio', volatile: 'range_pct', quiet: 'range_pct', gap: 'gap', oversold: 'rsi', overbought: 'rsi', high52: 'pos_52w', low52: 'pos_52w', bull: 'bias', bear: 'bias', overextended: 'ext_score' };
  function matching() {
    let rows = FILTERS[state.filter](state.rows.slice());
    if (state.search) { const q = state.search.toUpperCase(); rows = rows.filter((r) => r.symbol.toUpperCase().includes(q) || (r.sector || '').toUpperCase().includes(q)); }
    return rows;
  }

  // ------------------------------------------------------------ colour scales
  const METRICS = {
    chg_1d: { label: 'Day %', kind: 'div', floor: 1.5, fmt: (v) => signed(v) },
    gap: { label: 'Gap %', kind: 'div', floor: 1, fmt: (v) => signed(v) },
    chg_5d: { label: '5-day %', kind: 'div', floor: 3, fmt: (v) => signed(v) },
    chg_20d: { label: '20-day %', kind: 'div', floor: 6, fmt: (v) => signed(v) },
    rsi: { label: 'RSI 14', kind: 'div', center: 50, floor: 20, fmt: (v) => v == null ? '—' : v.toFixed(0) },
    pos_52w: { label: '52-week position', kind: 'div', center: 50, floor: 50, fmt: (v) => v == null ? '—' : v.toFixed(0) + '%' },
    bias: { label: 'Trend bias', kind: 'div', floor: 5, fmt: (v) => v == null ? '—' : (v > 0 ? '+' : '') + v },
    vol_ratio: { label: 'Volume × 20-day avg', kind: 'seq', floor: 2, fmt: (v) => v == null ? '—' : v.toFixed(1) + '×' },
    range_pct: { label: 'Day range %', kind: 'seq', floor: 3, fmt: (v) => v == null ? '—' : v.toFixed(1) + '%' },
    atr_pct: { label: 'ATR %', kind: 'seq', floor: 3, fmt: (v) => v == null ? '—' : v.toFixed(1) + '%' },
    ext_score: { label: 'Overextension score', kind: 'seq', floor: 35, fmt: (v) => v == null ? '—' : v.toFixed(0) },
  };
  const C_NEG = [216, 67, 60], C_MID = [150, 158, 170], C_POS = [18, 144, 122], C_SEQ = [47, 111, 237], C_NA = [190, 196, 205];
  const mix = (a, b, t) => a.map((x, i) => Math.round(x + (b[i] - x) * t));
  const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;
  function scaleFor(key, rows) {
    const m = METRICS[key], center = m.center || 0;
    const vals = rows.map((r) => r[key]).filter((v) => v !== null && v !== undefined).map((v) => Math.abs(v - center)).sort((a, b) => a - b);
    const p90 = vals.length ? vals[Math.floor(vals.length * 0.9)] : m.floor;
    return { center, limit: Math.max(m.floor, p90), kind: m.kind };
  }
  function colorFor(v, sc) {
    if (v === null || v === undefined) return rgb(C_NA);
    if (sc.kind === 'seq') { const t = Math.max(0, Math.min(1, (v - sc.center) / sc.limit)); return rgb(mix(C_MID, C_SEQ, t)); }
    const t = Math.max(-1, Math.min(1, (v - sc.center) / sc.limit));
    return rgb(t >= 0 ? mix(C_MID, C_POS, t) : mix(C_MID, C_NEG, -t));
  }
  function renderLegend(sc) {
    const m = METRICS[state.colorBy];
    if (sc.kind === 'seq') {
      $('#legend').innerHTML = `<span>${m.fmt(sc.center)}</span><i style="background:linear-gradient(90deg,${rgb(C_MID)},${rgb(C_SEQ)})"></i><span>${m.fmt(sc.limit)}+</span><span class="muted">${m.label}</span>`;
    } else {
      $('#legend').innerHTML = `<span>${m.fmt(sc.center - sc.limit)}</span><i style="background:linear-gradient(90deg,${rgb(C_NEG)},${rgb(C_MID)},${rgb(C_POS)})"></i><span>${m.fmt(sc.center + sc.limit)}</span><span class="muted">${m.label}</span>`;
    }
  }

  // ------------------------------------------------------------ squarified treemap
  function squarify(items, x, y, w, h) {
    // items: [{size, ...}] -> [{item, x, y, w, h}]; lays rows along the shorter side so tiles stay near-square
    const out = [];
    const total = items.reduce((s, i) => s + i.size, 0);
    if (!items.length || total <= 0 || w <= 0 || h <= 0) return out;
    const scale = (w * h) / total;
    const list = items.slice().sort((a, b) => b.size - a.size).map((i) => ({ item: i, area: i.size * scale }));
    let cx = x, cy = y, cw = w, ch = h, row = [], rowSum = 0;
    const worst = (r, s, side) => { if (!side || !s) return Infinity; let mx = 0, mn = Infinity; for (const q of r) { mx = Math.max(mx, q.area); mn = Math.min(mn, q.area); } return Math.max(side * side * mx / (s * s), (s * s) / (side * side * mn)); };
    const layoutRow = () => {
      if (cw >= ch) { const rw = rowSum / ch; let oy = cy; for (const q of row) { const rh = q.area / rw; out.push({ item: q.item, x: cx, y: oy, w: rw, h: rh }); oy += rh; } cx += rw; cw -= rw; }
      else { const rh = rowSum / cw; let ox = cx; for (const q of row) { const rw = q.area / rh; out.push({ item: q.item, x: ox, y: cy, w: rw, h: rh }); ox += rw; } cy += rh; ch -= rh; }
      row = []; rowSum = 0;
    };
    for (const q of list) {
      const side = Math.min(cw, ch);
      if (!row.length) { row.push(q); rowSum = q.area; continue; }
      if (worst(row.concat(q), rowSum + q.area, side) <= worst(row, rowSum, side)) { row.push(q); rowSum += q.area; }
      else { layoutRow(); row.push(q); rowSum = q.area; }
    }
    if (row.length) layoutRow();
    return out;
  }

  // ------------------------------------------------------------ map rendering
  function sizeOf(r) {
    if (state.sizeBy === 'equal') return 1;
    if (state.sizeBy === 'volume') return Math.max(r.volume || 0, 1);
    if (state.sizeBy === 'turnover') return Math.max(r.turnover || 0, 1);
    return r.market_cap || null;    // resolved in renderMap (fallback for names without a cap yet)
  }
  function renderMap() {
    const box = $('#map'); if (state.view !== 'map' || !state.rows.length) return;
    const W = box.clientWidth, H = box.clientHeight; if (!W || !H) return;
    const rows = state.rows;
    const caps = rows.map(sizeOf);
    const known = caps.filter((c) => c);
    const fallback = known.length ? Math.min(...known) * 0.6 : null;
    const sized = rows.map((r, i) => ({ r, size: caps[i] || fallback || Math.max(r.turnover || 0, 1) }));
    const capsMissing = state.sizeBy === 'market_cap' && known.length < rows.length;
    const sc = scaleFor(state.colorBy, rows); renderLegend(sc);
    const ok = new Set(matching().map((r) => r.symbol)), dimming = ok.size !== rows.length;
    const key = state.colorBy, m = METRICS[key], G = 2;
    const tileHtml = (t, r) => {
      const w = Math.max(0, t.w - G), h = Math.max(0, t.h - G); if (w < 2 || h < 2) return '';
      const fs = Math.max(10, Math.min(22, Math.sqrt(w * h) / 5.5));
      let inner = '';
      if (w >= 34 && h >= 16) inner = `<b style="font-size:${fs.toFixed(0)}px">${escapeHtml(r.name)}</b>` + (h >= fs * 2.4 && w >= 48 ? `<span style="font-size:${Math.max(9, fs * 0.78).toFixed(0)}px">${m.fmt(r[key])}</span>` : '');
      return `<div class="tile${dimming && !ok.has(r.symbol) ? ' dim' : ''}" data-sym="${r.symbol}" style="left:${t.x.toFixed(1)}px;top:${t.y.toFixed(1)}px;width:${w.toFixed(1)}px;height:${h.toFixed(1)}px;background:${colorFor(r[key], sc)}">${inner}</div>`;
    };
    let html = '';
    if (state.groupBy === 'sector') {
      const groups = {};
      for (const s of sized) (groups[s.r.sector || 'Other'] ||= []).push(s);
      const gItems = Object.entries(groups).map(([name, list]) => ({ name, list, size: list.reduce((a, b) => a + b.size, 0) }));
      for (const g of squarify(gItems, 0, 0, W, H)) {
        const gw = g.w - G, gh = g.h - G; if (gw < 4 || gh < 4) continue;
        const list = g.item.list, tot = g.item.size;
        const wavg = list.reduce((a, s) => a + (s.r[key] ?? (m.center || 0)) * s.size, 0) / tot;   // size-weighted metric for the header
        const header = gh >= 40 && gw >= 60 ? 17 : 0;
        const tiles = squarify(list, 0, 0, gw - 2, gh - header - 2).map((t) => tileHtml({ ...t, x: t.x + 1, y: t.y + header + 1 }, t.item.r)).join('');
        html += `<div class="sector" style="left:${g.x.toFixed(1)}px;top:${g.y.toFixed(1)}px;width:${gw.toFixed(1)}px;height:${gh.toFixed(1)}px">${header ? `<div class="sector-label" title="${escapeHtml(g.item.name)} · ${list.length} stocks · size-weighted ${m.label} ${m.fmt(wavg)}"><span>${escapeHtml(g.item.name)}</span><span class="${sc.kind === 'div' ? cls(wavg - (m.center || 0)) : ''}">${m.fmt(wavg)}</span></div>` : ''}${tiles}</div>`;
      }
    } else {
      html = squarify(sized, 0, 0, W, H).map((t) => tileHtml(t, t.item.r)).join('');
    }
    box.innerHTML = html || '<div class="muted map-empty">Nothing to show.</div>';
    $('#meta').textContent = `${ok.size} of ${rows.length}${capsMissing ? ' · market caps loading' : ''}`;
  }

  // tooltip
  const tip = $('#tip');
  function showTip(r, ev) {
    tip.innerHTML = `<div class="t-head"><b>${escapeHtml(r.name)}</b> <span class="muted">${escapeHtml(r.sector || '')}</span></div>
      <div class="t-price">${fmt(r.price)} <span class="${cls(r.chg_1d)}">${signed(r.chg_1d)}</span></div>
      <div class="t-grid">
        <span>Gap</span><span class="${cls(r.gap)}">${signed(r.gap)}</span>
        <span>5d</span><span class="${cls(r.chg_5d)}">${signed(r.chg_5d)}</span>
        <span>20d</span><span class="${cls(r.chg_20d)}">${signed(r.chg_20d)}</span>
        <span>Range</span><span>${fmt(r.range_pct)}%</span>
        <span>Vol × avg</span><span class="${r.vol_ratio >= 1.5 ? 'pos' : ''}">${r.vol_ratio == null ? '—' : r.vol_ratio.toFixed(2) + '×'}</span>
        <span>RSI</span><span class="${r.rsi < 30 ? 'pos' : r.rsi > 70 ? 'neg' : ''}">${r.rsi == null ? '—' : r.rsi.toFixed(0)}</span>
        <span>52-wk pos</span><span>${r.pos_52w == null ? '—' : r.pos_52w.toFixed(0) + '%'}</span>
        <span>Mkt cap</span><span>${crore(r.market_cap)}</span>
        <span>Turnover</span><span>${crore(r.turnover)}</span>
        <span>Trend</span><span>${biasBadge(r.bias)}</span>
        <span>Stretch</span><span class="${r.ext_score >= 35 ? 'neg' : ''}">${r.ext_score == null ? '—' : r.ext_score + (r.ext_score >= 50 ? ' · stretched' : r.ext_score >= 35 ? ' · extended' : r.ext_score >= 20 ? ' · warming' : '')}</span>
      </div><div class="muted" style="font-size:11px;margin-top:4px">click to analyze</div>`;
    tip.hidden = false; moveTip(ev);
  }
  function moveTip(ev) {
    const pad = 14, w = tip.offsetWidth, h = tip.offsetHeight;
    let x = ev.clientX + pad, y = ev.clientY + pad;
    if (x + w > window.innerWidth - 8) x = ev.clientX - w - pad;
    if (y + h > window.innerHeight - 8) y = ev.clientY - h - pad;
    tip.style.left = `${x}px`; tip.style.top = `${y}px`;
  }
  $('#map').addEventListener('mousemove', (ev) => {
    const t = ev.target.closest('.tile'); if (!t) { tip.hidden = true; return; }
    const r = state.rows.find((x) => x.symbol === t.dataset.sym); if (!r) return;
    if (tip.dataset.sym !== r.symbol) { tip.dataset.sym = r.symbol; showTip(r, ev); } else moveTip(ev);
  });
  $('#map').addEventListener('mouseleave', () => { tip.hidden = true; tip.dataset.sym = ''; });
  $('#map').addEventListener('click', (ev) => { const t = ev.target.closest('.tile'); if (t) go(t.dataset.sym); });

  // ------------------------------------------------------------ table rendering
  function biasBadge(b) {
    const label = b >= 3 ? 'bullish' : b <= -3 ? 'bearish' : b > 0 ? 'lean up' : b < 0 ? 'lean down' : 'mixed';
    const k = b >= 3 ? 'ok' : b <= -3 ? 'bad' : 'mid';
    return `<span class="badge ${k}">${label} ${b > 0 ? '+' : ''}${b}</span>`;
  }
  function renderTable() {
    const rows = matching();
    const { key, dir } = state.sort;
    rows.sort((a, b) => {
      const av = a[key], bv = b[key];
      if (av === null || av === undefined) return 1; if (bv === null || bv === undefined) return -1;
      return (av > bv ? 1 : av < bv ? -1 : 0) * dir * (typeof av === 'string' ? -1 : 1);
    });
    $$('th[data-sort]').forEach((th) => th.classList.toggle('sorted', th.dataset.sort === key));
    $('#table tbody').innerHTML = rows.map((r) => `
      <tr class="clickable" data-sym="${r.symbol}">
        <td><b>${r.name}</b><div class="muted" style="font-size:11px">${r.symbol}${r.via ? ` · <span title="Yahoo has no BSE history for this stock; NSE data shown">NSE data</span>` : ''}</div></td>
        <td><span class="badge">${escapeHtml(r.sector || '—')}</span></td>
        <td class="num">${fmt(r.price)}</td>
        <td class="num ${cls(r.chg_1d)}">${signed(r.chg_1d)}</td>
        <td class="num ${cls(r.gap)}">${signed(r.gap)}</td>
        <td class="num ${cls(r.chg_5d)}">${signed(r.chg_5d)}</td>
        <td class="num ${cls(r.chg_20d)}">${signed(r.chg_20d)}</td>
        <td class="num">${fmt(r.range_pct)}%</td>
        <td class="num ${r.vol_ratio >= 1.5 ? 'pos' : ''}">${r.vol_ratio === null ? '—' : r.vol_ratio.toFixed(2) + '×'}</td>
        <td class="num ${r.rsi < 30 ? 'pos' : r.rsi > 70 ? 'neg' : ''}">${r.rsi === null ? '—' : r.rsi.toFixed(0)}</td>
        <td class="num">${fmt(r.atr_pct)}%</td>
        <td class="num"><span class="pos-bar"><i style="left:${r.pos_52w ?? 50}%"></i></span>${r.pos_52w === null ? '—' : r.pos_52w.toFixed(0) + '%'}</td>
        <td class="num">${crore(r.market_cap)}</td>
        <td class="num">${biasBadge(r.bias)}</td>
        <td class="num ${r.ext_score >= 35 ? 'neg' : ''}">${r.ext_score == null ? '—' : r.ext_score}</td>
        <td><button class="btn small primary" data-go="${r.symbol}">Analyze</button></td>
      </tr>`).join('') || '<tr><td colspan="16" class="muted">Nothing matches.</td></tr>';
    $$('#table tbody tr.clickable').forEach((tr) => tr.addEventListener('click', () => go(tr.dataset.sym)));
    $('#meta').textContent = `${rows.length} of ${state.rows.length}`;
  }
  function render() { if (state.view === 'map') renderMap(); else renderTable(); }
  function setView(v) {
    state.view = v;
    $$('.seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
    $('#map').hidden = v !== 'map'; $('#map-tools').hidden = v !== 'map'; $('#table-wrap').hidden = v !== 'table';
    localStorage.setItem('tb.screener.view', v);
    render();
  }
  function go(symbol) {
    const exchange = symbol.toUpperCase().endsWith('.BO') ? 'BSE' : 'NSE';
    localStorage.setItem('tb.last', JSON.stringify({ symbol, exchange, interval: $('#interval').value, horizon: null }));
    window.location.href = `/?symbol=${encodeURIComponent(symbol)}&exchange=${exchange}&interval=${$('#interval').value}`;
  }
  function renderIndices(list) {
    $('#indices').innerHTML = list.map((i) => `<div class="idx"><div class="k">${i.name}</div><div class="v">${fmt(i.price)} <span class="${cls(i.chg_1d)}">${signed(i.chg_1d)}</span></div><div class="muted" style="font-size:11px">5d ${signed(i.chg_5d)} · 20d ${signed(i.chg_20d)}</div></div>`).join('');
  }
  let metaTimer = null;
  async function load() {
    const u = $('#universe').value, wl = $('#watchlist').value.trim();
    localStorage.setItem('tb.screener', JSON.stringify({ universe: u, watchlist: wl, interval: $('#interval').value, colorBy: state.colorBy, sizeBy: state.sizeBy, groupBy: state.groupBy }));
    const btn = $('#refresh'); btn.disabled = true; btn.textContent = 'Loading…';
    try {
      const d = await api(`/api/screener?universe=${u}${wl ? '&symbols=' + encodeURIComponent(wl) : ''}`);
      state.rows = d.rows; renderIndices(d.indices); render();
      status(d.missing.length ? `No data for: ${d.missing.join(', ')}` : null, 'info');
      $('#meta').textContent += ` · updated ${new Date(d.generated_at).toLocaleTimeString()} (${d.took_s}s)`;
      // market caps arrive from a background fetch: pick them up shortly after the first load
      clearTimeout(metaTimer);
      if (d.meta_pending && state.metaRetries < 4) { state.metaRetries += 1; metaTimer = setTimeout(load, 8000); } else if (!d.meta_pending) state.metaRetries = 0;
    } catch (e) { status(e.message); }
    btn.disabled = false; btn.textContent = 'Refresh';
  }

  // ------------------------------------------------------------ events
  $$('.chip').forEach((c) => c.addEventListener('click', () => {
    $$('.chip').forEach((x) => x.classList.remove('active')); c.classList.add('active'); state.filter = c.dataset.filter;
    const fs = FILTER_SORT[state.filter]; if (fs) state.sort = { key: fs[0], dir: fs[1] };
    const col = FILTER_COLOR[state.filter]; if (col) { state.colorBy = col; $('#color-by').value = col; }
    render();
  }));
  $$('th[data-sort]').forEach((th) => th.addEventListener('click', () => {
    const k = th.dataset.sort; state.sort = { key: k, dir: state.sort.key === k ? -state.sort.dir : -1 }; render();
  }));
  $$('.seg-btn').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
  $('#color-by').addEventListener('change', () => { state.colorBy = $('#color-by').value; render(); });
  $('#size-by').addEventListener('change', () => { state.sizeBy = $('#size-by').value; render(); });
  $('#group-by').addEventListener('change', () => { state.groupBy = $('#group-by').value; render(); });
  $('#search').addEventListener('input', () => { state.search = $('#search').value.trim(); render(); });
  $('#refresh').addEventListener('click', () => { state.metaRetries = 0; load(); });
  $('#universe').addEventListener('change', () => { state.metaRetries = 0; load(); });
  $('#watchlist').addEventListener('change', () => { state.metaRetries = 0; load(); });
  let left = 60, timer = null;
  $('#auto').addEventListener('change', () => {
    $('.live-toggle').classList.toggle('on', $('#auto').checked); clearInterval(timer); $('#auto-countdown').textContent = '';
    if (!$('#auto').checked) return;
    left = 60; timer = setInterval(async () => { left -= 1; $('#auto-countdown').textContent = `${left}s`; if (left <= 0) { left = 60; await load(); } }, 1000);
  });
  let raf = null;
  new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(renderMap); }).observe($('#map'));

  // ------------------------------------------------------------ boot
  (async () => {
    const us = await api('/api/universes');
    $('#universe').innerHTML = us.map((u) => `<option value="${u.key}">${u.name} (${u.count})</option>`).join('');
    try {
      const saved = JSON.parse(localStorage.getItem('tb.screener') || 'null');
      if (saved) {
        $('#universe').value = saved.universe; $('#watchlist').value = saved.watchlist || '';   // analyze interval always starts at the 15-minute default
        if (saved.colorBy && METRICS[saved.colorBy]) { state.colorBy = saved.colorBy; $('#color-by').value = saved.colorBy; }
        if (saved.sizeBy) { state.sizeBy = saved.sizeBy; $('#size-by').value = saved.sizeBy; }
        if (saved.groupBy) { state.groupBy = saved.groupBy; $('#group-by').value = saved.groupBy; }
      }
    } catch {}
    if (!$('#universe').value) $('#universe').value = 'nifty100';
    setView(localStorage.getItem('tb.screener.view') === 'table' ? 'table' : 'map');
    load();
  })();
})();
