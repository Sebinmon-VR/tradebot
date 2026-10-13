/** npx tsx tests/parity/models.test.ts - the TS models must reproduce app/models.py.
 *  Monte Carlo uses a different (seeded) RNG than numpy, so it is checked statistically, not bit-for-bit. */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runAll } from '../../src/engine/models';
import { sliceBars } from '../../src/engine/types';
import { done, FIXTURES, toBars, value } from './check';
import { compareSignal } from './strategies.test';

const DIR = join(FIXTURES, 'strategies');
let exact = 0, mc = 0, worstMc = 0;
for (const file of readdirSync(DIR).filter((f) => f.endsWith('.json'))) {
  const fx = JSON.parse(readFileSync(join(DIR, file), 'utf8'));
  const bars = toBars(JSON.parse(readFileSync(join(FIXTURES, file), 'utf8')).bars);
  console.log(`${fx.name} (models, horizon ${fx.horizon})`);
  for (const cut of fx.models) {
    const ts = runAll({ bars: sliceBars(bars, 0, cut.end), f: {} }, fx.horizon);
    value(`${fx.name}[:${cut.end}].count`, ts.length, cut.signals.length, 0, 0);
    cut.signals.forEach((py: any, i: number) => {
      const label = `${fx.name}[:${cut.end}].${py.key}`, s = ts[i];
      if (py.key !== 'monte_carlo' || py.confidence === 0) { compareSignal(label, s, py, { rel: 1e-6, abs: 1e-9 }); exact++; return; }
      // Monte Carlo: same drift / volatility exactly; P(up) and quantiles within sampling error of 4000 paths
      mc++;
      const v = py.values, t = s.values as any;
      value(`${label}.sigma_per_bar`, t.sigma_per_bar, v.sigma_per_bar);
      value(`${label}.drift_per_bar`, t.drift_per_bar, v.drift_per_bar);
      value(`${label}.prob_up`, t.prob_up, v.prob_up, 0, 0.03);
      worstMc = Math.max(worstMc, Math.abs(t.prob_up - v.prob_up));
      const spread = v.sigma_per_bar * Math.sqrt(fx.horizon);                       // log-sd of the final price
      for (const q of ['q10', 'q50', 'q90']) value(`${label}.${q}`, t[q], v[q], 0.1 * spread, 0);
      value(`${label}.expected_return_pct`, t.expected_return_pct, v.expected_return_pct, 0, 10 * spread);
      value(`${label}.confidence`, s.confidence, py.confidence, 0, 0.075);
      if (Math.abs(v.prob_up - 0.5) > 0.03) value(`${label}.direction`, s.direction, py.direction, 0, 0);
    });
  }
}
console.log(`${exact} model signals compared exactly, ${mc} Monte Carlo signals statistically (worst |dP(up)| ${worstMc.toFixed(4)})`);
done('models');
