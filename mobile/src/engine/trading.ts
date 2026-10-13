/**
 * Port of app/trading.py: Groww's fee schedule, the level-based trade plan and the paper-trading ledger.
 *
 * Orders behave like a broker's order panel:
 *  - BUY / SELL, product Intraday (MIS: must be squared off, short-selling allowed) or Delivery
 *    ("overnight" = CNC: STT both sides, DP charge on the sell, no short-selling);
 *  - Market (fills now at the last price plus slippage), Limit (waits for the price), SL (a trigger that
 *    becomes a market order);
 *  - an optional stop-loss and target attached to the position (checkTrades watches them);
 *  - a SELL against a long position exits it; a SELL with nothing held opens an intraday short; a BUY
 *    against a short covers it;
 *  - intraday positions still open at the broker's square-off time are closed with the square-off charge.
 *
 * Storage is injected (TradeStore); prices / bars are injected (getPrice / getBars) or passed explicitly.
 * Every number that Python rounds is rounded here with Python's round() semantics (half-even on the exact
 * binary value) and every Python sum() uses Python 3.12+'s compensated summation, so fees match to the paisa.
 * Pure TypeScript - no React Native / Node imports (runs on Hermes).
 */
import { Bars, DataError, IST_OFFSET_S } from './types';

// ---------------------------------------------------------------- Python-compatible numerics
/** Digits of |x| rounded half-even to `d` decimals (Python's round / format semantics on the exact double). */
function fixedHalfEven(a: number, d: number): string {
  const s = a.toFixed(d);
  const extra = 30;
  const long = a.toFixed(Math.min(100, d + extra));
  const tail = long.slice(long.length - extra);
  if (/^50*$/.test(tail)) {
    // exact tie: toFixed rounded up; Python rounds to even
    let trunc = long.slice(0, long.length - extra);
    if (trunc.endsWith('.')) trunc = trunc.slice(0, -1);
    const lastDigit = Number(trunc[trunc.length - 1]);
    if (lastDigit % 2 === 0) return trunc;
  }
  return s;
}

/** Python's round(x, d). */
export function pyRound(x: number, d = 0): number {
  if (!Number.isFinite(x)) return x;
  if (d === 0) {
    const f = Math.floor(x), diff = x - f;
    if (diff === 0.5) return f % 2 === 0 ? f : f + 1;
    return diff < 0.5 ? f : f + 1;
  }
  if (Math.abs(x) >= 1e21) return x;
  const v = Number(fixedHalfEven(Math.abs(x), d));
  return x < 0 || Object.is(x, -0) ? -v : v;
}

/** Python's f"{x:.{d}f}" / f"{x:,.{d}f}". */
export function pyFormat(x: number, d: number, comma = false): string {
  if (Number.isNaN(x)) return 'nan';
  if (!Number.isFinite(x)) return x > 0 ? 'inf' : '-inf';
  const neg = x < 0 || Object.is(x, -0);
  let s = fixedHalfEven(Math.abs(x), d);
  if (comma) {
    const [i, f] = s.split('.');
    s = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (f !== undefined ? '.' + f : '');
  }
  return (neg ? '-' : '') + s;
}

/** Python 3.12+ sum() of floats (Neumaier compensated summation). */
export function pySum(xs: number[]): number {
  let hi = 0, lo = 0;
  for (const x of xs) {
    const t = hi + x;
    if (Math.abs(hi) >= Math.abs(x)) lo += (hi - t) + x;
    else lo += (x - t) + hi;
    hi = t;
  }
  if (lo && Number.isFinite(lo)) hi += lo;
  return hi;
}

/** Python truthiness (empty object / array are falsy, NaN is truthy). */
function truthy(x: unknown): boolean {
  if (x === null || x === undefined || x === false || x === 0 || x === '') return false;
  if (Array.isArray(x)) return x.length > 0;
  if (typeof x === 'object') return Object.keys(x as object).length > 0;
  return true;
}

// ---------------------------------------------------------------- time helpers (epoch ms, UTC)
const DAY_MS = 86400000;
const IST_MS = IST_OFFSET_S * 1000;
/** India cash session in UTC: 03:45-10:00 (09:15-15:30 IST). */
export const INDIA_SESSION_UTC: [[number, number], [number, number]] = [[3, 45], [10, 0]];
export const INTERVAL_SECONDS: Record<string, number> = { '1m': 60, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '1d': 86400, '1wk': 604800 };

export function intervalSeconds(interval: string): number {
  const s = INTERVAL_SECONDS[interval];
  if (s === undefined) throw new DataError(`Unsupported interval '${interval}'. Use one of ${pyList(Object.keys(INTERVAL_SECONDS))}`);
  return s;
}
const pyList = (xs: string[]) => '[' + xs.map((x) => `'${x}'`).join(', ') + ']';

/** Python's datetime.isoformat() for an aware UTC datetime. */
export function isoUtc(ms: number): string {
  const s = new Date(ms).toISOString(); // YYYY-MM-DDTHH:MM:SS.mmmZ
  const frac = s.slice(20, 23);
  return s.slice(0, 19) + (frac === '000' ? '' : '.' + frac + '000') + '+00:00';
}
/** db.now_iso(): UTC, whole seconds. */
export const nowIso = (ms: number) => isoUtc(Math.floor(ms / 1000) * 1000);

/** datetime.fromisoformat(); a naive string is taken as UTC (like trading._aware). Returns epoch ms, or null. */
export function parseIso(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?)?\s*(Z|[+-]\d{2}:?\d{2}(?::?\d{2})?)?$/.exec(iso.trim());
  if (!m) throw new DataError(`Invalid isoformat string: '${iso}'`);
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0), m[7] ? Math.floor(Number((m[7] + '000000').slice(0, 6)) / 1000) : 0);
  let off = 0;
  if (m[8] && m[8] !== 'Z') {
    const sgn = m[8][0] === '-' ? -1 : 1;
    const digits = m[8].slice(1).replace(/:/g, '');
    off = sgn * ((+digits.slice(0, 2)) * 3600 + (+digits.slice(2, 4)) * 60 + (+(digits.slice(4, 6) || 0))) * 1000;
  }
  return ms - off;
}

/** Python weekday(): Monday = 0 (of the UTC date). */
const weekday = (ms: number) => (new Date(ms).getUTCDay() + 6) % 7;

function sessionUtc(ms: number): [number, number] {
  const d = Math.floor(ms / DAY_MS) * DAY_MS;
  const [[oh, om], [ch, cm]] = INDIA_SESSION_UTC;
  return [d + (oh * 60 + om) * 60000, d + (ch * 60 + cm) * 60000];
}
/** `hhmm` IST on the IST date of the instant `ms`, in UTC ms. */
function exitUtc(ms: number, hhmm: string): number {
  const [h, m] = hhmm.split(':').map((x) => parseInt(x, 10));
  const istMid = Math.floor((ms + IST_MS) / DAY_MS) * DAY_MS;
  return istMid + (h * 60 + m) * 60000 - IST_MS;
}
function nextWeekday(ms: number): number {
  let d = ms + DAY_MS;
  while (weekday(d) >= 5) d += DAY_MS;
  return d;
}

// ---------------------------------------------------------------- fees and settings
export interface Fees {
  broker: string;
  brokerage_pct: number; brokerage_cap: number; brokerage_min: number;
  stt_delivery_pct: number; stt_intraday_sell_pct: number;
  stamp_delivery_pct: number; stamp_intraday_pct: number;
  exchange_pct: number; sebi_pct: number; ipft_pct: number; gst_pct: number;
  dp_charge: number; dp_waive_below: number; auto_squareoff: number; slippage_pct: number;
  [k: string]: string | number;
}

/** Groww's published equity schedule (groww.in/pricing). Percentages are of the order value. */
export const GROWW_FEES: Fees = {
  broker: 'Groww',
  brokerage_pct: 0.1, brokerage_cap: 20.0, brokerage_min: 5.0,
  stt_delivery_pct: 0.1,
  stt_intraday_sell_pct: 0.025,
  stamp_delivery_pct: 0.015, stamp_intraday_pct: 0.003,
  exchange_pct: 0.00297,
  sebi_pct: 0.0001, ipft_pct: 0.0001,
  gst_pct: 18.0,
  dp_charge: 20.0, dp_waive_below: 100.0,
  auto_squareoff: 50.0,
  slippage_pct: 0.05,
};

export interface TradingSettings {
  capital: number; risk_pct: number; max_positions: number; allow_overnight: boolean; leverage: number;
  intraday_exit: string; squareoff_time: string; min_trade_value: number; max_cost_share: number;
  stop_atr: number; entry_zone_atr: number; max_level_atr: number; min_stop_pct: number; min_target_costs: number;
  fees: Fees;
}

export const DEFAULT_SETTINGS: TradingSettings = {
  capital: 10000.0, risk_pct: 2.0, max_positions: 2, allow_overnight: true, leverage: 1.0,
  intraday_exit: '15:10',
  squareoff_time: '15:20',
  min_trade_value: 2000.0,
  max_cost_share: 0.4,
  stop_atr: 0.4, entry_zone_atr: 0.35, max_level_atr: 4.0,
  min_stop_pct: 0.15,
  min_target_costs: 2.0,
  fees: GROWW_FEES,
};
const SETTING_TYPES: Record<string, 'float' | 'int' | 'bool' | 'str'> = {
  capital: 'float', risk_pct: 'float', max_positions: 'int', allow_overnight: 'bool', leverage: 'float', intraday_exit: 'str',
  squareoff_time: 'str', min_trade_value: 'float', max_cost_share: 'float', stop_atr: 'float', entry_zone_atr: 'float',
  max_level_atr: 'float', min_stop_pct: 'float', min_target_costs: 'float',
};
export const TICK = 0.05;
export const SIDES = ['BUY', 'SELL'] as const;
export const PRODUCTS = ['intraday', 'overnight'] as const;
export const ORDER_TYPES = ['market', 'limit', 'sl'] as const;

function pyFloat(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string' && /^\s*[+-]?(\d+\.?\d*(e[+-]?\d+)?|\.\d+(e[+-]?\d+)?|inf(inity)?|nan)\s*$/i.test(v)) {
    const t = v.trim().toLowerCase().replace(/^\+/, '');
    if (t.endsWith('inf') || t.endsWith('infinity')) return t.startsWith('-') ? -Infinity : Infinity;
    if (t.endsWith('nan')) return NaN;
    return Number(t);
  }
  throw new TypeError(`could not convert to float: ${JSON.stringify(v)}`);
}
function pyInt(v: unknown): number {
  if (typeof v === 'number') { if (!Number.isFinite(v)) throw new TypeError('cannot convert float to integer'); return Math.trunc(v); }
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string' && /^\s*[+-]?\d+\s*$/.test(v)) return parseInt(v, 10);
  throw new TypeError(`invalid literal for int(): ${JSON.stringify(v)}`);
}
const cloneSettings = (s: TradingSettings): TradingSettings => ({ ...s, fees: { ...s.fees } });

// ---------------------------------------------------------------- charges
export interface Charges {
  brokerage: number; stt: number; stamp: number; exchange: number; sebi: number; ipft: number; gst: number; dp: number; slippage: number; total: number;
  squareoff?: number;
}
export interface RoundTrip { buy: Charges; sell: Charges; total: number; pct_of_value: number; per_share: number }
export type OrderSide = 'buy' | 'sell';
export type Mode = 'intraday' | 'overnight';

const pct = (value: number, p: number) => value * p / 100.0;

/** Charges for one executed order of `value` rupees. */
export function orderCharges(value: number, side: OrderSide | string, mode: Mode | string, fees: Fees, dp = false): Charges {
  if (value <= 0) return { brokerage: 0, stt: 0, stamp: 0, exchange: 0, sebi: 0, ipft: 0, gst: 0, dp: 0, slippage: 0, total: 0 };
  const brokerage = Math.max(Math.min(fees.brokerage_cap, pct(value, fees.brokerage_pct)), fees.brokerage_min);
  let stt: number, stamp: number;
  if (mode === 'overnight') {
    stt = pct(value, fees.stt_delivery_pct);
    stamp = side === 'buy' ? pct(value, fees.stamp_delivery_pct) : 0.0;
  } else {
    stt = side === 'sell' ? pct(value, fees.stt_intraday_sell_pct) : 0.0;
    stamp = side === 'buy' ? pct(value, fees.stamp_intraday_pct) : 0.0;
  }
  const exchange = pct(value, fees.exchange_pct);
  const sebi = pct(value, fees.sebi_pct);
  const ipft = pct(value, fees.ipft_pct);
  const gst = pct(brokerage + exchange + sebi + ipft, fees.gst_pct);
  const dpCharge = dp && side === 'sell' && mode === 'overnight' && value >= fees.dp_waive_below ? fees.dp_charge * (1 + fees.gst_pct / 100) : 0.0;
  const slippage = pct(value, fees.slippage_pct);
  const items = [brokerage, stt, stamp, exchange, sebi, ipft, gst, dpCharge, slippage].map((v) => pyRound(v, 2));
  const [b, s, st, ex, se, ip, g, d, sl] = items;
  return { brokerage: b, stt: s, stamp: st, exchange: ex, sebi: se, ipft: ip, gst: g, dp: d, slippage: sl, total: pyRound(pySum(items), 2) };
}

/** Charges for opening and closing `qty` shares (slippage included as a cost). */
export function roundTrip(entry: number, exitPx: number, qty: number, mode: Mode | string, fees: Fees, short = false): RoundTrip {
  const [openSide, closeSide]: OrderSide[] = short ? ['sell', 'buy'] : ['buy', 'sell'];
  const buy = orderCharges(entry * qty, openSide, mode, fees);
  const sell = orderCharges(exitPx * qty, closeSide, mode, fees, !short);
  const total = pyRound(buy.total + sell.total, 2);
  const value = entry * qty;
  return { buy, sell, total, pct_of_value: value ? pyRound(total / value * 100, 3) : 0.0, per_share: qty ? pyRound(total / qty, 4) : 0.0 };
}

/** Ledger charges: slippage is already inside the paper fill price, so it is not charged again. */
export function ledgerCharges(value: number, side: OrderSide | string, mode: Mode | string, fees: Fees, dp = false): Charges {
  const c = orderCharges(value, side, mode, fees, dp);
  c.total = pyRound(c.total - c.slippage, 2);
  c.slippage = 0.0;
  return c;
}

// ---------------------------------------------------------------- sessions and deadlines
export interface Deadline { deadline: string; bars: number; label: string }
export interface Deadlines { intraday: Deadline | null; overnight: Deadline }

/** Exit deadline and the number of bars until it for each mode. `now` is epoch ms (or a Date). */
export function deadlines(now: number | Date, sec: number, exitHhmm: string, horizon: number): Deadlines {
  const n = +now;
  if (sec >= 86400) {
    const days = Math.max(1, horizon);
    let d = n;
    for (let i = 0; i < days; i++) d = nextWeekday(d);
    const end = sessionUtc(d)[1];
    return { intraday: null, overnight: { deadline: isoUtc(end), bars: days, label: `close in ${days} session${days > 1 ? 's' : ''}` } };
  }
  const [openT] = sessionUtc(n);
  const exitToday = exitUtc(n, exitHhmm);
  const sessionBars = Math.max(1, Math.floor((exitToday - openT) / 1000 / sec));
  let intraday: Deadline, overnight: Deadline;
  if (weekday(n) < 5 && n < exitToday - 2 * sec * 1000) {
    const barsToday = Math.max(1, Math.floor((exitToday - Math.max(n, openT)) / 1000 / sec));
    intraday = { deadline: isoUtc(exitToday), bars: barsToday, label: 'today ' + exitHhmm + ' IST' };
    const nxt = nextWeekday(n);
    overnight = { deadline: isoUtc(exitUtc(nxt, exitHhmm)), bars: barsToday + sessionBars, label: 'next session ' + exitHhmm + ' IST' };
  } else {
    const nxt = weekday(n) >= 5 || n >= exitToday - 2 * sec * 1000 ? nextWeekday(n) : n;
    intraday = { deadline: isoUtc(exitUtc(nxt, exitHhmm)), bars: sessionBars, label: 'next session ' + exitHhmm + ' IST' };
    const nxt2 = nextWeekday(nxt);
    overnight = { deadline: isoUtc(exitUtc(nxt2, exitHhmm)), bars: 2 * sessionBars, label: 'session after next ' + exitHhmm + ' IST' };
  }
  return { intraday, overnight };
}

/** The broker square-off (epoch ms) that applies to an intraday position opened at `entryTime`. */
export function squareoffUtc(entryTime: number | Date, hhmm: string): number {
  const e = +entryTime;
  let so = exitUtc(e, hhmm);
  if (e >= so || weekday(e) >= 5) so = exitUtc(nextWeekday(e), hhmm);
  return so;
}

// ---------------------------------------------------------------- barrier statistics
export interface BarrierProb { target: number; stop: number; time: number; n: number; end_up_rate: number; tilted?: boolean }
export type MaybeProb = BarrierProb | Record<string, never>;
const hasProb = (p: MaybeProb): p is BarrierProb => 'target' in p;

/** How often, from a random past bar, price rose `u` (fraction) before falling `d` within `horizon` bars,
 *  fell first, or did neither. A bar that touches both counts as a stop. Returns {} when too little history. */
export function barrierRates(bars: Bars, u: number, d: number, horizon: number, n = 1500): MaybeProb {
  const H = Math.max(1, Math.trunc(horizon));
  const c = bars.c.slice(-(n + H)), h = bars.h.slice(-(n + H)), l = bars.l.slice(-(n + H));
  const N = c.length - H;
  if (N < 40) return {};
  const hitUp = new Uint8Array(N), hitDn = new Uint8Array(N), still = new Uint8Array(N).fill(1);
  for (let k = 1; k <= H; k++) {
    for (let i = 0; i < N; i++) {
      if (!still[i]) continue;
      const up = h[k + i] / c[i] - 1 >= u;
      const dn = l[k + i] / c[i] - 1 <= -d;
      if (dn) hitDn[i] = 1;
      if (up && !dn) hitUp[i] = 1;
      if (up || dn) still[i] = 0;
    }
  }
  let nu = 0, nd = 0, ns = 0, ne = 0;
  for (let i = 0; i < N; i++) { nu += hitUp[i]; nd += hitDn[i]; ns += still[i]; if (c[H + i] > c[i]) ne++; }
  return { target: nu / N, stop: nd / N, time: ns / N, n: N, end_up_rate: ne / N };
}

/** Scale the historical barrier rates by today's calibrated forecast relative to the chart's base up-rate. */
export function tilt(base: MaybeProb, pUp: number | null | undefined, upRate: number | null | undefined): MaybeProb {
  if (!hasProb(base)) return {};
  if (pUp == null || upRate == null || !(0.05 < upRate && upRate < 0.95)) return { ...base, tilted: false };
  const t = base.target * Math.min(2.0, Math.max(0.5, pUp / upRate));
  const s = base.stop * Math.min(2.0, Math.max(0.5, (1 - pUp) / (1 - upRate)));
  const tot = t + s + base.time;
  return { ...base, target: t / tot, stop: s / tot, time: base.time / tot, tilted: true };
}

// ---------------------------------------------------------------- planning
type Num = number | null | undefined;
export interface AnalysisSummary {
  atr?: Num;
  pivots?: Record<string, any> | null; cpr?: Record<string, any> | null; camarilla?: Record<string, any> | null;
  vwap_bands?: Record<string, any> | null; value_area?: Record<string, any> | null;
  learner?: { available?: boolean; up_rate?: Num; [k: string]: any } | null;
  [k: string]: any;
}
/** The analysis result fields the plan reads (same names as the Python analysis dict). */
export interface PlanInput {
  symbol: string; interval: string; price_at: number; prob_up: number; direction: string; horizon_bars: number;
  summary: AnalysisSummary; signals?: { key: string; values?: Record<string, any> | null; [k: string]: any }[] | null;
  data_symbol?: string | null;
  [k: string]: any;
}
export type Level = [string, number];

export function planLevels(summary: AnalysisSummary, signals: PlanInput['signals'], price: number): [Level[], Level[]] {
  const pv = summary.pivots || {}, cpr = summary.cpr || {}, cam = summary.camarilla || {};
  const vb = summary.vwap_bands || {}, va = summary.value_area || {};
  const srSig = (signals || []).find((s) => s.key === 'support_resistance');
  const sr = (srSig && srSig.values) || {};
  const cand: [string, any][] = [['pivot', pv.pivot], ['S1', pv.s1], ['S2', pv.s2], ['S3', pv.s3],
    ['R1', pv.r1], ['R2', pv.r2], ['R3', pv.r3],
    ['CPR bottom', cpr.bc], ['CPR top', cpr.tc],
    ['Camarilla L3', cam.l3], ['Camarilla L4', cam.l4], ['Camarilla H3', cam.h3], ['Camarilla H4', cam.h4],
    ['VWAP', vb.vwap], ['VWAP -1sd', vb.lower1], ['VWAP -2sd', vb.lower2], ['VWAP +1sd', vb.upper1], ['VWAP +2sd', vb.upper2],
    ['value area low', va.val], ['POC', va.poc], ['value area high', va.vah],
    ['swing support', sr.support], ['swing resistance', sr.resistance],
    ['previous session low', pv.ref_low], ['previous session high', pv.ref_high]];
  const ok: Level[] = cand.filter(([, v]) => typeof v === 'number' && Number.isFinite(v) && v > 0).map(([nm, v]) => [nm, v as number]);
  const supports = ok.filter(([, v]) => v <= price).sort((a, b) => b[1] - a[1]);
  const resistances = ok.filter(([, v]) => v > price).sort((a, b) => a[1] - b[1]);
  return [supports, resistances];
}

/** Round to the NSE tick (0.05). */
export function tick(x: number): number {
  return pyRound(pyRound(x / TICK) * TICK, 2);
}

export interface PlanOption {
  mode: Mode; target: number; target_name: string; deadline: string; deadline_label: string; bars: number; prob: MaybeProb;
  charges: RoundTrip; charges_loss: number; charges_flat: number; net_win: number; net_loss: number; net_flat: number;
  expectancy: number | null; rr: number; breakeven_pct: number;
}
export interface TradePlan {
  available: boolean; reason?: string; verdict?: 'trade' | 'wait' | 'no trade'; reasons?: string[];
  side?: 'BUY' | 'SELL'; long?: boolean; entry_type?: 'market' | 'limit'; entry?: number; level?: number; level_name?: string;
  stop?: number; risk_per_share?: number; qty?: number; qty_affordable?: number; value?: number; risk_rupees?: number;
  risk_budget?: number; cash?: number; cost_share?: number; cost_pct?: number; best?: PlanOption; options?: PlanOption[];
  supports?: Level[]; resistances?: Level[]; atr?: number; price?: number;
  settings?: Pick<TradingSettings, 'capital' | 'risk_pct' | 'max_positions' | 'allow_overnight' | 'leverage' | 'intraday_exit'>;
  fees?: string;
}

// ---------------------------------------------------------------- storage
/** Raw `trades` row: exactly the SQLite columns. */
export interface TradeRow {
  id: number; symbol: string; interval: string; mode: string; side: string; status: string; created_at: string; qty: number;
  entry_type: string; entry_price: number; trigger: number | null; fill_price: number | null; entry_time: string | null;
  stop: number; target: number; deadline: string; exit_price: number | null; exit_time: string | null; exit_reason: string | null;
  gross_pnl: number | null; charges: number | null; net_pnl: number | null; charges_json: string | null; plan_json: string | null;
  prediction_id: number | null; note: string | null;
}
/** Columns trading.ts inserts (db.insert_trade); the others start NULL. */
export const TRADE_INSERT_COLUMNS = ['symbol', 'interval', 'mode', 'side', 'status', 'created_at', 'qty', 'entry_type', 'entry_price', 'trigger',
  'fill_price', 'entry_time', 'stop', 'target', 'deadline', 'charges_json', 'plan_json', 'prediction_id', 'note'] as const;
export type NewTradeRow = Partial<Omit<TradeRow, 'id'>>;
/** Columns a user edit may change (db.TRADE_EDITABLE). */
export const TRADE_EDITABLE = ['qty', 'stop', 'target', 'deadline', 'charges_json', 'note', 'trigger', 'entry_price'] as const;
export type TradeStatus = 'pending' | 'open' | 'closed' | 'cancelled';

/**
 * Persistence used by the ledger. An expo-sqlite implementation runs TRADES_SCHEMA_SQL once and maps:
 *  - listTrades:  SELECT * FROM trades [WHERE status=?] ORDER BY created_at DESC, id DESC LIMIT ?
 *  - getTrade:    SELECT * FROM trades WHERE id=?
 *  - insertTrade: INSERT INTO trades (<the keys of `row` / TRADE_INSERT_COLUMNS>) VALUES (...) -> lastInsertRowId
 *  - updateTrade: UPDATE trades SET k=? ... WHERE id=?   (raw columns; no whitelist - trading.ts decides what to write)
 *  - getSetting:  SELECT value FROM settings WHERE key=?  -> JSON.parse(value), or null
 *  - setSetting:  INSERT OR REPLACE INTO settings (key, value) VALUES (?, JSON.stringify(value))
 * Rows are returned as plain objects with the column names (what expo-sqlite's getAllAsync returns).
 */
export interface TradeStore {
  listTrades(status?: string | null, limit?: number): Promise<TradeRow[]>;
  getTrade(id: number): Promise<TradeRow | null>;
  insertTrade(row: NewTradeRow): Promise<number>;
  updateTrade(id: number, patch: Partial<Omit<TradeRow, 'id'>>): Promise<void>;
  getSetting(key: string): Promise<any>;
  setSetting(key: string, value: any): Promise<void>;
}

/** CREATE statements mirroring app/db.py (trades + settings). */
export const TRADES_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    interval TEXT NOT NULL,
    mode TEXT NOT NULL,
    side TEXT NOT NULL DEFAULT 'long',
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    qty INTEGER NOT NULL,
    entry_type TEXT NOT NULL,
    entry_price REAL NOT NULL,
    trigger REAL,
    fill_price REAL,
    entry_time TEXT,
    stop REAL NOT NULL,
    target REAL NOT NULL,
    deadline TEXT NOT NULL,
    exit_price REAL,
    exit_time TEXT,
    exit_reason TEXT,
    gross_pnl REAL,
    charges REAL,
    net_pnl REAL,
    charges_json TEXT,
    plan_json TEXT,
    prediction_id INTEGER,
    note TEXT
);
CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
`;

const ROW_COLUMNS: (keyof TradeRow)[] = ['id', 'symbol', 'interval', 'mode', 'side', 'status', 'created_at', 'qty', 'entry_type', 'entry_price', 'trigger',
  'fill_price', 'entry_time', 'stop', 'target', 'deadline', 'exit_price', 'exit_time', 'exit_reason', 'gross_pnl', 'charges', 'net_pnl',
  'charges_json', 'plan_json', 'prediction_id', 'note'];

/** In-memory TradeStore (tests, previews). Same ordering and NULL defaults as the SQLite tables. */
export class MemoryTradeStore implements TradeStore {
  rows: TradeRow[] = [];
  settings = new Map<string, string>();
  private nextId = 1;
  /** Load existing rows (e.g. a backup / test fixture); ids are kept and AUTOINCREMENT continues after the largest. */
  seed(rows: TradeRow[]): void {
    for (const r of rows) this.rows.push({ ...r });
    this.nextId = Math.max(this.nextId, ...this.rows.map((r) => r.id + 1));
  }
  async listTrades(status?: string | null, limit = 500): Promise<TradeRow[]> {
    const rows = this.rows.filter((r) => !status || r.status === status);
    rows.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : b.id - a.id));
    return rows.slice(0, limit).map((r) => ({ ...r }));
  }
  async getTrade(id: number): Promise<TradeRow | null> {
    const r = this.rows.find((x) => x.id === id);
    return r ? { ...r } : null;
  }
  async insertTrade(row: NewTradeRow): Promise<number> {
    const r = {} as any;
    for (const c of ROW_COLUMNS) r[c] = null;
    for (const c of TRADE_INSERT_COLUMNS) r[c] = (row as any)[c] ?? null;
    if (r.side == null) r.side = 'long';
    r.id = this.nextId++;
    this.rows.push(r as TradeRow);
    return r.id;
  }
  async updateTrade(id: number, patch: Partial<Omit<TradeRow, 'id'>>): Promise<void> {
    const r = this.rows.find((x) => x.id === id);
    if (r) Object.assign(r, patch);
  }
  async getSetting(key: string): Promise<any> {
    const v = this.settings.get(key);
    return v === undefined ? null : JSON.parse(v);
  }
  async setSetting(key: string, value: any): Promise<void> {
    this.settings.set(key, JSON.stringify(value));
  }
}

/** A trade as the API returns it (db._trade_row): the row plus decoded JSON, 0/'' mapped to null. */
export interface Trade extends Omit<TradeRow, 'stop' | 'target' | 'deadline'> {
  stop: number | null; target: number | null; deadline: string | null;
  plan: any; charges_detail: Record<string, any>;
  // added by portfolio() for open positions
  last_price?: number; unrealised?: number; unrealised_pct?: number; progress?: number | null; squareoff?: string | null;
}
export function tradeFromRow(r: TradeRow | null): Trade | null {
  if (!r) return null;
  return {
    ...r,
    plan: r.plan_json ? JSON.parse(r.plan_json) : null,
    charges_detail: r.charges_json ? JSON.parse(r.charges_json) : {},
    stop: r.stop || null, target: r.target || null, deadline: r.deadline || null, side: r.side || 'long',
  };
}

// ---------------------------------------------------------------- ledger helpers
function entryTotal(t: Trade): number {
  const d = t.charges_detail || {};
  const e = truthy(d.entry) ? d.entry : truthy(d.buy) ? d.buy : {};
  return Number(e.total ?? 0);
}
const isLong = (t: { side?: string | null }) => (t.side || 'long') !== 'short';
function slip(price: number, buying: boolean, fees: Fees): number {
  return buying ? tick(price * (1 + fees.slippage_pct / 100)) : tick(price * (1 - fees.slippage_pct / 100));
}
/** Python `a < b` ordering for the sort keys used here (strings). */
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export interface TradingContext {
  store: TradeStore;
  /** Last traded price (Python: last close of fetch_ohlcv(symbol, interval)). */
  getPrice?: (symbol: string, interval: string) => Promise<number>;
  /** Completed + forming bars, oldest first (Python: fetch_ohlcv). Needed by checkTrades and buildPlan without explicit bars. */
  getBars?: (symbol: string, interval: string) => Promise<Bars>;
  /** Clock (defaults to Date.now). */
  now?: () => number | Date;
}

export interface OrderRequest {
  symbol: string; side: string; product?: string | null; order_type?: string | null; qty: number;
  price?: number | null; trigger?: number | null; live_price?: number | null; interval?: string;
  stop?: number | null; target?: number | null; deadline?: string | null; plan?: any; prediction_id?: number | null;
}
export interface OrderPreview {
  errors: string[]; notes: string[]; action?: 'open_long' | 'open_short' | 'close_long' | 'cover_short' | 'invalid'; side?: string;
  product?: string; order_type?: string; qty?: number; ltp: number | null; ref_price?: number; value?: number; margin?: number; cash?: number;
  cash_after?: number; charges?: Charges; round_trip?: RoundTrip | null; breakeven_pct?: number | null; held?: number; shorted?: number;
  squareoff?: string | null;
}
export interface CheckResult {
  filled: { id: number; fill: number }[];
  closed: { id: number; reason: string; net_pnl?: number | null }[];
  errors: { id: number; error: string }[];
}
export interface PortfolioStats {
  trades: number; open: number; pending: number; net_pnl: number; gross_pnl: number; charges: number; win_rate: number | null;
  profit_factor: number | null; expectancy: number | null; avg_win: number | null; avg_loss: number | null; max_drawdown_pct: number; return_pct: number | null;
}
export interface Portfolio {
  settings: TradingSettings; capital: number; cash: number; invested: number; unrealised: number; equity: number;
  open: Trade[]; pending: Trade[]; closed: Trade[]; stats: PortfolioStats; equity_curve: { time: string | null; equity: number }[];
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The paper-trading ledger over an injected store / price feed (the functions of trading.py that touch the db). */
export class PaperTrader {
  constructor(public ctx: TradingContext) {}

  private nowMs(): number {
    return this.ctx.now ? +this.ctx.now() : Date.now();
  }
  private async fetchLast(symbol: string, interval: string): Promise<number> {
    if (this.ctx.getPrice) return Number(await this.ctx.getPrice(symbol, interval));
    if (this.ctx.getBars) { const b = await this.ctx.getBars(symbol, interval); return Number(b.c[b.c.length - 1]); }
    throw new DataError('no price feed configured');
  }
  async listTrades(status?: string | null, limit = 500): Promise<Trade[]> {
    return (await this.ctx.store.listTrades(status, limit)).map((r) => tradeFromRow(r) as Trade);
  }
  async getTrade(id: number): Promise<Trade | null> {
    return tradeFromRow(await this.ctx.store.getTrade(id));
  }
  /** db.update_trade: only TRADE_EDITABLE columns. */
  async updateTrade(id: number, fields: Record<string, any>): Promise<void> {
    const f: Record<string, any> = {};
    for (const k of Object.keys(fields)) if ((TRADE_EDITABLE as readonly string[]).includes(k)) f[k] = fields[k];
    if (Object.keys(f).length) await this.ctx.store.updateTrade(id, f);
  }
  private async fillTrade(id: number, fill: number, entryTime: string, chargesJson: string) {
    await this.ctx.store.updateTrade(id, { status: 'open', fill_price: fill, entry_time: entryTime, charges_json: chargesJson });
  }
  private async storeClose(id: number, exitPrice: number, exitTime: string, reason: string, gross: number, charges: number, net: number, chargesJson: string) {
    await this.ctx.store.updateTrade(id, { status: 'closed', exit_price: exitPrice, exit_time: exitTime, exit_reason: reason, gross_pnl: gross, charges, net_pnl: net, charges_json: chargesJson });
  }
  /** db.cancel_trade: only pending / open rows. */
  async cancelTrade(id: number): Promise<void> {
    const r = await this.ctx.store.getTrade(id);
    if (r && (r.status === 'pending' || r.status === 'open')) await this.ctx.store.updateTrade(id, { status: 'cancelled', exit_time: nowIso(this.nowMs()), exit_reason: 'cancelled' });
  }

  // ------------------------------------------------ settings
  async getSettings(): Promise<TradingSettings> {
    const saved = (await this.ctx.store.getSetting('trading')) || {};
    const out: any = cloneSettings(DEFAULT_SETTINGS);
    for (const [k, v] of Object.entries(saved)) {
      if (k === 'fees' && v && typeof v === 'object' && !Array.isArray(v)) Object.assign(out.fees, v);
      else if (k in out) out[k] = v;
    }
    return out;
  }
  async saveSettings(patch: Record<string, any>): Promise<TradingSettings> {
    const cur: any = await this.getSettings();
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'fees' && v && typeof v === 'object' && !Array.isArray(v)) {
        for (const [fk, fv] of Object.entries(v)) if (fk in cur.fees) cur.fees[fk] = fk === 'broker' ? fv : pyFloat(fv);
      } else if (k in DEFAULT_SETTINGS && k !== 'fees') {
        const ty = SETTING_TYPES[k];
        cur[k] = ty === 'bool' ? truthy(v) : ty === 'int' ? pyInt(v) : ty === 'float' ? pyFloat(v) : String(v);
      }
    }
    await this.ctx.store.setSetting('trading', cur);
    return cur;
  }
  async resetSettings(): Promise<TradingSettings> {
    await this.ctx.store.setSetting('trading', {});
    return this.getSettings();
  }

  // ------------------------------------------------ positions and cash
  /** Capital plus realised P&L, minus the value tied up in open positions (shorts block the same margin) and pending orders. */
  async portfolioCash(settings?: TradingSettings): Promise<number> {
    const st = settings || (await this.getSettings());
    let cash = Number(st.capital);
    for (const t of await this.listTrades()) {
      if (t.status === 'closed') cash += Number(t.net_pnl || 0);
      else if (t.status === 'open') cash -= Number(t.fill_price) * t.qty + entryTotal(t);
      else if (t.status === 'pending') cash -= Number(t.entry_price) * t.qty;
    }
    return cash;
  }
  async openPositions(symbol?: string | null): Promise<Trade[]> {
    const rows = (await this.listTrades('open')).filter((t) => !symbol || t.symbol === symbol);
    return rows.sort((a, b) => cmp(a.entry_time || a.created_at, b.entry_time || b.created_at));
  }
  private async openCount(): Promise<number> {
    return (await this.ctx.store.listTrades('open')).length + (await this.ctx.store.listTrades('pending')).length;
  }

  // ------------------------------------------------ plan
  /** Turn an analysis result into a costed trade plan in the direction of the call. Never throws. */
  async buildPlan(result: PlanInput, opts: { bars?: Bars; settings?: TradingSettings; now?: number | Date } = {}): Promise<TradePlan> {
    try {
      const st = opts.settings || (await this.getSettings());
      const fees = st.fees;
      const now = opts.now != null ? +opts.now : this.nowMs();
      const { symbol, interval } = result;
      const sec = intervalSeconds(interval);
      const summary = result.summary, signals = result.signals || [];
      const price = Number(result.price_at);
      const atr = Number(summary.atr || price * 0.01);
      const bars = opts.bars || (this.ctx.getBars ? await this.ctx.getBars(result.data_symbol || symbol, interval) : null);
      if (!bars) throw new DataError('no bars for the plan');
      const learner = summary.learner || {};
      const pUp = Number(result.prob_up);
      const upRate = learner.available ? (learner.up_rate ?? null) : null;
      const direction = result.direction;
      const long = direction === 'UP' || (direction === 'SIDEWAYS' && pUp >= 0.5);
      const [supports, resistances] = planLevels(summary, signals, price);
      const supOut: Level[] = supports.slice(0, 6).map(([n, v]) => [n, pyRound(v, 2)]);
      const resOut: Level[] = resistances.slice(0, 6).map(([n, v]) => [n, pyRound(v, 2)]);
      if (!long && sec >= 86400) {
        return { available: false, side: 'SELL', long: false, supports: supOut, resistances: resOut,
          reason: 'The call is DOWN and cash delivery cannot short-sell (shorts are intraday only). Wait for an UP call or switch to an intraday chart.' };
      }
      const entryLevels = long ? supports.filter(([, v]) => price - v <= st.max_level_atr * atr) : resistances.filter(([, v]) => v - price <= st.max_level_atr * atr);
      if (!entryLevels.length) {
        return { available: false, side: long ? 'BUY' : 'SELL', long, supports: supOut, resistances: resOut,
          reason: `No ${long ? 'support' : 'resistance'} level within ${pyFormat(st.max_level_atr, 0)} ATR ${long ? 'below' : 'above'} the price - nothing to ${long ? 'buy' : 'sell'} against.` };
      }
      const [levelName, level] = entryLevels[0];
      const entryType: 'market' | 'limit' = Math.abs(price - level) <= st.entry_zone_atr * atr ? 'market' : 'limit';
      const entry = entryType === 'market' ? price : tick(level);
      const stop = long ? tick(Math.min(level - st.stop_atr * atr, entry * (1 - st.min_stop_pct / 100)))
        : tick(Math.max(level + st.stop_atr * atr, entry * (1 + st.min_stop_pct / 100)));
      const riskPs = Math.abs(entry - stop);
      if (riskPs <= 0) return { available: false, reason: 'Stop would not sit on the right side of the entry.', supports: supOut, resistances: resOut };
      const dls = deadlines(now, sec, st.intraday_exit, Math.trunc(Number(result.horizon_bars)));
      const cash = await this.portfolioCash(st);
      const riskAmount = st.capital * st.risk_pct / 100;
      const qtyRisk = Math.floor(riskAmount / riskPs);
      const qtyCash = entry > 0 ? Math.floor(cash * st.leverage / entry) : 0;
      const qty = Math.max(0, Math.min(qtyRisk, qtyCash));
      const qtyShown = Math.max(1, qty);
      const costPct = roundTrip(entry, entry, qtyShown, 'intraday', fees, !long).pct_of_value;
      const minMove = Math.max(0.8 * riskPs, entry * costPct / 100 * st.min_target_costs);
      const pool = long ? resistances : supports;
      const targets: Level[] = pool.filter(([, v]) => (long ? v - entry : entry - v) >= minMove).map(([n, v]) => [n, tick(v)]);
      if (!targets.length) {
        const nearest = pool.length ? pool[0] : null;
        return { available: false, side: long ? 'BUY' : 'SELL', long, supports: supOut, resistances: resOut,
          entry: pyRound(entry, 2), stop, qty: qtyShown, cost_pct: costPct,
          reason: `No ${long ? 'resistance' : 'support'} level far enough ${long ? 'above' : 'below'} ${pyFormat(entry, 2, true)} to pay for the trade: `
            + `the round trip costs ${pyFormat(costPct, 2)}% on ${qtyShown} shares, so the target must be at least ${pyFormat(minMove / entry * 100, 2)}% away; nearest is `
            + (nearest ? `${nearest[0]} at ${pyFormat(nearest[1], 2, true)} (${pyFormat(Math.abs(nearest[1] / entry - 1) * 100, 2)}%).` : 'none.') };
      }
      const modes: Mode[] = sec >= 86400 ? ['overnight'] : ['intraday', ...(long && st.allow_overnight ? (['overnight'] as Mode[]) : [])];
      const options: PlanOption[] = [];
      for (const mode of modes) {
        const dl = dls[mode];
        if (!dl) continue;
        for (const [tname, target] of targets.slice(0, 4)) {
          const move = Math.abs(target - entry);
          let prob: MaybeProb;
          if (long) {
            prob = tilt(barrierRates(bars, move / entry, riskPs / entry, dl.bars), pUp, upRate);
          } else {
            const raw = barrierRates(bars, riskPs / entry, move / entry, dl.bars);
            const base: MaybeProb = hasProb(raw) ? { ...raw, target: raw.stop, stop: raw.target } : {};
            prob = tilt(base, 1 - pUp, upRate == null ? null : 1 - upRate);
          }
          const winC = roundTrip(entry, target, qtyShown, mode, fees, !long);
          const lossC = roundTrip(entry, stop, qtyShown, mode, fees, !long);
          const flatC = roundTrip(entry, entry, qtyShown, mode, fees, !long);
          const netWin = qtyShown * move - winC.total;
          const netLoss = -qtyShown * riskPs - lossC.total;
          const netFlat = -flatC.total;
          const exp = hasProb(prob) ? prob.target * netWin + prob.stop * netLoss + prob.time * netFlat : null;
          options.push({ mode, target, target_name: tname, deadline: dl.deadline, deadline_label: dl.label,
            bars: dl.bars, prob, charges: winC, charges_loss: lossC.total, charges_flat: flatC.total,
            net_win: pyRound(netWin, 2), net_loss: pyRound(netLoss, 2), net_flat: pyRound(netFlat, 2),
            expectancy: exp === null ? null : pyRound(exp, 2),
            rr: pyRound((move - winC.per_share) / (riskPs + lossC.per_share), 2),
            breakeven_pct: pyRound(flatC.total / (qtyShown * entry) * 100, 3) });
        }
      }
      if (!options.length) return { available: false, reason: 'No exit window available.', supports: supOut, resistances: resOut };
      const key = (o: PlanOption) => -(o.expectancy !== null ? o.expectancy : -1e9);
      options.sort((a, b) => key(a) - key(b) || (a.mode !== 'intraday' ? 1 : 0) - (b.mode !== 'intraday' ? 1 : 0));
      const best = options[0];
      const value = qtyShown * entry;
      const grossWin = qtyShown * Math.abs(best.target - entry);
      const costShare = grossWin > 0 ? best.charges.total / grossWin : 1.0;
      const reasons: string[] = [];
      if (direction === 'SIDEWAYS') reasons.push('no validated edge right now (the model made no call)');
      if (qty < 1) {
        reasons.push(qtyCash < 1 ? `capital too small: 1 share costs ${pyFormat(entry, 2, true)}, cash ${pyFormat(cash, 0, true)}`
          : `risk budget ${pyFormat(riskAmount, 0, true)} covers no share with a ${pyFormat(riskPs, 2)} stop distance`);
      }
      if (best.expectancy !== null && best.expectancy <= 0) reasons.push('expected net profit is not positive after charges');
      if (costShare > st.max_cost_share) reasons.push(`charges would take ${pyFormat(costShare * 100, 0)}% of the expected gross profit (limit ${pyFormat(st.max_cost_share * 100, 0)}%)`);
      const minValue = Math.min(st.min_trade_value, st.capital * 0.5);
      if (value < minValue) reasons.push(`trade value ${pyFormat(value, 0, true)} is below the ${pyFormat(minValue, 0, true)} minimum`);
      const openN = await this.openCount();
      if (openN >= st.max_positions) reasons.push(`already ${openN} position(s) open or pending (limit ${st.max_positions})`);
      const verdict = reasons.length ? 'no trade' : entryType === 'limit' ? 'wait' : 'trade';
      return {
        available: true, verdict, reasons, side: long ? 'BUY' : 'SELL', long,
        entry_type: entryType, entry: pyRound(entry, 2), level: pyRound(level, 2), level_name: levelName,
        stop, risk_per_share: pyRound(riskPs, 2), qty: qtyShown, qty_affordable: qty, value: pyRound(value, 2),
        risk_rupees: pyRound(qtyShown * riskPs, 2), risk_budget: pyRound(riskAmount, 2), cash: pyRound(cash, 2),
        cost_share: pyRound(costShare, 3), best, options,
        supports: supOut, resistances: resOut,
        atr: pyRound(atr, 4), price: pyRound(price, 2),
        settings: { capital: st.capital, risk_pct: st.risk_pct, max_positions: st.max_positions, allow_overnight: st.allow_overnight, leverage: st.leverage, intraday_exit: st.intraday_exit },
        fees: fees.broker,
      };
    } catch (exc) {
      if (exc instanceof DataError) return { available: false, reason: exc.message };
      return { available: false, reason: `plan failed: ${errMsg(exc)}` };
    }
  }

  // ------------------------------------------------ orders
  /** What an order would do and cost, without placing it. Errors are returned, not thrown. */
  async previewOrder(req: OrderRequest): Promise<OrderPreview> {
    const st = await this.getSettings();
    const fees = st.fees;
    const errors: string[] = [], notes: string[] = [];
    const side = (req.side || '').toUpperCase();
    let product = (req.product || 'intraday').toLowerCase();
    const orderType = (req.order_type || 'market').toLowerCase();
    const { symbol, price, trigger } = req;
    if (!(SIDES as readonly string[]).includes(side)) errors.push('side must be BUY or SELL');
    if (!(PRODUCTS as readonly string[]).includes(product)) errors.push('product must be intraday or overnight');
    if (!(ORDER_TYPES as readonly string[]).includes(orderType)) errors.push('order type must be market, limit or sl');
    let qty = Math.trunc(Number(req.qty || 0));
    if (qty < 1) errors.push('quantity must be at least 1');
    let ltp: number;
    try {
      ltp = req.live_price ? Number(req.live_price) : await this.fetchLast(symbol, req.interval || '15m');
    } catch (exc) {
      return { errors: [`no price for ${symbol}: ${errMsg(exc)}`], notes: [], ltp: null };
    }
    if (orderType === 'limit' && !price) errors.push('a limit order needs a price');
    if (orderType === 'sl' && !trigger) errors.push('an SL order needs a trigger price');
    const ref = orderType === 'limit' && price ? Number(price) : orderType === 'sl' && trigger ? Number(trigger) : ltp;
    const positions = await this.openPositions(symbol);
    const longs = positions.filter((t) => isLong(t));
    const shorts = positions.filter((t) => !isLong(t));
    const held = longs.reduce((a, t) => a + t.qty, 0);
    const shorted = shorts.reduce((a, t) => a + t.qty, 0);
    let action: NonNullable<OrderPreview['action']>;
    if (side === 'BUY') action = shorted ? 'cover_short' : 'open_long';
    else action = held ? 'close_long' : product === 'intraday' ? 'open_short' : 'invalid';
    if (action === 'invalid') errors.push('delivery orders can only sell shares you hold; short-selling is intraday only');
    if (action === 'close_long' || action === 'cover_short') {
      const have = action === 'close_long' ? held : shorted;
      if (qty > have) { notes.push(`you hold ${have}; the order will close all ${have}`); qty = have; }
      const posMode = (longs.length ? longs : shorts)[0].mode;
      if (product !== posMode) notes.push(`position is ${posMode}; exit charges follow the position's product`);
      product = posMode;
    }
    const cash = await this.portfolioCash(st);
    const openN = await this.openCount();
    const chargesSide: OrderSide = side === 'BUY' ? 'buy' : 'sell';
    const entryCharges = orderCharges(ref * qty, chargesSide, product, fees, action === 'close_long');
    const opening = action === 'open_long' || action === 'open_short';
    const margin = opening ? ref * qty : 0.0;
    let rt: RoundTrip | null = null;
    if (opening) {
      if (margin > cash * st.leverage + 1e-9) errors.push(`insufficient cash: ${pyFormat(margin, 0, true)} needed, ${pyFormat(cash, 0, true)} available`);
      if (openN >= st.max_positions) errors.push(`position limit reached (${st.max_positions} open or pending)`);
      rt = roundTrip(ref, ref, qty, product, fees, action === 'open_short');
    }
    return { errors, notes, action, side, product, order_type: orderType, qty,
      ltp: pyRound(ltp, 2), ref_price: pyRound(ref, 2), value: pyRound(ref * qty, 2), margin: pyRound(margin, 2), cash: pyRound(cash, 2),
      cash_after: pyRound(cash - margin, 2), charges: entryCharges, round_trip: rt,
      breakeven_pct: rt ? rt.pct_of_value : null, held, shorted,
      squareoff: product === 'intraday' ? isoUtc(squareoffUtc(this.nowMs(), st.squareoff_time)) : null };
  }

  /** Place a paper order the way a broker panel would. Throws DataError when the preview has errors. */
  async placeOrder(req: OrderRequest): Promise<{ action: string; trades: Trade[]; notes: string[] }> {
    const interval = req.interval || '15m';
    const pv = await this.previewOrder({ ...req, interval });
    if (pv.errors.length) throw new DataError(pv.errors.join('; '));
    const st = await this.getSettings();
    const fees = st.fees;
    const now = this.nowMs();
    const action = pv.action!, qty = pv.qty!, product = pv.product!;
    const ltp = pv.ltp as number;
    const orderType = pv.order_type!;
    const { symbol, price, trigger, stop, target } = req;
    if (action === 'close_long' || action === 'cover_short') {
      const positions = (await this.openPositions(symbol)).filter((t) => isLong(t) === (action === 'close_long'));
      let remaining = qty;
      const out: Trade[] = [];
      for (const t of positions) {
        if (remaining <= 0) break;
        const q = Math.min(remaining, t.qty);
        if (orderType === 'market') {
          out.push(await this.closeQty(t, q, ltp, now, 'manual', fees));
        } else {
          const part = q < t.qty ? await this.split(t, q) : t;
          await this.updateTrade(part.id, orderType === 'limit' ? { target: Number(price) } : { stop: Number(trigger) });
          out.push((await this.getTrade(part.id))!);
        }
        remaining -= q;
      }
      return { action, trades: out, notes: pv.notes };
    }
    const long = action === 'open_long';
    const fill = orderType === 'market' ? slip(ltp, long, fees) : null;
    const entryPrice = orderType === 'limit' ? Number(price) : orderType === 'sl' ? Number(trigger) : fill;
    const row: NewTradeRow = {
      symbol, interval, mode: product, side: long ? 'long' : 'short',
      status: fill ? 'open' : 'pending', created_at: isoUtc(now), qty, entry_type: orderType,
      entry_price: entryPrice as number, trigger: trigger ? Number(trigger) : null, fill_price: fill,
      entry_time: fill ? isoUtc(now) : null, stop: stop ? Number(stop) : 0.0, target: target ? Number(target) : 0.0,
      deadline: req.deadline || '', prediction_id: req.prediction_id ?? null, plan_json: req.plan ? JSON.stringify(req.plan) : null,
      charges_json: fill ? JSON.stringify({ entry: ledgerCharges(fill * qty, long ? 'buy' : 'sell', product, fees) }) : '{}',
    };
    const tid = await this.ctx.store.insertTrade(row);
    return { action, trades: [(await this.getTrade(tid))!], notes: pv.notes };
  }

  /** Record the prediction card's plan as an order. */
  async placeTrade(symbol: string, interval: string, plan: TradePlan, predictionId: number | null = null, livePrice: number | null = null): Promise<Trade> {
    if (!plan.available) throw new DataError('The plan is not tradeable.');
    if ((plan.qty_affordable ?? 0) < 1) throw new DataError('Not enough capital for one share.');
    const best = plan.best!;
    const res = await this.placeOrder({ symbol, interval, side: 'BUY', product: best.mode, order_type: plan.entry_type, qty: Math.trunc(plan.qty_affordable!),
      price: plan.entry_type === 'limit' ? plan.entry : null, stop: plan.stop, target: best.target,
      live_price: livePrice, deadline: best.deadline, plan, prediction_id: predictionId });
    return res.trades[0];
  }

  /** Split `q` shares off an open position into a separate open row (for partial exits); returns the new row. */
  private async split(t: Trade, q: number): Promise<Trade> {
    const detail = truthy(t.charges_detail) ? t.charges_detail : {};
    const entry: Record<string, number> = truthy(detail.entry) ? detail.entry : truthy(detail.buy) ? detail.buy : {};
    const frac = q / t.qty;
    const partEntry: Record<string, number> = {};
    for (const [k, v] of Object.entries(entry)) partEntry[k] = pyRound(v * frac, 2);
    const restEntry: Record<string, number> = {};
    for (const [k, v] of Object.entries(entry)) restEntry[k] = pyRound(v - (partEntry[k] ?? 0), 2);
    await this.updateTrade(t.id, { qty: t.qty - q, charges_json: JSON.stringify({ ...detail, entry: restEntry }) });
    const row: any = {};
    for (const k of ['symbol', 'interval', 'mode', 'side', 'status', 'created_at', 'entry_type', 'entry_price', 'trigger',
      'fill_price', 'entry_time', 'prediction_id', 'plan_json', 'note'] as const) row[k] = (t as any)[k] ?? null;
    Object.assign(row, { qty: q, stop: t.stop || 0.0, target: t.target || 0.0, deadline: t.deadline || '',
      charges_json: JSON.stringify({ ...detail, entry: partEntry }) });
    return (await this.getTrade(await this.ctx.store.insertTrade(row)))!;
  }

  private async close(t: Trade, price: number, when: number | string, reason: string, fees: Fees): Promise<Trade> {
    const qty = t.qty, fill = Number(t.fill_price), long = isLong(t);
    const exitPx = slip(price, !long, fees);
    const detail: Record<string, any> = truthy(t.charges_detail) ? t.charges_detail : {};
    detail.exit = ledgerCharges(exitPx * qty, long ? 'sell' : 'buy', t.mode, fees, long);
    if (reason === 'squareoff') {
      detail.exit.squareoff = fees.auto_squareoff;
      detail.exit.total = pyRound(detail.exit.total + fees.auto_squareoff, 2);
    }
    const charges = pyRound(entryTotal(t) + detail.exit.total, 2);
    const gross = pyRound(long ? (exitPx - fill) * qty : (fill - exitPx) * qty, 2);
    await this.storeClose(t.id, exitPx, typeof when === 'string' ? when : isoUtc(when), reason, gross, charges, pyRound(gross - charges, 2), JSON.stringify(detail));
    return (await this.getTrade(t.id))!;
  }

  private async closeQty(t: Trade, q: number, price: number, when: number, reason: string, fees: Fees): Promise<Trade> {
    if (q >= t.qty) return this.close(t, price, when, reason, fees);
    return this.close(await this.split(t, q), price, when, reason, fees);
  }

  /** Close an open position at `price` (or the last price); a pending order is cancelled. */
  async closeTrade(id: number, price: number | null = null, reason = 'manual'): Promise<Trade> {
    const t = await this.getTrade(id);
    if (!t) throw new DataError('Trade not found');
    const st = await this.getSettings();
    if (t.status === 'pending') {
      await this.cancelTrade(id);
      return (await this.getTrade(id))!;
    }
    if (t.status !== 'open') throw new DataError('Trade is not open');
    const px = price == null ? await this.fetchLast(t.symbol, t.interval) : Number(price);
    return this.close(t, px, this.nowMs(), reason, st.fees);
  }

  /** Fill pending orders and exit open positions on stop / target / deadline / broker square-off using real bars. */
  async checkTrades(nowArg?: number | Date): Promise<CheckResult> {
    const now = nowArg != null ? +nowArg : this.nowMs();
    const st = await this.getSettings();
    const fees = st.fees;
    const filled: CheckResult['filled'] = [], errors: CheckResult['errors'] = [];
    const closed: any[] = [];
    const cache = new Map<string, Bars>();
    const all = [...(await this.listTrades('pending')), ...(await this.listTrades('open'))];
    for (let t of all) {
      try {
        const key = t.symbol + '\u0000' + t.interval;
        if (!cache.has(key)) {
          if (!this.ctx.getBars) throw new DataError('no bar feed configured');
          cache.set(key, await this.ctx.getBars(t.symbol, t.interval));
        }
        const df = cache.get(key)!;
        const sec = intervalSeconds(t.interval);
        const secMs = sec * 1000;
        const long = isLong(t);
        const deadline = parseIso(t.deadline);
        let since = parseIso(t.entry_time || t.created_at)!;
        const barStart = sec < 86400 ? Math.floor(since / secMs) * secMs : Math.floor(since / DAY_MS) * DAY_MS;
        let start = df.t.findIndex((x) => x * 1000 >= barStart);
        if (start < 0) start = df.t.length;
        if (t.status === 'pending') {
          const so = t.mode === 'intraday' ? squareoffUtc(since, st.squareoff_time) : null;
          if ((deadline !== null && now >= deadline) || (so !== null && now >= so)) {
            await this.cancelTrade(t.id); closed.push({ id: t.id, reason: 'expired' }); continue;
          }
          const lvl = Number(t.entry_price);
          let hit = -1;
          for (let i = start; i < df.t.length; i++) {
            const ok = t.entry_type === 'limit' ? (long ? df.l[i] <= lvl : df.h[i] >= lvl) : (long ? df.h[i] >= lvl : df.l[i] <= lvl);
            if (ok) { hit = i; break; }
          }
          if (hit < 0) continue;
          const o = df.o[hit];
          const fill = t.entry_type === 'limit' ? tick(long ? Math.min(lvl, o) : Math.max(lvl, o)) : slip(long ? Math.max(lvl, o) : Math.min(lvl, o), long, fees);
          const when = df.t[hit] * 1000;
          await this.fillTrade(t.id, fill, isoUtc(when), JSON.stringify({ entry: ledgerCharges(fill * t.qty, long ? 'buy' : 'sell', t.mode, fees) }));
          filled.push({ id: t.id, fill });
          t = (await this.getTrade(t.id))!;
          start = hit;
          since = when;
        }
        const stop = t.stop, target = t.target;
        const so = t.mode === 'intraday' ? squareoffUtc(since, st.squareoff_time) : null;
        const fillBar = t.entry_time ? parseIso(t.entry_time) : null;
        let done = false;
        for (let i = start; i < df.t.length; i++) {
          const ts = df.t[i] * 1000;
          const barEnd = ts + secMs;
          const o = df.o[i], h = df.h[i], l = df.l[i], c = df.c[i];
          const inFillBar = fillBar !== null && ts <= fillBar && fillBar < ts + secMs;
          const [hi, lo] = inFillBar ? [c, c] : [h, l];
          const stopHit = truthy(stop) && (long ? lo <= stop! : hi >= stop!);
          const targetHit = truthy(target) && (long ? hi >= target! : lo <= target!);
          if (stopHit) {
            const px = inFillBar ? c : long ? Math.min(stop!, o) : Math.max(stop!, o);
            closed.push(await this.close(t, px, barEnd, 'stop', fees)); done = true; break;
          }
          if (targetHit) {
            const px = inFillBar ? c : long ? Math.max(target!, o) : Math.min(target!, o);
            closed.push(await this.close(t, px, barEnd, 'target', fees)); done = true; break;
          }
          if (deadline !== null && barEnd >= deadline) { closed.push(await this.close(t, c, barEnd, 'deadline', fees)); done = true; break; }
          if (so !== null && barEnd >= so) { closed.push(await this.close(t, c, barEnd, 'squareoff', fees)); done = true; break; }
        }
        if (!done && start < df.t.length) {
          const lastC = df.c[df.c.length - 1];
          if (deadline !== null && now >= deadline + secMs) closed.push(await this.close(t, lastC, now, 'deadline', fees));
          else if (so !== null && now >= so + secMs) closed.push(await this.close(t, lastC, now, 'squareoff', fees));
        }
      } catch (exc) {
        errors.push({ id: t.id, error: errMsg(exc) });
      }
    }
    return { filled, closed: closed.map((c) => ('reason' in c ? c : { id: c.id, reason: c.exit_reason, net_pnl: c.net_pnl })), errors };
  }

  // ------------------------------------------------ portfolio
  async portfolio(): Promise<Portfolio> {
    const st = await this.getSettings();
    const fees = st.fees;
    const trades = await this.listTrades();
    const openT = trades.filter((t) => t.status === 'open');
    const pending = trades.filter((t) => t.status === 'pending');
    const closed = trades.filter((t) => t.status === 'closed').sort((a, b) => cmp(a.exit_time || '', b.exit_time || ''));
    const cash = await this.portfolioCash(st);
    let invested = 0.0, unrealised = 0.0;
    const lastCache = new Map<string, number>();
    for (const t of openT) {
      const key = t.symbol + '\u0000' + t.interval;
      let last: number;
      try {
        last = lastCache.has(key) ? lastCache.get(key)! : await this.fetchLast(t.symbol, t.interval);
      } catch {
        last = Number(t.fill_price);
      }
      lastCache.set(key, last);
      const long = isLong(t);
      const exitEst = ledgerCharges(last * t.qty, long ? 'sell' : 'buy', t.mode, fees, long).total;
      const fill = Number(t.fill_price);
      const gross = long ? (last - fill) * t.qty : (fill - last) * t.qty;
      t.last_price = last;
      t.unrealised = pyRound(gross - entryTotal(t) - exitEst, 2);
      t.unrealised_pct = fill ? pyRound((long ? last / fill - 1 : fill / last - 1) * 100, 2) : 0.0;
      const tgt = t.target;
      if (tgt && long && tgt > fill) t.progress = pyRound((last - fill) / (tgt - fill) * 100, 1);
      else if (tgt && !long && tgt < fill) t.progress = pyRound((fill - last) / (fill - tgt) * 100, 1);
      else t.progress = null;
      t.squareoff = t.mode === 'intraday' && t.entry_time ? isoUtc(squareoffUtc(parseIso(t.entry_time)!, st.squareoff_time)) : null;
      invested += fill * t.qty;
      unrealised += t.unrealised;
    }
    const wins = closed.filter((t) => (t.net_pnl || 0) > 0);
    const losses = closed.filter((t) => (t.net_pnl || 0) <= 0);
    const grossWin = pySum(wins.map((t) => t.net_pnl ?? 0));
    const grossLoss = -pySum(losses.map((t) => t.net_pnl ?? 0));
    const curve: { time: string | null; equity: number }[] = [];
    let eq = Number(st.capital), peak = Number(st.capital), mdd = 0.0;
    for (const t of closed) {
      eq += Number(t.net_pnl || 0);
      peak = Math.max(peak, eq);
      mdd = Math.max(mdd, peak ? (peak - eq) / peak * 100 : 0);
      curve.push({ time: t.exit_time, equity: pyRound(eq, 2) });
    }
    const pf = grossLoss > 0 ? grossWin / grossLoss : null;
    const netSum = pySum(closed.map((t) => t.net_pnl || 0));
    const stats: PortfolioStats = {
      trades: closed.length, open: openT.length, pending: pending.length,
      net_pnl: pyRound(netSum, 2), gross_pnl: pyRound(pySum(closed.map((t) => t.gross_pnl || 0)), 2),
      charges: pyRound(pySum(closed.map((t) => t.charges || 0)), 2),
      win_rate: closed.length ? pyRound(wins.length / closed.length, 3) : null,
      profit_factor: pf !== null ? pyRound(pf, 2) : null,
      expectancy: closed.length ? pyRound(netSum / closed.length, 2) : null,
      avg_win: wins.length ? pyRound(grossWin / wins.length, 2) : null, avg_loss: losses.length ? pyRound(-grossLoss / losses.length, 2) : null,
      max_drawdown_pct: pyRound(mdd, 2), return_pct: st.capital ? pyRound((eq / Number(st.capital) - 1) * 100, 2) : null,
    };
    return { settings: st, capital: st.capital, cash: pyRound(cash, 2), invested: pyRound(invested, 2), unrealised: pyRound(unrealised, 2),
      equity: pyRound(cash + invested + unrealised, 2), open: openT, pending, closed: closed.slice().reverse(), stats, equity_curve: curve };
  }
}
