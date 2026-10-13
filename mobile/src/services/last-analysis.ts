/**
 * The most recent analysis per symbol|interval (in memory), so other screens - the Learning view, History -
 * can show what the model learned without re-running it.  `subscribe` notifies on every new analysis.
 */
import type { Prediction } from '@/engine/learner';

import type { AnalysisResult } from './analysis';

export interface LastAnalysis { key: string; symbol: string; interval: string; result: AnalysisResult; learner: Prediction | null; at: number }
const store = new Map<string, LastAnalysis>();
let latest: LastAnalysis | null = null;
const subs = new Set<(a: LastAnalysis) => void>();

const learners = new Map<string, Prediction | null>();
/** Called by the learner hook with its raw prediction; picked up by the next recordAnalysis for the same chart. */
export function noteLearner(symbol: string, interval: string, p: Prediction | null) { learners.set(`${symbol}|${interval}`, p); }

export function recordAnalysis(symbol: string, interval: string, result: AnalysisResult) {
  const key = `${symbol}|${interval}`;
  const learner = result.summary && (result.summary as any).prob_source === 'walk-forward learner' ? learners.get(key) ?? null : null;
  const a = { key, symbol, interval, result, learner, at: Date.now() };
  store.set(a.key, a);
  latest = a;
  subs.forEach((s) => s(a));
}
export const getAnalysis = (symbol: string, interval: string) => store.get(`${symbol}|${interval}`) ?? null;
export const latestAnalysis = () => latest;
export const allAnalyses = () => [...store.values()].sort((a, b) => b.at - a.at);
export function subscribe(cb: (a: LastAnalysis) => void) { subs.add(cb); return () => { subs.delete(cb); }; }
