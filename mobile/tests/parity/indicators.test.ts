/** npx tsx tests/parity/indicators.test.ts - the TS indicators must match app/indicators.py on the same bars. */
import * as ind from '../../src/engine/indicators';
import { done, fixtures, series, toBars, value } from './check';

for (const { name, data } of fixtures()) {
  console.log(name);
  const b = toBars(data.bars);
  const all = ind.computeAll(b);
  for (const [col, py] of Object.entries<any[]>(data.indicators)) {
    if (!(col in all)) { series(`${name}.${col} (missing in TS)`, [], py); continue; }
    series(`${name}.${col}`, all[col], py, { rel: 1e-6, abs: 1e-6 });
  }
  const L = data.levels, intra = data.intraday;
  const piv = ind.pivotPoints(b, intra);
  for (const k of ['pivot', 'r1', 'r2', 'r3', 's1', 's2', 's3']) value(`${name}.pivots.${k}`, (piv as any)[k], L.pivots[k]);
  const cpr = ind.cprLevels(b, intra);
  for (const k of ['pivot', 'tc', 'bc', 'width_pct', 'narrow']) value(`${name}.cpr.${k}`, (cpr as any)[k], L.cpr[k]);
  const cam = ind.camarillaLevels(b, intra);
  for (const k of Object.keys(L.camarilla)) value(`${name}.camarilla.${k}`, cam[k], L.camarilla[k]);
  const vb = ind.vwapBands(b, intra);
  for (const k of Object.keys(L.vwap_bands)) value(`${name}.vwap_bands.${k}`, (vb as any)?.[k], L.vwap_bands[k]);
  const mp = ind.marketProfile(b, intra);
  for (const k of Object.keys(L.profile)) value(`${name}.profile.${k}`, (mp as any)?.[k], L.profile[k]);
  const fib = ind.fibonacciLevels(b);
  value(`${name}.fib.up_swing`, fib.up_swing, L.fib.up_swing);
  for (const k of Object.keys(L.fib.levels)) value(`${name}.fib.${k}`, fib.levels[k], L.fib.levels[k]);
  value(`${name}.hurst`, ind.hurstExponent(b.c), L.hurst, 1e-6);
  series(`${name}.vwap_session`, ind.vwap(b), L.vwap_session);
  const sw = ind.swingPoints(b);
  series(`${name}.swing_high`, sw.swingHigh, L.swing_high);
  series(`${name}.swing_low`, sw.swingLow, L.swing_low);
}
done('indicators');
