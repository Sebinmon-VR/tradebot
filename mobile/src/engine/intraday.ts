/**
 * Intraday overextension - port of app/intraday_ext.py: stocks that ran too far from TODAY's open (side "up")
 * or fell too far below it (side "down", the same rules on the mirrored frame: prices negated, high/low
 * swapped, so R-pivots become S-pivots and RSI becomes 100 - RSI).  Every 5-minute bar gets a 0-100 score;
 * the module also measures, over ~60 sessions, where earlier such sessions closed.
 */
import * as ind from './indicators';
import { isNum, median } from './series';
import { Bars, istDate, istDay, istMinutes, istTime } from './types';
import { ramp } from './overextended';

export const INTERVAL = '5m', HIST_RANGE = '60d';
export const HIST_THRESHOLD = 35;
export const LAST_SIGNAL_MIN = 14 * 60 + 30;   // episodes after 14:30 IST leave too little of the session to judge
export const FADE_GIVEBACK = 0.5;              // "the push has failed": half of the move from the open handed back
export const SKIP_OPEN_BARS = 2;               // 09:15 and 09:20: VWAP and RSI are meaningless on one or two bars
// tiers from 60 days of 5-minute bars (NIFTY 100 + mid/small caps, before 14:30): a session peaks at 25+ on
// roughly 12% of stock-days, 35+ on about 4% and 50+ on about 1%
export const TIERS: [number, string][] = [[50, 'stretched'], [35, 'extended'], [25, 'warming']];
export const MIN_SCORE = 25;
export type Side = 'up' | 'down';

interface Rule { label: string; weight: number; lo?: number; hi?: number; origin: string; rule: string }
export const RULES: Record<string, Rule> = {
  run: { label: 'Run from the open', weight: 30, lo: 1.0, hi: 2.5, origin: "Wilder's ATR as the yardstick; Toby Crabel, Day Trading with Short Term Price Patterns and Opening Range Breakout (1990)", rule: "Price more than 1 daily ATR above today's open; full points at 2.5 ATR" },
  vwap: { label: 'Stretched above VWAP', weight: 20, lo: 1.5, hi: 3.0, origin: 'VWAP (Berkowitz, Logue & Noser, 1988) with volume-weighted standard-deviation bands', rule: 'Price more than 1.5 sigma above the session VWAP; full points at 3 sigma' },
  pivot: { label: 'Through the floor pivots', weight: 15, origin: "Classic floor-trader pivots from yesterday's high, low and close", rule: 'Above R1 = 1/3, above R2 = 2/3, above R3 = full points' },
  rsi: { label: '5-min RSI overbought', weight: 15, lo: 70, hi: 85, origin: 'J. Welles Wilder, New Concepts in Technical Trading Systems (1978)', rule: 'RSI-14 on 5-minute bars above 70; full points at 85' },
  rvol: { label: 'Volume climax', weight: 10, lo: 2.0, hi: 5.0, origin: "Richard Wyckoff's buying climax; relative volume at the same time of day", rule: 'Volume so far today at least 2x the 20-session average by this time; full points at 5x' },
  giveback: { label: 'Giving back from the high', weight: 10, lo: 0.25, hi: 0.6, origin: 'Failed push / upthrust (Wyckoff): the run is already being sold', rule: 'After a run of 1+ ATR, a quarter or more of it handed back from the high; full points at 60%' },
};
export const RULES_DOWN: Record<string, Rule> = {
  run: { ...RULES.run, label: 'Fall from the open', rule: "Price more than 1 daily ATR below today's open; full points at 2.5 ATR" },
  vwap: { ...RULES.vwap, label: 'Stretched below VWAP', rule: 'Price more than 1.5 sigma below the session VWAP; full points at 3 sigma' },
  pivot: { ...RULES.pivot, rule: 'Below S1 = 1/3, below S2 = 2/3, below S3 = full points' },
  rsi: { ...RULES.rsi, label: '5-min RSI oversold', rule: 'RSI-14 on 5-minute bars below 30; full points at 15' },
  rvol: { ...RULES.rvol, origin: "Richard Wyckoff's selling climax; relative volume at the same time of day" },
  giveback: { ...RULES.giveback, label: 'Bouncing off the low', origin: 'Failed break / spring (Wyckoff): the drop is already being bought', rule: 'After a fall of 1+ ATR, a quarter or more of it recovered from the low; full points at 60%' },
};
const KEYS = Object.keys(RULES);

export function mirror(b: Bars): Bars {
  return { t: b.t, o: b.o.map((x) => -x), c: b.c.map((x) => -x), h: b.l.map((x) => -x), l: b.h.map((x) => -x), v: b.v };
}

/** Per-bar session features (column arrays).  For side "down" everything is in mirrored space. */
export interface Features {
  n: number; t: number[]; day: number[]; k: number[]; open: number[]; hi: number[]; lo: number[]; close: number[]; dayClose: number[];
  atrPrev: number[]; prevClose: number[]; p: number[]; r1: number[]; r2: number[]; r3: number[];
  runAtr: number[]; highAtr: number[]; vwap: number[]; vwapZ: number[]; rsi: number[]; rvol: number[]; giveback: number[];
  chgPrev: number[]; chgOpen: number[]; gap: number[]; score: number[]; parts: Record<string, number[]>; peak: number[]; fading: boolean[];
}

export function features(bars: Bars, side: Side = 'up'): Features {
  const b = side === 'down' ? mirror(bars) : bars;
  const { c, h, l, o } = b, n = c.length;
  const v = b.v.map((x) => (isNum(x) ? x : 0));
  const day = b.t.map(istDay);
  // sessions (runs of the same IST day) and the daily bars they aggregate to
  const runs: { d: number; s: number; e: number }[] = [];
  for (let i = 0; i < n; i++) {
    if (!runs.length || runs[runs.length - 1].d !== day[i]) runs.push({ d: day[i], s: i, e: i + 1 });
    else runs[runs.length - 1].e = i + 1;
  }
  const D = runs.length;
  const daily: Bars = { t: runs.map((r) => b.t[r.s]), o: [], h: [], l: [], c: [], v: [] };
  for (const r of runs) {
    let hh = -Infinity, ll = Infinity;
    for (let i = r.s; i < r.e; i++) { hh = Math.max(hh, h[i]); ll = Math.min(ll, l[i]); }
    daily.o.push(o[r.s]); daily.h.push(hh); daily.l.push(ll); daily.c.push(c[r.e - 1]); daily.v.push(0);
  }
  const dAtr = ind.atr(daily, 14);
  const F: Features = {
    n, t: b.t, day, k: new Array(n), open: new Array(n), hi: new Array(n), lo: new Array(n), close: c, dayClose: new Array(n),
    atrPrev: new Array(n), prevClose: new Array(n), p: new Array(n), r1: new Array(n), r2: new Array(n), r3: new Array(n),
    runAtr: new Array(n), highAtr: new Array(n), vwap: new Array(n), vwapZ: new Array(n), rsi: ind.rsi(c, 14), rvol: new Array(n),
    giveback: new Array(n), chgPrev: new Array(n), chgOpen: new Array(n), gap: new Array(n), score: new Array(n).fill(0),
    parts: Object.fromEntries(KEYS.map((k) => [k, new Array(n).fill(0)])), peak: new Array(n), fading: new Array(n),
  };
  // relative volume: cumulative volume by bar k vs the mean of the previous 20 sessions at the same k
  // (pandas: pivot day x k, rolling(20, min_periods=5).mean().shift(1) down the days)
  const cumByDay: number[][] = runs.map((r) => { const a: number[] = []; let acc = 0; for (let i = r.s; i < r.e; i++) { acc += v[i]; a.push(acc); } return a; });
  for (let di = 0; di < D; di++) {
    const r = runs[di];
    const ph = di > 0 ? daily.h[di - 1] : NaN, pl = di > 0 ? daily.l[di - 1] : NaN, pc = di > 0 ? daily.c[di - 1] : NaN;
    const pp = (ph + pl + pc) / 3, atrPrev = di > 0 ? dAtr[di - 1] : NaN;
    const atr = atrPrev === 0 ? NaN : atrPrev;
    let hiSoFar = -Infinity, loSoFar = Infinity, tpv = 0, tp2v = 0, cv = 0;
    for (let i = r.s; i < r.e; i++) {
      const k = i - r.s;
      hiSoFar = Math.max(hiSoFar, h[i]); loSoFar = Math.min(loSoFar, l[i]);
      const tp = (h[i] + l[i] + c[i]) / 3;
      tpv += tp * v[i]; tp2v += tp * tp * v[i]; cv += v[i];
      F.k[i] = k; F.open[i] = o[r.s]; F.hi[i] = hiSoFar; F.lo[i] = loSoFar; F.dayClose[i] = c[r.e - 1];
      F.atrPrev[i] = atrPrev; F.prevClose[i] = pc; F.p[i] = pp; F.r1[i] = 2 * pp - pl; F.r2[i] = pp + (ph - pl); F.r3[i] = ph + 2 * (pp - pl);
      F.runAtr[i] = (c[i] - o[r.s]) / atr; F.highAtr[i] = (hiSoFar - o[r.s]) / atr;
      const vw = cv === 0 ? NaN : tpv / cv;
      F.vwap[i] = vw;
      let sd = Math.sqrt(Math.max(0, cv === 0 ? NaN : tp2v / cv - vw * vw));
      if (isNum(atr)) sd = Math.max(sd, 0.1 * atr);                // a few bars in, sigma is tiny: floor it
      F.vwapZ[i] = (c[i] - vw) / sd;
      let sum = 0, cnt = 0;
      for (let dj = Math.max(0, di - 20); dj < di; dj++) { const x = cumByDay[dj][k]; if (x !== undefined) { sum += x; cnt++; } }
      const typical = cnt >= 5 ? sum / cnt : NaN;
      F.rvol[i] = typical === 0 ? NaN : cumByDay[di][k] / typical;
      const push = hiSoFar - o[r.s];
      F.giveback[i] = F.highAtr[i] >= 1 ? (push === 0 ? NaN : (hiSoFar - c[i]) / push) : 0;
      F.chgPrev[i] = (c[i] / pc - 1) * 100; F.chgOpen[i] = (c[i] / o[r.s] - 1) * 100; F.gap[i] = (o[r.s] / pc - 1) * 100;
      const up = c[i] > o[r.s] && isNum(atr) && k >= SKIP_OPEN_BARS;
      if (up) {
        const R = (key: string, x: number) => ramp(x, RULES[key].lo!, RULES[key].hi!);
        const piv = ((c[i] > F.r1[i] ? 1 : 0) + (c[i] > F.r2[i] ? 1 : 0) + (c[i] > F.r3[i] ? 1 : 0)) / 3;
        F.parts.run[i] = R('run', F.runAtr[i]); F.parts.vwap[i] = R('vwap', F.vwapZ[i]); F.parts.pivot[i] = piv;
        F.parts.rsi[i] = R('rsi', F.rsi[i]); F.parts.rvol[i] = R('rvol', F.rvol[i]); F.parts.giveback[i] = R('giveback', F.giveback[i]);
        let s = 0;
        for (const key of KEYS) s += F.parts[key][i] * RULES[key].weight;
        F.score[i] = s;
      }
      F.peak[i] = Math.max(k > 0 ? F.peak[i - 1] : 0, F.score[i]);
      // "fading": reached the extended line and handed back half the move.  Measured 2026-09-29 on 60 days of
      // NIFTY 100 + mid/small caps (up side): 63% closed lower, avg -0.26% to the close, stable across both
      // halves; the down-side mirror ("bouncing") showed no edge.
      F.fading[i] = F.peak[i] >= HIST_THRESHOLD && c[i] > o[r.s] && k >= SKIP_OPEN_BARS && F.giveback[i] >= FADE_GIVEBACK;
    }
  }
  return F;
}

export function tier(score: number): string | null {
  for (const [lo, name] of TIERS) if (score >= lo) return name;
  return null;
}

type Outcomes = [number[], number[], number[]];
/** First bar of each session where `mask` holds: move to the close, further run, deepest pullback - all in the
 *  direction of the move (negative = it reversed), so the same code serves the mirrored down side. */
function firstOutcomes(F: Features, end: number, mask: (i: number) => boolean): Outcomes {
  const fwd: number[] = [], further: number[] = [], dips: number[] = [];
  let lastDay = -1;
  for (let i = 0; i < end; i++) {
    if (F.day[i] === lastDay || !mask(i)) continue;
    lastDay = F.day[i];
    const px = F.close[i];
    let mx = -Infinity, mn = Infinity, j = i + 1;
    for (; j < end && F.day[j] === F.day[i]; j++) { mx = Math.max(mx, F.hi[j]); mn = Math.min(mn, F.lo[j]); }
    fwd.push((F.dayClose[i] - px) / Math.abs(px));
    further.push(j > i + 1 ? (mx - px) / Math.abs(px) : 0);
    dips.push(j > i + 1 ? (mn - px) / Math.abs(px) : 0);
  }
  return [fwd, further, dips];
}
const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
function summary([fwd, further, dips]: Outcomes, sgn = 1) {
  if (!fwd.length) return { episodes: 0, reversal_share: null, avg_fwd_pct: null, median_further_pct: null, median_dip_pct: null };
  return {
    episodes: fwd.length, reversal_share: round(fwd.filter((x) => x < 0).length / fwd.length, 3),
    avg_fwd_pct: round((sgn * fwd.reduce((a, x) => a + x, 0) / fwd.length) * 100), median_further_pct: round(sgn * median(further) * 100),
    median_dip_pct: round(sgn * median(dips) * 100),
  };
}

export function episodes(F: Features, threshold = HIST_THRESHOLD, sgn = 1) {
  const lastDay = F.day[F.n - 1];
  let end = F.n;
  while (end > 0 && F.day[end - 1] === lastDay) end--;
  const ok = (i: number) => istMinutes(F.t[i]) <= LAST_SIGNAL_MIN;
  const run = firstOutcomes(F, end, (i) => ok(i) && F.score[i] >= threshold);
  const fade = firstOutcomes(F, end, (i) => ok(i) && F.fading[i]);
  let bLower = 0, bTotal = 0;
  for (let i = 0; i < end; i++) {
    if (!ok(i) || !(F.close[i] > F.open[i]) || F.k[i] < SKIP_OPEN_BARS) continue;
    bTotal++;
    if ((F.dayClose[i] - F.close[i]) / Math.abs(F.close[i]) < 0) bLower++;
  }
  const sessions = new Set(F.day).size - 1;
  return {
    threshold, sessions, ...summary(run, sgn), fade: summary(fade, sgn), uncond_reversal_share: bTotal ? round(bLower / bTotal, 3) : null,
    _run: run, _fade: fade, _base: [bLower, bTotal] as [number, number],
  };
}

const num = (x: number, d = 2) => (isNum(x) && Number.isFinite(x) ? round(x, d) : null);

export function row(sym: string, bars: Bars, side: Side = 'up') {
  const F = features(bars, side);
  const sgn = side === 'down' ? -1 : 1, i = F.n - 1;
  const px = (x: number) => (isNum(x) ? num(sgn * x) : null);
  const s = F.score[i];
  const hist = episodes(F, HIST_THRESHOLD, sgn);
  let t0 = i;
  while (t0 > 0 && F.day[t0 - 1] === F.day[i]) t0--;
  let peak = 0, peakAt = -1;
  for (let j = t0; j <= i; j++) if (F.score[j] > peak) { peak = F.score[j]; peakAt = j; }
  const phase = F.fading[i] ? 'fading' : s >= HIST_THRESHOLD ? 'running' : null;
  const lvl = (['r3', 'r2', 'r1'] as const).find((k) => isNum(F[k][i]) && F.close[i] > F[k][i]);
  const pre = side === 'down' ? 'S' : 'R';
  const rules = side === 'down' ? RULES_DOWN : RULES;
  const d = {
    symbol: sym, name: sym.replace(/\.(NS|BO)$/, ''), side, price: px(F.close[i]), session: istDate(F.t[i]), bar_time: F.t[i],
    open: px(F.open[i]), extreme: px(F.hi[i]), prev_close: px(F.prevClose[i]),
    chg_prev: num(F.chgPrev[i]), chg_open: num(F.chgOpen[i]), gap: num(F.gap[i]),
    extreme_from_open: num((F.hi[i] / F.open[i] - 1) * 100),
    run_atr: num(sgn * F.runAtr[i], 1), extreme_atr: num(sgn * F.highAtr[i], 1), atr_pct: num((F.atrPrev[i] / Math.abs(F.close[i])) * 100),
    vwap: px(F.vwap[i]), vwap_z: num(sgn * F.vwapZ[i], 1),
    rsi: num(side === 'down' ? 100 - F.rsi[i] : F.rsi[i], 0), rvol: num(F.rvol[i], 1),
    giveback: F.highAtr[i] >= 1 ? num(F.giveback[i] * 100, 0) : null,
    level_prefix: pre, levels: { p: px(F.p[i]), l1: px(F.r1[i]), l2: px(F.r2[i]), l3: px(F.r3[i]) },
    beyond: lvl ? pre + lvl[1] : null,
    score: Math.round(s), tier: tier(s), peak_today: Math.round(peak), phase,
    peak_time: peak > 0 ? istTime(F.t[peakAt]) : null,
    history: (({ _run, _fade, _base, ...h }) => h)(hist),
    spark: F.close.slice(t0, i + 1).map(px), spark_vwap: F.vwap.slice(t0, i + 1).map(px),
    rules: [] as { key: string; label: string; origin: string; rule: string; points: number; max_points: number; value: string }[],
  };
  const below = side === 'down';
  const text = (key: string): string => {
    switch (key) {
      case 'run': return `${Math.abs(d.run_atr ?? 0).toFixed(1)} ATR ${below ? 'below' : 'above'} the open (${(d.chg_open ?? 0) >= 0 ? '+' : ''}${(d.chg_open ?? 0).toFixed(1)}%)`;
      case 'vwap': return `${Math.abs(d.vwap_z ?? 0).toFixed(1)} sigma ${below ? 'below' : 'above'} VWAP ${(d.vwap ?? 0).toFixed(2)}`;
      case 'pivot': return `${below ? 'below' : 'above'} ${d.beyond} (${((d.levels as any)['l' + d.beyond![1]] ?? 0).toFixed(2)})`;
      case 'rsi': return `RSI-14 (5m) ${(d.rsi ?? 0).toFixed(0)}`;
      case 'rvol': return `volume ${(d.rvol ?? 0).toFixed(1)}x usual by this time`;
      case 'giveback': return `${(d.giveback ?? 0).toFixed(0)}% of the ${below ? 'fall recovered from' : 'run given back from'} ${(d.extreme ?? 0).toFixed(2)}`;
    }
    return '';
  };
  for (const [key, meta] of Object.entries(rules)) {
    const p = F.parts[key][i];
    if (p > 0) d.rules.push({ key, label: meta.label, origin: meta.origin, rule: meta.rule, points: round(p * meta.weight, 1), max_points: meta.weight, value: text(key) });
  }
  d.rules.sort((a, b) => b.points - a.points);
  return { ...d, _hist: hist };
}
export type IntradayRow = Omit<ReturnType<typeof row>, '_hist'> & { sector?: string; market_cap?: number | null };

export function summarize(frames: Map<string, Bars>, symbols: string[], name: string, universe: string, side: Side = 'up') {
  const sgn = side === 'down' ? -1 : 1;
  let rows: IntradayRow[] = [];
  const missing: string[] = [];
  const pools = { _run: [[], [], []] as Outcomes, _fade: [[], [], []] as Outcomes };
  let bL = 0, bT = 0;
  for (const s of symbols) {
    const b = frames.get(s);
    if (!b || b.c.length < 300) { missing.push(s); continue; }
    try {
      const { _hist: h, ...m } = row(s, b, side);
      for (const k of ['_run', '_fade'] as const) for (let j = 0; j < 3; j++) pools[k][j].push(...h[k][j]);
      bL += h._base[0]; bT += h._base[1];
      rows.push(m);
    } catch (e) { missing.push(`${s}: ${(e as Error).message}`); }
  }
  const latest = rows.reduce<string | null>((m, r) => (m && m > r.session ? m : r.session), null);
  rows = rows.filter((r) => r.session === latest);    // a stale symbol (suspended, no bars today) is not "today"
  rows.sort((a, b) => b.peak_today - a.peak_today || sgn * ((b.chg_open ?? 0) - (a.chg_open ?? 0)));
  const counts: Record<string, number> = {};
  for (const [, t] of TIERS) counts[t] = rows.filter((r) => tier(r.peak_today) === t).length;
  counts.fading = rows.filter((r) => r.phase === 'fading').length;
  counts.running = rows.filter((r) => r.phase === 'running').length;
  return {
    universe, name, scanned: symbols.length, session: latest, rows, counts, tiers: TIERS.map(([min, n]) => ({ min, name: n })), missing, side,
    base_rate: {
      threshold: HIST_THRESHOLD, ...summary(pools._run, sgn), fade: summary(pools._fade, sgn), uncond_reversal_share: bT ? round(bL / bT, 3) : null,
      fade_rule: `after reaching ${HIST_THRESHOLD}+, at least ${FADE_GIVEBACK * 100}% of the ${side === 'down' ? 'fall from the open recovered' : 'run from the open given back'}`,
    },
    rules: Object.entries(side === 'down' ? RULES_DOWN : RULES).map(([key, v]) => ({ key, ...v })),
    generated_at: new Date().toISOString(),
  };
}
