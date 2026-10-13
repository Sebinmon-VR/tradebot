/**
 * Backtests and as-of analyses on the phone - port of app/evaluator.py backtest() and the as_of path of
 * app/ensemble.py analyze().  At each past point the full analysis (40 strategies + models + the walk-forward
 * learner) is run on ONLY the bars up to and including that point, then graded right away against the bars
 * that followed (engine/evaluator.ts tryResolve, the same grading as live predictions).
 *
 * Honesty: every point slices the bars first, so indicators, strategy votes, labels and the learner fit only
 * ever see the past; points run oldest first so a cached learner fit is never newer than the point it serves
 * (the learner refits whenever the cached fit is from a later bar).  The per-strategy hit rates that tilt the
 * rule weights are the current ones, as in the Python backtest.
 *
 * This does the analysis itself (analyzeCore + the learner) rather than calling services/analysis.ts analyze(),
 * so the Learning screen's "latest analysis" stays the chart's live one and is not replaced by a past point.
 */
import { DEFAULT_HORIZON, LearnerInput, analyzeCore } from '@/engine/ensemble';
import { tryResolve } from '@/engine/evaluator';
import { computeAll } from '@/engine/indicators';
import { predict, predictionSummary } from '@/engine/learner';
import { INTERVAL_SECONDS } from '@/engine/trading';
import { Bars, DataError, sliceBars } from '@/engine/types';
import { Fetched, barIsForming, fetchBars } from '@/engine/yahoo';

import { markResolved, rebuildStats, savePrediction, strategyStats } from './predictions';

/** Python: min_history = 120 bars before the earliest test point; analyze() itself needs 60. */
export const MIN_HISTORY = 120;
const yieldToUi = () => new Promise((r) => setTimeout(r, 0));

export interface GradedPoint {
  bar_time: string; direction: 'UP' | 'DOWN' | 'SIDEWAYS'; prob_up: number; confidence: number;
  expected_accuracy: number | null; evidence: string | null; prob_source: string;
  price_at: number; target_price: number | null; stop_price: number | null;
  resolved_price: number | null; actual_move_pct: number | null; outcome: 'correct' | 'incorrect' | 'no_call' | null;
  id?: number;
}
export interface BacktestResult {
  symbol: string; interval: string; horizon_bars: number; steps: number; calls: number; no_call: number;
  correct: number; incorrect: number; accuracy: number | null;
  /** Share of the tested windows that closed higher - the hit rate of "always call UP". */
  up_rate: number | null;
  /** max(up_rate, 1 - up_rate): what always calling the majority side would have scored. */
  base_rate: number | null;
  by_direction: Record<string, { correct: number; incorrect: number; no_call: number }>;
  results: GradedPoint[]; cancelled: boolean; seconds: number;
}

/** Completed bars only (a forming last bar is not a result yet). */
function closedBars(f: Fetched, interval: string): Bars {
  const b = f.bars, n = b.t.length;
  return n && barIsForming(f.dataSymbol, interval, b.t[n - 1]) ? sliceBars(b, 0, n - 1) : b;
}

/** ensemble.analyze(df=past): the full analysis on bars [0, idx] of `bars`, learner included. */
async function analyzeAt(symbol: string, interval: string, fetched: Fetched, bars: Bars, idx: number, horizon: number) {
  const sec = INTERVAL_SECONDS[interval] ?? 86400;
  const past = sliceBars(bars, 0, idx + 1);
  if (past.t.length < 60) throw new DataError(`Only ${past.t.length} bars available before this point; need at least 60.`);
  const frame = computeAll(past);
  const stats = await strategyStats();
  let learner: LearnerInput | null = null, learnerError: string | null = null;
  try {
    const pr = await predict(symbol, interval, horizon, { bars: past, f: frame }, sec);
    if (pr) {
      learner = {
        prob: pr.prob, threshold: pr.fit.threshold, tierAccuracy: pr.tier?.accuracy ?? null, fitAccuracy: pr.fit.accuracy,
        learnedWeights: pr.fit.learnedWeights, signals: pr.signals, summary: predictionSummary(pr),
      };
    }
  } catch (e) { learnerError = (e as Error).message; }
  await yieldToUi();
  const core = analyzeCore({ bars: past, intervalSeconds: sec, horizon, stats, learner, frame });
  return {
    symbol, interval, data_symbol: fetched.dataSymbol, note: fetched.note ?? null, created_at: core.bar_time, as_of: core.bar_time,
    ...core, learner_error: learnerError,
  };
}
type PastAnalysis = Awaited<ReturnType<typeof analyzeAt>>;

function gradeNow(symbol: string, interval: string, r: PastAnalysis, bars: Bars) {
  return tryResolve({ id: 0, symbol, interval, bar_time: r.bar_time, horizon_bars: r.horizon_bars, direction: r.direction,
    price_at: r.price_at, target_price: r.target_price, expected_move_pct: r.expected_move_pct }, bars);
}

function pointOf(r: PastAnalysis, g: ReturnType<typeof gradeNow>): GradedPoint {
  const S = r.summary as any;
  return {
    bar_time: r.bar_time, direction: r.direction, prob_up: r.prob_up, confidence: r.confidence,
    expected_accuracy: S.expected_accuracy ?? null, evidence: S.learner?.evidence ?? null, prob_source: S.prob_source,
    price_at: r.price_at, target_price: r.direction === 'SIDEWAYS' ? null : r.target_price, stop_price: r.stop_price,
    resolved_price: g ? g.resolved_price : null, actual_move_pct: g ? g.actual_move_pct : null, outcome: g ? g.outcome : null,
  };
}

export interface BacktestOpts {
  horizon?: number;
  /** how many past points (Python `steps`, 1-100) */
  steps?: number;
  /** bars between points (default = horizon, so the graded windows do not overlap) */
  stepBars?: number;
  /** store each point as a prediction (source 'backtest'), graded, feeding the accuracy stats */
  save?: boolean;
  onProgress?: (done: number, total: number, last: GradedPoint | null) => void;
  /** set `.cancelled = true` to stop after the point in progress */
  cancel?: { cancelled: boolean };
}

/** evaluator.backtest(): walk back through history, analyse each point with only its past, grade it. */
export async function backtest(symbol: string, interval: string, opts: BacktestOpts = {}): Promise<BacktestResult> {
  const started = Date.now();
  const fetched = await fetchBars(symbol, interval);
  const bars = closedBars(fetched, interval);
  const horizon = Math.max(1, Math.trunc(opts.horizon || DEFAULT_HORIZON[interval] || 10));
  const steps = Math.max(1, Math.min(100, Math.trunc(opts.steps ?? 10)));
  const stepBars = Math.max(1, Math.trunc(opts.stepBars || horizon));
  const save = opts.save !== false;
  const n = bars.t.length;
  const cuts: number[] = [];
  const end = n - horizon - 1;                      // the last point must leave `horizon` future bars
  for (let i = 0; i < steps; i++) {
    const idx = end - i * stepBars;
    if (idx < MIN_HISTORY) break;
    cuts.push(idx);
  }
  if (!cuts.length) throw new DataError(`Not enough history for a backtest on ${fetched.dataSymbol} ${interval} (${n} bars).`);
  cuts.reverse();                                    // oldest first
  const results: GradedPoint[] = [];
  opts.onProgress?.(0, cuts.length, null);
  for (const idx of cuts) {
    if (opts.cancel?.cancelled) break;
    const r = await analyzeAt(fetched.dataSymbol, interval, fetched, bars, idx, horizon);
    const g = gradeNow(fetched.dataSymbol, interval, r, bars);
    const pt = pointOf(r, g);
    if (save) {
      pt.id = await savePrediction(fetched.dataSymbol, interval, r, { source: 'backtest', createdAt: r.bar_time });
      if (g) await markResolved(pt.id, g.outcome, g.resolved_price, g.actual_move_pct_raw);
    }
    results.push(pt);
    opts.onProgress?.(results.length, cuts.length, pt);
    await yieldToUi();
  }
  if (save && results.length) await rebuildStats();
  return summarise(fetched.dataSymbol, interval, horizon, results, !!opts.cancel?.cancelled && results.length < cuts.length, (Date.now() - started) / 1000);
}

export function summarise(symbol: string, interval: string, horizon: number, results: GradedPoint[], cancelled: boolean, seconds: number): BacktestResult {
  const graded = results.filter((r) => r.outcome === 'correct' || r.outcome === 'incorrect');
  const correct = graded.filter((r) => r.outcome === 'correct').length;
  const byDir: BacktestResult['by_direction'] = {};
  for (const r of results) {
    if (!r.outcome) continue;
    const b = (byDir[r.direction] ??= { correct: 0, incorrect: 0, no_call: 0 });
    b[r.outcome] += 1;
  }
  const moves = results.filter((r) => r.actual_move_pct != null);
  const upRate = moves.length ? moves.filter((r) => (r.actual_move_pct as number) > 0).length / moves.length : null;
  return {
    symbol, interval, horizon_bars: horizon, steps: results.length, calls: graded.length, no_call: results.length - graded.length,
    correct, incorrect: graded.length - correct, accuracy: graded.length ? correct / graded.length : null,
    up_rate: upRate, base_rate: upRate == null ? null : Math.max(upRate, 1 - upRate), by_direction: byDir, results, cancelled, seconds,
  };
}

/**
 * The as-of analysis (POST /api/analyze with as_of): history cut at the last bar at or before `asOf`
 * (epoch seconds), analysed, and - since the future is already known - graded at once when `horizon` bars
 * have printed after it.  Saved with source 'asof' unless save=false.
 */
export async function analyzeAsOf(symbol: string, interval: string, asOf: number, opts: { horizon?: number; save?: boolean } = {}) {
  const fetched = await fetchBars(symbol, interval);
  const bars = closedBars(fetched, interval);
  const horizon = Math.max(1, Math.trunc(opts.horizon || DEFAULT_HORIZON[interval] || 10));
  let idx = -1;
  for (let i = 0; i < bars.t.length; i++) if (bars.t[i] <= asOf) idx = i; else break;
  if (idx + 1 < 60) throw new DataError(`Only ${idx + 1} bars available before that time; need at least 60.`);
  const r = await analyzeAt(fetched.dataSymbol, interval, fetched, bars, idx, horizon);
  const g = gradeNow(fetched.dataSymbol, interval, r, bars);
  const pt = pointOf(r, g);
  if (opts.save !== false) {
    pt.id = await savePrediction(fetched.dataSymbol, interval, r, { source: 'asof', createdAt: r.bar_time });
    if (g) { await markResolved(pt.id, g.outcome, g.resolved_price, g.actual_move_pct_raw); await rebuildStats(); }
  }
  return { result: r, point: pt, barsAfter: bars.t.length - 1 - idx };
}
