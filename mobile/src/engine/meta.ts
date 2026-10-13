/**
 * Market cap + sector per symbol (sizes and groups the market-map tiles).  Yahoo's quote endpoint needs a
 * session cookie and a "crumb"; one batched request then answers up to QUOTE_BATCH symbols.  Results are
 * kept for META_TTL in the injected key-value store, so the map normally never waits for them.
 */
import { NET } from './net';
import { SECTORS } from './universe';

export interface KV {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}
export interface SymbolMeta { market_cap: number | null; sector: string | null; name?: string | null; at: number }

const META_TTL = 86400, QUOTE_BATCH = 40, KV_KEY = 'screener_meta';
const UA = { 'User-Agent': 'Mozilla/5.0' };
let crumb: string | null = null;
let cookie = '';             // only used where fetch has no cookie jar (Node tests); the phone's native jar keeps it
let META: Record<string, SymbolMeta> | null = null;
let pending: Promise<void> | null = null;

async function getCrumb(force = false): Promise<string> {
  if (crumb && !force) return crumb;
  const headers = () => ({ ...UA, ...(cookie ? { Cookie: cookie } : {}) });
  let r = await fetch(`${NET.query[0]}/v1/test/getcrumb`, { headers: headers() });
  let text = r.ok ? await r.text() : '';
  if (!text || text.includes('<') || text.length > 40) {
    try {
      const r1 = await fetch(NET.cookie, { headers: UA });
      const set = (r1.headers as any).getSetCookie?.() as string[] | undefined;
      if (set?.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
    } catch { /* the 404 page still sets the cookie */ }
    r = await fetch(`${NET.query[0]}/v1/test/getcrumb`, { headers: headers() });
    text = r.ok ? await r.text() : '';
  }
  if (!text || text.includes('<')) throw new Error('Yahoo did not issue a crumb');
  crumb = text.trim();
  return crumb;
}

async function quoteBatch(symbols: string[]): Promise<Record<string, SymbolMeta>> {
  const out: Record<string, SymbolMeta> = {};
  for (let attempt = 0; attempt < 2; attempt++) {
    const c = await getCrumb(attempt > 0);
    const url = `${NET.query[0]}/v7/finance/quote?symbols=${symbols.map(encodeURIComponent).join(',')}&fields=marketCap,sector,shortName,longName&crumb=${encodeURIComponent(c)}`;
    const r = await fetch(url, { headers: { ...UA, ...(cookie ? { Cookie: cookie } : {}) } });
    if (r.status === 401 || r.status === 403) continue;
    const j = await r.json();
    const at = Date.now() / 1000;
    for (const q of j?.quoteResponse?.result ?? []) {
      out[q.symbol] = { market_cap: q.marketCap > 0 ? q.marketCap : null, sector: q.sector || null, name: q.longName || q.shortName || null, at };
    }
    return out;
  }
  return out;
}

async function load(kv: KV) {
  if (META) return META;
  try { META = JSON.parse((await kv.get(KV_KEY)) || '{}'); } catch { META = {}; }
  return META!;
}

/** Start a background refresh for symbols with no (or day-old) data.  Returns true while one is running. */
export async function ensureMeta(kv: KV, symbols: string[]): Promise<boolean> {
  const meta = await load(kv);
  if (pending) return true;
  const now = Date.now() / 1000;
  const stale = symbols.filter((s) => !meta[s] || now - meta[s].at > META_TTL);
  if (!stale.length) return false;
  pending = (async () => {
    for (let i = 0; i < stale.length; i += QUOTE_BATCH) {
      try {
        const got = await quoteBatch(stale.slice(i, i + QUOTE_BATCH));
        for (const [s, m] of Object.entries(got)) {
          const old = meta[s];
          // keep an older good value if this attempt came back empty (Yahoo hiccups are common)
          meta[s] = { ...m, market_cap: m.market_cap ?? old?.market_cap ?? null, sector: m.sector ?? old?.sector ?? null };
        }
      } catch { /* try again on the next scan */ }
    }
    await kv.set(KV_KEY, JSON.stringify(meta));
  })().finally(() => { pending = null; });
  return true;
}

export const metaPending = () => pending;

/** Attach market cap and sector (built-in sector map first, then Yahoo's). */
export function decorate<T extends { symbol: string; name: string; via?: string | null }>(rows: T[]): (T & { market_cap: number | null; sector: string })[] {
  const meta = META ?? {};
  return rows.map((r) => {
    const m = meta[r.via || r.symbol];
    return { ...r, market_cap: m?.market_cap ?? null, sector: SECTORS[r.name] || m?.sector || 'Other' };
  });
}
