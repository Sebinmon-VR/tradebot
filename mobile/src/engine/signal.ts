/**
 * The contract between strategies / models (producers) and the ensemble / learner (consumers) - the TS
 * form of `Signal` in app/strategies.py.
 */
import type { Frame } from './indicators';
import type { Bars } from './types';

export type Direction = -1 | 0 | 1;
export type Category = 'trend' | 'momentum' | 'volatility' | 'volume' | 'price_action' | 'levels' | 'model' | 'regime' | 'error';

export interface Signal {
  key: string;
  name: string;
  origin: string;
  category: Category | string;
  direction: Direction;
  /** 0..1 */
  confidence: number;
  reason: string;
  rules: string;
  values: Record<string, unknown>;
}

/** What a strategy sees: the bars and computeAll(bars) over the same rows (the last row is "now"). */
export interface StrategyInput {
  bars: Bars;
  f: Frame;
}
/** `intervalSeconds` matters only to the strategies in NEEDS_INTERVAL (session-anchored levels). */
export type StrategyFn = (x: StrategyInput, intervalSeconds: number) => Signal;

/** Python's _clip: non-finite -> lo. */
export function clip(x: number | null | undefined, lo = 0, hi = 1): number {
  if (x == null || !Number.isFinite(x)) return lo;
  return Math.min(hi, Math.max(lo, x));
}

/** Signal.to_dict(): confidence clipped and rounded, values rounded to 4 dp, non-finite -> null. */
export function signalToJson(s: Signal): Signal {
  const clean = (v: unknown): unknown => {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 1e4) / 1e4 : null;
    if (Array.isArray(v)) return v.map(clean);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clean(x)]));
    return v;
  };
  return { ...s, confidence: Math.round(clip(s.confidence) * 1000) / 1000, values: clean(s.values) as Record<string, unknown> };
}
