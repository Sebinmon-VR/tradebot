/**
 * Market map metrics - port of app/screener.py _metrics().  The phone downloads 2 years of daily bars once
 * (shared with the Overextended scan); the screener's 52-week figures use the last year of them, as the
 * Python screener's 1-year download does.
 */
import * as ind from './indicators';
import { lastValid, pctChange, rollingMean, std } from './series';
import { Bars, sliceBars } from './types';
import { scoreSeries } from './overextended';

const r = (x: number | null | undefined, d = 2) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);

export function lastYear(b: Bars): Bars {
  const cut = b.t[b.t.length - 1] - 365 * 86400;
  const i = b.t.findIndex((t) => t > cut);
  return i > 0 ? sliceBars(b, i) : b;
}

export function metrics(sym: string, full2y: Bars) {
  const b = lastYear(full2y);
  const { c, h, l, o } = b, v = b.v.map((x) => x || 0), n = c.length;
  const last = c[n - 1], prev = c[n - 2];
  const chg = (k: number) => (n > k ? (last / c[n - 1 - k] - 1) * 100 : null);
  const rng = ((h[n - 1] - l[n - 1]) / last) * 100;
  const volAvg = n > 21 ? v.slice(-21, -1).reduce((a, x) => a + x, 0) / 20 : v.slice(0, -1).reduce((a, x) => a + x, 0) / Math.max(1, n - 1);
  const volRatio = volAvg > 0 ? v[n - 1] / volAvg : null;
  const rsi = n > 15 ? ind.rsi(c, 14)[n - 1] : null;
  const atrPct = n > 15 ? (ind.atr(b, 14)[n - 1] / last) * 100 : null;
  const sma50 = n >= 50 ? rollingMean(c, 50)[n - 1] : null;
  const sma200 = n >= 200 ? rollingMean(c, 200)[n - 1] : null;
  const macdHist = n > 35 ? ind.macd(c).macd_hist[n - 1] : null;
  const hi52 = Math.max(...h), lo52 = Math.min(...l);
  const pos52 = hi52 > lo52 ? ((last - lo52) / (hi52 - lo52)) * 100 : null;
  const vol20 = n > 21 ? std(pctChange(c).slice(-20), 1) * Math.sqrt(252) * 100 : null;
  const gap = (o[n - 1] / prev - 1) * 100;
  // quick trend bias -5..+5 (not the full ensemble; that runs on the analysis screen)
  let bias = 0;
  if (sma50 != null) bias += last > sma50 ? 1 : -1;
  if (sma50 != null && sma200 != null) bias += sma50 > sma200 ? 1 : -1;
  if (rsi != null) bias += rsi > 50 ? 1 : -1;
  if (macdHist != null) bias += macdHist > 0 ? 1 : -1;
  const c5 = chg(5);
  if (c5 != null) bias += c5 > 0 ? 1 : -1;
  let ext: number | null = null;
  try { ext = full2y.c.length >= 60 ? Math.round(lastValid(scoreSeries(full2y))) : null; } catch { ext = null; }
  const volume = v[n - 1];
  return {
    symbol: sym, name: sym.replace(/\.(NS|BO)$/, ''), price: r(last)!, chg_1d: r((last / prev - 1) * 100)!, gap: r(gap)!, chg_5d: r(c5), chg_20d: r(chg(20)),
    range_pct: r(rng)!, volume, turnover: Math.round(volume * last), vol_ratio: r(volRatio), rsi: r(rsi, 1), atr_pct: r(atrPct), volatility: r(vol20, 1),
    pos_52w: r(pos52, 1), dist_52w_high: r((last / hi52 - 1) * 100)!, above_sma50: sma50 == null ? null : last > sma50, above_sma200: sma200 == null ? null : last > sma200,
    bias, ext_score: ext, bar_time: b.t[n - 1],
  };
}
export type ScreenerRow = ReturnType<typeof metrics> & { via?: string | null; sector?: string; market_cap?: number | null };

export function summarize(frames: Map<string, Bars>, symbols: string[], indices: Record<string, string>, name: string, universe: string) {
  const rows: ScreenerRow[] = [], missing: string[] = [], idx: ScreenerRow[] = [];
  for (const s of symbols) {
    const b = frames.get(s);
    if (!b || b.c.length < 5) { missing.push(s); continue; }
    try { rows.push(metrics(s, b)); } catch (e) { missing.push(`${s}: ${(e as Error).message}`); }
  }
  for (const [s, label] of Object.entries(indices)) {
    const b = frames.get(s);
    if (b && b.c.length >= 5) idx.push({ ...metrics(s, b), name: label });
  }
  return { universe, name, count: rows.length, rows, indices: idx, missing, generated_at: new Date().toISOString() };
}
