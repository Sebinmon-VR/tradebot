/**
 * Minimal pandas-style series helpers.  A series is a plain number[] aligned to the bars; missing
 * values are NaN, exactly where pandas would put NaN, so ports of the Python engine can be checked
 * number-for-number against it (see mobile/tests/parity).
 */
export type Series = number[];

export const nan = Number.NaN;
export const isNum = (x: number) => !Number.isNaN(x);
export const full = (n: number, v = nan): Series => new Array(n).fill(v);

export function map2(a: Series, b: Series, f: (x: number, y: number) => number): Series {
  const out = new Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = f(a[i], b[i]);
  return out;
}
export const add = (a: Series, b: Series) => map2(a, b, (x, y) => x + y);
export const sub = (a: Series, b: Series) => map2(a, b, (x, y) => x - y);
export const mul = (a: Series, b: Series) => map2(a, b, (x, y) => x * y);
/** Division with pandas' `.replace(0, np.nan)` on the denominator. */
export const div = (a: Series, b: Series) => map2(a, b, (x, y) => (y === 0 ? nan : x / y));
export const scale = (a: Series, k: number) => a.map((x) => x * k);

export function shift(s: Series, k: number): Series {
  const n = s.length, out = full(n);
  if (k >= 0) for (let i = k; i < n; i++) out[i] = s[i - k];
  else for (let i = 0; i < n + k; i++) out[i] = s[i - k];
  return out;
}
export const diff = (s: Series, k = 1) => map2(s, shift(s, k), (x, y) => x - y);
export const pctChange = (s: Series, k = 1) => map2(s, shift(s, k), (x, y) => (y === 0 ? nan : x / y - 1));

/** rolling(n, min_periods=n).<agg>() - NaN whenever the window is short or holds a NaN. */
function rolling(s: Series, n: number, agg: (w: number[]) => number, minPeriods = n): Series {
  const out = full(s.length);
  for (let i = 0; i < s.length; i++) {
    const lo = Math.max(0, i - n + 1);
    const w: number[] = [];
    for (let j = lo; j <= i; j++) if (isNum(s[j])) w.push(s[j]);
    if (w.length >= minPeriods && (minPeriods < n || w.length === i - lo + 1)) out[i] = agg(w);
  }
  return out;
}
export function rollingMean(s: Series, n: number, minPeriods = n): Series {
  // O(n) running sum for the common all-valid case; falls back to the generic path around NaNs
  const out = full(s.length);
  let sum = 0, cnt = 0;
  for (let i = 0; i < s.length; i++) {
    if (isNum(s[i])) { sum += s[i]; cnt++; }
    if (i >= n && isNum(s[i - n])) { sum -= s[i - n]; cnt--; }
    const win = Math.min(n, i + 1);
    if (cnt >= minPeriods && (minPeriods < n || cnt === win) && win >= Math.min(n, minPeriods)) out[i] = sum / cnt;
  }
  return out;
}
export const rollingSum = (s: Series, n: number, minPeriods = n) => rolling(s, n, (w) => w.reduce((a, b) => a + b, 0), minPeriods);
export const rollingMax = (s: Series, n: number, minPeriods = n) => rolling(s, n, (w) => Math.max(...w), minPeriods);
export const rollingMin = (s: Series, n: number, minPeriods = n) => rolling(s, n, (w) => Math.min(...w), minPeriods);
/** Standard deviation; ddof=1 like pandas' default, ddof=0 like numpy / Bollinger. */
export function rollingStd(s: Series, n: number, ddof = 1, minPeriods = n): Series {
  return rolling(s, n, (w) => {
    if (w.length - ddof <= 0) return nan;
    const m = w.reduce((a, b) => a + b, 0) / w.length;
    return Math.sqrt(w.reduce((a, b) => a + (b - m) * (b - m), 0) / (w.length - ddof));
  }, minPeriods);
}
/** Centered rolling max/min (pandas center=True, odd window). */
export function centeredMax(s: Series, n: number): Series {
  const r = rollingMax(s, n), half = (n - 1) / 2;
  return shift(r, -half);
}
export function centeredMin(s: Series, n: number): Series {
  const r = rollingMin(s, n), half = (n - 1) / 2;
  return shift(r, -half);
}

/**
 * ewm(alpha, adjust=False, min_periods).mean(): starts at the first valid value; NaNs in the middle keep
 * the previous state (pandas ignore_na=False differs only in re-weighting, which never happens here
 * because inputs are NaN only at the start).
 */
export function ewm(s: Series, alpha: number, minPeriods = 0): Series {
  const out = full(s.length);
  let m = nan, cnt = 0;
  for (let i = 0; i < s.length; i++) {
    const x = s[i];
    if (isNum(x)) {
      m = isNum(m) ? alpha * x + (1 - alpha) * m : x;
      cnt++;
    }
    if (cnt >= Math.max(1, minPeriods) && isNum(m)) out[i] = m;
  }
  return out;
}

export function cumsum(s: Series): Series {
  const out = full(s.length);
  let acc = 0;
  for (let i = 0; i < s.length; i++) {
    if (isNum(s[i])) acc += s[i];
    out[i] = isNum(s[i]) ? acc : nan;
  }
  return out;
}
export const fillna = (s: Series, v: number) => s.map((x) => (isNum(x) ? x : v));
export const clip = (s: Series, lo = -Infinity, hi = Infinity) => s.map((x) => (isNum(x) ? Math.min(hi, Math.max(lo, x)) : x));
export const last = (s: Series) => s[s.length - 1];
export function lastValid(s: Series): number {
  for (let i = s.length - 1; i >= 0; i--) if (isNum(s[i])) return s[i];
  return nan;
}
export function mean(xs: number[]): number {
  const v = xs.filter(isNum);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : nan;
}
export function std(xs: number[], ddof = 0): number {
  const v = xs.filter(isNum);
  if (v.length - ddof <= 0) return nan;
  const m = mean(v);
  return Math.sqrt(v.reduce((a, b) => a + (b - m) * (b - m), 0) / (v.length - ddof));
}
export function median(xs: number[]): number {
  const v = xs.filter(isNum).sort((a, b) => a - b);
  if (!v.length) return nan;
  const k = v.length >> 1;
  return v.length % 2 ? v[k] : (v[k - 1] + v[k]) / 2;
}
/** Group consecutive runs by key (bars are time-sorted, so a session is one run). */
export function groupRuns<K>(keys: K[]): { key: K; start: number; end: number }[] {
  const runs: { key: K; start: number; end: number }[] = [];
  for (let i = 0; i < keys.length; i++) {
    if (!runs.length || runs[runs.length - 1].key !== keys[i]) runs.push({ key: keys[i], start: i, end: i + 1 });
    else runs[runs.length - 1].end = i + 1;
  }
  return runs;
}
