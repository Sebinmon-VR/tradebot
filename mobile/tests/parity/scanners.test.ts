/** npx tsx tests/parity/scanners.test.ts - market map metrics, multi-day overextended and today's scanner vs Python. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as intraday from '../../src/engine/intraday';
import * as over from '../../src/engine/overextended';
import { metrics } from '../../src/engine/screener';
import { sliceBars } from '../../src/engine/types';
import { FIXTURES, done, series, toBars, value } from './check';

const fx = JSON.parse(readFileSync(join(FIXTURES, 'scanners.json'), 'utf8'));
const load = (n: string) => toBars(JSON.parse(readFileSync(join(FIXTURES, n + '.json'), 'utf8')).bars);

function compare(label: string, ts: any, py: any, skip = new Set<string>()) {
  for (const [k, pv] of Object.entries<any>(py)) {
    if (skip.has(k)) continue;
    const tv = ts[k];
    if (Array.isArray(pv)) {
      if (pv.length && typeof pv[0] === 'object' && pv[0] !== null) {
        value(`${label}.${k}.length`, tv?.length, pv.length);
        pv.forEach((x: any, i: number) => compare(`${label}.${k}[${i}]`, tv?.[i] ?? {}, x));
      } else series(`${label}.${k}`, tv ?? [], pv, { rel: 1e-6, abs: 0.011 });
    } else if (pv && typeof pv === 'object') compare(`${label}.${k}`, tv ?? {}, pv);
    else value(`${label}.${k}`, tv, pv, 1e-6, typeof pv === 'number' ? 0.011 : 0);
  }
}

const daily = load(fx.overextended.bars);
series('overextended.score', over.scoreSeries(daily), fx.overextended.score, { abs: 1e-6 });
for (const [cut, py] of Object.entries<any>(fx.overextended.cuts)) {
  const { _hist, ...ts } = over.row('RELIANCE.NS', sliceBars(daily, 0, +cut));
  compare(`overextended@${cut}`, ts, py, new Set(['bar_time']));
}
compare('screener', metrics('RELIANCE.NS', daily), fx.screener, new Set(['bar_time']));

const bars5 = load(fx.intraday.bars);
for (const side of ['up', 'down'] as const) {
  const py = fx.intraday[side];
  const F = intraday.features(bars5, side);
  series(`intraday.${side}.score`, F.score, py.score, { abs: 1e-6 });
  series(`intraday.${side}.rvol`, F.rvol, py.rvol, { rel: 1e-9 });
  series(`intraday.${side}.vwap_z`, F.vwapZ, py.vwap_z, { rel: 1e-6, abs: 1e-6 });
  series(`intraday.${side}.fading`, F.fading, py.fading);
  const { _hist, ...row } = intraday.row('ELECTCAST.NS', bars5, side);
  compare(`intraday.${side}.row`, row, py.row, new Set(['bar_time']));
}
done('scanners');
