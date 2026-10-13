/**
 * Learning - port of the web app's "Learning & prediction" pop-up (#learn, openLearning in static/app.js):
 * what the walk-forward learner was trained on, how it validated, the calibration / strength tiers behind
 * the 55% call rule, the evidence grade, the most informative inputs, the weight it learned for every
 * strategy, and step by step how this call was reached.  Shows the latest analysis (any chart analysed in
 * this session), or a stored prediction when opened from History (?id=).
 */
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { Body, CallBadge, EVIDENCE_LABEL, Grid, H, KV, Note, OutcomeBadge, Table, VoteText, whenBar } from '@/components/more/common';
import { LastAnalysis, allAnalyses, latestAnalysis, subscribe } from '@/services/last-analysis';
import { getPrediction } from '@/services/predictions';
import { Badge, Button, Card, Chip, Row, T, fmt, pct, useColors } from '@/ui/kit';

const FEATURE_LABEL: Record<string, string> = { rsi_14: 'RSI 14', rsi_2: 'RSI 2', stoch_k: 'Stochastic %K', williams_r: 'Williams %R', cci_20: 'CCI 20', mfi_14: 'MFI 14', adx: 'ADX', roc_10: 'ROC 10', roc_60: 'ROC 60',
  bb_pct: 'Bollinger %B', bb_width: 'Bollinger width', volatility_20: '20-bar volatility', supertrend_dir: 'Supertrend direction', psar_dir: 'PSAR direction', cmf_20: 'Chaikin money flow',
  macd_hist_n: 'MACD histogram', di_diff: '+DI minus -DI', ret_h: 'return over the horizon', dist_sma20: 'distance to SMA20', dist_sma50: 'distance to SMA50', dist_ema200: 'distance to EMA200',
  dist_hma20: 'distance to HMA20', atr_pct: 'ATR %', vol_ratio: 'volume vs 20-bar average', vol_z: 'volume z-score', obv_slope: 'OBV slope', hl_range: 'bar range', body: 'bar body',
  range_pos: 'close position in bar', gap: 'gap', rv_ratio: 'short vs long volatility', dist_dc20: 'position in 20-bar channel', cloud_pos: 'position vs Ichimoku cloud',
  tod: 'time of day', tod_sin: 'time of day (sin)', tod_cos: 'time of day (cos)', dow_sin: 'day of week (sin)', dow_cos: 'day of week (cos)',
  mkt_ret_1: 'NIFTY 1-bar return', mkt_ret_5: 'NIFTY 5-bar return', mkt_ret_20: 'NIFTY 20-bar return', mkt_vol_20: 'NIFTY volatility', rel_5: 'return vs NIFTY (5 bars)', rel_20: 'return vs NIFTY (20 bars)' };
function featureLabel(k: string, names: Record<string, any>) {
  if (k.startsWith('v_')) { const s = names[k.slice(2)]; return (s ? s.name : k.slice(2)) + ' vote'; }
  if (FEATURE_LABEL[k]) return FEATURE_LABEL[k];
  const m = k.match(/^ret_(\d+)$/);
  return m ? `${m[1]}-bar return` : k.replace(/_/g, ' ');
}

/** The fields openLearning(p) reads - from a live analysis or a stored prediction. */
interface P {
  symbol: string; interval: string; horizon_bars: number; bar_time: string; direction: string; prob_up: number;
  target_price: number | null; stop_price: number | null; expected_move_pct: number | null; auto_outcome?: string | null;
  summary: any; signals: any[]; source?: string; id?: number | null; platt?: [number, number] | null;
}
const fromAnalysis = (a: LastAnalysis): P => ({ ...(a.result as any), symbol: a.symbol, interval: a.interval, id: a.result.prediction_id, platt: a.learner?.fit.platt ?? null });

export default function LearningScreen() {
  const c = useColors();
  const { id } = useLocalSearchParams<{ id?: string }>();
  const [list, setList] = useState<LastAnalysis[]>(allAnalyses());
  const [key, setKey] = useState<string | null>(latestAnalysis()?.key ?? null);
  const [stored, setStored] = useState<P | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => subscribe((a) => { setList(allAnalyses()); setKey(a.key); }), []);
  useEffect(() => {
    if (!id) { setStored(null); return; }
    getPrediction(Number(id)).then((r) => {
      if (!r) { setErr(`Prediction #${id} not found.`); return; }
      let summary: any = {}, signals: any[] = [];
      try { summary = JSON.parse(r.summary_json); signals = JSON.parse(r.signals_json); } catch { /* old row */ }
      setStored({ ...r, summary, signals });
    }).catch((e) => setErr((e as Error).message));
  }, [id]);

  const live = list.find((a) => a.key === key) ?? list[0] ?? null;
  const p: P | null = stored ?? (live ? fromAnalysis(live) : null);

  if (!p) {
    return (
      <Body>
        {err ? <Card><T color={c.down}>{err}</T></Card> : null}
        <Card>
          <T bold size={15}>No analysis yet</T>
          <Note>The learning view explains the latest analysis: what the walk-forward learner was trained on, how it validated, and why it made (or did not make) a call. Open a chart and tap Analyze - the first fit of a chart takes a while on a phone - then come back here.</Note>
          <View style={{ alignSelf: 'flex-start' }}><Button title="Open the Chart tab" onPress={() => router.navigate('/chart')} /></View>
        </Card>
      </Body>
    );
  }

  return (
    <Body>
      {stored ? (
        <Row gap={6} wrap><Badge>stored prediction #{stored.id}</Badge>{stored.source && stored.source !== 'live' ? <Badge>{stored.source}</Badge> : null}
          {list.length ? <Chip small label="Show latest analysis" onPress={() => router.setParams({ id: undefined as any })} /> : null}</Row>
      ) : list.length > 1 ? (
        <Row wrap gap={6}>{list.map((a) => <Chip key={a.key} small label={`${a.symbol} ${a.interval}`} on={a.key === live?.key} onPress={() => setKey(a.key)} />)}</Row>
      ) : null}
      <Learning p={p} />
    </Body>
  );
}

function Learning({ p }: { p: P }) {
  const c = useColors();
  const names: Record<string, any> = {};
  (p.signals || []).forEach((s) => (names[s.key] = s));
  const S = p.summary || {}, L = S.learner || null;
  const learners = (p.signals || []).filter((s) => s.category === 'ml' && s.key !== 'wf_ensemble');
  const fb: number = S.fallback_prob_up != null ? S.fallback_prob_up : p.prob_up;
  const noCall = p.direction === 'SIDEWAYS';
  const available = !!(L && L.available);
  const t = (available && L.tier) || {};
  const strength = Math.abs(p.prob_up - 0.5) + 0.5;
  const threshold: number = S.threshold ?? L?.threshold ?? 0.58;

  return (
    <>
      <Card accent={p.direction === 'UP' ? c.up : p.direction === 'DOWN' ? c.down : c.flat}>
        <H>What it predicted</H>
        <Row gap={8} wrap><CallBadge d={p.direction} /><T bold size={15}>{p.symbol}</T><T muted>{p.interval} · next {p.horizon_bars} bars after {whenBar(p.bar_time, p.interval)}</T></Row>
        <T size={13}>Calibrated P(up) <T bold>{pct(p.prob_up, 1)}</T> · {noCall ? 'no directional call' : `${p.direction} to ${fmt(p.target_price)}, stop ${fmt(p.stop_price)} (${(p.expected_move_pct ?? 0).toFixed(2)}% expected move)`}</T>
        {p.auto_outcome ? <Row gap={6}><T muted size={12.5}>graded</T><OutcomeBadge o={p.auto_outcome} /></Row> : null}
        <T muted size={12}>Source of the probability: {S.prob_source ?? '—'}</T>
      </Card>

      {available ? (
        <>
          <Card>
            <Grid>
              <KV k="Raw model P(up)" v={pct(L.prob_raw, 1)} />
              <KV k="After calibration" v={pct(L.prob_up, 1)} />
              <KV k="Call threshold" v={`≥ ${pct(L.threshold)} or ≤ ${pct(1 - L.threshold)}`} />
              <KV k="Validated accuracy" v={t.accuracy != null ? pct(t.accuracy) : '—'} sub="of past calls this strong" />
              <KV k="Similar past calls" v={t.n != null ? String(t.n) : '—'} sub={`${pct(t.coverage)} of bars`} />
              <KV k="Evidence" v={L.evidence ?? '—'} sub={EVIDENCE_LABEL[L.evidence] ?? ''} />
            </Grid>
          </Card>

          <Card>
            <H>How this call was reached</H>
            <Step n={1}>The 40 published strategies and 4 statistical models voted on the latest closed bar. Their weighted blend (the rule ensemble) says P(up) {pct(fb)}.</Step>
            <Step n={2}>Four learners trained on this chart's own history ({L.n_rows} bars, {L.n_features} inputs, including every strategy's past votes) give P(up) now: {learners.map((s) => `${shortName(s.name)} ${pct(s.values?.prob_up)}`).join(', ') || '—'}. Their average is {pct(L.prob_raw, 1)}.</Step>
            <Step n={3}>That average is calibrated (Platt scaling{p.platt ? `, a = ${p.platt[0].toFixed(2)}, b = ${p.platt[1].toFixed(2)}` : ''}) against how such raw scores actually turned out out-of-sample: {pct(L.prob_raw, 1)} → {pct(L.prob_up, 1)}.</Step>
            <Step n={4}>Call strength = |P − 50%| + 50% = {pct(strength, 1)}. {L.validated ? `The weakest strength at which past out-of-sample calls on this chart were right at least 55% of the time is ${pct(threshold)}.` : `No strength level reached 55% out-of-sample on this chart, so the learner is not validated and the threshold falls back to ${pct(threshold)}.`}</Step>
            <Step n={5}>{noCall
              ? `${pct(strength, 1)} is below ${pct(threshold)}, so the system stands aside: NO CALL. No-calls are not counted in accuracy.`
              : `${pct(strength, 1)} ≥ ${pct(threshold)}, so it calls ${p.direction}. Calls this strong were right ${t.accuracy != null ? pct(t.accuracy) : '—'} of the time on ${t.n ?? '—'} past bars, which sets the confidence; the target is the expected move (ATR / Monte-Carlo volatility over ${p.horizon_bars} bars).`}</Step>
          </Card>

          <Card>
            <H>Who voted what</H>
            <Table head={['Learner', 'P(up) now', 'WF acc.', 'Vote']} flex={[2.2, 1, 1, 1]}
              rows={[
                ...learners.map((s) => [s.name, pct(s.values?.prob_up), pct(s.values?.validation_accuracy), <VoteText key="v" d={s.direction} />]),
                ['Rule ensemble (strategies + models)', pct(fb), '—', <VoteText key="v" d={fb > 0.58 ? 1 : fb < 0.42 ? -1 : 0} />],
              ]} />
            <Note>The four learners are averaged and then calibrated on their own out-of-sample record, with recent bars weighted more (half-life {L.half_life} bars). A direction is called only beyond the strength at which such calls were right at least 55% of the time on this chart.</Note>
          </Card>

          <Card>
            <H>What it learned on this chart</H>
            <Grid>
              <KV k="Trained on" v={`${L.n_rows} bars`} sub={`${L.n_features} inputs`} />
              <KV k="Validation" v={`${L.folds} walk-forward folds`} sub="purged, expanding" />
              <KV k="Out-of-sample accuracy" v={pct(L.accuracy)} sub={`vs ${pct(L.base_rate)} always calling the drift`} />
              <KV k="Windows that closed higher" v={pct(L.up_rate)} />
              <KV k="Log-loss (lower = better)" v={Number(L.logloss).toFixed(3)} sub={`vs ${Number(L.logloss_base).toFixed(3)} drift`} />
              <KV k="Model fitted on bar" v={whenBar(L.fitted_on, p.interval)} />
            </Grid>
            <Note>Walk-forward: the models are trained on the past and tested on the next block of bars they never saw (the most recent 60% of history in {L.folds} expanding folds, with {p.horizon_bars} bars purged between train and test so the label windows do not overlap). Every accuracy here is out-of-sample.</Note>
          </Card>

          <Card>
            <H sub="Out-of-sample: of all past bars where the calibrated P(up) was at least this far from 50%, how often the call was right.">Accuracy by call strength</H>
            <Table head={['Strength', 'Calls', 'Share', 'Acc.', '']} flex={[2, 0.8, 0.8, 0.8, 1.3]}
              highlight={(i) => (L.tiers || [])[i]?.threshold === t.threshold}
              rows={(L.tiers || []).map((x: any) => [
                `P ≥ ${x.threshold.toFixed(2)} / ≤ ${(1 - x.threshold).toFixed(2)}`, String(x.n), pct(x.coverage),
                <T key="a" size={12.5} bold color={x.accuracy == null ? c.muted : x.accuracy >= 0.55 ? c.up : c.down}>{x.accuracy == null ? '—' : pct(x.accuracy)}</T>,
                <View key="b" style={{ gap: 2, alignItems: 'flex-end' }}>
                  {x.threshold === L.threshold ? <Badge tone="ok">threshold</Badge> : null}
                  {t.threshold === x.threshold ? <Badge>this call</Badge> : null}
                </View>,
              ])} />
            <Note>The 55% rule: the call threshold is the weakest strength whose past calls reached 55% accuracy. Below it the system says NO CALL rather than guess. A row only counts with at least max(30, 2 × horizon) calls. If none reaches 55% the learner is not validated on this chart: the threshold falls back to 0.60 and any call carries evidence "none".</Note>
          </Card>

          <Card>
            <H>Evidence grade</H>
            <T size={13}>This call: <T bold>{L.evidence}</T> - z = {L.edge_z ?? '—'} on ~{L.effective_n ?? '—'} independent outcomes. Whole fit: <T bold>{L.fit_evidence ?? '—'}</T> (z = {L.fit_edge_z ?? '—'}, ~{L.fit_effective_n ?? '—'}).</T>
            <Note>Beating a coin flip is not enough: if {pct(L.base_rate)} of windows went the same way, always calling that side scores {pct(L.base_rate)}. The grade asks how many standard errors the tier's accuracy sits above that drift, counting only ~n / {p.horizon_bars} independent outcomes (neighbouring bars share most of their {p.horizon_bars}-bar future).</Note>
            {(['strong', 'weak', 'drift', 'none'] as const).map((k) => (
              <Row key={k} gap={8} style={{ paddingVertical: 2 }}>
                <View style={{ width: 58 }}><Badge tone={k === 'strong' ? 'ok' : k === 'weak' ? 'mid' : k === 'drift' ? 'bad' : 'plain'}>{k}</Badge></View>
                <T size={12} style={{ flex: 1 }} bold={L.evidence === k}>{k === 'strong' ? 'z ≥ 1.64: beats the drift at ~95% one-sided confidence.' : k === 'weak' ? '0.8 ≤ z < 1.64: probably beats the drift.' : k === 'drift' ? 'z < 0.8: no better than following the prevailing trend.' : 'not validated (no strength level reached 55%) or no calls.'}</T>
              </Row>
            ))}
          </Card>

          <Card>
            <H>Learners (walk-forward)</H>
            <Table head={['Learner', 'Accuracy', 'Log-loss']} flex={[2.4, 1, 1]}
              rows={Object.entries(L.learners || {}).map(([k, v]: [string, any]) => [names[k] ? names[k].name : k, pct(v.accuracy), Number(v.logloss).toFixed(3)])} />
          </Card>

          <Weights lw={L.learned_weights || {}} names={names} />

          {L.top_features?.length ? (
            <Card>
              <H sub="Random Forest importance">Most informative inputs</H>
              <Row wrap gap={6}>{L.top_features.map(([k, w]: [string, number]) => <Badge key={k}>{featureLabel(k, names)} · {(w * 100).toFixed(1)}%</Badge>)}</Row>
            </Card>
          ) : null}
        </>
      ) : (
        <Card>
          <H>Rule ensemble only</H>
          <Note>{L ? L.reason || '' : 'This prediction was made before the learning layer existed.'} P(up) = 0.65 × weighted strategy votes ({pct(S.rule_prob_up)}) + 0.35 × statistical models ({S.model_prob_up != null ? pct(S.model_prob_up) : '—'}); a direction is called beyond {pct(S.threshold || 0.58)}.</Note>
        </Card>
      )}

      <Card>
        <H>Rule ensemble behind it</H>
        <Note>Bull / bear score {S.bull_score} / {S.bear_score} · {S.agreeing} of {S.voters} voters agree with the call · regime {S.regime || '—'} (Hurst {S.hurst}). Per-strategy hit rates on the Accuracy screen adjust the rule weights; the learned weights above are re-estimated on this chart every {Math.max(2, Math.floor(p.horizon_bars / 2))} bars.</Note>
      </Card>
    </>
  );
}

const shortName = (n: string) => n.replace(/ \(walk-forward\)| \(Wolpert\)/g, '');

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  const c = useColors();
  return (
    <Row gap={8} style={{ alignItems: 'flex-start' }}>
      <View style={{ width: 20, height: 20, borderRadius: 10, backgroundColor: c.accent, alignItems: 'center', justifyContent: 'center', marginTop: 1 }}><T size={11} bold color="#fff">{n}</T></View>
      <T size={12.5} style={{ flex: 1, lineHeight: 18 }}>{children}</T>
    </Row>
  );
}

function Weights({ lw, names }: { lw: Record<string, number>; names: Record<string, any> }) {
  const c = useColors();
  const all = Object.entries(lw).sort((a, b) => b[1] - a[1]);
  if (!all.length) return null;
  const maxw = Math.max(0.01, ...all.map(([, w]) => Math.abs(w)));
  const pos = all.filter(([, w]) => w > 0.05), neg = all.filter(([, w]) => w < -0.05).reverse(), flat = all.length - pos.length - neg.length;
  const row = ([k, w]: [string, number]) => (
    <Row key={k} gap={6} style={{ paddingVertical: 2 }}>
      <T size={12.5} style={{ flex: 1 }} numberOfLines={1}>{names[k] ? names[k].name : k}</T>
      <View style={{ width: 90, height: 6, backgroundColor: c.panel2, borderRadius: 3, overflow: 'hidden' }}><View style={{ width: (Math.abs(w) / maxw) * 90, height: 6, backgroundColor: w >= 0 ? c.up : c.down }} /></View>
      <T size={12.5} bold color={w >= 0 ? c.up : c.down} style={{ width: 44, textAlign: 'right' }}>{w > 0 ? '+' : ''}{w.toFixed(2)}</T>
    </Row>
  );
  return (
    <Card>
      <H sub="Stacked model over every strategy's past votes on this chart: + = its vote has been right here (trust it), − = it has been contrarian here (fade it).">Weight learned for each strategy</H>
      <T bold size={12} color={c.up}>Trusted here ({pos.length})</T>
      {pos.length ? pos.map(row) : <T muted size={12}>none</T>}
      <T bold size={12} color={c.down} style={{ marginTop: 6 }}>Faded here ({neg.length})</T>
      {neg.length ? neg.map(row) : <T muted size={12}>none</T>}
      {flat ? <T muted size={11.5}>{flat} more near zero (|w| ≤ 0.05): little information on this chart.</T> : null}
    </Card>
  );
}
