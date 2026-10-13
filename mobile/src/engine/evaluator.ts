/**
 * Port of the pure grading logic of app/evaluator.py (grade, _try_resolve) plus data.bar_is_forming.
 * Scheduling and persistence stay with the caller: tryResolve returns the outcome and the caller stores it
 * (db.resolve_prediction(id, outcome, resolved_price, actual_move_pct_raw)) and rebuilds the stats.
 * Pure TypeScript (runs on Hermes).
 */
import { Bars } from './types';
import { INDIA_SESSION_UTC, intervalSeconds, parseIso, pyRound } from './trading';

export type Outcome = 'correct' | 'incorrect' | 'no_call';

/**
 * (outcome, resolved_price, actual_move_pct) for a completed horizon `path` (the horizon bars after the call).
 * UP is correct if the close at the horizon is above entry OR the target was touched; DOWN mirrors that.
 * SIDEWAYS means the system stood aside: `no_call` (counts in neither side of the accuracy figure).
 */
export function grade(direction: string, priceAt: number, target: number | null | undefined, _expectedMovePct: number | null | undefined,
  path: Bars): [Outcome, number, number] {
  const endClose = Number(path.c[path.c.length - 1]);
  const movePct = (endClose / priceAt - 1) * 100;
  let hitTarget = false;
  if (target != null) {
    if (direction === 'UP') hitTarget = path.h.some((h) => h >= target);
    else if (direction === 'DOWN') hitTarget = path.l.some((l) => l <= target);
  }
  let ok: boolean;
  if (direction === 'UP') ok = endClose > priceAt || hitTarget;
  else if (direction === 'DOWN') ok = endClose < priceAt || hitTarget;
  else return ['no_call', endClose, movePct];
  return [ok ? 'correct' : 'incorrect', endClose, movePct];
}

export function isIndian(symbol: string): boolean {
  const s = symbol.toUpperCase();
  return s.endsWith('.NS') || s.endsWith('.BO') || ['^NSEI', '^NSEBANK', '^BSESN', '^CNXIT', '^INDIAVIX'].includes(s);
}

/**
 * True when the bar starting at `lastBarT` (epoch seconds UTC) has not closed yet at `nowMs`.
 * Intraday: open until start + interval. Daily / weekly: open until the session close of its last day
 * (10:00 UTC = 15:30 IST for NSE/BSE; weekly bars are stamped Monday and end Friday), else the next midnight UTC.
 */
export function barIsForming(symbol: string, interval: string, lastBarT: number, nowMs: number = Date.now()): boolean {
  const sec = intervalSeconds(interval);
  const start = lastBarT * 1000;
  if (sec < 86400) return nowMs < start + sec * 1000;
  const weekly = sec >= 604800;
  const lastDay = start + (weekly ? 4 : 0) * 86400000;
  if (isIndian(symbol)) {
    const [h, m] = INDIA_SESSION_UTC[1];
    const mid = Math.floor(lastDay / 86400000) * 86400000;
    return nowMs < mid + (h * 60 + m) * 60000;
  }
  return nowMs < lastDay + 86400000;
}

/** The prediction fields tryResolve reads (same names as the predictions table). */
export interface PendingPrediction {
  id: number; symbol: string; interval: string; bar_time: string | number; horizon_bars: number;
  direction: string; price_at: number; target_price?: number | null; expected_move_pct?: number | null;
  [k: string]: any;
}
export interface ResolveResult {
  id: number; symbol: string; direction: string; outcome: Outcome; resolved_price: number; actual_move_pct: number;
  /** Unrounded move, what Python stores in predictions.actual_move_pct. */
  actual_move_pct_raw: number;
}

/** bar_time as epoch seconds (an ISO string without offset is UTC, like the naive pandas index). */
export function barTimeSeconds(bt: string | number): number {
  return typeof bt === 'number' ? bt : (parseIso(bt) as number) / 1000;
}

/** Drop the forming last bar (it is not a result yet). */
function completed(p: PendingPrediction, bars: Bars, nowMs: number): number {
  const n = bars.t.length;
  return n && barIsForming(p.symbol, p.interval, bars.t[n - 1], nowMs) ? n - 1 : n;
}

/** Resolve one prediction against `bars` if enough completed bars have printed after its bar; null otherwise. */
export function tryResolve(p: PendingPrediction, bars: Bars, nowMs: number = Date.now()): ResolveResult | null {
  const n = completed(p, bars, nowMs);
  const bt = barTimeSeconds(p.bar_time);
  const idx: number[] = [];
  for (let i = 0; i < n; i++) if (bars.t[i] > bt) idx.push(i);
  if (idx.length < p.horizon_bars) return null;
  const take = idx.slice(0, p.horizon_bars);
  const path: Bars = { t: take.map((i) => bars.t[i]), o: take.map((i) => bars.o[i]), h: take.map((i) => bars.h[i]), l: take.map((i) => bars.l[i]), c: take.map((i) => bars.c[i]), v: take.map((i) => bars.v[i]) };
  const [outcome, endClose, move] = grade(p.direction, p.price_at, p.target_price, p.expected_move_pct, path);
  return { id: p.id, symbol: p.symbol, direction: p.direction, outcome, resolved_price: endClose, actual_move_pct: pyRound(move, 3), actual_move_pct_raw: move };
}

/** Bars printed after the prediction's bar (resolve_pending's "waiting" progress; counts the forming bar too, as Python does). */
export function barsDone(p: PendingPrediction, bars: Bars): number {
  const bt = barTimeSeconds(p.bar_time);
  let k = 0;
  for (const t of bars.t) if (t > bt) k++;
  return k;
}
