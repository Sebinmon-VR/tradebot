/**
 * Walk-forward stacked learner - a port of app/learner.py.  It turns the strategies' votes and market
 * features into one calibrated probability and decides whether the system has enough edge to call a
 * direction at all.
 *
 * * Stacked generalisation (Wolpert 1992): every strategy's vote at every past bar is a feature.
 * * Purged walk-forward CV (Lopez de Prado 2018): five expanding folds over the most recent 60% of
 *   history, `horizon` bars purged between training and test.
 * * Platt (1999) scaling of the out-of-fold average, recency weighted.
 * * Base learners (see ml.ts): L2 logistic regression, Random Forest, histogram gradient boosting and a
 *   level-1 logistic regression over the votes.
 * * Market factor (Sharpe 1964): NIFTY 50 returns and the stock's return relative to the index.
 *
 * I/O is injected (configureLearner / the `deps` argument): the vote cache (backed by expo-sqlite in the app),
 * the NIFTY fetcher and the strategy table.  All timestamps are bar-start epoch seconds (UTC), as in types.ts;
 * learner.py works on the naive-UTC index, so time-of-day and weekday features are computed in UTC too.
 */
import type { Frame } from './indicators';
import { Signal, StrategyFn, StrategyInput, clip as clip01 } from './signal';
import type { Bars } from './types';
import { isIndian as isIndianSymbol } from './yahoo';
import { pctChange, rollingMean, rollingStd, rollingSum } from './series';
import {
  Classifier, Clipper, ColumnSubset, DropConstant, HistGradientBoostingClassifier, LogisticRegression, Mat, Pipeline,
  RandomForestClassifier, SimpleImputer, StandardScaler, kish, logit, logloss, mat, plattFit, recencyWeights, sigmoid, sliceRows, wavg,
} from './ml';

export const VOTE_WINDOW = 320;
export const MAX_ROWS = 1500;
export const MIN_ROWS = 200;
export const MIN_TRAIN = 120;
export const FOLDS = 5;
export const TEST_SHARE = 0.6;
export const THRESHOLDS = [0.52, 0.55, 0.58, 0.6, 0.65, 0.7];
export const MIN_TIER_ACC = 0.55;
export const MARKET_SYMBOL = '^NSEI';
export const FIT_MAX_AGE = 3600;
export const CLIP_SD = 4.0;
export const TRAIN_HALF_LIFE = 0.5;
export const CAL_HALF_LIFE = 0.2;
export const CAL_HALF_LIFE_MIN = 40;
export const TECH_COLS = ['rsi_14', 'rsi_2', 'stoch_k', 'williams_r', 'cci_20', 'mfi_14', 'adx', 'roc_10', 'roc_60',
  'bb_pct', 'bb_width', 'volatility_20', 'supertrend_dir', 'psar_dir', 'cmf_20'];

export type LearnerName = 'logistic_regression' | 'random_forest' | 'gradient_boosting' | 'stacked_votes';
export const LEARNER_NAMES: LearnerName[] = ['logistic_regression', 'random_forest', 'gradient_boosting', 'stacked_votes'];

export const LEARNER_META: Record<LearnerName | 'wf_ensemble', { name: string; origin: string; rules: string }> = {
  logistic_regression: { name: 'Logistic Regression (walk-forward)', origin: 'L2-regularised logistic regression on standardised features; purged walk-forward CV (Lopez de Prado 2018)',
    rules: 'Linear model of P(up in `horizon` bars) from ~70 technical, market-factor, time and strategy-vote features. Validated out-of-sample on the most recent 60% of history in 5 expanding folds.' },
  random_forest: { name: 'Random Forest (walk-forward)', origin: 'Breiman (2001); 200 trees, purged walk-forward CV',
    rules: 'Bagged decision trees on the same feature set. Reports the walk-forward accuracy so you can see whether it has any edge on this chart.' },
  gradient_boosting: { name: 'Gradient Boosting (walk-forward)', origin: 'Friedman (2001); histogram-based implementation (Ke et al. 2017), purged walk-forward CV',
    rules: 'Boosted shallow trees on the same feature set; captures non-linear interactions between indicators and market context.' },
  stacked_votes: { name: 'Stacked Strategy Votes (Wolpert)', origin: "Stacked generalisation (Wolpert 1992): level-1 logistic regression over every strategy's vote",
    rules: 'Learns a weight for every strategy from its historical votes on this instrument and timeframe - a negative weight means the strategy has been contrarian here.' },
  wf_ensemble: { name: 'Calibrated Ensemble', origin: 'Average of the four walk-forward learners, Platt-scaled (Platt 1999) on out-of-fold predictions',
    rules: 'The final probability. A direction is called only where out-of-sample calls of the same strength were right at least 55% of the time; otherwise the system stands aside (no call).' },
};

// ------------------------------------------------------------------ injected I/O
/** Strategy votes at past bars: `cols[k][row]` is the vote (direction x confidence) of strategy `keys[k]`
 *  at bar `t[row]`; `close` is that bar's close (used to detect revised history).  Rows are sorted by t. */
export interface VoteTable { t: number[]; close: number[]; keys: string[]; cols: number[][] }
/** Persistent vote cache (votes are pure functions of closed bars, so they survive restarts). */
export interface VoteCache {
  load(symbol: string, interval: string): Promise<VoteTable | null>;
  save(symbol: string, interval: string, table: VoteTable): Promise<void>;
}
export interface LearnerDeps {
  /** The strategy table (strategies.ts STRATEGIES).  Key order = vote-feature order. */
  strategies: Record<string, StrategyFn>;
  /** Optional fast path (strategies.ts votesAt): votes of every strategy on rows [start, end) of the full frame,
   *  without slicing.  Same semantics as calling each strategy on the sliced window. */
  votesAt?: ((x: StrategyInput, intervalSeconds: number, start: number, end: number) => Record<string, number>) | null;
  cache?: VoteCache | null;
  /** NIFTY 50 bars for the interval (e.g. `(iv) => fetchBars('^NSEI', iv).then(r => r.bars)`); null = no market factor. */
  fetchMarket?: ((interval: string) => Promise<Bars>) | null;
  isIndian?: (symbol: string) => boolean;
  /** Wall clock in seconds (for the fit cache age). */
  now?: () => number;
  /** Called while votes are computed / folds are fitted. */
  onProgress?: (stage: string, done: number, total: number) => void;
}
let DEPS: LearnerDeps = { strategies: {} };
/** Set the default dependencies once at app start-up. */
export function configureLearner(d: Partial<LearnerDeps>): void { DEPS = { ...DEPS, ...d }; }
const deps = (d?: Partial<LearnerDeps>): LearnerDeps => (d ? { ...DEPS, ...d } : DEPS);
const nowS = (d: LearnerDeps) => (d.now ? d.now() : Date.now() / 1000);
/** Let the UI breathe between heavy steps (Hermes is single-threaded). */
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** The data the learner sees: the bars and computeAll(bars) over the same rows (all bars closed). */
export interface LearnerData { bars: Bars; f: Frame }

// ------------------------------------------------------------------ caches
const VOTES = new Map<string, VoteTable>();
const FITS = new Map<string, Fit>();
const FIT_LOCKS = new Map<string, Promise<unknown>>();

/** Forget cached votes / fits (tests, or after the strategy set changed). */
export function clearLearnerCaches(): void { VOTES.clear(); FITS.clear(); }

// ------------------------------------------------------------------ strategy votes at every bar
/** A frame whose columns are the rows [a, b) of `f`, sliced lazily on first access (strategies read a few). */
function frameViewFactory(f: Frame) {
  const proto: Record<string, unknown> = {};
  for (const key of Object.keys(f)) {
    Object.defineProperty(proto, key, {
      enumerable: true,
      get(this: { _a: number; _b: number; _c: Record<string, number[]> }) {
        const c = this._c[key];
        return c !== undefined ? c : (this._c[key] = f[key].slice(this._a, this._b));
      },
    });
  }
  return (a: number, b: number): Frame => {
    const o = Object.create(proto);
    Object.defineProperty(o, '_a', { value: a });
    Object.defineProperty(o, '_b', { value: b });
    Object.defineProperty(o, '_c', { value: {} });
    return o as Frame;
  };
}

function votesForBar(strategies: Record<string, StrategyFn>, keys: string[], bars: Bars, f: Frame, sec: number): number[] {
  const row = new Array<number>(keys.length);
  const x = { bars, f };
  for (let k = 0; k < keys.length; k++) {
    try {
      const s = strategies[keys[k]](x, sec);
      row[k] = Number(s.direction) * Math.min(1, Math.max(0, Number(s.confidence)));
    } catch {
      row[k] = 0;
    }
  }
  return row;
}

/** Adjacent bars carry almost the same `horizon`-bar label, so long horizons are sampled every 2-3 bars. */
export const trainingStride = (horizon: number) => Math.max(1, Math.min(3, Math.floor(horizon / 8)));

/** Positions of every `stride`-th bar among the last `maxRows * stride`, always ending on the last bar. */
export function voteIndex(n: number, maxRows: number, stride: number): number[] {
  const lo = Math.max(0, n - maxRows * stride), out: number[] = [];
  for (let p = n - 1; p >= lo; p -= stride) out.push(p);
  return out.reverse();
}

const isClose = (a: number, b: number) => Math.abs(a - b) <= 1e-8 + 1e-6 * Math.abs(b);

/**
 * Signed vote of every strategy at up to `maxRows` closed bars of `data`, sampled every `stride` bars and
 * always including the last bar.  Rows are cached per (symbol, interval); cached rows from a revised bar
 * onward are recomputed.  Returns the rows for exactly those bars, in time order.
 */
export async function strategyVotes(symbol: string, interval: string, data: LearnerData, sec: number, maxRows = MAX_ROWS, stride = 1,
                                    d?: Partial<LearnerDeps>): Promise<VoteTable> {
  const dp = deps(d), key = `${symbol}|${interval}`;
  const t = data.bars.t, close = data.bars.c, n = t.length;
  const idx = voteIndex(n, maxRows, stride);
  const skeys = Object.keys(dp.strategies);
  let cached: VoteTable | null = VOTES.get(key) ?? null;
  if (!cached && dp.cache) {
    try {
      const c = await dp.cache.load(symbol, interval);
      if (c && c.t.length && skeys.every((k) => c.keys.includes(k))) {
        // JSON round-trips turn NaN into null: restore it
        cached = { t: c.t, close: c.close.map((x) => (x == null ? NaN : x)), keys: c.keys, cols: c.cols.map((col) => col.map((x) => (x == null ? NaN : x))) };
        VOTES.set(key, cached);
      }
    } catch { /* a broken cache is just a miss */ }
  }
  const posOf = new Map<number, number>();
  for (let p = 0; p < n; p++) posOf.set(t[p], p);
  if (cached) {
    // if Yahoo revised a bar, drop cached votes from that bar onward (earlier ones are still exact)
    let firstBad = -1;
    for (let r = 0; r < cached.t.length; r++) {
      const p = posOf.get(cached.t[r]);
      if (p !== undefined && !isClose(cached.close[r], close[p])) { firstBad = cached.t[r]; break; }
    }
    if (firstBad >= 0) {
      const keep = cached.t.findIndex((x) => x >= firstBad);
      cached = keep <= 0 ? null : { t: cached.t.slice(0, keep), close: cached.close.slice(0, keep), keys: cached.keys, cols: cached.cols.map((c) => c.slice(0, keep)) };
    }
  }
  const have = new Set(cached ? cached.t : []);
  const missing = idx.filter((p) => !have.has(t[p]));
  if (missing.length) {
    const view = dp.votesAt ? null : frameViewFactory(data.f);
    const rows: { t: number; close: number; v: number[] }[] = [];
    for (let m = 0; m < missing.length; m++) {
      const p = missing[m], a = Math.max(0, p - VOTE_WINDOW + 1), b = p + 1;
      let v: number[];
      if (dp.votesAt) {
        let r: Record<string, number> = {};
        try { r = dp.votesAt(data, sec, a, b); } catch { /* all zero */ }
        v = skeys.map((k) => r[k] ?? 0);
      } else {
        const bars: Bars = { t: t.slice(a, b), o: data.bars.o.slice(a, b), h: data.bars.h.slice(a, b), l: data.bars.l.slice(a, b), c: close.slice(a, b), v: data.bars.v.slice(a, b) };
        v = votesForBar(dp.strategies, skeys, bars, view!(a, b), sec);
      }
      rows.push({ t: t[p], close: close[p], v });
      if (m % 50 === 49) { dp.onProgress?.('votes', m + 1, missing.length); await tick(); }
    }
    cached = mergeVotes(cached, rows, skeys);
    VOTES.set(key, cached);
    if (dp.cache) { try { await dp.cache.save(symbol, interval, cached); } catch { /* ignore */ } }
  }
  const table = cached!;
  const rowOf = new Map<number, number>();
  table.t.forEach((x, r) => rowOf.set(x, r));
  const out: VoteTable = { t: [], close: [], keys: table.keys.slice(), cols: table.keys.map(() => []) };
  for (const p of idx) {
    const r = rowOf.get(t[p]);
    out.t.push(t[p]);
    out.close.push(r === undefined ? NaN : table.close[r]);
    for (let k = 0; k < table.keys.length; k++) out.cols[k].push(r === undefined ? NaN : table.cols[k][r]);
  }
  return out;
}

function mergeVotes(cached: VoteTable | null, rows: { t: number; close: number; v: number[] }[], skeys: string[]): VoteTable {
  const keys = cached ? cached.keys.slice() : skeys.slice();
  for (const k of skeys) if (!keys.includes(k)) keys.push(k);
  const kpos = skeys.map((k) => keys.indexOf(k));
  const all: { t: number; close: number; v: number[] }[] = [];
  if (cached) for (let r = 0; r < cached.t.length; r++) {
    const v = keys.map((_, k) => (k < cached.keys.length ? cached.cols[k][r] : NaN));
    all.push({ t: cached.t[r], close: cached.close[r], v });
  }
  for (const row of rows) {
    const v = new Array<number>(keys.length).fill(NaN);
    kpos.forEach((k, j) => (v[k] = row.v[j]));
    all.push({ t: row.t, close: row.close, v });
  }
  all.sort((a, b) => a.t - b.t);                           // stable: a new row follows a cached duplicate
  const dedup: typeof all = [];
  for (const r of all) { if (dedup.length && dedup[dedup.length - 1].t === r.t) dedup[dedup.length - 1] = r; else dedup.push(r); }
  const kept = dedup.length > MAX_ROWS * 2 ? dedup.slice(-MAX_ROWS * 2) : dedup;
  return { t: kept.map((r) => r.t), close: kept.map((r) => r.close), keys, cols: keys.map((_, k) => kept.map((r) => r.v[k])) };
}

// ------------------------------------------------------------------ features
export interface MarketFeatures { mkt_ret_1: number[]; mkt_ret_5: number[]; mkt_ret_20: number[]; mkt_vol_20: number[] }

/** NIFTY 50 returns computed on the index's own bars, aligned to `t` (last index bar at or before each). */
export function marketFeaturesFromBars(m: Bars, t: number[]): MarketFeatures {
  const c = m.c;
  const r1 = pctChange(c), r5 = pctChange(c, 5), r20 = pctChange(c, 20), vol = rollingStd(r1, 20);
  // drop duplicated timestamps (keep last), sort
  const order = m.t.map((_, i) => i).sort((a, b) => m.t[a] - m.t[b] || a - b);
  const ut: number[] = [], ui: number[] = [];
  for (const i of order) { if (ut.length && ut[ut.length - 1] === m.t[i]) ui[ui.length - 1] = i; else { ut.push(m.t[i]); ui.push(i); } }
  const out: MarketFeatures = { mkt_ret_1: [], mkt_ret_5: [], mkt_ret_20: [], mkt_vol_20: [] };
  let j = -1;
  const targets = t.map((x, i) => [x, i] as [number, number]);
  const res = new Array<number>(t.length);
  // targets are sorted in practice; binary search keeps it correct if not
  for (const [x, i] of targets) {
    let lo = 0, hi = ut.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (ut[mid] <= x) lo = mid + 1; else hi = mid; }
    j = lo - 1;
    res[i] = j;
  }
  for (let i = 0; i < t.length; i++) {
    const k = res[i] >= 0 ? ui[res[i]] : -1;
    out.mkt_ret_1.push(k >= 0 ? r1[k] : NaN);
    out.mkt_ret_5.push(k >= 0 ? r5[k] : NaN);
    out.mkt_ret_20.push(k >= 0 ? r20[k] : NaN);
    out.mkt_vol_20.push(k >= 0 ? vol[k] : NaN);
  }
  return out;
}

/** market_features(): null for non-Indian symbols, the index itself, or when the fetch fails. */
export async function marketFeatures(symbol: string, interval: string, t: number[], d?: Partial<LearnerDeps>): Promise<MarketFeatures | null> {
  const dp = deps(d);
  const indian = dp.isIndian ?? isIndianSymbol;
  if (!indian(symbol) || symbol === MARKET_SYMBOL || !dp.fetchMarket) return null;
  try {
    const m = await dp.fetchMarket(interval);
    return marketFeaturesFromBars(m, t);
  } catch {
    return null;
  }
}

export interface FeatureTable { t: number[]; names: string[]; cols: Float64Array[]; y: Float64Array }

/** Feature matrix (one row per bar in votes.t) and the label: did the close rise over the next `horizon` bars. */
export function buildFeatures(data: LearnerData, votes: VoteTable, market: MarketFeatures | null, horizon: number, sec: number): FeatureTable {
  const F = data.f, T = data.bars.t, N = T.length, n = votes.t.length;
  const posOf = new Map<number, number>();
  for (let p = 0; p < N; p++) posOf.set(T[p], p);
  const pos = votes.t.map((x) => { const p = posOf.get(x); if (p === undefined) throw new Error(`vote bar ${x} not in data`); return p; });
  const names: string[] = [], cols: Float64Array[] = [];
  const at = (s: ArrayLike<number>) => Float64Array.from(pos, (p) => s[p]);
  const put = (name: string, v: Float64Array) => { names.push(name); cols.push(v); };
  const full_c = F.close, c = at(full_c), o = at(F.open), h = at(F.high), l = at(F.low), v = at(F.volume);
  const col = (k: string) => at(F[k]);
  const each = (fn: (i: number) => number) => { const out = new Float64Array(n); for (let i = 0; i < n; i++) out[i] = fn(i); return out; };
  const dz = (x: number) => (x === 0 ? NaN : x);   // pandas .replace(0, np.nan)
  for (const k of TECH_COLS) if (F[k]) put(k, col(k));
  const mh = col('macd_hist'); put('macd_hist_n', each((i) => mh[i] / c[i]));
  const pdi = col('plus_di'), mdi = col('minus_di'); put('di_diff', each((i) => pdi[i] - mdi[i]));
  for (const k of [1, 2, 3, 5, 10, 20]) put(`ret_${k}`, at(pctChange(full_c, k)));
  put('ret_h', at(pctChange(full_c, horizon)));
  for (const [name, k] of [['dist_sma20', 'sma_20'], ['dist_sma50', 'sma_50'], ['dist_ema200', 'ema_200'], ['dist_hma20', 'hma_20']]) {
    const m = col(k); put(name, each((i) => c[i] / m[i] - 1));
  }
  const atr = col('atr_14'); put('atr_pct', each((i) => atr[i] / c[i]));
  const vs = col('vol_sma_20'); put('vol_ratio', each((i) => v[i] / dz(vs[i])));
  const vol = F.volume, vm = rollingMean(vol, 20), vsd = rollingStd(vol, 20);
  put('vol_z', each((i) => (vol[pos[i]] - vm[pos[i]]) / dz(vsd[pos[i]])));
  const obv = F.obv, vsum5 = rollingSum(vol, 5);
  put('obv_slope', each((i) => { const p = pos[i]; return (p >= 5 ? obv[p] - obv[p - 5] : NaN) / dz(vsum5[p]); }));
  put('hl_range', each((i) => (h[i] - l[i]) / c[i]));
  put('body', each((i) => (c[i] - o[i]) / c[i]));
  put('range_pos', each((i) => (c[i] - l[i]) / dz(h[i] - l[i])));
  put('gap', each((i) => { const p = pos[i]; return p >= 1 ? F.open[p] / full_c[p - 1] - 1 : NaN; }));
  const r1 = pctChange(full_c), s5 = rollingStd(r1, 5), s20 = rollingStd(r1, 20);
  put('rv_ratio', each((i) => s5[pos[i]] / dz(s20[pos[i]])));
  const dcl = col('dc20_lower'), dcu = col('dc20_upper'); put('dist_dc20', each((i) => (c[i] - dcl[i]) / dz(dcu[i] - dcl[i])));
  const sa = col('senkou_a'), sb = col('senkou_b');
  put('cloud_pos', each((i) => {
    // np.maximum / np.minimum propagate NaN, and NaN comparisons are false -> 0.0
    const top = sa[i] !== sa[i] || sb[i] !== sb[i] ? NaN : Math.max(sa[i], sb[i]);
    const bot = sa[i] !== sa[i] || sb[i] !== sb[i] ? NaN : Math.min(sa[i], sb[i]);
    return c[i] > top ? (c[i] - top) / c[i] : c[i] < bot ? (c[i] - bot) / c[i] : 0;
  }));
  const tv = votes.t;
  if (sec < 86400) {
    // NSE session 09:15-15:30 IST = 03:45-10:00 UTC
    const tod = each((i) => { const mins = Math.floor((((tv[i] % 86400) + 86400) % 86400) / 60); return Math.min(1, Math.max(0, (mins - 225) / 375)); });
    put('tod', tod);
    put('tod_sin', each((i) => Math.sin(2 * Math.PI * tod[i])));
    put('tod_cos', each((i) => Math.cos(2 * Math.PI * tod[i])));
  }
  const dow = each((i) => (((Math.floor(tv[i] / 86400) + 3) % 7) + 7) % 7);   // Monday = 0, like pandas
  put('dow_sin', each((i) => Math.sin((2 * Math.PI * dow[i]) / 5)));
  put('dow_cos', each((i) => Math.cos((2 * Math.PI * dow[i]) / 5)));
  if (market) {
    for (const k of ['mkt_ret_1', 'mkt_ret_5', 'mkt_ret_20', 'mkt_vol_20'] as const) put(k, Float64Array.from(market[k]));
    const r5 = cols[names.indexOf('ret_5')], r20 = cols[names.indexOf('ret_20')];
    put('rel_5', each((i) => r5[i] - market.mkt_ret_5[i]));
    put('rel_20', each((i) => r20[i] - market.mkt_ret_20[i]));
  }
  votes.keys.forEach((k, j) => put(`v_${k}`, Float64Array.from(votes.cols[j])));
  const y = each((i) => { const p = pos[i] + horizon; if (p >= N) return NaN; const fwd = full_c[p]; return fwd !== fwd ? NaN : fwd > c[i] ? 1 : 0; });
  for (const cc of cols) for (let i = 0; i < n; i++) if (cc[i] === Infinity || cc[i] === -Infinity) cc[i] = NaN;
  return { t: votes.t.slice(), names, cols, y };
}

// ------------------------------------------------------------------ learners
/** The four base learners with learner.py's hyper-parameters. */
export function makers(voteCols: number[]): Record<LearnerName, () => Classifier> {
  return {
    logistic_regression: () => new Pipeline([new SimpleImputer('median'), new StandardScaler(), new Clipper(-CLIP_SD, CLIP_SD)], new LogisticRegression(0.02)),
    random_forest: () => new Pipeline([new SimpleImputer('median')], new RandomForestClassifier(200, 15, 42)),
    gradient_boosting: () => new DropConstant(new HistGradientBoostingClassifier(100, 0.03, 3, 30, 2.0)),
    stacked_votes: () => new ColumnSubset(voteCols, new Pipeline([new StandardScaler(), new Clipper(-CLIP_SD, CLIP_SD)], new LogisticRegression(0.05))),
  };
}

export interface Tier { threshold: number; n: number; n_eff: number; coverage: number; accuracy: number | null }
export type Evidence = 'strong' | 'weak' | 'drift' | 'none';

export interface Fit {
  symbol: string; interval: string; horizon: number;
  lastBar: number;                 // epoch seconds of the last bar the fit saw
  fittedAt: number;                // wall-clock seconds
  nRows: number; nFeatures: number; folds: number;
  baseRate: number;                // share of the majority outcome out-of-fold
  upRate: number;                  // share of out-of-fold windows that closed higher
  accuracy: number;                // calibrated out-of-fold accuracy at 0.5
  logloss: number; loglossBase: number;
  tiers: Tier[]; threshold: number; validated: boolean; evidence: Evidence; edgeZ: number; effectiveN: number;
  learnerScores: Record<LearnerName, { accuracy: number; logloss: number }>;
  models: Record<LearnerName, Classifier>;
  halfLife: number;
  platt: [number, number];
  featureNames: string[];
  learnedWeights: Record<string, number>;
  topFeatures: [string, number][];
  /** Out-of-fold diagnostics (not in Python's Fit): raw OOF per learner over the labelled rows, NaN outside the test folds. */
  oof?: Record<LearnerName, Float64Array>;
}

export function calibrate(f: Fit, pRaw: number): number { const [a, b] = f.platt; return sigmoid(a * logit(pRaw) + b); }
export function tierFor(f: Fit, prob: number): Tier {
  const strength = Math.abs(prob - 0.5) + 0.5;
  let best = f.tiers[0];
  for (const t of f.tiers) if (strength >= t.threshold - 1e-12) best = t;
  return best;
}

/** (z, effective_n, label): how many standard errors the tier's accuracy sits above the majority side,
 *  counting ~n/horizon independent outcomes. */
export function tierEvidence(tier: Tier, baseRate: number, horizon: number, validated: boolean): [number, number, Evidence] {
  const n = Math.trunc(tier.n || 0);
  const eff = Math.max(1, Math.trunc(pyRound((tier.n_eff || n) / Math.max(1, horizon), 0)));
  if (tier.accuracy == null || n === 0) return [0, eff, 'none'];
  const se = Math.sqrt((baseRate * (1 - baseRate)) / eff);
  const z = se > 0 ? (tier.accuracy - baseRate) / se : 0;
  if (!validated) return [z, eff, 'none'];
  return [z, eff, z >= 1.64 ? 'strong' : z >= 0.8 ? 'weak' : 'drift'];
}

/** Python's round(x, nd): round-half-even on the exact binary value. */
export function pyRound(x: number, nd = 0): number {
  if (!Number.isFinite(x)) return x;
  const k = Math.pow(10, nd), s = x * k, f = Math.floor(s), diff = s - f;
  if (diff === 0.5 && (x * k) / k === x) return (f % 2 === 0 ? f : f + 1) / k;
  return Number(x.toFixed(nd));
}

/** Purged walk-forward split: [start, end) of each test fold and the training end (horizon bars purged). */
export function walkForwardSplits(n: number, horizon: number, folds: number): { s: number; e: number; trEnd: number }[] {
  const start = Math.max(Math.trunc(n * (1 - TEST_SHARE)), MIN_TRAIN + horizon);
  const step = (n - start) / folds, edges: number[] = [];
  for (let k = 0; k <= folds; k++) edges.push(Math.trunc(k === folds ? n : k * step + start));
  const out: { s: number; e: number; trEnd: number }[] = [];
  for (let k = 0; k < folds; k++) {
    const s = edges[k], e = edges[k + 1], trEnd = s - horizon;
    if (trEnd < MIN_TRAIN || e <= s) continue;
    out.push({ s, e, trEnd });
  }
  return out;
}

const oneClass = (y: ArrayLike<number>, n: number) => { for (let i = 1; i < n; i++) if (y[i] !== y[0]) return false; return true; };

async function walkForward(X: Mat, y: Float64Array, horizon: number, mk: Record<LearnerName, () => Classifier>, folds: number, dp: LearnerDeps) {
  const n = y.length, oof = {} as Record<LearnerName, Float64Array>;
  for (const name of LEARNER_NAMES) oof[name] = new Float64Array(n).fill(NaN);
  const splits = walkForwardSplits(n, horizon, folds);
  let used = 0;
  for (const { s, e, trEnd } of splits) {
    if (oneClass(y, trEnd)) return null;               // sklearn would raise here; the caller falls back
    used++;
    const w = recencyWeights(trEnd, trEnd * TRAIN_HALF_LIFE);
    const Xtr = sliceRows(X, 0, trEnd), ytr = y.subarray(0, trEnd), Xte = sliceRows(X, s, e);
    for (const name of LEARNER_NAMES) {
      const m = mk[name]().fit(Xtr, ytr, w);
      oof[name].set(m.predictProba(Xte), s);
      await tick();
    }
    dp.onProgress?.('folds', used, splits.length);
  }
  return { oof, used };
}

/** Train (or reuse) the walk-forward learner for this instrument / timeframe / horizon using only the
 *  bars in `data` (all closed).  One fit per key runs at a time; concurrent callers share the result. */
export function fit(symbol: string, interval: string, horizon: number, data: LearnerData, sec: number, d?: Partial<LearnerDeps>): Promise<Fit | null> {
  const key = `${symbol}|${interval}|${horizon}`;
  const prev = FIT_LOCKS.get(key) ?? Promise.resolve();
  const run = prev.then(() => fitLocked(key, symbol, interval, horizon, data, sec, deps(d)));
  const settled = run.catch(() => undefined);
  FIT_LOCKS.set(key, settled);
  settled.then(() => { if (FIT_LOCKS.get(key) === settled) FIT_LOCKS.delete(key); });
  return run;
}

async function fitLocked(key: string, symbol: string, interval: string, horizon: number, data: LearnerData, sec: number, dp: LearnerDeps): Promise<Fit | null> {
  const T = data.bars.t, lastBar = T[T.length - 1];
  const cached = FITS.get(key);
  if (cached && cached.lastBar <= lastBar && nowS(dp) - cached.fittedAt < FIT_MAX_AGE) {
    let newer = 0;
    for (const x of T) if (x > cached.lastBar) newer++;
    if (newer < Math.max(2, Math.floor(horizon / 2))) return cached;
  }
  const votes = await strategyVotes(symbol, interval, data, sec, MAX_ROWS, trainingStride(horizon), dp);
  const market = await marketFeatures(symbol, interval, votes.t, dp);
  const feats = buildFeatures(data, votes, market, horizon, sec);
  const res = await fitFromFeatures(symbol, interval, horizon, feats, lastBar, dp);
  if (res) FITS.set(key, res);
  return res;
}

/** Rows kept for training: labelled and more than 70% of features present. */
export function labelledRows(feats: FeatureTable): number[] {
  const rows: number[] = [], p = feats.cols.length;
  for (let i = 0; i < feats.y.length; i++) {
    if (feats.y[i] !== feats.y[i]) continue;
    let ok = 0;
    for (let j = 0; j < p; j++) if (feats.cols[j][i] === feats.cols[j][i]) ok++;
    if (ok / p > 0.7) rows.push(i);
  }
  return rows;
}

/** Out-of-fold scores, Platt calibration, tiers and the call rule (learner.fit between the walk-forward and
 *  the final models).  Pure: given the same OOF predictions it reproduces Python's numbers. */
export function calibrateOof(oof: Record<LearnerName, ArrayLike<number>>, Y: ArrayLike<number>, horizon: number, used: number) {
  const n = Y.length;
  const maskIdx: number[] = [];
  for (let i = 0; i < n; i++) if (oof.logistic_regression[i] === oof.logistic_regression[i]) maskIdx.push(i);
  if (maskIdx.length < 60 || used === 0) return null;
  const yo = Float64Array.from(maskIdx, (i) => Y[i]), no = yo.length;
  const halfLife = Math.max(CAL_HALF_LIFE_MIN, no * CAL_HALF_LIFE);
  const wo = recencyWeights(no, halfLife);
  const scores = {} as Record<LearnerName, { accuracy: number; logloss: number }>;
  const pAvg = new Float64Array(no);
  for (const name of LEARNER_NAMES) {
    const po = Float64Array.from(maskIdx, (i) => oof[name][i]);
    const hit = Float64Array.from(po, (x, k) => ((x > 0.5) === (yo[k] > 0.5) ? 1 : 0));
    scores[name] = { accuracy: wavg(hit, wo), logloss: logloss(po, yo, wo) };
    for (let k = 0; k < no; k++) pAvg[k] += po[k];
  }
  for (let k = 0; k < no; k++) pAvg[k] /= LEARNER_NAMES.length;
  const lg = Float64Array.from(pAvg, logit);
  const [a, b] = plattFit(lg, yo, wo);
  const pCal = Float64Array.from(lg, (x) => sigmoid(a * x + b));
  const upRate = wavg(yo, wo), baseRate = Math.max(upRate, 1 - upRate);
  const hits = Float64Array.from(pCal, (x, k) => ((x > 0.5) === (yo[k] > 0.5) ? 1 : 0));
  const acc = wavg(hits, wo);
  const tiers: Tier[] = THRESHOLDS.map((t) => {
    const sel: number[] = [];
    for (let k = 0; k < no; k++) if (Math.abs(pCal[k] - 0.5) >= t - 0.5 - 1e-12) sel.push(k);
    const ws = sel.map((k) => wo[k]);
    return { threshold: t, n: sel.length, n_eff: pyRound(kish(ws), 1), coverage: sel.length / no,
             accuracy: sel.length ? wavg(sel.map((k) => hits[k]), ws) : null };
  });
  const minN = Math.max(30, 2 * horizon);
  const chosen = tiers.find((t) => t.accuracy != null && t.n >= minN && t.accuracy >= MIN_TIER_ACC) ?? null;
  const validated = chosen != null;
  const threshold = validated ? chosen!.threshold : 0.6;
  const ref = chosen ?? tiers.find((t) => t.threshold === threshold) ?? tiers[0];
  const [z, eff, evidence] = tierEvidence(ref, baseRate, horizon, validated);
  return {
    baseRate, upRate, accuracy: acc, logloss: logloss(pCal, yo, wo), loglossBase: logloss(new Float64Array(no).fill(upRate), yo, wo),
    halfLife: Math.trunc(halfLife), tiers, threshold, validated, evidence, edgeZ: z, effectiveN: eff, learnerScores: scores,
    platt: [a, b] as [number, number], pCal, yo, wo,
  };
}

/** The fit itself from a ready feature table (exported for tests / backtests that bring their own votes). */
export async function fitFromFeatures(symbol: string, interval: string, horizon: number, feats: FeatureTable, lastBar: number,
                                      d?: Partial<LearnerDeps>): Promise<Fit | null> {
  const dp = deps(d);
  const rows = labelledRows(feats);
  if (rows.length < MIN_ROWS) return null;
  const names = feats.names, p = names.length, n = rows.length;
  const voteCols = names.map((c, i) => (c.startsWith('v_') ? i : -1)).filter((i) => i >= 0);
  const X = mat(n, p), Y = new Float64Array(n);
  for (let r = 0; r < n; r++) { const i = rows[r]; Y[r] = feats.y[i]; for (let j = 0; j < p; j++) X.data[r * p + j] = feats.cols[j][i]; }
  const mk = makers(voteCols);
  const folds = n >= 400 ? FOLDS : 3;
  const wf = await walkForward(X, Y, horizon, mk, folds, dp);
  if (!wf) return null;
  const { oof, used } = wf;
  const cal = calibrateOof(oof, Y, horizon, used);
  if (!cal) return null;
  const { baseRate, upRate, accuracy: acc, tiers, threshold, validated, evidence, edgeZ: z, effectiveN: eff, learnerScores: scores, platt: [a, b], halfLife } = cal;
  // final models on every labelled row (recent rows weighted up)
  if (oneClass(Y, n)) return null;
  const wAll = recencyWeights(n, n * TRAIN_HALF_LIFE);
  const models = {} as Record<LearnerName, Classifier>;
  for (const name of LEARNER_NAMES) { models[name] = mk[name]().fit(X, Y, wAll); await tick(); }
  const stack = ((models.stacked_votes as ColumnSubset).model as Pipeline).final as LogisticRegression;
  const learned: Record<string, number> = {};
  voteCols.forEach((c, k) => (learned[names[c].slice(2)] = stack.coef[k]));
  const rf = (models.random_forest as Pipeline).final as RandomForestClassifier;
  // Python zips the full name list with the importances of the imputer-kept columns (same order when none dropped)
  const pairs: [string, number][] = [];
  for (let j = 0; j < Math.min(names.length, rf.featureImportances.length); j++) pairs.push([names[j], rf.featureImportances[j]]);
  const top = pairs.map((x, i) => [x, i] as [[string, number], number]).sort((u, v) => v[0][1] - u[0][1] || u[1] - v[1]).slice(0, 10).map((x) => x[0]);
  return {
    symbol, interval, horizon, lastBar, fittedAt: nowS(dp), nRows: n, nFeatures: p, folds: used, baseRate, upRate, accuracy: acc,
    logloss: cal.logloss, loglossBase: cal.loglossBase, halfLife,
    tiers, threshold, validated, evidence, edgeZ: z, effectiveN: eff, learnerScores: scores, models, platt: [a, b], featureNames: names,
    learnedWeights: learned, topFeatures: top, oof,
  };
}

// ------------------------------------------------------------------ prediction
export interface Prediction {
  fit: Fit;
  prob: number;          // calibrated P(up)
  probRaw: number;
  perLearner: Partial<Record<LearnerName, number>>;
  tier: Tier;
  signals: Signal[];
  evidence: Evidence;    // evidence for a call of this strength
  edgeZ: number;
  effectiveN: number;
}

const pct0 = (x: number) => pyRound(x * 100, 0).toFixed(0);

/** Predict for the last row of a feature table with a fitted model (no I/O). */
export function predictFromFeatures(f: Fit, feats: FeatureTable): Prediction | null {
  const last = feats.t.length - 1, x = mat(1, f.featureNames.length);
  const colOf = new Map(feats.names.map((n, j) => [n, j]));
  f.featureNames.forEach((name, j) => { const c = colOf.get(name); x.data[j] = c === undefined ? NaN : feats.cols[c][last]; });
  const per: Partial<Record<LearnerName, number>> = {};
  for (const name of LEARNER_NAMES) {
    try { per[name] = f.models[name].predictProba(x)[0]; } catch { /* skip a failing learner */ }
  }
  const vals = Object.values(per) as number[];
  if (!vals.length) return null;
  const pRaw = vals.reduce((s, v) => s + v, 0) / vals.length;
  const p = calibrate(f, pRaw);
  const tier = tierFor(f, p);
  const signals: Signal[] = [];
  for (const name of Object.keys(per) as LearnerName[]) {
    const pl = per[name]!, sc = f.learnerScores[name], meta = LEARNER_META[name];
    const d = pl > 0.53 ? 1 : pl < 0.47 ? -1 : 0;
    const edge = Math.max(sc.accuracy - 0.5, 0);
    signals.push({
      key: name, ...meta, category: 'ml', direction: d, confidence: clip01(Math.abs(pl - 0.5) * 2 * (0.4 + edge * 4)),
      reason: `P(up) ${pct0(pl)}%; walk-forward accuracy ${pct0(sc.accuracy)}% on ${f.nRows} bars (${f.folds} folds, base rate ${pct0(f.baseRate)}%)`,
      values: { prob_up: pl, validation_accuracy: sc.accuracy, logloss: sc.logloss, base_rate: f.baseRate, train_bars: f.nRows },
    });
  }
  const strength = Math.abs(p - 0.5) + 0.5;
  const d = strength >= f.threshold - 1e-12 ? (p > 0.5 ? 1 : -1) : 0;
  const accHere = tier.accuracy != null ? tier.accuracy : f.accuracy;
  const [zHere, effHere, evidence] = tierEvidence(tier, f.baseRate, f.horizon, d !== 0);
  const conf = d ? clip01((accHere - 0.5) * 2) : clip01(1 - Math.abs(p - 0.5) * 4) * 0.6;
  const reason = d
    ? `Calibrated P(up) ${pct0(p)}%. Out-of-sample, calls at least this strong were right ${pct0(accHere)}% of the time (${tier.n} bars, ${pct0(tier.coverage)}% of history); evidence: ${evidence}`
    : `Calibrated P(up) ${pct0(p)}% - below the ${f.threshold.toFixed(2)} strength where this chart's calls have been reliable`
      + (f.validated ? '' : ` (no strength level reached ${pct0(MIN_TIER_ACC)}% out-of-sample accuracy)`) + '; no call';
  signals.push({
    key: 'wf_ensemble', ...LEARNER_META.wf_ensemble, category: 'ml', direction: d as -1 | 0 | 1, confidence: conf, reason,
    values: { prob_up: p, prob_raw: pRaw, expected_accuracy: accHere, threshold: f.threshold, validated: f.validated, evidence, oof_accuracy: f.accuracy, base_rate: f.baseRate },
  });
  return { fit: f, prob: p, probRaw: pRaw, perLearner: per, tier, signals, evidence, edgeZ: zHere, effectiveN: effHere };
}

/** Fit or reuse the learner and predict from the last closed bar of `data`. */
export async function predict(symbol: string, interval: string, horizon: number, data: LearnerData, sec: number, d?: Partial<LearnerDeps>): Promise<Prediction | null> {
  const dp = deps(d);
  const f = await fit(symbol, interval, horizon, data, sec, dp);
  if (!f) return null;
  const votes = await strategyVotes(symbol, interval, data, sec, 1, 1, dp);
  const market = await marketFeatures(symbol, interval, votes.t, dp);
  const feats = buildFeatures(data, votes, market, horizon, sec);
  return predictFromFeatures(f, feats);
}

/** Prediction.summary() - the snake_case dict the Python API returns (rounded the same way). */
export function predictionSummary(pr: Prediction): Record<string, unknown> {
  const f = pr.fit, r4 = (x: number) => pyRound(x, 4);
  return {
    available: true, prob_up: r4(pr.prob), prob_raw: r4(pr.probRaw),
    n_rows: f.nRows, n_features: f.nFeatures, folds: f.folds, base_rate: r4(f.baseRate), up_rate: r4(f.upRate),
    accuracy: r4(f.accuracy), logloss: r4(f.logloss), logloss_base: r4(f.loglossBase),
    threshold: f.threshold, validated: f.validated,
    fit_evidence: f.evidence, fit_edge_z: pyRound(f.edgeZ, 2), fit_effective_n: f.effectiveN,
    evidence: pr.evidence, edge_z: pyRound(pr.edgeZ, 2), effective_n: pr.effectiveN, tiers: f.tiers, half_life: f.halfLife,
    tier: pr.tier, expected_accuracy: pr.tier.accuracy,
    learners: Object.fromEntries(Object.entries(f.learnerScores).map(([k, v]) => [k, { accuracy: r4(v.accuracy), logloss: r4(v.logloss) }])),
    learned_weights: Object.fromEntries(Object.entries(f.learnedWeights).map(([k, v]) => [k, pyRound(v, 3)])),
    top_features: f.topFeatures.map(([n, w]) => [n, r4(w)]),
    fitted_on: new Date(f.lastBar * 1000).toISOString().slice(0, 19),
  };
}

export function catalog(): { key: string; kind: string; doc: string }[] {
  return Object.entries(LEARNER_META).map(([k, m]) => ({ key: k, kind: 'model', doc: `${m.name}. ${m.origin}. ${m.rules}` }));
}
