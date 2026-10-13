/**
 * The scikit-learn pieces app/learner.py uses, written from scratch for the phone (pure TS, typed arrays):
 *
 * - SimpleImputer(strategy="median")        - exact (all-NaN training columns are dropped, like sklearn)
 * - StandardScaler                          - exact (sklearn's corrected two-pass variance, constant-feature rule)
 * - clip to +-CLIP_SD (FunctionTransformer)  - exact
 * - LogisticRegression (L2, lbfgs objective) - solved by damped Newton to ~1e-10, i.e. the exact optimum of
 *   sklearn's objective  sum_i w_i logloss_i + ||coef||^2 / (2C)  (intercept unpenalised).  sklearn's own lbfgs
 *   stops at tol=1e-4, so its coefficients sit ~1e-4..1e-3 from this optimum.
 * - RandomForestClassifier (Breiman 2001)   - bootstrap, sqrt(p) features per split, gini, min_samples_leaf
 *   counted on distinct bootstrapped rows, sample weights x bootstrap counts, MDI importances.  Split points
 *   are searched over <=255 quantile bins per feature (the histogram trick) instead of every distinct value,
 *   and the RNG differs from numpy's, so it matches sklearn in behaviour, not bit-for-bit.
 * - HistGradientBoostingClassifier          - a faithful port of sklearn's algorithm (same binning incl. the
 *   averaged_inverted_cdf percentiles, float32 gradients, native missing-value handling, gain formula, depth
 *   and min_samples_leaf rules, histogram subtraction, shrinkage).  No randomness is involved at these sizes
 *   (no early stopping below 10k rows), so predictions agree with sklearn to ~1e-9 in practice.
 * - Platt scaling, log-loss, recency weights, Kish effective size, ROC AUC (test helper).
 */

export const EPS = 2.220446049250313e-16;

// ------------------------------------------------------------------ matrices
/** Dense row-major matrix. */
export interface Mat { data: Float64Array; n: number; p: number }
export const mat = (n: number, p: number): Mat => ({ data: new Float64Array(n * p), n, p });
export function fromRows(rows: ArrayLike<number>[], p = rows.length ? rows[0].length : 0): Mat {
  const m = mat(rows.length, p);
  for (let i = 0; i < rows.length; i++) for (let j = 0; j < p; j++) m.data[i * p + j] = rows[i][j];
  return m;
}
/** Matrix from feature columns (cols[j][i] = row i of feature j). */
export function fromCols(cols: ArrayLike<number>[], n = cols.length ? cols[0].length : 0): Mat {
  const p = cols.length, m = mat(n, p);
  for (let j = 0; j < p; j++) { const c = cols[j]; for (let i = 0; i < n; i++) m.data[i * p + j] = c[i]; }
  return m;
}
export function sliceRows(X: Mat, a: number, b: number): Mat {
  return { data: X.data.slice(a * X.p, b * X.p), n: b - a, p: X.p };
}
export function takeRows(X: Mat, rows: ArrayLike<number>): Mat {
  const m = mat(rows.length, X.p);
  for (let r = 0; r < rows.length; r++) m.data.set(X.data.subarray(rows[r] * X.p, rows[r] * X.p + X.p), r * X.p);
  return m;
}
export function selectCols(X: Mat, cols: ArrayLike<number>): Mat {
  const q = cols.length, m = mat(X.n, q);
  for (let i = 0; i < X.n; i++) { const o = i * X.p, d = i * q; for (let j = 0; j < q; j++) m.data[d + j] = X.data[o + cols[j]]; }
  return m;
}

type Vec = ArrayLike<number>;

// ------------------------------------------------------------------ small helpers
export function sigmoid(x: number): number { return 1 / (1 + Math.exp(-x)); }
/** learner._logit: clip to [1e-4, 1-1e-4] first. */
export function logit(p: number): number { const q = Math.min(1 - 1e-4, Math.max(1e-4, p)); return Math.log(q / (1 - q)); }
/** learner._logloss: probabilities clipped to [1e-6, 1-1e-6]; weighted mean when w is given. */
export function logloss(p: Vec, y: Vec, w?: Vec | null): number {
  let s = 0, sw = 0;
  for (let i = 0; i < p.length; i++) {
    const q = Math.min(1 - 1e-6, Math.max(1e-6, p[i]));
    const l = -(y[i] * Math.log(q) + (1 - y[i]) * Math.log(1 - q));
    const wi = w ? w[i] : 1;
    s += wi * l; sw += wi;
  }
  return s / sw;
}
/** np.average(x, weights=w) */
export function wavg(x: Vec, w?: Vec | null): number {
  let s = 0, sw = 0;
  for (let i = 0; i < x.length; i++) { const wi = w ? w[i] : 1; s += wi * x[i]; sw += wi; }
  return s / sw;
}
/** learner._recency_weights: 1 for the newest row, halving every `halfLife` rows, scaled to mean 1. */
export function recencyWeights(n: number, halfLife: number): Float64Array {
  const w = new Float64Array(Math.max(0, n));
  if (n <= 0) return w;
  const hl = Math.max(halfLife, 1);
  let s = 0;
  for (let i = 0; i < n; i++) { w[i] = Math.pow(0.5, (n - 1 - i) / hl); s += w[i]; }
  const k = n / s;
  for (let i = 0; i < n; i++) w[i] *= k;
  return w;
}
/** Kish (1965) effective sample size. */
export function kish(w: Vec): number {
  let s = 0, s2 = 0;
  for (let i = 0; i < w.length; i++) { s += w[i]; s2 += w[i] * w[i]; }
  return w.length && s2 > 0 ? (s * s) / s2 : 0;
}
/** ROC AUC with average ranks for ties (Mann-Whitney U). */
export function rocAuc(p: Vec, y: Vec): number {
  const n = p.length, idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => p[a] - p[b]);
  const rank = new Float64Array(n);
  for (let i = 0; i < n;) {
    let j = i;
    while (j + 1 < n && p[idx[j + 1]] === p[idx[i]]) j++;
    for (let k = i; k <= j; k++) rank[idx[k]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  let pos = 0, sr = 0;
  for (let i = 0; i < n; i++) if (y[i] > 0.5) { pos++; sr += rank[i]; }
  const neg = n - pos;
  return pos && neg ? (sr - (pos * (pos + 1)) / 2) / (pos * neg) : NaN;
}

/** Seeded PRNG (mulberry32).  Deterministic across platforms. */
export class Rng {
  private s: number;
  constructor(seed: number) { this.s = seed >>> 0; }
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(k: number): number { return Math.floor(this.next() * k); }
}

// ------------------------------------------------------------------ model interface
export interface Classifier {
  fit(X: Mat, y: Vec, w?: Vec | null): this;
  /** P(class 1) per row. */
  predictProba(X: Mat): Float64Array;
}
export interface Transformer {
  fit(X: Mat): this;
  transform(X: Mat): Mat;
}

// ------------------------------------------------------------------ preprocessing
function medianOf(v: number[]): number {
  v.sort((a, b) => a - b);
  const k = v.length >> 1;
  return v.length % 2 ? v[k] : (v[k - 1] + v[k]) / 2;
}
/** SimpleImputer(strategy="median"): columns with no observed value in the training data are dropped. */
export class SimpleImputer implements Transformer {
  statistics: Float64Array = new Float64Array(0);   // NaN for dropped columns (like sklearn's statistics_)
  keep: number[] = [];
  constructor(public strategy: 'median' | 'mean' = 'median') {}
  fit(X: Mat): this {
    this.statistics = new Float64Array(X.p);
    this.keep = [];
    const buf: number[] = [];
    for (let j = 0; j < X.p; j++) {
      buf.length = 0;
      for (let i = 0; i < X.n; i++) { const x = X.data[i * X.p + j]; if (x === x) buf.push(x); }
      if (!buf.length) { this.statistics[j] = NaN; continue; }
      this.statistics[j] = this.strategy === 'median' ? medianOf(buf) : buf.reduce((a, b) => a + b, 0) / buf.length;
      this.keep.push(j);
    }
    return this;
  }
  transform(X: Mat): Mat {
    const q = this.keep.length, m = mat(X.n, q);
    for (let i = 0; i < X.n; i++) for (let k = 0; k < q; k++) {
      const j = this.keep[k], x = X.data[i * X.p + j];
      m.data[i * q + k] = x === x ? x : this.statistics[j];
    }
    return m;
  }
}

/** StandardScaler (population std; near-constant features get scale 1, exactly as sklearn decides). */
export class StandardScaler implements Transformer {
  mean: Float64Array = new Float64Array(0);
  scale: Float64Array = new Float64Array(0);
  fit(X: Mat): this {
    const { n, p } = X;
    this.mean = new Float64Array(p);
    this.scale = new Float64Array(p);
    for (let j = 0; j < p; j++) {
      let s = 0;
      for (let i = 0; i < n; i++) s += X.data[i * p + j];
      const mu = s / n;
      let corr = 0, sq = 0;
      for (let i = 0; i < n; i++) { const d = X.data[i * p + j] - mu; corr += d; sq += d * d; }
      const v = (sq - (corr * corr) / n) / n;
      const upper = n * EPS * v + (n * mu * EPS) ** 2;
      this.mean[j] = mu;
      this.scale[j] = v <= upper ? 1 : Math.sqrt(v);
    }
    return this;
  }
  transform(X: Mat): Mat {
    const m = mat(X.n, X.p);
    for (let i = 0; i < X.n; i++) for (let j = 0; j < X.p; j++) m.data[i * X.p + j] = (X.data[i * X.p + j] - this.mean[j]) / this.scale[j];
    return m;
  }
}

/** FunctionTransformer(lambda X: np.clip(X, lo, hi)) */
export class Clipper implements Transformer {
  constructor(public lo: number, public hi: number) {}
  fit(): this { return this; }
  transform(X: Mat): Mat {
    const m = mat(X.n, X.p);
    for (let k = 0; k < X.data.length; k++) { const x = X.data[k]; m.data[k] = x < this.lo ? this.lo : x > this.hi ? this.hi : x; }
    return m;
  }
}

// ------------------------------------------------------------------ logistic regression
/**
 * L2 logistic regression, the minimiser of  sum_i w_i [log(1 + e^z_i) - y_i z_i] + ||coef||^2 / (2C),
 * z = X coef + intercept - scikit-learn's objective (it divides the whole thing by sum(w), which does not
 * move the optimum).  Damped Newton with a Cholesky solve; converges in ~6-10 steps.
 */
export class LogisticRegression implements Classifier {
  coef: Float64Array = new Float64Array(0);
  intercept = 0;
  nIter = 0;
  constructor(public C = 1.0, public tol = 1e-8, public maxIter = 100) {}

  private objective(X: Mat, y: Vec, w: Vec | null, beta: Float64Array): number {
    const { n, p } = X, lam = 1 / this.C;
    let f = 0;
    for (let i = 0; i < n; i++) {
      let z = beta[p];
      const o = i * p;
      for (let j = 0; j < p; j++) z += X.data[o + j] * beta[j];
      // log(1+e^z) - y z, stable
      const l = (z > 0 ? z + Math.log1p(Math.exp(-z)) : Math.log1p(Math.exp(z))) - y[i] * z;
      f += (w ? w[i] : 1) * l;
    }
    let r = 0;
    for (let j = 0; j < p; j++) r += beta[j] * beta[j];
    return f + 0.5 * lam * r;
  }

  fit(X: Mat, y: Vec, w?: Vec | null): this {
    const { n, p } = X, d = p + 1, lam = 1 / this.C;
    const ww = w ?? null;
    let beta = new Float64Array(d);
    const g = new Float64Array(d), H = new Float64Array(d * d), z = new Float64Array(n);
    let f = this.objective(X, y, ww, beta);
    this.nIter = 0;
    for (let it = 0; it < this.maxIter; it++) {
      this.nIter = it + 1;
      g.fill(0); H.fill(0);
      for (let i = 0; i < n; i++) {
        let zi = beta[p];
        const o = i * p;
        for (let j = 0; j < p; j++) zi += X.data[o + j] * beta[j];
        z[i] = zi;
        const pi = 1 / (1 + Math.exp(-zi)), wi = ww ? ww[i] : 1;
        const r = wi * (pi - y[i]), h = wi * pi * (1 - pi);
        for (let j = 0; j < p; j++) {
          const xj = X.data[o + j];
          g[j] += r * xj;
          const hx = h * xj, row = j * d;
          for (let k = j; k < p; k++) H[row + k] += hx * X.data[o + k];
          H[row + p] += hx;
        }
        g[p] += r;
        H[p * d + p] += h;
      }
      for (let j = 0; j < p; j++) { g[j] += lam * beta[j]; H[j * d + j] += lam; }
      for (let j = 0; j < d; j++) for (let k = 0; k < j; k++) H[j * d + k] = H[k * d + j];
      let gmax = 0;
      for (let j = 0; j < d; j++) gmax = Math.max(gmax, Math.abs(g[j]));
      const step = choleskySolve(H, g, d);
      // backtracking line search on the objective (pure Newton is fine near the optimum)
      let t = 1, next = new Float64Array(d), fn = f;
      for (let ls = 0; ls < 30; ls++) {
        for (let j = 0; j < d; j++) next[j] = beta[j] - t * step[j];
        fn = this.objective(X, y, ww, next);
        if (fn <= f + 1e-12 * Math.abs(f)) break;
        t *= 0.5;
      }
      let smax = 0;
      for (let j = 0; j < d; j++) smax = Math.max(smax, Math.abs(t * step[j]));
      beta = next; f = fn;
      if (smax < this.tol || gmax < 1e-14) break;
    }
    this.coef = beta.slice(0, p);
    this.intercept = beta[p];
    return this;
  }

  decision(X: Mat): Float64Array {
    const out = new Float64Array(X.n);
    for (let i = 0; i < X.n; i++) {
      let z = this.intercept;
      const o = i * X.p;
      for (let j = 0; j < X.p; j++) z += X.data[o + j] * this.coef[j];
      out[i] = z;
    }
    return out;
  }
  predictProba(X: Mat): Float64Array {
    const z = this.decision(X);
    for (let i = 0; i < z.length; i++) z[i] = sigmoid(z[i]);
    return z;
  }
}

/** Solve H x = g for symmetric positive-definite H (d x d, row-major); a tiny ridge is added if needed. */
function choleskySolve(H: Float64Array, g: Float64Array, d: number): Float64Array {
  for (let jitter = 0; jitter < 8; jitter++) {
    const L = new Float64Array(d * d);
    let ok = true;
    const ridge = jitter ? 1e-12 * Math.pow(100, jitter) : 0;
    for (let i = 0; i < d && ok; i++) {
      for (let j = 0; j <= i; j++) {
        let s = H[i * d + j] + (i === j ? ridge : 0);
        for (let k = 0; k < j; k++) s -= L[i * d + k] * L[j * d + k];
        if (i === j) {
          if (!(s > 0)) { ok = false; break; }
          L[i * d + i] = Math.sqrt(s);
        } else L[i * d + j] = s / L[j * d + j];
      }
    }
    if (!ok) continue;
    const yv = new Float64Array(d), x = new Float64Array(d);
    for (let i = 0; i < d; i++) { let s = g[i]; for (let k = 0; k < i; k++) s -= L[i * d + k] * yv[k]; yv[i] = s / L[i * d + i]; }
    for (let i = d - 1; i >= 0; i--) { let s = yv[i]; for (let k = i + 1; k < d; k++) s -= L[k * d + i] * x[k]; x[i] = s / L[i * d + i]; }
    return x;
  }
  return new Float64Array(d);
}

/** Platt (1999) scaling: P(y=1) = sigmoid(a * x + b), fitted as an (almost) unregularised logistic
 *  regression, LogisticRegression(C=1e6) on one feature exactly as learner.py does. */
export function plattFit(x: Vec, y: Vec, w?: Vec | null, C = 1e6): [number, number] {
  const X = mat(x.length, 1);
  for (let i = 0; i < x.length; i++) X.data[i] = x[i];
  const lr = new LogisticRegression(C).fit(X, y, w);
  return [lr.coef[0], lr.intercept];
}

// ------------------------------------------------------------------ pipelines / wrappers
/** make_pipeline(transformers..., final) with sample_weight routed to the final step only. */
export class Pipeline implements Classifier {
  constructor(public steps: Transformer[], public final: Classifier) {}
  fit(X: Mat, y: Vec, w?: Vec | null): this {
    let Z = X;
    for (const s of this.steps) Z = s.fit(Z).transform(Z);
    this.final.fit(Z, y, w);
    return this;
  }
  transform(X: Mat): Mat {
    let Z = X;
    for (const s of this.steps) Z = s.transform(Z);
    return Z;
  }
  predictProba(X: Mat): Float64Array { return this.final.predictProba(this.transform(X)); }
}
/** learner._ColumnSubset */
export class ColumnSubset implements Classifier {
  constructor(public cols: number[], public model: Classifier) {}
  fit(X: Mat, y: Vec, w?: Vec | null): this { this.model.fit(selectCols(X, this.cols), y, w); return this; }
  predictProba(X: Mat): Float64Array { return this.model.predictProba(selectCols(X, this.cols)); }
}
/** learner._DropConstant: drop all-NaN / constant columns; sample weights deliberately NOT forwarded. */
export class DropConstant implements Classifier {
  cols: number[] = [];
  constructor(public model: Classifier) {}
  fit(X: Mat, y: Vec): this {
    this.cols = [];
    for (let j = 0; j < X.p; j++) {
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < X.n; i++) { const x = X.data[i * X.p + j]; if (Number.isFinite(x)) { if (x < lo) lo = x; if (x > hi) hi = x; } }
      if (hi > lo) this.cols.push(j);
    }
    this.model.fit(selectCols(X, this.cols), y);
    return this;
  }
  predictProba(X: Mat): Float64Array { return this.model.predictProba(selectCols(X, this.cols)); }
}

// ------------------------------------------------------------------ binning (shared by the tree models)
const ALMOST_INF = 1e300;
export const MISSING_BIN = 255;

/** numpy.percentile(sorted, q, method="averaged_inverted_cdf") for q in percent. */
function percentileAIC(sorted: Float64Array, qPct: number): number {
  const n = sorted.length, q = qPct / 100;
  const v = n * q - 1;
  let prev = Math.floor(v), next = prev + 1;
  if (v >= n - 1) { prev = n - 1; next = n - 1; } else if (v < 0) { prev = 0; next = 0; }
  // numpy: gamma = 0.5 exactly on an order statistic (average the two), otherwise 1 (take the upper one)
  const gamma = v - prev === 0 ? 0.5 : 1;
  const a = sorted[prev], b = sorted[next], diff = b - a;
  return b - diff * (1 - gamma);
}

/** sklearn _find_binning_thresholds(col, max_bins=255). */
export function binThresholds(col: ArrayLike<number>, maxBins = 255): Float64Array {
  const vals: number[] = [];
  for (let i = 0; i < col.length; i++) if (col[i] === col[i]) vals.push(col[i]);
  const sorted = Float64Array.from(vals).sort();
  const distinct: number[] = [];
  for (let i = 0; i < sorted.length; i++) if (i === 0 || sorted[i] !== sorted[i - 1]) distinct.push(sorted[i]);
  if (distinct.length <= 1) return new Float64Array(0);
  let thr: number[];
  if (distinct.length <= maxBins) {
    thr = [];
    for (let i = 0; i + 1 < distinct.length; i++) thr.push((distinct[i] + distinct[i + 1]) / 2);
  } else {
    thr = [];
    const step = 100 / maxBins;
    for (let k = 1; k < maxBins; k++) thr.push(percentileAIC(sorted, k * step));
    const u: number[] = [];
    const s = thr.slice().sort((a, b) => a - b);
    for (let i = 0; i < s.length; i++) if (i === 0 || s[i] !== s[i - 1]) u.push(s[i]);
    thr = u;
  }
  return Float64Array.from(thr, (x) => Math.min(x, ALMOST_INF));
}
/** Bin index: first i with x <= thr[i] (else thr.length); NaN -> MISSING_BIN. */
export function binOf(thr: Float64Array, x: number): number {
  if (x !== x) return MISSING_BIN;
  let lo = 0, hi = thr.length;
  while (lo < hi) { const mid = lo + ((hi - lo - 1) >> 1); if (x <= thr[mid]) hi = mid; else lo = mid + 1; }
  return lo;
}
interface Binned { bins: Uint8Array; thr: Float64Array[]; nBins: Int32Array; hasMissing: Uint8Array; n: number; p: number }
/** Column-major binned copy of X (bins[j * n + i]). */
function binMatrix(X: Mat): Binned {
  const { n, p } = X, bins = new Uint8Array(n * p), thr: Float64Array[] = [], nBins = new Int32Array(p), hasMissing = new Uint8Array(p);
  const col = new Float64Array(n);
  for (let j = 0; j < p; j++) {
    for (let i = 0; i < n; i++) col[i] = X.data[i * p + j];
    const t = binThresholds(col);
    thr.push(t);
    nBins[j] = t.length + 1;
    for (let i = 0; i < n; i++) { const b = binOf(t, col[i]); bins[j * n + i] = b; if (b === MISSING_BIN) hasMissing[j] = 1; }
  }
  return { bins, thr, nBins, hasMissing, n, p };
}

// ------------------------------------------------------------------ random forest
interface Tree { feat: Int32Array; thr: Float64Array; left: Int32Array; right: Int32Array; value: Float64Array }

/**
 * RandomForestClassifier(n_estimators, min_samples_leaf, max_features="sqrt", bootstrap=True, gini).
 * Inputs must be NaN-free (learner.py imputes first).
 */
export class RandomForestClassifier implements Classifier {
  trees: Tree[] = [];
  featureImportances: Float64Array = new Float64Array(0);
  constructor(public nEstimators = 100, public minSamplesLeaf = 1, public seed = 42) {}

  fit(X: Mat, y: Vec, w?: Vec | null): this {
    const { n, p } = X, B = binMatrix(X), bins = B.bins, rng = new Rng(this.seed);
    const mtry = Math.max(1, Math.floor(Math.sqrt(p))), msl = this.minSamplesLeaf;
    const yy = new Uint8Array(n);
    for (let i = 0; i < n; i++) yy[i] = y[i] > 0.5 ? 1 : 0;
    const counts = new Int32Array(n), sw = new Float64Array(n), idx = new Int32Array(n), tmp = new Int32Array(n);
    const h0 = new Float64Array(256), h1 = new Float64Array(256), hc = new Int32Array(256);
    const feats = new Int32Array(p);
    const imp = new Float64Array(p);
    let usedTrees = 0;
    this.trees = [];
    for (let t = 0; t < this.nEstimators; t++) {
      counts.fill(0);
      for (let k = 0; k < n; k++) counts[rng.int(n)]++;
      let m = 0;
      for (let i = 0; i < n; i++) if (counts[i] > 0) { sw[i] = (w ? w[i] : 1) * counts[i]; idx[m++] = i; }
      const feat: number[] = [], thr: number[] = [], left: number[] = [], right: number[] = [], value: number[] = [];
      const timp = new Float64Array(p);
      let rootW = 0;
      // explicit stack of [start, end, nodeId]
      const stack: number[] = [];
      const newNode = () => { feat.push(-1); thr.push(0); left.push(-1); right.push(-1); value.push(0); return feat.length - 1; };
      stack.push(0, m, newNode());
      while (stack.length) {
        const node = stack.pop()!, end = stack.pop()!, start = stack.pop()!;
        let W0 = 0, W1 = 0;
        for (let k = start; k < end; k++) { const i = idx[k]; if (yy[i]) W1 += sw[i]; else W0 += sw[i]; }
        const W = W0 + W1, cnt = end - start;
        if (node === 0) rootW = W;
        value[node] = W1 / W;
        const gini = 1 - (W0 / W) ** 2 - (W1 / W) ** 2;
        if (cnt < 2 || cnt < 2 * msl || gini <= 1e-7) continue;
        // sample features without replacement until mtry visited and at least one non-constant one found
        for (let j = 0; j < p; j++) feats[j] = j;
        let remaining = p, visited = 0, nonConst = 0;
        let bestProxy = -Infinity, bestF = -1, bestB = -1;
        while (remaining > 0 && (visited < mtry || nonConst === 0)) {
          const r = rng.int(remaining), f = feats[r];
          feats[r] = feats[remaining - 1]; feats[remaining - 1] = f; remaining--;
          visited++;
          const base = f * n;
          // h0 / h1 / hc are all-zero between uses: one pass accumulates, the used range is cleared afterwards
          let lo = 255, hi = 0;
          for (let k = start; k < end; k++) {
            const i = idx[k], b = bins[base + i];
            if (b < lo) lo = b;
            if (b > hi) hi = b;
            hc[b]++;
            if (yy[i]) h1[b] += sw[i]; else h0[b] += sw[i];
          }
          if (lo >= hi) { h0[lo] = 0; h1[lo] = 0; hc[lo] = 0; continue; }     // constant in this node
          nonConst++;
          let l0 = 0, l1 = 0, lc = 0;
          for (let b = lo; b < hi; b++) {
            l0 += h0[b]; l1 += h1[b]; lc += hc[b];
            if (hc[b] === 0) continue;
            if (lc < msl) continue;
            if (cnt - lc < msl) break;
            const r0 = W0 - l0, r1 = W1 - l1, wl = l0 + l1, wr = r0 + r1;
            if (wl <= 0 || wr <= 0) continue;
            const proxy = (l0 * l0 + l1 * l1) / wl + (r0 * r0 + r1 * r1) / wr;
            if (proxy > bestProxy) { bestProxy = proxy; bestF = f; bestB = b; }
          }
          for (let q = lo; q <= hi; q++) { h0[q] = 0; h1[q] = 0; hc[q] = 0; }
        }
        if (bestF < 0) continue;
        // partition idx[start:end] by bin <= bestB (stable)
        const base = bestF * n;
        let a = start, c = 0;
        for (let k = start; k < end; k++) { const i = idx[k]; if (B.bins[base + i] <= bestB) idx[a++] = i; else tmp[c++] = i; }
        for (let k = 0; k < c; k++) idx[a + k] = tmp[k];
        let L0 = 0, L1 = 0;
        for (let k = start; k < a; k++) { const i = idx[k]; if (yy[i]) L1 += sw[i]; else L0 += sw[i]; }
        const R0 = W0 - L0, R1 = W1 - L1, WL = L0 + L1, WR = R0 + R1;
        const gl = 1 - (L0 / WL) ** 2 - (L1 / WL) ** 2, gr = 1 - (R0 / WR) ** 2 - (R1 / WR) ** 2;
        timp[bestF] += W * gini - WL * gl - WR * gr;
        feat[node] = bestF;
        thr[node] = B.thr[bestF][bestB];
        const ln = newNode(), rn = newNode();
        left[node] = ln; right[node] = rn;
        stack.push(a, end, rn, start, a, ln);
      }
      this.trees.push({ feat: Int32Array.from(feat), thr: Float64Array.from(thr), left: Int32Array.from(left), right: Int32Array.from(right), value: Float64Array.from(value) });
      if (feat.length > 1) {
        let s = 0;
        for (let j = 0; j < p; j++) { timp[j] /= rootW; s += timp[j]; }
        if (s > 0) for (let j = 0; j < p; j++) imp[j] += timp[j] / s;
        usedTrees++;
      }
    }
    let s = 0;
    for (let j = 0; j < p; j++) s += imp[j];
    this.featureImportances = new Float64Array(p);
    if (usedTrees && s > 0) for (let j = 0; j < p; j++) this.featureImportances[j] = imp[j] / s;
    return this;
  }

  predictProba(X: Mat): Float64Array {
    const out = new Float64Array(X.n);
    for (let i = 0; i < X.n; i++) {
      const o = i * X.p;
      let s = 0;
      for (const t of this.trees) {
        let k = 0;
        while (t.feat[k] >= 0) k = X.data[o + t.feat[k]] <= t.thr[k] ? t.left[k] : t.right[k];
        s += t.value[k];
      }
      out[i] = s / this.trees.length;
    }
    return out;
  }
}

// ------------------------------------------------------------------ histogram gradient boosting
interface HNode { feat: number; thr: number; missLeft: boolean; left: number; right: number; value: number }
interface Split { gain: number; feat: number; bin: number; missLeft: boolean; gL: number; hL: number; gR: number; hR: number; nL: number; nR: number; vL: number; vR: number }

/**
 * HistGradientBoostingClassifier(max_iter, learning_rate, max_depth, min_samples_leaf, l2_regularization),
 * binary log-loss, max_leaf_nodes=31, max_bins=255, no early stopping (sklearn's "auto" only enables it
 * above 10 000 rows; learner.py never has that many), no sample weights (learner.py does not pass them).
 */
export class HistGradientBoostingClassifier implements Classifier {
  baseline = 0;
  trees: HNode[][] = [];
  constructor(public maxIter = 100, public learningRate = 0.1, public maxDepth: number | null = null, public minSamplesLeaf = 20,
              public l2 = 0, public maxLeafNodes = 31) {}

  fit(X: Mat, y: Vec): this {
    const { n, p } = X, B = binMatrix(X), l2 = this.l2, msl = this.minSamplesLeaf, MIN_HESS = 1e-3;
    const nb = B.nBins, hm = B.hasMissing, bins = B.bins;
    let ybar = 0;
    for (let i = 0; i < n; i++) ybar += y[i];
    let pr = ybar / n;
    pr = Math.min(1 - EPS, Math.max(EPS, pr));
    this.baseline = Math.log(pr / (1 - pr));
    const raw = new Float64Array(n).fill(this.baseline);
    const grad = new Float32Array(n), hess = new Float32Array(n);
    // compact histogram layout: feature f owns slots off[f] .. off[f] + nb[f], the last one being its missing-value
    // bin (sklearn keeps 256 slots per feature; only the used ones matter and the sums are identical)
    const off = new Int32Array(p + 1);
    for (let f = 0; f < p; f++) off[f + 1] = off[f] + nb[f] + 1;
    const HS = off[p];
    const cb = new Uint8Array(n * p);                  // bins with MISSING_BIN remapped to the feature's slot nb[f]
    for (let f = 0; f < p; f++) for (let i = 0; i < n; i++) { const b = bins[f * n + i]; cb[f * n + i] = b === MISSING_BIN ? nb[f] : b; }
    const slot = new Int32Array(n * p);                 // row-major histogram offset of every (row, feature)
    for (let i = 0; i < n; i++) for (let f = 0; f < p; f++) slot[i * p + f] = (off[f] + cb[f * n + i]) * 3;
    const idx = new Int32Array(n), tmp = new Int32Array(n);
    this.trees = [];
    type GNode = { start: number; end: number; depth: number; g: number; h: number; value: number; hist: Float64Array | null; split: Split | null; id: number };

    // one interleaved histogram per node: [(feature * 256 + bin) * 3 + {0: sum_gradients, 1: sum_hessians, 2: count}]
    type Hist = Float64Array;
    const pool: Hist[] = [];
    const release = (h: Hist | null) => { if (h) pool.push(h); };
    const buildHist = (start: number, end: number): Hist => {
      const hh = pool.pop(), A = hh ? hh.fill(0) : new Float64Array(HS * 3);
      // row-major over the node's samples; every bin still receives its samples in node order (same sums as sklearn)
      for (let k = start; k < end; k++) {
        const i = idx[k], g = grad[i], h = hess[i], r = i * p;
        for (let j = 0; j < p; j++) { const q = slot[r + j]; A[q] += g; A[q + 1] += h; A[q + 2]++; }
      }
      return A;
    };
    const nodeValue = (g: number, h: number) => -g / (h + l2 + 1e-15);

    const findSplit = (nd: GNode): Split | null => {
      const A = nd.hist!;
      const nS = nd.end - nd.start, sg = nd.g, sh = nd.h, lossCur = sg * nd.value;
      let best: Split | null = null, bestGain = -1;
      for (let f = 0; f < p; f++) {
        const hb = off[f], miss = hm[f];
        let fGain = -1, fBin = -1, fMissLeft = false, fgl = 0, fhl = 0, fnl = 0;
        // left to right, missing values go right
        let gl = 0, hl = 0, nl = 0;
        const end = nb[f] - 1 + miss;
        for (let b = 0; b < end; b++) {
          const q = (hb + b) * 3, cg = A[q], ch = A[q + 1], cc = A[q + 2];
          // an empty bin (all three sums exactly 0) leaves every quantity - and so the gain - unchanged: skipping it is exact
          if (cc === 0 && cg === 0 && ch === 0) continue;
          gl += cg; hl += ch; nl += cc;
          const nr = nS - nl, hr = sh - hl, gr = sg - gl;
          if (nl < msl) continue;
          if (nr < msl) break;
          if (hl < MIN_HESS) continue;
          if (hr < MIN_HESS) break;
          const vl = nodeValue(gl, hl), vr = nodeValue(gr, hr);
          const gain = lossCur - gl * vl - gr * vr;
          if (gain > fGain && gain > 0) { fGain = gain; fBin = b; fMissLeft = false; fgl = gl; fhl = hl; fnl = nl; }
        }
        if (miss) {
          // right to left, missing values go left
          let gr = 0, hr = 0, nr = 0;
          for (let b = nb[f] - 2; b >= 0; b--) {
            const q = (hb + b + 1) * 3, cg = A[q], ch = A[q + 1], cc = A[q + 2];
            if (cc === 0 && cg === 0 && ch === 0) continue;
            gr += cg; hr += ch; nr += cc;
            const nl2 = nS - nr, hl2 = sh - hr, gl2 = sg - gr;
            if (nr < msl) continue;
            if (nl2 < msl) break;
            if (hr < MIN_HESS) continue;
            if (hl2 < MIN_HESS) break;
            const vl = nodeValue(gl2, hl2), vr = nodeValue(gr, hr);
            const gain = lossCur - gl2 * vl - gr * vr;
            if (gain > fGain && gain > 0) { fGain = gain; fBin = b; fMissLeft = true; fgl = gl2; fhl = hl2; fnl = nl2; }
          }
        }
        if (fGain > bestGain) {
          bestGain = fGain;
          best = { gain: fGain, feat: f, bin: fBin, missLeft: fMissLeft, gL: fgl, hL: fhl, gR: sg - fgl, hR: sh - fhl, nL: fnl, nR: nS - fnl,
                   vL: nodeValue(fgl, fhl), vR: nodeValue(sg - fgl, sh - fhl) };
        }
      }
      return best && best.gain > 0 ? best : null;
    };

    for (let it = 0; it < this.maxIter; it++) {
      for (let i = 0; i < n; i++) {
        const r = raw[i], yi = y[i];
        if (r > -37) {
          const e = Math.exp(-r);
          grad[i] = ((1 - yi) - yi * e) / (1 + e);
          hess[i] = e / ((1 + e) * (1 + e));
        } else {
          const e = Math.exp(r);
          grad[i] = e - yi;
          hess[i] = e;
        }
      }
      for (let i = 0; i < n; i++) idx[i] = i;
      const nodes: HNode[] = [];
      const add = (): number => { nodes.push({ feat: -1, thr: 0, missLeft: false, left: -1, right: -1, value: 0 }); return nodes.length - 1; };
      const rootHist = buildHist(0, n);
      let g0 = 0, h0 = 0;
      for (let b = off[0]; b < off[1]; b++) { g0 += rootHist[b * 3]; h0 += rootHist[b * 3 + 1]; }
      const root: GNode = { start: 0, end: n, depth: 0, g: g0, h: h0, value: 0, hist: rootHist, split: null, id: add() };
      const leaves: GNode[] = [];
      const todo: GNode[] = [];
      if (n < 2 * msl || h0 < MIN_HESS) { leaves.push(root); release(root.hist); root.hist = null; }
      else { root.split = findSplit(root); if (root.split) todo.push(root); else { leaves.push(root); release(root.hist); root.hist = null; } }
      // max_depth bounds the tree well below max_leaf_nodes for learner.py's settings, so the split order
      // (sklearn pops the highest gain first) does not change the result; process in gain order anyway.
      let nLeaves = 1;
      while (todo.length) {
        let bi = 0;
        for (let k = 1; k < todo.length; k++) if (todo[k].split!.gain > todo[bi].split!.gain) bi = k;
        const nd = todo.splice(bi, 1)[0], s = nd.split!;
        const base = s.feat * n;
        let a = nd.start, c = 0;
        for (let k = nd.start; k < nd.end; k++) {
          const i = idx[k], b = cb[base + i];
          if ((s.missLeft && b === nb[s.feat]) || b <= s.bin) idx[a++] = i; else tmp[c++] = i;
        }
        for (let k = 0; k < c; k++) idx[a + k] = tmp[k];
        const depth = nd.depth + 1;
        const L: GNode = { start: nd.start, end: a, depth, g: s.gL, h: s.hL, value: s.vL, hist: null, split: null, id: add() };
        const R: GNode = { start: a, end: nd.end, depth, g: s.gR, h: s.hR, value: s.vR, hist: null, split: null, id: add() };
        nLeaves++;
        const hn = nodes[nd.id];
        hn.feat = s.feat;
        hn.missLeft = hm[s.feat] ? s.missLeft : s.nL > s.nR;
        hn.thr = s.bin === nb[s.feat] - 1 ? Infinity : B.thr[s.feat][s.bin];
        hn.left = L.id; hn.right = R.id;
        let leafL = false, leafR = false;
        if (this.maxLeafNodes && nLeaves >= this.maxLeafNodes) { leafL = leafR = true; for (const t of todo) { leaves.push(t); release(t.hist); t.hist = null; } todo.length = 0; }
        else if (this.maxDepth != null && depth === this.maxDepth) leafL = leafR = true;
        else { leafL = L.end - L.start < 2 * msl; leafR = R.end - R.start < 2 * msl; }
        if (!leafL || !leafR) {
          const nLs = L.end - L.start, nRs = R.end - R.start;
          const [small, large] = nLs < nRs ? [L, R] : [R, L];
          small.hist = buildHist(small.start, small.end);
          const ph = nd.hist!, sh = small.hist;
          for (let q = 0; q < HS * 3; q++) ph[q] -= sh[q];
          large.hist = ph;              // histogram subtraction, reusing the parent's buffers like sklearn
        } else release(nd.hist);
        nd.hist = null;
        for (const [child, isLeaf] of [[L, leafL], [R, leafR]] as [GNode, boolean][]) {
          if (!isLeaf) child.split = findSplit(child);
          if (child.split) todo.push(child);
          else { leaves.push(child); release(child.hist); child.hist = null; }
        }
      }
      for (const lf of leaves) {
        const v = lf.value * this.learningRate;
        nodes[lf.id].value = v;
        for (let k = lf.start; k < lf.end; k++) raw[idx[k]] += v;
      }
      this.trees.push(nodes);
    }
    return this;
  }

  rawPredict(X: Mat): Float64Array {
    const out = new Float64Array(X.n).fill(this.baseline);
    for (const t of this.trees) {
      for (let i = 0; i < X.n; i++) {
        const o = i * X.p;
        let k = 0;
        while (t[k].feat >= 0) {
          const nd = t[k], x = X.data[o + nd.feat];
          k = x !== x ? (nd.missLeft ? nd.left : nd.right) : x <= nd.thr ? nd.left : nd.right;
        }
        out[i] += t[k].value;
      }
    }
    return out;
  }
  predictProba(X: Mat): Float64Array {
    const r = this.rawPredict(X);
    for (let i = 0; i < r.length; i++) r[i] = sigmoid(r[i]);
    return r;
  }
}
