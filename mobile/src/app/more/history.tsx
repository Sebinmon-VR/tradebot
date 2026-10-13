/**
 * History & feedback - port of the web app's History tab: every stored prediction (newest first), filters
 * by symbol / status / source, the system's grade and your verdict; tap a row to review it.
 */
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshControl, TextInput, View } from 'react-native';

import { Body, CallBadge, OutcomeBadge, stars, when } from '@/components/more/common';
import { ReviewSheet } from '@/components/more/review-sheet';
import { PredictionRow, listPredictions, resolvePending } from '@/services/predictions';
import { Badge, Button, Card, Choice, ErrorBox, Row, T, fmt, pct, useColors } from '@/ui/kit';

type Status = '' | 'pending' | 'resolved';
type Source = '' | 'live' | 'asof' | 'backtest';
const PAGE = 200;

export default function HistoryScreen() {
  const c = useColors();
  const [symbol, setSymbol] = useState('');
  const [status, setStatus] = useState<Status>('');
  const [source, setSource] = useState<Source>('');
  const [rows, setRows] = useState<PredictionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [open, setOpen] = useState<PredictionRow | null>(null);
  const q = useRef({ symbol, status, source });
  q.current = { symbol, status, source };

  const load = useCallback(async () => {
    const { symbol: s, status: st, source: src } = q.current;
    try {
      setRows(await listPredictions({ symbol: s.trim() || undefined, status: st || undefined, source: src || undefined, limit: PAGE }));
      setError(null);
    } catch (e) { setError((e as Error).message); }
  }, []);
  useFocusEffect(useCallback(() => { load(); }, [load]));
  useEffect(() => { const id = setTimeout(load, 250); return () => clearTimeout(id); }, [symbol, status, source, load]);

  const autoEval = async () => {
    setResolving(true); setMsg(null);
    try {
      const r = await resolvePending();
      setMsg(`Graded ${r.resolved.length} · still waiting for bars ${r.waiting.length}${r.errors.length ? ` · ${r.errors.length} failed (${r.errors[0].error})` : ''}.`);
      await load();
    } catch (e) { setMsg((e as Error).message); } finally { setResolving(false); }
  };

  return (
    <View style={{ flex: 1 }}>
      <Body refresh={<RefreshControl refreshing={false} onRefresh={load} />}>
        <Card>
          <TextInput value={symbol} onChangeText={setSymbol} placeholder="Filter by symbol (e.g. RELIANCE)" placeholderTextColor={c.muted} autoCapitalize="characters" autoCorrect={false}
            style={{ borderWidth: 1, borderColor: c.border, borderRadius: 9, paddingHorizontal: 10, paddingVertical: 8, color: c.text, backgroundColor: c.bg }} />
          <Choice<Status> small value={status} onChange={setStatus} options={[['', 'All'], ['pending', 'Pending'], ['resolved', 'Resolved']]} />
          <Choice<Source> small value={source} onChange={setSource} options={[['', 'Live + tests'], ['live', 'Live only'], ['asof', 'As-of tests'], ['backtest', 'Backtests']]} />
          <Row gap={8}>
            <View style={{ flex: 1 }}><Button title="Auto-evaluate due predictions" onPress={autoEval} busy={resolving} /></View>
            <Button title="Refresh" kind="plain" onPress={load} />
          </Row>
          {msg ? <T muted size={12}>{msg}</T> : null}
        </Card>
        <T muted size={11.5}>Tap a prediction to mark it correct / partial / incorrect. Your verdict overrides the system's and retrains strategy weights. <T bold size={11.5}>No call</T> = the system stood aside; it is not counted in accuracy.</T>
        {error ? <ErrorBox message={error} onRetry={load} /> : null}
        {rows && !rows.length ? <Card><T muted>No predictions {symbol || status || source ? 'match these filters' : 'yet - analyse a chart or run a backtest'}.</T></Card> : null}
        {rows?.map((r) => <HistoryRow key={r.id} r={r} onPress={() => setOpen(r)} />)}
        {rows && rows.length >= PAGE ? <T muted size={11.5}>Showing the newest {PAGE}. Narrow the filters to see older ones.</T> : null}
      </Body>
      <ReviewSheet p={open} onClose={() => setOpen(null)} onChanged={load} />
    </View>
  );
}

function HistoryRow({ r, onPress }: { r: PredictionRow; onPress: () => void }) {
  const c = useColors();
  const noCall = r.direction === 'SIDEWAYS';
  const accent = r.auto_outcome === 'correct' ? c.up : r.auto_outcome === 'incorrect' ? c.down : undefined;
  return (
    <Card onPress={onPress} accent={accent} style={{ gap: 4, paddingVertical: 10 }}>
      <Row gap={6}>
        <T muted size={11.5}>#{r.id}</T>
        <T bold size={14.5}>{r.symbol}</T>
        <T muted size={12}>{r.interval} / {r.horizon_bars}</T>
        {r.source && r.source !== 'live' ? <Badge>{r.source}</Badge> : null}
        <View style={{ flex: 1 }} />
        <CallBadge d={r.direction} />
      </Row>
      <Row gap={10} wrap>
        <T muted size={12}>{when(r.created_at, true)}</T>
        <T size={12}>P(up) <T bold size={12}>{pct(r.prob_up)}</T></T>
        <T size={12}>{fmt(r.price_at)} → {noCall ? 'no call' : fmt(r.target_price)}</T>
      </Row>
      <Row gap={6} wrap>
        {r.auto_outcome ? <><T muted size={12}>system</T><OutcomeBadge o={r.auto_outcome} /></> : <Badge>awaiting bars</Badge>}
        {r.resolved_price != null ? <T muted size={11.5}>closed {fmt(r.resolved_price)} ({(r.actual_move_pct ?? 0) >= 0 ? '+' : ''}{(r.actual_move_pct ?? 0).toFixed(2)}%)</T> : null}
        <View style={{ flex: 1 }} />
        {r.user_verdict ? <><T muted size={12}>you</T><OutcomeBadge o={r.user_verdict} />{r.user_rating ? <T size={11.5} color={c.flat}>{stars(r.user_rating)}</T> : null}</> : <T muted size={12}>no verdict</T>}
      </Row>
      {r.user_note ? <T muted size={11.5} numberOfLines={2}>“{r.user_note}”</T> : null}
    </Card>
  );
}
