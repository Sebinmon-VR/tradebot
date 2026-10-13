/// <reference types="node" />
/** Shared helpers for the parity tests: load a fixture, compare series / values with a tolerance, report. */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Bars } from '../../src/engine/types';

export const FIXTURES = join(__dirname, 'fixtures');
export function fixtures(): { name: string; data: any }[] {
  return readdirSync(FIXTURES).filter((f) => f.endsWith('.json'))
    .map((f) => ({ name: f.replace('.json', ''), data: JSON.parse(readFileSync(join(FIXTURES, f), 'utf8')) }))
    .filter((x) => x.data.bars && x.data.indicators);   // bar fixtures only (made by make_fixtures.py)
}
export const toBars = (b: any): Bars => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v.map((x: number | null) => x ?? 0) });

let failures = 0, checks = 0;
const close = (a: number | null | undefined, b: number | null | undefined, rel: number, abs: number) => {
  // the fixtures store NaN and +-inf as null (JSON has neither)
  const an = a == null || !Number.isFinite(a as number), bn = b == null || !Number.isFinite(b as number);
  if (an || bn) return an === bn;
  return Math.abs((a as number) - (b as number)) <= abs + rel * Math.abs(b as number);
};
/** Compare a TS series with the Python one; `skip` ignores the first bars (ewm warm-up differences). */
export function series(label: string, ts: (number | boolean)[], py: (number | boolean | null)[], opt: { rel?: number; abs?: number; skip?: number } = {}) {
  checks++;
  const rel = opt.rel ?? 1e-6, abs = opt.abs ?? 1e-8;
  if (ts.length !== py.length) { failures++; console.log(`  FAIL ${label}: length ${ts.length} vs ${py.length}`); return; }
  let bad = 0, first = -1;
  for (let i = opt.skip ?? 0; i < py.length; i++) {
    const ok = typeof py[i] === 'boolean' ? ts[i] === py[i] : close(ts[i] as number, py[i] as number, rel, abs);
    if (!ok) { bad++; if (first < 0) first = i; }
  }
  if (bad) { failures++; console.log(`  FAIL ${label}: ${bad} mismatches, first at ${first}: ts=${ts[first]} py=${py[first]}`); }
}
export function value(label: string, ts: unknown, py: unknown, rel = 1e-6, abs = 1e-8) {
  checks++;
  const ok = typeof py === 'boolean' || typeof py === 'string' ? ts === py : close(ts as number, py as number, rel, abs);
  if (!ok) { failures++; console.log(`  FAIL ${label}: ts=${ts} py=${py}`); }
}
export function done(name: string) {
  console.log(`${name}: ${checks - failures}/${checks} checks passed`);
  if (failures) process.exitCode = 1;
}
