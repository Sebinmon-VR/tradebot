/**
 * Market data straight from Yahoo's chart API (the endpoint yfinance itself uses), with the same two-tier
 * cache as app/data.py: the full history is downloaded at most every HISTORY_TTL seconds, and in between only
 * the latest session is fetched and merged over it.  Requests go through a small queue (MAX_PARALLEL at a
 * time, interactive callers first) because Yahoo throttles bursts.
 */
import { NET } from './net';
import { ALIASES } from './universe';
import { Bars, DataError } from './types';

export const INTERVALS: Record<string, { range: string; seconds: number; tail: string }> = {
  '1m': { range: '7d', seconds: 60, tail: '1d' },
  '5m': { range: '60d', seconds: 300, tail: '1d' },
  '15m': { range: '60d', seconds: 900, tail: '1d' },
  '30m': { range: '60d', seconds: 1800, tail: '1d' },
  '1h': { range: '730d', seconds: 3600, tail: '5d' },
  '1d': { range: '5y', seconds: 86400, tail: '5d' },
  '1wk': { range: '10y', seconds: 604800, tail: '1mo' },
};
export const EXCHANGE_SUFFIX: Record<string, string> = { NSE: '.NS', BSE: '.BO', '': '.NS' };
const INDIAN_INDICES = new Set(['^NSEI', '^NSEBANK', '^BSESN', '^CNXIT', '^INDIAVIX']);
const HISTORY_TTL = 600, TAIL_TTL = 2;
const INTRADAY_SEC: Record<string, boolean> = { '1m': true, '5m': true, '15m': true, '30m': true, '1h': true };
const MAX_PARALLEL = 6;

export function normalizeSymbol(symbol: string, exchange = ''): string {
  const s = symbol.trim().toUpperCase();
  if (!s) throw new DataError('Symbol is required');
  if (ALIASES[s]) return ALIASES[s];
  const ex = exchange.trim().toUpperCase();
  if (!(ex in EXCHANGE_SUFFIX)) throw new DataError(`Unknown exchange '${exchange}'. Use NSE or BSE.`);
  const qualified = s.includes('.') || s.startsWith('^') || s.includes('=') || s.includes('-');
  return qualified ? s : s + EXCHANGE_SUFFIX[ex];
}
export const isIndian = (sym: string) => /\.(NS|BO)$/i.test(sym) || INDIAN_INDICES.has(sym.toUpperCase());

// ------------------------------------------------------------ request queue
let active = 0;
const waiting: { fg: boolean; go: () => void }[] = [];
function acquire(fg: boolean): Promise<void> {
  if (active < MAX_PARALLEL) { active++; return Promise.resolve(); }
  return new Promise((go) => { const item = { fg, go: () => { active++; go(); } }; fg ? waiting.unshift(item) : waiting.push(item); });
}
function release() {
  active--;
  const next = waiting.shift();
  if (next) next.go();
}

async function getJson(path: string, background = false): Promise<any> {
  await acquire(!background);
  try {
    let lastErr: unknown;
    for (const host of NET.query) {
      try {
        const r = await fetch(host + path, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } });
        if (r.status === 404) return (await r.json().catch(() => null)) ?? null;
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return await r.json();
      } catch (e) { lastErr = e; }
    }
    throw new DataError(`Yahoo request failed: ${String((lastErr as Error)?.message ?? lastErr)}`);
  } finally { release(); }
}

export interface ChartMeta { symbol: string; currency?: string; exchangeName?: string; regularMarketPrice?: number; chartPreviousClose?: number; longName?: string; shortName?: string }

/** One chart download, adjusted like yfinance's auto_adjust=True (daily+ bars scaled by adjclose / close). */
export async function downloadChart(symbol: string, interval: string, range: string, background = false): Promise<{ bars: Bars; meta: ChartMeta }> {
  const q = `/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}&includePrePost=false&events=div%2Csplits`;
  const j = await getJson(q, background);
  const res = j?.chart?.result?.[0];
  if (!res) {
    const msg = j?.chart?.error?.description;
    throw new DataError(msg ? `${symbol}: ${msg}` : `No data returned for '${symbol}'. Check the symbol / exchange.`);
  }
  const ts: number[] = res.timestamp ?? [];
  const q0 = res.indicators?.quote?.[0] ?? {};
  const adj: (number | null)[] | undefined = res.indicators?.adjclose?.[0]?.adjclose;
  const bars: Bars = { t: [], o: [], h: [], l: [], c: [], v: [] };
  for (let i = 0; i < ts.length; i++) {
    const c = q0.close?.[i];
    if (c == null || Number.isNaN(c)) continue;
    const f = adj && adj[i] != null && c ? (adj[i] as number) / c : 1;
    const o = q0.open?.[i] ?? c, h = q0.high?.[i] ?? c, l = q0.low?.[i] ?? c;
    const t = ts[i];
    // NSE/BSE intraday: Yahoo appends a zero-volume 15:30 IST print after the close - not a trading bar
    if (INTRADAY_SEC[interval] && isIndian(symbol) && (q0.volume?.[i] ?? 0) === 0 && ((t + 19800) % 86400) / 60 >= 930) continue;
    // Yahoo occasionally repeats the forming bar with the same timestamp: keep the latest
    if (bars.t.length && bars.t[bars.t.length - 1] === t) { bars.t.pop(); bars.o.pop(); bars.h.pop(); bars.l.pop(); bars.c.pop(); bars.v.pop(); }
    bars.t.push(t); bars.o.push(o * f); bars.h.push(h * f); bars.l.push(l * f); bars.c.push(c * f); bars.v.push(q0.volume?.[i] ?? 0);
  }
  return { bars, meta: res.meta ?? { symbol } };
}

/** Overlay the fresh tail on the history (rows in both take the fresh values). */
export function mergeBars(hist: Bars, tail: Bars): Bars {
  if (!tail.t.length) return hist;
  const cut = hist.t.findIndex((t) => t >= tail.t[0]);
  const k = cut < 0 ? hist.t.length : cut;
  const cat = (a: number[], b: number[]) => a.slice(0, k).concat(b);
  return { t: cat(hist.t, tail.t), o: cat(hist.o, tail.o), h: cat(hist.h, tail.h), l: cat(hist.l, tail.l), c: cat(hist.c, tail.c), v: cat(hist.v, tail.v) };
}

export interface Fetched { bars: Bars; meta: ChartMeta; dataSymbol: string; note?: string }
const HISTORY = new Map<string, { at: number; f: Fetched }>();
const MERGED = new Map<string, { at: number; f: Fetched }>();
const INFLIGHT = new Map<string, Promise<Fetched>>();
const now = () => Date.now() / 1000;

/**
 * OHLCV for a symbol including the forming bar.  `fresh` tops the cached history up with the latest session.
 * A BSE ticker with thin Yahoo history falls back to the NSE listing (and says so in `note`).
 */
export async function fetchBars(symbol: string, interval = '1d', opts: { exchange?: string; fresh?: boolean; background?: boolean; range?: string } = {}): Promise<Fetched> {
  const sym = normalizeSymbol(symbol, opts.exchange ?? '');
  const iv = INTERVALS[interval];
  if (!iv) throw new DataError(`Unsupported interval '${interval}'`);
  const range = opts.range ?? iv.range;
  const key = `${sym}|${interval}|${range}`;
  const pending = INFLIGHT.get(key);
  if (pending) return pending;
  const p = (async (): Promise<Fetched> => {
    const merged = MERGED.get(key);
    if (merged && now() - merged.at < TAIL_TTL) return merged.f;
    const hist = HISTORY.get(key);
    if (!hist || now() - hist.at >= HISTORY_TTL) {
      const { bars, meta } = await downloadChart(sym, interval, range, opts.background);
      if (bars.t.length < 60 && sym.endsWith('.BO')) {
        const ns = sym.slice(0, -3) + '.NS';
        try {
          const alt = await fetchBars(ns, interval, { ...opts, exchange: '' });
          if (alt.bars.t.length >= 60) {
            const f = { ...alt, note: `Yahoo has no usable BSE history for ${sym}; showing NSE data (${ns}), which tracks the BSE price closely.` };
            HISTORY.set(key, { at: now(), f }); MERGED.set(key, { at: now(), f });
            return f;
          }
        } catch { /* fall through to the error below */ }
      }
      if (!bars.t.length) throw new DataError(`No data returned for '${sym}' (${interval}). Check the symbol / exchange.`);
      if (bars.t.length < 60) throw new DataError(`Only ${bars.t.length} bars available for ${sym}; need at least 60. Try a larger interval.`);
      const f: Fetched = { bars, meta, dataSymbol: sym };
      HISTORY.set(key, { at: now(), f }); MERGED.set(key, { at: now(), f });
      return f;
    }
    if (opts.fresh === false || hist.f.dataSymbol !== sym) return (merged ?? hist).f;
    try {
      const { bars: tail, meta } = await downloadChart(sym, interval, iv.tail, opts.background);
      const f: Fetched = { ...hist.f, bars: mergeBars(hist.f.bars, tail), meta };
      MERGED.set(key, { at: now(), f });
      return f;
    } catch (e) {
      if (merged) return merged.f;   // keep serving the last good frame rather than failing a live refresh
      throw e;
    }
  })();
  INFLIGHT.set(key, p);
  try { return await p; } finally { INFLIGHT.delete(key); }
}

/** Many symbols at once for the scanners (background priority, failures reported not thrown). */
export async function fetchMany(symbols: string[], interval: string, range: string, onProgress?: (done: number, total: number) => void) {
  const out = new Map<string, Bars>(), missing: string[] = [];
  let done = 0;
  await Promise.all(symbols.map(async (s) => {
    try { out.set(s, (await fetchBars(s, interval, { range, background: true })).bars); }
    catch { missing.push(s); }
    onProgress?.(++done, symbols.length);
  }));
  return { frames: out, missing };
}

/** True while the last bar has not closed (intraday: until bar + interval; daily: until 15:30 IST). */
export function barIsForming(symbol: string, interval: string, lastBar: number, nowS = now()): boolean {
  const sec = INTERVALS[interval]?.seconds ?? 86400;
  if (sec < 86400) return nowS < lastBar + sec;
  const lastDay = lastBar + (sec >= 604800 ? 4 * 86400 : 0);
  if (isIndian(symbol)) {
    const d = new Date(lastDay * 1000);
    return nowS < Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 10, 0) / 1000;
  }
  return nowS < lastDay + 86400;
}

export interface SearchHit { symbol: string; name: string; exchange: string; type: string }
export async function searchSymbols(query: string, limit = 10): Promise<SearchHit[]> {
  const q = query.trim();
  if (!q) return [];
  const hits: SearchHit[] = [];
  if (ALIASES[q.toUpperCase()]) hits.push({ symbol: ALIASES[q.toUpperCase()], name: q.toUpperCase(), exchange: 'INDEX/ALIAS', type: 'alias' });
  try {
    const j = await getJson(`/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=${limit * 3}&newsCount=0`);
    for (const r of j?.quotes ?? []) {
      if (r.exchange !== 'NSI' && r.exchange !== 'BSE') continue;
      hits.push({ symbol: r.symbol, name: r.shortname || r.longname || '', exchange: r.exchange === 'NSI' ? 'NSE' : 'BSE', type: r.quoteType || '' });
    }
  } catch { /* best effort */ }
  return hits.slice(0, limit);
}

export function clearCache() { HISTORY.clear(); MERGED.clear(); }
