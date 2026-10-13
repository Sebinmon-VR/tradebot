/**
 * Prediction history and the feedback loop on the phone - port of the prediction parts of app/db.py and
 * app/evaluator.py: every analysis is stored; once its horizon bars have printed it is graded automatically;
 * the user can grade it too; per-strategy hit rates are rebuilt from the graded ones and feed the ensemble.
 */
import type { StrategyStats } from '@/engine/ensemble';
import { tryResolve } from '@/engine/evaluator';
import { fetchBars } from '@/engine/yahoo';

import { predictionStore } from './prediction-store';

export interface PredictionRow {
  id: number; symbol: string; interval: string; horizon_bars: number; created_at: string; bar_time: string; price_at: number;
  direction: 'UP' | 'DOWN' | 'SIDEWAYS'; prob_up: number; confidence: number; target_price: number | null; stop_price: number | null;
  expected_move_pct: number | null; expires_at: string | null; signals_json: string; summary_json: string; status: 'pending' | 'resolved';
  auto_outcome: string | null; resolved_price: number | null; resolved_at: string | null; actual_move_pct: number | null;
  user_verdict: string | null; user_rating: number | null; user_note: string | null; source: string;
}
export interface PredStore {
  insert(row: Omit<PredictionRow, 'id'>): Promise<number>;
  update(id: number, patch: Partial<PredictionRow>): Promise<void>;
  list(opts?: { symbol?: string; status?: string; source?: string; limit?: number }): Promise<PredictionRow[]>;
  get(id: number): Promise<PredictionRow | null>;
  graded(): Promise<PredictionRow[]>;
  addFeedback(id: number, verdict: string, rating: number | null, note: string | null, at: string): Promise<void>;
  saveStats(stats: StrategyStats): Promise<void>;
  loadStats(): Promise<StrategyStats>;
  /** Delete a prediction and its feedback; true when it existed. */
  delete(id: number): Promise<boolean>;
  /** Feedback rows, newest first: of one prediction, or of all (joined with symbol / direction). */
  listFeedback(predictionId?: number | null, limit?: number): Promise<FeedbackRow[]>;
}
export interface FeedbackRow { id: number; prediction_id: number; verdict: string; rating: number | null; note: string | null; created_at: string; symbol?: string; direction?: string }
export const PREDICTIONS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS predictions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT NOT NULL, interval TEXT NOT NULL, horizon_bars INTEGER NOT NULL,
  created_at TEXT NOT NULL, bar_time TEXT NOT NULL, price_at REAL NOT NULL, direction TEXT NOT NULL, prob_up REAL NOT NULL,
  confidence REAL NOT NULL, target_price REAL, stop_price REAL, expected_move_pct REAL, expires_at TEXT,
  signals_json TEXT NOT NULL, summary_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', auto_outcome TEXT,
  resolved_price REAL, resolved_at TEXT, actual_move_pct REAL, user_verdict TEXT, user_rating INTEGER, user_note TEXT,
  source TEXT NOT NULL DEFAULT 'live'
);
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT, prediction_id INTEGER NOT NULL REFERENCES predictions(id) ON DELETE CASCADE,
  verdict TEXT NOT NULL, rating INTEGER, note TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS strategy_stats (
  key TEXT PRIMARY KEY, name TEXT, category TEXT, correct INTEGER NOT NULL DEFAULT 0, incorrect INTEGER NOT NULL DEFAULT 0, neutral INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_pred_symbol ON predictions(symbol, created_at);
CREATE INDEX IF NOT EXISTS idx_pred_status ON predictions(status);
`;

const nowIso = () => new Date().toISOString();
let store: PredStore | null = null;
const S = () => (store ??= predictionStore());

export async function savePrediction(symbol: string, interval: string, a: any, opts: { source?: string; createdAt?: string } = {}): Promise<number> {
  return S().insert({
    symbol, interval, horizon_bars: a.horizon_bars, created_at: opts.createdAt ?? nowIso(), bar_time: a.bar_time, price_at: a.price_at, direction: a.direction,
    prob_up: a.prob_up, confidence: a.confidence, target_price: a.target_price ?? null, stop_price: a.stop_price ?? null,
    expected_move_pct: a.expected_move_pct ?? null, expires_at: a.expires_at ?? null, signals_json: JSON.stringify(a.signals ?? []),
    summary_json: JSON.stringify(a.summary ?? {}), status: 'pending', auto_outcome: null, resolved_price: null, resolved_at: null,
    actual_move_pct: null, user_verdict: null, user_rating: null, user_note: null, source: opts.source ?? 'live',
  });
}
export const listPredictions = (opts?: { symbol?: string; status?: string; source?: string; limit?: number }) => S().list(opts);
export const getPrediction = (id: number) => S().get(id);
export const listFeedback = (predictionId?: number | null, limit = 200) => S().listFeedback(predictionId, limit);
/** Delete a prediction (and its feedback) and rebuild the per-strategy stats without it. */
export async function deletePrediction(id: number) {
  const ok = await S().delete(id);
  if (ok) await rebuildStats();
  return ok;
}
/** Store a grade computed by the caller (as-of tests / backtests know the future already: db.resolve_prediction). */
export async function markResolved(id: number, outcome: string, resolvedPrice: number, actualMovePct: number) {
  await S().update(id, { status: 'resolved', auto_outcome: outcome, resolved_price: resolvedPrice, resolved_at: nowIso(), actual_move_pct: actualMovePct });
}
export const strategyStats = () => S().loadStats();

export function finalOutcome(p: PredictionRow): string | null {
  if (p.user_verdict === 'correct' || p.user_verdict === 'incorrect' || p.user_verdict === 'partial') return p.user_verdict;
  return p.auto_outcome;
}
const DIR: Record<string, number> = { UP: 1, DOWN: -1, SIDEWAYS: 0 };
/** What the market actually did (+1 / -1 / 0), from the graded move or the user's verdict (db.actual_direction). */
export function actualDirection(p: PredictionRow): number | null {
  if (p.actual_move_pct != null && p.status === 'resolved') {
    const thr = (p.expected_move_pct || 1.0) * 0.25, m = p.actual_move_pct;
    return m > thr ? 1 : m < -thr ? -1 : 0;
  }
  const out = finalOutcome(p), pred = DIR[p.direction] ?? 0;
  if (out === 'correct') return pred;
  if (out === 'incorrect' && pred !== 0) return -pred;
  return null;
}
/** Per-strategy hit rates from every prediction with a known outcome (db.rebuild_stats). */
export async function rebuildStats(): Promise<StrategyStats> {
  const counts: StrategyStats = {};
  for (const p of await S().graded()) {
    const actual = actualDirection(p);
    if (actual == null) continue;
    for (const s of JSON.parse(p.signals_json) as any[]) {
      const c = (counts[s.key] ??= { key: s.key, name: s.name ?? s.key, category: s.category ?? '', correct: 0, incorrect: 0, neutral: 0 });
      const d = Number(s.direction ?? 0);
      if (d === 0 || (s.confidence ?? 0) < 0.2) c.neutral! += 1;
      else if (d === actual) c.correct += 1;
      else if (actual === 0) c.neutral! += 1;
      else c.incorrect += 1;
    }
  }
  await S().saveStats(counts);
  return counts;
}
export async function addFeedback(id: number, verdict: 'correct' | 'incorrect' | 'partial', rating: number | null = null, note: string | null = null) {
  await S().addFeedback(id, verdict, rating, note, nowIso());
  await rebuildStats();
  return S().get(id);
}
/** Grade every pending prediction whose horizon bars have printed (evaluator.resolve_pending). */
export async function resolvePending() {
  const pending = await S().list({ status: 'pending', limit: 500 });
  const resolved: any[] = [], waiting: any[] = [], errors: any[] = [];
  const bars = new Map<string, Awaited<ReturnType<typeof fetchBars>>['bars']>();
  for (const p of pending) {
    const key = `${p.symbol}|${p.interval}`;
    try {
      if (!bars.has(key)) bars.set(key, (await fetchBars(p.symbol, p.interval, { fresh: false, background: true })).bars);
      const r = tryResolve(p, bars.get(key)!);
      if (r) {
        await S().update(p.id, { status: 'resolved', auto_outcome: r.outcome, resolved_price: r.resolved_price, resolved_at: nowIso(), actual_move_pct: r.actual_move_pct_raw });
        resolved.push(r);
      } else waiting.push({ id: p.id, symbol: p.symbol, bars_needed: p.horizon_bars });
    } catch (e) { errors.push({ id: p.id, error: (e as Error).message }); }
  }
  if (resolved.length) await rebuildStats();
  return { resolved, waiting, errors };
}
/** Accuracy summary over every stored prediction (db.overall_stats). */
export async function overallStats() {
  const rows = await S().list({ limit: 100000 });
  const graded = rows.filter((p) => ['correct', 'incorrect', 'partial'].includes(finalOutcome(p) ?? ''));
  const n = (o: string) => graded.filter((p) => finalOutcome(p) === o).length;
  const correct = n('correct'), partial = n('partial'), incorrect = n('incorrect');
  const ratings = rows.map((p) => p.user_rating).filter((r): r is number => !!r);
  const byDirection: Record<string, { correct: number; incorrect: number; partial: number }> = {};
  for (const p of graded) {
    const b = (byDirection[p.direction] ??= { correct: 0, incorrect: 0, partial: 0 });
    b[finalOutcome(p) as 'correct' | 'incorrect' | 'partial'] += 1;
  }
  return {
    with_user_feedback: rows.filter((p) => p.user_verdict).length,
    avg_user_rating: ratings.length ? ratings.reduce((a, b) => a + b, 0) / ratings.length : null,
    by_direction: byDirection,
    total_predictions: rows.length, pending: rows.filter((p) => p.status === 'pending' && !p.user_verdict).length, evaluated: graded.length,
    no_call: rows.filter((p) => finalOutcome(p) === 'no_call').length, correct, partial, incorrect,
    accuracy: graded.length ? (correct + 0.5 * partial) / graded.length : null,
  };
}
