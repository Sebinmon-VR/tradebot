/**
 * The page inside the chart WebView: TradingView Lightweight Charts (bundled, works offline) with candles,
 * volume, indicator overlays, session levels, the analysis' entry / target / stop and forecast cone, and an
 * optional indicator pane (RSI, MACD, ...) whose time axis is locked to the price chart.  Same colours and
 * styles as static/app.js.  The app drives it with window.tb.set(payload) / window.tb.tail(payload).
 * Times arrive already shifted to IST (epoch + 5:30) so the axis reads in Indian time.
 */
import LWC from './lwc-source';

export interface ChartBar { time: number; open: number; high: number; low: number; close: number; volume: number }
export interface ChartLine { price: number; color: string; title: string; style?: number }
export interface Pt { time: number; value: number }
export interface OverlaySeries { color: string; width?: number; style?: number; data: Pt[] }
export interface PaneSeries { key: string; type: 'line' | 'hist'; color?: string; lines?: number[]; data: Pt[] }
export interface ChartPrediction { entry: number; target: number | null; stop: number | null; direction: string; forecast: { time: number; median: number; upper: number; lower: number }[] }
export interface ChartPayload {
  bars: ChartBar[]; lines: ChartLine[]; intraday: boolean; fit?: boolean;
  overlays?: Record<string, OverlaySeries>; pane?: PaneSeries[] | null; prediction?: ChartPrediction | null;
}
export interface ChartTail { bars: ChartBar[]; overlays?: Record<string, Pt[]>; pane?: Record<string, Pt[]> }

export function chartHtml(dark: boolean): string {
  const bg = dark ? '#0e1116' : '#ffffff', text = dark ? '#c9d0da' : '#4b5563', grid = dark ? '#1c2129' : '#eef1f5', border = dark ? '#2b313c' : '#dde2ea';
  const ink = dark ? '#e6e9ee' : '#1d2430';
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<style>html,body{margin:0;height:100%;background:${bg};overflow:hidden;touch-action:none;-webkit-user-select:none;user-select:none}
#m{position:absolute;left:0;right:0;top:0;bottom:0}#p{position:absolute;left:0;right:0;bottom:0;height:0;border-top:1px solid ${border}}
#lg{position:absolute;left:6px;top:4px;z-index:3;font:11px -apple-system,Roboto,sans-serif;color:${text};pointer-events:none}</style></head>
<body><div id="m"></div><div id="p"></div><div id="lg"></div><script>${LWC}</script><script>
(function(){
  var opts = { autoSize: true, layout: { background: { color: '${bg}' }, textColor: '${text}', fontSize: 11 },
    grid: { vertLines: { color: '${grid}' }, horzLines: { color: '${grid}' } },
    rightPriceScale: { borderColor: '${border}' }, timeScale: { borderColor: '${border}', timeVisible: true, secondsVisible: false, rightOffset: 8 },
    crosshair: { mode: 0 }, kineticScroll: { touch: true, mouse: false },
    handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true },
    handleScale: { axisPressedMouseMove: { time: true, price: true }, axisDoubleClickReset: true, pinch: true, mouseWheel: true } };
  var M = document.getElementById('m'), P = document.getElementById('p');
  var chart = LightweightCharts.createChart(M, opts);
  var pane = LightweightCharts.createChart(P, Object.assign({}, opts, { timeScale: Object.assign({}, opts.timeScale, { visible: false }) }));
  var candles = chart.addCandlestickSeries({ upColor: '#26a69a', downColor: '#ef5350', borderVisible: false, wickUpColor: '#26a69a', wickDownColor: '#ef5350' });
  var vol = chart.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: 'vol', priceLineVisible: false, lastValueVisible: false });
  chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
  var syncing = false;
  function link(a, b){ a.timeScale().subscribeVisibleLogicalRangeChange(function(r){ if (syncing || !r) return; syncing = true; b.timeScale().setVisibleLogicalRange(r); syncing = false; }); }
  link(chart, pane); link(pane, chart);
  var lines = [], overlays = {}, paneSeries = {}, fc = null, paneOn = false;
  function volBar(b){ return { time: b.time, value: b.volume, color: b.close >= b.open ? 'rgba(38,166,154,0.35)' : 'rgba(239,83,80,0.35)' }; }
  function histPt(d){ return { time: d.time, value: d.value, color: d.value >= 0 ? 'rgba(38,166,154,.7)' : 'rgba(239,83,80,.7)' }; }
  function post(m){ if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(m)); else if (window.parent !== window) window.parent.postMessage(JSON.stringify(m), '*'); }
  function setPane(on){
    if (on === paneOn) return; paneOn = on;
    M.style.bottom = on ? '30%' : '0'; P.style.height = on ? '30%' : '0';
    chart.timeScale().applyOptions({ visible: true });
  }
  function forecastSeries(){
    if (fc) return fc;
    fc = { median: chart.addLineSeries({ color: '${ink}', lineWidth: 2, lineStyle: 2, priceLineVisible: false, lastValueVisible: true, title: 'forecast' }),
      upper: chart.addLineSeries({ color: 'rgba(120,130,145,.45)', lineWidth: 1, lineStyle: 3, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }),
      lower: chart.addLineSeries({ color: 'rgba(120,130,145,.45)', lineWidth: 1, lineStyle: 3, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }) };
    return fc;
  }
  function legend(p){
    var L = document.getElementById('lg'), parts = [];
    if (p.prediction) parts.push('<b style="color:' + (p.prediction.direction === 'UP' ? '#26a69a' : p.prediction.direction === 'DOWN' ? '#ef5350' : '#f0b429') + '">' + (p.prediction.direction === 'SIDEWAYS' ? 'NO CALL' : p.prediction.direction) + '</b>');
    Object.keys(p.overlays || {}).forEach(function(k){ parts.push('<span style="color:' + p.overlays[k].color + '">' + k.replace('_', ' ') + '</span>'); });
    L.innerHTML = parts.join(' · ');
  }
  window.tb = {
    set: function(p){
      var keep = !p.fit ? chart.timeScale().getVisibleLogicalRange() : null;
      candles.setData(p.bars.map(function(b){ return { time: b.time, open: b.open, high: b.high, low: b.low, close: b.close }; }));
      vol.setData(p.bars.map(volBar));
      // overlays: add / update / remove
      var want = p.overlays || {};
      Object.keys(overlays).forEach(function(k){ if (!want[k]) { chart.removeSeries(overlays[k]); delete overlays[k]; } });
      Object.keys(want).forEach(function(k){
        var o = want[k];
        if (!overlays[k]) overlays[k] = chart.addLineSeries({ color: o.color, lineWidth: o.width || 1, lineStyle: o.style || 0, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
        overlays[k].setData(o.data);
      });
      // price lines: session levels + the analysis' entry / target / stop
      lines.forEach(function(l){ candles.removePriceLine(l); }); lines = [];
      (p.lines || []).forEach(function(l){ lines.push(candles.createPriceLine({ price: l.price, color: l.color, lineWidth: 1, lineStyle: l.style == null ? 2 : l.style, axisLabelVisible: true, title: l.title })); });
      var pr = p.prediction, F = forecastSeries();
      if (pr && pr.forecast && pr.forecast.length && p.bars.length) {
        var last = p.bars[p.bars.length - 1], col = pr.direction === 'UP' ? '#26a69a' : pr.direction === 'DOWN' ? '#ef5350' : '#f0b429';
        var start = { time: last.time, value: pr.entry }, pts = pr.forecast.filter(function(f){ return f.time > last.time; });
        F.median.applyOptions({ color: col });
        F.median.setData([start].concat(pts.map(function(f){ return { time: f.time, value: f.median }; })));
        F.upper.setData([start].concat(pts.map(function(f){ return { time: f.time, value: f.upper }; })));
        F.lower.setData([start].concat(pts.map(function(f){ return { time: f.time, value: f.lower }; })));
        lines.push(candles.createPriceLine({ price: pr.entry, color: '#6b7583', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: 'entry' }));
        if (pr.target != null && pr.direction !== 'SIDEWAYS') lines.push(candles.createPriceLine({ price: pr.target, color: col, lineWidth: 2, lineStyle: 0, axisLabelVisible: true, title: 'target' }));
        if (pr.stop != null) lines.push(candles.createPriceLine({ price: pr.stop, color: '#f0b429', lineWidth: 2, lineStyle: 0, axisLabelVisible: true, title: 'stop' }));
      } else { F.median.setData([]); F.upper.setData([]); F.lower.setData([]); }
      // indicator pane
      Object.keys(paneSeries).forEach(function(k){ pane.removeSeries(paneSeries[k]); }); paneSeries = {};
      setPane(!!(p.pane && p.pane.length));
      (p.pane || []).forEach(function(cfg){
        var s;
        if (cfg.type === 'hist') { s = pane.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false }); s.setData(cfg.data.map(histPt)); }
        else {
          s = pane.addLineSeries({ color: cfg.color, lineWidth: 1, priceLineVisible: false, lastValueVisible: true }); s.setData(cfg.data);
          (cfg.lines || []).forEach(function(v){ s.createPriceLine({ price: v, color: '#9aa3b2', lineWidth: 1, lineStyle: 3, axisLabelVisible: false }); });
        }
        s.__hist = cfg.type === 'hist'; paneSeries[cfg.key] = s;
      });
      chart.applyOptions({ timeScale: { timeVisible: !!p.intraday } });
      legend(p);
      if (p.fit) {
        chart.priceScale('right').applyOptions({ autoScale: true }); pane.priceScale('right').applyOptions({ autoScale: true });
        var n = p.bars.length; chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - (p.intraday ? 120 : 100)), to: n + 8 });
      } else if (keep) chart.timeScale().setVisibleLogicalRange(keep);
      if (paneOn) pane.timeScale().setVisibleLogicalRange(chart.timeScale().getVisibleLogicalRange());
    },
    tail: function(t){
      t.bars.forEach(function(b){ candles.update({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close }); vol.update(volBar(b)); });
      Object.keys(t.overlays || {}).forEach(function(k){ if (overlays[k]) t.overlays[k].forEach(function(d){ overlays[k].update(d); }); });
      Object.keys(t.pane || {}).forEach(function(k){ var s = paneSeries[k]; if (s) t.pane[k].forEach(function(d){ s.update(s.__hist ? histPt(d) : d); }); });
    },
    reset: function(){ chart.priceScale('right').applyOptions({ autoScale: true }); chart.timeScale().scrollToRealTime(); },
    range: function(){ return chart.timeScale().getVisibleLogicalRange(); }
  };
  function onMsg(e){ try { var m = JSON.parse(e.data); if (m && m.fn && window.tb[m.fn]) window.tb[m.fn](m.arg); } catch (err) {} }
  window.addEventListener('message', onMsg); document.addEventListener('message', onMsg);
  post({ ready: true });
})();
</script></body></html>`;
}
