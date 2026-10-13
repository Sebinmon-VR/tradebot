/** npx tsx tests/parity/ensemble.test.ts - analyzeCore must reproduce app/ensemble.analyze() (with db stats and the
 *  learner injected).  Pass 1 feeds Python's own signals, so the scoring is checked number-for-number; pass 2 lets
 *  the TS strategies/models produce them (Monte Carlo differs by RNG, so the rule-only probability gets a tolerance). */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { analyzeCore, chartLevels, LearnerInput } from '../../src/engine/ensemble';
import type { Signal } from '../../src/engine/signal';
import { sliceBars } from '../../src/engine/types';
import { done, FIXTURES, toBars, value } from './check';

const DIR = join(FIXTURES, 'strategies');
// fields the caller (not analyzeCore) fills in
const CALLER = new Set(['symbol', 'interval', 'created_at', 'as_of', 'data_symbol', 'note']);

const unNull = (v: any): any => v === null ? NaN : Array.isArray(v) ? v.map(unNull) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, unNull(x)])) : v;
const pySignal = (s: any): Signal => ({ ...s, values: unNull(s.values) });
const learnerOf = (spec: any): LearnerInput | null => spec && ({
  prob: spec.prob, threshold: spec.threshold, tierAccuracy: spec.tier_accuracy, fitAccuracy: spec.fit_accuracy,
  learnedWeights: spec.learned_weights, signals: spec.signals.map(pySignal), summary: spec.summary,
});

function deep(label: string, ts: any, py: any) {
  if (py === null || typeof py !== 'object') {
    if (label.endsWith('.ref_time')) return value(label, String(ts).slice(0, 10), String(py).slice(0, 10));  // UTC vs IST clock, same date
    if (typeof py === 'number' || py === null) return value(label, ts === undefined ? 'missing' : ts, py, 1e-9, 1e-9);
    return value(label, ts, py);
  }
  if (ts === null || typeof ts !== 'object') return value(`${label} (type)`, JSON.stringify(ts)?.slice(0, 80), JSON.stringify(py).slice(0, 80));
  if (Array.isArray(py)) {
    value(`${label}.length`, ts.length, py.length, 0, 0);
    py.forEach((v, i) => deep(`${label}[${i}]`, ts[i], v));
    return;
  }
  for (const k of new Set([...Object.keys(py), ...Object.keys(ts)])) {
    if (!(k in py)) { value(`${label}.${k} (extra in TS)`, 'present', 'absent'); continue; }
    deep(`${label}.${k}`, ts[k], py[k]);
  }
}

let cases = 0;
for (const file of readdirSync(DIR).filter((f) => f.endsWith('.json'))) {
  const fx = JSON.parse(readFileSync(join(DIR, file), 'utf8'));
  const bars = toBars(JSON.parse(readFileSync(join(FIXTURES, file), 'utf8')).bars);
  console.log(fx.name);
  for (const c of fx.ensemble) {
    const label = `${fx.name}[:${c.end}].${c.variant}`;
    const b = sliceBars(bars, 0, c.end);
    const py: any = Object.fromEntries(Object.entries(c.result).filter(([k]) => !CALLER.has(k)));
    const base = { bars: b, intervalSeconds: fx.sec, horizon: fx.horizon, stats: c.stats, learner: learnerOf(c.learner) };
    // pass 1: Python's signals -> exact scoring, targets, forecast, levels
    deep(label, analyzeCore({ ...base, signals: c.signals.map(pySignal) }), py);
    // pass 2: TS signals end to end
    const ts = analyzeCore(base);
    const nearThreshold = Math.abs(Math.abs(py.prob_up - 0.5) + 0.5 - py.summary.threshold) < 0.02;
    if (!nearThreshold) value(`${label}.e2e.direction`, ts.direction, py.direction);
    value(`${label}.e2e.prob_up`, ts.prob_up, py.prob_up, 0, c.learner ? 1e-9 : 0.02);
    value(`${label}.e2e.bull_score`, ts.summary.bull_score, py.summary.bull_score, 0, 0.05);
    value(`${label}.e2e.bear_score`, ts.summary.bear_score, py.summary.bear_score, 0, 0.05);
    cases++;
  }
  for (const lv of fx.chart_levels) deep(`${fx.name}[:${lv.end}].chart_levels`, chartLevels(sliceBars(bars, 0, lv.end)), lv.levels);
}
console.log(`${cases} analyze() cases compared`);
done('ensemble');
