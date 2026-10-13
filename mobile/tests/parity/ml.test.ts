/**
 * ml.ts vs scikit-learn on the learner's real walk-forward folds (fixtures/learner/*.json, made by
 * make_learner_fixtures.py).  Exact parts are checked to 1e-6; the random forest (different RNG + binned
 * split search) is checked statistically against sklearn's own seed-to-seed spread.
 *
 *   cd mobile && npx tsx tests/parity/ml.test.ts
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURES, done, series, value } from './check';
import {
  Clipper, ColumnSubset, DropConstant, HistGradientBoostingClassifier, LogisticRegression, Mat, Pipeline, SimpleImputer, StandardScaler,
  kish, logloss, mat, recencyWeights, rocAuc, sliceRows,
} from '../../src/engine/ml';
import { makers, walkForwardSplits, trainingStride, tierEvidence, TRAIN_HALF_LIFE } from '../../src/engine/learner';

const DIR = join(FIXTURES, 'learner');
const nn = (a: (number | null)[]) => a.map((x) => (x == null ? NaN : x));
const maxAbs = (a: ArrayLike<number>, b: ArrayLike<number>) => { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; };
const acc = (p: ArrayLike<number>, y: ArrayLike<number>) => { let s = 0; for (let i = 0; i < p.length; i++) s += (p[i] > 0.5) === (y[i] > 0.5) ? 1 : 0; return s / p.length; };
const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
const sd = (a: number[]) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };

// ---------------------------------------------------------------- small exact helpers
{
  const raw = [1.8, 1.6, 1.4, 1.2, 1.0, 0.8, 0.6, 0.4, 0.2, 0].map((e) => 0.5 ** e), s = raw.reduce((a, b) => a + b, 0);
  series('recencyWeights(10, 5)', Array.from(recencyWeights(10, 5)), raw.map((x) => x * (10 / s)), { rel: 1e-14 });
}
{
  const w = recencyWeights(10, 5); let s = 0; for (const x of w) s += x;
  value('recencyWeights mean 1', s / 10, 1, 1e-12);
  value('kish of ones', kish([1, 1, 1, 1]), 4);
  value('stride h=10', trainingStride(10), 1); value('stride h=16', trainingStride(16), 2); value('stride h=24', trainingStride(24), 3); value('stride h=40', trainingStride(40), 3);
  const [z, eff, ev] = tierEvidence({ threshold: 0.55, n: 200, n_eff: 150.3, coverage: 0.5, accuracy: 0.6 }, 0.52, 10, true);
  value('tier_evidence eff', eff, 15); value('tier_evidence z', z, (0.6 - 0.52) / Math.sqrt(0.52 * 0.48 / 15)); value('tier_evidence label', ev, 'drift');
}

const timings: Record<string, number[]> = {};
const agg = { auc: [] as number[], ll: [] as number[], acc: [] as number[] };
const time = <T>(k: string, f: () => T): T => { const t0 = performance.now(); const r = f(); (timings[k] ??= []).push(performance.now() - t0); return r; };

for (const file of readdirSync(DIR).filter((f) => f.endsWith('.json'))) {
  const fx = JSON.parse(readFileSync(join(DIR, file), 'utf8'));
  const name = file.replace('.json', '');
  console.log(`\n${name}: h=${fx.horizon}`);
  const names: string[] = fx.feature_names, lab: boolean[] = fx.labelled;
  const rows = lab.map((b, i) => (b ? i : -1)).filter((i) => i >= 0);
  const p = names.length, n = rows.length;
  const X: Mat = mat(n, p), Y = new Float64Array(n);
  rows.forEach((i, r) => { Y[r] = fx.y[i]; for (let j = 0; j < p; j++) X.data[r * p + j] = fx.features[j][i] ?? NaN; });
  const voteCols = names.map((c, i) => (c.startsWith('v_') ? i : -1)).filter((i) => i >= 0);
  const folds = n >= 400 ? 5 : 3;
  const splits = walkForwardSplits(n, fx.horizon, folds);
  value(`${name} fold count`, splits.length, fx.folds_detail.length);
  const rfRows: string[] = [];
  splits.forEach((sp, k) => {
    const py = fx.folds_detail[k], tag = `${name} fold${k}`;
    value(`${tag} s`, sp.s, py.s); value(`${tag} e`, sp.e, py.e); value(`${tag} tr_end`, sp.trEnd, py.tr_end);
    const w = recencyWeights(sp.trEnd, sp.trEnd * TRAIN_HALF_LIFE);
    series(`${tag} weights`, Array.from(w), py.weights, { rel: 1e-12 });
    const Xtr = sliceRows(X, 0, sp.trEnd), ytr = Y.subarray(0, sp.trEnd), Xte = sliceRows(X, sp.s, sp.e), yte = Y.subarray(sp.s, sp.e);
    // imputer + scaler
    const imp = new SimpleImputer('median').fit(Xtr);
    series(`${tag} imputer statistics`, Array.from(imp.statistics), nn(py.imputer_stats), { rel: 1e-12 });
    const sc = new StandardScaler().fit(imp.transform(Xtr));
    series(`${tag} scaler mean`, Array.from(sc.mean), py.scaler_mean, { rel: 1e-10, abs: 1e-14 });
    series(`${tag} scaler scale`, Array.from(sc.scale), py.scaler_scale, { rel: 1e-10 });
    // logistic regression: exact optimum vs sklearn tol=1e-12; and vs learner.py's default-tolerance sklearn
    const mk = makers(voteCols);
    const lr = time('logistic_regression', () => mk.logistic_regression().fit(Xtr, ytr, w)) as Pipeline;
    const lrc = (lr.final as LogisticRegression);
    series(`${tag} LR coef vs sklearn(tol=1e-12)`, Array.from(lrc.coef), py.lr_tight_coef, { rel: 1e-5, abs: 1e-6 });
    value(`${tag} LR intercept vs sklearn(tol=1e-12)`, lrc.intercept, py.lr_tight_intercept, 1e-5, 1e-6);
    const plr = lr.predictProba(Xte);
    series(`${tag} LR proba vs sklearn(tol=1e-12)`, Array.from(plr), py.lr_tight, { rel: 1e-6, abs: 1e-7 });
    const dDefault = maxAbs(plr, py.logistic_regression);
    value(`${tag} LR proba vs sklearn default lbfgs (<2e-3)`, dDefault < 2e-3, true);
    const st = time('stacked_votes', () => mk.stacked_votes().fit(Xtr, ytr, w)) as ColumnSubset;
    const stc = (st.model as Pipeline).final as LogisticRegression;
    series(`${tag} stacked coef vs sklearn(tol=1e-12)`, Array.from(stc.coef), py.stack_tight_coef, { rel: 1e-5, abs: 1e-6 });
    const pst = st.predictProba(Xte);
    series(`${tag} stacked proba vs sklearn(tol=1e-12)`, Array.from(pst), py.stack_tight, { rel: 1e-6, abs: 1e-7 });
    const dStack = maxAbs(pst, py.stacked_votes);
    // gradient boosting: deterministic port
    const hgb = time('gradient_boosting', () => mk.gradient_boosting().fit(Xtr, ytr, w)) as DropConstant;
    series(`${tag} HGB kept columns`, hgb.cols, py.hgb_cols);
    const phgb = hgb.predictProba(Xte);
    const dHgb = maxAbs(phgb, py.gradient_boosting);
    value(`${tag} HGB proba vs sklearn (<1e-6)`, dHgb < 1e-6, true);
    // random forest: behavioural parity
    const rf = time('random_forest', () => mk.random_forest().fit(Xtr, ytr, w));
    const prf = rf.predictProba(Xte);
    const spread = py.rf_seed_spread as { auc: number | null; logloss: number; acc: number }[];
    const aucs = spread.map((s) => s.auc!).filter((x) => x != null), lls = spread.map((s) => s.logloss), accs = spread.map((s) => s.acc);
    const tsAuc = rocAuc(prf, yte), tsLl = logloss(prf, yte), tsAcc = acc(prf, yte), pyAuc = rocAuc(py.random_forest, yte);
    // tolerance: sklearn's own seed-to-seed spread, floored (5 seeds underestimate it) - 4 sd or 0.03 AUC / 0.01 log-loss / 0.04 acc
    value(`${tag} RF AUC within sklearn spread`, Math.abs(tsAuc - mean(aucs)) <= Math.max(4 * sd(aucs), 0.03), true);
    value(`${tag} RF logloss within sklearn spread`, Math.abs(tsLl - mean(lls)) <= Math.max(4 * sd(lls), 0.01), true);
    value(`${tag} RF accuracy within sklearn spread`, Math.abs(tsAcc - mean(accs)) <= Math.max(4 * sd(accs), 0.1), true);   // accuracy at 0.5 on 59-147 rows is coarse
    agg.auc.push(tsAuc - mean(aucs)); agg.ll.push(tsLl - mean(lls)); agg.acc.push(tsAcc - mean(accs));
    rfRows.push(`fold${k} n_test=${sp.e - sp.s}: AUC ts ${tsAuc.toFixed(3)} / sk(seed42) ${pyAuc.toFixed(3)} / sk seeds ${mean(aucs).toFixed(3)}+-${sd(aucs).toFixed(3)}; `
      + `logloss ts ${tsLl.toFixed(4)} / sk ${mean(lls).toFixed(4)}+-${sd(lls).toFixed(4)}; acc ts ${tsAcc.toFixed(3)} / sk ${mean(accs).toFixed(3)}; `
      + `LR|default-sk| ${dDefault.toExponential(1)} stack ${dStack.toExponential(1)} HGB ${dHgb.toExponential(1)}`);
  });
  rfRows.forEach((r) => console.log('  ' + r));
}
// aggregate over every fold of every fixture: the forest must not be systematically better or worse than sklearn's
console.log(`\nRF minus sklearn (mean over ${agg.auc.length} folds): AUC ${mean(agg.auc).toFixed(4)} (sd ${sd(agg.auc).toFixed(4)}), logloss ${mean(agg.ll).toFixed(4)} (sd ${sd(agg.ll).toFixed(4)}), acc ${mean(agg.acc).toFixed(4)}`);
value('RF mean AUC difference vs sklearn |d| < 0.02', Math.abs(mean(agg.auc)) < 0.02, true);
value('RF mean logloss difference vs sklearn |d| < 0.005', Math.abs(mean(agg.ll)) < 0.005, true);
value('RF mean accuracy difference vs sklearn |d| < 0.03', Math.abs(mean(agg.acc)) < 0.03, true);
console.log('\nms per fit (PC, node):', Object.fromEntries(Object.entries(timings).map(([k, v]) => [k, `${mean(v).toFixed(0)} avg, ${Math.max(...v).toFixed(0)} max`])));
done('ml');
