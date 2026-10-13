/**
 * Accuracy - port of the web app's Accuracy tab: overall tiles, the per-strategy hit rate (from graded
 * predictions) with the adaptive weight multiplier it gives the strategy, and recent feedback.
 */
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { RefreshControl, View } from 'react-native';

import { adaptiveMultiplier } from '@/engine/ensemble';
import { Body, CAT_LABEL, H, OutcomeBadge, Table, stars, when } from '@/components/more/common';
import { FeedbackRow, listFeedback, overallStats, strategyStats } from '@/services/predictions';
import { Badge, Card, Choice, ErrorBox, Row, T, Tile, pct, useColors } from '@/ui/kit';

interface StratRow { key: string; name: string; category: string; evaluated: number; correct: number; incorrect: number; neutral: number; accuracy: number | null; mult: number }
type Sort = 'accuracy' | 'evaluated' | 'weight';

export default function AccuracyScreen() {
  const c = useColors();
  const [o, setO] = useState<Awaited<ReturnType<typeof overallStats>> | null>(null);
  const [rows, setRows] = useState<StratRow[]>([]);
  const [fb, setFb] = useState<FeedbackRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<Sort>('accuracy');

  const load = useCallback(async () => {
    try {
      const [ov, st, f] = await Promise.all([overallStats(), strategyStats(), listFeedback(null, 20)]);
      setO(ov); setFb(f);
      setRows(Object.entries(st).map(([key, s]) => {
        const n = s.correct + s.incorrect;
        return { key, name: s.name ?? key, category: s.category ?? '', evaluated: n, correct: s.correct, incorrect: s.incorrect, neutral: s.neutral ?? 0, accuracy: n ? s.correct / n : null, mult: adaptiveMultiplier(s) };
      }));
      setError(null);
    } catch (e) { setError((e as Error).message); }
  }, []);
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const sorted = [...rows].sort((a, b) => sort === 'evaluated' ? b.evaluated - a.evaluated
    : sort === 'weight' ? b.mult - a.mult : (b.accuracy ?? 0) - (a.accuracy ?? 0) || b.evaluated - a.evaluated);
  const accColor = (a: number | null) => (a == null ? c.muted : a >= 0.55 ? c.up : a <= 0.45 ? c.down : c.flat);

  return (
    <Body refresh={<RefreshControl refreshing={false} onRefresh={load} />}>
      {error ? <ErrorBox message={error} onRetry={load} /> : null}
      {o ? (
        <Row wrap gap={6}>
          <Tile k="Predictions" v={o.total_predictions} />
          <Tile k="Calls evaluated" v={o.evaluated} />
          <Tile k="No call" v={o.no_call} />
          <Tile k="Pending" v={o.pending} />
          <Tile k="Accuracy of calls" v={o.accuracy == null ? '—' : pct(o.accuracy, 1)} color={accColor(o.accuracy)} sub="partial counts ½" />
          <Tile k="✔ / ~ / ✘" v={`${o.correct} / ${o.partial} / ${o.incorrect}`} />
          <Tile k="Your feedback" v={o.with_user_feedback} />
          <Tile k="Avg rating" v={o.avg_user_rating ? `${o.avg_user_rating.toFixed(1)} ★` : '—'} />
          {Object.entries(o.by_direction).filter(([d]) => d !== 'SIDEWAYS').map(([d, b]) => (
            <Tile key={d} k={`${d} calls`} v={`${b.correct}✔ ${b.partial}~ ${b.incorrect}✘`} />
          ))}
        </Row>
      ) : null}

      <Card>
        <H sub="From every graded prediction (auto-graded or your verdict). A strategy's weight in the rule ensemble is multiplied by a Bayesian-smoothed version of this hit rate: 0.3× to 2×, close to 1× until it has ~25 graded votes.">Per-strategy hit rate</H>
        <Choice<Sort> small value={sort} onChange={setSort} options={[['accuracy', 'By accuracy'], ['evaluated', 'By votes graded'], ['weight', 'By weight ×']]} />
        {sorted.length ? (
          <Table head={['Strategy', 'Graded', '✔', '✘', 'Acc.', 'Wt ×']} flex={[2.6, 0.9, 0.7, 0.7, 1, 0.9]}
            rows={sorted.map((r) => [
              <View key="n"><T size={12.5} bold numberOfLines={1}>{r.name}</T><T muted size={10.5}>{CAT_LABEL[r.category] ?? r.category}{r.neutral ? ` · ${r.neutral} neutral` : ''}</T></View>,
              String(r.evaluated), String(r.correct), String(r.incorrect),
              <View key="a" style={{ alignItems: 'flex-end', gap: 2 }}>
                <T size={12.5} bold color={accColor(r.accuracy)}>{r.accuracy == null ? '—' : pct(r.accuracy)}</T>
                {r.accuracy != null ? <View style={{ width: 40, height: 3, backgroundColor: c.panel2, borderRadius: 2 }}><View style={{ width: 40 * r.accuracy, height: 3, backgroundColor: accColor(r.accuracy), borderRadius: 2 }} /></View> : null}
              </View>,
              <T key="m" size={12.5} color={r.mult > 1.02 ? c.up : r.mult < 0.98 ? c.down : c.text}>{r.mult.toFixed(2)}</T>,
            ])} />
        ) : <T muted>No evaluated predictions yet. Give feedback on History, run a Backtest, or wait for the auto-evaluator.</T>}
      </Card>

      <Card>
        <H>Recent feedback</H>
        {fb.length ? fb.map((f) => (
          <Row key={f.id} wrap gap={6} style={{ paddingVertical: 3 }}>
            <T muted size={12}>{when(f.created_at)}</T><T bold size={12.5}>{f.symbol}</T>{f.direction ? <Badge>{f.direction === 'SIDEWAYS' ? 'no call' : f.direction}</Badge> : null}
            <OutcomeBadge o={f.verdict} />{f.rating ? <T size={12} color={c.flat}>{stars(f.rating)}</T> : null}
            {f.note ? <T muted size={12}>— {f.note}</T> : null}
          </Row>
        )) : <T muted>No feedback yet.</T>}
      </Card>
    </Body>
  );
}
