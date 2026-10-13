/**
 * Real-world trading strategies - a port of app/strategies.py.
 *
 * Each strategy is a published / widely-used system with its standard parameters.  It reads the
 * indicator frame (computeAll) and returns a Signal: direction (+1 up, -1 down, 0 neutral), a
 * confidence in [0, 1] and a reason citing the rule that fired.
 *
 * Every strategy works on a window [s, e) of the frame, exactly like the Python function on
 * `df.iloc[s:e]`: the last row of the window is "now".  The frame is computed once over the full
 * history (as app/learner.py does), so the learner can evaluate the strategies at many past bars
 * with runWindow() / votesAt() without slicing or recomputing anything; each strategy reads only the
 * rows its rule needs.  Strategies in NEEDS_INTERVAL also receive the bar length in seconds: on
 * intraday charts their levels come from the previous IST *session*, on daily+ charts from the
 * previous bar.
 */
import type { Direction, Signal, StrategyFn, StrategyInput } from './signal';
import { clip } from './signal';
import type { Frame } from './indicators';
import * as ind from './indicators';
import { Bars, istDate, istDay, istTime, sliceBars } from './types';

// ---------------------------------------------------------------- python-compatible helpers
/** Python's f"{x:.{d}f}": nan / inf spelled like Python, exact ties rounded half-to-even, "-0.0" kept. */
export function pyFixed(x: number, d: number): string {
  if (Number.isNaN(x)) return 'nan';
  if (!Number.isFinite(x)) return x > 0 ? 'inf' : '-inf';
  let s = x.toFixed(d);   // exact decimal value of the double, but ties go up
  const m = Math.abs(x) * 10 ** d;
  if (Math.abs((m % 1) - 0.5) < 1e-6 && Math.abs(x) < 1e15) {
    // near a tie: look at the exact expansion; a true tie rounds half-to-even like Python
    const exact = Math.abs(x).toFixed(100), dot = exact.indexOf('.'), fr = exact.slice(dot + 1);
    if (fr[d] === '5' && /^0*$/.test(fr.slice(d + 1))) {
      const t = exact.slice(0, d ? dot + 1 + d : dot);        // truncated: keep it when its last digit is even
      if (Number(t[t.length - 1]) % 2 === 0) s = (x < 0 ? '-' : '') + t;
    }
  }
  if ((x < 0 || Object.is(x, -0)) && !s.startsWith('-')) s = '-' + s;
  return s;
}
/** Signal.to_dict() with Python's rounding (signal.ts signalToJson rounds via Math.round(x * 1e4), which can
 *  differ from Python's round() by one unit in the last place on near-ties). */
export function signalToDict(s: Signal): Signal {
  const clean = (v: unknown): unknown => {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return Number.isFinite(v) ? pyRound(v, 4) : null;
    if (Array.isArray(v)) return v.map(clean);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clean(x)]));
    return v;
  };
  return { ...s, confidence: pyRound(clip(s.confidence), 3), values: clean(s.values) as Record<string, unknown> };
}
/** Python's f"{x:+.{d}f}". */
export const pySigned = (x: number, d: number) => { const s = pyFixed(x, d); return s.startsWith('-') ? s : '+' + s; };
/** Python's round(x, d) (NaN stays NaN). */
export const pyRound = (x: number, d: number) => (Number.isFinite(x) ? Number(pyFixed(x, d)) : x);
/** str(pd.Timestamp) of an IST bar time, first 19 chars ("2026-09-26 09:15:00"). */
export function pyTimestamp(t: number): string {
  const sec = (((t + 19800) % 60) + 60) % 60;
  return `${istDate(t)} ${istTime(t)}:${String(sec).padStart(2, '0')}`;
}

class IndexError extends Error {
  constructor(msg = 'single positional indexer is out-of-bounds') { super(msg); }
}
const toInt = (x: number): Direction => {
  if (!Number.isFinite(x)) throw new Error('cannot convert float NaN to integer');
  return (Math.trunc(x) || 0) as Direction;
};
const sgn = (x: number) => (Number.isNaN(x) ? NaN : Math.sign(x));
/** Python's `float(x) or 1e-9` (NaN is truthy, only 0 is replaced) */
export const orEps = (x: number, eps = 1e-9) => (x === 0 ? eps : x);

/** least-squares line through ys at x = 0..n-1 (np.polyfit(x, y, 1)) -> [slope, intercept] */
export function polyfit1(ys: number[]): [number, number] {
  const n = ys.length, mx = (n - 1) / 2;
  let my = 0;
  for (const y of ys) my += y;
  my /= n;
  let sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) { sxy += (i - mx) * (ys[i] - my); sxx += (i - mx) ** 2; }
  const slope = sxy / sxx;
  return [slope, my - slope * mx];
}

// ---------------------------------------------------------------- window access
/** A view of rows [s, e) of the frame - the Python `df` a strategy receives. */
export interface Win { b: Bars; f: Frame; s: number; e: number; iv: number }
const len = (w: Win) => w.e - w.s;
/** _last(df, col, back) */
function at(w: Win, col: string, back = 0): number {
  const i = w.e - 1 - back;
  if (i < w.s || i >= w.e) throw new IndexError();
  const v = w.f[col][i];
  return v == null ? NaN : v;
}
/** max / min of arr over [a, b) skipping NaN; NaN when empty (pandas). */
function maxOf(arr: number[], a: number, b: number): number {
  let m = NaN;
  for (let i = a; i < b; i++) if (!Number.isNaN(arr[i]) && !(arr[i] <= m)) m = arr[i];
  return m;
}
function minOf(arr: number[], a: number, b: number): number {
  let m = NaN;
  for (let i = a; i < b; i++) if (!Number.isNaN(arr[i]) && !(arr[i] >= m)) m = arr[i];
  return m;
}
function sumOf(arr: number[], a: number, b: number): number {
  let t = 0;
  for (let i = a; i < b; i++) if (!Number.isNaN(arr[i])) t += arr[i];
  return t;
}
/** first row of tail(n) inside the window */
const tail = (w: Win, n: number) => Math.max(w.s, w.e - n);
/** _slope(series, n) on rows [a, e): OLS slope of the last n non-NaN values, 0 if fewer than 3. */
function slopeOf(arr: number[], a: number, e: number, n: number): number {
  const ys: number[] = [];
  for (let i = e - 1; i >= a && ys.length < n; i--) if (!Number.isNaN(arr[i])) ys.push(arr[i]);
  if (ys.length < 3) return 0;
  return polyfit1(ys.reverse())[0];
}
/** first row of the IST session that row i belongs to (within the window) */
function sessionStart(w: Win, i: number): number {
  const d = istDay(w.b.t[i]);
  let k = i;
  while (k > w.s && istDay(w.b.t[k - 1]) === d) k--;
  return k;
}
/** the rows the previous-session / previous-bar level functions look at: the last two sessions (intraday) or two bars */
function levelRows(w: Win, intraday: boolean): { a: number; prev: number | null } {
  if (!intraday) return { a: Math.max(w.s, w.e - 2), prev: w.e - w.s >= 2 ? w.e - 2 : null };
  const cs = sessionStart(w, w.e - 1);
  if (cs <= w.s) return { a: cs, prev: null };
  return { a: sessionStart(w, cs - 1), prev: sessionStart(w, cs - 1) };
}

/** pivot_points(df, intraday) of the window, with Python's ref_time string (the reference session's date or bar time). */
export function pivotsAt(w: Win, intraday: boolean) {
  const { a, prev } = levelRows(w, intraday);
  const { ref_time: _t, ...pv } = ind.pivotPoints(sliceBars(w.b, a, w.e), intraday);
  const refTime = prev == null ? pyTimestamp(w.b.t[w.e - 1]) : intraday ? `${istDate(w.b.t[prev])} 00:00:00` : pyTimestamp(w.b.t[prev]);
  return { ...pv, ref_time: refTime };
}
export const cprAt = (w: Win, intraday: boolean) => ind.cprLevels(sliceBars(w.b, levelRows(w, intraday).a, w.e), intraday);
export const camarillaAt = (w: Win, intraday: boolean) => ind.camarillaLevels(sliceBars(w.b, levelRows(w, intraday).a, w.e), intraday);
export const vwapBandsAt = (w: Win, intraday: boolean) =>
  ind.vwapBands(sliceBars(w.b, intraday ? sessionStart(w, w.e - 1) : tail(w, 20), w.e), intraday);
export const marketProfileAt = (w: Win, intraday: boolean) =>
  ind.marketProfile(sliceBars(w.b, intraday ? levelRows(w, true).a : tail(w, 21), w.e), intraday);
export const fibonacciAt = (w: Win, n = 100) => ind.fibonacciLevels(sliceBars(w.b, tail(w, n), w.e), n);

// ---------------------------------------------------------------- signal construction
interface Meta { name: string; origin: string; category: string; rules: string }
type Emit = (direction: number, confidence: number, reason: string, values?: Record<string, unknown>) => Signal;
const emitter = (key: string, m: Meta): Emit => (direction, confidence, reason, values = {}) => ({
  key, name: m.name, origin: m.origin, category: m.category, direction: toInt(direction), confidence, reason, rules: m.rules, values,
});
const f0 = (x: number) => pyFixed(x, 0), f1 = (x: number) => pyFixed(x, 1), f2 = (x: number) => pyFixed(x, 2);

// =============================================================================
//  TREND STRATEGIES
// =============================================================================

function goldenCross(w: Win): Signal {
  const s50 = at(w, 'sma_50'), s200 = at(w, 'sma_200'), c = at(w, 'close');
  const sig = emitter('golden_cross', { name: 'Golden / Death Cross', origin: 'Classic institutional trend rule (SMA 50/200)', category: 'trend', rules: 'Bullish when SMA50 > SMA200 and price above both; bearish when SMA50 < SMA200 and price below.' });
  if (Number.isNaN(s200)) return sig(0, 0, 'Not enough history for SMA200');
  const spread = (s50 - s200) / s200;
  const a = w.f.sma_50, b = w.f.sma_200;
  let flips = 0;
  for (let i = Math.max(w.s + 1, w.e - 10); i < w.e; i++) { const d = Math.abs(sgn(a[i] - b[i]) - sgn(a[i - 1] - b[i - 1])); if (!Number.isNaN(d)) flips += d; }
  const recent = flips > 0;
  const conf = clip(0.45 + Math.abs(spread) * 5 + (recent ? 0.25 : 0));
  if (s50 > s200 && c > s50)
    return sig(1, conf, `SMA50 above SMA200 by ${f1(spread * 100)}%; price above SMA50` + (recent ? ' (fresh golden cross)' : ''), { sma50: s50, sma200: s200, spread_pct: spread * 100 });
  if (s50 < s200 && c < s50)
    return sig(-1, conf, `SMA50 below SMA200 by ${f1(Math.abs(spread) * 100)}%; price below SMA50` + (recent ? ' (fresh death cross)' : ''), { sma50: s50, sma200: s200, spread_pct: spread * 100 });
  return sig(0, 0.2, 'Price and moving averages not aligned', { sma50: s50, sma200: s200 });
}

function emaCrossover(w: Win): Signal {
  const e9 = w.f.ema_9, e21 = w.f.ema_21;
  if (len(w) < 1) throw new IndexError();
  const lastD = sgn(e9[w.e - 1] - e21[w.e - 1]);
  let barsSince = len(w);
  for (let i = w.e - 1; i >= w.s; i--) { const d = sgn(e9[i] - e21[i]); if (!(d === lastD)) { barsSince = w.e - 1 - i; break; } }
  const c = at(w, 'close');
  const gap = (at(w, 'ema_9') - at(w, 'ema_21')) / c;
  const sig = emitter('ema_crossover', { name: 'EMA 9/21 Crossover', origin: 'Common swing-trading fast/slow EMA system', category: 'trend', rules: 'Long when EMA9 crosses above EMA21; short when it crosses below. Fresher crosses score higher.' });
  if (Number.isNaN(gap)) return sig(0, 0, 'Insufficient data');
  const fresh = Math.max(0, 1 - barsSince / 15);
  const conf = clip(0.35 + fresh * 0.4 + Math.abs(gap) * 20);
  const d = toInt(lastD);
  return sig(d, conf, `EMA9 ${d > 0 ? 'above' : 'below'} EMA21 for ${barsSince} bars (gap ${f2(gap * 100)}%)`,
    { ema9: at(w, 'ema_9'), ema21: at(w, 'ema_21'), bars_since_cross: barsSince });
}

function macdStrategy(w: Win): Signal {
  const m = at(w, 'macd'), s = at(w, 'macd_signal'), h = at(w, 'macd_hist'), hPrev = at(w, 'macd_hist', 1);
  const sig = emitter('macd', { name: 'MACD Crossover', origin: 'Gerald Appel (1979), 12/26/9', category: 'momentum', rules: 'Bullish: MACD above signal (esp. above zero) with rising histogram. Bearish: the reverse.' });
  if (Number.isNaN(h)) return sig(0, 0, 'Insufficient data');
  const cross = (i: number) => sgn(w.f.macd[i] - w.f.macd_signal[i]);
  let fresh = false;
  if (len(w) > 4) {
    // Series.mode() of the three previous signs: most frequent, smallest on ties, NaN dropped
    const cnt = new Map<number, number>();
    for (let i = w.e - 4; i < w.e - 1; i++) { const v = cross(i); if (!Number.isNaN(v)) cnt.set(v || 0, (cnt.get(v || 0) ?? 0) + 1); }
    if (!cnt.size) throw new IndexError();
    let mode = NaN, best = -1;
    for (const [v, k] of [...cnt.entries()].sort((a, b) => a[0] - b[0])) if (k > best) { best = k; mode = v; }
    fresh = cross(w.e - 1) !== mode;
  }
  const price = at(w, 'close');
  const strength = clip((Math.abs(h) / price) * 300);
  if (m > s) {
    const conf = clip(0.35 + strength + (fresh ? 0.2 : 0) + (m > 0 ? 0.1 : 0) + (h > hPrev ? 0.1 : 0));
    return sig(1, conf, `MACD above signal${fresh ? ' (fresh bullish cross)' : ''}; ${m > 0 ? 'above' : 'below'} zero line; histogram ${h > hPrev ? 'rising' : 'fading'}`, { macd: m, signal: s, hist: h });
  }
  const conf = clip(0.35 + strength + (fresh ? 0.2 : 0) + (m < 0 ? 0.1 : 0) + (h < hPrev ? 0.1 : 0));
  return sig(-1, conf, `MACD below signal${fresh ? ' (fresh bearish cross)' : ''}; ${m < 0 ? 'below' : 'above'} zero line; histogram ${h < hPrev ? 'falling' : 'recovering'}`, { macd: m, signal: s, hist: h });
}

function adxDmi(w: Win): Signal {
  const a = at(w, 'adx'), p = at(w, 'plus_di'), m = at(w, 'minus_di');
  const sig = emitter('adx_dmi', { name: 'ADX / DMI Trend', origin: 'J. Welles Wilder (1978), 14-period', category: 'trend', rules: 'ADX > 25 = trending. +DI > -DI bullish, -DI > +DI bearish. ADX < 20 = no trend (neutral).' });
  if (Number.isNaN(a)) return sig(0, 0, 'Insufficient data');
  if (a < 20) return sig(0, 0.4, `ADX ${f1(a)} < 20: range-bound, no trend to follow`, { adx: a, plus_di: p, minus_di: m });
  const d = p > m ? 1 : -1;
  const rising = slopeOf(w.f.adx, w.s, w.e, 5) > 0;
  const conf = clip(0.3 + (a - 20) / 40 + (rising ? 0.15 : 0) + Math.abs(p - m) / 100);
  return sig(d, conf, `ADX ${f1(a)} (${rising ? 'strengthening' : 'weakening'}) with ${d > 0 ? '+DI' : '-DI'} dominant (${f1(p)} vs ${f1(m)})`, { adx: a, plus_di: p, minus_di: m });
}

function supertrendStrategy(w: Win): Signal {
  const d = at(w, 'supertrend_dir'), st = at(w, 'supertrend'), c = at(w, 'close');
  const sig = emitter('supertrend', { name: 'Supertrend', origin: 'Olivier Seban; ATR(10) x 3', category: 'trend', rules: 'Long while close is above the Supertrend line; short while below. Flips on close crossing the line.' });
  if (Number.isNaN(st) || d === 0) return sig(0, 0, 'Insufficient data');
  const dir = w.f.supertrend_dir;
  let flips = 0;
  for (let i = Math.max(w.s + 1, w.e - 5); i < w.e; i++) { const x = Math.abs(dir[i] - dir[i - 1]); if (!Number.isNaN(x)) flips += x; }
  const dist = Math.abs(c - st) / c;
  const conf = clip(0.45 + dist * 8 + (flips > 0 ? 0.15 : 0));
  return sig(d, conf, `Price ${d > 0 ? 'above' : 'below'} Supertrend (${f2(st)}), ${f1(dist * 100)}% away` + (flips > 0 ? ' - recent flip' : ''), { supertrend: st, direction: d });
}

function parabolicSarStrategy(w: Win): Signal {
  const d = at(w, 'psar_dir'), ps = at(w, 'psar'), c = at(w, 'close');
  const sig = emitter('parabolic_sar', { name: 'Parabolic SAR', origin: 'J. Welles Wilder (1978), AF 0.02 step, 0.20 max', category: 'trend', rules: 'Dots below price = uptrend (long); dots above price = downtrend (short).' });
  if (Number.isNaN(ps)) return sig(0, 0, 'Insufficient data');
  // int((psar_dir == d)[::-1].argmin() or len(df))
  let k = 0;
  while (k < len(w) && w.f.psar_dir[w.e - 1 - k] === d) k++;
  const run = k === 0 || k === len(w) ? len(w) : k;
  const conf = clip(0.4 + Math.min(run, 20) / 50 + (Math.abs(c - ps) / c) * 5);
  return sig(d, conf, `SAR ${d > 0 ? 'below' : 'above'} price for ${run} bars (SAR ${f2(ps)})`, { psar: ps, bars_in_trend: run });
}

function ichimokuStrategy(w: Win): Signal {
  const c = at(w, 'close'), t = at(w, 'tenkan'), k = at(w, 'kijun'), sa = at(w, 'senkou_a'), sb = at(w, 'senkou_b');
  const sig = emitter('ichimoku', { name: 'Ichimoku Cloud', origin: 'Goichi Hosoda (1960s), 9/26/52', category: 'trend', rules: 'Bullish: price above cloud, Tenkan > Kijun, green cloud (A > B). Bearish: the mirror. Inside cloud = neutral.' });
  if ([sa, sb, t, k].some(Number.isNaN)) return sig(0, 0, 'Insufficient data');
  const top = Math.max(sa, sb), bot = Math.min(sa, sb);
  let score = 0;
  const parts: string[] = [];
  if (c > top) { score += 2; parts.push('price above cloud'); } else if (c < bot) { score -= 2; parts.push('price below cloud'); } else parts.push('price inside cloud');
  if (t > k) { score += 1; parts.push('Tenkan > Kijun'); } else { score -= 1; parts.push('Tenkan < Kijun'); }
  if (sa > sb) { score += 1; parts.push('bullish (green) cloud'); } else { score -= 1; parts.push('bearish (red) cloud'); }
  // Chikou (lagging span) confirmation: today's close vs close 26 bars ago
  if (len(w) > 27) {
    if (c > at(w, 'close', 26)) { score += 1; parts.push('Chikou above price'); } else { score -= 1; parts.push('Chikou below price'); }
  }
  const d = score >= 2 ? 1 : score <= -2 ? -1 : 0;
  const conf = clip(Math.abs(score) / 5);
  return sig(d, d ? conf : 0.3, parts.join(', '), { tenkan: t, kijun: k, senkou_a: sa, senkou_b: sb, score });
}

function hullMaTrend(w: Win): Signal {
  const h = at(w, 'hma_20'), hp = at(w, 'hma_20', 2), c = at(w, 'close');
  const sig = emitter('hull_ma', { name: 'Hull MA Slope', origin: 'Alan Hull (2005), HMA 20', category: 'trend', rules: 'Long when HMA is rising and price above it; short when falling and price below.' });
  if (Number.isNaN(h) || Number.isNaN(hp)) return sig(0, 0, 'Insufficient data');
  const slope = (h - hp) / c;
  const d = slope > 0 ? 1 : -1;
  const agree = d > 0 ? c > h : c < h;
  const conf = clip(0.3 + Math.abs(slope) * 100 + (agree ? 0.2 : -0.1));
  return sig(d, conf, `HMA20 ${d > 0 ? 'rising' : 'falling'} (${f2(slope * 100)}%/bar); price ${c > h ? 'above' : 'below'} HMA`, { hma20: h, slope_pct: slope * 100 });
}

function elderTripleScreen(w: Win): Signal {
  const sig = emitter('elder_triple_screen', { name: 'Elder Triple Screen', origin: "Dr. Alexander Elder, 'Trading for a Living' (1993)", category: 'trend', rules: 'Screen 1: higher-timeframe trend via EMA13 slope & MACD histogram. Screen 2: buy pullbacks (Stoch < 30) in uptrend, sell rallies (Stoch > 70) in downtrend.' });
  // Higher timeframe: aggregate 5 bars into one (the last close of each block, blocks aligned to the end)
  const n = Math.floor(len(w) / 5) * 5;
  if (n < 100) return sig(0, 0, 'Insufficient data');
  const hs: number[] = [];
  for (let i = w.e - n + 4; i < w.e; i += 5) hs.push(w.b.c[i]);
  const ema13 = ind.ema(hs, 13), mh = ind.macd(hs).macd_hist, L = hs.length - 1;
  let tide = 0;
  if (ema13[L] > ema13[L - 1] && mh[L] > mh[L - 1]) tide = 1;
  else if (ema13[L] < ema13[L - 1] && mh[L] < mh[L - 1]) tide = -1;
  const k = at(w, 'stoch_k');
  if (tide === 0) return sig(0, 0.3, 'Higher-timeframe EMA13 and MACD histogram disagree: no tide', { stoch_k: k });
  if (tide > 0) {
    const pullback = k < 30;
    const conf = clip(0.5 + (pullback ? 0.35 : 0) - (k > 80 ? 0.15 : 0));
    return sig(1, conf, `Weekly-equivalent tide up (EMA13 rising, MACD-hist rising); Stoch ${f0(k)}${pullback ? ' = pullback entry zone' : ''}`, { stoch_k: k, tide });
  }
  const rally = k > 70;
  const conf = clip(0.5 + (rally ? 0.35 : 0) - (k < 20 ? 0.15 : 0));
  return sig(-1, conf, `Weekly-equivalent tide down (EMA13 falling, MACD-hist falling); Stoch ${f0(k)}${rally ? ' = rally short zone' : ''}`, { stoch_k: k, tide });
}

function chandelierExit(w: Win): Signal {
  const c = at(w, 'close'), a = at(w, 'atr_22');
  const sig = emitter('chandelier_exit', { name: 'Chandelier Exit', origin: 'Chuck LeBeau; 22-period high/low, 3 x ATR(22)', category: 'volatility', rules: 'Stay long while close > 22-bar high - 3 ATR; stay short while close < 22-bar low + 3 ATR.' });
  if (Number.isNaN(a)) return sig(0, 0, 'Insufficient data');
  const full = len(w) >= 22;
  const hh = full ? maxOf(w.b.h, w.e - 22, w.e) : NaN, ll = full ? minOf(w.b.l, w.e - 22, w.e) : NaN;
  const longStop = hh - 3 * a, shortStop = ll + 3 * a;
  const values = { long_stop: longStop, short_stop: shortStop };
  if (c > longStop && c > shortStop) return sig(1, clip(0.4 + ((c - longStop) / (3 * a)) * 0.4), `Close above long chandelier stop ${f2(longStop)}`, values);
  if (c < shortStop && c < longStop) return sig(-1, clip(0.4 + ((shortStop - c) / (3 * a)) * 0.4), `Close below short chandelier stop ${f2(shortStop)}`, values);
  return sig(0, 0.3, 'Price between chandelier stops (no regime)', values);
}

function heikinAshiTrend(w: Win): Signal {
  const { ha_open: ho, ha_close: hc, ha_high: hh, ha_low: hl } = w.f;
  const a = tail(w, 6), i = w.e - 1;
  if (i < w.s) throw new IndexError();
  const color = (j: number) => sgn(hc[j] - ho[j]);
  const last = toInt(color(i));
  const sig = emitter('heikin_ashi', { name: 'Heikin-Ashi Trend', origin: "Japanese 'average bar' charting; widely used trend filter", category: 'price_action', rules: 'Consecutive same-colour HA candles = trend. No lower wick (bull) / no upper wick (bear) = strong.' });
  if (last === 0) return sig(0, 0.2, 'Doji-like HA candle');
  let run = 0;
  for (let j = i; j >= a && color(j) === last; j--) run++;
  const strong = last > 0 ? hl[i] >= Math.min(ho[i], hc[i]) * 0.9995 : hh[i] <= Math.max(ho[i], hc[i]) * 1.0005;
  const conf = clip(0.3 + run * 0.1 + (strong ? 0.2 : 0));
  return sig(last, conf, `${run} consecutive ${last > 0 ? 'green' : 'red'} HA candles${strong ? ' with no opposing wick (strong)' : ''}`, { run });
}

// =============================================================================
//  MOMENTUM / OSCILLATOR STRATEGIES
// =============================================================================

function rsiWilder(w: Win): Signal {
  const r = at(w, 'rsi_14');
  at(w, 'close');
  const sig = emitter('rsi_wilder', { name: 'RSI 14 (Wilder)', origin: 'J. Welles Wilder (1978)', category: 'momentum', rules: 'RSI < 30 oversold (bullish reversal), > 70 overbought (bearish). Between: RSI > 50 bullish bias, < 50 bearish. Divergence strengthens the call.' });
  if (Number.isNaN(r)) return sig(0, 0, 'Insufficient data');
  // divergence over last 20 bars
  const a = tail(w, 20), c = w.b.c, R = w.f.rsi_14, cl = c[w.e - 1], rl = R[w.e - 1];
  const priceHH = cl >= maxOf(c, a, w.e) * 0.995, priceLL = cl <= minOf(c, a, w.e) * 1.005;
  const rsiLH = rl < maxOf(R, a, w.e) - 3, rsiHL = rl > minOf(R, a, w.e) + 3;
  if (r < 30) return sig(1, clip(0.5 + (30 - r) / 30 + (priceLL && rsiHL ? 0.2 : 0)), `RSI ${f1(r)} oversold` + (priceLL && rsiHL ? ' with bullish divergence' : ''), { rsi: r });
  if (r > 70) return sig(-1, clip(0.5 + (r - 70) / 30 + (priceHH && rsiLH ? 0.2 : 0)), `RSI ${f1(r)} overbought` + (priceHH && rsiLH ? ' with bearish divergence' : ''), { rsi: r });
  const d = r > 50 ? 1 : -1;
  if (priceHH && rsiLH) return sig(-1, 0.45, `Bearish RSI divergence (price at highs, RSI ${f1(r)} lower high)`, { rsi: r });
  if (priceLL && rsiHL) return sig(1, 0.45, `Bullish RSI divergence (price at lows, RSI ${f1(r)} higher low)`, { rsi: r });
  return sig(d, clip(0.15 + Math.abs(r - 50) / 60), `RSI ${f1(r)} ${d > 0 ? 'above' : 'below'} 50 midline (mild ${d > 0 ? 'bullish' : 'bearish'} bias)`, { rsi: r });
}

function connorsRsi2(w: Win): Signal {
  const r2 = at(w, 'rsi_2'), c = at(w, 'close');
  let s200 = at(w, 'sma_200');
  const s5 = len(w) >= 5 ? sumOf(w.b.c, w.e - 5, w.e) / 5 : NaN;
  const sig = emitter('connors_rsi2', { name: 'Connors RSI-2', origin: "Larry Connors & Cesar Alvarez, 'Short Term Trading Strategies That Work' (2008)", category: 'momentum', rules: 'Long: close > SMA200 and RSI(2) < 10 (extreme 5). Short: close < SMA200 and RSI(2) > 90. Exit when price crosses SMA5.' });
  if (Number.isNaN(s200)) {
    // fall back to SMA100 as long-term filter when history is short
    s200 = at(w, 'sma_100');
    if (Number.isNaN(s200)) return sig(0, 0, 'Needs 200-bar history for trend filter');
  }
  if (c > s200 && r2 < 10) return sig(1, clip(0.55 + (10 - r2) / 20), `Above SMA200 with RSI(2) ${f1(r2)} < 10: oversold pullback in uptrend`, { rsi2: r2, sma200: s200, sma5: s5 });
  if (c < s200 && r2 > 90) return sig(-1, clip(0.55 + (r2 - 90) / 20), `Below SMA200 with RSI(2) ${f1(r2)} > 90: overbought bounce in downtrend`, { rsi2: r2, sma200: s200, sma5: s5 });
  return sig(0, 0.25, `No setup (RSI2 ${f1(r2)}, price ${c > s200 ? 'above' : 'below'} SMA200)`, { rsi2: r2, sma200: s200 });
}

function stochasticLane(w: Win): Signal {
  const k = at(w, 'stoch_k'), d = at(w, 'stoch_d'), kp = at(w, 'stoch_k', 1), dp = at(w, 'stoch_d', 1);
  const sig = emitter('stochastic', { name: 'Stochastic Oscillator', origin: 'George Lane (1950s), 14/3/3', category: 'momentum', rules: 'Bullish: %K crosses above %D below 20. Bearish: %K crosses below %D above 80. Mid-range crosses are weaker.' });
  if (Number.isNaN(k) || Number.isNaN(dp)) return sig(0, 0, 'Insufficient data');
  const v = { k, d };
  if (kp <= dp && k > d) return sig(1, clip(0.35 + (k < 25 ? 0.4 : 0.1)), `%K crossed above %D at ${f0(k)}${k < 25 ? ' (oversold zone)' : ''}`, v);
  if (kp >= dp && k < d) return sig(-1, clip(0.35 + (k > 75 ? 0.4 : 0.1)), `%K crossed below %D at ${f0(k)}${k > 75 ? ' (overbought zone)' : ''}`, v);
  if (k < 20) return sig(1, 0.35, `Stochastic ${f0(k)} oversold, awaiting cross`, v);
  if (k > 80) return sig(-1, 0.35, `Stochastic ${f0(k)} overbought, awaiting cross`, v);
  const dd = k > d ? 1 : -1;
  return sig(dd, 0.15, `%K ${dd > 0 ? 'above' : 'below'} %D mid-range (${f0(k)})`, v);
}

function cciLambert(w: Win): Signal {
  const v = at(w, 'cci_20'), vp = at(w, 'cci_20', 1);
  const sig = emitter('cci', { name: 'CCI (Lambert)', origin: 'Donald Lambert (1980), 20-period', category: 'momentum', rules: 'Cross above +100 = bullish momentum; cross below -100 = bearish. Beyond +/-200 = exhaustion.' });
  if (Number.isNaN(v)) return sig(0, 0, 'Insufficient data');
  const vals = { cci: v };
  if (v > 200) return sig(-1, 0.4, `CCI ${f0(v)} > 200: exhaustion, reversal risk`, vals);
  if (v < -200) return sig(1, 0.4, `CCI ${f0(v)} < -200: capitulation, reversal potential`, vals);
  if (v > 100) return sig(1, clip(0.4 + (vp <= 100 ? 0.2 : 0) + (v - 100) / 300), `CCI ${f0(v)} above +100${vp <= 100 ? ' (fresh cross)' : ''}`, vals);
  if (v < -100) return sig(-1, clip(0.4 + (vp >= -100 ? 0.2 : 0) + (-100 - v) / 300), `CCI ${f0(v)} below -100${vp >= -100 ? ' (fresh cross)' : ''}`, vals);
  return sig(Math.sign(v), 0.15, `CCI ${f0(v)} inside +/-100 band`, vals);
}

function williamsRStrategy(w: Win): Signal {
  const r = at(w, 'williams_r');
  const sig = emitter('williams_r', { name: 'Williams %R', origin: 'Larry Williams, 14-period', category: 'momentum', rules: 'Below -80 oversold (bullish), above -20 overbought (bearish).' });
  if (Number.isNaN(r)) return sig(0, 0, 'Insufficient data');
  if (r < -80) return sig(1, clip(0.4 + (-80 - r) / 40), `%R ${f0(r)} oversold`, { williams_r: r });
  if (r > -20) return sig(-1, clip(0.4 + (r + 20) / 40), `%R ${f0(r)} overbought`, { williams_r: r });
  return sig(r > -50 ? 1 : -1, 0.15, `%R ${f0(r)} mid-range`, { williams_r: r });
}

function momentum121(w: Win): Signal {
  if (len(w) < 70) return { key: 'momentum_12_1', name: 'Academic Momentum (12-1)', origin: 'Jegadeesh & Titman (1993)', category: 'momentum', direction: 0, confidence: 0, reason: 'Insufficient data', rules: '', values: {} };
  const c = w.b.c, e = w.e;
  const mom = c[e - 6] / c[e - 66] - 1;
  const rets: number[] = [];
  for (let i = e - 60; i < e; i++) rets.push(c[i - 1] === 0 ? NaN : c[i] / c[i - 1] - 1);
  const m = rets.reduce((x, y) => x + y, 0) / rets.length;
  const vol = orEps(Math.sqrt(rets.reduce((x, y) => x + (y - m) ** 2, 0) / (rets.length - 1)) * Math.sqrt(60));
  const z = mom / vol;
  const sig = emitter('momentum_12_1', { name: 'Academic Momentum (12-1)', origin: 'Jegadeesh & Titman (1993); 60-bar lookback skipping last 5', category: 'momentum', rules: 'Positive trailing return (excluding the most recent bars) predicts continuation; negative predicts further weakness.' });
  return sig(mom > 0 ? 1 : -1, clip(0.25 + Math.abs(z) * 0.35), `Trailing 60-bar return (skip 5) ${pySigned(mom * 100, 1)}%, vol-adjusted ${pySigned(z, 2)}`, { momentum_pct: mom * 100, z });
}

function fiftyTwoWeekHigh(w: Win): Signal {
  const n = Math.min(len(w), 252), a = w.e - n;
  const hi = maxOf(w.b.h, a, w.e), lo = minOf(w.b.l, a, w.e), c = at(w, 'close');
  const ratio = c / hi, pos = hi > lo ? (c - lo) / (hi - lo) : 0.5;
  const sig = emitter('fifty_two_week_high', { name: '52-Week High Momentum', origin: 'George & Hwang, Journal of Finance (2004)', category: 'momentum', rules: 'Price within ~5% of its 52-week high = bullish anchoring effect; near the 52-week low = bearish.' });
  const vals = { high: hi, low: lo, ratio };
  if (ratio > 0.95) return sig(1, clip(0.4 + (ratio - 0.95) * 8), `Price at ${f1(ratio * 100)}% of ${n}-bar high`, vals);
  if (pos < 0.15) return sig(-1, clip(0.4 + (0.15 - pos) * 2), `Price in bottom ${f0(pos * 100)}% of ${n}-bar range`, vals);
  return sig(pos > 0.5 ? 1 : -1, 0.15, `Price at ${f0(pos * 100)}% of ${n}-bar range`, vals);
}

// =============================================================================
//  VOLATILITY / BREAKOUT STRATEGIES
// =============================================================================

function bollingerBreakout(w: Win): Signal {
  const bw = at(w, 'bb_width'), u = at(w, 'bb_upper'), l = at(w, 'bb_lower'), c = at(w, 'close');
  const sig = emitter('bollinger_breakout', { name: 'Bollinger Squeeze Breakout', origin: "John Bollinger, 'Bollinger on Bollinger Bands' (2001); 20/2", category: 'volatility', rules: 'BandWidth at multi-period low = squeeze. Close above upper band = bullish breakout; below lower = bearish. Walking the band continues the trend.' });
  if (Number.isNaN(bw)) return sig(0, 0, 'Insufficient data');
  const bwMin = minOf(w.f.bb_width, tail(w, 120), w.e);
  const squeeze = bw <= bwMin * 1.25;
  const recently = minOf(w.f.bb_width, tail(w, 10), w.e) <= bwMin * 1.25;
  const conf = clip(0.45 + (recently ? 0.3 : 0));
  if (c > u) return sig(1, conf, `Close above upper band${recently ? ' after squeeze' : ' (walking the band)'}`, { bandwidth: bw, upper: u, lower: l });
  if (c < l) return sig(-1, conf, `Close below lower band${recently ? ' after squeeze' : ' (walking the band)'}`, { bandwidth: bw, upper: u, lower: l });
  if (squeeze) return sig(0, 0.5, `Squeeze in progress (BandWidth ${pyFixed(bw, 3)} near 120-bar low) - breakout pending, direction unknown`, { bandwidth: bw });
  return sig(0, 0.15, 'Inside bands, no squeeze', { bandwidth: bw });
}

function bollingerMeanReversion(w: Win): Signal {
  const pct = at(w, 'bb_pct'), a = at(w, 'adx'), r = at(w, 'rsi_14');
  const sig = emitter('bollinger_mr', { name: 'Bollinger %B Mean Reversion', origin: 'John Bollinger; classic range-trading application (with ADX < 25 filter)', category: 'volatility', rules: 'In a non-trending market (ADX < 25), %B < 0 = buy back toward the middle band; %B > 1 = sell.' });
  if (Number.isNaN(pct) || Number.isNaN(a)) return sig(0, 0, 'Insufficient data');
  const trending = a >= 25, vals = { pct_b: pct, adx: a };
  const note = trending ? ', but ADX trending - weaker' : ', ADX low (range)';
  if (pct < 0.05) return sig(1, clip((trending ? 0.25 : 0.55) + (r < 35 ? 0.15 : 0)), `%B ${f2(pct)} at/below lower band${note}`, vals);
  if (pct > 0.95) return sig(-1, clip((trending ? 0.25 : 0.55) + (r > 65 ? 0.15 : 0)), `%B ${f2(pct)} at/above upper band${note}`, vals);
  return sig(0, 0.15, `%B ${f2(pct)} inside bands`, vals);
}

function ttmSqueeze(w: Win): Signal {
  const bu = at(w, 'bb_upper'), bl = at(w, 'bb_lower'), ku = at(w, 'kc_upper'), kl = at(w, 'kc_lower');
  const sig = emitter('ttm_squeeze', { name: 'TTM Squeeze', origin: "John Carter, 'Mastering the Trade' (2005); BB(20,2) inside KC(20,1.5)", category: 'volatility', rules: 'Squeeze ON when Bollinger Bands sit inside Keltner Channels. When it releases, trade the direction of the momentum histogram (linear regression of price vs. midline).' });
  if ([bu, bl, ku, kl].some(Number.isNaN)) return sig(0, 0, 'Insufficient data');
  const f = w.f;
  const on = (i: number) => f.bb_upper[i] < f.kc_upper[i] && f.bb_lower[i] > f.kc_lower[i];
  // momentum: close minus mean of (donchian mid, sma20) regressed over 20 bars
  const ms: number[] = [];
  for (let i = tail(w, 20); i < w.e; i++) { const v = f.close[i] - (f.dc20_mid[i] + f.sma_20[i]) / 2; if (!Number.isNaN(v)) ms.push(v); }
  let mom = 0;
  if (ms.length >= 5) { const [sl, ic] = polyfit1(ms); mom = sl * (ms.length - 1) + ic; }
  const d = mom > 0 ? 1 : -1;
  if (on(w.e - 1)) return sig(0, 0.45, `Squeeze ON (volatility compressed); momentum leaning ${d > 0 ? 'up' : 'down'} - wait for release`, { squeeze_on: true, momentum: mom });
  let released = false;
  for (let i = tail(w, 6); i < w.e - 1; i++) if (on(i)) released = true;
  const conf = clip(0.3 + (released ? 0.4 : 0) + (Math.abs(mom) / at(w, 'close')) * 20);
  return sig(d, conf, `Squeeze ${released ? 'just fired' : 'off'}; momentum ${d > 0 ? 'positive' : 'negative'}`, { squeeze_on: false, momentum: mom, fired: released });
}

function turtleBreakout(w: Win): Signal {
  const c = at(w, 'close'), u20 = at(w, 'dc20_upper', 1), l20 = at(w, 'dc20_lower', 1), u55 = at(w, 'dc55_upper', 1), l55 = at(w, 'dc55_lower', 1);
  const sig = emitter('turtle', { name: 'Turtle Breakout (Donchian)', origin: 'Richard Dennis & William Eckhardt (1983); Donchian 20/55, exit 10', category: 'volatility', rules: 'Buy a close above the prior 20-bar high (55-bar for System 2); sell a close below the prior 20-bar low. Exit on a 10-bar reverse breakout.' });
  if (Number.isNaN(u55)) return sig(0, 0, 'Insufficient data');
  const hi10 = maxOf(w.b.h, tail(w, 11), w.e - 1), lo10 = minOf(w.b.l, tail(w, 11), w.e - 1);
  if (c > u55) return sig(1, 0.8, 'Close above 55-bar high (System 2 entry)', { dc55_high: u55, dc20_high: u20 });
  if (c < l55) return sig(-1, 0.8, 'Close below 55-bar low (System 2 entry)', { dc55_low: l55, dc20_low: l20 });
  if (c > u20) return sig(1, 0.65, 'Close above 20-bar high (System 1 entry)', { dc20_high: u20 });
  if (c < l20) return sig(-1, 0.65, 'Close below 20-bar low (System 1 entry)', { dc20_low: l20 });
  // In-position logic: where is price relative to the channel
  const pos = u20 > l20 ? (c - l20) / (u20 - l20) : 0.5;
  if (c < lo10 && pos > 0.5) return sig(-1, 0.35, '10-bar low broken: long exit signal', { pos });
  if (c > hi10 && pos < 0.5) return sig(1, 0.35, '10-bar high broken: short exit signal', { pos });
  return sig(0, 0.2, `Inside 20-bar channel (${f0(pos * 100)}% of range)`, { pos, dc20_high: u20, dc20_low: l20 });
}

function keltnerPullback(w: Win): Signal {
  const c = at(w, 'close'), ku = at(w, 'kc_upper'), km = at(w, 'kc_mid'), kl = at(w, 'kc_lower');
  const sig = emitter('keltner_pullback', { name: 'Keltner Pullback', origin: 'Chester Keltner / Linda Bradford Raschke; EMA20 +/- 1.5 ATR', category: 'volatility', rules: 'Recent close above upper channel = uptrend; buy pullbacks to the midline. Recent close below lower = downtrend; sell rallies to midline.' });
  if (Number.isNaN(ku)) return sig(0, 0, 'Insufficient data');
  let up = false, dn = false;
  for (let i = tail(w, 15); i < w.e; i++) { if (w.f.close[i] > w.f.kc_upper[i]) up = true; if (w.f.close[i] < w.f.kc_lower[i]) dn = true; }
  const nearMid = Math.abs(c - km) < at(w, 'atr_14') * 0.5;
  if (up && !dn) return sig(1, clip(0.4 + (nearMid && c >= km ? 0.3 : 0) + (c > ku ? 0.1 : 0)), `Uptrend (recent close above upper Keltner)${nearMid ? '; pullback to midline' : ''}`, { kc_mid: km });
  if (dn && !up) return sig(-1, clip(0.4 + (nearMid && c <= km ? 0.3 : 0) + (c < kl ? 0.1 : 0)), `Downtrend (recent close below lower Keltner)${nearMid ? '; rally to midline' : ''}`, { kc_mid: km });
  return sig(0, 0.2, 'No clean Keltner trend', { kc_mid: km });
}

function volumeBreakout(w: Win): Signal {
  const c = at(w, 'close'), v = at(w, 'volume'), va = at(w, 'vol_sma_20');
  const sig = emitter('volume_breakout', { name: 'Volume-Confirmed Breakout', origin: "Stan Weinstein 'Secrets for Profiting in Bull and Bear Markets' (1988); Stage analysis", category: 'volume', rules: 'A close beyond the prior 20-bar range on >= 1.5x 20-bar average volume is confirmed; breakouts on low volume are suspect.' });
  if (Number.isNaN(va) || va === 0) return sig(0, 0, 'No volume data');
  const hi = maxOf(w.b.h, tail(w, 21), w.e - 1), lo = minOf(w.b.l, tail(w, 21), w.e - 1);
  const ratio = v / va, weak = ratio >= 1.5 ? '' : ' (weak volume)';
  const conf = clip(0.3 + (ratio >= 1.5 ? 0.4 : -0.1) + Math.min(ratio, 3) / 10);
  if (c > hi) return sig(1, conf, `Breakout above 20-bar high on ${f1(ratio)}x volume${weak}`, { volume_ratio: ratio });
  if (c < lo) return sig(-1, conf, `Breakdown below 20-bar low on ${f1(ratio)}x volume${weak}`, { volume_ratio: ratio });
  const barDir = toInt(sgn(c - at(w, 'open')));
  if (ratio >= 2 && barDir !== 0) return sig(barDir, 0.35, `Volume climax ${f1(ratio)}x on a ${barDir > 0 ? 'green' : 'red'} bar`, { volume_ratio: ratio });
  return sig(0, 0.15, `No breakout; volume ${f1(ratio)}x average`, { volume_ratio: ratio });
}

function openingRangeBreakout(w: Win): Signal {
  const sig = emitter('orb', { name: 'Opening Range Breakout', origin: "Toby Crabel, 'Day Trading with Short Term Price Patterns' (1990)", category: 'price_action', rules: 'Intraday: the first 30 minutes define the range; a close above it is bullish, below it bearish for the session.' });
  if (w.iv >= 3600) return sig(0, 0, 'Intraday strategy - not applicable on this timeframe');
  if (len(w) < 1) throw new IndexError('index -1 is out of bounds for axis 0 with size 0');
  const cs = sessionStart(w, w.e - 1);
  const bars = Math.max(1, Math.floor(1800 / w.iv));
  if (w.e - cs <= bars) return sig(0, 0.2, 'Opening range still forming');
  const hi = maxOf(w.b.h, cs, cs + bars), lo = minOf(w.b.l, cs, cs + bars), c = at(w, 'close');
  const vals = { orb_high: hi, orb_low: lo };
  if (c > hi) return sig(1, clip(0.45 + ((c - hi) / (hi - lo + 1e-9)) * 0.2), `Trading above the opening range high ${f2(hi)}`, vals);
  if (c < lo) return sig(-1, clip(0.45 + ((lo - c) / (hi - lo + 1e-9)) * 0.2), `Trading below the opening range low ${f2(lo)}`, vals);
  return sig(0, 0.25, `Inside opening range ${f2(lo)} - ${f2(hi)}`, vals);
}

// =============================================================================
//  VOLUME STRATEGIES
// =============================================================================

function obvGranville(w: Win): Signal {
  const o = at(w, 'obv'), oe = at(w, 'obv_ema');
  const sig = emitter('obv', { name: 'On-Balance Volume', origin: 'Joseph Granville (1963)', category: 'volume', rules: 'OBV above its 20-EMA and rising confirms an uptrend (volume flows in); OBV falling while price rises = bearish divergence.' });
  const a = tail(w, 20);
  if (Number.isNaN(oe) || sumOf(w.b.v, a, w.e) === 0) return sig(0, 0, 'No volume data');
  const obvSlope = slopeOf(w.f.obv, a, w.e, 20), priceSlope = slopeOf(w.b.c, a, w.e, 20);
  const up = o > oe && obvSlope > 0, dn = o < oe && obvSlope < 0, vals = { obv: o, obv_ema: oe };
  if (up && priceSlope < 0) return sig(1, 0.5, 'Bullish divergence: OBV rising while price falls (accumulation)', vals);
  if (dn && priceSlope > 0) return sig(-1, 0.5, 'Bearish divergence: OBV falling while price rises (distribution)', vals);
  if (up) return sig(1, 0.45, 'OBV above its EMA and rising: volume confirms uptrend', vals);
  if (dn) return sig(-1, 0.45, 'OBV below its EMA and falling: volume confirms downtrend', vals);
  return sig(0, 0.2, 'OBV mixed', vals);
}

/** session-anchored VWAP at the last row of the window (indicators.vwap(df).iloc[-1]) */
function sessionVwap(w: Win): number {
  const b = w.b;
  let pv = 0, vol = 0;
  for (let i = sessionStart(w, w.e - 1); i < w.e; i++) { pv += ((b.h[i] + b.l[i] + b.c[i]) / 3) * b.v[i]; vol += b.v[i]; }
  return vol === 0 ? NaN : pv / vol;
}

function vwapStrategy(w: Win): Signal {
  const c = at(w, 'close');
  const sig = emitter('vwap', { name: 'VWAP', origin: 'Institutional execution benchmark; standard intraday bias tool', category: 'volume', rules: 'Price above VWAP = bullish bias (longs favoured, VWAP acts as support); below = bearish. Distance is normalised by ATR.' });
  const intraday = w.iv < 86400;
  const v = intraday ? sessionVwap(w) : at(w, 'vwap_20'), label = intraday ? 'session VWAP' : '20-bar VWAP';
  const a = at(w, 'atr_14');
  if (Number.isNaN(v) || Number.isNaN(a) || a === 0) return sig(0, 0, 'No volume data');
  const dist = (c - v) / a, d = dist > 0 ? 1 : -1;
  return sig(d, clip(0.3 + Math.min(Math.abs(dist), 2) * 0.2), `Price ${f2(Math.abs(dist))} ATR ${d > 0 ? 'above' : 'below'} ${label} (${f2(v)})`, { vwap: v, atr_distance: dist });
}

function mfiStrategy(w: Win): Signal {
  const m = at(w, 'mfi_14');
  const sig = emitter('mfi', { name: 'Money Flow Index', origin: 'Gene Quong & Avrum Soudack; 14-period', category: 'volume', rules: 'MFI < 20 oversold (bullish), > 80 overbought (bearish).' });
  if (Number.isNaN(m) || sumOf(w.b.v, tail(w, 20), w.e) === 0) return sig(0, 0, 'No volume data');
  if (m < 20) return sig(1, clip(0.4 + (20 - m) / 30), `MFI ${f0(m)} oversold`, { mfi: m });
  if (m > 80) return sig(-1, clip(0.4 + (m - 80) / 30), `MFI ${f0(m)} overbought`, { mfi: m });
  return sig(m > 50 ? 1 : -1, 0.12, `MFI ${f0(m)} neutral zone`, { mfi: m });
}

function chaikinMoneyFlowStrategy(w: Win): Signal {
  const v = at(w, 'cmf_20');
  const sig = emitter('cmf', { name: 'Chaikin Money Flow', origin: 'Marc Chaikin; 20-period', category: 'volume', rules: 'CMF > +0.05 = buying pressure (bullish); < -0.05 = selling pressure (bearish).' });
  if (Number.isNaN(v) || sumOf(w.b.v, tail(w, 20), w.e) === 0) return sig(0, 0, 'No volume data');
  if (Math.abs(v) < 0.05) return sig(0, 0.15, `CMF ${pySigned(v, 3)} near zero`, { cmf: v });
  return sig(Math.sign(v), clip(0.35 + Math.abs(v) * 2), `CMF ${pySigned(v, 3)}: ${v > 0 ? 'accumulation' : 'distribution'}`, { cmf: v });
}

// =============================================================================
//  PRICE ACTION / LEVELS
// =============================================================================

function candlestickPatterns(w: Win): Signal {
  const sig = emitter('candlesticks', { name: 'Candlestick Patterns', origin: "Steve Nison, 'Japanese Candlestick Charting Techniques' (1991)", category: 'price_action', rules: 'Detects Engulfing, Hammer / Hanging Man, Shooting Star, Morning / Evening Star, Three White Soldiers / Black Crows, Doji. Reversal patterns count more after an extended move.' });
  const a = tail(w, 5), b = w.b;
  const pick = (arr: number[]) => arr.slice(a, w.e);
  const o = pick(b.o), h = pick(b.h), l = pick(b.l), c = pick(b.c);
  const body = c.map((x, i) => x - o[i]);
  const rng = h.map((x, i) => Math.max(x - l[i], 1e-9));
  const upper = h.map((x, i) => x - Math.max(o[i], c[i]));
  const lower = l.map((x, i) => Math.min(o[i], c[i]) - x);
  const A = (arr: number[], k: number) => { if (k > arr.length) throw new IndexError(`index -${k} is out of bounds for axis 0 with size ${arr.length}`); return arr[arr.length - k]; };
  const last3 = (arr: number[]) => arr.slice(Math.max(0, arr.length - 3));
  const found: [string, number, number][] = [];
  // trend context: last 10 bars before the pattern
  const pa = tail(w, 12), pb = w.e - 2;
  if (pb <= pa) throw new IndexError();
  const downMove = b.c[pb - 1] < b.c[pa] * 0.98, upMove = b.c[pb - 1] > b.c[pa] * 1.02;
  // Engulfing
  if (A(body, 2) < 0 && 0 < A(body, 1) && A(c, 1) > A(o, 2) && A(o, 1) < A(c, 2)) found.push(['Bullish Engulfing', 1, 0.55 + (downMove ? 0.2 : 0)]);
  if (A(body, 2) > 0 && 0 > A(body, 1) && A(c, 1) < A(o, 2) && A(o, 1) > A(c, 2)) found.push(['Bearish Engulfing', -1, 0.55 + (upMove ? 0.2 : 0)]);
  // Hammer / Hanging man / Shooting star / Inverted hammer
  const b1 = Math.abs(A(body, 1)), r1 = A(rng, 1);
  const small = b1 <= r1 * 0.35;
  if (small && A(lower, 1) >= 2 * b1 && A(upper, 1) <= r1 * 0.15)
    found.push(downMove || !upMove ? ['Hammer', 1, 0.5 + (downMove ? 0.2 : -0.2)] : ['Hanging Man', -1, 0.45]);
  if (small && A(upper, 1) >= 2 * b1 && A(lower, 1) <= r1 * 0.15)
    found.push(upMove || !downMove ? ['Shooting Star', -1, 0.5 + (upMove ? 0.2 : -0.2)] : ['Inverted Hammer', 1, 0.45]);
  // Doji
  if (b1 <= r1 * 0.08) found.push(['Doji (indecision)', 0, 0.3]);
  // Morning / Evening star
  const mid3 = (A(o, 3) + A(c, 3)) / 2;
  if (A(body, 3) < 0 && Math.abs(A(body, 2)) < A(rng, 2) * 0.3 && A(body, 1) > 0 && A(c, 1) > mid3) found.push(['Morning Star', 1, 0.7]);
  if (A(body, 3) > 0 && Math.abs(A(body, 2)) < A(rng, 2) * 0.3 && A(body, 1) < 0 && A(c, 1) < mid3) found.push(['Evening Star', -1, 0.7]);
  // Three soldiers / crows
  const rng3 = last3(rng);
  if (last3(body).every((x) => x > 0) && A(c, 1) > A(c, 2) && A(c, 2) > A(c, 3) && last3(upper).every((x, i) => x < rng3[i] * 0.3)) found.push(['Three White Soldiers', 1, 0.6]);
  if (last3(body).every((x) => x < 0) && A(c, 1) < A(c, 2) && A(c, 2) < A(c, 3) && last3(lower).every((x, i) => x < rng3[i] * 0.3)) found.push(['Three Black Crows', -1, 0.6]);
  if (!found.length) return sig(0, 0.1, 'No notable pattern on the last bars', { patterns: [] });
  let score = 0;
  for (const [, d, cf] of found) score += d * cf;
  const d = Math.sign(score);
  return sig(d, d ? clip(Math.abs(score)) : 0.3, found.map((x) => x[0]).join(', '), { patterns: found.map((x) => x[0]) });
}

function floorPivots(w: Win): Signal {
  const pv = pivotsAt(w, w.iv < 86400);
  const c = at(w, 'close'), a = at(w, 'atr_14');
  const sig = emitter('floor_pivots', { name: 'Pivot Points', origin: "Classic floor-trader pivots (CME pit tradition); previous session's H/L/C on intraday charts", category: 'levels', rules: 'Above the pivot = bullish bias, targets R1/R2; below = bearish, targets S1/S2. Price sitting at S1/R1 within 0.3 ATR is a bounce zone.' });
  if (Number.isNaN(a)) return sig(0, 0, 'Insufficient data', pv);
  const near = (v: number) => Math.abs(c - v) < a * 0.3;
  if (near(pv.s1) || near(pv.s2)) return sig(1, 0.45, `Price at support ${near(pv.s1) ? 'S1' : 'S2'} - bounce zone`, pv);
  if (near(pv.r1) || near(pv.r2)) return sig(-1, 0.45, `Price at resistance ${near(pv.r1) ? 'R1' : 'R2'} - rejection zone`, pv);
  const d = c > pv.pivot ? 1 : -1;
  return sig(d, 0.3, `Price ${d > 0 ? 'above' : 'below'} pivot ${f2(pv.pivot)}`, pv);
}

function fibonacciRetracement(w: Win): Signal {
  if (len(w) < 1) throw new Error('attempt to get argmax of an empty sequence');
  const fib = fibonacciAt(w, 100);
  const c = at(w, 'close'), a = at(w, 'atr_14'), lv = fib.levels;
  const sig = emitter('fibonacci', { name: 'Fibonacci Retracement', origin: 'Classic Fibonacci pullback trading (Elliott / Gann tradition)', category: 'levels', rules: 'In an up-swing, a pullback holding 38.2/50/61.8% is a buy zone; in a down-swing a bounce into those levels is a sell zone. Beyond 78.6% the swing is invalidated.' });
  if (Number.isNaN(a)) return sig(0, 0, 'Insufficient data', lv);
  const hits = ['0.382', '0.500', '0.618'].filter((k) => Math.abs(c - lv[k]) < a * 0.5);
  const conf = 0.5 + 0.1 * (hits.includes('0.618') ? 1 : 0);
  if (fib.up_swing) {
    if (hits.length) return sig(1, conf, `Pullback in up-swing at ${hits.join(', ')} retracement`, lv);
    if (c < lv['0.786']) return sig(-1, 0.4, 'Retraced beyond 78.6%: up-swing invalidated', lv);
    return sig(1, 0.2, 'Up-swing intact, not at a fib level', lv);
  }
  if (hits.length) return sig(-1, conf, `Bounce in down-swing at ${hits.join(', ')} retracement`, lv);
  if (c > lv['0.786']) return sig(1, 0.4, 'Retraced beyond 78.6%: down-swing invalidated', lv);
  return sig(-1, 0.2, 'Down-swing intact, not at a fib level', lv);
}

function supportResistance(w: Win): Signal {
  const c = at(w, 'close'), a = at(w, 'atr_14');
  const sig = emitter('support_resistance', { name: 'Support / Resistance', origin: "Classic technical analysis (Edwards & Magee, 'Technical Analysis of Stock Trends', 1948)", category: 'levels', rules: 'Nearest swing-high resistance / swing-low support. A close through a level on the last bar = breakout; a hold within 0.5 ATR = bounce.' });
  if (Number.isNaN(a)) return sig(0, 0, 'Insufficient data');
  // fractal swing points (5 bars either side, both inside the window), excluding the last bar
  const { h, l } = w.b, res: number[] = [], sup: number[] = [];
  for (let i = w.s + 5; i <= w.e - 6 && i < w.e - 1; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let j = i - 5; j <= i + 5; j++) { if (h[j] > hi) hi = h[j]; if (l[j] < lo) lo = l[j]; }
    if (h[i] === hi) res.push(h[i]);
    if (l[i] === lo) sup.push(l[i]);
  }
  const prev = at(w, 'close', 1);
  let nearestRes = NaN, nearestSup = NaN, brokeRes = NaN, brokeSup = NaN;
  for (const r of res) {
    if (r > c && !(r >= nearestRes)) nearestRes = r;
    if (r > prev && r < c && !(r <= brokeRes)) brokeRes = r;
  }
  for (const s of sup) {
    if (s < c && !(s <= nearestSup)) nearestSup = s;
    if (s < prev && s > c && !(s >= brokeSup)) brokeSup = s;
  }
  const vals = { resistance: nearestRes, support: nearestSup };
  if (!Number.isNaN(brokeRes)) return sig(1, 0.55, `Broke above resistance ${f2(brokeRes)}`, vals);
  if (!Number.isNaN(brokeSup)) return sig(-1, 0.55, `Broke below support ${f2(brokeSup)}`, vals);
  if (!Number.isNaN(nearestSup) && c - nearestSup < a * 0.5) return sig(1, 0.4, `Holding at support ${f2(nearestSup)}`, vals);
  if (!Number.isNaN(nearestRes) && nearestRes - c < a * 0.5) return sig(-1, 0.4, `Pressing resistance ${f2(nearestRes)}`, vals);
  if (!Number.isNaN(nearestSup) && !Number.isNaN(nearestRes)) {
    const pos = (c - nearestSup) / (nearestRes - nearestSup);
    return sig(0, 0.15, `Mid-range between ${f2(nearestSup)} and ${f2(nearestRes)} (${f0(pos * 100)}%)`, vals);
  }
  return sig(0, 0.1, 'No nearby levels', vals);
}

// =============================================================================
//  SESSION LEVELS, VOLUME-AT-PRICE, GAPS, NARROW RANGE, ALLIGATOR
// =============================================================================

function cprStrategy(w: Win): Signal {
  const sig = emitter('cpr', { name: 'Central Pivot Range (CPR)', origin: "Frank Ochoa, 'Secrets of a Pivot Boss' (2010); previous-session pivot, BC, TC", category: 'levels', rules: "Close above the top central pivot (TC) = bullish bias; below the bottom central (BC) = bearish; inside the range = no bias. A narrow CPR (< 1/12 of the previous session's range) signals a trend day and strengthens the call." });
  const cp = cprAt(w, w.iv < 86400);
  const c = at(w, 'close'), a = at(w, 'atr_14');
  if (Number.isNaN(a) || a === 0) return sig(0, 0, 'Insufficient data');
  const narrow = cp.narrow, tag = narrow ? ' (narrow CPR: trend day likely)' : '';
  if (c > cp.tc) return sig(1, clip(0.4 + (narrow ? 0.2 : 0) + Math.min((c - cp.tc) / a, 2) * 0.05), `Close above CPR top ${f2(cp.tc)}${tag}`, cp);
  if (c < cp.bc) return sig(-1, clip(0.4 + (narrow ? 0.2 : 0) + Math.min((cp.bc - c) / a, 2) * 0.05), `Close below CPR bottom ${f2(cp.bc)}${tag}`, cp);
  return sig(0, 0.3, `Inside the CPR ${f2(cp.bc)} - ${f2(cp.tc)}: no bias yet`, cp);
}

function camarillaStrategy(w: Win): Signal {
  const sig = emitter('camarilla', { name: 'Camarilla Pivots', origin: 'Nick Scott (1989); widely used by Indian intraday traders. H3/L3 reversal, H4/L4 breakout', category: 'levels', rules: 'Price within 0.3 ATR of H3 = sell zone (reversal), of L3 = buy zone. A close above H4 = breakout long; below L4 = breakdown short.' });
  const lv = camarillaAt(w, w.iv < 86400);
  const c = at(w, 'close'), a = at(w, 'atr_14');
  if (Number.isNaN(a) || a === 0) return sig(0, 0, 'Insufficient data');
  if (c > lv.h4) return sig(1, 0.6, `Close above H4 ${f2(lv.h4)}: breakout`, lv);
  if (c < lv.l4) return sig(-1, 0.6, `Close below L4 ${f2(lv.l4)}: breakdown`, lv);
  if (Math.abs(c - lv.h3) < a * 0.3) return sig(-1, 0.45, `At H3 ${f2(lv.h3)}: reversal zone, expect a fade`, lv);
  if (Math.abs(c - lv.l3) < a * 0.3) return sig(1, 0.45, `At L3 ${f2(lv.l3)}: reversal zone, expect a bounce`, lv);
  const d = c > lv.ref_close ? 1 : -1;
  return sig(d, 0.15, `Inside the Camarilla range, ${d > 0 ? 'above' : 'below'} the previous close`, lv);
}

function vwapBandsStrategy(w: Win): Signal {
  const sig = emitter('vwap_bands', { name: 'VWAP Bands', origin: "Session VWAP +/- volume-weighted standard deviation; institutional benchmark (Brian Shannon, 'Maximum Trading Gains with Anchored VWAP', 2023)", category: 'volume', rules: 'Price more than 2 sigma above VWAP is stretched: fade it unless ADX > 25 (then ride the band). More than 2 sigma below: the mirror. Within 0.5 sigma = at fair value, no bias.' });
  if (len(w) < 1) throw new IndexError('index -1 is out of bounds for axis 0 with size 0');
  const vb = vwapBandsAt(w, w.iv < 86400);
  const c = at(w, 'close'), adx = at(w, 'adx');
  if (!vb || vb.sd <= 0) return sig(0, 0, 'No volume data');
  const dist = (c - vb.vwap) / vb.sd;
  const vals = { vwap: vb.vwap, sd: vb.sd, upper2: vb.upper2, lower2: vb.lower2, sigma_distance: dist };
  const trending = !Number.isNaN(adx) && adx > 25;
  if (dist >= 2) return trending ? sig(1, 0.3, `${f1(dist)} sigma above VWAP with ADX ${f0(adx)}: riding the upper band`, vals)
    : sig(-1, 0.45, `${f1(dist)} sigma above VWAP: stretched, fade toward ${f2(vb.vwap)}`, vals);
  if (dist <= -2) return trending ? sig(-1, 0.3, `${f1(-dist)} sigma below VWAP with ADX ${f0(adx)}: riding the lower band`, vals)
    : sig(1, 0.45, `${f1(-dist)} sigma below VWAP: stretched, bounce toward ${f2(vb.vwap)}`, vals);
  if (Math.abs(dist) < 0.5) return sig(0, 0.2, `At VWAP (${pySigned(dist, 1)} sigma): fair value`, vals);
  const d = dist > 0 ? 1 : -1;
  return sig(d, 0.2, `${f1(Math.abs(dist))} sigma ${d > 0 ? 'above' : 'below'} VWAP, inside the bands`, vals);
}

function openingGap(w: Win): Signal {
  const sig = emitter('opening_gap', { name: 'Opening Gap', origin: "Gap statistics (Scott Andrews, 'Understanding Gaps', 2011): gap-and-go vs gap-fill", category: 'price_action', rules: 'Gap >= 0.3% vs the previous close. Gap up holding above the open = continuation; trading back below the open = fade toward the previous close (fill). Already filled = no edge. Mirror for gap downs.' });
  let prevClose: number, openPx: number;
  if (w.iv < 86400) {
    if (len(w) < 2) return sig(0, 0, 'Insufficient data');
    const cs = sessionStart(w, w.e - 1);
    if (cs <= w.s) return sig(0, 0, 'Insufficient data');
    prevClose = w.b.c[cs - 1]; openPx = w.b.o[cs];
  } else {
    if (len(w) < 2) return sig(0, 0, 'Insufficient data');
    prevClose = w.b.c[w.e - 2]; openPx = w.b.o[w.e - 1];
  }
  const c = at(w, 'close');
  const gap = prevClose ? (openPx / prevClose - 1) * 100 : 0;
  const vals = { gap_pct: gap, open: openPx, prev_close: prevClose }, g = pySigned(gap, 2);
  if (Math.abs(gap) < 0.3) return sig(0, 0.15, `No meaningful gap (${g}%)`, vals);
  if (gap > 0) {
    if (c <= prevClose) return sig(0, 0.25, `Gap up ${g}% already filled`, vals);
    if (c < openPx) return sig(-1, 0.5, `Gap up ${g}% fading below the open: fill toward ${f2(prevClose)}`, vals);
    return sig(1, 0.4, `Gap up ${g}% holding above the open (gap-and-go)`, vals);
  }
  if (c >= prevClose) return sig(0, 0.25, `Gap down ${g}% already filled`, vals);
  if (c > openPx) return sig(1, 0.5, `Gap down ${g}% recovering above the open: fill toward ${f2(prevClose)}`, vals);
  return sig(-1, 0.4, `Gap down ${g}% holding below the open (gap-and-go)`, vals);
}

function nr7Crabel(w: Win): Signal {
  const sig = emitter('nr7', { name: 'NR7 Narrow Range', origin: "Toby Crabel, 'Day Trading with Short Term Price Patterns and Opening Range Breakout' (1990)", category: 'price_action', rules: "A bar with the narrowest range of the last 7 (NR7) precedes expansion. If the last bar was NR7: breakout pending, no direction. If the previous bar was NR7: a close above its high = long, below its low = short." });
  if (len(w) < 9) return sig(0, 0, 'Insufficient data');
  const e = w.e, rng = (i: number) => w.b.h[i] - w.b.l[i];
  let m7 = Infinity;
  for (let i = e - 7; i < e; i++) m7 = Math.min(m7, rng(i));
  if (rng(e - 1) <= m7) return sig(0, 0.4, 'Last bar is an NR7: range contraction, breakout pending', { range: rng(e - 1) });
  let p7 = Infinity;
  for (let i = e - 8; i < e - 1; i++) p7 = Math.min(p7, rng(i));
  if (rng(e - 2) <= p7) {
    const hi = w.b.h[e - 2], lo = w.b.l[e - 2], c = at(w, 'close'), vals = { nr7_high: hi, nr7_low: lo };
    if (c > hi) return sig(1, 0.55, `Broke above the NR7 bar's high ${f2(hi)}`, vals);
    if (c < lo) return sig(-1, 0.55, `Broke below the NR7 bar's low ${f2(lo)}`, vals);
    return sig(0, 0.3, `Inside the NR7 bar's range ${f2(lo)} - ${f2(hi)}`, vals);
  }
  return sig(0, 0.1, 'No narrow-range setup');
}

function marketProfileStrategy(w: Win): Signal {
  const sig = emitter('market_profile', { name: 'Market Profile Value Area', origin: 'J. Peter Steidlmayer, CBOT Market Profile (1984); volume-at-price of the previous session, 70% value area', category: 'levels', rules: 'Close above the value area high (VAH) = buyers accepting higher prices; below the value area low (VAL) = sellers in control; inside value = balance, lean by side of the point of control (POC).' });
  if (len(w) < 1) throw new IndexError('index -1 is out of bounds for axis 0 with size 0');
  const mp = marketProfileAt(w, w.iv < 86400);
  const c = at(w, 'close'), a = at(w, 'atr_14');
  if (!mp || Number.isNaN(a) || a === 0) return sig(0, 0, 'No volume data');
  if (c > mp.vah) return sig(1, clip(0.45 + Math.min((c - mp.vah) / a, 2) * 0.05), `Accepted above value area high ${f2(mp.vah)}`, mp);
  if (c < mp.val) return sig(-1, clip(0.45 + Math.min((mp.val - c) / a, 2) * 0.05), `Rejected below value area low ${f2(mp.val)}`, mp);
  const d = c > mp.poc ? 1 : -1;
  return sig(d, 0.15, `Inside value area (${f2(mp.val)} - ${f2(mp.vah)}), ${d > 0 ? 'above' : 'below'} POC ${f2(mp.poc)}`, mp);
}

/** Wilder smoothing of the median price over rows [s, i] (indicators.rma, min_periods n); NaN before the window */
function medianRmaAt(w: Win, i: number, n: number): number {
  if (i < w.s) return NaN;
  const alpha = 1 / n;
  let m = NaN;
  for (let j = w.s; j <= i; j++) { const x = (w.b.h[j] + w.b.l[j]) / 2; m = j === w.s ? x : alpha * x + (1 - alpha) * m; }
  return i - w.s + 1 >= n ? m : NaN;
}

function alligatorWilliams(w: Win): Signal {
  const sig = emitter('alligator', { name: 'Williams Alligator', origin: "Bill Williams, 'Trading Chaos' (1995); SMMA 13/8/5 shifted 8/5/3", category: 'trend', rules: 'Lips above teeth above jaw with price above the lips = uptrend (long). The mirror = downtrend (short). Lines intertwined = the alligator sleeps: no trade.' });
  if (len(w) < 1) throw new IndexError();
  const i = w.e - 1;
  const jaw = medianRmaAt(w, i - 8, 13), teeth = medianRmaAt(w, i - 5, 8), lips = medianRmaAt(w, i - 3, 5);
  const c = at(w, 'close'), a = at(w, 'atr_14');
  if ([jaw, teeth, lips].some(Number.isNaN) || Number.isNaN(a) || a === 0) return sig(0, 0, 'Insufficient data');
  const spread = (lips - jaw) / a, vals = { jaw, teeth, lips, spread_atr: spread };
  if (lips > teeth && teeth > jaw && c > lips) return sig(1, clip(0.4 + Math.min(spread, 3) * 0.1), `Alligator eating up: lips > teeth > jaw, price above (${f1(spread)} ATR mouth)`, vals);
  if (lips < teeth && teeth < jaw && c < lips) return sig(-1, clip(0.4 + Math.min(-spread, 3) * 0.1), `Alligator eating down: lips < teeth < jaw, price below (${f1(-spread)} ATR mouth)`, vals);
  return sig(0, 0.25, 'Alligator sleeping: lines intertwined', vals);
}

// =============================================================================
//  REGISTRY
// =============================================================================

type WinFn = (w: Win) => Signal;
const REGISTRY: [string, WinFn, string][] = [
  ['golden_cross', goldenCross, 'SMA50 / SMA200 Golden Cross & Death Cross - the classic long-term trend filter.'],
  ['ema_crossover', emaCrossover, 'EMA 9/21 crossover - the standard swing / day-trading fast trend signal.'],
  ['macd', macdStrategy, "Gerald Appel's MACD (12,26,9): signal-line cross + zero-line + histogram momentum."],
  ['adx_dmi', adxDmi, "Wilder's ADX / DMI: trade in the direction of DI dominance only when ADX shows a trend (>20-25)."],
  ['supertrend', supertrendStrategy, 'Supertrend (10, 3) - ATR-based trailing trend indicator popular with Indian intraday traders.'],
  ['parabolic_sar', parabolicSarStrategy, "Wilder's Parabolic SAR (0.02, 0.2) stop-and-reverse."],
  ['ichimoku', ichimokuStrategy, 'Ichimoku Kinko Hyo: price vs Kumo cloud, Tenkan/Kijun cross, cloud colour.'],
  ['hull_ma', hullMaTrend, "Alan Hull's HMA(20) slope - a low-lag trend direction filter."],
  ['elder_triple_screen', elderTripleScreen, "Alexander Elder's Triple Screen: higher-timeframe tide (EMA13 slope / MACD-hist on 5x bars),\nthen trade pullbacks on the base timeframe oscillator (Stochastic / Force Index)."],
  ['chandelier_exit', chandelierExit, "Chuck LeBeau's Chandelier Exit: 22-bar high - 3 x ATR(22) (long) / 22-bar low + 3 x ATR (short)."],
  ['heikin_ashi', heikinAshiTrend, 'Heikin-Ashi candle colour run; candles with no wick against the trend = strong trend.'],
  ['rsi_wilder', rsiWilder, "Wilder's RSI(14): 30/70 reversal zones, 50 midline as trend bias, plus simple divergence check."],
  ['connors_rsi2', connorsRsi2, "Larry Connors' RSI(2) mean-reversion: buy RSI2 < 10 above SMA200, sell RSI2 > 90 below SMA200. Exit at SMA5."],
  ['stochastic', stochasticLane, "George Lane's Stochastic (14,3,3): %K/%D crosses in the 20/80 zones."],
  ['cci', cciLambert, "Donald Lambert's CCI(20): +100/-100 breakout rules (trend) and extremes (reversal)."],
  ['williams_r', williamsRStrategy, "Larry Williams' %R(14): -20 / -80 zones."],
  ['momentum_12_1', momentum121, "Jegadeesh & Titman (1993) cross-sectional momentum, adapted to a single asset:\nreturn over the past 12 'months' skipping the most recent 1 (uses 60-bar / 5-bar analog)."],
  ['fifty_two_week_high', fiftyTwoWeekHigh, 'George & Hwang (2004): nearness to the 52-week high predicts future returns.'],
  ['bollinger_breakout', bollingerBreakout, "John Bollinger's Squeeze: BandWidth at a 120-bar low then a close outside the bands starts a move."],
  ['bollinger_mr', bollingerMeanReversion, 'Bollinger %B mean reversion when ADX shows no trend.'],
  ['ttm_squeeze', ttmSqueeze, "John Carter's TTM Squeeze: Bollinger inside Keltner = squeeze on; fire in the momentum direction on release."],
  ['turtle', turtleBreakout, 'Turtle Trading (Richard Dennis & William Eckhardt, 1983): System 1 = 20-day Donchian breakout,\nSystem 2 = 55-day breakout. Exit on 10-day opposite breakout.'],
  ['keltner_pullback', keltnerPullback, "Linda Raschke's Keltner Channel trend-pullback: trend by channel breakouts, enter on pullbacks to the EMA20 midline."],
  ['volume_breakout', volumeBreakout, 'Stan Weinstein / classic breakout confirmation: a range break on >= 1.5x average volume.'],
  ['orb', openingRangeBreakout, "Toby Crabel's Opening Range Breakout (intraday only): break of the first 30 minutes' range."],
  ['obv', obvGranville, "Joseph Granville's On-Balance Volume: OBV trend confirms price; divergence warns."],
  ['vwap', vwapStrategy, 'Institutional VWAP: price above VWAP = buyers in control (session VWAP intraday, 20-bar rolling otherwise).'],
  ['mfi', mfiStrategy, 'Money Flow Index (volume-weighted RSI): 20/80 zones.'],
  ['cmf', chaikinMoneyFlowStrategy, "Marc Chaikin's CMF(20): sustained > +0.05 accumulation, < -0.05 distribution."],
  ['candlesticks', candlestickPatterns, 'Japanese candlestick reversal patterns as catalogued by Steve Nison.'],
  ['floor_pivots', floorPivots, 'Classic floor-trader pivot points (P, R1-3, S1-3) from the previous session (intraday) or previous bar.'],
  ['fibonacci', fibonacciRetracement, 'Fibonacci retracement of the last major swing: 38.2 / 50 / 61.8 pullbacks in the swing direction.'],
  ['support_resistance', supportResistance, 'Swing-point support / resistance: reaction at the nearest level, or a clean break.'],
  ['cpr', cprStrategy, "Frank Ochoa's Central Pivot Range: previous-session pivot / BC / TC; price above the range is bullish,\nbelow bearish; a narrow CPR marks a likely trend day."],
  ['camarilla', camarillaStrategy, 'Camarilla pivots: fade the H3 / L3 reversal zone, follow a break of H4 / L4.'],
  ['vwap_bands', vwapBandsStrategy, 'Session VWAP with volume-weighted standard-deviation bands: stretched beyond 2 sigma reverts unless the trend is strong.'],
  ['opening_gap', openingGap, 'Gap trading: a gap that holds beyond the open tends to continue (gap-and-go); one that trades back through the open tends to fill.'],
  ['nr7', nr7Crabel, "Toby Crabel's NR7: the narrowest range in seven bars precedes a range expansion; trade the break of that bar."],
  ['market_profile', marketProfileStrategy, 'Market Profile value area: acceptance above the value area high is bullish, below the value area low bearish.'],
  ['alligator', alligatorWilliams, "Bill Williams' Alligator: lips > teeth > jaw with price above = eating up (trend); intertwined = sleeping."],
];

/** strategies whose levels depend on whether the bars are intraday (previous session) or daily+ (previous bar) */
export const NEEDS_INTERVAL = new Set(['orb', 'vwap', 'floor_pivots', 'cpr', 'camarilla', 'vwap_bands', 'opening_gap', 'market_profile']);

const winOf = (x: StrategyInput, iv: number, s = 0, e = x.bars.c.length): Win => ({ b: x.bars, f: x.f, s, e, iv });

export const STRATEGIES: Record<string, StrategyFn> = Object.fromEntries(REGISTRY.map(([k, fn]) => [k, (x: StrategyInput, iv: number) => fn(winOf(x, iv))]));

const errorSignal = (key: string, exc: unknown): Signal =>
  ({ key, name: key, origin: '', category: 'error', direction: 0, confidence: 0, reason: `error: ${exc instanceof Error ? exc.message : String(exc)}`, rules: '', values: {} });

/**
 * run_all(df.iloc[start:end], intervalSeconds): every strategy on rows [start, end) of the full-history frame.
 * A strategy that throws yields an 'error' signal (a single strategy must never break the analysis).
 */
export function runWindow(x: StrategyInput, intervalSeconds: number, start: number, end: number): Signal[] {
  const w = winOf(x, intervalSeconds, Math.max(0, start), Math.min(end, x.bars.c.length));
  return REGISTRY.map(([key, fn]) => { try { return fn(w); } catch (exc) { return errorSignal(key, exc); } });
}
export function runAll(x: StrategyInput, intervalSeconds: number): Signal[] {
  return runWindow(x, intervalSeconds, 0, x.bars.c.length);
}
/** learner._votes_for_bar: direction x clip(confidence) per strategy on rows [start, end); 0 when a strategy errors. */
export function votesAt(x: StrategyInput, intervalSeconds: number, start: number, end: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of runWindow(x, intervalSeconds, start, end)) out[s.key] = s.category === 'error' ? 0 : s.direction * clip(s.confidence);
  return out;
}
export const STRATEGY_KEYS = REGISTRY.map(([k]) => k);
/** Static description of each strategy (the Python docstrings, for the UI's strategy reference). */
export const catalog = (): { key: string; doc: string }[] => REGISTRY.map(([key, , doc]) => ({ key, doc }));
/** A Win over the whole frame, for callers (ensemble) that need the level helpers on the latest bar. */
export const fullWindow = (x: StrategyInput, intervalSeconds: number): Win => winOf(x, intervalSeconds);
