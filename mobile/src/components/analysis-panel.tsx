/**
 * The call card under the chart - the web app's #prediction-card plus its Signals and Indicators tabs:
 * UP / DOWN / NO CALL with P(up), validated accuracy and evidence, entry / target / stop (also drawn on the
 * chart), the Groww-costed trade plan, details (next bar, confidence, agreement, regime, category scores),
 * every strategy's vote with its weight, learned weight and track record, and the indicator / level values.
 */
import { useEffect, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';

import type { StrategyStats } from '@/engine/ensemble';
import { adaptiveMultiplier } from '@/engine/ensemble';
import type { TradePlan } from '@/engine/trading';
import { barIsForming, type Fetched } from '@/engine/yahoo';
import { AnalysisResult, analyze } from '@/services/analysis';
import { onLearnerProgress } from '@/services/learner';
import { addFeedback, strategyStats } from '@/services/predictions';
import { trader } from '@/services/trader';
import { Badge, Button, Card, Chip, Row, Stat, T, fmt, inr, pct, signed, useColors } from '@/ui/kit';

const EVIDENCE: Record<string, string> = {
  strong: 'out-of-sample calls this strong beat simply following the drift by 1.64+ standard errors.',
  weak: 'calls this strong beat following the drift, but only by about 0.8-1.6 standard errors.',
  drift: 'these calls were right only as often as betting on the recent drift - no edge beyond it.',
  none: 'no validated edge on this chart; treat the direction as a lean, not a call.',
};
const CATEGORIES: [string, string][] = [['', 'All'], ['trend', 'Trend'], ['momentum', 'Momentum'], ['volatility', 'Volatility'], ['volume', 'Volume'], ['price_action', 'Price action'], ['levels', 'Levels'], ['statistical', 'Models'], ['ml', 'ML']];
const catOf = (r: { category: string }) => (r.category === 'model' || r.category === 'regime' ? 'statistical' : r.category);

export function AnalysisPanel({ symbol, interval, fetched, horizon, auto, onResult, onPlan }: {
  symbol: string; interval: string; fetched: Fetched; horizon: number; auto: boolean;
  onResult: (r: AnalysisResult | null) => void; onPlan: (p: TradePlan | null) => void;
}) {
  const c = useColors();
  const [res, setRes] = useState<AnalysisResult | null>(null);
  const [plan, setPlan] = useState<TradePlan | null>(null);
  const [stats, setStats] = useState<StrategyStats>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [prog, setProg] = useState<string | null>(null);
  const [open, setOpen] = useState<'details' | 'signals' | 'indicators' | null>(null);
  const [cat, setCat] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const running = useRef(false);
  const fetchedRef = useRef(fetched);
  fetchedRef.current = fetched;

  useEffect(() => onLearnerProgress((stage, d, t) => setProg(stage === 'votes' ? `Scoring 40 strategies on past bars ${d}/${t}` : `Training and validating the learner ${d}/${t}`)), []);
  useEffect(() => { setRes(null); setPlan(null); setMsg(null); setErr(null); onResult(null); onPlan(null); }, [symbol, interval]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async () => {
    if (running.current) return;
    running.current = true; setBusy(true); setErr(null); setMsg(null);
    try {
      const f = fetchedRef.current;
      const out = await analyze(symbol, interval, f, { horizon });
      setRes(out.result); onResult(out.result);
      const p = await trader().buildPlan(out.result as any, { bars: f.bars });
      setPlan(p); onPlan(p);
      setStats(await strategyStats());
    } catch (e) { setErr((e as Error).message); }
    finally { running.current = false; setBusy(false); setProg(null); }
  };
  // auto: re-run whenever a new bar has closed (the web app's "Auto" toggle)
  const t = fetched.bars.t, nT = t.length;
  const lastClosed = nT && barIsForming(fetched.dataSymbol, interval, t[nT - 1]) ? t[nT - 2] : t[nT - 1];
  useEffect(() => { if (auto && res) run(); }, [lastClosed]); // eslint-disable-line react-hooks/exhaustive-deps
  const place = async () => {
    if (!res || !plan?.available) return;
    try { const tr = await trader().placeTrade(symbol, interval, plan, res.prediction_id); setMsg(`Paper trade #${tr.id} placed - see Portfolio.`); }
    catch (e) { setErr((e as Error).message); }
  };
  const grade = async (v: 'correct' | 'incorrect' | 'partial') => {
    if (!res?.prediction_id) return;
    await addFeedback(res.prediction_id, v);
    setStats(await strategyStats());
    setMsg(`Marked ${v}. Strategy track records updated.`);
  };

  if (!res) {
    return (
      <Card>
        <Row style={{ justifyContent: 'space-between' }}>
          <T bold size={15}>Analysis · next {horizon} bars</T>
          <Button title="Analyze" onPress={run} busy={busy} />
        </Row>
        <T muted size={12.5}>Runs 40 published strategies and 5 statistical models on this chart; a walk-forward validated learner makes the call - UP, DOWN or NO CALL - with the accuracy calls that strong had out of sample. Everything is computed on this phone.</T>
        {busy ? <T muted size={12}>{prog ?? 'Analysing…'} · the first analysis of a chart trains the model (can take a minute on a phone); later ones take a second.</T> : null}
        {err ? <T color={c.down} size={12}>{err}</T> : null}
      </Card>
    );
  }
  const s: any = res.summary, L = s.learner ?? {};
  const dirColor = res.direction === 'UP' ? c.up : res.direction === 'DOWN' ? c.down : c.flat;
  const signals = res.signals.slice().sort((a, b) => Math.abs(b.contribution ?? 0) - Math.abs(a.contribution ?? 0));
  const shown = signals.filter((r) => !cat || catOf(r) === cat);
  const nb = res.next_bar;
  const cats = Object.entries(s.categories ?? {}) as [string, { bull: number; bear: number; count: number }][];
  const maxCat = Math.max(0.001, ...cats.map(([, v]) => Math.max(v.bull, v.bear)));
  const tab = (k: 'details' | 'signals' | 'indicators', label: string) => <Chip small label={label} on={open === k} onPress={() => setOpen(open === k ? null : k)} />;

  return (
    <Card accent={dirColor}>
      <Row style={{ justifyContent: 'space-between' }}>
        <T bold size={15}>{res.symbol.replace(/\.(NS|BO)$/, '')} · {interval} · next {res.horizon_bars} bars</T>
        <Button title="Re-run" kind="plain" onPress={run} busy={busy} />
      </Row>
      {busy && prog ? <T muted size={12}>{prog}</T> : null}
      <Row gap={10} wrap>
        <T bold size={28} color={dirColor}>{res.direction === 'SIDEWAYS' ? 'NO CALL' : res.direction}</T>
        <View style={{ flex: 1, minWidth: 160, gap: 3 }}>
          <View style={{ height: 10, borderRadius: 5, backgroundColor: c.down + '55', overflow: 'hidden' }}>
            <View style={{ width: `${res.prob_up * 100}%`, height: 10, backgroundColor: c.up }} />
          </View>
          <T size={12}>P(up) <T bold size={12}>{pct(res.prob_up, 1)}</T> · call threshold {pct(s.threshold, 0)} / {pct(1 - s.threshold, 0)}</T>
        </View>
      </Row>
      <T size={12.5}><T bold size={12.5}>Validated </T>{s.expected_accuracy != null ? pct(s.expected_accuracy, 1) : '—'} <T muted size={12}>· {s.prob_source}</T></T>
      <T muted size={12}>{L.available === false ? `Learner: ${L.reason ?? 'not available'}` : L.evidence ? `Evidence: ${L.evidence} - ${EVIDENCE[L.evidence] ?? ''}` : ''}{res.learner_error ? ` Learner error: ${res.learner_error}` : ''}</T>
      <Row wrap gap={12}>
        <Stat k="entry" v={fmt(res.price_at)} />
        <Stat k="target" v={res.direction === 'SIDEWAYS' ? '—' : fmt(res.target_price)} color={dirColor} />
        <Stat k="stop" v={fmt(res.stop_price)} color={c.flat} />
        <Stat k="risk:reward" v={s.risk_reward ?? '—'} />
        <Stat k="exp. move" v={signed(res.expected_move_pct)} />
      </Row>
      <NowLine res={res} price={fetched.bars.c[fetched.bars.c.length - 1]} />
      <T muted size={11}>Entry, target, stop and the forecast cone are drawn on the chart (Overlays → Target / stop).</T>

      {plan ? (
        <View style={{ borderTopWidth: 1, borderTopColor: c.border, paddingTop: 8, gap: 4 }}>
          <T bold>Trade plan (Groww charges included)</T>
          {plan.available ? (
            <>
              <Row wrap gap={4}>
                <Badge tone={plan.verdict === 'trade' ? 'ok' : plan.verdict === 'wait' ? 'mid' : 'bad'}>{(plan.verdict ?? '').toUpperCase()}</Badge>
                {plan.side ? <Badge>{`${plan.side} ${plan.entry_type} ${fmt(plan.entry)}${plan.level_name ? ` at ${plan.level_name}` : ''}`}</Badge> : null}
              </Row>
              {(plan.reasons ?? []).map((r) => <T key={r} muted size={12}>• {r}</T>)}
              {plan.best ? (
                <Row wrap gap={12}>
                  <Stat k="qty" v={plan.qty ?? '—'} /><Stat k="stop" v={fmt(plan.stop)} /><Stat k={`target (${plan.best.target_name})`} v={fmt(plan.best.target)} />
                  <Stat k="mode" v={plan.best.mode} /><Stat k="charges" v={inr(plan.best.charges.total)} />
                  <Stat k="net if target" v={inr(plan.best.net_win)} color={c.up} /><Stat k="net if stop" v={`−${inr(Math.abs(plan.best.net_loss))}`} color={c.down} />
                  <Stat k="expectancy" v={plan.best.expectancy == null ? '—' : inr(plan.best.expectancy)} /><Stat k="deadline" v={plan.best.deadline_label} />
                </Row>
              ) : null}
              {plan.verdict === 'trade' ? <View style={{ alignSelf: 'flex-start' }}><Button title="Paper trade this plan" onPress={place} /></View> : <T muted size={11.5}>Use the order ticket below to trade anyway ("From plan" fills it).</T>}
            </>
          ) : <T muted size={12}>{plan.reason}</T>}
        </View>
      ) : null}

      <Row wrap gap={6} style={{ marginTop: 4 }}>{tab('details', 'Details')}{tab('signals', `Signals (${res.signals.length})`)}{tab('indicators', 'Indicators & levels')}</Row>

      {open === 'details' ? (
        <View style={{ gap: 6 }}>
          {nb ? <T size={12.5}><T bold size={12.5}>Next bar: </T>{nb.direction === 'SIDEWAYS' ? 'no call' : nb.direction} · expected close {fmt(nb.expected_close)} · range {fmt(nb.range_low)} – {fmt(nb.range_high)}</T> : null}
          <Row wrap gap={12}>
            <Stat k="confidence" v={pct(res.confidence)} /><Stat k="agreement" v={`${pct(s.agreement)} of ${s.voters}`} />
            <Stat k="expected move" v={signed(res.expected_move_pct)} />
            <Stat k="valid until ≈" v={new Date(res.expires_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} />
            <Stat k="regime" v={`${s.regime ?? '—'} (H ${s.hurst})`} /><Stat k="bull / bear" v={`${s.bull_score} / ${s.bear_score}`} />
            <Stat k="rule P(up)" v={pct(s.rule_prob_up)} /><Stat k="model P(up)" v={s.model_prob_up == null ? '—' : pct(s.model_prob_up)} />
          </Row>
          {cats.map(([k, v]) => (
            <View key={k} style={{ gap: 2 }}>
              <T muted size={11}>{k} · {v.count} · bear {v.bear.toFixed(2)} / bull {v.bull.toFixed(2)}</T>
              <Row gap={2}>
                <View style={{ flex: 1, alignItems: 'flex-end' }}><View style={{ height: 7, width: `${(v.bear / maxCat) * 100}%`, backgroundColor: c.down, borderRadius: 3 }} /></View>
                <View style={{ flex: 1 }}><View style={{ height: 7, width: `${(v.bull / maxCat) * 100}%`, backgroundColor: c.up, borderRadius: 3 }} /></View>
              </Row>
            </View>
          ))}
          <T muted size={11}>Analytics for research and education only. Not investment advice. Markets can move against every indicator.</T>
        </View>
      ) : null}

      {open === 'signals' ? (
        <View style={{ gap: 4 }}>
          <T muted size={11.5}>Every strategy votes. Weight = base × regime × track record. L = the weight the walk-forward model learned for it on this chart (negative = contrarian here). Tap a row for its values.</T>
          <Row wrap gap={5}>{CATEGORIES.map(([k, tt]) => <Chip key={k} small label={tt} on={cat === k} onPress={() => setCat(k)} />)}</Row>
          {shown.map((r) => {
            const st = stats[r.key], n = st ? st.correct + st.incorrect : 0;
            const vote = r.direction > 0 ? '▲' : r.direction < 0 ? '▼' : '•';
            return (
              <Pressable key={r.key} onPress={() => setExpanded(expanded === r.key ? null : r.key)} style={{ paddingVertical: 5, borderBottomWidth: 1, borderBottomColor: c.border }}>
                <Row style={{ justifyContent: 'space-between' }}>
                  <T size={12.5} style={{ flex: 1 }}><T bold size={12.5} color={r.direction > 0 ? c.up : r.direction < 0 ? c.down : c.muted}>{vote} {r.name}</T> <T muted size={11}>{catOf(r)}</T></T>
                  <T muted size={11}>{Math.round(r.confidence * 100)}% · w {r.weight}{r.learned_weight != null ? ` · L ${r.learned_weight}` : ''}</T>
                </Row>
                <T muted size={11.5}>{r.reason}</T>
                <T muted size={10.5}>{n ? `track record ${st!.correct}/${n} (${Math.round((st!.correct / n) * 100)}%) · weight ×${adaptiveMultiplier(st).toFixed(2)}` : 'no graded track record yet'}</T>
                {expanded === r.key ? (
                  <View style={{ marginTop: 3 }}>
                    <T muted size={11}>{r.origin}</T>
                    <T muted size={11}>{r.rules}</T>
                    <T size={11}>{Object.entries(r.values ?? {}).map(([k, v]) => `${k}: ${typeof v === 'number' ? Math.round(v * 1e4) / 1e4 : String(v)}`).join(' · ')}</T>
                  </View>
                ) : null}
              </Pressable>
            );
          })}
        </View>
      ) : null}

      {open === 'indicators' ? <IndicatorsGrid res={res} /> : null}

      <Row wrap gap={6} style={{ marginTop: 4 }}>
        <T muted size={12}>Grade this call:</T>
        <Button title="✓ correct" kind="plain" onPress={() => grade('correct')} /><Button title="~ partial" kind="plain" onPress={() => grade('partial')} /><Button title="✗ wrong" kind="plain" onPress={() => grade('incorrect')} />
      </Row>
      {msg ? <T size={12} color={c.up}>{msg}</T> : null}
      {err ? <T size={12} color={c.down}>{err}</T> : null}
      <T muted size={11}>Prediction #{res.prediction_id} saved on this phone · graded automatically after {res.horizon_bars} bars · More → History for all calls, More → Learning for what the model learned.</T>
    </Card>
  );
}

function IndicatorsGrid({ res }: { res: AnalysisResult }) {
  const s: any = res.summary;
  const ind = Object.entries(res.indicators ?? {});
  const levels: [string, Record<string, any> | undefined][] = [['Floor pivots', s.pivots], ['CPR', s.cpr], ['Camarilla', s.camarilla], ['VWAP bands', s.vwap_bands], ['Value area', s.value_area], ['Fibonacci', s.fibonacci?.levels]];
  const show = (v: unknown) => (typeof v === 'number' ? (Math.abs(v) >= 1000 ? fmt(v, 0) : fmt(v, 2)) : typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v ?? '—'));
  return (
    <View style={{ gap: 8 }}>
      <Row wrap gap={10}>{ind.map(([k, v]) => <Stat key={k} k={k.replace(/_/g, ' ')} v={show(v)} />)}</Row>
      {levels.filter(([, v]) => v && Object.keys(v).length).map(([name, v]) => (
        <View key={name} style={{ gap: 2 }}>
          <T bold size={12.5}>{name}</T>
          <Row wrap gap={10}>{Object.entries(v!).filter(([k]) => !['ref_time', 'bars', 'narrow'].includes(k)).map(([k, x]) => <Stat key={k} k={k} v={show(x)} />)}</Row>
        </View>
      ))}
      <T muted size={11}>Levels use the previous session on intraday charts and the previous bar on daily / weekly charts.</T>
    </View>
  );
}

/** The web app's "Now" row: live price versus the call's entry, and how far it is towards the target (or the stop). */
function NowLine({ res, price }: { res: AnalysisResult; price: number }) {
  const c = useColors();
  if (!Number.isFinite(price) || !res.price_at) return null;
  const since = price / res.price_at - 1;
  let prog = '', tone = c.muted;
  if (res.direction !== 'SIDEWAYS' && res.target_price && res.stop_price) {
    const span = Math.abs(res.target_price - res.price_at), done = (price - res.price_at) * (res.direction === 'UP' ? 1 : -1);
    if (done >= span) { prog = ' · target reached'; tone = c.up; }
    else if (res.direction === 'UP' ? price <= res.stop_price : price >= res.stop_price) { prog = ' · stop hit'; tone = c.down; }
    else prog = ` · ${Math.max(-999, Math.min(999, (done / span) * 100)).toFixed(0)}% of the way to target`;
  }
  return (
    <T size={12.5}>Now <T bold size={12.5}>{fmt(price)}</T> <T size={12.5} color={since >= 0 ? c.up : c.down}>{since >= 0 ? '+' : ''}{(since * 100).toFixed(2)}%</T> since entry<T size={12.5} color={tone}>{prog}</T></T>
  );
}
