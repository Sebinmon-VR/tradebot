/**
 * The strategy guide's rows (the web app's /api/catalog + the names / origins / rules it shows): every
 * strategy's docstring from engine/strategies.ts catalog(), the statistical models, the Hurst regime signal
 * and the walk-forward learners (engine/learner.ts LEARNER_META).  Names, origins, categories and rules
 * come from the signals themselves: the strategies are run once on a synthetic price series (a few
 * milliseconds) so the guide works before any analysis has been made.
 */
import { computeAll } from '@/engine/indicators';
import { LEARNER_META } from '@/engine/learner';
import { runAll as runModels } from '@/engine/models';
import type { Signal } from '@/engine/signal';
import { catalog as strategyCatalog, runAll as runStrategies } from '@/engine/strategies';
import type { Bars } from '@/engine/types';

export interface GuideRow { key: string; kind: 'strategy' | 'model' | 'regime' | 'learner'; name: string; origin: string; category: string; rules: string; doc: string }

/** A deterministic random walk with a daily-bar rhythm (enough rows for every indicator's warm-up). */
function syntheticBars(n = 420): Bars {
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const b: Bars = { t: [], o: [], h: [], l: [], c: [], v: [] };
  let px = 100;
  const t0 = Date.UTC(2023, 0, 2) / 1000 + 3.75 * 3600;
  for (let i = 0; i < n; i++) {
    const o = px, c = Math.max(1, o * (1 + (rnd() - 0.49) * 0.03));
    b.t.push(t0 + i * 86400); b.o.push(o); b.c.push(c);
    b.h.push(Math.max(o, c) * (1 + rnd() * 0.01)); b.l.push(Math.min(o, c) * (1 - rnd() * 0.01)); b.v.push(1e5 * (0.5 + rnd()));
    px = c;
  }
  return b;
}

const MODEL_DOC: Record<string, string> = {
  // the docstrings of app/models.py
  linreg: 'OLS trend on log price: slope significance (t-stat) and R-squared give direction & confidence.',
  ar_model: 'Autoregressive AR(p) model on log returns, iterated `horizon` steps ahead.',
  monte_carlo: 'Geometric Brownian Motion Monte Carlo: probability of finishing above spot after `horizon` bars.',
  knn_analog: 'Nearest-neighbour analog forecasting: find the most similar past price patterns and see what followed.',
  hurst: 'Hurst exponent regime detector: tells the ensemble whether to trust trend or mean-reversion strategies.',
};

let cached: GuideRow[] | null = null;

/** Every strategy, model and learner; `known` (e.g. the latest analysis' signals) supplies names first. */
export function guideRows(known: Signal[] = []): GuideRow[] {
  if (cached && !known.length) return cached;
  const meta = new Map<string, Signal>();
  try {
    const bars = syntheticBars(), x = { bars, f: computeAll(bars) };
    for (const s of [...runStrategies(x, 86400), ...runModels(x, 10)]) if (s.category !== 'error') meta.set(s.key, s);
  } catch { /* names fall back to keys */ }
  for (const s of known) if (s.category !== 'error' && s.name) meta.set(s.key, s);
  const row = (key: string, kind: GuideRow['kind'], doc: string, fallbackCat: string): GuideRow => {
    const s = meta.get(key);
    return { key, kind, doc, name: s?.name ?? key.replace(/_/g, ' '), origin: s?.origin ?? '', category: s?.category ?? fallbackCat, rules: s?.rules ?? '' };
  };
  const rows: GuideRow[] = strategyCatalog().map((r) => row(r.key, 'strategy', r.doc, 'other'));
  for (const key of ['linreg', 'ar_model', 'monte_carlo', 'knn_analog']) rows.push(row(key, 'model', MODEL_DOC[key], 'statistical'));
  rows.push(row('hurst', 'regime', MODEL_DOC.hurst, 'regime'));
  for (const [key, m] of Object.entries(LEARNER_META)) rows.push({ key, kind: 'learner', name: m.name, origin: m.origin, category: 'ml', rules: m.rules, doc: '' });
  if (!known.length) cached = rows;
  return rows;
}
