/**
 * Chart + analysis - the phone version of the web app's main page (static/index.html / app.js).
 * The chart is pinned at the top (outside the scroll view, so drags and pinches reach it) with the web app's
 * overlays, indicator pane, session levels and the analysis' entry / target / stop / forecast.  Below it scroll
 * the call card (details, signals, indicators, trade plan) and the order ticket.  Sheets: search, options
 * (exchange, horizon, auto re-run), overlays.  Live: the forming bar is refreshed every few seconds.
 */
import { useLocalSearchParams } from 'expo-router';
import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Modal, Pressable, ScrollView, TextInput, View, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AnalysisPanel } from '@/components/analysis-panel';
import { ChartSettings, DEFAULT_LEVELS, DEFAULT_OVERLAYS, LEVELS, OVERLAYS, PANES, buildPayload, buildTail, predictionFor } from '@/components/chart/chart-data';
import type { ChartPrediction } from '@/components/chart/chart-html';
import { ChartHandle, ChartView } from '@/components/chart/chart-view';
import { OrderTicket } from '@/components/order-ticket';
import { DEFAULT_HORIZON } from '@/engine/ensemble';
import { computeAll, Frame } from '@/engine/indicators';
import type { TradePlan } from '@/engine/trading';
import { isIntraday, istDay } from '@/engine/types';
import { Fetched, SearchHit, barIsForming, fetchBars, normalizeSymbol, searchSymbols } from '@/engine/yahoo';
import type { AnalysisResult } from '@/services/analysis';
import { getJson, setJson } from '@/storage/db';
import { Badge, Button, Card, Chip, Choice, ErrorBox, Row, T, fmt, signed, toneOf, useColors } from '@/ui/kit';

const INTERVALS: [string, string][] = [['1m', '1m'], ['5m', '5m'], ['15m', '15m'], ['30m', '30m'], ['1h', '1h'], ['1d', 'Day'], ['1wk', 'Week']];
const POLL_MS = 5000;
type Ex = 'NSE' | 'BSE';
interface Saved { symbol?: string; interval?: string; recent?: string[]; overlays?: string[]; levels?: string[]; pane?: string; exchange?: Ex; horizon?: Record<string, number>; auto?: boolean }

export default function ChartScreen() {
  const c = useColors();
  const { height: winH } = useWindowDimensions();
  const params = useLocalSearchParams<{ symbol?: string; interval?: string }>();
  const [symbol, setSymbol] = useState('RELIANCE.NS');
  const [interval, setInterval_] = useState('15m');
  const [recent, setRecent] = useState<string[]>([]);
  const [settings, setSettings] = useState<ChartSettings>({ overlays: DEFAULT_OVERLAYS, levels: DEFAULT_LEVELS, pane: 'none' });
  const [exchange, setExchange] = useState<Ex>('NSE');
  const [horizons, setHorizons] = useState<Record<string, number>>({});
  const [auto, setAuto] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [fetched, setFetched] = useState<Fetched | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [sheet, setSheet] = useState<null | 'search' | 'options' | 'overlays'>(null);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [plan, setPlan] = useState<TradePlan | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const chart = useRef<ChartHandle>(null);
  const frame = useRef<Frame | null>(null);
  const reqSeq = useRef(0);

  // ---- persisted settings
  useEffect(() => {
    getJson<Saved>('chart.settings', {}).then((v) => {
      if (!params.symbol && v.symbol) setSymbol(v.symbol);
      if (!params.interval && v.interval) setInterval_(v.interval);
      if (v.recent) setRecent(v.recent);
      setSettings({ overlays: v.overlays ?? DEFAULT_OVERLAYS, levels: v.levels ?? DEFAULT_LEVELS, pane: v.pane ?? 'none' });
      if (v.exchange) setExchange(v.exchange);
      if (v.horizon) setHorizons(v.horizon);
      if (v.auto != null) setAuto(v.auto);
      setLoaded(true);
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (params.symbol) setSymbol(params.symbol); if (params.interval) setInterval_(params.interval); }, [params.symbol, params.interval]);
  useEffect(() => {
    if (!loaded) return;
    setRecent((old) => {
      const r = [symbol, ...old.filter((s) => s !== symbol)].slice(0, 10);
      setJson('chart.settings', { symbol, interval, recent: r, ...settings, exchange, horizon: horizons, auto });
      return r;
    });
  }, [loaded, symbol, interval, settings, exchange, horizons, auto]);

  const horizon = horizons[interval] ?? DEFAULT_HORIZON[interval] ?? 10;
  const prediction: ChartPrediction | null = useMemo(
    () => (result && result.symbol === symbol && result.interval === interval ? predictionFor(result) : null), [result, symbol, interval]);

  const draw = useCallback((f: Fetched, fit: boolean) => {
    frame.current ??= computeAll(f.bars);
    chart.current?.set(buildPayload(f.bars, frame.current, settings, prediction, fit));
  }, [settings, prediction]);

  // ---- full load on symbol / interval change (a later request always wins over a slower earlier one)
  useEffect(() => {
    if (!loaded) return;
    const my = ++reqSeq.current;
    setLoading(true); setError(null); setFetched(null); setResult(null); setPlan(null); frame.current = null;
    fetchBars(symbol, interval).then((f) => {
      if (my !== reqSeq.current) return;
      frame.current = computeAll(f.bars);
      setFetched(f); setUpdatedAt(Date.now()); draw(f, true);
    }).catch((e) => { if (my === reqSeq.current) setError((e as Error).message); })
      .finally(() => { if (my === reqSeq.current) setLoading(false); });
  }, [loaded, symbol, interval, retry]); // eslint-disable-line react-hooks/exhaustive-deps
  // redraw (keeping the view) when overlays / levels / pane or the analysis change
  useEffect(() => { if (fetched) draw(fetched, false); }, [settings, prediction]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- live: while the last bar is forming, top up the latest session and send only the new bars
  useEffect(() => {
    if (!fetched) return;
    const id = setInterval(async () => {
      const b = fetched.bars, lastT = b.t[b.t.length - 1];
      if (!barIsForming(fetched.dataSymbol, interval, lastT) && Date.now() / 1000 - lastT > 86400 * 3) return;
      const my = reqSeq.current;
      try {
        const f = await fetchBars(symbol, interval);
        if (my !== reqSeq.current || f === fetched) return;
        frame.current = computeAll(f.bars);
        chart.current?.tail(buildTail(f.bars, frame.current, settings, lastT));
        setFetched(f); setUpdatedAt(Date.now());
      } catch { /* keep the last good chart */ }
    }, POLL_MS);
    return () => clearInterval(id);
  }, [fetched, symbol, interval, settings]);

  const b = fetched?.bars;
  const n = b?.c.length ?? 0;
  const last = n ? b!.c[n - 1] : null;
  // previous session's close: the last bar of the previous IST day (intraday) or the previous bar (daily+)
  let prevClose: number | null = n > 1 ? b!.c[n - 2] : null;
  if (b && isIntraday(b)) { const d = istDay(b.t[n - 1]); for (let i = n - 1; i >= 0; i--) if (istDay(b.t[i]) !== d) { prevClose = b.c[i]; break; } }
  const chg = last != null && prevClose ? (last / prevClose - 1) * 100 : null;
  const live = !!b && n > 0 && barIsForming(fetched!.dataSymbol, interval, b.t[n - 1]);
  const chartH = expanded ? winH - 200 : Math.round(winH * 0.46);
  const toggle = (list: string[], k: string) => (list.includes(k) ? list.filter((x) => x !== k) : [...list, k]);
  const pick = (s: string, ex: Ex | '' = exchange) => { try { setSymbol(normalizeSymbol(s, ex)); setSheet(null); } catch { /* ignore */ } };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: c.bg }} edges={['top', 'left', 'right']}>
      <View style={{ paddingHorizontal: 12, paddingTop: 6, gap: 6 }}>
        <Row style={{ justifyContent: 'space-between' }}>
          <Pressable onPress={() => setSheet('search')} style={{ flex: 1 }}>
            <T bold size={20} numberOfLines={1}>{symbol.replace(/\.(NS|BO)$/, '')} <T muted size={12}>{symbol.endsWith('.BO') ? 'BSE' : symbol.startsWith('^') ? 'index' : 'NSE'} ▾</T></T>
            <T muted size={11.5} numberOfLines={1}>{fetched?.meta.longName || fetched?.meta.shortName || 'tap to search'}</T>
          </Pressable>
          {last != null ? (
            <View style={{ alignItems: 'flex-end' }}>
              <T bold size={18}>{fmt(last)}</T>
              <T size={12} color={toneOf(c, chg)}>{signed(chg)} <T muted size={11}>{live ? '● live' : 'closed'}</T></T>
            </View>
          ) : null}
        </Row>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, alignItems: 'center' }}>
          <Chip small label="🔍 Search" onPress={() => setSheet('search')} />
          <Chip small label="〰 Overlays" onPress={() => setSheet('overlays')} />
          <Chip small label="⚙ Options" onPress={() => setSheet('options')} />
          <Chip small label={expanded ? '⤡ Less' : '⤢ Full'} onPress={() => setExpanded((x) => !x)} />
          {INTERVALS.map(([k, t]) => <Chip key={k} small label={t} on={k === interval} onPress={() => setInterval_(k)} />)}
        </ScrollView>
        {recent.length > 1 ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
            {recent.map((s) => <Chip key={s} small label={s.replace(/\.(NS|BO)$/, '')} on={s === symbol} onPress={() => setSymbol(s)} />)}
          </ScrollView>
        ) : null}
      </View>
      <View style={{ paddingHorizontal: 6, paddingTop: 6 }}>
        <ChartView ref={chart} height={chartH} />
        {loading ? <View style={{ position: 'absolute', top: 30, left: 18 }}><Badge>{`Loading ${symbol} ${interval}…`}</Badge></View> : null}
        <View style={{ position: 'absolute', right: 74, top: 10 }}>
          <Pressable onPress={() => chart.current?.reset()} hitSlop={8}><Badge>⟲ latest</Badge></Pressable>
        </View>
      </View>
      {!expanded ? (
        <ScrollView contentContainerStyle={{ padding: 12, paddingBottom: 110, gap: 10 }} keyboardShouldPersistTaps="handled">
          {error ? <ErrorBox message={error} onRetry={() => setRetry((x) => x + 1)} /> : null}
          {fetched?.note ? <T muted size={12}>{fetched.note}</T> : null}
          <T muted size={11}>{n} bars{updatedAt ? ` · updated ${new Date(updatedAt).toLocaleTimeString()}` : ''} · drag to scroll, pinch to zoom, long-press for the crosshair</T>
          {fetched ? (
            <AnalysisPanel symbol={symbol} interval={interval} fetched={fetched} horizon={horizon} auto={auto} onResult={setResult} onPlan={setPlan} />
          ) : null}
          {fetched ? <OrderTicket symbol={fetched.dataSymbol} interval={interval} plan={plan} livePrice={last} predictionId={result?.prediction_id ?? null} /> : null}
        </ScrollView>
      ) : null}

      <Sheet open={sheet === 'search'} title="Search" onClose={() => setSheet(null)}>
        <SearchBox exchange={exchange} onPick={pick} />
        <Choice label="Exchange for typed symbols" small value={exchange} options={[['NSE', 'NSE'], ['BSE', 'BSE']]} onChange={setExchange} />
      </Sheet>
      <Sheet open={sheet === 'options'} title="Analysis options" onClose={() => setSheet(null)}>
        <Choice label="Exchange" small value={exchange} options={[['NSE', 'NSE'], ['BSE', 'BSE']]}
          onChange={(ex) => { setExchange(ex); if (!symbol.startsWith('^')) pick(symbol.replace(/\.(NS|BO)$/, ''), ex); }} />
        <Choice label={`Horizon for ${interval} (bars ahead)`} small value={horizon}
          options={[...new Set([4, 8, 12, 16, 24, 32, 48, DEFAULT_HORIZON[interval] ?? 10])].sort((x, y) => x - y).map((h) => [h, `${h}${h === DEFAULT_HORIZON[interval] ? ' (default)' : ''}`])}
          onChange={(h) => setHorizons((o) => ({ ...o, [interval]: h }))} />
        <Choice label="Auto re-run the analysis when a bar closes" small value={auto ? 'on' : 'off'} options={[['off', 'Off'], ['on', 'On']]} onChange={(v) => setAuto(v === 'on')} />
        <T muted size={12}>Backtests and as-of tests are under More → Backtest.</T>
      </Sheet>
      <Sheet open={sheet === 'overlays'} title="Chart overlays" onClose={() => setSheet(null)}>
        <T muted size={11}>OVERLAYS</T>
        <Row wrap gap={6}>{OVERLAYS.map(([k, t]) => <Chip key={k} small label={t} on={settings.overlays.includes(k)} onPress={() => setSettings((s) => ({ ...s, overlays: toggle(s.overlays, k) }))} />)}</Row>
        <T muted size={11}>LEVELS</T>
        <Row wrap gap={6}>{LEVELS.map(([k, t]) => <Chip key={k} small label={t} on={settings.levels.includes(k)} onPress={() => setSettings((s) => ({ ...s, levels: toggle(s.levels, k) }))} />)}</Row>
        <T muted size={11}>INDICATOR PANE</T>
        <Row wrap gap={6}>{PANES.map(([k, t]) => <Chip key={k} small label={t} on={settings.pane === k} onPress={() => setSettings((s) => ({ ...s, pane: k }))} />)}</Row>
      </Sheet>
    </SafeAreaView>
  );
}

function Sheet({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  const c = useColors();
  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={{ flex: 1, backgroundColor: '#0008' }} onPress={onClose} />
      <View style={{ backgroundColor: c.panel, borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 16, gap: 10, maxHeight: '75%' }}>
        <Row style={{ justifyContent: 'space-between' }}><T bold size={16}>{title}</T><Button title="Done" kind="plain" onPress={onClose} /></Row>
        <ScrollView contentContainerStyle={{ gap: 10, paddingBottom: 24 }} keyboardShouldPersistTaps="handled">{children}</ScrollView>
      </View>
    </Modal>
  );
}

function SearchBox({ exchange, onPick }: { exchange: Ex; onPick: (s: string, ex?: Ex | '') => void }) {
  const c = useColors();
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  useEffect(() => {
    if (q.trim().length < 2) { setHits([]); return; }
    const t = setTimeout(() => searchSymbols(q).then(setHits), 300);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <View style={{ gap: 6 }}>
      <TextInput autoFocus placeholder="Stock or index: ELECTCAST, NIFTY, BANKNIFTY…" placeholderTextColor={c.muted} value={q} onChangeText={setQ}
        autoCapitalize="characters" autoCorrect={false} onSubmitEditing={() => q.trim() && onPick(q.trim(), exchange)}
        style={{ borderWidth: 1, borderColor: c.border, borderRadius: 9, paddingHorizontal: 10, paddingVertical: 9, color: c.text, backgroundColor: c.bg }} />
      {hits.map((h) => (
        <Pressable key={h.symbol} onPress={() => onPick(h.symbol, '')} style={{ paddingVertical: 6 }}>
          <T bold>{h.symbol} <T muted size={12}>{h.exchange}</T></T><T muted size={12}>{h.name}</T>
        </Pressable>
      ))}
      {q.trim() && !hits.length ? <Card><T muted size={12}>Press enter to open {q.trim().toUpperCase()} on {exchange}.</T></Card> : null}
    </View>
  );
}
