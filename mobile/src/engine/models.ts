/**
 * Statistical prediction models - a port of app/models.py.
 *
 * Each model forecasts the direction of the close `horizon` bars ahead and returns a Signal (same shape
 * as the rule-based strategies) whose `values` carry `prob_up` and `expected_return_pct`.  The machine-
 * learning layer (learner) is separate: it is validated walk-forward and produces the final calibrated
 * probability.
 */
import type { Signal, StrategyInput } from './signal';
import { clip } from './signal';
import { hurstExponent } from './indicators';
import { orEps, polyfit1, pyFixed, pySigned } from './strategies';

interface Meta { name: string; origin: string; category: string; rules: string }
const emitter = (key: string, m: Meta) => (direction: number, confidence: number, reason: string, values: Record<string, unknown> = {}): Signal =>
  ({ key, name: m.name, origin: m.origin, category: m.category, direction: (direction || 0) as Signal['direction'], confidence, reason, rules: m.rules, values });

/** np.log(close).diff().dropna(), optionally only the last `window` returns */
function logReturns(close: number[], window?: number): number[] {
  const r: number[] = [];
  for (let i = 1; i < close.length; i++) { const x = Math.log(close[i]) - Math.log(close[i - 1]); if (!Number.isNaN(x)) r.push(x); }
  return window ? r.slice(Math.max(0, r.length - window)) : r;
}
const meanOf = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
const stdOf = (v: number[]) => { const m = meanOf(v); return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length); };
/** np.percentile (linear interpolation) of an ascending array */
function percentile(sorted: number[], q: number): number {
  const pos = (q / 100) * (sorted.length - 1), lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
function medianOf(v: number[]): number {
  if (v.some(Number.isNaN)) return NaN;
  const s = [...v].sort((a, b) => a - b), k = s.length >> 1;
  return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2;
}

/** Least squares X b = y via Householder QR (np.linalg.lstsq for a full-column-rank X). */
export function lstsq(X: number[][], y: number[]): number[] {
  const m = X.length, n = X[0].length;
  const A = X.map((r) => r.slice()), b = y.slice();
  for (let k = 0; k < n; k++) {
    let norm = 0;
    for (let i = k; i < m; i++) norm += A[i][k] ** 2;
    norm = Math.sqrt(norm);
    if (norm === 0) continue;
    const alpha = A[k][k] > 0 ? -norm : norm;
    const v = new Array(m).fill(0);
    v[k] = A[k][k] - alpha;
    for (let i = k + 1; i < m; i++) v[i] = A[i][k];
    let vv = 0;
    for (let i = k; i < m; i++) vv += v[i] * v[i];
    if (vv === 0) continue;
    for (let j = k; j < n; j++) {
      let d = 0;
      for (let i = k; i < m; i++) d += v[i] * A[i][j];
      const f = (2 * d) / vv;
      for (let i = k; i < m; i++) A[i][j] -= f * v[i];
    }
    let d = 0;
    for (let i = k; i < m; i++) d += v[i] * b[i];
    const f = (2 * d) / vv;
    for (let i = k; i < m; i++) b[i] -= f * v[i];
  }
  const beta = new Array(n).fill(0);
  for (let k = n - 1; k >= 0; k--) {
    let s = b[k];
    for (let j = k + 1; j < n; j++) s -= A[k][j] * beta[j];
    beta[k] = A[k][k] === 0 ? 0 : s / A[k][k];
  }
  return beta;
}

// ----------------------------------------------------------------- statistical
/** OLS trend on log price: slope significance (t-stat) and R-squared give direction & confidence. */
export function linearRegressionTrend(x: StrategyInput, horizon: number, window = 60): Signal {
  const sig = emitter('linreg', { name: 'Linear Regression Trend', origin: 'Ordinary least squares on log price (classic regression channel)', category: 'statistical', rules: 'Fit a line through the last 60 log-closes. Positive, statistically significant slope = up; negative = down. R-squared measures how clean the trend is.' });
  const c = x.bars.c, y = c.slice(Math.max(0, c.length - window)).map(Math.log), n = y.length;
  if (n < 20) return sig(0, 0, 'Insufficient data');
  const [slope, intercept] = polyfit1(y);
  const my = meanOf(y), mx = (n - 1) / 2;
  let ssRes = 0, ssTot = 0, sxx = 0;
  for (let i = 0; i < n; i++) { ssRes += (y[i] - (intercept + slope * i)) ** 2; ssTot += (y[i] - my) ** 2; sxx += (i - mx) ** 2; }
  ssTot = ssTot || 1e-12;
  const r2 = 1 - ssRes / ssTot;
  const se = Math.sqrt(ssRes / Math.max(n - 2, 1) / sxx);
  const t = se > 0 ? slope / se : 0;
  const spot = c[c.length - 1];
  const expRet = (Math.exp(slope * horizon) - 1) * 100;
  const d = slope > 0 ? 1 : -1;
  const conf = clip((Math.min(Math.abs(t), 8) / 8) * 0.6 + r2 * 0.4);
  return sig(d, conf, `Slope ${pySigned(slope * 100, 3)}%/bar, t-stat ${pyFixed(t, 1)}, R2 ${pyFixed(r2, 2)}; projected ${pySigned(expRet, 2)}% in ${horizon} bars`,
    { prob_up: clip(0.5 + (d * conf) / 2), expected_return_pct: expRet, r2, t_stat: t, projected_price: spot * (1 + expRet / 100) });
}

/** Autoregressive AR(p) model on log returns, iterated `horizon` steps ahead. */
export function arReturns(x: StrategyInput, horizon: number, p = 5, window = 250): Signal {
  const sig = emitter('ar_model', { name: 'Autoregressive AR(5)', origin: 'Box-Jenkins time-series forecasting (AR component of ARIMA)', category: 'statistical', rules: 'Regress each return on the previous 5 returns, then roll the forecast forward. Sign of the cumulative forecast gives direction; size relative to volatility gives confidence.' });
  const r = logReturns(x.bars.c, window);
  if (r.length < p * 6) return sig(0, 0, 'Insufficient data');
  const X: number[][] = [], y: number[] = [];
  for (let j = 0; j + p < r.length; j++) {
    const row: number[] = [];
    for (let i = 0; i < p; i++) row.push(r[j + p - 1 - i]);   // lag i+1
    row.push(1);
    X.push(row); y.push(r[j + p]);
  }
  const beta = lstsq(X, y);
  const resid = y.map((v, j) => v - X[j].reduce((a, xv, i) => a + xv * beta[i], 0));
  const residSd = orEps(stdOf(resid));
  const hist = r.slice(-p), fc: number[] = [];
  for (let k = 0; k < horizon; k++) {
    let nxt = beta[p];
    for (let i = 0; i < p; i++) nxt += hist[hist.length - 1 - i] * beta[i];
    fc.push(nxt); hist.push(nxt);
  }
  const cum = fc.reduce((a, b) => a + b, 0);
  const expRet = (Math.exp(cum) - 1) * 100;
  const z = cum / (residSd * Math.sqrt(horizon));
  const d = cum > 0 ? 1 : -1;
  const conf = clip(Math.abs(z) * 0.8);
  return sig(d, conf, `AR(5) forecasts ${pySigned(expRet, 2)}% over ${horizon} bars (z ${pySigned(z, 2)})`,
    { prob_up: clip(0.5 + (d * conf) / 2), expected_return_pct: expRet, z });
}

/**
 * Seeded PRNG (xoshiro128**, seeded through splitmix32) with Box-Muller normals.
 * NOTE: numpy's default_rng (PCG64 + ziggurat) is not reproduced bit-for-bit, so the Monte Carlo paths
 * differ from Python's; the model's logic is identical and the result is deterministic for a given seed.
 * With 4000 paths P(up) agrees with Python within sampling error (sd ~0.008) - see tests/parity/models.test.ts.
 */
export function normalRng(seed: number): () => number {
  let s = seed >>> 0;
  const split = () => { s = (s + 0x9e3779b9) >>> 0; let z = s; z = Math.imul(z ^ (z >>> 16), 0x85ebca6b); z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35); return (z ^ (z >>> 16)) >>> 0; };
  let a = split(), b = split(), c = split(), d = split();
  const next = () => {
    const r = Math.imul(((Math.imul(b, 5) << 7) | (Math.imul(b, 5) >>> 25)), 9) >>> 0;
    const t = b << 9;
    c ^= a; d ^= b; b ^= c; a ^= d; c ^= t; d = (d << 11) | (d >>> 21);
    return r;
  };
  const uniform = () => ((next() >>> 5) * 67108864 + (next() >>> 6) + 1) / 9007199254740993;   // (0, 1)
  let spare = NaN;
  return () => {
    if (!Number.isNaN(spare)) { const z = spare; spare = NaN; return z; }
    const rad = Math.sqrt(-2 * Math.log(uniform())), th = 2 * Math.PI * uniform();
    spare = rad * Math.sin(th);
    return rad * Math.cos(th);
  };
}

/** Geometric Brownian Motion Monte Carlo: probability of finishing above spot after `horizon` bars. */
export function monteCarloGbm(x: StrategyInput, horizon: number, paths = 4000, window = 250, seed = 7): Signal {
  const sig = emitter('monte_carlo', { name: 'Monte Carlo (GBM)', origin: 'Black-Scholes-Merton style geometric Brownian motion simulation', category: 'statistical', rules: 'Simulate thousands of price paths using historical drift (shrunk 50% toward zero) and volatility. P(final > spot) is the up-probability; the 10th/90th percentiles bound the expected range.' });
  const r = logReturns(x.bars.c, window);
  if (r.length < 30) return sig(0, 0, 'Insufficient data');
  const mu = meanOf(r) * 0.5, sigma = orEps(stdOf(r));
  const rnd = normalRng(seed), spot = x.bars.c[x.bars.c.length - 1];
  const final = new Array<number>(paths);
  let up = 0;
  for (let p = 0; p < paths; p++) {
    let shock = 0;
    for (let k = 0; k < horizon; k++) shock += rnd();
    final[p] = spot * Math.exp((mu - 0.5 * sigma ** 2) * horizon + sigma * shock);
    if (final[p] > spot) up++;
  }
  final.sort((a, b) => a - b);
  const prob = up / paths;
  const q10 = percentile(final, 10), q50 = percentile(final, 50), q90 = percentile(final, 90);
  const d = prob > 0.5 ? 1 : -1;
  return sig(d, clip(Math.abs(prob - 0.5) * 2.5), `P(up) ${pyFixed(prob * 100, 0)}%; median ${pyFixed(q50, 2)}, 80% range ${pyFixed(q10, 2)} - ${pyFixed(q90, 2)}`,
    { prob_up: prob, expected_return_pct: (q50 / spot - 1) * 100, q10, q50, q90, sigma_per_bar: sigma, drift_per_bar: mu });
}

/** Nearest-neighbour analog forecasting: find the most similar past price patterns and see what followed. */
export function knnPatternAnalog(x: StrategyInput, horizon: number, window = 20, k = 30): Signal {
  const sig = emitter('knn_analog', { name: 'Pattern Analog (kNN)', origin: 'Analog / nearest-neighbour forecasting (Lorenz 1969; widely used pattern-matching approach)', category: 'statistical', rules: 'Normalise the last 20 returns, find the 30 most similar historical windows (Euclidean distance) and measure what price did over the next `horizon` bars. Share of positive outcomes = P(up).' });
  const r = logReturns(x.bars.c), n = r.length;
  if (n < window + horizon + k + 20) return sig(0, 0, 'Insufficient history for analogs');
  const norm = (a: number, b: number) => {
    const v = r.slice(a, b), m = meanOf(v), s = stdOf(v);
    return v.map((z) => (z - m) / (s > 0 ? s : 1));
  };
  const cur = norm(n - window, n);
  const cands: [number, number][] = [];
  for (let i = window; i < n - horizon; i++) {
    const seg = norm(i - window, i);
    let dd = 0;
    for (let j = 0; j < window; j++) dd += (seg[j] - cur[j]) ** 2;
    let fwd = 0;
    for (let j = i; j < i + horizon; j++) fwd += r[j];
    cands.push([Math.sqrt(dd), fwd]);
  }
  cands.sort((a, b) => a[0] - b[0]);   // stable, like Python's list.sort
  const fwd = cands.slice(0, k).map((c) => c[1]);
  const prob = fwd.filter((f) => f > 0).length / fwd.length;
  const expRet = (Math.exp(medianOf(fwd)) - 1) * 100;
  const d = prob > 0.5 ? 1 : -1;
  return sig(d, clip(Math.abs(prob - 0.5) * 2), `${Math.trunc(prob * k)} of ${k} closest historical patterns went up; median move ${pySigned(expRet, 2)}%`,
    { prob_up: prob, expected_return_pct: expRet, neighbours: k });
}

/** Hurst exponent regime detector: tells the ensemble whether to trust trend or mean-reversion strategies. */
export function hurstRegime(x: StrategyInput): Signal {
  const c = x.bars.c, h = hurstExponent(c.slice(Math.max(0, c.length - 300)));
  const sig = emitter('hurst', { name: 'Hurst Regime', origin: "H.E. Hurst (1951); Peters, 'Fractal Market Analysis' (1994)", category: 'regime', rules: 'H > 0.55 = persistent / trending market (weight trend-followers up). H < 0.45 = mean-reverting (weight oscillators up). ~0.5 = random walk.' });
  const label = h > 0.55 ? 'trending' : h < 0.45 ? 'mean-reverting' : 'random-walk';
  return sig(0, clip(Math.abs(h - 0.5) * 4), `Hurst ${pyFixed(h, 2)}: ${label} regime`, { hurst: h, regime: label });
}

export const MODELS: Record<string, (x: StrategyInput, horizon: number) => Signal> = {
  linreg: linearRegressionTrend,
  ar_model: arReturns,
  monte_carlo: monteCarloGbm,
  knn_analog: knnPatternAnalog,
};

const errMsg = (exc: unknown) => `error: ${exc instanceof Error ? exc.message : String(exc)}`;

/** Every model plus the Hurst regime signal (last); a model that throws yields an 'error' signal. */
export function runAll(x: StrategyInput, horizon: number): Signal[] {
  const out: Signal[] = [];
  for (const [key, fn] of Object.entries(MODELS)) {
    try { out.push(fn(x, horizon)); } catch (exc) { out.push({ key, name: key, origin: '', category: 'error', direction: 0, confidence: 0, reason: errMsg(exc), rules: '', values: {} }); }
  }
  try { out.push(hurstRegime(x)); } catch (exc) { out.push({ key: 'hurst', name: 'Hurst Regime', origin: '', category: 'regime', direction: 0, confidence: 0, reason: errMsg(exc), rules: '', values: {} }); }
  return out;
}
