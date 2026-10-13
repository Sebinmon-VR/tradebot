/** Parity: src/engine/trading.ts vs app/trading.py (fixtures from make_trading_fixtures.py).
 *  Run: cd mobile && npx tsx tests/parity/trading.test.ts */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURES, toBars, value, done } from './check';
import * as T from '../../src/engine/trading';
import { Bars, DataError, sliceBars } from '../../src/engine/types';

const load = (n: string) => JSON.parse(readFileSync(join(FIXTURES, 'trading', n + '.json'), 'utf8'));
const barCache = new Map<string, Bars>();
const barsOf = (n: string): Bars => {
  if (!barCache.has(n)) barCache.set(n, toBars(JSON.parse(readFileSync(join(FIXTURES, n + '.json'), 'utf8')).bars));
  return barCache.get(n)!;
};

const SKIP = new Set(['charges_json', 'plan_json']); // JSON text differs in formatting; the decoded plan / charges_detail are compared
let shown = 0;
function deep(label: string, ts: any, py: any): void {
  if (py === null || py === undefined) {
    if (ts !== null && ts !== undefined) { value(label, JSON.stringify(ts), 'null'); }
    else value(label, null, null);
    return;
  }
  if (Array.isArray(py)) {
    if (!Array.isArray(ts) || ts.length !== py.length) { value(label + ' (array length)', Array.isArray(ts) ? ts.length : typeof ts, py.length); return; }
    py.forEach((v, i) => deep(`${label}[${i}]`, ts[i], v));
    return;
  }
  if (typeof py === 'object') {
    if (ts === null || typeof ts !== 'object') { value(label + ' (object)', JSON.stringify(ts), 'object'); return; }
    const keys = new Set([...Object.keys(py), ...Object.keys(ts)]);
    for (const k of keys) if (!SKIP.has(k)) deep(`${label}.${k}`, ts[k], py[k]);
    return;
  }
  if (typeof py === 'number') { value(label, ts, py, 1e-9, 1e-9); return; }
  value(label, ts, py);
}
const json = (x: any) => JSON.parse(JSON.stringify(x));

async function main() {
  // ---------------- numerics
  const ch = load('charges');
  for (const r of ch.rounds) {
    value(`round0 ${r.x}`, T.pyRound(r.x), r.r0, 0, 0);
    for (const d of [1, 2, 3, 4]) value(`round${d} ${r.x}`, T.pyRound(r.x, d), r['r' + d], 0, 0);
    value(`fmt0 ${r.x}`, T.pyFormat(r.x, 0), r.f0);
    value(`fmt2 ${r.x}`, T.pyFormat(r.x, 2), r.f2);
    value(`fmtc0 ${r.x}`, T.pyFormat(r.x, 0, true), r.fc0);
    value(`fmtc2 ${r.x}`, T.pyFormat(r.x, 2, true), r.fc2);
  }
  for (const s of ch.sums) value(`sum ${s.xs}`, T.pySum(s.xs), s.sum, 0, 0);
  for (const t of ch.ticks) {
    value(`tick ${t.x}`, T.tick(t.x), t.tick, 0, 0);
    // slippage uses the fee dicts
  }
  const fees = ch.fees as Record<string, T.Fees>;
  for (const t of ch.ticks) {
    const slip = (p: number, buying: boolean, f: T.Fees) => (buying ? T.tick(p * (1 + f.slippage_pct / 100)) : T.tick(p * (1 - f.slippage_pct / 100)));
    value(`slip buy ${t.x}`, slip(t.x, true, fees.groww), t.slip_buy, 0, 0);
    value(`slip sell ${t.x}`, slip(t.x, false, fees.groww), t.slip_sell, 0, 0);
    value(`slip custom ${t.x}`, slip(t.x, true, fees.custom), t.slip_custom, 0, 0);
  }
  // fees must match to the paisa: exact equality after rounding
  let feeCases = 0;
  for (const c of ch.order) {
    const [v, side, mode, dp, fk] = c.in;
    deep(`order ${c.in}`, T.orderCharges(v, side, mode, fees[fk], dp), c.out);
    deep(`ledger ${c.in}`, T.ledgerCharges(v, side, mode, fees[fk], dp), c.ledger);
    feeCases++;
  }
  for (const c of ch.round_trip) {
    const [e, x, q, mode, short, fk] = c.in;
    deep(`round_trip ${c.in}`, T.roundTrip(e, x, q, mode, fees[fk], short), c.out);
    feeCases++;
  }

  // ---------------- deadlines
  const dl = load('deadlines');
  for (const c of dl.deadlines) deep(`deadlines ${c.now} ${c.sec} ${c.hhmm} ${c.horizon}`, T.deadlines(T.parseIso(c.now)!, c.sec, c.hhmm, c.horizon), c.out);
  for (const c of dl.squareoff) value(`squareoff ${c.t} ${c.hhmm}`, T.isoUtc(T.squareoffUtc(T.parseIso(c.t)!, c.hhmm)), c.out);

  // ---------------- barrier statistics
  for (const c of load('barriers').cases) {
    const base = T.barrierRates(barsOf(c.bars), c.u, c.d, c.h, c.n);
    deep(`barrier ${c.bars} ${c.u} ${c.d} ${c.h} ${c.n}`, base, c.out);
    for (const [p, r, out] of c.tilts) deep(`tilt ${c.bars} ${c.u} ${c.d} ${c.h} ${c.n} ${p} ${r}`, T.tilt(base, p, r), out);
  }

  // ---------------- plans
  const plans = load('plans').cases;
  for (const [i, c] of plans.entries()) {
    const store = new T.MemoryTradeStore();
    store.seed(c.rows);
    if (c.saved_settings != null) await store.setSetting('trading', c.saved_settings);
    const trader = new T.PaperTrader({ store });
    const out = await trader.buildPlan(c.result, { bars: barsOf(c.bars), settings: c.settings ?? undefined, now: T.parseIso(c.now)! });
    deep(`plan#${i} ${c.bars}`, json(out), c.out);
  }

  // ---------------- ledger scenarios
  const ledger = load('ledger');
  let steps = 0;
  for (const [name, sc] of Object.entries<any>(ledger)) {
    const store = new T.MemoryTradeStore();
    let clock = 0;
    const market = new Map<string, Bars>();
    const trader = new T.PaperTrader({
      store, now: () => clock,
      getBars: async (s, iv) => { const b = market.get(s + '|' + iv); if (!b) throw new DataError(`No data for ${s} ${iv}`); return b; },
    });
    let plan: any = null;
    for (const [k, s] of sc.steps.entries()) {
      const py = sc.results[k];
      let res: any;
      try {
        switch (s.op) {
          case 'clock': clock = T.parseIso(s.now)!; res = { ok: null }; break;
          case 'market': market.set(s.symbol + '|' + s.interval, sliceBars(barsOf(s.bars), 0, Math.min(s.upto, barsOf(s.bars).t.length))); res = { ok: null }; break;
          case 'save_settings': res = { ok: await trader.saveSettings(s.patch) }; break;
          case 'reset_settings': res = { ok: await trader.resetSettings() }; break;
          case 'get_settings': res = { ok: await trader.getSettings() }; break;
          case 'preview': res = { ok: await trader.previewOrder(s.args) }; break;
          case 'place': res = { ok: await trader.placeOrder(s.args) }; break;
          case 'plan': {
            const out = await trader.buildPlan(s.result, { bars: market.get(s.result.symbol + '|' + s.result.interval) });
            plan = json(out); res = { ok: out }; break;
          }
          case 'place_trade': res = { ok: await trader.placeTrade(s.symbol, s.interval, plan, s.prediction_id ?? null, s.live_price ?? null) }; break;
          case 'close': res = { ok: await trader.closeTrade(s.id, s.price ?? null, s.reason ?? 'manual') }; break;
          case 'check': res = { ok: await trader.checkTrades() }; break;
          case 'portfolio': res = { ok: await trader.portfolio() }; break;
          case 'cash': res = { ok: await trader.portfolioCash() }; break;
          default: throw new Error('unknown op ' + s.op);
        }
      } catch (e) {
        res = { error: (e as Error).message };
      }
      res.state = await trader.listTrades();
      deep(`ledger ${name} step ${k} ${s.op}`, json(res), py);
      steps++;
    }
  }
  console.log(`  fee cases ${feeCases}, plans ${plans.length}, ledger steps ${steps}`);
  done('trading');
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
