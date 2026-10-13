/** Parity: src/engine/evaluator.ts vs app/evaluator.py grade / _try_resolve and data.bar_is_forming.
 *  Run: cd mobile && npx tsx tests/parity/evaluator.test.ts */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURES, toBars, value, done } from './check';
import { grade, tryResolve, barIsForming, barsDone } from '../../src/engine/evaluator';
import { parseIso } from '../../src/engine/trading';
import { Bars, sliceBars } from '../../src/engine/types';

const fx = JSON.parse(readFileSync(join(FIXTURES, 'trading', 'evaluator.json'), 'utf8'));
const cache = new Map<string, Bars>();
const barsOf = (n: string): Bars => {
  if (!cache.has(n)) cache.set(n, toBars(JSON.parse(readFileSync(join(FIXTURES, n + '.json'), 'utf8')).bars));
  return cache.get(n)!;
};

for (const g of fx.grades) {
  const [o, r, m] = grade(g.direction, g.price, g.target, null, sliceBars(barsOf(g.bars), g.start, g.end));
  const l = `grade ${g.bars} ${g.start}`;
  value(l + ' outcome', o, g.out[0]);
  value(l + ' price', r, g.out[1], 0, 0);
  value(l + ' move', m, g.out[2], 1e-12, 1e-12);
}
for (const c of fx.resolves) {
  const sub = sliceBars(barsOf(c.bars), 0, c.upto);
  const res = tryResolve(c.p, sub, parseIso(c.now)!);
  const l = `resolve ${c.bars} ${c.upto} ${c.p.bar_time}`;
  value(l + ' resolved?', res !== null, c.out !== null);
  if (res && c.out) {
    for (const k of ['id', 'symbol', 'direction', 'outcome', 'resolved_price', 'actual_move_pct']) value(`${l} ${k}`, (res as any)[k], c.out[k], 0, 0);
    value(l + ' keys', Object.keys(res).filter((k) => k !== 'actual_move_pct_raw').length, Object.keys(c.out).length);
  }
  value(l + ' done', barsDone(c.p, sub), c.done);
}
for (const f of fx.forming) {
  value(`forming ${f.symbol} ${f.interval} ${f.last} ${f.now}`, barIsForming(f.symbol, f.interval, parseIso(f.last)! / 1000, parseIso(f.now)!), f.out);
}
console.log(`  grades ${fx.grades.length}, resolves ${fx.resolves.length}, forming ${fx.forming.length}`);
done('evaluator');
