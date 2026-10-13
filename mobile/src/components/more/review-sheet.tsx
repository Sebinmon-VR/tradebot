/**
 * Review a prediction - port of the web app's feedback #modal plus the #detail pop-up: summary, the strongest
 * votes at the time, earlier feedback, verdict (correct / partial / incorrect), 1-5 stars and a note.
 * Saving calls addFeedback, which rebuilds the per-strategy hit rates that tilt the rule weights.
 */
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, Text, TextInput, View } from 'react-native';

import { FeedbackRow, PredictionRow, addFeedback, deletePrediction, listFeedback } from '@/services/predictions';
import { Button, Row, T, fmt, pct, useColors } from '@/ui/kit';
import { confirmAsk } from '@/ui/confirm';

import { CallBadge, H, OutcomeBadge, VoteText, stars, when } from './common';

const VERDICTS: ['correct' | 'partial' | 'incorrect', string, 'up' | 'flat' | 'down'][] = [['correct', '✔ Correct', 'up'], ['partial', '~ Partially', 'flat'], ['incorrect', '✘ Incorrect', 'down']];
const STAR_LABEL = ['rate usefulness', 'useless', 'weak', 'okay', 'good', 'excellent'];

export function ReviewSheet({ p, onClose, onChanged }: { p: PredictionRow | null; onClose: () => void; onChanged: () => void }) {
  const c = useColors();
  const [verdict, setVerdict] = useState<'correct' | 'partial' | 'incorrect' | null>(null);
  const [rating, setRating] = useState(0);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [fb, setFb] = useState<FeedbackRow[]>([]);

  useEffect(() => {
    if (!p) return;
    setVerdict((p.user_verdict as any) ?? null); setRating(p.user_rating ?? 0); setNote(p.user_note ?? ''); setErr(null);
    listFeedback(p.id).then(setFb).catch(() => setFb([]));
  }, [p]);
  if (!p) return null;

  let signals: any[] = [];
  try { signals = JSON.parse(p.signals_json); } catch { /* old row */ }
  const top = signals.filter((s) => s.direction !== 0 && s.counts_in_rule_score !== false).sort((a, b) => (b.contribution ?? 0) - (a.contribution ?? 0)).slice(0, 8);
  let summary: any = {};
  try { summary = JSON.parse(p.summary_json); } catch { /* old row */ }
  const noCall = p.direction === 'SIDEWAYS';

  const save = async () => {
    if (!verdict) return;
    setBusy(true);
    try { await addFeedback(p.id, verdict, rating || null, note.trim() || null); onChanged(); onClose(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const del = async () => {
    if (!(await confirmAsk('Delete prediction', `Delete prediction #${p.id} (${p.symbol})? Its feedback goes too and the strategy stats are rebuilt.`))) return;
    try { await deletePrediction(p.id); onChanged(); onClose(); } catch (e) { setErr((e as Error).message); }
  };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={{ flex: 1, backgroundColor: '#0008' }} onPress={onClose} />
      <View style={{ maxHeight: '88%', backgroundColor: c.panel, borderTopLeftRadius: 16, borderTopRightRadius: 16, borderWidth: 1, borderColor: c.border }}>
        <ScrollView contentContainerStyle={{ padding: 14, gap: 10, paddingBottom: 30 }} keyboardShouldPersistTaps="handled">
          <Row>
            <T bold size={17} style={{ flex: 1 }}>Review prediction #{p.id}</T>
            <Pressable onPress={onClose} hitSlop={10}><T size={22} muted>×</T></Pressable>
          </Row>
          <Row wrap gap={6}>
            <T bold size={15}>{p.symbol}</T><T muted>{p.interval} · {p.horizon_bars} bars</T><CallBadge d={p.direction} />
            {p.source && p.source !== 'live' ? <OutcomeBadgeText text={p.source} /> : null}
          </Row>
          <T size={13} style={{ lineHeight: 19 }}>
            Called <T bold>{noCall ? 'NO CALL' : p.direction}</T> at {fmt(p.price_at)} on {when(p.created_at, true)} for the next {p.horizon_bars} bars
            {noCall ? '' : ` (target ${fmt(p.target_price)}${p.stop_price ? `, stop ${fmt(p.stop_price)}` : ''})`}. P(up) {pct(p.prob_up)} · confidence {pct(p.confidence)}
            {summary.expected_accuracy != null ? ` · validated accuracy ${pct(summary.expected_accuracy)} (${summary.learner?.evidence ?? ''})` : ''}.
          </T>
          <Row wrap gap={6}>
            <T muted size={12.5}>System:</T><OutcomeBadge o={p.auto_outcome} pendingLabel="awaiting bars" />
            {p.resolved_price != null ? <T muted size={12.5}>closed {fmt(p.resolved_price)} ({(p.actual_move_pct ?? 0) >= 0 ? '+' : ''}{(p.actual_move_pct ?? 0).toFixed(2)}%)</T> : null}
          </Row>

          <H>Your verdict</H>
          <Row gap={6}>
            {VERDICTS.map(([k, label, tone]) => {
              const col = c[tone], on = verdict === k;
              return (
                <Pressable key={k} onPress={() => setVerdict(k)} style={{ flex: 1, paddingVertical: 10, borderRadius: 9, borderWidth: 1.5, alignItems: 'center', borderColor: on ? col : c.border, backgroundColor: on ? col + '22' : c.panel2 }}>
                  <Text style={{ color: on ? col : c.text, fontWeight: '700', fontSize: 13 }}>{label}</Text>
                </Pressable>
              );
            })}
          </Row>
          <Row gap={4}>
            {[1, 2, 3, 4, 5].map((k) => (
              <Pressable key={k} onPress={() => setRating(k === rating ? 0 : k)} hitSlop={4}>
                <Text style={{ fontSize: 28, color: k <= rating ? c.flat : c.border }}>★</Text>
              </Pressable>
            ))}
            <T muted size={12.5} style={{ marginLeft: 6 }}>{STAR_LABEL[rating]}</T>
          </Row>
          <TextInput value={note} onChangeText={setNote} placeholder="Note (optional): what happened, why it was right / wrong" placeholderTextColor={c.muted} multiline
            style={{ minHeight: 64, borderWidth: 1, borderColor: c.border, borderRadius: 9, padding: 10, color: c.text, backgroundColor: c.bg, textAlignVertical: 'top' }} />
          <T muted size={11.5}>Your verdict overrides the system's grade and retrains the per-strategy hit rates that weight the rule votes.</T>
          {err ? <T color={c.down}>{err}</T> : null}
          <Row gap={8}>
            <View style={{ flex: 1 }}><Button title="Save feedback" onPress={save} disabled={!verdict} busy={busy} /></View>
            <Button title="Chart" kind="plain" onPress={() => { onClose(); router.navigate({ pathname: '/chart', params: { symbol: p.symbol, interval: p.interval } }); }} />
            <Button title="Learning" kind="plain" onPress={() => { onClose(); router.push({ pathname: '/more/learning', params: { id: String(p.id) } }); }} />
          </Row>

          {top.length ? (
            <>
              <H>Strongest votes at the time</H>
              {top.map((s) => (
                <View key={s.key} style={{ gap: 1, paddingVertical: 3, borderBottomWidth: 1, borderBottomColor: c.border }}>
                  <Row><T bold size={12.5} style={{ flex: 1 }}>{s.name}</T><VoteText d={s.direction} /><T muted size={12}> {Math.round((s.confidence ?? 0) * 100)}%</T></Row>
                  <T muted size={11.5}>{s.reason}</T>
                </View>
              ))}
            </>
          ) : null}
          {fb.length ? (
            <>
              <H>Earlier feedback</H>
              {fb.map((f) => (
                <Row key={f.id} wrap gap={6}><T muted size={12}>{when(f.created_at)}</T><OutcomeBadge o={f.verdict} /><T size={12} color={c.flat}>{stars(f.rating)}</T>{f.note ? <T muted size={12}>— {f.note}</T> : null}</Row>
              ))}
            </>
          ) : null}
          <View style={{ alignSelf: 'flex-start', marginTop: 6 }}><Button title="Delete prediction" kind="danger" onPress={del} /></View>
        </ScrollView>
      </View>
    </Modal>
  );
}

function OutcomeBadgeText({ text }: { text: string }) {
  const c = useColors();
  return <View style={{ borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2, backgroundColor: c.badge, borderWidth: 1, borderColor: c.border }}><Text style={{ color: c.muted, fontSize: 11 }}>{text}</Text></View>;
}
