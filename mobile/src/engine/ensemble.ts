/**
 * Combine every strategy and model vote into one prediction - the pure part of app/ensemble.py.
 *
 * Two layers:
 * 1. Rule ensemble - every strategy and statistical model votes; weight = base weight (by category) x
 *    regime adjustment (Hurst) x adaptive accuracy multiplier learned from resolved predictions and user
 *    feedback.  This gives the bull / bear scores and a rule probability.
 * 2. Walk-forward learner - its calibrated probability is the final P(up), and a direction is only called
 *    where out-of-sample calls of the same strength were right often enough (else SIDEWAYS = no call).
 *    The caller runs the learner and injects its prediction (LearnerInput); without one the rule
 *    probability is used with the 0.58 / 0.42 thresholds.
 *
 * No I/O here: the caller supplies the closed bars, the strategy track record (db.strategy_stats()
 * shape) and optionally the learner prediction, and adds symbol / interval / created_at / as_of / note.
 */
import type { Frame } from './indicators';
import { computeAll } from './indicators';
import type { Signal } from './signal';

import { runAll as runModels } from './models';
import { camarillaAt, cprAt, fibonacciAt, fullWindow, marketProfileAt, pivotsAt, pyRound, runAll as runStrategies, signalToDict, vwapBandsAt } from './strategies';
import { Bars, isIntraday } from './types';

export const BASE_WEIGHT: Record<string, number> = {
  trend: 1.0, momentum: 0.8, volatility: 0.9, volume: 0.7,
  price_action: 0.6, levels: 0.6, statistical: 0.9, ml: 1.1, regime: 0.0, error: 0.0,
};
/** Strategies whose logic is mean-reverting (fade the move) vs trend-following. */
export const MEAN_REVERSION_KEYS = new Set(['rsi_wilder', 'connors_rsi2', 'stochastic', 'williams_r', 'mfi', 'bollinger_mr',
  'floor_pivots', 'fibonacci', 'support_resistance', 'cci', 'camarilla', 'vwap_bands', 'opening_gap', 'market_profile']);
export const TREND_KEYS = new Set(['golden_cross', 'ema_crossover', 'macd', 'adx_dmi', 'supertrend', 'parabolic_sar', 'ichimoku',
  'hull_ma', 'elder_triple_screen', 'chandelier_exit', 'heikin_ashi', 'momentum_12_1', 'fifty_two_week_high', 'turtle',
  'keltner_pullback', 'volume_breakout', 'bollinger_breakout', 'ttm_squeeze', 'linreg', 'cpr', 'nr7', 'alligator']);
export const DEFAULT_HORIZON: Record<string, number> = { '1m': 30, '5m': 24, '15m': 16, '30m': 14, '1h': 12, '1d': 10, '1wk': 6 };
export const FALLBACK_THRESHOLD = 0.58;
const NO_LEARNER_REASON = 'not enough history for walk-forward validation (need 200+ labelled bars)';

/** One row of db.strategy_stats(): the resolved track record of a strategy. */
export interface StrategyStat { key?: string; name?: string; category?: string; correct: number; incorrect: number; neutral?: number }
export type StrategyStats = Record<string, StrategyStat>;

/** Bayesian-smoothed hit rate -> weight multiplier in [0.3, 2.0]. Few samples => close to 1. */
export function adaptiveMultiplier(stat?: StrategyStat | null): number {
  if (!stat) return 1.0;
  const n = stat.correct + stat.incorrect;
  if (n === 0) return 1.0;
  const acc = (stat.correct + 1) / (n + 2);
  const shrink = Math.min(n, 25) / 25;          // trust the stat more as samples accumulate
  return Math.min(2.0, Math.max(0.3, 1 + (acc / 0.5 - 1) * shrink));
}

export function regimeMultiplier(key: string, hurst: number): number {
  if (hurst > 0.55) {
    const boost = 1 + (hurst - 0.55) * 4;     // up to ~1.4 at H=0.65
    return TREND_KEYS.has(key) ? boost : MEAN_REVERSION_KEYS.has(key) ? 1 / boost : 1.0;
  }
  if (hurst < 0.45) {
    const boost = 1 + (0.45 - hurst) * 4;
    return MEAN_REVERSION_KEYS.has(key) ? boost : TREND_KEYS.has(key) ? 1 / boost : 1.0;
  }
  return 1.0;
}

/** A signal as shown in the analysis table (Signal.to_dict() plus its weighting). */
export interface SignalRow extends Signal {
  weight: number; base_weight: number; regime_mult: number; adaptive_mult: number; contribution: number;
  history: StrategyStat | null; counts_in_rule_score: boolean; learned_weight?: number;
}

export function signalRow(s: Signal, stats: StrategyStats, hurst: number, counts: boolean): SignalRow {
  const base = BASE_WEIGHT[s.category] ?? 0.5;
  const reg = regimeMultiplier(s.key, hurst), adp = adaptiveMultiplier(stats[s.key]);
  const w = base * reg * adp;
  return {
    ...signalToDict(s), weight: pyRound(w, 3), base_weight: base, regime_mult: pyRound(reg, 3), adaptive_mult: pyRound(adp, 3),
    contribution: pyRound(w * s.confidence, 3), history: stats[s.key] ?? null, counts_in_rule_score: counts,
  };
}

export interface RuleScore {
  rows: SignalRow[]; bull: number; bear: number; neutral: number; net: number;
  ruleProb: number; modelProb: number | null; fallbackProb: number; hurst: number;
}

/** Layer 1: weight every vote and turn the signals into bull / bear scores and a rule probability. */
export function scoreSignals(signals: Signal[], stats: StrategyStats = {}): RuleScore {
  const hs = signals.find((s) => s.key === 'hurst');
  const hurst = hs ? ((hs.values.hurst as number | undefined) ?? 0.5) : 0.5;
  let bull = 0, bear = 0, neutral = 0;
  const rows: SignalRow[] = [], modelProbs: [number, number][] = [];
  for (const s of signals) {
    const r = signalRow(s, stats, hurst, true);
    rows.push(r);
    if (s.direction > 0) bull += r.contribution;
    else if (s.direction < 0) bear += r.contribution;
    else neutral += r.contribution * 0.5;
    if ('prob_up' in s.values && s.confidence > 0) modelProbs.push([Number(s.values.prob_up), r.weight * Math.max(s.confidence, 0.15)]);
  }
  const total = bull + bear + neutral;
  const net = total > 0 ? (bull - bear) / total : 0.0;
  const ruleProb = 0.5 + net / 2;
  let modelProb: number | null = null, fallbackProb = ruleProb;
  if (modelProbs.length) {
    let pw = 0, ws = 0;
    for (const [p, w] of modelProbs) { pw += p * w; ws += w; }
    modelProb = pw / ws;
    fallbackProb = 0.65 * ruleProb + 0.35 * modelProb;
  }
  fallbackProb = Math.min(0.98, Math.max(0.02, fallbackProb));
  return { rows, bull, bear, neutral, net, ruleProb, modelProb, fallbackProb, hurst };
}

/**
 * What the walk-forward learner hands the ensemble (app/learner.py Prediction):
 * prob = calibrated P(up); threshold = fit.threshold; tierAccuracy = tier["accuracy"] (null when the
 * tier has none); fitAccuracy = fit.accuracy; learnedWeights = fit.learned_weights; signals = its
 * per-learner + "wf_ensemble" signals (category 'ml'); summary = Prediction.summary().
 */
export interface LearnerInput {
  prob: number; threshold: number; tierAccuracy: number | null; fitAccuracy: number;
  learnedWeights: Record<string, number>; signals: Signal[]; summary: Record<string, unknown>;
}

export interface AnalyzeInput {
  /** closed bars, oldest first (drop a still-forming last bar and pass it as formingBar) */
  bars: Bars;
  intervalSeconds: number;
  horizon: number;
  /** db.strategy_stats() - track record per strategy key */
  stats?: StrategyStats;
  /** the learner's prediction on these bars, or null/undefined to use the rule ensemble */
  learner?: LearnerInput | null;
  /** optional precomputed computeAll(bars) and strategy + model signals (they are computed when absent) */
  frame?: Frame;
  signals?: Signal[];
  /** the excluded forming bar: its latest close becomes the entry price */
  formingBar?: { t: number; close: number } | null;
  /** most recent streamed tick; overrides the entry price */
  livePrice?: number | null;
}

export interface ForecastPoint { time: number; bar: number; median: number; upper: number; lower: number }
export type Direction3 = 'UP' | 'DOWN' | 'SIDEWAYS';

/** Naive-UTC ISO string like pandas' Timestamp.isoformat() on the app's UTC index. */
export const isoUtc = (t: number) => new Date(t * 1000).toISOString().slice(0, 19);

/** Rough wall-clock estimate (ISO, +00:00) of when `horizon` more bars will have printed (ensemble._expires_at). */
export function expiresAt(intervalSeconds: number, horizon: number, lastBarT: number): string {
  let days: number;
  if (intervalSeconds >= 86400 * 7) days = 7 * horizon;
  else if (intervalSeconds >= 86400) days = (horizon * 7) / 5 + 1;          // skip weekends
  else {
    const perDay = (6.5 * 3600) / intervalSeconds;                          // typical cash session
    const d = horizon / perDay;
    days = (d * 7) / 5 + (d < 0.5 ? 0 : 1);
  }
  // datetime.timedelta(days=float): whole days + whole seconds + microseconds rounded half-to-even
  const whole = Math.trunc(days), secs = (days - whole) * 86400, wholeSec = Math.trunc(secs);
  const usD = (secs - wholeSec) * 1e6;
  let us = Math.round(usD);
  if (Math.abs(usD % 1) === 0.5 && us % 2 !== 0) us -= 1;
  const totalUs = lastBarT * 1e6 + whole * 86400e6 + wholeSec * 1e6 + us;
  const sec = Math.floor(totalUs / 1e6), frac = totalUs - sec * 1e6;
  return `${isoUtc(sec)}${frac ? '.' + String(frac).padStart(6, '0') : ''}+00:00`;
}

const INDICATOR_KEYS = ['open', 'high', 'low', 'close', 'volume', 'sma_20', 'sma_50', 'sma_200', 'ema_9', 'ema_21', 'ema_50', 'ema_200',
  'rsi_14', 'rsi_2', 'macd', 'macd_signal', 'macd_hist', 'adx', 'plus_di', 'minus_di', 'stoch_k', 'stoch_d',
  'cci_20', 'williams_r', 'mfi_14', 'atr_14', 'bb_upper', 'bb_mid', 'bb_lower', 'bb_width', 'bb_pct',
  'kc_upper', 'kc_lower', 'supertrend', 'psar', 'tenkan', 'kijun', 'senkou_a', 'senkou_b', 'obv', 'vwap_20',
  'cmf_20', 'hma_20', 'volatility_20', 'vol_sma_20'];

const nanmax = (xs: number[]) => { const v = xs.filter((x) => !Number.isNaN(x)); return v.length ? Math.max(...v) : NaN; };
const npMedian = (xs: number[]) => {
  if (xs.some(Number.isNaN)) return NaN;
  const s = [...xs].sort((a, b) => a - b), k = s.length >> 1;
  return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2;
};
const r4 = (x: number) => pyRound(x, 4);

/**
 * ensemble.analyze() minus data fetching, the DB and the learner call: returns every field of the
 * /api/analyze response except symbol, interval, created_at, as_of, data_symbol and note (the caller's).
 */
export function analyzeCore(inp: AnalyzeInput) {
  const { bars, intervalSeconds: sec, horizon } = inp;
  const stats = inp.stats ?? {};
  const data = inp.frame ?? computeAll(bars);
  const x = { bars, f: data };
  const n = bars.c.length;

  // ---- layer 1: rule ensemble
  const signals = inp.signals ?? [...runStrategies(x, sec), ...runModels(x, horizon)];
  const score = scoreSignals(signals, stats);
  const { rows, hurst } = score;

  // ---- layer 2: walk-forward learner (injected)
  const lp = inp.learner ?? null;
  let probUp: number, threshold: number, probSource: string, learnerSummary: Record<string, unknown>;
  if (lp) {
    for (const s of lp.signals) rows.push(signalRow(s, stats, hurst, false));   // shown, but they are the final layer, not rule votes
    probUp = Math.min(0.98, Math.max(0.02, lp.prob));
    threshold = lp.threshold;
    probSource = 'walk-forward learner';
    learnerSummary = lp.summary;
    for (const r of rows) if (r.key in lp.learnedWeights) r.learned_weight = pyRound(lp.learnedWeights[r.key], 3);
  } else {
    probUp = score.fallbackProb;
    threshold = FALLBACK_THRESHOLD;
    probSource = 'rule ensemble';
    learnerSummary = { available: false, reason: NO_LEARNER_REASON };
  }
  const direction: Direction3 = probUp >= threshold ? 'UP' : probUp <= 1 - threshold ? 'DOWN' : 'SIDEWAYS';
  const voters = rows.filter((r) => r.direction !== 0 && r.confidence >= 0.2);
  const dInt = direction === 'UP' ? 1 : direction === 'DOWN' ? -1 : 0;
  const agreeing = voters.filter((r) => r.direction === dInt).length;
  const agreement = voters.length ? agreeing / voters.length : 0.0;
  let expectedAccuracy: number | null = null, confidence: number;
  const clip01 = (v: number) => Math.min(1, Math.max(0, v));
  if (lp && direction !== 'SIDEWAYS') {
    expectedAccuracy = lp.tierAccuracy ?? lp.fitAccuracy;
    confidence = clip01((expectedAccuracy - 0.5) * 2);
  } else if (direction === 'SIDEWAYS') confidence = clip01(1 - Math.abs(probUp - 0.5) * 4) * 0.6;
  else confidence = clip01(Math.abs(probUp - 0.5) * 2 * (0.5 + 0.5 * agreement));

  // ---- price targets
  const L = n - 1;
  let price = bars.c[L], priceSource = 'last close';
  if (inp.formingBar) { price = inp.formingBar.close; priceSource = 'forming bar'; }
  if (inp.livePrice && inp.livePrice > 0) { price = inp.livePrice; priceSource = 'live tick'; }
  const atr = Number.isNaN(data.atr_14[L]) ? price * 0.01 : data.atr_14[L];
  const mc = signals.find((s) => s.key === 'monte_carlo');
  const mcSigma = mc && 'sigma_per_bar' in mc.values ? Number(mc.values.sigma_per_bar) : null;
  const sigmaMove = mcSigma != null ? price * (Math.exp(mcSigma * Math.sqrt(horizon)) - 1) : null;
  const atrMove = atr * Math.sqrt(horizon) * 0.8;
  let expectedMove = nanmax([atrMove, sigmaMove || 0.0]);
  const modelRet = signals.filter((s) => 'expected_return_pct' in s.values && s.confidence > 0.2).map((s) => Number(s.values.expected_return_pct));
  if (modelRet.length) {
    const m = (Math.abs(npMedian(modelRet)) / 100) * price;
    if (m > 0) expectedMove = Math.max(expectedMove * 0.7, Math.min(expectedMove * 1.5, m));
  }
  let target: number, stop: number | null;
  if (direction === 'UP') { target = price + expectedMove; stop = price - 1.5 * atr; }
  else if (direction === 'DOWN') { target = price - expectedMove; stop = price + 1.5 * atr; }
  else { target = price; stop = null; }
  const rr = stop ? Math.abs(target - price) / Math.abs(price - stop) : null;

  const categories: Record<string, { bull: number; bear: number; count: number }> = {};
  for (const r of rows) {
    const c = (categories[r.category] ??= { bull: 0, bear: 0, count: 0 });
    if (r.direction > 0) c.bull += r.contribution;
    else if (r.direction < 0) c.bear += r.contribution;
    c.count += 1;
  }

  const intraday = sec < 86400, w = fullWindow(x, sec);
  const hurstSig = signals.find((s) => s.key === 'hurst');
  const summary = {
    bull_score: pyRound(score.bull, 3), bear_score: pyRound(score.bear, 3), neutral_score: pyRound(score.neutral, 3),
    net: pyRound(score.net, 3), rule_prob_up: pyRound(score.ruleProb, 3), model_prob_up: score.modelProb != null ? pyRound(score.modelProb, 3) : null,
    fallback_prob_up: pyRound(score.fallbackProb, 3), prob_source: probSource, threshold,
    expected_accuracy: expectedAccuracy != null ? r4(expectedAccuracy) : null,
    no_call: direction === 'SIDEWAYS', learner: learnerSummary,
    agreement: pyRound(agreement, 3), voters: voters.length, agreeing,
    hurst: pyRound(hurst, 3), regime: (hurstSig?.values.regime as string | undefined) ?? null,
    atr: r4(atr), expected_move: r4(expectedMove), risk_reward: rr ? pyRound(rr, 2) : null,
    categories,
    pivots: pivotsAt(w, intraday), cpr: cprAt(w, intraday), camarilla: camarillaAt(w, intraday),
    vwap_bands: vwapBandsAt(w, intraday) ?? {}, value_area: marketProfileAt(w, intraday) ?? {},
    fibonacci: fibonacciAt(w, 100),
  };

  // ---- projected path for the next `horizon` bars (median + 80% band)
  const sigma = mcSigma ?? atr / price;
  const t0 = bars.t[L];
  const forecast: ForecastPoint[] = [];
  for (let k = 1; k <= horizon; k++) {
    const median = price + dInt * expectedMove * Math.sqrt(k / horizon);
    const band = 1.28 * sigma * Math.sqrt(k);
    forecast.push({ time: t0 + k * sec, bar: k, median: r4(median), upper: r4(median * Math.exp(band)), lower: r4(median * Math.exp(-band)) });
  }
  const nb = forecast[0];
  const nextBar = { direction, prob_up: r4(probUp), expected_close: nb.median, range_low: nb.lower, range_high: nb.upper, time: nb.time };
  const indicators: Record<string, number | null> = {};
  for (const k of INDICATOR_KEYS) { const v = data[k][L]; indicators[k] = Number.isNaN(v) ? null : r4(v); }
  return {
    horizon_bars: horizon, bar_time: isoUtc(t0),
    last_bar_forming: !!inp.formingBar, price_source: priceSource,
    forming_bar_time: inp.formingBar ? isoUtc(inp.formingBar.t) : null,
    forecast, next_bar: nextBar,
    price_at: price, direction, prob_up: r4(probUp), confidence: r4(confidence),
    target_price: r4(target), stop_price: stop ? r4(stop) : null,
    expected_move_pct: r4((expectedMove / price) * 100),
    expires_at: expiresAt(sec, horizon, t0),
    signals: rows, summary, indicators,
  };
}
export type AnalyzeCore = ReturnType<typeof analyzeCore>;

/** Floor pivots, CPR and Camarilla levels for the last bar's session, drawn as lines on the chart. */
export function chartLevels(bars: Bars) {
  const intraday = isIntraday(bars);
  try {
    const w = fullWindow({ bars, f: {} }, intraday ? 60 : 86400);
    return { intraday, pivots: pivotsAt(w, intraday), cpr: cprAt(w, intraday), camarilla: camarillaAt(w, intraday) };
  } catch {
    return {};   // a levels failure must never break the chart
  }
}
