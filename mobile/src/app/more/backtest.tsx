/**
 * Backtest - port of POST /api/backtest (evaluator.backtest) and the as-of analysis (POST /api/analyze with
 * as_of): the full analysis at N past points, each using only the bars before it, graded against what
 * happened next; the hit rate is shown next to the base rate (always calling the majority side).
 */
import { useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Switch, TextInput, View } from 'react-native';

import { DEFAULT_HORIZON } from '@/engine/ensemble';
import { Body, CallBadge, H, Note, OutcomeBadge, whenBar } from '@/components/more/common';
import { BacktestResult, GradedPoint, analyzeAsOf, backtest, summarise } from '@/services/backtest';
import { latestAnalysis } from '@/services/last-analysis';
import { onLearnerProgress } from '@/services/learner';
import { Badge, Button, Card, Choice, ErrorBox, Row, T, Tile, fmt, pct, useColors } from '@/ui/kit';

const INTERVALS: [string, string][] = [['5m', '5m'], ['15m', '15m'], ['30m', '30m'], ['1h', '1h'], ['1d', '1D'], ['1wk', '1W']];
const POINTS: [number, string][] = [[5, '5'], [10, '10'], [20, '20'], [30, '30'], [50, '50']];

export default function BacktestScreen() {
  const c = useColors();
  const params = useLocalSearchParams<{ symbol?: string; interval?: string }>();
  const last = latestAnalysis();
  const [symbol, setSymbol] = useState(params.symbol ?? last?.symbol ?? 'RELIANCE.NS');
  const [interval, setInterval_] = useState(params.interval ?? last?.interval ?? '1d');
  const [horizon, setHorizon] = useState('');
  const [steps, setSteps] = useState(10);
  const [stepBars, setStepBars] = useState('');
  const [save, setSave] = useState(true);
  const [running, setRunning] = useState(false);
  const [prog, setProg] = useState<{ done: number; total: number; stage: string; started: number } | null>(null);
  const [points, setPoints] = useState<GradedPoint[]>([]);
  const [res, setRes] = useState<BacktestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asOf, setAsOf] = useState('');
  const [asOfBusy, setAsOfBusy] = useState(false);
  const [asOfOut, setAsOfOut] = useState<{ point: GradedPoint; barsAfter: number; horizon: number } | null>(null);
  const cancel = useRef({ cancelled: false });
  const [, force] = useState(0);

  const hDefault = DEFAULT_HORIZON[interval] ?? 10;
  const h = Math.max(1, Math.min(200, Number(horizon) || hDefault));

  // learner sub-progress (votes / folds) while a point is being analysed; a clock for elapsed / ETA
  useEffect(() => onLearnerProgress((stage, d, t) => {
    if (!running) return;
    setProg((p) => (p ? { ...p, stage: stage === 'votes' ? `scoring strategies on past bars ${d}/${t}` : `training + validating the learner, fold ${d}/${t}` } : p));
  }), [running]);
  useEffect(() => { if (!running) return; const id = setInterval(() => force((x) => x + 1), 1000); return () => clearInterval(id); }, [running]);

  const run = async () => {
    cancel.current = { cancelled: false };
    setRunning(true); setError(null); setRes(null); setPoints([]);
    setProg({ done: 0, total: steps, stage: 'downloading bars', started: Date.now() });
    const got: GradedPoint[] = [];
    try {
      const r = await backtest(symbol.trim(), interval, {
        horizon: h, steps, stepBars: Number(stepBars) || undefined, save, cancel: cancel.current,
        onProgress: (done, total, pt) => {
          if (pt) { got.push(pt); setPoints([...got]); }
          setProg((p) => ({ done, total, stage: done < total ? 'analysing the next point' : 'done', started: p?.started ?? Date.now() }));
        },
      });
      setRes(r);
    } catch (e) {
      setError((e as Error).message);
      if (got.length) setRes(summarise(symbol.trim().toUpperCase(), interval, h, got, true, 0));
    } finally { setRunning(false); }
  };

  const runAsOf = async () => {
    const m = asOf.trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?$/);
    if (!m) { setError('As-of: enter a date as YYYY-MM-DD (optionally with HH:MM, India time).'); return; }
    // IST wall clock -> UTC epoch; a bare date means the end of that day's session
    const [hh, mm] = m[4] ? [Number(m[4]), Number(m[5])] : [23, 59];
    const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), hh, mm) / 1000 - 19800;
    setAsOfBusy(true); setError(null); setAsOfOut(null);
    try {
      const out = await analyzeAsOf(symbol.trim(), interval, t, { horizon: h, save });
      setAsOfOut({ point: out.point, barsAfter: out.barsAfter, horizon: out.result.horizon_bars });
    } catch (e) { setError((e as Error).message); } finally { setAsOfBusy(false); }
  };

  const elapsed = prog ? (Date.now() - prog.started) / 1000 : 0;
  const eta = prog && prog.done > 0 && prog.done < prog.total ? (elapsed / prog.done) * (prog.total - prog.done) : null;
  const shown = res ?? (points.length ? summarise(symbol, interval, h, points, false, elapsed) : null);

  return (
    <Body>
      <Card>
        <TextInput value={symbol} onChangeText={setSymbol} placeholder="Symbol (RELIANCE.NS, TCS, ^NSEI)" placeholderTextColor={c.muted} autoCapitalize="characters" autoCorrect={false} editable={!running}
          style={{ borderWidth: 1, borderColor: c.border, borderRadius: 9, paddingHorizontal: 10, paddingVertical: 8, color: c.text, backgroundColor: c.bg, fontWeight: '700' }} />
        <Choice small label="Interval" value={interval} onChange={(v) => { setInterval_(v); setHorizon(''); setStepBars(''); }} options={INTERVALS} />
        <Choice small label="Past points" value={steps} onChange={setSteps} options={POINTS} />
        <Row gap={10}>
          <Field label="Horizon (bars)" value={horizon} onChange={setHorizon} placeholder={String(hDefault)} />
          <Field label="Bars between points" value={stepBars} onChange={setStepBars} placeholder={String(h)} />
        </Row>
        <Row gap={8}>
          <Switch value={save} onValueChange={setSave} disabled={running} />
          <T size={12.5} style={{ flex: 1 }}>Save to History (source “backtest”) - graded, so they feed the per-strategy accuracy stats</T>
        </Row>
        <Row gap={8}>
          <View style={{ flex: 1 }}><Button title={running ? 'Running…' : `Run ${steps} past points`} onPress={run} busy={running} /></View>
          {running ? <Button title="Cancel" kind="danger" onPress={() => { cancel.current.cancelled = true; setProg((p) => (p ? { ...p, stage: 'stopping after this point…' } : p)); }} /> : null}
        </Row>
        <Note>Each point sees only the bars up to it: indicators, strategy votes and the walk-forward learner are rebuilt from that past, then the call is graded on the {h} bars that followed. The learner refits at every point - tens of seconds each on a phone.</Note>
      </Card>

      {prog && running ? (
        <Card>
          <Row><T bold style={{ flex: 1 }}>Point {Math.min(prog.done + 1, prog.total)} of {prog.total}</T><T muted size={12}>{Math.round(elapsed)} s{eta != null ? ` · ~${Math.round(eta)} s left` : ''}</T></Row>
          <View style={{ height: 5, backgroundColor: c.panel2, borderRadius: 3, overflow: 'hidden' }}><View style={{ height: 5, width: `${(prog.done / prog.total) * 100}%`, backgroundColor: c.accent }} /></View>
          <T muted size={12}>{prog.stage}</T>
        </Card>
      ) : null}
      {error ? <ErrorBox message={error} /> : null}

      {shown && shown.steps ? <Summary r={shown} running={running} /> : null}
      {points.slice().reverse().map((p, i) => <PointRow key={p.bar_time + i} p={p} interval={interval} />)}

      <Card>
        <H sub="Analyse one past moment with only the data available then; if the horizon has passed it is graded at once.">As-of analysis</H>
        <Row gap={8}>
          <TextInput value={asOf} onChangeText={setAsOf} placeholder="YYYY-MM-DD or YYYY-MM-DD HH:MM" placeholderTextColor={c.muted} autoCorrect={false}
            style={{ flex: 1, borderWidth: 1, borderColor: c.border, borderRadius: 9, paddingHorizontal: 10, paddingVertical: 8, color: c.text, backgroundColor: c.bg }} />
          <Button title="Analyse" onPress={runAsOf} busy={asOfBusy} disabled={running} />
        </Row>
        {asOfOut ? (
          <>
            <PointRow p={asOfOut.point} interval={interval} flat />
            {!asOfOut.point.outcome ? <T muted size={12}>Only {asOfOut.barsAfter} of {asOfOut.horizon} bars have printed since - not graded yet{save ? '; the auto-evaluator will grade it' : ''}.</T> : null}
          </>
        ) : null}
      </Card>
    </Body>
  );
}

function Field({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (s: string) => void; placeholder: string }) {
  const c = useColors();
  return (
    <View style={{ flex: 1, gap: 4 }}>
      <T muted size={11} style={{ textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</T>
      <TextInput value={value} onChangeText={(s) => onChange(s.replace(/[^0-9]/g, ''))} keyboardType="number-pad" placeholder={placeholder} placeholderTextColor={c.muted}
        style={{ borderWidth: 1, borderColor: c.border, borderRadius: 9, paddingHorizontal: 10, paddingVertical: 7, color: c.text, backgroundColor: c.bg }} />
    </View>
  );
}

function Summary({ r, running }: { r: BacktestResult; running: boolean }) {
  const c = useColors();
  const edge = r.accuracy != null && r.base_rate != null ? r.accuracy - r.base_rate : null;
  return (
    <Card>
      <Row><T bold size={15} style={{ flex: 1 }}>{r.symbol} · {r.interval} · {r.horizon_bars}-bar horizon</T>{r.cancelled ? <Badge tone="mid">stopped early</Badge> : running ? <Badge>so far</Badge> : null}</Row>
      <Row wrap gap={6}>
        <Tile k="Hit rate of calls" v={r.accuracy == null ? '—' : pct(r.accuracy)} color={edge == null ? undefined : edge > 0 ? c.up : c.down} sub={`${r.correct} ✔ / ${r.incorrect} ✘`} />
        <Tile k="Base rate" v={r.base_rate == null ? '—' : pct(r.base_rate)} sub={r.up_rate == null ? '' : `${pct(r.up_rate)} of windows rose`} />
        <Tile k="Calls / no call" v={`${r.calls} / ${r.no_call}`} sub={`${r.steps} points`} />
      </Row>
      {Object.entries(r.by_direction).map(([d, b]) => (
        <T key={d} size={12.5}>{d === 'SIDEWAYS' ? 'No call' : `${d} calls`}: {d === 'SIDEWAYS' ? `${b.no_call}` : `${b.correct} right, ${b.incorrect} wrong`}</T>
      ))}
      <Note>Base rate = what always calling the majority side of these same windows would have scored. A hit rate above it is an edge; with only {r.calls} graded calls the uncertainty is about ±{r.calls ? Math.round(100 / Math.sqrt(r.calls)) : '—'} points, so treat small samples as a hint, not proof.{r.seconds ? ` Took ${Math.round(r.seconds)} s.` : ''}</Note>
    </Card>
  );
}

function PointRow({ p, interval, flat }: { p: GradedPoint; interval: string; flat?: boolean }) {
  const c = useColors();
  const accent = p.outcome === 'correct' ? c.up : p.outcome === 'incorrect' ? c.down : undefined;
  const body = (
    <>
      <Row gap={6}>
        <T bold size={13} style={{ flex: 1 }}>{whenBar(p.bar_time, interval)}</T>
        <CallBadge d={p.direction} />
        <OutcomeBadge o={p.outcome} pendingLabel="not graded" />
      </Row>
      <Row gap={10} wrap>
        <T size={12}>P(up) <T bold size={12}>{pct(p.prob_up)}</T></T>
        <T size={12}>{fmt(p.price_at)} → {p.target_price == null ? 'no call' : fmt(p.target_price)}</T>
        {p.resolved_price != null ? <T size={12} color={(p.actual_move_pct ?? 0) >= 0 ? c.up : c.down}>closed {fmt(p.resolved_price)} ({(p.actual_move_pct ?? 0) >= 0 ? '+' : ''}{(p.actual_move_pct ?? 0).toFixed(2)}%)</T> : null}
      </Row>
      <T muted size={11.5}>{p.prob_source}{p.expected_accuracy != null ? ` · validated ${pct(p.expected_accuracy)}` : ''}{p.evidence ? ` · evidence ${p.evidence}` : ''}{p.id ? ` · #${p.id}` : ''}</T>
    </>
  );
  return flat ? <View style={{ gap: 4, marginTop: 4 }}>{body}</View> : <Card accent={accent} style={{ gap: 4, paddingVertical: 9 }}>{body}</Card>;
}
