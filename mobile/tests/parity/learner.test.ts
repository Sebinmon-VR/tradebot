/**
 * learner.ts vs app/learner.py (fixtures/learner/*.json, made by make_learner_fixtures.py).  The vote table
 * comes from Python's strategy_votes (served through an in-memory VoteCache), so this test does not depend on
 * strategies.ts.  Deterministic stages (vote index, market factor, features, labels, calibration from the same
 * out-of-fold predictions, tiers, evidence) must match exactly; the full fit contains the random forest, so its
 * scores are compared with a tolerance and printed side by side.
 *
 *   cd mobile && npx tsx tests/parity/learner.test.ts
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURES, done, series, toBars, value } from './check';
import { computeAll } from '../../src/engine/indicators';
import {
  LEARNER_NAMES, LearnerDeps, MAX_ROWS, VoteCache, VoteTable, buildFeatures, calibrateOof, catalog, clearLearnerCaches, fit, labelledRows,
  marketFeatures, predict, predictionSummary, strategyVotes, trainingStride,
} from '../../src/engine/learner';

const DIR = join(FIXTURES, 'learner');
const nn = (a: (number | null)[]) => a.map((x) => (x == null ? NaN : x));
const maxAbs = (a: ArrayLike<number>, b: ArrayLike<number>) => { let m = 0; for (let i = 0; i < a.length; i++) if (a[i] === a[i]) m = Math.max(m, Math.abs(a[i] - b[i])); return m; };

function memCache(t: VoteTable | null): VoteCache & { saved: number } {
  let table = t;
  return {
    saved: 0,
    async load() { return table; },
    async save(_s, _i, tb) { table = tb; this.saved++; },
  };
}

async function main() {
  value('catalog size', catalog().length, 5);
  for (const file of readdirSync(DIR).filter((f) => f.endsWith('.json'))) {
    const fx = JSON.parse(readFileSync(join(DIR, file), 'utf8'));
    const name = file.replace('.json', '');
    const bfx = JSON.parse(readFileSync(join(FIXTURES, name + '.json'), 'utf8'));
    const bars = toBars(bfx.bars), data = { bars, f: computeAll(bars) };
    const { symbol, interval, sec, horizon } = fx;
    console.log(`\n${name}: ${bars.t.length} bars, h=${horizon}`);
    clearLearnerCaches();
    const table: VoteTable = { t: fx.votes.t, close: fx.votes.close, keys: fx.votes.keys, cols: fx.votes.cols.map(nn) };
    const cache = memCache(table);
    const deps: Partial<LearnerDeps> = { strategies: {}, cache, fetchMarket: async () => toBars(fx.market_bars), isIndian: () => true, now: () => 2e9 };

    // ---- votes (from the cache), market factor, features, labels
    const stride = trainingStride(horizon);
    value(`${name} stride`, stride, fx.stride);
    const votes = await strategyVotes(symbol, interval, data, sec, MAX_ROWS, stride, deps);
    series(`${name} vote index`, votes.t, fx.votes_idx);
    value(`${name} no vote recompute`, cache.saved, 0);
    const market = await marketFeatures(symbol, interval, votes.t, deps);
    for (const k of ['mkt_ret_1', 'mkt_ret_5', 'mkt_ret_20', 'mkt_vol_20'] as const) series(`${name} ${k}`, market![k], fx.market_features[k], { rel: 1e-9, abs: 1e-12 });
    const feats = buildFeatures(data, votes, market, horizon, sec);
    value(`${name} feature names`, JSON.stringify(feats.names), JSON.stringify(fx.feature_names));
    const worst: [string, number][] = [];
    feats.names.forEach((c, j) => {
      const k = fx.feature_names.indexOf(c);
      if (k < 0) return;
      series(`${name} feature ${c}`, Array.from(feats.cols[j]), fx.features[k], { rel: 1e-6, abs: 1e-9 });
      worst.push([c, maxAbs(feats.cols[j], nn(fx.features[k]))]);
    });
    worst.sort((a, b) => b[1] - a[1]);
    console.log('  largest feature |ts-py|:', worst.slice(0, 3).map(([c, d]) => `${c} ${d.toExponential(1)}`).join(', '));
    series(`${name} y`, Array.from(feats.y), fx.y);
    const rows = labelledRows(feats);
    series(`${name} labelled`, Array.from(feats.y, (_, i) => rows.includes(i)), fx.labelled);

    // ---- calibration / tiers / evidence from Python's own out-of-fold predictions: exact
    const Y = rows.map((i) => feats.y[i]);
    const pyOof = Object.fromEntries(LEARNER_NAMES.map((k) => [k, nn(fx.captured.oof[k])])) as any;
    const cal = calibrateOof(pyOof, Y, horizon, fx.captured.used)!;
    const F = fx.fit;
    for (const k of ['base_rate', 'up_rate', 'accuracy', 'logloss', 'logloss_base', 'half_life', 'threshold', 'validated', 'evidence', 'edge_z', 'effective_n'] as const) {
      const tsKey = ({ base_rate: 'baseRate', up_rate: 'upRate', logloss_base: 'loglossBase', half_life: 'halfLife', edge_z: 'edgeZ', effective_n: 'effectiveN' } as any)[k] ?? k;
      value(`${name} calibrated ${k}`, (cal as any)[tsKey], F[k], 1e-5, 1e-6);
    }
    value(`${name} platt a`, cal.platt[0], F.platt[0], 1e-3, 1e-4);
    value(`${name} platt b`, cal.platt[1], F.platt[1], 1e-3, 1e-4);
    cal.tiers.forEach((t, i) => {
      const p = F.tiers[i];
      value(`${name} tier ${t.threshold} n`, t.n, p.n); value(`${name} tier ${t.threshold} n_eff`, t.n_eff, p.n_eff);
      value(`${name} tier ${t.threshold} coverage`, t.coverage, p.coverage); value(`${name} tier ${t.threshold} accuracy`, t.accuracy, p.accuracy);
    });
    for (const k of LEARNER_NAMES) {
      value(`${name} ${k} oof accuracy`, cal.learnerScores[k].accuracy, F.learner_scores[k].accuracy, 1e-9);
      value(`${name} ${k} oof logloss`, cal.learnerScores[k].logloss, F.learner_scores[k].logloss, 1e-9);
    }

    // ---- the full TS fit (walk-forward + final models) and prediction
    const t0 = performance.now();
    const f = (await fit(symbol, interval, horizon, data, sec, deps))!;
    const fitMs = performance.now() - t0;
    value(`${name} fit available`, f != null, true);
    value(`${name} n_rows`, f.nRows, F.n_rows); value(`${name} n_features`, f.nFeatures, F.n_features); value(`${name} folds`, f.folds, F.folds);
    value(`${name} last_bar`, f.lastBar, F.last_bar);
    value(`${name} up_rate (labels only)`, f.upRate, F.up_rate, 1e-9);
    value(`${name} half_life`, f.halfLife, F.half_life);
    const dHgb = maxAbs(f.oof!.gradient_boosting, pyOof.gradient_boosting), dLr = maxAbs(f.oof!.logistic_regression, pyOof.logistic_regression);
    const dSt = maxAbs(f.oof!.stacked_votes, pyOof.stacked_votes), dRf = maxAbs(f.oof!.random_forest, pyOof.random_forest);
    value(`${name} HGB oof exact (<1e-9)`, dHgb < 1e-9, true);
    value(`${name} LR oof ~ sklearn lbfgs (<2e-3)`, dLr < 2e-3, true);
    value(`${name} stacked oof ~ sklearn lbfgs (<2e-3)`, dSt < 2e-3, true);
    value(`${name} RF oof accuracy within 0.08`, Math.abs(f.learnerScores.random_forest.accuracy - F.learner_scores.random_forest.accuracy) < 0.08, true);
    value(`${name} calibrated accuracy within 0.04`, Math.abs(f.accuracy - F.accuracy) < 0.04, true);
    value(`${name} calibrated logloss within 0.01`, Math.abs(f.logloss - F.logloss) < 0.01, true);
    const lw = Object.keys(F.learned_weights).map((k) => Math.abs(f.learnedWeights[k] - F.learned_weights[k]));
    value(`${name} learned weights ~ sklearn (<5e-3)`, Math.max(...lw) < 5e-3, true);
    const pr = (await predict(symbol, interval, horizon, data, sec, deps))!;
    const P = fx.prediction;
    value(`${name} predict reuses the fit`, pr.fit === f, true);
    value(`${name} predict HGB exact`, pr.perLearner.gradient_boosting!, P.per_learner.gradient_boosting, 1e-8, 1e-10);
    value(`${name} predict LR ~`, pr.perLearner.logistic_regression!, P.per_learner.logistic_regression, 0, 3e-3);
    value(`${name} predict stacked ~`, pr.perLearner.stacked_votes!, P.per_learner.stacked_votes, 0, 3e-3);
    value(`${name} predict RF within 0.1 (sklearn seed sd ~0.02)`, Math.abs(pr.perLearner.random_forest! - P.per_learner.random_forest) < 0.1, true);
    console.log(`  per learner ts ${JSON.stringify(pr.perLearner)}
  per learner py ${JSON.stringify(P.per_learner)}`);
    value(`${name} prob within 0.05`, Math.abs(pr.prob - P.prob) < 0.05, true);
    const sum = predictionSummary(pr);
    value(`${name} summary keys`, JSON.stringify(Object.keys(sum).sort()), JSON.stringify(Object.keys(P.summary).sort()));
    value(`${name} signals`, pr.signals.map((s) => s.key).join(','), P.signals.map((s: any) => s.key).join(','));
    value(`${name} fitted_on`, sum.fitted_on, P.summary.fitted_on);
    console.log(`  fit ${fitMs.toFixed(0)} ms (PC, node).  OOF max|ts-py|: HGB ${dHgb.toExponential(1)}, LR ${dLr.toExponential(1)}, stacked ${dSt.toExponential(1)}, RF ${dRf.toFixed(3)}`);
    const row = (tag: string, a: any) => `${tag}: acc ${a.acc.toFixed(3)} logloss ${a.ll.toFixed(4)} base ${a.base.toFixed(3)} thr ${a.thr} validated ${a.val} evidence ${a.ev} z ${a.z.toFixed(2)} platt (${a.platt[0].toFixed(3)}, ${a.platt[1].toFixed(3)}) P(up) ${a.prob.toFixed(3)} raw ${a.raw.toFixed(3)} RF-acc ${a.rf.toFixed(3)}`;
    console.log('  ' + row('ts', { acc: f.accuracy, ll: f.logloss, base: f.baseRate, thr: f.threshold, val: f.validated, ev: f.evidence, z: f.edgeZ, platt: f.platt, prob: pr.prob, raw: pr.probRaw, rf: f.learnerScores.random_forest.accuracy }));
    console.log('  ' + row('py', { acc: F.accuracy, ll: F.logloss, base: F.base_rate, thr: F.threshold, val: F.validated, ev: F.evidence, z: F.edge_z, platt: F.platt, prob: P.prob, raw: P.prob_raw, rf: F.learner_scores.random_forest.accuracy }));
    console.log('  ts tiers', f.tiers.map((t) => `${t.threshold}:${t.n}/${t.accuracy?.toFixed(3)}`).join(' '));
    console.log('  py tiers', F.tiers.map((t: any) => `${t.threshold}:${t.n}/${t.accuracy?.toFixed(3)}`).join(' '));
    console.log('  top features ts', f.topFeatures.slice(0, 5).map(([n]) => n).join(', '), '| py', F.top_features.slice(0, 5).map((x: any) => x[0]).join(', '));
  }
  await endToEnd();
  done('learner');
}

/** strategies.ts -> strategy_votes -> fit -> predict with nothing cached (the phone's first analysis of a chart). */
async function endToEnd() {
  let S: typeof import('../../src/engine/strategies');
  try { S = await import('../../src/engine/strategies'); } catch { console.log('\n(strategies.ts not available - end-to-end smoke test skipped)'); return; }
  for (const name of ['RELIANCE_NS_1d', 'TCS_NS_15m', 'ELECTCAST_NS_5m']) {
    const fx = JSON.parse(readFileSync(join(DIR, name + '.json'), 'utf8'));
    const bfx = JSON.parse(readFileSync(join(FIXTURES, name + '.json'), 'utf8'));
    const bars = toBars(bfx.bars);
    const { symbol, interval, sec, horizon } = fx;
    clearLearnerCaches();
    const cache = memCache(null);
    const deps: Partial<LearnerDeps> = { strategies: S.STRATEGIES, votesAt: S.votesAt, cache, fetchMarket: async () => toBars(fx.market_bars), isIndian: () => true };
    const t0 = performance.now();
    const data = { bars, f: computeAll(bars) };
    const t1 = performance.now();
    const votes = await strategyVotes(symbol, interval, data, sec, MAX_ROWS, trainingStride(horizon), deps);
    const t2 = performance.now();
    const pr = await predict(symbol, interval, horizon, data, sec, deps);
    const t3 = performance.now();
    const pr2 = await predict(symbol, interval, horizon, data, sec, deps);
    const t4 = performance.now();
    value(`${name} e2e prediction`, pr != null, true);
    value(`${name} e2e second predict reuses fit`, pr2?.fit === pr?.fit, true);
    value(`${name} e2e votes saved to cache`, cache.saved >= 1, true);
    // the TS strategies' votes vs Python's on the same windows (a parity check of strategies.ts, reported only)
    const py = new Map<number, number>(fx.votes.t.map((x: number, r: number) => [x, r]));
    let same = 0, tot = 0;
    const bad: Record<string, number> = {};
    votes.keys.forEach((k, j) => {
      const pk = fx.votes.keys.indexOf(k);
      votes.t.forEach((x, r) => {
        const pr_ = py.get(x); if (pr_ === undefined || pk < 0) return;
        tot++;
        const a = votes.cols[j][r], b = fx.votes.cols[pk][pr_] ?? NaN;
        if (Math.abs(a - b) <= 1e-6 || (a !== a && b !== b)) same++; else bad[k] = (bad[k] || 0) + 1;
      });
    });
    // the slow path (every strategy on sliced windows) must give the same votes as strategies.ts votesAt
    clearLearnerCaches();
    const slow = await strategyVotes(symbol, interval, data, sec, 30, 1, { ...deps, votesAt: null, cache: null });
    const fast = await strategyVotes(symbol, interval, data, sec, 30, 1, { ...deps, cache: null, strategies: S.STRATEGIES });
    let slowSame = 0, slowTot = 0;
    slow.cols.forEach((c, j) => c.forEach((x, r) => { slowTot++; const y = fast.cols[j][r]; if (x === y || (x !== x && y !== y)) slowSame++; }));
    console.log(`
${name} end-to-end (PC, node): computeAll ${(t1 - t0).toFixed(0)} ms, votes for ${votes.t.length} bars ${(t2 - t1).toFixed(0)} ms, `
      + `fit+predict ${(t3 - t2).toFixed(0)} ms, cached predict ${(t4 - t3).toFixed(0)} ms; total ${(t3 - t0).toFixed(0)} ms`);
    console.log(`  P(up) ${pr!.prob.toFixed(3)} (py ${fx.prediction.prob.toFixed(3)}), evidence ${pr!.evidence}, threshold ${pr!.fit.threshold}; `
      + `votes equal to Python ${(100 * same / tot).toFixed(2)}% of ${tot}${Object.keys(bad).length ? ' - differing: ' + JSON.stringify(bad) : ''}; `
      + `slice path == votesAt path ${slowSame}/${slowTot}`);
    value(`${name} sliced-window votes == votesAt votes`, slowSame, slowTot);
  }
}
main();
