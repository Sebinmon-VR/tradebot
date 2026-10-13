/**
 * Overextended (multi-day): stocks that ran too far, too fast on daily bars - port of app/overextended.py.
 * The score (0-100) adds up published overbought / exhaustion rules, each ramped from "just triggered" to
 * "extreme" times its weight; every stock also carries what happened after its own earlier episodes.
 */
import * as ind from './indicators';
import { Series, div, full, isNum, map2, median, pctChange, rollingMax, rollingMean, rollingStd, shift } from './series';
import { Bars } from './types';

export const HIST_THRESHOLD = 35;
export const FWD_BARS = 5, DIP_BARS = 10;
// tiers set from the NIFTY 100 distribution (2 years of daily bars): 20+ on ~6% of bars, 35+ on 2%, 50+ on 0.6%
export const TIERS: [number, string][] = [[50, 'stretched'], [35, 'extended'], [20, 'warming']];
export const MIN_SCORE = 20;

export interface Rule { label: string; weight: number; lo?: number; hi?: number; origin: string; rule: string }
export const RULES: Record<string, Rule> = {
  rsi14: { label: 'RSI-14 overbought', weight: 12, lo: 70, hi: 82, origin: 'J. Welles Wilder, New Concepts in Technical Trading Systems (1978)', rule: 'RSI-14 above 70; full points at 82' },
  rsi2: { label: 'RSI-2 extreme', weight: 10, lo: 90, hi: 98, origin: 'Larry Connors & Cesar Alvarez, Short Term Trading Strategies That Work (2009)', rule: 'RSI-2 above 90; full points at 98' },
  bb: { label: 'Above upper Bollinger Band', weight: 12, lo: 1.0, hi: 1.2, origin: 'John Bollinger, Bollinger on Bollinger Bands (2001)', rule: '%B above 1.0 (close beyond the 20-day, 2-sigma band); full points at 1.2' },
  sma20: { label: 'Stretched from 20-day SMA', weight: 14, lo: 1.5, hi: 3.5, origin: 'Linda Raschke & Larry Connors, Street Smarts (1995): distance from the mean in ATR units', rule: 'Close more than 1.5 ATR above the 20-day SMA; full points at 3.5 ATR' },
  sma50: { label: 'Stretched from 50-day SMA', weight: 8, lo: 3, hi: 7, origin: 'Distance from the intermediate mean in ATR units (Raschke & Connors)', rule: 'Close more than 3 ATR above the 50-day SMA; full points at 7 ATR' },
  streak: { label: 'Up-day streak', weight: 8, lo: 3, hi: 6, origin: 'Connors & Alvarez (2009): consecutive up closes mean-revert', rule: '4 or more consecutive up closes; full points at 6' },
  roc: { label: 'Parabolic 20-day run', weight: 10, lo: 1.5, hi: 2.5, origin: 'Martin Pring, Technical Analysis Explained: rate-of-change extremes', rule: "20-day return above 1.5x the stock's own 20-day volatility; full points at 2.5x" },
  climax: { label: 'Buying-climax volume', weight: 8, lo: 1.5, hi: 3.5, origin: 'Richard Wyckoff (1930s); Stan Weinstein, Secrets for Profiting in Bull and Bear Markets (1988)', rule: 'Volume at least 2x the 20-day average on an up day that made a 20-day high; full points at 3.5x' },
  candle: { label: 'Bearish reversal candle at the highs', weight: 10, origin: 'Steve Nison, Japanese Candlestick Charting Techniques (1991)', rule: 'Shooting star, bearish engulfing, dark cloud cover or gravestone doji within a bar of a 20-day high' },
  divergence: { label: 'Bearish RSI divergence', weight: 8, origin: "Wilder (1978); Andrew Cardwell's RSI divergence work", rule: 'New 20-day closing high while RSI-14 sits 5+ points below its own 20-day peak' },
};

export const ramp = (x: number, lo: number, hi: number) => (isNum(x) ? Math.min(1, Math.max(0, (x - lo) / (hi - lo))) : 0);

export interface Components { parts: Record<string, Series>; score: Series; raw: Record<string, Series>; pattern: string[] }
export function components(b: Bars): Components {
  const { c, h, l, o } = b, n = c.length;
  const v = b.v.map((x) => (isNum(x) ? x : 0));
  const rsi14 = ind.rsi(c, 14), rsi2 = ind.rsi(c, 2), bb = ind.bollinger(c, 20, 2);
  const atr = ind.atr(b, 14).map((x) => (x === 0 ? NaN : x));
  const sma20 = rollingMean(c, 20), sma50 = rollingMean(c, 50);
  const st20 = map2(map2(c, sma20, (a, m) => a - m), atr, (d, a) => d / a), st50 = map2(map2(c, sma50, (a, m) => a - m), atr, (d, a) => d / a);
  const streak = full(n, 0);
  for (let i = 1; i < n; i++) streak[i] = c[i] - c[i - 1] > 0 ? streak[i - 1] + 1 : 0;
  const ret = pctChange(c), roc20 = pctChange(c, 20);
  const z20 = div(roc20, rollingStd(ret, 20).map((x) => x * Math.sqrt(20)));
  const vratio = div(v, shift(rollingMean(v, 20), 1));
  const hi20prev = shift(rollingMax(h, 20), 1);
  const hi20 = rollingMax(h, 20), hi20prev2 = shift(hi20, 2), close20max = rollingMax(c, 20);
  const rsiPeak = rollingMax(rsi14, 20);
  const pattern: string[] = new Array(n).fill('');
  const parts: Record<string, Series> = {};
  for (const k of Object.keys(RULES)) parts[k] = full(n, 0);
  const R = (k: string, x: number) => ramp(x, RULES[k].lo!, RULES[k].hi!);
  for (let i = 0; i < n; i++) {
    const body = c[i] - o[i], rng = h[i] - l[i];
    const upper = h[i] - Math.max(o[i], c[i]), lower = Math.min(o[i], c[i]) - l[i];
    const pb = i > 0 ? c[i - 1] - o[i - 1] : NaN;
    // pandas: comparisons with NaN (rng == 0 -> NaN) are False
    const shooting = rng > 0 && Math.abs(body) <= 0.35 * rng && upper >= 2 * Math.abs(body) && lower <= 0.15 * rng;
    const engulf = pb > 0 && body < 0 && c[i] < o[i - 1] && o[i] > c[i - 1];
    const dark = pb > 0 && body < 0 && o[i] > h[i - 1] && c[i] < (o[i - 1] + c[i - 1]) / 2;
    const gravestone = rng > 0 && Math.abs(body) <= 0.08 * rng && upper >= 0.6 * rng;
    const nearHigh = i >= 1 && Math.max(h[i], h[i - 1]) >= hi20prev2[i];
    pattern[i] = engulf ? 'Bearish engulfing' : dark ? 'Dark cloud cover' : shooting ? 'Shooting star' : gravestone ? 'Gravestone doji' : '';
    const candle = nearHigh && (shooting || engulf || dark || gravestone);
    const newHigh = c[i] >= close20max[i];
    const diverg = newHigh && rsi14[i] <= rsiPeak[i] - 5 && rsi14[i] > 55;
    const climaxCtx = vratio[i] >= 2 && c[i] > o[i] && h[i] >= hi20prev[i];
    parts.rsi14[i] = R('rsi14', rsi14[i]); parts.rsi2[i] = R('rsi2', rsi2[i]); parts.bb[i] = R('bb', bb.bb_pct[i]);
    parts.sma20[i] = R('sma20', st20[i]); parts.sma50[i] = R('sma50', st50[i]); parts.streak[i] = R('streak', streak[i]);
    parts.roc[i] = R('roc', z20[i]); parts.climax[i] = climaxCtx ? R('climax', vratio[i]) : 0;
    parts.candle[i] = candle ? 1 : 0; parts.divergence[i] = diverg ? 1 : 0;
  }
  const score = full(n, 0);
  for (const k of Object.keys(RULES)) for (let i = 0; i < n; i++) score[i] += parts[k][i] * RULES[k].weight;
  return {
    parts, score, pattern,
    raw: { rsi14, rsi2, bb_pct: bb.bb_pct, st20, st50, streak, roc20: roc20.map((x) => x * 100), z20, vratio, atr, sma20, sma50, rsi_peak: rsiPeak },
  };
}
export const scoreSeries = (b: Bars) => components(b).score;

export function tier(score: number, tiers = TIERS): string | null {
  for (const [lo, name] of tiers) if (score >= lo) return name;
  return null;
}

export interface History {
  threshold: number; fwd_bars: number; dip_bars: number; episodes: number; on_for: number;
  lower_share: number | null; avg_fwd_pct: number | null; median_dip_pct: number | null; worst_fwd_pct: number | null; best_fwd_pct: number | null;
  uncond_lower_share: number | null; uncond_avg_fwd_pct: number | null;
}
const r2 = (x: number, d = 2) => (isNum(x) && Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : null);

export function episodes(score: Series, close: Series, low: Series, threshold = HIST_THRESHOLD) {
  const n = score.length, on = score.map((s) => s >= threshold);
  const usable: number[] = [];
  for (let i = 0; i < n; i++) if (on[i] && !(i > 0 && on[i - 1]) && i < n - FWD_BARS) usable.push(i);
  let onFor = 0;
  for (let i = n - 1; i >= 0 && on[i]; i--) onFor++;
  const fwdAll: number[] = [];
  for (let i = 0; i + FWD_BARS < n; i++) fwdAll.push(close[i + FWD_BARS] / close[i] - 1);
  const uLower = fwdAll.filter((x) => x < 0).length, uSum = fwdAll.reduce((a, x) => a + x, 0);
  const out: History & { _uncond: [number, number, number]; _fwd?: number[]; _dips?: number[] } = {
    threshold, fwd_bars: FWD_BARS, dip_bars: DIP_BARS, episodes: usable.length, on_for: onFor,
    lower_share: null, avg_fwd_pct: null, median_dip_pct: null, worst_fwd_pct: null, best_fwd_pct: null,
    uncond_lower_share: fwdAll.length ? r2(uLower / fwdAll.length, 3) : null, uncond_avg_fwd_pct: fwdAll.length ? r2((uSum / fwdAll.length) * 100) : null,
    _uncond: [uLower, fwdAll.length, uSum],
  };
  if (!usable.length) return out;
  const fwd = usable.map((i) => close[i + FWD_BARS] / close[i] - 1);
  const dips = usable.map((i) => {
    let m = Infinity;
    for (let j = i + 1; j < Math.min(n, i + 1 + DIP_BARS); j++) if (isNum(low[j])) m = Math.min(m, low[j]);
    return m / close[i] - 1;
  });
  Object.assign(out, {
    lower_share: r2(fwd.filter((x) => x < 0).length / fwd.length, 3), avg_fwd_pct: r2((fwd.reduce((a, x) => a + x, 0) / fwd.length) * 100),
    median_dip_pct: r2(median(dips) * 100), worst_fwd_pct: r2(Math.min(...fwd) * 100), best_fwd_pct: r2(Math.max(...fwd) * 100), _fwd: fwd, _dips: dips,
  });
  return out;
}

function valueText(key: string, r: Record<string, number>, pattern: string): string {
  switch (key) {
    case 'rsi14': return `RSI-14 ${r.rsi14.toFixed(0)}`;
    case 'rsi2': return `RSI-2 ${r.rsi2.toFixed(0)}`;
    case 'bb': return `%B ${r.bb_pct.toFixed(2)}`;
    case 'sma20': return `${r.st20.toFixed(1)} ATR above the 20-day SMA`;
    case 'sma50': return `${r.st50.toFixed(1)} ATR above the 50-day SMA`;
    case 'streak': return `${r.streak} up closes in a row`;
    case 'roc': return `20-day ${r.roc20 >= 0 ? '+' : ''}${r.roc20.toFixed(1)}% = ${r.z20.toFixed(1)}x its volatility`;
    case 'climax': return `volume ${r.vratio.toFixed(1)}x the 20-day average at a 20-day high`;
    case 'candle': return pattern || 'reversal candle';
    case 'divergence': return `new 20-day high with RSI-14 ${r.rsi14.toFixed(0)} vs peak ${r.rsi_peak.toFixed(0)}`;
  }
  return '';
}

export interface FiredRule { key: string; label: string; origin: string; rule: string; points: number; max_points: number; value: string }
export function row(sym: string, b: Bars) {
  const { parts, score, raw, pattern } = components(b);
  const n = b.c.length, i = n - 1, s = score[i], last = b.c[i];
  const R: Record<string, number> = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, v[i]]));
  const fired: FiredRule[] = [];
  for (const [k, meta] of Object.entries(RULES)) {
    const p = parts[k][i];
    if (p > 0) fired.push({ key: k, label: meta.label, origin: meta.origin, rule: meta.rule, points: Math.round(p * meta.weight * 10) / 10, max_points: meta.weight, value: valueText(k, R, pattern[i]) });
  }
  fired.sort((a, b2) => b2.points - a.points);
  const hist = episodes(score, b.c, b.l);
  const chg = (k: number) => (n > k ? r2((last / b.c[n - 1 - k] - 1) * 100) : null);
  let hi52 = -Infinity;
  for (let j = Math.max(0, n - 252); j < n; j++) hi52 = Math.max(hi52, b.h[j]);
  const { _uncond, _fwd, _dips, ...history } = hist;
  return {
    symbol: sym, name: sym.replace(/\.(NS|BO)$/, ''), price: r2(last), chg_1d: chg(1), chg_5d: chg(5), chg_20d: chg(20),
    score: Math.round(s), tier: tier(s), rules: fired,
    rsi14: r2(R.rsi14, 1), rsi2: r2(R.rsi2, 1), bb_pct: r2(R.bb_pct), stretch20: r2(R.st20, 1), stretch50: r2(R.st50, 1),
    streak: isNum(R.streak) ? R.streak : 0, z20: r2(R.z20, 1), vol_ratio: r2(R.vratio), atr_pct: r2((R.atr / last) * 100), sma20: r2(R.sma20),
    to_sma20_pct: r2((R.sma20 / last - 1) * 100), dist_52w_high: r2((last / hi52 - 1) * 100),
    history, spark: b.c.slice(-60).map((x) => Math.round(x * 100) / 100), spark_sma: raw.sma20.slice(-60).map((x) => r2(x)),
    bar_time: b.t[i], _hist: hist,
  };
}
export type OverextendedRow = Omit<ReturnType<typeof row>, '_hist'> & { via?: string | null; sector?: string; market_cap?: number | null };

/** Pool rows into the scan result (the caller downloads frames: 2 years of daily bars per symbol). */
export function summarize(frames: Map<string, Bars>, symbols: string[], name: string, universe: string) {
  const rows: OverextendedRow[] = [], missing: string[] = [];
  const fwd: number[] = [], dips: number[] = [];
  let uL = 0, uT = 0, uS = 0;
  for (const s of symbols) {
    const b = frames.get(s);
    if (!b || b.c.length < 60) { missing.push(s); continue; }
    try {
      const { _hist: h, ...m } = row(s, b);
      uL += h._uncond[0]; uT += h._uncond[1]; uS += h._uncond[2];
      if (h._fwd) { fwd.push(...h._fwd); dips.push(...h._dips!); }
      rows.push(m);
    } catch (e) { missing.push(`${s}: ${(e as Error).message}`); }
  }
  rows.sort((a, b) => b.score - a.score || (b.chg_20d ?? 0) - (a.chg_20d ?? 0));
  const counts: Record<string, number> = {};
  for (const [, t] of TIERS) counts[t] = rows.filter((r) => r.tier === t).length;
  return {
    universe, name, scanned: symbols.length, rows, counts, tiers: TIERS.map(([min, n]) => ({ min, name: n })), missing,
    base_rate: {
      threshold: HIST_THRESHOLD, fwd_bars: FWD_BARS, dip_bars: DIP_BARS, episodes: fwd.length, years: 2,
      lower_share: fwd.length ? r2(fwd.filter((x) => x < 0).length / fwd.length, 3) : null,
      avg_fwd_pct: fwd.length ? r2((fwd.reduce((a, x) => a + x, 0) / fwd.length) * 100) : null,
      median_dip_pct: dips.length ? r2(median(dips) * 100) : null,
      uncond_lower_share: uT ? r2(uL / uT, 3) : null, uncond_avg_fwd_pct: uT ? r2((uS / uT) * 100) : null,
    },
    rules: Object.entries(RULES).map(([key, v]) => ({ key, ...v })),
    generated_at: new Date().toISOString(),
  };
}
