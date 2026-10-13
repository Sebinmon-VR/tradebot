/* Trading Analytics front-end */
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const fmt = (v, d = 2) => (v === null || v === undefined || Number.isNaN(v)) ? '—' : Number(v).toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d });
  const pct = (v, d = 1) => (v === null || v === undefined) ? '—' : `${(v * 100).toFixed(d)}%`;
  // bar times from the API are naive UTC ("2026-09-24T04:30:00"): parse them as UTC, never as local time
  const parseIso = (iso) => new Date(/[zZ]$|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso + 'Z');
  const when = (iso) => iso ? parseIso(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—';
  const isDailyPlus = (interval) => interval === '1d' || interval === '1wk';
  // bar labels: daily/weekly bars are stamped at midnight UTC, so show only the date for them
  const whenBar = (iso, interval) => !iso ? '—' : isDailyPlus(interval) ? parseIso(iso).toLocaleDateString(undefined, { dateStyle: 'medium', timeZone: 'UTC' }) : when(iso);
  const CAT_LABEL = { trend: 'Trend', momentum: 'Momentum', volatility: 'Volatility', volume: 'Volume', price_action: 'Price action', levels: 'Levels', statistical: 'Statistical', ml: 'Machine learning', regime: 'Regime', error: 'Error' };

  const state = { chart: null, pane: null, series: {}, paneSeries: [], chartData: null, prediction: null, overlays: {}, priceLines: [], pivotLines: [], paneKind: 'rsi', feedbackTarget: null, catalog: [], tabs: [], activeTab: -1,
    // real-time state: tick socket, tail-poll timer, cumulative day volume seen, last tick, bar the analysis was made on
    live: { ws: null, timer: null, fullTimer: null, dayVolume: null, tick: null, key: null, reconnect: null, lastTickAt: 0, barClosed: false, analysisBar: null } };
  const INTRADAY_POLL_MS = 4000, DAILY_POLL_MS = 20000, FULL_RESYNC_MS = 300000, LIVE_MAX_SECONDS = 120;

  // ------------------------------------------------------------ status
  function status(msg, kind = 'error') {
    const el = $('#status');
    if (!msg) { el.hidden = true; return; }
    el.textContent = msg; el.className = 'status ' + (kind === 'info' ? 'info' : ''); el.hidden = false;
  }
  async function api(path, opts = {}) {
    const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.detail || res.statusText);
    return body;
  }

  // ------------------------------------------------------------ chart
  // colours come from the page theme (dark / light, see theme.js); the top-bar switch fires 'tb-theme'
  const cssVar = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const themeOpts = () => ({
    layout: { background: { type: 'solid', color: 'rgba(0,0,0,0)' }, textColor: cssVar('--muted'), fontFamily: 'Manrope, system-ui, sans-serif' },
    grid: { vertLines: { color: cssVar('--line') }, horzLines: { color: cssVar('--line') } },
    rightPriceScale: { borderColor: cssVar('--line') },
    timeScale: { borderColor: cssVar('--line'), timeVisible: true, secondsVisible: false },
  });
  window.addEventListener('tb-theme', () => { [state.chart, state.pane].forEach((c) => c && c.applyOptions(themeOpts())); });
  const chartOpts = {
    ...themeOpts(),
    crosshair: { mode: 0 },
    localization: { timeFormatter: (t) => new Date(t * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) },
  };
  function initCharts() {
    state.chart = LightweightCharts.createChart($('#chart-main'), { ...chartOpts, autoSize: true });
    state.pane = LightweightCharts.createChart($('#chart-pane'), { ...chartOpts, autoSize: true });
    state.series.candles = state.chart.addCandlestickSeries({ upColor: '#1fdc6a', downColor: '#ff4d4f', borderVisible: false, wickUpColor: '#1fdc6a', wickDownColor: '#ff4d4f' });
    state.series.volume = state.chart.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: 'vol' });
    state.chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    // sync time scales
    let syncing = false;
    const link = (a, b) => a.timeScale().subscribeVisibleLogicalRangeChange((r) => { if (syncing || !r) return; syncing = true; b.timeScale().setVisibleLogicalRange(r); syncing = false; });
    link(state.chart, state.pane); link(state.pane, state.chart);
  }
  const OVERLAY_STYLE = {
    ema_9: { color: '#4f8cff', lineWidth: 1 }, ema_21: { color: '#f0b429', lineWidth: 1 },
    sma_50: { color: '#ff8a65', lineWidth: 1 }, sma_200: { color: '#ba68c8', lineWidth: 2 },
    bb_upper: { color: 'rgba(120,160,255,.6)', lineWidth: 1 }, bb_lower: { color: 'rgba(120,160,255,.6)', lineWidth: 1 },
    kc_upper: { color: 'rgba(255,200,120,.6)', lineWidth: 1, lineStyle: 2 }, kc_lower: { color: 'rgba(255,200,120,.6)', lineWidth: 1, lineStyle: 2 },
    supertrend: { color: '#26c6da', lineWidth: 2, lineStyle: 0 }, psar: { color: '#9aa3b2', lineWidth: 1, lineStyle: 1 },
    vwap_20: { color: '#b8800a', lineWidth: 1, lineStyle: 2 },
    senkou_a: { color: 'rgba(38,166,154,.7)', lineWidth: 1 }, senkou_b: { color: 'rgba(239,83,80,.7)', lineWidth: 1 },
  };
  const OVERLAY_GROUPS = { bb: ['bb_upper', 'bb_lower'], kc: ['kc_upper', 'kc_lower'], ichimoku: ['senkou_a', 'senkou_b'] };
  function overlayKeys(name) { return OVERLAY_GROUPS[name] || [name]; }
  function renderOverlays() {
    if (!state.chartData) return;
    $$('#overlay-toggles input').forEach((cb) => {
      const name = cb.dataset.overlay;
      if (name === 'levels') { renderLevels(cb.checked); return; }
      if (name === 'pivots' || name === 'camarilla') { renderPivots(); return; }
      overlayKeys(name).forEach((key) => {
        const data = state.chartData.overlays[key] || [];
        if (cb.checked) {
          if (!state.overlays[key]) state.overlays[key] = state.chart.addLineSeries({ ...OVERLAY_STYLE[key], priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
          state.overlays[key].setData(data);
        } else if (state.overlays[key]) {
          state.chart.removeSeries(state.overlays[key]); delete state.overlays[key];
        }
      });
    });
  }
  function renderForecast() {
    if (!state.forecast) {
      state.forecast = {
        median: state.chart.addLineSeries({ color: '#8a8c93', lineWidth: 2, lineStyle: 2, priceLineVisible: false, lastValueVisible: true, title: 'forecast' }),
        upper: state.chart.addLineSeries({ color: 'rgba(29,36,48,.3)', lineWidth: 1, lineStyle: 3, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }),
        lower: state.chart.addLineSeries({ color: 'rgba(29,36,48,.3)', lineWidth: 1, lineStyle: 3, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }),
      };
    }
    const p = state.prediction, show = $('[data-overlay=levels]').checked;
    if (!show || !p || !p.forecast || !state.chartData || p.symbol !== state.chartData.symbol || p.interval !== state.chartData.interval) {
      Object.values(state.forecast).forEach((s) => s.setData([])); return;
    }
    const color = p.direction === 'UP' ? '#1fdc6a' : p.direction === 'DOWN' ? '#ff4d4f' : '#f0b429';
    const start = { time: state.chartData.last.time, value: p.price_at };
    // forecast timestamps must be strictly increasing and after the last candle
    const pts = p.forecast.filter((f) => f.time > state.chartData.last.time);
    state.forecast.median.applyOptions({ color });
    state.forecast.median.setData([start, ...pts.map((f) => ({ time: f.time, value: f.median }))]);
    state.forecast.upper.setData([start, ...pts.map((f) => ({ time: f.time, value: f.upper }))]);
    state.forecast.lower.setData([start, ...pts.map((f) => ({ time: f.time, value: f.lower }))]);
  }
  function renderLevels(show) {
    state.priceLines.forEach((l) => state.series.candles.removePriceLine(l)); state.priceLines = [];
    renderForecast();
    const p = state.prediction;
    if (!show || !p || !state.chartData || p.symbol !== state.chartData.symbol) return;
    const add = (price, color, title) => state.priceLines.push(state.series.candles.createPriceLine({ price, color, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title }));
    add(p.price_at, '#6b7583', 'entry');
    if (p.direction !== 'SIDEWAYS') { add(p.target_price, p.direction === 'UP' ? '#1fdc6a' : '#ff4d4f', 'target'); if (p.stop_price) add(p.stop_price, '#f0b429', 'stop'); }
  }
  // session levels: floor pivots + CPR, Camarilla (from the chart payload, so they show without a prediction)
  function renderPivots() {
    state.pivotLines.forEach((l) => state.series.candles.removePriceLine(l)); state.pivotLines = [];
    const lv = state.chartData && state.chartData.levels; if (!lv || !lv.pivots) return;
    const add = (price, color, title, style = 3) => { if (price == null || !isFinite(price)) return; state.pivotLines.push(state.series.candles.createPriceLine({ price, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title })); };
    if ($('[data-overlay=pivots]').checked) {
      add(lv.pivots.pivot, '#b8800a', 'P', 0);
      ['r1', 'r2', 'r3'].forEach((k) => add(lv.pivots[k], 'rgba(239,83,80,.85)', k.toUpperCase()));
      ['s1', 's2', 's3'].forEach((k) => add(lv.pivots[k], 'rgba(38,166,154,.85)', k.toUpperCase()));
      if (lv.cpr) { add(lv.cpr.tc, 'rgba(184,128,10,.6)', 'TC', 2); add(lv.cpr.bc, 'rgba(184,128,10,.6)', 'BC', 2); }
    }
    if ($('[data-overlay=camarilla]').checked && lv.camarilla) {
      ['h3', 'h4'].forEach((k) => add(lv.camarilla[k], '#ff8a65', k.toUpperCase(), 4));
      ['l3', 'l4'].forEach((k) => add(lv.camarilla[k], '#26c6da', k.toUpperCase(), 4));
    }
  }
  const PANES = {
    rsi: [{ key: 'rsi_14', color: '#ba68c8', lines: [30, 70] }],
    macd: [{ key: 'macd_hist', type: 'hist' }, { key: 'macd', color: '#4f8cff' }, { key: 'macd_signal', color: '#ff8a65' }],
    adx: [{ key: 'adx', color: '#b8800a', lines: [20, 25] }],
    stoch: [{ key: 'stoch_k', color: '#4f8cff', lines: [20, 80] }, { key: 'stoch_d', color: '#ff8a65' }],
    obv: [{ key: 'obv', color: '#26c6da' }],
    cci: [{ key: 'cci_20', color: '#ba68c8', lines: [-100, 100] }],
    mfi: [{ key: 'mfi_14', color: '#1fdc6a', lines: [20, 80] }],
  };
  function renderPane() {
    state.paneSeries.forEach((s) => state.pane.removeSeries(s)); state.paneSeries = [];
    if (!state.chartData) return;
    (PANES[state.paneKind] || []).forEach((cfg) => {
      const data = state.chartData.panes[cfg.key] || [];
      let s;
      if (cfg.type === 'hist') {
        s = state.pane.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false });
        s.setData(data.map((d) => ({ ...d, color: d.value >= 0 ? 'rgba(38,166,154,.7)' : 'rgba(239,83,80,.7)' })));
      } else {
        s = state.pane.addLineSeries({ color: cfg.color, lineWidth: 1, priceLineVisible: false, lastValueVisible: true });
        s.setData(data);
        (cfg.lines || []).forEach((v) => s.createPriceLine({ price: v, color: '#c9d0da', lineWidth: 1, lineStyle: 3, axisLabelVisible: false }));
      }
      s.__key = cfg.key; s.__hist = cfg.type === 'hist';
      state.paneSeries.push(s);
    });
    state.pane.timeScale().setVisibleLogicalRange(state.chart.timeScale().getVisibleLogicalRange());
  }
  const histColor = (v) => v >= 0 ? 'rgba(38,166,154,.7)' : 'rgba(239,83,80,.7)';
  let chartSeq = 0;   // every chart request is numbered: a slower, older request must not overwrite a newer chart
  async function loadChart(symbol, interval, exchange) {
    const seq = ++chartSeq;
    const data = await api(`/api/chart?symbol=${encodeURIComponent(symbol)}&interval=${interval}&exchange=${exchange}`);
    if (seq !== chartSeq) return null;   // the user switched tabs while this chart was loading
    const same = state.chartData && state.chartData.symbol === data.symbol && state.chartData.interval === interval;
    const prevRange = same ? state.chart.timeScale().getVisibleLogicalRange() : null;
    data.exchange = exchange;
    state.chartData = data;
    state.series.candles.setData(data.candles);
    state.series.volume.setData(data.volume);
    Object.values(state.overlays).forEach((s) => state.chart.removeSeries(s)); state.overlays = {};
    renderOverlays(); renderPane();
    if (!same) {
      // a different symbol or timeframe: dragging a price axis switches it to a fixed range, and that range would
      // leave the new symbol's candles outside the visible area (a 239-rupee stock on a 600-rupee axis looks blank)
      state.chart.priceScale('right').applyOptions({ autoScale: true });
      state.pane.priceScale('right').applyOptions({ autoScale: true });
      state.chart.timeScale().applyOptions({ rightOffset: 12 });
    }
    if (prevRange) state.chart.timeScale().setVisibleLogicalRange(prevRange);
    else state.chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, data.candles.length - 160), to: data.candles.length + 12 });
    $('#chart-title').textContent = `${data.symbol} · ${interval}`;
    updateHeader();
    tkSync();
    startLive(data.data_symbol || data.symbol, exchange);
    return data;
  }

  // ------------------------------------------------------------ real-time chart
  // Two feeds keep the chart current:
  //  1. a WebSocket of trades (Yahoo's streamer, relayed by the server) moves the forming candle on every tick;
  //  2. a small "tail" poll every few seconds fetches Yahoo's official bars from the last candle onward, which
  //     reconciles the tick-built candle, appends new bars and refreshes every indicator line.
  function lastCandle() { const c = state.chartData && state.chartData.candles; return c && c.length ? c[c.length - 1] : null; }
  function setLiveBadge(kind, text) { const el = $('#chart-live'); el.className = 'chart-live ' + kind; el.textContent = text; }
  function updateHeader() {
    const cd = state.chartData, last = lastCandle(); if (!last) return;
    const t = state.live.tick, useTick = t && t.symbol === (cd.data_symbol || cd.symbol) && Date.now() - state.live.lastTickAt < 120000;
    const price = useTick ? t.price : last.close;
    $('#chart-price').textContent = fmt(price);
    let ch = null, label = '';
    if (useTick && typeof t.change_percent === 'number') { ch = t.change_percent / 100; label = 'today'; }
    else { const prev = cd.candles[cd.candles.length - 2]; if (prev) { ch = last.close / prev.close - 1; label = 'vs prev bar'; } }
    const chEl = $('#chart-change');
    chEl.textContent = ch === null ? '' : `${ch >= 0 ? '+' : ''}${(ch * 100).toFixed(2)}% ${label}`;
    chEl.className = 'change ' + (ch >= 0 ? 'up' : 'down');
    updateNow(price);
    tkLtp(price);
  }
  function stopLive() {
    const L = state.live;
    clearInterval(L.timer); L.timer = null; clearInterval(L.fullTimer); L.fullTimer = null; clearTimeout(L.reconnect); L.reconnect = null;
    if (L.ws) { const w = L.ws; L.ws = null; try { w.onclose = null; w.close(); } catch {} }
    L.dayVolume = null; L.tick = null; L.key = null;
  }
  function startLive(symbol, exchange) {
    const key = `${symbol}|${state.chartData.interval}`;
    if (state.live.key === key && state.live.ws) return;   // already streaming this symbol
    stopLive();
    const L = state.live; L.key = key; L.analysisBar = null; L.barClosed = false;   // a new chart: no bar of it has closed since a call
    L.timer = setInterval(pollTail, state.chartData.bar_seconds < 86400 ? INTRADAY_POLL_MS : DAILY_POLL_MS);
    L.fullTimer = setInterval(reloadChart, FULL_RESYNC_MS);   // full resync so tick-built bars match Yahoo's exactly
    connectTicks(symbol, exchange, key);
  }
  function connectTicks(symbol, exchange, key) {
    const L = state.live;
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/ticks?symbol=${encodeURIComponent(symbol)}&exchange=${exchange}`;
    let ws;
    try { ws = new WebSocket(url); } catch { setLiveBadge('poll', '◌ polling'); return; }
    L.ws = ws;
    setLiveBadge('poll', '◌ connecting');
    ws.onopen = () => setLiveBadge('poll', '◌ waiting for trades');
    ws.onmessage = (ev) => { if (L.key !== key) return; try { onTick(JSON.parse(ev.data)); } catch (e) { console.warn('tick', e); } };
    ws.onclose = () => {
      if (L.key !== key) return;
      L.ws = null; setLiveBadge('poll', '◌ polling (stream offline)');
      L.reconnect = setTimeout(() => { if (L.key === key) connectTicks(symbol, exchange, key); }, 3000);
    };
    ws.onerror = () => { try { ws.close(); } catch {} };
  }
  function onTick(t) {
    if (t.error) { setLiveBadge('poll', '◌ ' + t.error); return; }
    if (t.subscribed) return;
    const cd = state.chartData, last = lastCandle(); if (!cd || !last) return;
    if (t.symbol !== (cd.data_symbol || cd.symbol)) return;
    const L = state.live; L.tick = t; L.lastTickAt = Date.now();
    setLiveBadge('on', `● LIVE ${new Date(t.time).toLocaleTimeString()}`);
    const sec = cd.bar_seconds, tsec = Math.floor(t.time / 1000);
    let bucket;
    if (sec >= 86400) bucket = (tsec >= last.time && tsec < last.time + sec) ? last.time : null;
    else {
      bucket = last.time + Math.floor((tsec - last.time) / sec) * sec;
      // only extend by exactly one bar; across a session gap the tail poll creates the correctly-timed bar
      if (bucket < last.time || bucket > last.time + sec) bucket = null;
    }
    if (bucket !== null && (t.market_hours === undefined || t.market_hours === 1 || t.market_hours === 'REGULAR_MARKET')) {
      let c;
      if (bucket === last.time) { c = last; c.high = Math.max(c.high, t.price); c.low = Math.min(c.low, t.price); c.close = t.price; }
      else { c = { time: bucket, open: t.price, high: t.price, low: t.price, close: t.price }; cd.candles.push(c); cd.volume.push({ time: bucket, value: 0 }); cd.last = { time: bucket, close: t.price }; }
      c.synthetic = true;
      try { state.series.candles.update({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close }); } catch (e) { console.warn(e); }
      const vol = cd.volume[cd.volume.length - 1];
      if (vol && vol.time === c.time && t.day_volume != null) {
        if (L.dayVolume != null && t.day_volume > L.dayVolume) vol.value += t.day_volume - L.dayVolume;
        L.dayVolume = t.day_volume;
        vol.color = c.close >= c.open ? 'rgba(38,166,154,0.5)' : 'rgba(239,83,80,0.5)';
        try { state.series.volume.update(vol); } catch {}
      }
      cd.last.close = t.price;
    }
    updateHeader();
  }
  let tailBusy = false;
  async function pollTail() {
    const cd = state.chartData, last = lastCandle(); if (!cd || !last || tailBusy) return;
    tailBusy = true;
    try {
      // ask from the last *official* bar we hold so a tick-built bar the server has not printed yet is not a gap
      const official = [...cd.candles].reverse().find((c) => !c.synthetic) || last;
      const d = await api(`/api/chart/tail?symbol=${encodeURIComponent(cd.symbol)}&interval=${cd.interval}&exchange=${cd.exchange}&since=${official.time}`);
      if (state.chartData !== cd) return;   // the chart changed while the poll was in flight: these bars belong to the old symbol
      if (!d.candles.length) return;
      if (d.candles[0].time !== official.time) { await reloadChart(); return; }   // bar times diverged: resync
      const before = last.time;
      for (const c of d.candles) {
        const cur = lastCandle();
        if (c.time < cur.time) { // official bar behind a tick-built one: merge official OHLC into our copy
          const mine = cd.candles.find((x) => x.time === c.time); if (mine) Object.assign(mine, c, { synthetic: false }); continue;
        }
        if (c.time === cur.time) Object.assign(cur, c, { synthetic: false }); else cd.candles.push({ ...c, synthetic: false });
        state.series.candles.update({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close });
      }
      for (const v of d.volume) {
        const cur = cd.volume[cd.volume.length - 1];
        if (cur && v.time < cur.time) { const mine = cd.volume.find((x) => x.time === v.time); if (mine) Object.assign(mine, v); continue; }
        if (cur && v.time === cur.time) Object.assign(cur, v); else cd.volume.push({ ...v });
        state.series.volume.update(v);
      }
      const upd = (series, points, key, hist) => {
        if (!series || !points) return;
        for (const pt of points) { try { series.update(hist ? { ...pt, color: histColor(pt.value) } : pt); } catch { /* older than the series' last point: ignore */ } }
        const arr = key && (cd.overlays[key] || cd.panes[key]);
        if (arr) for (const pt of points) { const i = arr.findIndex((x) => x.time === pt.time); if (i >= 0) arr[i] = pt; else if (!arr.length || pt.time > arr[arr.length - 1].time) arr.push(pt); }
      };
      Object.entries(d.overlays).forEach(([k, pts]) => upd(state.overlays[k], pts, k, false));
      Object.entries(d.panes).forEach(([k, pts]) => upd(state.paneSeries.find((ps) => ps.__key === k), pts, k, state.paneSeries.find((ps) => ps.__key === k)?.__hist));
      const now = lastCandle();
      cd.last = { time: now.time, close: now.close }; cd.last_bar_forming = d.last_bar_forming;
      if (d.levels && d.levels.pivots && JSON.stringify(d.levels) !== JSON.stringify(cd.levels)) { cd.levels = d.levels; renderPivots(); }   // a new session: fresh pivots
      if (now.time !== before) state.live.dayVolume = state.live.tick ? state.live.tick.day_volume : null;
      // a bar has closed since the analysis ran -> live mode re-runs immediately
      if (state.live.analysisBar !== null && now.time > state.live.analysisBar) state.live.barClosed = true;
      if (!state.live.ws || Date.now() - state.live.lastTickAt > 15000) setLiveBadge(state.live.ws ? 'idle' : 'poll', `◌ ${state.live.ws ? 'no trades' : 'polling'} · bars ${new Date(d.server_time * 1000).toLocaleTimeString()}`);
      updateHeader();
    } catch (e) { console.warn('tail', e); }
    finally { tailBusy = false; }
  }
  async function reloadChart() {
    const cd = state.chartData; if (!cd) return;
    const key = state.live.key;
    try { await loadChart(cd.symbol, cd.interval, cd.exchange); } catch (e) { console.warn('reload', e); }
    if (state.live.key !== key) state.live.analysisBar = null;
  }
  // "Now" row on the prediction card: live price versus entry / target / stop
  function updateNow(price) {
    const p = state.prediction, el = $('#pred-now'); if (!p || !el || !state.chartData || p.symbol !== state.chartData.symbol) { if (el) el.hidden = true; return; }
    const since = price / p.price_at - 1;
    let prog = '';
    if (p.direction !== 'SIDEWAYS' && p.target_price && p.stop_price) {
      const span = Math.abs(p.target_price - p.price_at), done = (price - p.price_at) * (p.direction === 'UP' ? 1 : -1);
      const pctT = Math.max(-999, Math.min(999, done / span * 100));
      prog = done >= span ? ' · <b class="up">target reached</b>' : (p.direction === 'UP' ? price <= p.stop_price : price >= p.stop_price) ? ' · <b class="down">stop hit</b>' : ` · ${pctT.toFixed(0)}% of the way to target`;
    }
    el.hidden = false;
    el.innerHTML = `Now <b>${fmt(price)}</b> <span class="${since >= 0 ? 'up' : 'down'}">${since >= 0 ? '+' : ''}${(since * 100).toFixed(2)}%</span> since entry${prog}`;
  }

  // ------------------------------------------------------------ learning pop-up
  const FEATURE_LABEL = { rsi_14: 'RSI 14', rsi_2: 'RSI 2', stoch_k: 'Stochastic %K', williams_r: 'Williams %R', cci_20: 'CCI 20', mfi_14: 'MFI 14', adx: 'ADX', roc_10: 'ROC 10', roc_60: 'ROC 60',
    bb_pct: 'Bollinger %B', bb_width: 'Bollinger width', volatility_20: '20-bar volatility', supertrend_dir: 'Supertrend direction', psar_dir: 'PSAR direction', cmf_20: 'Chaikin money flow',
    macd_hist_n: 'MACD histogram', di_diff: '+DI minus -DI', ret_h: 'return over the horizon', dist_sma20: 'distance to SMA20', dist_sma50: 'distance to SMA50', dist_ema200: 'distance to EMA200',
    dist_hma20: 'distance to HMA20', atr_pct: 'ATR %', vol_ratio: 'volume vs 20-bar average', vol_z: 'volume z-score', obv_slope: 'OBV slope', hl_range: 'bar range', body: 'bar body',
    range_pos: 'close position in bar', gap: 'gap', rv_ratio: 'short vs long volatility', dist_dc20: 'position in 20-bar channel', cloud_pos: 'position vs Ichimoku cloud',
    tod: 'time of day', tod_sin: 'time of day (sin)', tod_cos: 'time of day (cos)', dow_sin: 'day of week (sin)', dow_cos: 'day of week (cos)',
    mkt_ret_1: 'NIFTY 1-bar return', mkt_ret_5: 'NIFTY 5-bar return', mkt_ret_20: 'NIFTY 20-bar return', mkt_vol_20: 'NIFTY volatility', rel_5: 'return vs NIFTY (5 bars)', rel_20: 'return vs NIFTY (20 bars)' };
  function featureLabel(k, names) {
    if (k.startsWith('v_')) { const s = names[k.slice(2)]; return (s ? s.name : k.slice(2)) + ' vote'; }
    if (FEATURE_LABEL[k]) return FEATURE_LABEL[k];
    const m = k.match(/^ret_(\d+)$/); if (m) return `${m[1]}-bar return`;
    return k.replace(/_/g, ' ');
  }
  function openLearning(p) {
    const names = {}; (p.signals || []).forEach((s) => names[s.key] = s);
    const S = p.summary || {}, L = S.learner || null;
    const dirLabel = p.direction === 'SIDEWAYS' ? '◆ NO CALL' : p.direction === 'UP' ? '▲ UP' : '▼ DOWN';
    const learners = (p.signals || []).filter((s) => s.category === 'ml' && s.key !== 'wf_ensemble');
    const fb = S.fallback_prob_up != null ? S.fallback_prob_up : p.prob_up;
    let html = `<h4>What it predicted</h4>
      <div class="learn-call"><span class="dir ${p.direction}">${dirLabel}</span><div><b>${p.symbol}</b> · ${p.interval} · next ${p.horizon_bars} bars after ${whenBar(p.bar_time, p.interval)}<br>
        <span class="muted">Calibrated P(up) ${pct(p.prob_up)} · ${p.direction === 'SIDEWAYS' ? 'no directional call' : `${p.direction} to ${fmt(p.target_price)}, stop ${fmt(p.stop_price)} (${p.expected_move_pct.toFixed(2)}% expected move)`}${p.auto_outcome ? ` · graded ${outcomeBadge(p.auto_outcome)}` : ''}</span></div></div>`;
    if (L && L.available) {
      const t = L.tier || {};
      html += `<div class="learn-grid" style="margin-top:8px">
        <div class="kv"><span class="k">Raw model P(up)</span><span class="v">${pct(L.prob_raw)}</span></div>
        <div class="kv"><span class="k">After calibration</span><span class="v">${pct(L.prob_up)}</span></div>
        <div class="kv"><span class="k">Call threshold</span><span class="v">≥ ${pct(L.threshold, 0)} or ≤ ${pct(1 - L.threshold, 0)}</span></div>
        <div class="kv"><span class="k">Validated accuracy</span><span class="v">${t.accuracy != null ? pct(t.accuracy, 0) : '—'}</span></div>
        <div class="kv"><span class="k">Similar past calls</span><span class="v">${t.n != null ? t.n : '—'} <span class="muted">(${pct(t.coverage, 0)} of bars)</span></span></div>
        <div class="kv"><span class="k">Evidence</span><span class="v">${EVIDENCE_LABEL[L.evidence] || L.evidence || '—'}</span></div>
      </div>
      <h4>Who voted what</h4>
      <table class="learn-table"><thead><tr><th>Learner</th><th class="num">P(up) now</th><th class="num">Walk-forward accuracy</th><th>Vote</th></tr></thead><tbody>
      ${learners.map((s) => `<tr><td>${s.name}</td><td class="num">${pct(s.values.prob_up, 0)}</td><td class="num">${pct(s.values.validation_accuracy, 0)}</td><td>${voteHtml(s.direction)}</td></tr>`).join('')}
      <tr><td>Rule ensemble (all strategies + statistical models)</td><td class="num">${pct(fb, 0)}</td><td class="num muted">—</td><td>${voteHtml(fb > 0.58 ? 1 : fb < 0.42 ? -1 : 0)}</td></tr>
      </tbody></table>
      <div class="learn-note">The four learners are averaged and then calibrated (Platt scaling) on their own out-of-sample record, with recent bars weighted more (half-life ${L.half_life} bars). That gives the calibrated P(up). A direction is called only beyond the strength at which such calls were right at least 55% of the time on this chart.</div>
      <h4>What it learned on this chart</h4>
      <div class="learn-grid">
        <div class="kv"><span class="k">Trained on</span><span class="v">${L.n_rows} bars · ${L.n_features} inputs</span></div>
        <div class="kv"><span class="k">Validation</span><span class="v">${L.folds} walk-forward folds</span></div>
        <div class="kv"><span class="k">Out-of-sample accuracy</span><span class="v">${pct(L.accuracy, 0)} <span class="muted">vs ${pct(L.base_rate, 0)} drift</span></span></div>
        <div class="kv"><span class="k">Windows that closed higher</span><span class="v">${pct(L.up_rate, 0)}</span></div>
        <div class="kv"><span class="k">Log-loss (lower = better)</span><span class="v">${Number(L.logloss).toFixed(3)} <span class="muted">vs ${Number(L.logloss_base).toFixed(3)} drift</span></span></div>
        <div class="kv"><span class="k">Model fitted on bar</span><span class="v">${whenBar(L.fitted_on, p.interval)}</span></div>
      </div>
      <h4>Accuracy by call strength (out-of-sample)</h4>
      <table class="learn-table"><thead><tr><th>Strength</th><th class="num">Calls</th><th class="num">Share of bars</th><th class="num">Accuracy</th><th></th></tr></thead><tbody>
      ${(L.tiers || []).map((x) => `<tr class="${t.threshold === x.threshold ? 'here' : ''}"><td>P ≥ ${x.threshold.toFixed(2)} or ≤ ${(1 - x.threshold).toFixed(2)}</td><td class="num">${x.n}</td><td class="num">${pct(x.coverage, 0)}</td><td class="num">${x.accuracy == null ? '—' : pct(x.accuracy, 0)}</td><td>${x.threshold === L.threshold ? '<span class="badge ok">call threshold</span>' : ''}${t.threshold === x.threshold ? '<span class="badge">this call</span>' : ''}</td></tr>`).join('')}
      </tbody></table>
      <h4>Learners (walk-forward)</h4>
      <table class="learn-table"><thead><tr><th>Learner</th><th class="num">Accuracy</th><th class="num">Log-loss</th></tr></thead><tbody>
      ${Object.entries(L.learners || {}).map(([k, v]) => `<tr><td>${names[k] ? names[k].name : k}</td><td class="num">${pct(v.accuracy, 0)}</td><td class="num">${Number(v.logloss).toFixed(3)}</td></tr>`).join('')}
      </tbody></table>`;
      const lw = Object.entries(L.learned_weights || {}).sort((a, b) => b[1] - a[1]);
      if (lw.length) {
        const maxw = Math.max(0.01, ...lw.map(([, w]) => Math.abs(w)));
        html += `<h4>Weight learned for each strategy <span class="muted" style="text-transform:none">(stacked model: + = trust its vote here, − = fade it)</span></h4>
        <div class="learn-weights">${lw.map(([k, w]) => `<div class="row"><span>${names[k] ? names[k].name : k}</span><span><i class="wbar ${w >= 0 ? 'pos' : 'neg'}" style="width:${(Math.abs(w) / maxw * 70).toFixed(0)}px"></i></span><span class="lw ${w > 0.05 ? 'pos' : w < -0.05 ? 'neg' : ''}">${w > 0 ? '+' : ''}${w.toFixed(2)}</span></div>`).join('')}</div>`;
      }
      if (L.top_features && L.top_features.length) {
        html += `<h4>Most informative inputs <span class="muted" style="text-transform:none">(Random Forest importance)</span></h4><div>${L.top_features.map(([k, w]) => `<span class="badge" title="${k}">${featureLabel(k, names)} · ${(w * 100).toFixed(1)}%</span> `).join('')}</div>`;
      }
    } else {
      html += `<div class="learn-note" style="margin-top:10px"><b>Rule ensemble only.</b> ${L ? escapeHtml(L.reason || '') : 'This prediction was made before the learning layer existed.'} P(up) = 0.65 × weighted strategy votes (${pct(S.rule_prob_up)}) + 0.35 × statistical models (${S.model_prob_up != null ? pct(S.model_prob_up) : '—'}); a direction is called beyond ${pct(S.threshold || 0.58, 0)}.</div>`;
    }
    html += `<h4>Rule ensemble behind it</h4><div class="learn-note" style="margin-top:0">Bull / bear score ${S.bull_score} / ${S.bear_score} · ${S.agreeing} of ${S.voters} voters agree with the call · regime ${S.regime || '—'} (Hurst ${S.hurst}). Per-strategy hit rates on the Accuracy tab adjust the rule weights; the learned weights above are re-estimated on this chart every ${Math.max(2, Math.floor(p.horizon_bars / 2))} bars.</div>`;
    $('#learn-title').textContent = `Learning & prediction · ${p.symbol} ${p.interval}`;
    $('#learn-body').innerHTML = html;
    $('#learn').hidden = false;
  }

  // ------------------------------------------------------------ trade plan (level-based long trade, broker charges)
  const rs = (v, d = 2) => (v === null || v === undefined || Number.isNaN(v)) ? '—' : '₹' + Number(v).toLocaleString('en-IN', { maximumFractionDigits: d, minimumFractionDigits: d });
  function renderTradePlan(p) {
    const el = $('#trade-plan'), t = p.trade_plan;
    if (!t) { el.hidden = true; return; }
    el.hidden = false;
    if (!t.available) {
      el.className = 'trade-plan none';
      el.innerHTML = `<div class="tp-head"><span class="tp-verdict none">○ NO TRADE PLAN</span></div><div class="muted">${escapeHtml(t.reason || '')}</div>`;
      return;
    }
    const b = t.best, pr = b.prob || {}, chg = b.charges, long = t.side !== 'SELL';
    const cls = t.verdict === 'trade' ? 'go' : t.verdict === 'wait' ? 'wait' : 'none';
    const head = t.verdict === 'trade' ? (long ? '● BUY NOW' : '● SELL SHORT NOW') : t.verdict === 'wait' ? (long ? '◔ WAIT: BUY THE PULLBACK' : '◔ WAIT: SELL THE BOUNCE') : '○ NO TRADE';
    const same = (o) => o.mode === b.mode && o.target === b.target;
    const lines = [['Brokerage (2 orders)', chg.buy.brokerage + chg.sell.brokerage], ['STT', chg.buy.stt + chg.sell.stt], ['Stamp duty', chg.buy.stamp + chg.sell.stamp],
      ['Exchange + SEBI + IPFT', chg.buy.exchange + chg.sell.exchange + chg.buy.sebi + chg.sell.sebi + chg.buy.ipft + chg.sell.ipft], ['GST', chg.buy.gst + chg.sell.gst],
      ['DP charge (delivery sell)', chg.sell.dp + chg.buy.dp], ['Slippage (model)', chg.buy.slippage + chg.sell.slippage]];
    el.className = 'trade-plan ' + cls;
    el.innerHTML = `
      <div class="tp-head"><span class="tp-verdict ${cls}">${head}</span><span class="muted">${b.mode} · exit by ${b.deadline_label}</span></div>
      ${t.reasons.length ? `<div class="tp-reasons">${t.reasons.map((r) => `<div>• ${escapeHtml(r)}</div>`).join('')}</div>` : ''}
      <div class="tp-grid">
        <div class="kv"><span class="k">${long ? 'Buy' : 'Sell'} ${t.entry_type === 'market' ? 'at market' : 'limit'}</span><span class="v">${rs(t.entry)} <span class="muted">${escapeHtml(t.level_name)}</span></span></div>
        <div class="kv"><span class="k">Stop</span><span class="v down">${rs(t.stop)}</span></div>
        <div class="kv"><span class="k">Target</span><span class="v up">${rs(b.target)} <span class="muted">${escapeHtml(b.target_name)}</span></span></div>
        <div class="kv"><span class="k">Qty</span><span class="v">${t.qty_affordable} <span class="muted">= ${rs(t.value, 0)}</span></span></div>
        <div class="kv"><span class="k">Charges</span><span class="v">${rs(chg.total)} <span class="muted">${chg.pct_of_value}%</span></span></div>
        <div class="kv"><span class="k">Expected net</span><span class="v ${b.expectancy > 0 ? 'up' : 'down'}">${b.expectancy == null ? '—' : rs(b.expectancy)} <span class="muted">R:R ${b.rr}</span></span></div>
      </div>
      <details class="tp-details"><summary>Charges, probabilities, other exits, levels</summary>
        <table class="learn-table"><tbody>${lines.map(([k, v]) => `<tr><td>${k}</td><td class="num">${rs(v)}</td></tr>`).join('')}<tr><td><b>Total round trip</b></td><td class="num"><b>${rs(chg.total)}</b> (break-even ${b.breakeven_pct}%)</td></tr></tbody></table>
        <div style="margin:6px 0">Net if target / stop: <span class="up">${rs(b.net_win, 0)}</span> / <span class="down">${rs(b.net_loss, 0)}</span> · P(target / stop / time-out): ${pr.target != null ? `${pct(pr.target, 0)} / ${pct(pr.stop, 0)} / ${pct(pr.time, 0)}` : '—'} · risk ${rs(t.risk_rupees, 0)} of ${rs(t.risk_budget, 0)} budget · cash ${rs(t.cash, 0)}</div>
        <table class="learn-table"><thead><tr><th>Exit</th><th>Target</th><th class="num">Charges</th><th class="num">P(target)</th><th class="num">Expected net</th></tr></thead><tbody>${t.options.map((o) => `<tr class="${same(o) ? 'here' : ''}"><td>${o.mode} · ${o.deadline_label}</td><td>${escapeHtml(o.target_name)} ${fmt(o.target)}</td><td class="num">${rs(o.charges.total)}</td><td class="num">${o.prob && o.prob.target != null ? pct(o.prob.target, 0) : '—'}</td><td class="num">${o.expectancy == null ? '—' : rs(o.expectancy)}</td></tr>`).join('')}</tbody></table>
        <div class="muted" style="margin-top:6px">Supports: ${t.supports.map(([n, v]) => `${n} ${fmt(v)}`).join(' · ')}<br>Resistances: ${t.resistances.map(([n, v]) => `${n} ${fmt(v)}`).join(' · ')}<br>Probabilities: how often a ${long ? '+' : '−'}${(Math.abs(b.target / t.entry - 1) * 100).toFixed(2)}% / ${long ? '−' : '+'}${(t.risk_per_share / t.entry * 100).toFixed(2)}% trade started from a random past bar of this chart hit the target first, the stop first, or neither within ${b.bars} bars (${pr.n || 0} bars${pr.tilted ? ', tilted by the calibrated forecast' : ''}).</div>
      </details>
      <div class="tp-actions"><button class="btn small primary" id="btn-paper-buy" ${t.qty_affordable < 1 ? 'disabled' : ''}>Use in order ticket ↑</button> <span class="muted" id="tp-msg"></span></div>`;
    $('#btn-paper-buy').addEventListener('click', () => { tkFromPlan(); window.scrollTo({ top: 0, behavior: 'smooth' }); });
  }

  // ------------------------------------------------------------ walk-forward learner box
  const EVIDENCE_LABEL = { strong: 'strong (beats the drift)', weak: 'weak (probably beats the drift)', drift: 'drift only (follows the prevailing trend)', none: 'none (no validated edge)' };
  function renderEdge(p) {
    const el = $('#pred-edge'), L = p.summary.learner;
    if (!L) { el.hidden = true; return; }
    el.hidden = false;
    if (!L.available) {
      el.className = 'pred-edge none';
      el.innerHTML = `<b>Rule ensemble only.</b> ${escapeHtml(L.reason || 'Not enough history to validate a model walk-forward on this chart.')} P(up) comes from the weighted strategy votes; a direction is called beyond ${pct(p.summary.threshold, 0)}.`;
      return;
    }
    const t = L.tier || {}, thr = L.threshold;
    const tiers = (L.tiers || []).filter((x) => x.accuracy !== null && x.n > 0).map((x) => `≥${x.threshold.toFixed(2)}: ${pct(x.accuracy, 0)} (${x.n})`).join(' · ');
    const learners = Object.entries(L.learners || {}).map(([k, v]) => `${k.replace(/_/g, ' ')} ${pct(v.accuracy, 0)}`).join(', ');
    el.className = 'pred-edge ' + (L.evidence || 'none');
    if (p.direction === 'SIDEWAYS') {
      el.innerHTML = `<b>No call.</b> Calibrated P(up) ${pct(p.prob_up, 0)} is inside the no-edge zone (a call needs ≥ ${pct(thr, 0)} or ≤ ${pct(1 - thr, 0)}). ${L.validated ? `On this chart, calls at ≥ ${pct(thr, 0)} strength were right ${pct((L.tiers.find((x) => x.threshold === thr) || {}).accuracy, 0)} of the time out-of-sample.` : 'No strength level reached 55% out-of-sample accuracy here, so only very strong readings would be called.'}
        <div class="tiers">Walk-forward on ${L.n_rows} bars, ${L.folds} folds · overall ${pct(L.accuracy, 0)} vs ${pct(L.base_rate, 0)} by always calling the drift · by strength: ${tiers}<br>Learners: ${learners}</div>`;
    } else {
      el.innerHTML = `<b>${p.direction} call.</b> Out-of-sample, calls at least this strong were right <b>${pct(t.accuracy, 0)}</b> of the time on this chart (${t.n} bars, ${pct(t.coverage, 0)} of history; ≈${L.effective_n} independent outcomes). Evidence: <b>${EVIDENCE_LABEL[L.evidence] || L.evidence}</b>${L.evidence === 'drift' ? ` - the market closed ${p.direction === 'UP' ? 'higher' : 'lower'} in ${pct(p.direction === 'UP' ? L.up_rate : 1 - L.up_rate, 0)} of these windows anyway.` : '.'}
        <div class="tiers">Walk-forward on ${L.n_rows} bars, ${L.folds} folds · overall ${pct(L.accuracy, 0)} vs ${pct(L.base_rate, 0)} by always calling the drift · by strength: ${tiers}<br>Learners: ${learners}</div>`;
    }
  }

  // ------------------------------------------------------------ prediction card
  function renderPrediction(p) {
    state.prediction = p;
    $('#pred-empty').hidden = true; $('#pred-body').hidden = false;
    const dir = $('#pred-dir'); dir.textContent = p.direction === 'UP' ? '▲ UP' : p.direction === 'DOWN' ? '▼ DOWN' : '◆ NO CALL'; dir.className = 'pred-dir ' + p.direction;
    $('#pred-symbol').textContent = `${p.symbol} · ${p.interval}`;
    $('#pred-horizon').textContent = `next ${p.horizon_bars} × ${p.interval} bars · from ${whenBar(p.bar_time, p.interval)}`;
    const lc = lastCandle(); state.live.analysisBar = lc ? lc.time : null; state.live.barClosed = false;
    if (p.next_bar) {
      const nb = p.next_bar, cls = nb.direction === 'UP' ? 'up' : nb.direction === 'DOWN' ? 'down' : 'flat';
      const stamp = isDailyPlus(p.interval) ? new Date(nb.time * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' }) : new Date(nb.time * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
      const which = p.last_bar_forming ? `Current candle (${stamp})` : 'Next candle';
      $('#next-bar').innerHTML = `<b class="${cls}">${which}: ${nb.direction === 'UP' ? '▲ likely up' : nb.direction === 'DOWN' ? '▼ likely down' : '◆ no directional call'}</b> (P(up) ${pct(nb.prob_up, 0)})<br>Expected close ≈ ${fmt(nb.expected_close)}, 80% range ${fmt(nb.range_low)} – ${fmt(nb.range_high)}<br><span class="muted">Full period: ${p.direction === 'SIDEWAYS' ? 'no call - stand aside' : p.direction + ' to ' + fmt(p.target_price)} over ${p.horizon_bars} bars. Dashed line on the chart shows the projected path.</span>`;
    }
    renderEdge(p);
    renderTradePlan(p);
    const fill = $('#prob-fill'); fill.style.setProperty('--w', `${(p.prob_up * 100).toFixed(1)}%`); fill.style.setProperty('--c', p.direction === 'UP' ? '#1fdc6a' : p.direction === 'DOWN' ? '#ff4d4f' : '#f0b429');
    $('#prob-label').textContent = `P(up) ${pct(p.prob_up)} · P(down) ${pct(1 - p.prob_up)}`;
    const L = p.summary.learner || {}, tier = L.tier;
    $('#pred-wf').textContent = p.direction === 'SIDEWAYS' ? 'no call' : (p.summary.expected_accuracy != null ? `${pct(p.summary.expected_accuracy, 0)} right (${tier ? tier.n : '?'} bars)` : 'not validated');
    const evEl = $('#pred-evidence'); evEl.textContent = L.available ? ({ strong: 'strong edge', weak: 'weak edge', drift: 'drift only', none: 'no edge' }[L.evidence] || L.evidence) : 'rules only'; evEl.className = 'muted ev-' + (L.evidence || 'none'); evEl.title = EVIDENCE_LABEL[L.evidence] || '';
    $('#pred-conf').textContent = pct(p.confidence, 0);
    $('#pred-agree').textContent = `${p.summary.agreeing} / ${p.summary.voters} voters (${pct(p.summary.agreement, 0)})`;
    $('#pred-entry').textContent = fmt(p.price_at);
    updateNow(state.live.tick && Date.now() - state.live.lastTickAt < 120000 ? state.live.tick.price : (lastCandle() ? lastCandle().close : p.price_at));
    $('#pred-target').textContent = p.direction === 'SIDEWAYS' ? '— (no call)' : `${fmt(p.target_price)} (${p.direction === 'UP' ? '+' : '-'}${p.expected_move_pct.toFixed(2)}%)`;
    $('#pred-stop').textContent = p.stop_price ? fmt(p.stop_price) : '—';
    $('#pred-rr').textContent = p.summary.risk_reward ? `1 : ${p.summary.risk_reward}` : '—';
    $('#pred-move').textContent = `${p.expected_move_pct.toFixed(2)}% (ATR ${fmt(p.summary.atr)})`;
    $('#pred-expires').textContent = when(p.expires_at);
    $('#pred-regime').textContent = `${p.summary.regime || '—'} (Hurst ${p.summary.hurst})`;
    $('#pred-scores').textContent = `${p.summary.bull_score} / ${p.summary.bear_score}`;
    $('#pred-id').textContent = p.id ? `saved as #${p.id}${p.source && p.source !== 'live' ? ` (${p.source})` : ''}` : 'not saved yet';
    $('#btn-save-now').hidden = !!p.id;
    $('#btn-feedback-now').hidden = !p.id;
    const ev = $('#pred-eval');
    if (p.evaluation && p.evaluation.outcome) {
      const e = p.evaluation;
      ev.className = 'pred-eval ' + e.outcome; ev.hidden = false;
      ev.innerHTML = `<b>As-of test result: ${e.outcome.toUpperCase()}</b><br>Market went ${e.actual_move_pct >= 0 ? '+' : ''}${e.actual_move_pct.toFixed(2)}% to ${fmt(e.resolved_price)} over the next ${p.horizon_bars} bars. This result already updated the strategy accuracy stats; you can still override it with feedback.`;
    } else if (p.evaluation && p.evaluation.error) {
      ev.className = 'pred-eval'; ev.hidden = false; ev.textContent = `Could not grade: ${p.evaluation.error}`;
    } else if (p.source === 'asof') {
      ev.className = 'pred-eval'; ev.hidden = false; ev.textContent = 'Not enough bars after this date yet to grade the call.';
    } else { ev.hidden = true; }
    const cats = p.summary.categories, maxv = Math.max(1e-9, ...Object.values(cats).map((c) => c.bull + c.bear));
    $('#cat-bars').innerHTML = Object.entries(cats).filter(([k]) => k !== 'regime' && k !== 'error').map(([k, c]) => `
      <div class="cat-row"><span>${CAT_LABEL[k] || k}</span><div class="cat-track"><i class="bull" style="width:${(c.bull / maxv * 100).toFixed(1)}%"></i><i class="bear" style="width:${(c.bear / maxv * 100).toFixed(1)}%"></i></div></div>`).join('');
    renderSignals(p.signals); renderIndicators(p); renderLevels($('[data-overlay=levels]').checked);
  }

  // ------------------------------------------------------------ signals table
  function voteHtml(d, conf) { return d > 0 ? '<span class="vote up">▲ UP</span>' : d < 0 ? '<span class="vote down">▼ DOWN</span>' : '<span class="vote flat">– NEUTRAL</span>'; }
  function callHtml(direction) { return direction === 'UP' ? voteHtml(1) : direction === 'DOWN' ? voteHtml(-1) : '<span class="vote flat">◆ NO CALL</span>'; }
  function learnedHtml(w) { if (w === undefined || w === null) return '<span class="muted">—</span>'; return `<span class="lw ${w > 0.05 ? 'pos' : w < -0.05 ? 'neg' : ''}">${w > 0 ? '+' : ''}${w.toFixed(2)}</span>`; }
  function trackRecord(h) {
    if (!h) return '<span class="muted">no history yet</span>';
    const n = h.correct + h.incorrect; if (!n) return '<span class="muted">no history yet</span>';
    const acc = h.correct / n;
    return `<span class="acc-bar"><i style="width:${(acc * 100).toFixed(0)}%;background:${acc >= 0.55 ? '#1fdc6a' : acc <= 0.45 ? '#ff4d4f' : '#f0b429'}"></i></span>${(acc * 100).toFixed(0)}% <span class="muted">(${n})</span>`;
  }
  function renderSignals(signals) {
    const filter = $('#signal-filter').value;
    const rows = signals.filter((s) => !filter || s.category === filter).sort((a, b) => b.contribution - a.contribution);
    $('#signals-table tbody').innerHTML = rows.map((s, i) => `
      <tr class="clickable" data-idx="${signals.indexOf(s)}">
        <td><b>${s.name}</b><div class="muted" style="font-size:11px">${s.origin}</div></td>
        <td><span class="badge">${CAT_LABEL[s.category] || s.category}</span></td>
        <td>${voteHtml(s.direction)}</td>
        <td><span class="conf-bar"><i style="width:${(s.confidence * 100).toFixed(0)}%"></i></span>${(s.confidence * 100).toFixed(0)}%</td>
        <td title="base ${s.base_weight} × regime ${s.regime_mult} × track record ${s.adaptive_mult}">${s.counts_in_rule_score === false ? '<span class="muted">final layer</span>' : s.weight}</td>
        <td>${learnedHtml(s.learned_weight)}</td>
        <td>${trackRecord(s.history)}</td>
        <td>${s.reason}</td>
      </tr>`).join('') || '<tr><td colspan="8" class="muted">No signals in this category.</td></tr>';
    $$('#signals-table tbody tr.clickable').forEach((tr) => tr.addEventListener('click', () => showSignalDetail(signals[+tr.dataset.idx])));
  }
  function showSignalDetail(s) {
    $('#detail-title').textContent = s.name;
    $('#detail-body').innerHTML = `
      <p><b>Origin:</b> ${s.origin}</p>
      <p><b>Rules:</b> ${s.rules}</p>
      <p><b>Vote:</b> ${voteHtml(s.direction)} confidence ${(s.confidence * 100).toFixed(0)}% · ${s.counts_in_rule_score === false ? 'final layer (walk-forward learner, not a rule vote)' : `weight ${s.weight} (base ${s.base_weight} × regime ${s.regime_mult} × track record ${s.adaptive_mult}) · contribution ${s.contribution}`}</p>
      ${s.learned_weight !== undefined ? `<p><b>Learned weight on this chart:</b> ${learnedHtml(s.learned_weight)} <span class="muted">(standardised coefficient in the stacked model; negative = contrarian here)</span></p>` : ''}
      <p><b>Reason:</b> ${s.reason}</p>
      <p><b>Track record:</b> ${trackRecord(s.history)}</p>
      <p><b>Values:</b></p><pre>${JSON.stringify(s.values, null, 2)}</pre>`;
    $('#detail').hidden = false;
  }

  // ------------------------------------------------------------ indicators tab
  function renderIndicators(p) {
    const ind = p.indicators;
    $('#ind-grid').innerHTML = Object.entries(ind).map(([k, v]) => `<div class="ind"><div class="k">${k}</div><div class="v">${v === null ? '—' : fmt(v, Math.abs(v) > 1000 ? 0 : 3)}</div></div>`).join('');
    const pv = p.summary.pivots, fib = p.summary.fibonacci;
    $('#levels-grid').innerHTML = `
      <div class="card"><h3 style="margin-top:0">Pivot points (classic)</h3><table>${['r3', 'r2', 'r1', 'pivot', 's1', 's2', 's3'].map((k) => `<tr><td>${k.toUpperCase()}</td><td style="text-align:right">${fmt(pv[k])}</td></tr>`).join('')}</table></div>
      <div class="card"><h3 style="margin-top:0">Fibonacci retracement (${fib.up_swing ? 'up' : 'down'}-swing ${fmt(fib.low)} → ${fmt(fib.high)})</h3><table>${Object.entries(fib.levels).map(([r, v]) => `<tr><td>${(parseFloat(r) * 100).toFixed(1)}%</td><td style="text-align:right">${fmt(v)}</td></tr>`).join('')}</table></div>
      ${p.summary.cpr ? `<div class="card"><h3 style="margin-top:0">CPR &amp; Camarilla <span class="muted">(previous ${pv.ref_time && pv.ref_time.length <= 10 ? 'session' : 'bar'}${pv.ref_time ? ' ' + pv.ref_time.slice(0, 10) : ''})</span></h3><table>
        <tr><td>CPR top (TC)</td><td style="text-align:right">${fmt(p.summary.cpr.tc)}</td></tr><tr><td>CPR bottom (BC)</td><td style="text-align:right">${fmt(p.summary.cpr.bc)}</td></tr>
        <tr><td>CPR width</td><td style="text-align:right">${p.summary.cpr.width_pct.toFixed(2)}%${p.summary.cpr.narrow ? ' (narrow)' : ''}</td></tr>
        ${['h4', 'h3', 'l3', 'l4'].map((k) => `<tr><td>Camarilla ${k.toUpperCase()}</td><td style="text-align:right">${fmt(p.summary.camarilla[k])}</td></tr>`).join('')}</table></div>` : ''}`;
  }

  // ------------------------------------------------------------ history tab
  function outcomeBadge(o) {
    if (!o) return '<span class="badge">pending</span>';
    if (o === 'no_call') return '<span class="badge nc" title="The system stood aside (no validated edge); not counted in accuracy">no call</span>';
    return `<span class="badge ${o === 'correct' ? 'ok' : o === 'partial' ? 'mid' : 'bad'}">${o}</span>`;
  }
  async function loadHistory() {
    const sym = $('#hist-symbol').value.trim(), st = $('#hist-status').value, src = $('#hist-source').value;
    const rows = await api(`/api/predictions?limit=200${sym ? '&symbol=' + encodeURIComponent(sym) : ''}${st ? '&status=' + st : ''}${src ? '&source=' + src : ''}`);
    $('#history-table tbody').innerHTML = rows.map((r) => `
      <tr>
        <td>${r.id}</td><td>${when(r.created_at)}${r.source && r.source !== 'live' ? `<div><span class="badge">${r.source}</span></div>` : ''}</td><td><b>${r.symbol}</b></td><td>${r.interval} / ${r.horizon_bars}</td>
        <td>${callHtml(r.direction)}</td>
        <td>${pct(r.prob_up, 0)}</td>
        <td>${fmt(r.price_at)} → ${r.direction === 'SIDEWAYS' ? 'no call' : fmt(r.target_price)}${r.resolved_price ? `<div class="muted" style="font-size:11px">closed ${fmt(r.resolved_price)} (${r.actual_move_pct >= 0 ? '+' : ''}${r.actual_move_pct.toFixed(2)}%)</div>` : ''}</td>
        <td>${r.auto_outcome ? `system: ${outcomeBadge(r.auto_outcome)}` : '<span class="badge">awaiting bars</span>'}</td>
        <td>${r.user_verdict ? outcomeBadge(r.user_verdict) + (r.user_rating ? ` <span class="muted">${'★'.repeat(r.user_rating)}</span>` : '') : '<span class="muted">—</span>'}${r.user_note ? `<div class="muted" style="font-size:11px">${escapeHtml(r.user_note)}</div>` : ''}</td>
        <td style="white-space:nowrap"><button class="btn small" data-fb="${r.id}">Review</button> <button class="btn small" data-view="${r.id}">View</button> <button class="btn small" data-del="${r.id}" title="delete">✕</button></td>
      </tr>`).join('') || '<tr><td colspan="10" class="muted">No predictions yet.</td></tr>';
    $$('[data-fb]').forEach((b) => b.addEventListener('click', () => openFeedback(+b.dataset.fb)));
    $$('[data-view]').forEach((b) => b.addEventListener('click', () => viewPrediction(+b.dataset.view)));
    $$('[data-del]').forEach((b) => b.addEventListener('click', async () => { if (confirm(`Delete prediction #${b.dataset.del}?`)) { await api(`/api/predictions/${b.dataset.del}`, { method: 'DELETE' }); loadHistory(); loadStats(); } }));
  }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  async function viewPrediction(id) {
    const p = await api(`/api/predictions/${id}`);
    $('#detail-title').textContent = `Prediction #${id} · ${p.symbol} ${p.direction}`;
    const top = p.signals.filter((s) => s.direction !== 0).sort((a, b) => b.contribution - a.contribution).slice(0, 12);
    $('#detail-body').innerHTML = `
      <p>${when(p.created_at)} · ${p.interval} · ${p.horizon_bars} bars · entry ${fmt(p.price_at)} → ${p.direction === 'SIDEWAYS' ? 'no call' : 'target ' + fmt(p.target_price)} · P(up) ${pct(p.prob_up)} · confidence ${pct(p.confidence, 0)}${p.summary && p.summary.expected_accuracy != null ? ` · validated accuracy ${pct(p.summary.expected_accuracy, 0)} (${(p.summary.learner || {}).evidence || ''})` : ''}</p>
      <p>System outcome: ${outcomeBadge(p.auto_outcome)} ${p.resolved_price ? `closed at ${fmt(p.resolved_price)} (${p.actual_move_pct.toFixed(2)}%)` : ''} · Your verdict: ${outcomeBadge(p.user_verdict)}</p>
      <h3>Strongest votes at the time</h3>
      <table class="table">${top.map((s) => `<tr><td><b>${s.name}</b></td><td>${voteHtml(s.direction)}</td><td>${(s.confidence * 100).toFixed(0)}%</td><td>${s.reason}</td></tr>`).join('')}</table>
      ${p.feedback.length ? `<h3>Feedback</h3>${p.feedback.map((f) => `<div class="fb-item">${when(f.created_at)} · ${outcomeBadge(f.verdict)} ${f.rating ? '★'.repeat(f.rating) : ''} ${f.note ? '— ' + escapeHtml(f.note) : ''}</div>`).join('')}` : ''}
      <p style="margin-top:12px"><button class="btn small" id="detail-learn">🧠 Learning &amp; prediction</button> <button class="btn small" id="detail-fb">Give feedback</button></p>`;
    $('#detail-learn').addEventListener('click', () => openLearning(p));
    $('#detail-fb').addEventListener('click', () => { $('#detail').hidden = true; openFeedback(id); });
    $('#detail').hidden = false;
  }

  // ------------------------------------------------------------ feedback modal
  const fb = { verdict: null, rating: 0 };
  async function openFeedback(id) {
    const p = await api(`/api/predictions/${id}`);
    state.feedbackTarget = p;
    fb.verdict = null; fb.rating = 0;
    $('#modal-title').textContent = `#${id}`;
    $('#modal-summary').innerHTML = `<b>${p.symbol}</b> ${p.interval} · called <b>${p.direction === 'SIDEWAYS' ? 'NO CALL' : p.direction}</b> at ${fmt(p.price_at)} on ${when(p.created_at)} for the next ${p.horizon_bars} bars${p.direction === 'SIDEWAYS' ? '' : ` (target ${fmt(p.target_price)})`}.${p.auto_outcome ? ` System graded it <b>${p.auto_outcome}</b>${p.resolved_price ? ` (closed ${fmt(p.resolved_price)}, ${p.actual_move_pct.toFixed(2)}%)` : ''}.` : ' Not yet auto-graded.'}`;
    $$('.verdict').forEach((b) => b.classList.remove('active'));
    $$('#stars span[data-star]').forEach((s) => s.classList.remove('lit'));
    $('#star-label').textContent = 'rate usefulness';
    $('#fb-note').value = p.user_note || '';
    $('#modal-save').disabled = true;
    $('#modal').hidden = false;
  }
  $$('.verdict').forEach((b) => b.addEventListener('click', () => { $$('.verdict').forEach((x) => x.classList.remove('active')); b.classList.add('active'); fb.verdict = b.dataset.verdict; $('#modal-save').disabled = false; }));
  $$('#stars span[data-star]').forEach((s) => s.addEventListener('click', () => { fb.rating = +s.dataset.star; $$('#stars span[data-star]').forEach((x) => x.classList.toggle('lit', +x.dataset.star <= fb.rating)); $('#star-label').textContent = ['', 'useless', 'weak', 'okay', 'good', 'excellent'][fb.rating]; }));
  $('#modal-close').addEventListener('click', () => $('#modal').hidden = true);
  $('#modal-cancel').addEventListener('click', () => $('#modal').hidden = true);
  $('#modal-save').addEventListener('click', async () => {
    const p = state.feedbackTarget; if (!p || !fb.verdict) return;
    try {
      await api(`/api/predictions/${p.id}/feedback`, { method: 'POST', body: JSON.stringify({ verdict: fb.verdict, rating: fb.rating || null, note: $('#fb-note').value.trim() || null }) });
      $('#modal').hidden = true; status(`Feedback saved for #${p.id}. Strategy weights updated.`, 'info'); setTimeout(() => status(null), 3000);
      loadHistory(); loadStats();
    } catch (e) { status(e.message); }
  });
  $('#btn-feedback-now').addEventListener('click', () => { if (state.prediction && state.prediction.id) openFeedback(state.prediction.id); });
  $('#btn-learn').addEventListener('click', () => { if (state.prediction) openLearning(state.prediction); });
  $('#learn-close').addEventListener('click', () => $('#learn').hidden = true);
  $('#learn').addEventListener('click', (e) => { if (e.target === $('#learn')) $('#learn').hidden = true; });
  $('#detail-close').addEventListener('click', () => $('#detail').hidden = true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { $('#modal').hidden = true; $('#detail').hidden = true; $('#learn').hidden = true; $('#suggest').hidden = true; closePops(); closeDrawer(); } });

  // ------------------------------------------------------------ accuracy tab
  async function loadStats() {
    const s = await api('/api/stats'); const o = s.overall;
    const tile = (k, v) => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div></div>`;
    $('#stat-tiles').innerHTML = tile('Predictions', o.total_predictions) + tile('Calls evaluated', o.evaluated) + tile('No call', o.no_call || 0) + tile('Pending', o.pending) +
      tile('Accuracy of calls', o.accuracy === null ? '—' : pct(o.accuracy, 1)) + tile('Correct / Partial / Wrong', `${o.correct} / ${o.partial} / ${o.incorrect}`) +
      tile('With your feedback', o.with_user_feedback) + tile('Avg rating', o.avg_user_rating ? o.avg_user_rating.toFixed(1) + ' ★' : '—') +
      Object.entries(o.by_direction).filter(([d]) => d !== 'SIDEWAYS').map(([d, b]) => tile(`${d} calls`, `${b.correct}✔ ${b.partial}~ ${b.incorrect}✘`)).join('');
    $('#strategy-stats-table tbody').innerHTML = s.strategies.map((r) => `
      <tr><td><b>${r.name}</b></td><td><span class="badge">${CAT_LABEL[r.category] || r.category}</span></td><td>${r.evaluated}</td><td>${r.correct}</td><td>${r.incorrect}</td>
      <td>${r.accuracy === null ? '—' : `<span class="acc-bar"><i style="width:${(r.accuracy * 100).toFixed(0)}%;background:${r.accuracy >= 0.55 ? '#1fdc6a' : r.accuracy <= 0.45 ? '#ff4d4f' : '#f0b429'}"></i></span>${pct(r.accuracy, 0)}`}</td>
      <td>${r.adaptive_mult}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">No evaluated predictions yet. Give feedback or wait for the auto-evaluator.</td></tr>';
    $('#recent-feedback').innerHTML = s.recent_feedback.map((f) => `<div class="fb-item">${when(f.created_at)} · <b>${f.symbol}</b> ${f.direction} · ${outcomeBadge(f.verdict)} ${f.rating ? '★'.repeat(f.rating) : ''} ${f.note ? '— ' + escapeHtml(f.note) : ''}</div>`).join('') || '<span class="muted">No feedback yet.</span>';
  }

  // ------------------------------------------------------------ guide tab
  async function loadGuide() {
    const rows = await api('/api/catalog'); state.catalog = rows;
    const names = {}; (state.prediction?.signals || []).forEach((s) => names[s.key] = s);
    $('#guide').innerHTML = rows.map((r) => {
      const s = names[r.key];
      const [first, ...rest] = r.doc.split('\n');
      return `<div class="g"><h4>${s ? s.name : r.key} <span class="badge">${r.kind}</span></h4>${s ? `<div class="origin">${s.origin}</div>` : ''}<p>${escapeHtml(first)}${rest.length ? '<br>' + escapeHtml(rest.join(' ')) : ''}</p>${s ? `<p style="margin-top:6px"><b>Rules:</b> ${s.rules}</p>` : ''}</div>`;
    }).join('');
  }

  // ------------------------------------------------------------ persisted UI options (survive page changes)
  const ui = Object.assign({ live: true, pane: 'rsi', overlays: null, details: false, product: 'intraday', type: 'market' }, JSON.parse(localStorage.getItem('tb.ui') || '{}'));
  function saveUi() { try { localStorage.setItem('tb.ui', JSON.stringify(ui)); } catch {} }
  function applyUi() {
    if (ui.overlays) $$('#overlay-toggles input').forEach((cb) => { if (cb.dataset.overlay in ui.overlays) cb.checked = !!ui.overlays[cb.dataset.overlay]; });
    if (ui.pane) { $$('.pane-tab').forEach((x) => x.classList.toggle('active', x.dataset.pane === ui.pane)); state.paneKind = ui.pane; }
    $('#pred-more').hidden = !ui.details; $('#pred-more-btn').textContent = ui.details ? 'Details ▴' : 'Details ▾';
    tk.product = ui.product || 'intraday'; tk.type = ui.type || 'market'; tkSeg('tk-product', tk.product); tkSeg('tk-type', tk.type); tkFields();
  }

  // ------------------------------------------------------------ tabs: one per symbol + timeframe, each keeping its last call
  const MAX_TABS = 8, FRESH_MS = 90000;
  const defaultHorizon = (iv) => ({ '1m': 30, '5m': 24, '15m': 16, '30m': 14, '1h': 12, '1d': 10, '1wk': 6 })[iv] || 10;
  const baseSym = (s) => String(s || '').trim().toUpperCase().replace(/\.(NS|BO)$/, '');
  function saveTabs() {
    const pack = (strip) => JSON.stringify({ active: state.activeTab, tabs: state.tabs.map((t) => ({ symbol: t.symbol, exchange: t.exchange, interval: t.interval, horizon: t.horizon, updatedAt: t.updatedAt, prediction: strip ? null : t.prediction })) });
    try { localStorage.setItem('tb.tabs', pack(false)); } catch { try { localStorage.setItem('tb.tabs', pack(true)); } catch {} }
  }
  function findTab(symbol, exchange, interval) {
    const b = baseSym(symbol);
    return state.tabs.findIndex((t) => t.interval === interval && t.exchange === exchange && (baseSym(t.symbol) === b || (t.prediction && baseSym(t.prediction.symbol) === b)));
  }
  function renderTabs() {
    const glyph = (p) => !p ? '' : p.direction === 'UP' ? '<span class="call up">▲</span>' : p.direction === 'DOWN' ? '<span class="call down">▼</span>' : '<span class="call flat">◆</span>';
    const tip = (t) => (t.prediction ? `${t.prediction.direction === 'SIDEWAYS' ? 'NO CALL' : t.prediction.direction} · P(up) ${pct(t.prediction.prob_up, 0)} · updated ${when(t.updatedAt)}` : 'not analysed yet') + (t.busy ? ' · analysing…' : t.queued ? ' · queued for analysis' : '');
    $('#tabstrip').innerHTML = state.tabs.map((t, i) => `<div class="stab ${i === state.activeTab ? 'active' : ''} ${t.busy ? 'busy' : t.queued ? 'queued' : ''}" data-i="${i}" title="${tip(t)}">${glyph(t.prediction)}<b>${baseSym(t.symbol)}</b><span class="muted">${t.interval}</span>${t.prediction ? `<span class="pu">${pct(t.prediction.prob_up, 0)}</span>` : ''}<button type="button" class="x" data-close="${i}" title="Close">×</button></div>`).join('')
      + `<button type="button" class="stab add" id="tab-add" title="Type a symbol in the box above and press Analyze to open it in a new tab">+</button>`;
    $$('#tabstrip .stab[data-i]').forEach((el) => el.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) return; activateTab(+el.dataset.i); }));
    $$('#tabstrip [data-close]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); closeTab(+b.dataset.close); }));
    $('#tab-add').addEventListener('click', () => { $('#symbol').select(); $('#symbol').focus(); });
  }
  function fillHeader(t) { $('#symbol').value = t.symbol; $('#exchange').value = t.exchange; $('#interval').value = t.interval; $('#horizon').value = t.horizon || defaultHorizon(t.interval); }
  let tabSeq = 0;
  const activeTab = () => state.tabs[state.activeTab] || null;
  function openTab(symbol, exchange, interval, horizon) {
    let i = findTab(symbol, exchange, interval);
    if (i < 0) {
      if (state.tabs.length >= MAX_TABS) {                          // drop the oldest tab that is not active
        const drop = state.tabs.findIndex((_, k) => k !== state.activeTab);
        dequeue(state.tabs[drop]); state.tabs.splice(drop, 1); if (state.activeTab > drop) state.activeTab -= 1;
      }
      state.tabs.push({ id: ++tabSeq, symbol: String(symbol).trim().toUpperCase(), exchange, interval, horizon: horizon || defaultHorizon(interval), prediction: null, updatedAt: null, busy: false, queued: false, failedAt: null });
      i = state.tabs.length - 1;
    } else if (horizon) state.tabs[i].horizon = horizon;
    state.activeTab = i; saveTabs(); renderTabs();
    return i;
  }
  // the call card for a tab without a call: nothing from the previous tab may linger (lines, forecast, "now" row)
  function showEmptyCard() { state.prediction = null; $('#pred-empty').hidden = false; $('#pred-body').hidden = true; $('#pred-now').hidden = true; renderLevels(false); }
  function closeTab(i) {
    const wasActive = i === state.activeTab;
    dequeue(state.tabs[i]); state.tabs.splice(i, 1);
    if (!state.tabs.length) { state.activeTab = -1; saveTabs(); renderTabs(); showEmptyCard(); return; }
    if (wasActive) activateTab(Math.min(i, state.tabs.length - 1));
    else { if (state.activeTab > i) state.activeTab -= 1; saveTabs(); renderTabs(); }
  }
  // message over the chart while it loads or when it could not load; a failed load retries on its own
  function chartMsg(text, error = false) { const el = $('#chart-msg'); el.hidden = !text; el.textContent = text || ''; el.className = 'chart-msg' + (error ? ' error' : ''); }
  let chartRetry = null, chartRetryDelay = 4000;
  const chartMatches = (t) => !!state.chartData && baseSym(state.chartData.symbol) === baseSym(t.symbol) && state.chartData.interval === t.interval;
  async function activateTab(i) {
    const t = state.tabs[i]; if (!t) return;
    state.activeTab = i; fillHeader(t); saveTabs(); renderTabs();
    clearTimeout(chartRetry);
    if (t.prediction) renderPrediction(t.prediction); else showEmptyCard();
    if (!chartMatches(t)) { $('#chart-title').textContent = `${baseSym(t.symbol)} · ${t.interval}`; chartMsg(`Loading ${baseSym(t.symbol)} ${t.interval}… (a scan on another page can hold the market-data feed for a few seconds)`); }
    let data = null;
    try { data = await loadChart(t.symbol, t.interval, t.exchange); } catch (e) {
      if (activeTab() !== t) return;
      chartMsg(`Chart could not load: ${e.message} · retrying in ${Math.round(chartRetryDelay / 1000)} s`, true);
      chartRetry = setTimeout(() => { if (activeTab() === t && !chartMatches(t)) activateTab(state.activeTab); }, chartRetryDelay);
      chartRetryDelay = Math.min(30000, chartRetryDelay * 2);
      return;
    }
    if (activeTab() !== t || !data) return;                          // the user moved on while the chart was loading
    chartMsg(null); chartRetryDelay = 4000;
    if (t.prediction) renderPrediction(t.prediction);               // re-sync levels and the bar the call was made on
    if (stale(t)) enqueue(t, true);
  }
  function storePrediction(t, pred) {
    if (!state.tabs.includes(t)) return;
    t.prediction = pred; t.updatedAt = new Date().toISOString(); t.symbol = pred.symbol; t.busy = false; t.failedAt = null;
    saveTabs(); renderTabs();
    if (activeTab() === t) renderPrediction(pred);
  }
  async function analyseTab(t, quiet = true) {
    if (!t || t.busy) return false;
    t.busy = true; t.queued = false; renderTabs();
    try {
      const tick = (activeTab() === t && state.live.tick && Date.now() - state.live.lastTickAt < 60000) ? state.live.tick : null;
      const pred = await api('/api/analyze', { method: 'POST', body: JSON.stringify({ symbol: t.symbol, exchange: t.exchange, interval: t.interval, horizon: t.horizon, save: false,
        live_price: tick ? tick.price : null, live_symbol: tick ? tick.symbol : null }) });
      storePrediction(t, pred);
      return true;
    } catch (e) { t.busy = false; t.failedAt = Date.now(); renderTabs(); if (!quiet) status(e.message); return false; }
  }

  // ------------------------------------------------------------ background analysis queue
  // Every open tab is analysed in the background, one at a time (the first run on a chart trains the model,
  // 20-40 s), the active tab first.  A tab is queued when the page opens, when it is stale on activation and,
  // with Auto on, whenever its own bar closes or its call is older than LIVE_MAX_SECONDS.
  const queue = [];
  let pumping = false;
  const BAR_SEC = { '1m': 60, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '1d': 86400, '1wk': 604800 };
  const stale = (t) => !t.prediction || !t.updatedAt || Date.now() - new Date(t.updatedAt).getTime() > FRESH_MS;
  function dequeue(t) { const k = queue.indexOf(t); if (k >= 0) queue.splice(k, 1); if (t) t.queued = false; }
  function enqueue(t, front = false) {
    if (!t || t.busy || t.queued || !state.tabs.includes(t)) return;
    t.queued = true; if (front) queue.unshift(t); else queue.push(t);
    renderTabs(); pump();
  }
  async function pump() {
    if (pumping) return; pumping = true;
    try {
      while (queue.length) {
        const ai = queue.indexOf(activeTab());
        const t = ai >= 0 ? queue.splice(ai, 1)[0] : queue.shift();   // the tab on screen always goes first
        t.queued = false;
        if (!state.tabs.includes(t) || t.busy) continue;
        const active = activeTab() === t;
        if (active && !t.prediction) status(`Analyzing ${baseSym(t.symbol)} ${t.interval}… the first run on a chart trains and validates the model (20-40 s); later runs take a second.`, 'info');
        const ok = await analyseTab(t, !active);
        if (ok && activeTab() === t) status(t.prediction && t.prediction.note ? t.prediction.note : null, 'info');
      }
    } finally { pumping = false; renderTabs(); }
  }
  // the bar the call was made on closes at bar_time + 2 bars (bar_time = last closed bar; the forming one is next);
  // daily / weekly bars close with the session and are covered by the LIVE_MAX_SECONDS refresh instead
  function nextClose(t) {
    const p = t.prediction; if (!p || !p.last_bar_forming) return null;
    const sec = BAR_SEC[p.interval] || 0; if (!sec || sec >= 86400) return null;
    return parseIso(p.bar_time).getTime() + 2 * sec * 1000;
  }
  function due(t, now) {
    if (t.busy || t.queued) return false;
    if (t.failedAt && now - t.failedAt < 30000) return false;          // back off after an error
    if (!t.prediction || !t.updatedAt) return true;
    const at = new Date(t.updatedAt).getTime();
    if (now - at > LIVE_MAX_SECONDS * 1000) return true;
    const nc = nextClose(t); if (nc && at < nc && now > nc + 2000) return true;
    return activeTab() === t && state.live.barClosed;
  }

  // ------------------------------------------------------------ analyze
  function currentParams() {
    const asOfRaw = $('#as-of').value;
    return {
      symbol: $('#symbol').value.trim(), exchange: $('#exchange').value, interval: $('#interval').value,
      horizon: +$('#horizon').value || null, as_of: asOfRaw ? new Date(asOfRaw).toISOString() : null,
    };
  }
  async function runAnalysis(e, save = true, reloadChartFirst = true) {
    if (e) e.preventDefault();
    const params = currentParams();
    if (!params.symbol) return;
    const i = openTab(params.symbol, params.exchange, params.interval, params.horizon);
    const tab = state.tabs[i]; dequeue(tab); tab.busy = true; renderTabs();
    const btn = $('#analyze-btn'); btn.disabled = true; btn.textContent = 'Analyzing…';
    if (!tab.prediction) status(`Analyzing ${params.symbol} ${params.interval}… the first run on a chart trains and validates the model (20-40 s); later runs take a second.`, 'info');
    try {
      const t = state.live.tick, fresh = t && Date.now() - state.live.lastTickAt < 60000 && state.chartData && t.symbol === (state.chartData.data_symbol || state.chartData.symbol);
      const useTick = fresh && !params.as_of;
      const body = { ...params, save, live_price: useTick ? t.price : null, live_symbol: useTick ? t.symbol : null };   // the server drops a tick from another chart
      const [, pred] = await Promise.all([
        reloadChartFirst ? loadChart(params.symbol, params.interval, params.exchange) : Promise.resolve(),
        api('/api/analyze', { method: 'POST', body: JSON.stringify(body) }),
      ]);
      if (activeTab() === tab && (!state.chartData || state.chartData.symbol !== pred.symbol || state.chartData.interval !== pred.interval)) await loadChart(params.symbol, params.interval, params.exchange);
      if (params.as_of) { tab.busy = false; renderTabs(); if (activeTab() === tab) renderPrediction(pred); status(`Analyzed ${pred.symbol} as of ${when(pred.bar_time)} using only data available then.`, 'info'); }
      else { storePrediction(tab, pred); status(pred.note || null, 'info'); }
      loadHistory(); loadStats();
    } catch (err) { tab.busy = false; tab.failedAt = Date.now(); renderTabs(); status(err.message); }
    btn.disabled = false; btn.textContent = 'Analyze';
  }
  $('#analyze-form').addEventListener('submit', (e) => runAnalysis(e, true));

  // ---- Auto: with it on, every open tab is re-analysed (unsaved) in the background whenever its own bar closes
  // and at least every LIVE_MAX_SECONDS, so entry / target / stop follow the live price on slow timeframes.
  let liveTimer = null;
  function setLive(on) {
    $('.live-toggle').classList.toggle('on', on); $('#live').checked = on;
    ui.live = on; saveUi();
    clearInterval(liveTimer); liveTimer = null; $('#live-countdown').textContent = '';
    if (!on) return;
    if ($('#as-of').value) { $('#as-of').value = ''; }
    liveTimer = setInterval(() => {
      const now = Date.now();
      state.tabs.forEach((t) => { if (due(t, now)) enqueue(t, activeTab() === t); });
      const a = activeTab(), el = $('#live-countdown');
      if (!a) el.textContent = '';
      else if (a.busy) el.textContent = state.live.barClosed ? 'bar closed · updating…' : 'updating…';
      else if (a.queued) el.textContent = 'queued…';
      else if (!a.updatedAt) el.textContent = '';
      else {
        const nc = nextClose(a), untilBar = nc ? Math.ceil((nc - now) / 1000) : Infinity;
        el.textContent = `${Math.max(0, Math.min(Math.ceil(LIVE_MAX_SECONDS - (now - new Date(a.updatedAt).getTime()) / 1000), untilBar))}s`;
      }
    }, 1000);
  }
  $('#live').addEventListener('change', () => setLive($('#live').checked));
  $('#as-of').addEventListener('change', () => { if ($('#as-of').value && $('#live').checked) { setLive(false); } });
  $('#btn-save-now').addEventListener('click', async () => {
    // re-run with save=true so the stored prediction matches the latest bar
    await runAnalysis(null, true);
  });
  $('#backtest-btn').addEventListener('click', async () => {
    const params = currentParams(); const steps = +$('#bt-steps').value || 10;
    if (!params.symbol) return;
    const btn = $('#backtest-btn'); btn.disabled = true; btn.textContent = `Testing ${steps} points…`;
    status(`Running backtest: ${steps} historical predictions on ${params.symbol} ${params.interval}, horizon ${params.horizon || 'default'} bars. The model is retrained at each point using only the data available then, so allow 5-15 s per point.`, 'info');
    try {
      const r = await api('/api/backtest', { method: 'POST', body: JSON.stringify({ symbol: params.symbol, exchange: params.exchange, interval: params.interval, horizon: params.horizon, steps, save: true }) });
      const dirs = Object.entries(r.by_direction).filter(([d]) => d !== 'SIDEWAYS').map(([d, b]) => `${d} ${b.correct}✔/${b.incorrect}✘`).join(', ');
      status(`Backtest ${r.symbol} ${r.interval}: ${r.calls} calls on ${r.steps} points, ${r.correct} correct (${r.accuracy === null ? '—' : pct(r.accuracy, 0)}) — ${dirs}; ${r.no_call} no-call. Results are in History (source: backtest) and the Accuracy tab; strategy weights have been updated.`, 'info');
      openDrawer('history');
      loadStats();
    } catch (err) { status(err.message); }
    btn.disabled = false; btn.textContent = 'Backtest';
  });
  $('#interval').addEventListener('change', () => { $('#horizon').value = defaultHorizon($('#interval').value); });

  // symbol search
  let searchTimer = null;
  $('#symbol').addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = $('#symbol').value.trim();
    if (q.length < 2) { $('#suggest').hidden = true; return; }
    searchTimer = setTimeout(async () => {
      try {
        const hits = await api(`/api/search?q=${encodeURIComponent(q)}`);
        if (!hits.length) { $('#suggest').hidden = true; return; }
        $('#suggest').innerHTML = hits.map((h) => `<div data-sym="${h.symbol}" data-ex="${h.exchange}"><span class="sym">${h.symbol}</span><span class="muted">${escapeHtml(h.name)} · ${h.exchange}</span></div>`).join('');
        $$('#suggest div').forEach((d) => d.addEventListener('mousedown', () => { $('#symbol').value = d.dataset.sym; if (d.dataset.ex === 'NSE' || d.dataset.ex === 'BSE') $('#exchange').value = d.dataset.ex; $('#suggest').hidden = true; }));
        $('#suggest').hidden = false;
      } catch { $('#suggest').hidden = true; }
    }, 300);
  });
  $('#symbol').addEventListener('blur', () => setTimeout(() => $('#suggest').hidden = true, 150));

  // overlays / panes / tabs
  $$('#overlay-toggles input').forEach((cb) => cb.addEventListener('change', () => { ui.overlays = Object.fromEntries($$('#overlay-toggles input').map((x) => [x.dataset.overlay, x.checked])); saveUi(); renderOverlays(); }));
  $$('.pane-tab').forEach((b) => b.addEventListener('click', () => { $$('.pane-tab').forEach((x) => x.classList.remove('active')); b.classList.add('active'); state.paneKind = b.dataset.pane; ui.pane = state.paneKind; saveUi(); renderPane(); }));
  $$('.tab').forEach((b) => b.addEventListener('click', () => {
    $$('.tab').forEach((x) => x.classList.remove('active')); b.classList.add('active');
    $$('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + b.dataset.tab));
    if (b.dataset.tab === 'history') loadHistory(); if (b.dataset.tab === 'accuracy') loadStats(); if (b.dataset.tab === 'guide') loadGuide();
  }));
  $('#signal-filter').addEventListener('change', () => state.prediction && renderSignals(state.prediction.signals));
  $('#hist-refresh').addEventListener('click', loadHistory);
  $('#hist-symbol').addEventListener('change', loadHistory);
  $('#hist-status').addEventListener('change', loadHistory);
  $('#hist-source').addEventListener('change', loadHistory);
  $('#hist-resolve').addEventListener('click', async () => {
    try {
      const r = await api('/api/resolve', { method: 'POST' });
      status(`Auto-evaluation: ${r.resolved.length} resolved, ${r.waiting.length} still waiting for bars${r.errors.length ? ', ' + r.errors.length + ' errors' : ''}.`, 'info');
      setTimeout(() => status(null), 5000); loadHistory(); loadStats();
    } catch (e) { status(e.message); }
  });

  // ------------------------------------------------------------ order ticket (top bar, platform style)
  const tk = { symbol: null, exchange: 'NSE', interval: '15m', side: 'BUY', product: 'intraday', type: 'market', ltp: null, cash: null, timer: null };
  function tkSeg(id, v) { $$(`#${id} .seg-btn`).forEach((b) => b.classList.toggle('active', b.dataset.v === v)); }
  function tkFields() {
    $('#tk-price-f').hidden = tk.type !== 'limit'; $('#tk-trigger-f').hidden = tk.type !== 'sl';
    const btn = $('#tk-place'); btn.textContent = `${tk.side} · ${tk.product === 'intraday' ? 'MIS' : 'CNC'} · ${tk.type.toUpperCase()}`; btn.className = 'btn tk-place ' + (tk.side === 'BUY' ? 'buy' : 'sell');
  }
  function tkSync() {
    const cd = state.chartData; if (!cd) return;
    const changed = tk.symbol !== cd.symbol;
    tk.symbol = cd.symbol; tk.exchange = cd.exchange; tk.interval = cd.interval;
    $('#tk-symbol').textContent = cd.symbol;
    const lc = lastCandle(); if (lc) tkLtp(lc.close, changed);
    if (changed) { $('#tk-stop').value = ''; $('#tk-target').value = ''; $('#tk-msg').textContent = ''; }
    tkPreview();
  }
  function tkLtp(price, reset = false) {
    if (price == null || !tk.symbol) return;
    tk.ltp = price; $('#tk-ltp').textContent = fmt(price);
    const ch = $('#chart-change'); $('#tk-chg').textContent = (ch.textContent || '').split(' ')[0]; $('#tk-chg').className = ch.className;
    if (reset || !$('#tk-price').value) $('#tk-price').value = price.toFixed(2);
    if (reset || !$('#tk-trigger').value) $('#tk-trigger').value = price.toFixed(2);
    if (reset) $('#tk-qty').value = Math.max(1, Math.floor((tk.cash || 0) * 0.5 / price));
  }
  function tkBody() {
    const cd = state.chartData, t = state.live.tick;
    const live = t && cd && Date.now() - state.live.lastTickAt < 60000 && t.symbol === (cd.data_symbol || cd.symbol) ? t.price : null;
    return { symbol: tk.symbol, exchange: tk.exchange, interval: tk.interval, side: tk.side, product: tk.product, order_type: tk.type, qty: +$('#tk-qty').value || 0,
      price: tk.type === 'limit' ? (+$('#tk-price').value || null) : null, trigger: tk.type === 'sl' ? (+$('#tk-trigger').value || null) : null,
      stop: +$('#tk-stop').value || null, target: +$('#tk-target').value || null, live_price: live };
  }
  function tkPreview() {
    clearTimeout(tk.timer);
    tk.timer = setTimeout(async () => {
      if (!tk.symbol) return;
      const el = $('#tk-preview');
      try {
        const pv = await api('/api/orders/preview', { method: 'POST', body: JSON.stringify(tkBody()) });
        if (pv.errors && pv.errors.length) { el.className = 'down'; el.textContent = pv.errors.join(' · '); return; }
        const act = { open_long: 'Buy', open_short: 'Short-sell (intraday)', close_long: 'Sell from holding', cover_short: 'Buy back the short' }[pv.action] || pv.action;
        el.className = 'muted';
        el.innerHTML = `${act} <b>${pv.qty}</b> × ${fmt(pv.ref_price)} = ₹${fmt(pv.value, 0)} · this order's charges ₹${fmt(pv.charges.total)}${pv.round_trip ? ` · round trip ₹${fmt(pv.round_trip.total)} (${pv.round_trip.pct_of_value}%, break-even ${pv.breakeven_pct}%)` : ''} · cash after ₹${fmt(pv.cash_after, 0)}${pv.squareoff && pv.action.startsWith('open') && pv.product === 'intraday' ? ` · broker square-off ${new Date(pv.squareoff).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}${pv.notes.length ? ' · ' + pv.notes.map(escapeHtml).join(' · ') : ''}`;
      } catch (e) { el.className = 'down'; el.textContent = e.message; }
    }, 250);
  }
  async function tkPlace() {
    if (!tk.symbol) return;
    const btn = $('#tk-place'); btn.disabled = true;
    try {
      const r = await api('/api/orders', { method: 'POST', body: JSON.stringify(tkBody()) });
      const t = r.trades[0];
      const what = { open_long: 'Bought', open_short: 'Sold short', close_long: 'Sold', cover_short: 'Covered' }[r.action] || r.action;
      $('#tk-msg').innerHTML = !t ? 'Done.' : t.status === 'pending' ? `<span class="up">Order #${t.id} placed:</span> ${t.side === 'short' ? 'sell' : 'buy'} ${t.qty} ${t.entry_type.toUpperCase()} at ${fmt(t.entry_price)}`
        : t.status === 'closed' ? `<span class="up">${what} ${t.qty} at ${fmt(t.exit_price)}</span> · net <b class="${t.net_pnl >= 0 ? 'up' : 'down'}">${t.net_pnl >= 0 ? '+' : ''}₹${fmt(t.net_pnl)}</b> after ₹${fmt(t.charges)} charges`
        : r.action.startsWith('open') ? `<span class="up">${what} ${t.qty} at ${fmt(t.fill_price)}</span> (#${t.id})${t.stop || t.target ? ` · SL ${fmt(t.stop)} / target ${fmt(t.target)}` : ''}`
        : `<span class="up">Exit order set on #${t.id}:</span> ${t.stop ? 'SL ' + fmt(t.stop) : ''} ${t.target ? 'target ' + fmt(t.target) : ''}`;
      tkPositions(); tkPreview();
    } catch (e) { $('#tk-msg').innerHTML = `<span class="down">${escapeHtml(e.message)}</span>`; }
    btn.disabled = false;
  }
  function tkFromPlan() {
    setTicket(true);
    const t = state.prediction && state.prediction.trade_plan;
    if (!t || !t.available) { $('#tk-msg').textContent = 'No tradeable plan on the prediction card.'; return; }
    tk.side = t.side === 'SELL' ? 'SELL' : 'BUY'; tk.product = t.best.mode; tk.type = t.entry_type === 'limit' ? 'limit' : 'market';
    tkSeg('tk-side', tk.side); tkSeg('tk-product', tk.product); tkSeg('tk-type', tk.type); tkFields();
    $('#tk-qty').value = Math.max(1, t.qty_affordable); $('#tk-price').value = t.entry.toFixed(2); $('#tk-stop').value = t.stop.toFixed(2); $('#tk-target').value = t.best.target.toFixed(2);
    $('#tk-msg').textContent = `Plan loaded (${t.verdict}). Review and press ${tk.side}.`; tkPreview();
  }
  async function tkPositions() {
    try {
      const p = await api('/api/portfolio'); tk.cash = p.cash;
      const chips = p.open.map((t) => `<div class="pos-chip ${t.unrealised >= 0 ? 'pos' : 'neg'}"><b>${t.symbol.replace('.NS', '').replace('.BO', '')}</b> <span class="badge ${t.side === 'short' ? 'bad' : 'ok'}">${t.side === 'short' ? 'SHORT' : 'LONG'}</span> ${t.qty} @ ${fmt(t.fill_price)} · LTP ${fmt(t.last_price)} · <b class="${t.unrealised >= 0 ? 'up' : 'down'}">${t.unrealised >= 0 ? '+' : ''}₹${fmt(t.unrealised)}</b> <span class="muted">(${t.unrealised_pct >= 0 ? '+' : ''}${t.unrealised_pct}%${t.stop ? ` · SL ${fmt(t.stop)}` : ''}${t.target ? ` · T ${fmt(t.target)}` : ''})</span> <button class="btn small" data-exit="${t.id}">Exit</button></div>`)
        .concat(p.pending.map((t) => `<div class="pos-chip pending"><b>${t.symbol.replace('.NS', '').replace('.BO', '')}</b> <span class="badge">${t.side === 'short' ? 'SELL' : 'BUY'} ${t.entry_type.toUpperCase()}</span> ${t.qty} @ ${fmt(t.entry_price)} <span class="muted">waiting</span> <button class="btn small" data-exit="${t.id}">Cancel</button></div>`));
      $('#tk-positions').innerHTML = `<span class="muted">Cash <b>₹${fmt(p.cash, 0)}</b> · Equity <b>₹${fmt(p.equity, 0)}</b> · Realised <b class="${p.stats.net_pnl >= 0 ? 'up' : 'down'}">${p.stats.net_pnl >= 0 ? '+' : ''}₹${fmt(p.stats.net_pnl, 0)}</b> · <a href="/portfolio">Portfolio →</a></span>${chips.join('')}`;
      $$('#tk-positions [data-exit]').forEach((b) => b.addEventListener('click', async () => { try { await api(`/api/trades/${b.dataset.exit}/close`, { method: 'POST', body: '{}' }); tkPositions(); tkPreview(); } catch (e) { $('#tk-msg').innerHTML = `<span class="down">${escapeHtml(e.message)}</span>`; } }));
    } catch (e) { console.warn('positions', e); }
  }
  $$('#tk-side .seg-btn').forEach((b) => b.addEventListener('click', () => { tk.side = b.dataset.v; tkSeg('tk-side', tk.side); tkFields(); tkPreview(); }));
  $$('#tk-product .seg-btn').forEach((b) => b.addEventListener('click', () => { tk.product = b.dataset.v; ui.product = tk.product; saveUi(); tkSeg('tk-product', tk.product); tkFields(); tkPreview(); }));
  $$('#tk-type .seg-btn').forEach((b) => b.addEventListener('click', () => { tk.type = b.dataset.v; ui.type = tk.type; saveUi(); tkSeg('tk-type', tk.type); tkFields(); tkPreview(); }));
  ['#tk-qty', '#tk-price', '#tk-trigger', '#tk-stop', '#tk-target'].forEach((s) => $(s).addEventListener('input', tkPreview));
  $('#tk-place').addEventListener('click', tkPlace);
  $('#tk-plan').addEventListener('click', tkFromPlan);
  // the order panel is folded away by default (simple view); the Order button or "paper trade" on the call card opens it
  function setTicket(open) {
    $('#ticket').classList.toggle('folded', !open);
    $('#tk-toggle').textContent = open ? 'Order ▴' : 'Order ▾';
    try { localStorage.setItem('tb.ticket', open ? '1' : '0'); } catch {}
  }
  $('#tk-toggle').addEventListener('click', () => setTicket($('#ticket').classList.contains('folded')));
  try { if (localStorage.getItem('tb.ticket') === '1') setTicket(true); } catch {}
  tkFields();

  // ------------------------------------------------------------ icon bar: popovers and the drawer
  function closePops() { $$('.popover').forEach((p) => { p.hidden = true; }); $$('.ico[data-pop]').forEach((b) => b.classList.remove('active')); }
  $$('.ico[data-pop]').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    const pop = $('#pop-' + b.dataset.pop), open = pop.hidden;
    closePops();
    if (open) { pop.hidden = false; b.classList.add('active'); }
  }));
  document.addEventListener('click', (e) => { if (!e.target.closest('.popover') && !e.target.closest('.ico')) closePops(); });
  function openDrawer(tab) {
    $('#drawer').hidden = false;
    const t = $$('.tab').find((x) => x.dataset.tab === tab); if (t) t.click();
    $$('.ico[data-drawer]').forEach((b) => b.classList.toggle('active', b.dataset.drawer === tab));
  }
  function closeDrawer() { $('#drawer').hidden = true; $$('.ico[data-drawer]').forEach((b) => b.classList.remove('active')); }
  $$('.ico[data-drawer]').forEach((b) => b.addEventListener('click', () => { if (!$('#drawer').hidden && b.classList.contains('active')) closeDrawer(); else openDrawer(b.dataset.drawer); }));
  $('#drawer-close').addEventListener('click', closeDrawer);
  $('#ico-learn').addEventListener('click', () => { if (state.prediction) openLearning(state.prediction); });
  $('#pred-more-btn').addEventListener('click', () => { const m = $('#pred-more'); m.hidden = !m.hidden; ui.details = !m.hidden; saveUi(); $('#pred-more-btn').textContent = m.hidden ? 'Details ▾' : 'Details ▴'; });

  // ------------------------------------------------------------ boot
  initCharts();
  try {
    const saved = JSON.parse(localStorage.getItem('tb.tabs') || 'null');
    if (saved && Array.isArray(saved.tabs)) {
      state.tabs = saved.tabs.filter((t) => t && t.symbol && t.interval).map((t) => ({ ...t, id: ++tabSeq, busy: false, queued: false, failedAt: null }));
      state.activeTab = Math.min(Math.max(0, saved.active | 0), state.tabs.length - 1);
    }
  } catch {}
  applyUi();
  // arriving from the map: /?symbol=RELIANCE.NS&interval=15m opens (or focuses) that tab
  const qs = new URLSearchParams(window.location.search);
  if (qs.get('symbol')) {
    const sym = qs.get('symbol'), ex = qs.get('exchange') || (sym.toUpperCase().endsWith('.BO') ? 'BSE' : 'NSE');
    openTab(sym, ex, qs.get('interval') || '15m', +qs.get('horizon') || null);
    window.history.replaceState({}, '', '/chart');
  }
  if (!state.tabs.length) openTab('RELIANCE', 'NSE', '15m', 16);
  renderTabs();
  activateTab(state.activeTab);        // shows the last call instantly, loads the chart, refreshes in the background if stale
  // background analysis: the active tab first (if its call is stale), then every tab that has never been analysed
  const first = activeTab(); if (first && stale(first)) enqueue(first, true);
  state.tabs.forEach((t) => { if (!t.prediction) enqueue(t); });
  setLive(ui.live);
  loadHistory().catch(() => {});
  tkPositions(); setInterval(tkPositions, 15000);
  // coming back through the browser's back/forward cache restores the page with its socket closed and its
  // timers stopped: reload the chart and reconnect instead of showing a frozen or blank chart
  window.addEventListener('pageshow', (e) => { if (e.persisted && state.activeTab >= 0) { stopLive(); state.chartData = null; activateTab(state.activeTab); } });
})();
