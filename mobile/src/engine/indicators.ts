/**
 * Technical indicators - a line-for-line port of app/indicators.py.  Every function returns series aligned
 * to the bars with NaN where pandas would have NaN.
 */
import {
  Series, add, centeredMax, centeredMin, clip, cumsum, div, ewm, fillna, full, groupRuns, isNum, map2, mean,
  nan, pctChange, rollingMax, rollingMean, rollingMin, rollingStd, rollingSum, scale, shift, sub,
} from './series';
import { Bars, istDay } from './types';

// ---------------------------------------------------------------- moving averages
export const sma = (s: Series, n: number) => rollingMean(s, n);
export const ema = (s: Series, n: number) => ewm(s, 2 / (n + 1), n);
export function wma(s: Series, n: number): Series {
  const out = full(s.length), wsum = (n * (n + 1)) / 2;
  for (let i = n - 1; i < s.length; i++) {
    let acc = 0, ok = true;
    for (let j = 0; j < n; j++) { const x = s[i - n + 1 + j]; if (!isNum(x)) { ok = false; break; } acc += x * (j + 1); }
    if (ok) out[i] = acc / wsum;
  }
  return out;
}
/** Hull Moving Average (Alan Hull, 2005). */
export function hma(s: Series, n: number): Series {
  const half = wma(s, Math.max(2, Math.floor(n / 2))), fullW = wma(s, n);
  return wma(map2(half, fullW, (a, b) => 2 * a - b), Math.max(2, Math.floor(Math.sqrt(n))));
}
/** Wilder's smoothing (RSI, ATR, ADX). */
export const rma = (s: Series, n: number) => ewm(s, 1 / n, n);

// ---------------------------------------------------------------- momentum
/** Relative Strength Index (J. Welles Wilder, 1978). */
export function rsi(close: Series, n = 14): Series {
  const d = map2(close, shift(close, 1), (a, b) => a - b);
  const up = d.map((x) => (isNum(x) ? Math.max(x, 0) : nan));
  const down = d.map((x) => (isNum(x) ? Math.max(-x, 0) : nan));
  const rs = div(rma(up, n), rma(down, n));
  return fillna(rs.map((x) => 100 - 100 / (1 + x)), 50);
}
/** MACD (Gerald Appel, 1979). */
export function macd(close: Series, fast = 12, slow = 26, signal = 9) {
  const line = sub(ema(close, fast), ema(close, slow));
  const sig = ema(line, signal);
  return { macd: line, macd_signal: sig, macd_hist: sub(line, sig) };
}
/** Stochastic oscillator (George Lane). */
export function stochastic(b: Bars, k = 14, d = 3, smooth = 3) {
  const lowK = rollingMin(b.l, k), highK = rollingMax(b.h, k);
  const raw = div(scale(sub(b.c, lowK), 100), sub(highK, lowK));
  const ks = rollingMean(raw, smooth);
  return { stoch_k: ks, stoch_d: rollingMean(ks, d) };
}
/** Williams %R (Larry Williams). */
export function williamsR(b: Bars, n = 14): Series {
  const hh = rollingMax(b.h, n), ll = rollingMin(b.l, n);
  return div(scale(sub(hh, b.c), -100), sub(hh, ll));
}
export const typicalPrice = (b: Bars) => b.c.map((c, i) => (b.h[i] + b.l[i] + c) / 3);
/** Commodity Channel Index (Donald Lambert, 1980). */
export function cci(b: Bars, n = 20): Series {
  const tp = typicalPrice(b), ma = rollingMean(tp, n);
  const md = rollingMean(map2(tp, ma, (a, m) => Math.abs(a - m)), n);
  return div(sub(tp, ma), scale(md, 0.015));
}
export const roc = (close: Series, n = 10) => pctChange(close, n).map((x) => 100 * x);
/** Money Flow Index (Quong & Soudack). */
export function mfi(b: Bars, n = 14): Series {
  const tp = typicalPrice(b), prev = shift(tp, 1);
  const flow = tp.map((x, i) => x * b.v[i]);
  const pos = flow.map((f, i) => (tp[i] > prev[i] ? f : 0));
  const neg = flow.map((f, i) => (tp[i] < prev[i] ? f : 0));
  const ratio = div(rollingSum(pos, n), rollingSum(neg, n));
  return fillna(ratio.map((x) => 100 - 100 / (1 + x)), 50);
}

// ---------------------------------------------------------------- volatility
export function trueRange(b: Bars): Series {
  return b.c.map((_, i) => {
    const hl = b.h[i] - b.l[i];
    if (i === 0) return hl;   // pandas max(axis=1) skips the NaN previous-close terms
    const pc = b.c[i - 1];
    return Math.max(hl, Math.abs(b.h[i] - pc), Math.abs(b.l[i] - pc));
  });
}
/** Average True Range (Wilder). */
export const atr = (b: Bars, n = 14) => rma(trueRange(b), n);
/** Bollinger Bands (John Bollinger). */
export function bollinger(close: Series, n = 20, k = 2) {
  const mid = sma(close, n), sd = rollingStd(close, n, 0);
  const upper = add(mid, scale(sd, k)), lower = sub(mid, scale(sd, k));
  return { bb_upper: upper, bb_mid: mid, bb_lower: lower, bb_width: div(sub(upper, lower), mid), bb_pct: div(sub(close, lower), sub(upper, lower)) };
}
/** Keltner Channels (Raschke's EMA/ATR variant). */
export function keltner(b: Bars, n = 20, mult = 1.5) {
  const mid = ema(b.c, n), rng = scale(atr(b, n), mult);
  return { kc_upper: add(mid, rng), kc_mid: mid, kc_lower: sub(mid, rng) };
}
/** Donchian Channel (Richard Donchian). */
export function donchian(b: Bars, n = 20) {
  const upper = rollingMax(b.h, n), lower = rollingMin(b.l, n);
  return { dc_upper: upper, dc_lower: lower, dc_mid: map2(upper, lower, (u, l) => (u + l) / 2) };
}

// ---------------------------------------------------------------- trend
/** ADX with +DI / -DI (Wilder). */
export function adx(b: Bars, n = 14) {
  const up = map2(b.h, shift(b.h, 1), (a, p) => a - p);
  const down = map2(b.l, shift(b.l, 1), (a, p) => p - a);
  const plusDm = up.map((u, i) => (u > down[i] && u > 0 ? u : 0));
  const minusDm = down.map((d, i) => (d > up[i] && d > 0 ? d : 0));
  // pandas: where() on a NaN first element yields 0.0 (NaN comparisons are False)
  const tr = rma(trueRange(b), n);
  const plusDi = div(scale(rma(plusDm, n), 100), tr), minusDi = div(scale(rma(minusDm, n), 100), tr);
  const dx = div(map2(plusDi, minusDi, (p, m) => 100 * Math.abs(p - m)), add(plusDi, minusDi));
  return { adx: rma(dx, n), plus_di: plusDi, minus_di: minusDi };
}
/** Supertrend (Olivier Seban). */
export function supertrend(b: Bars, n = 10, mult = 3) {
  const a = atr(b, n), len = b.c.length;
  const hl2 = b.h.map((h, i) => (h + b.l[i]) / 2);
  const upper = hl2.map((x, i) => x + mult * a[i]), lower = hl2.map((x, i) => x - mult * a[i]);
  const st = full(len), dir = full(len, 0), fu = upper.slice(), fl = lower.slice();
  for (let i = 1; i < len; i++) {
    if (!isNum(a[i]) || !isNum(a[i - 1])) continue;
    fl[i] = lower[i] > fl[i - 1] || b.c[i - 1] < fl[i - 1] ? lower[i] : fl[i - 1];
    fu[i] = upper[i] < fu[i - 1] || b.c[i - 1] > fu[i - 1] ? upper[i] : fu[i - 1];
    const prevDir = dir[i - 1] !== 0 ? dir[i - 1] : 1;
    dir[i] = prevDir === 1 ? (b.c[i] < fl[i] ? -1 : 1) : (b.c[i] > fu[i] ? 1 : -1);
    st[i] = dir[i] === 1 ? fl[i] : fu[i];
  }
  return { supertrend: st, supertrend_dir: dir };
}
/** Parabolic SAR (Wilder). */
export function parabolicSar(b: Bars, af0 = 0.02, afStep = 0.02, afMax = 0.2) {
  const n = b.c.length, sar = full(n), trend = full(n, 0);
  if (n < 3) return { psar: sar, psar_dir: trend };
  const { h, l } = b;
  let up = h[1] > h[0], ep = up ? h[0] : l[0], af = af0;
  sar[0] = up ? l[0] : h[0];
  for (let i = 1; i < n; i++) {
    let cur = sar[i - 1] + af * (ep - sar[i - 1]);
    if (up) {
      cur = Math.min(cur, l[i - 1], i >= 2 ? l[i - 2] : l[i - 1]);
      if (l[i] < cur) { up = false; cur = ep; ep = l[i]; af = af0; }
      else if (h[i] > ep) { ep = h[i]; af = Math.min(af + afStep, afMax); }
    } else {
      cur = Math.max(cur, h[i - 1], i >= 2 ? h[i - 2] : h[i - 1]);
      if (h[i] > cur) { up = true; cur = ep; ep = h[i]; af = af0; }
      else if (l[i] < ep) { ep = l[i]; af = Math.min(af + afStep, afMax); }
    }
    sar[i] = cur;
    trend[i] = up ? 1 : -1;
  }
  return { psar: sar, psar_dir: trend };
}
/** Ichimoku Kinko Hyo (Goichi Hosoda). */
export function ichimoku(b: Bars, tenkan = 9, kijun = 26, senkou = 52) {
  const mid = (n: number) => map2(rollingMax(b.h, n), rollingMin(b.l, n), (a, c) => (a + c) / 2);
  const t = mid(tenkan), k = mid(kijun);
  return { tenkan: t, kijun: k, senkou_a: shift(map2(t, k, (a, c) => (a + c) / 2), kijun), senkou_b: shift(mid(senkou), kijun), chikou: shift(b.c, -kijun) };
}

// ---------------------------------------------------------------- volume
/** On-Balance Volume (Joseph Granville). */
export function obv(b: Bars): Series {
  const out: Series = new Array(b.c.length);
  let acc = 0;
  for (let i = 0; i < b.c.length; i++) {
    if (i > 0) acc += Math.sign(b.c[i] - b.c[i - 1]) * b.v[i];
    out[i] = acc;
  }
  return out;
}
/** VWAP: rolling window if n, else anchored per IST session. */
export function vwap(b: Bars, n?: number): Series {
  const tp = typicalPrice(b), pv = tp.map((x, i) => x * b.v[i]);
  if (n) return div(rollingSum(pv, n), rollingSum(b.v, n));
  const out = full(b.c.length);
  for (const r of groupRuns(b.t.map(istDay))) {
    let a = 0, v = 0;
    for (let i = r.start; i < r.end; i++) { a += pv[i]; v += b.v[i]; out[i] = v === 0 ? nan : a / v; }
  }
  return out;
}
/** Chaikin Money Flow (Marc Chaikin). */
export function chaikinMoneyFlow(b: Bars, n = 20): Series {
  const mfv = b.c.map((c, i) => {
    const rng = b.h[i] - b.l[i];
    return rng === 0 ? 0 : (((c - b.l[i]) - (b.h[i] - c)) / rng) * b.v[i];
  });
  return div(rollingSum(mfv, n), rollingSum(b.v, n));
}

// ---------------------------------------------------------------- price structure
export function heikinAshi(b: Bars) {
  const n = b.c.length;
  const haClose = b.c.map((c, i) => (b.o[i] + b.h[i] + b.l[i] + c) / 4);
  const haOpen = new Array(n);
  haOpen[0] = (b.o[0] + b.c[0]) / 2;
  for (let i = 1; i < n; i++) haOpen[i] = (haOpen[i - 1] + haClose[i - 1]) / 2;
  return {
    ha_open: haOpen, ha_close: haClose,
    ha_high: b.h.map((h, i) => Math.max(h, haOpen[i], haClose[i])), ha_low: b.l.map((l, i) => Math.min(l, haOpen[i], haClose[i])),
  };
}

export interface Ref { open: number; high: number; low: number; close: number; volume: number; t: number }
/** The previous session aggregated (intraday) or the previous bar (daily+) - anchors pivots, CPR, Camarilla. */
export function sessionReference(b: Bars, intraday: boolean): Ref | null {
  const n = b.c.length;
  if (n < 2) return null;
  if (!intraday) return { open: b.o[n - 2], high: b.h[n - 2], low: b.l[n - 2], close: b.c[n - 2], volume: b.v[n - 2], t: b.t[n - 2] };
  const runs = groupRuns(b.t.map(istDay));
  if (runs.length < 2) return null;
  const r = runs[runs.length - 2];
  let hi = -Infinity, lo = Infinity, vol = 0;
  for (let i = r.start; i < r.end; i++) { hi = Math.max(hi, b.h[i]); lo = Math.min(lo, b.l[i]); vol += b.v[i]; }
  return { open: b.o[r.start], high: hi, low: lo, close: b.c[r.end - 1], volume: vol, t: b.t[r.start] };
}
const refOrLast = (b: Bars, intraday: boolean): Ref => {
  const n = b.c.length - 1;
  return sessionReference(b, intraday) ?? { open: b.o[n], high: b.h[n], low: b.l[n], close: b.c[n], volume: b.v[n], t: b.t[n] };
};
/** Classic floor-trader pivots. */
export function pivotPoints(b: Bars, intraday = false) {
  const { high: h, low: l, close: c, t } = refOrLast(b, intraday);
  const p = (h + l + c) / 3;
  return { pivot: p, r1: 2 * p - l, s1: 2 * p - h, r2: p + (h - l), s2: p - (h - l), r3: h + 2 * (p - l), s3: l - 2 * (h - p), ref_high: h, ref_low: l, ref_close: c, ref_time: t };
}
/** Central Pivot Range (Frank Ochoa). */
export function cprLevels(b: Bars, intraday = false) {
  const { high: h, low: l, close: c } = refOrLast(b, intraday);
  const p = (h + l + c) / 3, bc = (h + l) / 2, tc = 2 * p - bc;
  const top = Math.max(tc, bc), bottom = Math.min(tc, bc), rng = h - l;
  return { pivot: p, tc: top, bc: bottom, width: top - bottom, width_pct: p ? ((top - bottom) / p) * 100 : 0, narrow: rng > 0 && top - bottom < rng / 12, ref_range: rng };
}
/** Camarilla pivots (Nick Scott, 1989). */
export function camarillaLevels(b: Bars, intraday = false) {
  const { high: h, low: l, close: c } = refOrLast(b, intraday);
  const rng = h - l;
  const out: Record<string, number> = { ref_close: c };
  ([[1, 12], [2, 6], [3, 4], [4, 2]] as const).forEach(([i, k]) => { out[`h${i}`] = c + (rng * 1.1) / k; out[`l${i}`] = c - (rng * 1.1) / k; });
  return out;
}
/** Session VWAP (intraday) or window VWAP, with volume-weighted sigma bands. */
export function vwapBands(b: Bars, intraday = false, window = 20) {
  const n = b.c.length;
  let start = Math.max(0, n - window);
  if (intraday) { const d = istDay(b.t[n - 1]); start = n - 1; while (start > 0 && istDay(b.t[start - 1]) === d) start--; }
  let tv = 0, pv = 0;
  for (let i = start; i < n; i++) { tv += b.v[i] || 0; pv += ((b.h[i] + b.l[i] + b.c[i]) / 3) * (b.v[i] || 0); }
  if (tv <= 0 || n - start < 2) return null;
  const vw = pv / tv;
  let acc = 0;
  for (let i = start; i < n; i++) { const tp = (b.h[i] + b.l[i] + b.c[i]) / 3; acc += (tp - vw) ** 2 * (b.v[i] || 0); }
  const sd = Math.sqrt(acc / tv);
  return { vwap: vw, sd, upper1: vw + sd, lower1: vw - sd, upper2: vw + 2 * sd, lower2: vw - 2 * sd, bars: n - start };
}
/** Volume-at-price profile (Steidlmayer): POC and the 70% value area. */
export function marketProfile(b: Bars, intraday = false, window = 20, bins = 24) {
  const n = b.c.length;
  let s: number, e: number;
  if (intraday) {
    const runs = groupRuns(b.t.map(istDay));
    const r = runs.length >= 2 ? runs[runs.length - 2] : runs[runs.length - 1];
    s = r.start; e = r.end;
  } else if (n > window) { s = n - window - 1; e = n - 1; } else { s = 0; e = n; }
  let lo = Infinity, hi = -Infinity, vs = 0;
  for (let i = s; i < e; i++) { lo = Math.min(lo, b.l[i]); hi = Math.max(hi, b.h[i]); vs += b.v[i] || 0; }
  if (hi <= lo || vs <= 0 || e - s < 2) return null;
  const edges = Array.from({ length: bins + 1 }, (_, i) => lo + ((hi - lo) * i) / bins);
  const vol = new Array(bins).fill(0);
  const searchRight = (x: number) => { let k = 0; while (k < edges.length && edges[k] <= x) k++; return k; };
  const searchLeft = (x: number) => { let k = 0; while (k < edges.length && edges[k] < x) k++; return k; };
  for (let i = s; i < e; i++) {
    const bv = b.v[i] || 0;
    if (bv <= 0) continue;
    const a = Math.min(Math.max(searchRight(b.l[i]) - 1, 0), bins - 1);
    const bb = Math.min(Math.max(searchLeft(b.h[i]) - 1, a), bins - 1);
    for (let k = a; k <= bb; k++) vol[k] += bv / (bb - a + 1);
  }
  let poc = 0;
  for (let k = 1; k < bins; k++) if (vol[k] > vol[poc]) poc = k;
  const total = vol.reduce((x, y) => x + y, 0);
  let area = vol[poc], loI = poc, hiI = poc;
  while (area < 0.7 * total && (loI > 0 || hiI < bins - 1)) {
    const up = hiI < bins - 1 ? vol[hiI + 1] : -1, dn = loI > 0 ? vol[loI - 1] : -1;
    if (up >= dn) { hiI++; area += up; } else { loI--; area += dn; }
  }
  return { poc: (edges[poc] + edges[poc + 1]) / 2, vah: edges[hiI + 1], val: edges[loI], high: hi, low: lo, bars: e - s };
}
/** Bill Williams' Alligator. */
export function alligator(b: Bars) {
  const mp = b.h.map((h, i) => (h + b.l[i]) / 2);
  return { jaw: shift(rma(mp, 13), 8), teeth: shift(rma(mp, 8), 5), lips: shift(rma(mp, 5), 3) };
}
/** Fractal swing highs / lows, `lookback` bars either side. */
export function swingPoints(b: Bars, lookback = 5) {
  const w = 2 * lookback + 1, mx = centeredMax(b.h, w), mn = centeredMin(b.l, w);
  return { swingHigh: b.h.map((h, i) => h === mx[i]), swingLow: b.l.map((l, i) => l === mn[i]) };
}
/** Fibonacci retracements of the last n-bar swing. */
export function fibonacciLevels(b: Bars, n = 100) {
  const s = Math.max(0, b.c.length - n);
  let hi = -Infinity, lo = Infinity, hiI = s, loI = s;
  for (let i = s; i < b.c.length; i++) { if (b.h[i] > hi) { hi = b.h[i]; hiI = i; } if (b.l[i] < lo) { lo = b.l[i]; loI = i; } }
  const upSwing = loI < hiI, d = hi - lo;
  const levels: Record<string, number> = {};
  for (const r of [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1]) levels[r.toFixed(3)] = upSwing ? hi - d * r : lo + d * r;
  return { high: hi, low: lo, up_swing: upSwing, levels };
}
/** Hurst exponent: >0.5 trending, <0.5 mean-reverting. */
export function hurstExponent(close: Series, maxLag = 40): number {
  const s = close.filter(isNum);
  if (s.length < maxLag * 2) return 0.5;
  const xs: number[] = [], ys: number[] = [];
  for (let lag = 2; lag < maxLag; lag++) {
    const d: number[] = [];
    for (let i = lag; i < s.length; i++) d.push(s[i] - s[i - lag]);
    const m = mean(d), sd = Math.sqrt(d.reduce((a, x) => a + (x - m) ** 2, 0) / d.length), tau = Math.sqrt(sd);
    if (tau <= 0) return 0.5;
    xs.push(Math.log(lag)); ys.push(Math.log(tau));
  }
  const mx = mean(xs), my = mean(ys);
  let num = 0, den = 0;
  for (let i = 0; i < xs.length; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  return Math.min(1, Math.max(0, (num / den) * 2));
}

// ---------------------------------------------------------------- bundle (compute_all)
export type Frame = Record<string, Series>;
export function computeAll(b: Bars): Frame {
  const c = b.c, out: Frame = { open: b.o, high: b.h, low: b.l, close: c, volume: b.v };
  for (const n of [10, 20, 50, 100, 200]) out[`sma_${n}`] = sma(c, n);
  for (const n of [9, 12, 13, 21, 26, 50, 200]) out[`ema_${n}`] = ema(c, n);
  out.hma_20 = hma(c, 20);
  out.rsi_14 = rsi(c, 14);
  out.rsi_2 = rsi(c, 2);
  Object.assign(out, macd(c), stochastic(b));
  out.williams_r = williamsR(b);
  out.cci_20 = cci(b);
  out.roc_10 = roc(c, 10);
  out.roc_60 = roc(c, 60);
  out.mfi_14 = mfi(b);
  out.atr_14 = atr(b);
  out.atr_22 = atr(b, 22);
  Object.assign(out, bollinger(c), keltner(b));
  const d20 = donchian(b, 20), d55 = donchian(b, 55);
  Object.assign(out, { dc20_upper: d20.dc_upper, dc20_lower: d20.dc_lower, dc20_mid: d20.dc_mid, dc55_upper: d55.dc_upper, dc55_lower: d55.dc_lower, dc55_mid: d55.dc_mid });
  Object.assign(out, adx(b), supertrend(b), parabolicSar(b), ichimoku(b));
  out.obv = obv(b);
  out.obv_ema = ema(out.obv, 20);
  out.vwap_20 = vwap(b, 20);
  out.cmf_20 = chaikinMoneyFlow(b);
  Object.assign(out, heikinAshi(b));
  out.vol_sma_20 = sma(b.v, 20);
  out.ret_1 = pctChange(c);
  out.volatility_20 = rollingStd(out.ret_1, 20).map((x) => x * Math.sqrt(252));
  return out;
}

export { clip, cumsum };
