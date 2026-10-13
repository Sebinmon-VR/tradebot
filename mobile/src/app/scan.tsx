/**
 * Today / Overextended screen - port of static/overextended.html/.js.  Two views:
 *   Today      - how far each stock ran above (▲) or fell below (▼) this session's open, 5-minute bars
 *   Multi-day  - overbought / exhaustion rules on daily bars
 * Every card carries the stock's own record and the summary the pooled record, recomputed on each scan.
 */
import { router } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, RefreshControl, Switch, TextInput, View } from 'react-native';

import type { IntradayRow } from '@/engine/intraday';
import type { OverextendedRow } from '@/engine/overextended';
import { UNIVERSES } from '@/engine/universe';
import { afterMeta, redecorate, scanOverextended, scanToday } from '@/services/scans';
import { getJson, setJson } from '@/storage/db';
import { Badge, BadgeTone, Card, Choice, ErrorBox, Header, Loading, Row, Screen, Stat, T, Tile, fmt, pct, signed, toneOf, useColors } from '@/ui/kit';
import { Spark } from '@/ui/spark';

type Mode = 'today' | 'daily';
type Side = 'up' | 'down';
interface Settings { mode: Mode; side: Side; universe: string; watchlist: string; minToday: number; minDaily: number; sortToday: string; sortDaily: string }
const DEFAULTS: Settings = { mode: 'today', side: 'up', universe: 'midsmall', watchlist: '', minToday: 25, minDaily: 20, sortToday: 'peak', sortDaily: 'score' };
const REFRESH_S = 120;

const WORDS = {
  up: { dir: 'above', ext: 'high', rev: 'closed lower', faded: 'faded', fadeTile: 'Fading', fadeSub: 'hit 35+, gave back half', running: 'Still running' },
  down: { dir: 'below', ext: 'low', rev: 'closed higher', faded: 'bounced', fadeTile: 'Bouncing', fadeSub: 'fell 35+, recovered half', running: 'Still falling' },
};
const tierOf = (s: number) => (s >= 50 ? 'stretched' : s >= 35 ? 'extended' : s >= 25 ? 'warming' : '');

export default function ScanScreen() {
  const c = useColors();
  const [s, setS] = useState<Settings>(DEFAULTS);
  const [loaded, setLoaded] = useState(false);
  const [data, setData] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<[number, number]>([0, 0]);
  const [error, setError] = useState<string | null>(null);
  const [auto, setAuto] = useState(false);
  const [search, setSearch] = useState('');
  const [showRules, setShowRules] = useState(false);
  const seq = useRef(0);

  useEffect(() => { getJson('scan.settings', DEFAULTS).then((v) => { setS({ ...DEFAULTS, ...v }); setLoaded(true); }); }, []);
  const update = (patch: Partial<Settings>) => setS((old) => { const n = { ...old, ...patch }; setJson('scan.settings', n); return n; });

  const load = useCallback(async (force = false) => {
    const my = ++seq.current;
    setBusy(true); setError(null); setProgress([0, 0]);
    try {
      const onP = (d: number, t: number) => { if (my === seq.current && (d % 5 === 0 || d === t)) setProgress([d, t]); };
      const res = s.mode === 'today' ? await scanToday(s.universe, s.watchlist, s.side, onP, force) : await scanOverextended(s.universe, s.watchlist, onP, force);
      if (my === seq.current) setData({ ...res, mode: s.mode });
      afterMeta()?.then(() => { if (my === seq.current) setData((d: any) => (d ? { ...d, rows: redecorate(d.rows) } : d)); });
    } catch (e) {
      if (my === seq.current) setError((e as Error).message);
    } finally {
      if (my === seq.current) setBusy(false);
    }
  }, [s.mode, s.side, s.universe, s.watchlist]);

  useEffect(() => { if (loaded) { setData(null); load(); } }, [loaded, load]);
  useEffect(() => {
    if (!auto) return;
    const id = setInterval(() => load(true), REFRESH_S * 1000);
    return () => clearInterval(id);
  }, [auto, load]);

  const today = s.mode === 'today';
  const minScore = today ? s.minToday : s.minDaily;
  const rows = useMemo(() => {
    if (!data || data.mode !== s.mode) return { list: [] as any[], note: '' };
    const val = (r: any) => (today ? r.peak_today : r.score);
    let list: any[] = data.rows.filter((r: any) => val(r) >= minScore);
    let note = '';
    if (!list.length && data.rows.length) {
      list = data.rows.slice().sort((a: any, b: any) => val(b) - val(a)).slice(0, 12);
      note = `Nothing reaches ${minScore} ${today ? 'today' : 'right now'}: these are the ${list.length} names closest to it. ${today ? 'Early in the session, or on a flat day, few stocks move far from the open.' : 'A quiet or falling market rarely has stretched names.'}`;
    }
    if (search) { const q = search.toUpperCase(); list = list.filter((r) => r.symbol.includes(q) || (r.sector || '').toUpperCase().includes(q)); }
    const sg = s.side === 'down' ? -1 : 1;
    const sorts: Record<string, (a: any, b: any) => number> = today ? {
      peak: (a, b) => b.peak_today - a.peak_today || b.score - a.score,
      fading: (a, b) => Number(b.phase === 'fading') - Number(a.phase === 'fading') || (b.giveback || 0) - (a.giveback || 0) || b.peak_today - a.peak_today,
      now: (a, b) => b.score - a.score || b.peak_today - a.peak_today,
      chg_open: (a, b) => sg * ((b.chg_open || 0) - (a.chg_open || 0)),
      vwap_z: (a, b) => sg * ((b.vwap_z || 0) - (a.vwap_z || 0)),
      rvol: (a, b) => (b.rvol || 0) - (a.rvol || 0),
    } : {
      score: (a, b) => b.score - a.score || (b.chg_20d || 0) - (a.chg_20d || 0),
      reversal: (a, b) => revPts(b) - revPts(a) || b.score - a.score,
      record: (a, b) => record(b) - record(a) || b.score - a.score,
      chg_20d: (a, b) => (b.chg_20d || 0) - (a.chg_20d || 0),
      rsi14: (a, b) => (b.rsi14 || 0) - (a.rsi14 || 0),
      vol_ratio: (a, b) => (b.vol_ratio || 0) - (a.vol_ratio || 0),
    };
    list.sort(sorts[today ? s.sortToday : s.sortDaily] ?? Object.values(sorts)[0]);
    return { list, note };
  }, [data, s, search, minScore, today]);

  const go = (symbol: string) => router.navigate({ pathname: '/chart', params: { symbol, interval: today ? '5m' : '1d' } });
  const W = WORDS[s.side];

  return (
    <Screen refresh={<RefreshControl refreshing={false} onRefresh={() => load(true)} />}>
      <Header
        title={today ? (s.side === 'down' ? 'Fell from the open' : 'Ran from the open') : 'Overextended'}
        sub={today ? `5-minute bars · ${s.side === 'down' ? 'still falling or bouncing' : 'still running or already fading'} · what happened by the close before` : 'daily bars · published overbought and exhaustion rules · each stock’s own record'}
        right={<Row gap={4}><T muted size={11}>Auto</T><Switch value={auto} onValueChange={setAuto} /></Row>}
      />
      <Choice label="View" value={s.mode} options={[['today', 'Today · from the open'], ['daily', 'Multi-day · daily bars']]} onChange={(mode) => update({ mode })} />
      {today ? <Choice label="Direction" value={s.side} options={[['up', '▲ Ran up'], ['down', '▼ Fell']]} onChange={(side) => update({ side })} /> : null}
      <Choice label="Universe" value={s.universe} small options={Object.values(UNIVERSES).map((u) => [u.key, `${u.name} (${u.symbols.length})`])} onChange={(universe) => update({ universe })} />
      <Choice label="Show from score" small value={minScore}
        options={today ? [[50, '50+ stretched'], [35, '35+ extended'], [25, '25+ warming'], [10, '10+ any']] : [[50, '50+ stretched'], [35, '35+ extended'], [20, '20+ warming'], [10, '10+ closest']]}
        onChange={(v) => update(today ? { minToday: v } : { minDaily: v })} />
      <TextInput
        placeholder="My watchlist (comma separated, scanned too)" placeholderTextColor={c.muted} defaultValue={s.watchlist} autoCapitalize="characters"
        onEndEditing={(e) => update({ watchlist: e.nativeEvent.text.trim() })}
        style={{ borderWidth: 1, borderColor: c.border, borderRadius: 9, paddingHorizontal: 10, paddingVertical: 8, color: c.text, backgroundColor: c.panel }}
      />

      {error ? <ErrorBox message={error} onRetry={() => load(true)} /> : null}
      {busy && !data ? <Loading text={today ? 'Downloading 60 days of 5-minute bars…' : 'Downloading 2 years of daily bars…'} done={progress[0]} total={progress[1]} /> : null}
      {data && data.mode === s.mode ? (today ? <SummaryToday d={data} side={s.side} /> : <SummaryDaily d={data} />) : null}
      {busy && data ? <T muted size={12}>Refreshing… {progress[1] ? `${progress[0]}/${progress[1]}` : ''}</T> : null}

      {data ? (
        <>
          <Choice small value={today ? s.sortToday : s.sortDaily} onChange={(k) => update(today ? { sortToday: k } : { sortDaily: k })}
            options={today ? [['peak', s.side === 'down' ? 'Biggest fall today' : 'Biggest run today'], ['fading', s.side === 'down' ? 'Bouncing first' : 'Fading first'], ['now', 'Most stretched now'], ['chg_open', 'Most % from open'], ['vwap_z', s.side === 'down' ? 'Furthest below VWAP' : 'Furthest above VWAP'], ['rvol', 'Volume climax']]
              : [['score', 'Most stretched'], ['reversal', 'Reversal signs first'], ['record', 'Best pullback record'], ['chg_20d', 'Biggest 20-day run'], ['rsi14', 'Highest RSI'], ['vol_ratio', 'Volume climax']]} />
          <TextInput placeholder="filter symbols…" placeholderTextColor={c.muted} value={search} onChangeText={setSearch} autoCapitalize="characters"
            style={{ borderWidth: 1, borderColor: c.border, borderRadius: 9, paddingHorizontal: 10, paddingVertical: 6, color: c.text, backgroundColor: c.panel }} />
          <T muted size={12}>{rows.list.length} shown of {data.rows.length} · updated {new Date(data.generated_at).toLocaleTimeString()} ({data.took_s?.toFixed(1)}s){data.missing?.length ? ` · no data for ${data.missing.length}` : ''}</T>
          {rows.note ? <T muted size={12.5}>{rows.note}</T> : null}
          {rows.list.map((r: any) => (today ? <TodayCard key={r.symbol} r={r} side={s.side} onPress={() => go(r.symbol)} /> : <DailyCard key={r.symbol} r={r} onPress={() => go(r.symbol)} />))}
        </>
      ) : null}

      <Pressable onPress={() => setShowRules((x) => !x)}><T color={c.accent} bold>{showRules ? '▾' : '▸'} How the score is built, and how to read it</T></Pressable>
      {showRules && data ? <RulesCard d={data} today={today} side={s.side} /> : null}
      <T muted size={11.5}>Analytics for research and education only, not investment advice. Intraday shorting on Groww is MIS only and is squared off by the broker before the close.</T>
    </Screen>
  );

  function revPts(r: OverextendedRow) { return r.rules.filter((f) => ['candle', 'divergence', 'climax'].includes(f.key)).reduce((a, f) => a + f.points, 0); }
  function record(r: OverextendedRow) { const h = r.history; return h.episodes >= 3 && h.lower_share != null ? h.lower_share - (h.uncond_lower_share ?? 0.5) : -1; }
  void W;
}

// ------------------------------------------------------------ Today cards
function TodayCard({ r, side, onPress }: { r: IntradayRow; side: Side; onPress: () => void }) {
  const c = useColors();
  const W = WORDS[side], t = tierOf(r.peak_today), L = r.levels, pre = r.level_prefix;
  const accent = side === 'up' && r.phase === 'fading' ? c.down : t === 'stretched' ? c.down : t === 'extended' ? c.flat : t === 'warming' ? c.accent : c.border;
  const line = side === 'up' && r.phase === 'fading' ? c.down : t === 'stretched' ? c.down : t === 'extended' ? c.flat : c.accent;
  const atr = (v: number | null) => (v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(1)} ATR`);
  const h = r.history, f = h.fade;
  const part = (name: string, x: typeof f) => (x.episodes ? `${name}: ${x.episodes}×, ${W.rev} ${pct(x.reversal_share)}, avg to close ${signed(x.avg_fwd_pct)}` : `${name}: never`);
  return (
    <Card accent={accent} onPress={onPress}>
      <Row style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <View style={{ flex: 1 }}>
          <T bold size={16}>{r.name}</T>
          <T muted size={11}>{r.sector ?? ''}</T>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <T bold size={24} color={t === 'stretched' ? c.down : t === 'extended' ? c.flat : c.text}>{r.peak_today}</T>
          <T muted size={10.5}>{t.toUpperCase()}{r.peak_time ? ` @${r.peak_time}` : ''} · now {r.score}</T>
        </View>
      </Row>
      <Row wrap gap={6}>
        <T bold size={15}>{fmt(r.price)}</T>
        <T color={toneOf(c, r.chg_open)}>{signed(r.chg_open)} from open</T>
        <T muted size={12}>{W.ext} {signed(r.extreme_from_open, 1)} · vs prev close {signed(r.chg_prev, 1)}{Math.abs(r.gap ?? 0) >= 0.5 ? ` · gap ${signed(r.gap, 1)}` : ''}</T>
      </Row>
      <Spark slots={75}
        lines={[{ values: r.spark_vwap, color: '#8a63d2', width: 1, dash: '3 2' }, { values: r.spark, color: line, dot: true }]}
        levels={[{ value: r.open, color: '#9aa3b2', label: 'open' }, ...[L.l1, L.l2, L.l3].map((v, i) => ({ value: v, color: '#c98a1b', label: `${pre}${i + 1}` }))
          .filter((x) => x.value != null && inRange(x.value, r.spark))]} />
      <Row wrap gap={10}>
        <Stat k="from open" v={atr(r.run_atr)} />
        <Stat k={W.ext} v={atr(r.extreme_atr)} />
        <Stat k="vs VWAP" v={r.vwap_z == null ? '—' : `${r.vwap_z > 0 ? '+' : ''}${r.vwap_z.toFixed(1)}σ`} />
        <Stat k="pivots" v={r.beyond ? `${side === 'down' ? '<' : '>'} ${r.beyond}` : `not past ${pre}1`} />
        <Stat k="RSI 5m" v={r.rsi == null ? '—' : r.rsi.toFixed(0)} />
        <Stat k="rel vol" v={r.rvol == null ? '—' : `${r.rvol.toFixed(1)}×`} />
      </Row>
      <Row wrap gap={4}>
        <PhaseBadge r={r} side={side} />
        {r.rules.map((f) => <Badge key={f.key}>{`${f.label} ${f.points}/${f.max_points} · ${f.value}`}</Badge>)}
      </Row>
      <T muted size={11.5}>{!h.episodes && !f.episodes ? `No session in the last ${h.sessions} reached ${h.threshold}+ ${W.dir} the open before 14:30.` : `Own record, last ${h.sessions} sessions · ${part(`crossed ${h.threshold}`, h)} · ${part(W.faded, f)}`}</T>
      <T muted size={11.5}>VWAP {fmt(r.vwap)} · open {fmt(r.open)} · {W.ext} {fmt(r.extreme)} · ATR {r.atr_pct == null ? '—' : r.atr_pct.toFixed(1) + '%'}  ›  tap for chart</T>
    </Card>
  );
}
const inRange = (v: number | null, xs: (number | null)[]) => {
  const vals = xs.filter((x): x is number => x != null);
  if (v == null || !vals.length) return false;
  const lo = Math.min(...vals), hi = Math.max(...vals), pad = (hi - lo) * 0.15;
  return v >= lo - pad && v <= hi + pad;
};
function PhaseBadge({ r, side }: { r: IntradayRow; side: Side }) {
  let tone: BadgeTone = 'plain', text = '';
  if (side === 'down') {
    if (r.phase === 'fading') { tone = 'mid'; text = `bouncing · ${r.giveback}% recovered (no measured edge)`; }
    else if (r.phase === 'running') { tone = 'mid'; text = 'still falling'; }
    else if (r.peak_today >= 35) text = 'steadied';
  } else if (r.phase === 'fading') { tone = 'bad'; text = `fading · ${r.giveback}% given back`; }
  else if (r.phase === 'running') { tone = 'mid'; text = 'still running · no edge to fade yet'; }
  else if (r.peak_today >= 35) text = 'cooled off';
  return text ? <Badge tone={tone}>{text}</Badge> : null;
}
function SummaryToday({ d, side }: { d: any; side: Side }) {
  const c = useColors();
  const b = d.base_rate, cnt = d.counts || {}, f = b.fade || {}, W = WORDS[side];
  const live = d.session === new Date(Date.now() + 19800e3).toISOString().slice(0, 10);
  const rec = (x: any) => (x.episodes ? `${W.rev} ${pct(x.reversal_share)} of ${x.episodes} times, average ${signed(x.avg_fwd_pct)} to the close, after moving a further ${signed(x.median_further_pct)} first (median)` : 'had no episodes yet');
  const edge = f.reversal_share != null && b.uncond_reversal_share != null ? f.reversal_share - b.uncond_reversal_share : null;
  const verdict = side === 'down'
    ? 'No version of "fell too far" has shown a reliable bounce in this data: falling stocks closed higher about as often as lower, and early big drops leaned towards falling further. Use this list to avoid catching a falling knife, not as buy signals.'
    : edge == null ? '' : edge >= 0.07 ? 'Fading names are the ones with an edge; a stock that is still running is not.' : 'In this universe even the fading version does not clearly beat the base rate: treat the list as a watchlist, not a signal.';
  return (
    <Card>
      <Row wrap gap={6}>
        <Tile k={W.fadeTile} v={cnt.fading ?? 0} sub={W.fadeSub} />
        <Tile k={W.running} v={cnt.running ?? 0} sub="score 35+ now" />
        <Tile k="Stretched · 50+" v={cnt.stretched ?? 0} sub="peak today" color={c.down} />
        <Tile k="Extended · 35-49" v={cnt.extended ?? 0} sub="peak today" color={c.flat} />
        <Tile k="Scanned" v={d.scanned} sub={live ? 'live session' : `last session ${d.session ?? ''}`} />
      </Row>
      <T size={12.5}><T bold size={12.5}>Pooled record, {d.name}, last ~60 sessions (before 14:30): </T>after the score first crossed {b.threshold} {W.dir} the open, the stock {rec(b)}. After it {W.faded} ({b.fade_rule}) it {rec(f)}. Any bar of a {side === 'down' ? 'down' : 'up'}-session {W.rev} {pct(b.uncond_reversal_share)} of the time. {verdict}</T>
    </Card>
  );
}

// ------------------------------------------------------------ Multi-day cards
function DailyCard({ r, onPress }: { r: OverextendedRow; onPress: () => void }) {
  const c = useColors();
  const col = r.tier === 'stretched' ? c.down : r.tier === 'extended' ? c.flat : c.accent;
  const h = r.history;
  const edge = h.lower_share != null ? h.lower_share - (h.uncond_lower_share ?? 0.5) : 0;
  const verdict: [BadgeTone, string] = h.episodes < 3 ? ['plain', 'too few episodes to judge'] : edge >= 0.15 ? ['bad', 'tends to pull back'] : edge <= -0.1 ? ['ok', 'tends to keep running'] : ['mid', 'no clear pattern'];
  return (
    <Card accent={r.tier ? col : c.border} onPress={onPress}>
      <Row style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <View style={{ flex: 1 }}><T bold size={16}>{r.name}</T><T muted size={11}>{r.sector ?? ''}</T></View>
        <View style={{ alignItems: 'flex-end' }}><T bold size={24} color={r.tier ? col : c.text}>{r.score}</T><T muted size={10.5}>{(r.tier ?? '').toUpperCase()}</T></View>
      </Row>
      <Row wrap gap={6}>
        <T bold size={15}>{fmt(r.price)}</T><T color={toneOf(c, r.chg_1d)}>{signed(r.chg_1d)}</T>
        <T muted size={12}>5d {signed(r.chg_5d, 1)} · 20d {signed(r.chg_20d, 1)} · {signed(r.dist_52w_high, 1)} vs 52-wk high</T>
      </Row>
      <Spark lines={[{ values: r.spark_sma, color: '#9aa3b2', width: 1, dash: '3 3' }, { values: r.spark, color: col, dot: true }]} />
      <Row wrap gap={10}>
        <Stat k="RSI 14" v={r.rsi14?.toFixed(0) ?? '—'} /><Stat k="RSI 2" v={r.rsi2?.toFixed(0) ?? '—'} /><Stat k="%B" v={r.bb_pct?.toFixed(2) ?? '—'} />
        <Stat k="vs SMA20" v={r.stretch20 == null ? '—' : `${r.stretch20 > 0 ? '+' : ''}${r.stretch20.toFixed(1)} ATR`} />
        <Stat k="streak" v={`${r.streak}↑`} /><Stat k="20d run" v={r.z20 == null ? '—' : `${r.z20.toFixed(1)}σ`} /><Stat k="vol" v={r.vol_ratio == null ? '—' : `${r.vol_ratio.toFixed(1)}×`} />
      </Row>
      <Row wrap gap={4}>{r.rules.map((f) => <Badge key={f.key} tone={['candle', 'divergence', 'climax'].includes(f.key) ? 'bad' : 'plain'}>{`${f.label} ${f.points}/${f.max_points} · ${f.value}`}</Badge>)}</Row>
      <Row wrap gap={4}>
        {h.on_for ? <Badge tone="mid">{`stretched ${h.on_for} session${h.on_for > 1 ? 's' : ''}`}</Badge> : null}
        {h.episodes ? <Badge tone={verdict[0]}>{verdict[1]}</Badge> : null}
      </Row>
      <T muted size={11.5}>{h.episodes ? `${h.episodes} past episodes · lower after ${h.fwd_bars} sessions ${pct(h.lower_share)} (any bar: ${pct(h.uncond_lower_share)}) · avg ${signed(h.avg_fwd_pct)} · typical dip ${signed(h.median_dip_pct)} within ${h.dip_bars}` : `No previous episode above ${h.threshold} in the last 2 years.`}</T>
      <T muted size={11.5}>Mean (SMA20) {fmt(r.sma20)} · {signed(r.to_sma20_pct, 1)} away · ATR {r.atr_pct?.toFixed(1) ?? '—'}%  ›  tap for chart</T>
    </Card>
  );
}
function SummaryDaily({ d }: { d: any }) {
  const c = useColors();
  const b = d.base_rate, cnt = d.counts || {};
  const edge = b.lower_share != null && b.uncond_lower_share != null ? b.lower_share - b.uncond_lower_share : null;
  return (
    <Card>
      <Row wrap gap={6}>
        <Tile k="Stretched · 50+" v={cnt.stretched ?? 0} color={c.down} /><Tile k="Extended · 35-49" v={cnt.extended ?? 0} color={c.flat} />
        <Tile k="Warming · 20-34" v={cnt.warming ?? 0} /><Tile k="Scanned" v={d.scanned} sub={d.name} />
      </Row>
      <T size={12.5}>{b.episodes ? `Base rate for ${d.name}, last ${b.years} years: the score crossed ${b.threshold} ${b.episodes} times; ${pct(b.lower_share)} of those were lower ${b.fwd_bars} sessions later (any bar: ${pct(b.uncond_lower_share)}), average ${signed(b.avg_fwd_pct)} versus ${signed(b.uncond_avg_fwd_pct)} for any bar. ${edge == null ? '' : edge >= 0.1 ? 'Stretched names here have, on average, given some of the run back.' : edge <= -0.05 ? 'Stretched names here have, on average, kept running: treat the score as a warning, not a signal.' : 'On average a stretched name here has done about the same as any other bar: the per-stock record matters more than the score.'}` : 'No history yet.'}</T>
    </Card>
  );
}
function RulesCard({ d, today, side }: { d: any; today: boolean; side: Side }) {
  return (
    <Card>
      <T size={12.5}>{today
        ? 'Every 5-minute bar of the session is scored 0-100 with six published intraday rules; a rule adds nothing until it triggers and its full weight at an extreme. Cards show the PEAK score today, when it happened, and the score now. Tested on 60 days of 5-minute bars (NIFTY 100 + mid/small caps): a stock far from its open is roughly a coin flip for the rest of the day. The one version that held up in both halves of the sample is on the up side - reached 35+ and then gave back half the run: about 63% closed lower, but only about -0.3% on average, less than a round trip of costs on a small position. The down side (falls) showed no reliable bounce.'
        : 'The score adds up ten published overbought and exhaustion rules on daily bars. Tiers were set from two years of NIFTY 100 bars (20+ about six names a day, 35+ two, 50+ under one). Strong stocks tend to keep going for months (Jegadeesh & Titman; George & Hwang), while the sessions right after an extreme tend to give some back (Connors, Bollinger) - so each card shows the stock\'s own record next to the base rate.'}</T>
      {d.rules?.map((r: any) => (
        <View key={r.key} style={{ marginTop: 6 }}>
          <T bold size={12.5}>{r.label} · {r.weight} pts</T>
          <T muted size={12}>{r.rule}</T>
          <T muted size={11}>{r.origin}</T>
        </View>
      ))}
      {today && side === 'down' ? <T size={12} style={{ marginTop: 6 }}>Falls use the same rules turned upside down (ATR below the open, sigma below VWAP, through S1-S3, RSI below 30, share of the fall recovered).</T> : null}
    </Card>
  );
}
