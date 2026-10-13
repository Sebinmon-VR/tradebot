/** npx tsx tests/parity/strategies.test.ts - the TS strategies must reproduce app/strategies.py signal-for-signal
 *  (fixtures: python mobile/tests/parity/make_strategy_fixtures.py). */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeAll } from '../../src/engine/indicators';
import { catalog, runWindow, STRATEGIES, votesAt } from '../../src/engine/strategies';
import type { Signal } from '../../src/engine/signal';
import { done, FIXTURES, toBars, value } from './check';

const DIR = join(FIXTURES, 'strategies');

export function compareSignal(label: string, ts: Signal, py: any, tol = { rel: 1e-6, abs: 1e-8 }) {
  value(`${label}.key`, ts.key, py.key);
  value(`${label}.category`, ts.category, py.category);
  value(`${label}.direction`, ts.direction, py.direction, 0, 0);
  if (py.category === 'error') return;
  for (const k of ['name', 'origin', 'rules', 'reason'] as const) value(`${label}.${k}`, ts[k], py[k]);
  value(`${label}.confidence`, ts.confidence, py.confidence, tol.rel, tol.abs);
  const keys = new Set([...Object.keys(py.values), ...Object.keys(ts.values)]);
  for (const k of keys) {
    const a = ts.values[k] as any, b = py.values[k];
    if (Array.isArray(b) || Array.isArray(a)) value(`${label}.values.${k}`, JSON.stringify(a), JSON.stringify(b));
    else if (typeof b === 'string' || typeof b === 'boolean') value(`${label}.values.${k}`, a, b);
    else value(`${label}.values.${k}`, a === undefined ? 'missing' : a, b === undefined ? 'missing' : b, tol.rel, tol.abs);
  }
}

const fired = new Map<string, Set<number>>();
let signals = 0;
if (process.argv[1]?.includes('strategies.test')) main();
function main() {
for (const file of readdirSync(DIR).filter((f) => f.endsWith('.json'))) {
  const fx = JSON.parse(readFileSync(join(DIR, file), 'utf8'));
  const src = JSON.parse(readFileSync(join(FIXTURES, file), 'utf8'));
  console.log(fx.name);
  const bars = toBars(src.bars), x = { bars, f: computeAll(bars) };
  for (const cut of fx.cuts) {
    const ts = runWindow(x, fx.sec, cut.start, cut.end);
    value(`${fx.name}[${cut.start}:${cut.end}].count`, ts.length, cut.signals.length, 0, 0);
    cut.signals.forEach((py: any, i: number) => {
      compareSignal(`${fx.name}[${cut.start}:${cut.end}].${py.key}`, ts[i], py);
      signals++;
      if (py.category !== 'error') { if (!fired.has(py.key)) fired.set(py.key, new Set()); fired.get(py.key)!.add(py.direction); }
    });
    // the learner's vote vector is direction x clipped confidence
    const votes = votesAt(x, fx.sec, cut.start, cut.end);
    cut.signals.forEach((py: any) => value(`${fx.name}[${cut.start}:${cut.end}].vote.${py.key}`, votes[py.key], py.category === 'error' ? 0 : py.direction * Math.min(1, Math.max(0, py.confidence ?? 0)), 1e-9, 1e-12));
  }
  // STRATEGIES record order and catalog docs
  value(`${fx.name}.keys`, Object.keys(STRATEGIES).join(','), fx.catalog.map((r: any) => r.key).join(','));
  catalog().forEach((r, i) => value(`${fx.name}.catalog.${r.key}`, r.doc, fx.catalog[i].doc));
}
const dirs = [...fired.entries()].map(([k, s]) => `${k}:${[...s].sort().join('/')}`);
console.log(`${signals} signals compared; directions seen per strategy -> ${dirs.join(' ')}`);
done('strategies');
}
