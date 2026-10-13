/**
 * Builds what the chart page draws from the bars: overlays and indicator-pane series (from computeAll, the
 * port of app/indicators.py), session levels (pivots, CPR, Camarilla, VWAP bands) and the analysis' entry /
 * target / stop / forecast.  Overlay and pane choices mirror the web app's toggles (static/app.js).
 */
import * as ind from '@/engine/indicators';
import { Bars, IST_OFFSET_S, isIntraday } from '@/engine/types';

import type { ChartLine, ChartPayload, ChartPrediction, ChartTail, OverlaySeries, PaneSeries, Pt } from './chart-html';

export const OVERLAYS: [string, string][] = [
  ['ema_9', 'EMA 9'], ['ema_21', 'EMA 21'], ['sma_50', 'SMA 50'], ['sma_200', 'SMA 200'], ['bb', 'Bollinger'], ['kc', 'Keltner'],
  ['supertrend', 'Supertrend'], ['psar', 'PSAR'], ['vwap_20', 'VWAP 20'], ['ichimoku', 'Ichimoku cloud'],
];
export const LEVELS: [string, string][] = [['pivots', 'Pivots + CPR'], ['camarilla', 'Camarilla'], ['vwapb', 'VWAP bands'], ['levels', 'Target / stop']];
export const PANES: [string, string][] = [['none', 'No pane'], ['rsi', 'RSI'], ['macd', 'MACD'], ['adx', 'ADX'], ['stoch', 'Stochastic'], ['obv', 'OBV'], ['cci', 'CCI'], ['mfi', 'MFI']];
export const DEFAULT_OVERLAYS = ['ema_9', 'ema_21', 'supertrend'];
export const DEFAULT_LEVELS = ['pivots', 'levels'];

const STYLE: Record<string, Omit<OverlaySeries, 'data'>> = {
  ema_9: { color: '#4f8cff', width: 1 }, ema_21: { color: '#f0b429', width: 1 }, sma_50: { color: '#ff8a65', width: 1 }, sma_200: { color: '#ba68c8', width: 2 },
  bb_upper: { color: 'rgba(120,160,255,.7)', width: 1 }, bb_lower: { color: 'rgba(120,160,255,.7)', width: 1 },
  kc_upper: { color: 'rgba(255,200,120,.8)', width: 1, style: 2 }, kc_lower: { color: 'rgba(255,200,120,.8)', width: 1, style: 2 },
  supertrend: { color: '#26c6da', width: 2 }, psar: { color: '#7b8494', width: 1, style: 1 }, vwap_20: { color: '#b8800a', width: 1, style: 2 },
  senkou_a: { color: 'rgba(38,166,154,.75)', width: 1 }, senkou_b: { color: 'rgba(239,83,80,.75)', width: 1 },
};
const GROUPS: Record<string, string[]> = { bb: ['bb_upper', 'bb_lower'], kc: ['kc_upper', 'kc_lower'], ichimoku: ['senkou_a', 'senkou_b'] };
const PANE_CFG: Record<string, { key: string; type: 'line' | 'hist'; color?: string; lines?: number[] }[]> = {
  rsi: [{ key: 'rsi_14', type: 'line', color: '#ba68c8', lines: [30, 70] }],
  macd: [{ key: 'macd_hist', type: 'hist' }, { key: 'macd', type: 'line', color: '#4f8cff' }, { key: 'macd_signal', type: 'line', color: '#ff8a65' }],
  adx: [{ key: 'adx', type: 'line', color: '#b8800a', lines: [20, 25] }, { key: 'plus_di', type: 'line', color: '#26a69a' }, { key: 'minus_di', type: 'line', color: '#ef5350' }],
  stoch: [{ key: 'stoch_k', type: 'line', color: '#4f8cff', lines: [20, 80] }, { key: 'stoch_d', type: 'line', color: '#ff8a65' }],
  obv: [{ key: 'obv', type: 'line', color: '#26c6da' }, { key: 'obv_ema', type: 'line', color: '#9aa3b2' }],
  cci: [{ key: 'cci_20', type: 'line', color: '#ba68c8', lines: [-100, 100] }],
  mfi: [{ key: 'mfi_14', type: 'line', color: '#26a69a', lines: [20, 80] }],
};

export interface ChartSettings { overlays: string[]; levels: string[]; pane: string }
const MAX_BARS = 1500;

const pts = (b: Bars, s: number[], from: number): Pt[] => {
  const out: Pt[] = [];
  for (let i = from; i < s.length; i++) if (Number.isFinite(s[i])) out.push({ time: b.t[i] + IST_OFFSET_S, value: s[i] });
  return out;
};
/** The raw indicator column, as app/ensemble.py chart_payload sends it. */
function seriesFor(f: ind.Frame, key: string): number[] {
  if (key === 'psar') return f.psar;
  return f[key] ?? [];
}

export function levelLines(b: Bars, show: Set<string>): ChartLine[] {
  const intra = isIntraday(b), out: ChartLine[] = [];
  if (show.has('pivots')) {
    const p = ind.pivotPoints(b, intra), c = ind.cprLevels(b, intra);
    out.push({ price: p.pivot, color: '#b8800a', title: 'P', style: 0 });
    for (const k of ['r1', 'r2', 'r3'] as const) out.push({ price: p[k], color: 'rgba(239,83,80,.85)', title: k.toUpperCase(), style: 3 });
    for (const k of ['s1', 's2', 's3'] as const) out.push({ price: p[k], color: 'rgba(38,166,154,.85)', title: k.toUpperCase(), style: 3 });
    out.push({ price: c.tc, color: 'rgba(184,128,10,.6)', title: 'TC', style: 2 }, { price: c.bc, color: 'rgba(184,128,10,.6)', title: 'BC', style: 2 });
  }
  if (show.has('camarilla')) {
    const c = ind.camarillaLevels(b, intra);
    out.push({ price: c.h3, color: '#ff8a65', title: 'H3', style: 4 }, { price: c.h4, color: '#ff8a65', title: 'H4', style: 4 });
    out.push({ price: c.l3, color: '#26c6da', title: 'L3', style: 4 }, { price: c.l4, color: '#26c6da', title: 'L4', style: 4 });
  }
  if (show.has('vwapb')) {
    const v = ind.vwapBands(b, intra);
    if (v) out.push({ price: v.vwap, color: '#8a63d2', title: 'VWAP', style: 0 }, { price: v.upper2, color: '#8a63d2', title: '+2σ', style: 3 }, { price: v.lower2, color: '#8a63d2', title: '-2σ', style: 3 });
  }
  return out.filter((l) => Number.isFinite(l.price));
}

export function buildPayload(b: Bars, f: ind.Frame, s: ChartSettings, prediction: ChartPrediction | null, fit: boolean): ChartPayload {
  const from = Math.max(0, b.t.length - MAX_BARS);
  const bars = b.t.slice(from).map((t, j) => { const i = from + j; return { time: t + IST_OFFSET_S, open: b.o[i], high: b.h[i], low: b.l[i], close: b.c[i], volume: b.v[i] }; });
  const overlays: Record<string, OverlaySeries> = {};
  for (const name of s.overlays) for (const key of GROUPS[name] ?? [name]) if (STYLE[key]) overlays[key] = { ...STYLE[key], data: pts(b, seriesFor(f, key), from) };
  const pane: PaneSeries[] | null = s.pane !== 'none' && PANE_CFG[s.pane] ? PANE_CFG[s.pane].map((c) => ({ ...c, data: pts(b, f[c.key] ?? [], from) })) : null;
  const lv = new Set(s.levels);
  return { bars, lines: levelLines(b, lv), intraday: isIntraday(b), fit, overlays, pane, prediction: lv.has('levels') ? prediction : null };
}

/** Only the bars from `fromT` (epoch s) on, with the matching overlay / pane points: cheap to send every few seconds. */
export function buildTail(b: Bars, f: ind.Frame, s: ChartSettings, fromT: number): ChartTail {
  let from = b.t.findIndex((t) => t >= fromT);
  if (from < 0) from = b.t.length - 1;
  const bars = b.t.slice(from).map((t, j) => { const i = from + j; return { time: t + IST_OFFSET_S, open: b.o[i], high: b.h[i], low: b.l[i], close: b.c[i], volume: b.v[i] }; });
  const overlays: Record<string, Pt[]> = {};
  for (const name of s.overlays) for (const key of GROUPS[name] ?? [name]) if (STYLE[key]) overlays[key] = pts(b, seriesFor(f, key), from);
  const pane: Record<string, Pt[]> = {};
  if (s.pane !== 'none') for (const c of PANE_CFG[s.pane] ?? []) pane[c.key] = pts(b, f[c.key] ?? [], from);
  return { bars, overlays, pane };
}

/** The analysis result -> what the chart draws (entry, target, stop, forecast cone). */
export function predictionFor(r: { price_at: number; target_price: number | null; stop_price: number | null; direction: string; forecast: { time: number; median: number; upper: number; lower: number }[] }): ChartPrediction {
  return {
    entry: r.price_at, target: r.target_price, stop: r.stop_price, direction: r.direction,
    forecast: r.forecast.map((p) => ({ ...p, time: p.time + IST_OFFSET_S })),
  };
}
