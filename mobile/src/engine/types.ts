/** OHLCV bars, oldest first.  `t` is the bar's start in epoch seconds (UTC). */
export interface Bars {
  t: number[];
  o: number[];
  h: number[];
  l: number[];
  c: number[];
  v: number[];
}

export const IST_OFFSET_S = 19800; // Asia/Kolkata, no DST

/** Session day key (days since epoch in IST) - the same grouping as pandas' index.normalize() on IST bars. */
export const istDay = (t: number) => Math.floor((t + IST_OFFSET_S) / 86400);
/** Minutes after midnight IST. */
export const istMinutes = (t: number) => Math.floor(((t + IST_OFFSET_S) % 86400) / 60);
export const istDate = (t: number) => new Date((t + IST_OFFSET_S) * 1000).toISOString().slice(0, 10);
export const istTime = (t: number) => new Date((t + IST_OFFSET_S) * 1000).toISOString().slice(11, 16);

export function sliceBars(b: Bars, start: number, end = b.t.length): Bars {
  return { t: b.t.slice(start, end), o: b.o.slice(start, end), h: b.h.slice(start, end), l: b.l.slice(start, end), c: b.c.slice(start, end), v: b.v.slice(start, end) };
}

export function isIntraday(b: Bars): boolean {
  const n = b.t.length;
  if (n < 3) return false;
  const d: number[] = [];
  for (let i = Math.max(1, n - 9); i < n; i++) d.push(b.t[i] - b.t[i - 1]);
  d.sort((a, b2) => a - b2);
  const m = d.length % 2 ? d[d.length >> 1] : (d[d.length / 2 - 1] + d[d.length / 2]) / 2;
  return m < 86400;
}

export class DataError extends Error {}
