/**
 * Wires the walk-forward learner (engine/learner.ts) into the app: strategy votes cached in the phone's
 * database (they are pure functions of closed bars, so they survive restarts), NIFTY 50 bars for the market
 * factor, and progress events for the UI - the first fit of a chart is the slow part (tens of seconds on a
 * phone); fits are then reused for an hour and a cached prediction takes milliseconds.
 */
import { computeAll } from '@/engine/indicators';
import { VoteCache, VoteTable, configureLearner, predict, predictionSummary } from '@/engine/learner';
import { STRATEGIES, votesAt } from '@/engine/strategies';
import { fetchBars } from '@/engine/yahoo';
import { kv } from '@/storage/db';

import { setLearnerHook } from './analysis';
import { noteLearner } from './last-analysis';

type Listener = (stage: string, done: number, total: number) => void;
const listeners = new Set<Listener>();
export function onLearnerProgress(cb: Listener) { listeners.add(cb); return () => { listeners.delete(cb); }; }

const voteCache: VoteCache = {
  async load(symbol, interval) {
    try {
      const raw = await kv.get(`votes|${symbol}|${interval}`);
      if (!raw) return null;
      const t = JSON.parse(raw) as VoteTable;
      t.cols = t.cols.map((col) => col.map((v) => (v == null ? NaN : v)));   // JSON has no NaN
      return t;
    } catch { return null; }
  },
  async save(symbol, interval, table) {
    try { await kv.set(`votes|${symbol}|${interval}`, JSON.stringify(table)); } catch { /* cache only */ }
  },
};

let ready = false;
export function initLearner() {
  if (ready) return;
  ready = true;
  configureLearner({
    strategies: STRATEGIES, votesAt, cache: voteCache,
    fetchMarket: async (iv) => (await fetchBars('^NSEI', iv, { background: true })).bars,
    onProgress: (stage, done, total) => listeners.forEach((l) => l(stage, done, total)),
  });
  setLearnerHook(async (symbol, interval, horizon, bars, sec) => {
    const pr = await predict(symbol, interval, horizon, { bars, f: computeAll(bars) }, sec);
    noteLearner(symbol, interval, pr);
    if (!pr) return null;
    return {
      prob: pr.prob, threshold: pr.fit.threshold, tierAccuracy: pr.tier?.accuracy ?? null, fitAccuracy: pr.fit.accuracy,
      learnedWeights: pr.fit.learnedWeights, signals: pr.signals, summary: predictionSummary(pr),
    };
  });
}
