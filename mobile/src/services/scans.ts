/**
 * The scans behind the Map and Today screens: download through the shared Yahoo cache (engine/yahoo.ts),
 * run the ported scanner, attach market cap / sector.  Results are memoised briefly so switching screens or
 * sort orders does not re-download.
 */
import * as intraday from '@/engine/intraday';
import { decorate, ensureMeta, metaPending } from '@/engine/meta';
import * as over from '@/engine/overextended';
import * as screener from '@/engine/screener';
import { UNIVERSES } from '@/engine/universe';
import { fetchMany, normalizeSymbol } from '@/engine/yahoo';
import { kv } from '@/storage/db';

export type Progress = (done: number, total: number) => void;
const CACHE_S = 60;
const memo = new Map<string, { at: number; value: unknown }>();

function symbolsFor(universe: string, watchlist: string) {
  const u = UNIVERSES[universe] ?? UNIVERSES.nifty100;
  const extra: string[] = [];
  for (const s of watchlist.split(',')) {
    try { if (s.trim()) extra.push(normalizeSymbol(s.trim(), u.exchange)); } catch { /* skip bad input */ }
  }
  return { u, symbols: [...new Set([...u.symbols, ...extra])] };
}

async function cached<T>(key: string, force: boolean, run: () => Promise<T>): Promise<T> {
  const hit = memo.get(key);
  if (!force && hit && Date.now() / 1000 - hit.at < CACHE_S) return hit.value as T;
  const value = await run();
  memo.set(key, { at: Date.now() / 1000, value });
  return value;
}

/** Market map: 2 years of daily bars (the multi-day Overextended scan reuses the same downloads). */
export function scanMap(universe: string, watchlist = '', onProgress?: Progress, force = false) {
  return cached(`map|${universe}|${watchlist}`, force, async () => {
    const { u, symbols } = symbolsFor(universe, watchlist);
    const t0 = Date.now();
    const { frames } = await fetchMany([...symbols, ...Object.keys(u.indices)], '1d', '2y', onProgress);
    const res = screener.summarize(frames, symbols, u.indices, u.name, universe);
    const pending = await ensureMeta(kv, res.rows.map((r) => r.symbol));
    return { ...res, meta_pending: pending, took_s: (Date.now() - t0) / 1000 };
  }).then((r) => ({ ...r, rows: decorate(r.rows) }));
}

/** Multi-day overextension on daily bars. */
export function scanOverextended(universe: string, watchlist = '', onProgress?: Progress, force = false) {
  return cached(`ext|${universe}|${watchlist}`, force, async () => {
    const { u, symbols } = symbolsFor(universe, watchlist);
    const t0 = Date.now();
    const { frames } = await fetchMany(symbols, '1d', '2y', onProgress);
    const res = over.summarize(frames, symbols, u.name, universe);
    await ensureMeta(kv, res.rows.map((r) => r.symbol));
    return { ...res, took_s: (Date.now() - t0) / 1000 };
  }).then((r) => ({ ...r, rows: decorate(r.rows) }));
}

/** Today: run up from (or fall below) the session open on 5-minute bars. */
export function scanToday(universe: string, watchlist = '', side: intraday.Side = 'up', onProgress?: Progress, force = false) {
  return cached(`today|${universe}|${watchlist}|${side}`, force, async () => {
    const { u, symbols } = symbolsFor(universe, watchlist);
    const t0 = Date.now();
    const { frames } = await fetchMany(symbols, intraday.INTERVAL, intraday.HIST_RANGE, onProgress);
    const res = intraday.summarize(frames, symbols, u.name, universe, side);
    await ensureMeta(kv, res.rows.map((r) => r.symbol));
    return { ...res, took_s: (Date.now() - t0) / 1000 };
  }).then((r) => ({ ...r, rows: decorate(r.rows) }));
}

/** Re-attach market caps / sectors once the background fetch has finished. */
export const redecorate = <T extends { symbol: string; name: string }>(rows: T[]) => decorate(rows);
/** Resolves when a pending market-cap / sector download finishes (null when none is running). */
export const afterMeta = () => metaPending();
