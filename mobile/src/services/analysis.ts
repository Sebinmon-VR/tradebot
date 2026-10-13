/**
 * One analysis on the phone - the port of ensemble.analyze(): strategies + models vote, the walk-forward
 * learner (when it has a validated fit) makes the call, the result is stored as a prediction that is graded
 * automatically once its horizon has passed.
 */
import { DEFAULT_HORIZON, LearnerInput, analyzeCore } from '@/engine/ensemble';
import { computeAll } from '@/engine/indicators';
import { INTERVAL_SECONDS } from '@/engine/trading';
import { Bars, sliceBars } from '@/engine/types';
import { Fetched, barIsForming } from '@/engine/yahoo';

import { recordAnalysis } from './last-analysis';
import { savePrediction, strategyStats } from './predictions';

export type LearnerHook = (symbol: string, interval: string, horizon: number, bars: Bars, sec: number) => Promise<LearnerInput | null>;
let learnerHook: LearnerHook | null = null;
/** Set by services/learner.ts once the on-phone learner is wired. */
export function setLearnerHook(h: LearnerHook | null) { learnerHook = h; }

const yieldToUi = () => new Promise((r) => setTimeout(r, 0));

export async function analyze(symbol: string, interval: string, fetched: Fetched, opts: { horizon?: number; livePrice?: number | null; save?: boolean } = {}) {
  const sec = INTERVAL_SECONDS[interval] ?? 86400;
  const horizon = opts.horizon ?? DEFAULT_HORIZON[interval] ?? 10;
  let bars = fetched.bars;
  const n = bars.t.length;
  let formingBar: { t: number; close: number } | null = null;
  if (n && barIsForming(fetched.dataSymbol, interval, bars.t[n - 1])) {
    formingBar = { t: bars.t[n - 1], close: bars.c[n - 1] };
    bars = sliceBars(bars, 0, n - 1);        // the forming bar is not a result yet
  }
  await yieldToUi();
  const stats = await strategyStats();
  let learner: LearnerInput | null = null, learnerError: string | null = null;
  if (learnerHook) {
    try { learner = await learnerHook(symbol, interval, horizon, bars, sec); } catch (e) { learnerError = (e as Error).message; }
  }
  await yieldToUi();
  const core = analyzeCore({ bars, intervalSeconds: sec, horizon, stats, learner, frame: computeAll(bars), formingBar, livePrice: opts.livePrice });
  const result = {
    symbol, interval, data_symbol: fetched.dataSymbol, note: fetched.note ?? null, created_at: new Date().toISOString(), ...core,
    learner_error: learnerError, prediction_id: null as number | null,
  };
  if (opts.save !== false) result.prediction_id = await savePrediction(symbol, interval, result);
  recordAnalysis(symbol, interval, result);
  return { result, bars };
}
export type AnalysisResult = Awaited<ReturnType<typeof analyze>>['result'];
