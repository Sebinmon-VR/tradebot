/**
 * Market map - port of static/screener.html/.js: every stock of a universe as a tile sized by market cap,
 * grouped by sector and coloured by the chosen metric; filters as chips; tap a tile for its chart.
 */
import { router } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, Switch, Text, TextInput, View } from 'react-native';

import type { ScreenerRow } from '@/engine/screener';
import { UNIVERSES } from '@/engine/universe';
import { afterMeta, redecorate, scanMap } from '@/services/scans';
import { getJson, setJson } from '@/storage/db';
import { Card, Choice, ErrorBox, Header, Loading, Row, Screen, T, crore, fmt, signed, toneOf, useColors } from '@/ui/kit';
import { METRICS, SCALE_COLORS, colorFor, scaleFor, squarify } from '@/ui/treemap';

const FILTERS: Record<string, [string, (r: ScreenerRow) => boolean, string?]> = {
  all: ['All', () => true],
  gainers: ['Top gainers', (r) => r.chg_1d > 0, 'chg_1d'],
  losers: ['Top losers', (r) => r.chg_1d < 0, 'chg_1d'],
  active: ['Most active', (r) => r.vol_ratio != null && r.vol_ratio >= 1.5, 'vol_ratio'],
  volatile: ['Most volatile', (r) => r.range_pct >= 3, 'range_pct'],
  gap: ['Big gaps', (r) => Math.abs(r.gap) >= 1, 'gap'],
  oversold: ['Oversold RSI<30', (r) => r.rsi != null && r.rsi < 30, 'rsi'],
  overbought: ['Overbought RSI>70', (r) => r.rsi != null && r.rsi > 70, 'rsi'],
  overextended: ['Overextended ⤵', (r) => r.ext_score != null && r.ext_score >= 20, 'ext_score'],
  high52: ['Near 52-wk high', (r) => r.dist_52w_high >= -5, 'pos_52w'],
  low52: ['Near 52-wk low', (r) => r.pos_52w != null && r.pos_52w <= 15, 'pos_52w'],
  bull: ['Bullish trend', (r) => r.bias >= 3, 'bias'],
  bear: ['Bearish trend', (r) => r.bias <= -3, 'bias'],
};
interface Settings {
  universe: string; colorBy: string; filter: string; sizeBy: 'market_cap' | 'turnover' | 'volume' | 'equal'; groupBy: 'sector' | 'none';
  view: 'map' | 'table'; watchlist: string; sort: string; dir: 1 | -1;
}
const DEFAULTS: Settings = { universe: 'nifty100', colorBy: 'chg_1d', filter: 'all', sizeBy: 'market_cap', groupBy: 'sector', view: 'map', watchlist: '', sort: 'chg_1d', dir: -1 };
const REFRESH_S = 120;
// table columns (the web app's Table view): key, header, formatter
const COLS: [string, string, (r: ScreenerRow) => string][] = [
  ['price', 'Price', (r) => fmt(r.price)], ['chg_1d', 'Day %', (r) => signed(r.chg_1d)], ['gap', 'Gap %', (r) => signed(r.gap)],
  ['chg_5d', '5d %', (r) => signed(r.chg_5d)], ['chg_20d', '20d %', (r) => signed(r.chg_20d)], ['range_pct', 'Range %', (r) => (r.range_pct == null ? '—' : r.range_pct.toFixed(1))],
  ['vol_ratio', 'Vol ×', (r) => (r.vol_ratio == null ? '—' : r.vol_ratio.toFixed(1))], ['rsi', 'RSI', (r) => (r.rsi == null ? '—' : r.rsi.toFixed(0))],
  ['atr_pct', 'ATR %', (r) => (r.atr_pct == null ? '—' : r.atr_pct.toFixed(1))], ['pos_52w', '52w pos', (r) => (r.pos_52w == null ? '—' : r.pos_52w.toFixed(0) + '%')],
  ['bias', 'Bias', (r) => String(r.bias)], ['ext_score', 'Ext', (r) => (r.ext_score == null ? '—' : String(r.ext_score))],
  ['market_cap', 'Mkt cap', (r) => crore(r.market_cap)],
];

export default function MapScreen() {
  const c = useColors();
  const [s, setS] = useState<Settings>(DEFAULTS);
  const [loaded, setLoaded] = useState(false);
  const [data, setData] = useState<Awaited<ReturnType<typeof scanMap>> | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<[number, number]>([0, 0]);
  const [error, setError] = useState<string | null>(null);
  const [width, setWidth] = useState(0);
  const [auto, setAuto] = useState(false);
  const [search, setSearch] = useState('');
  const seq = useRef(0);

  useEffect(() => { getJson('map.settings', DEFAULTS).then((v) => { setS({ ...DEFAULTS, ...v }); setLoaded(true); }); }, []);
  const update = (patch: Partial<Settings>) => setS((o) => { const n = { ...o, ...patch }; setJson('map.settings', n); return n; });

  const load = useCallback(async (force = false) => {
    const my = ++seq.current;
    setBusy(true); setError(null);
    try {
      const res = await scanMap(s.universe, s.watchlist, (d, t) => { if (my === seq.current && (d % 5 === 0 || d === t)) setProgress([d, t]); }, force);
      if (my === seq.current) setData(res);
      // market caps arrive in the background: re-attach them a few seconds later
      afterMeta()?.then(() => { if (my === seq.current) setData((d) => (d ? { ...d, rows: redecorate(d.rows), meta_pending: false } : d)); });
    } catch (e) { if (my === seq.current) setError((e as Error).message); }
    finally { if (my === seq.current) setBusy(false); }
  }, [s.universe, s.watchlist]);
  useEffect(() => { if (loaded) { setData(null); load(); } }, [loaded, load]);
  useEffect(() => {
    if (!auto) return;
    const id = setInterval(() => load(true), REFRESH_S * 1000);
    return () => clearInterval(id);
  }, [auto, load]);

  const rows = useMemo(() => {
    if (!data) return [];
    let r = data.rows.filter(FILTERS[s.filter][1]);
    if (search) { const q = search.toUpperCase(); r = r.filter((x) => x.symbol.includes(q) || (x.sector || '').toUpperCase().includes(q)); }
    return r;
  }, [data, s.filter, search]);
  const sorted = useMemo(() => rows.slice().sort((a, b) => {
    if (s.sort === 'name') return s.dir * (a.name < b.name ? 1 : -1);
    return s.dir * (((b as any)[s.sort] ?? -1e18) - ((a as any)[s.sort] ?? -1e18));
  }), [rows, s.sort, s.dir]);
  const sc = useMemo(() => scaleFor(s.colorBy, rows), [rows, s.colorBy]);
  const H = Math.max(420, Math.round(width * 1.35));
  const tiles = useMemo(() => {
    if (!width || !rows.length) return { groups: [] as any[], tiles: [] as any[] };
    const known = rows.map((r) => r.market_cap).filter((x): x is number => !!x);
    const fallback = known.length ? Math.min(...known) * 0.6 : null;
    const size = (r: ScreenerRow) => (s.sizeBy === 'equal' ? 1 : s.sizeBy === 'turnover' ? Math.max(r.turnover, 1) : s.sizeBy === 'volume' ? Math.max(r.volume || 0, 1) : r.market_cap || fallback || Math.max(r.turnover, 1));
    const bySector = new Map<string, ScreenerRow[]>();
    for (const r of rows) { const k = s.groupBy === 'none' ? '' : r.sector || 'Other'; bySector.set(k, [...(bySector.get(k) ?? []), r]); }
    const gItems = [...bySector.entries()].map(([name, list]) => ({ name, list, size: list.reduce((a, r) => a + size(r), 0) }));
    const HEAD = s.groupBy === 'none' ? 0 : 15, groups: any[] = [], out: any[] = [];
    for (const g of squarify(gItems, 0, 0, width, H)) {
      groups.push(g);
      const inner = squarify(g.item.list.map((r) => ({ r, size: size(r) })), g.x + 1, g.y + HEAD + 1, g.w - 2, g.h - HEAD - 2);
      out.push(...inner);
    }
    return { groups, tiles: out };
  }, [rows, width, H, s.sizeBy, s.groupBy]);

  const m = METRICS[s.colorBy];
  const idx = data?.indices ?? [];
  return (
    <Screen refresh={<RefreshControl refreshing={false} onRefresh={() => load(true)} />}>
      <Header title="Market map" sub="tile size = market cap · colour = the metric you pick · tap a tile for its chart"
        right={<Row gap={4}><T muted size={11}>Auto</T><Switch value={auto} onValueChange={setAuto} /></Row>} />
      {idx.length ? (
        <Row wrap gap={10}>
          {idx.map((i) => <T key={i.symbol} size={12.5}><T bold size={12.5}>{i.name} </T>{fmt(i.price)} <T size={12.5} color={toneOf(c, i.chg_1d)}>{signed(i.chg_1d)}</T></T>)}
        </Row>
      ) : null}
      <Choice label="Universe" small value={s.universe} options={Object.values(UNIVERSES).map((u) => [u.key, `${u.name} (${u.symbols.length})`])} onChange={(universe) => update({ universe })} />
      <Choice label="Show" small value={s.filter} options={Object.entries(FILTERS).map(([k, v]) => [k, v[0]])} onChange={(filter) => update({ filter, colorBy: FILTERS[filter][2] ?? s.colorBy })} />
      <Choice label="Colour by" small value={s.colorBy} options={Object.entries(METRICS).map(([k, v]) => [k, v.label])} onChange={(colorBy) => update({ colorBy })} />
      <Choice label="View" small value={s.view} options={[['map', '▦ Map'], ['table', '☰ Table']]} onChange={(view) => update({ view })} />
      {s.view === 'map' ? (
        <>
          <Choice label="Size by" small value={s.sizeBy} options={[['market_cap', 'Market cap'], ['turnover', 'Turnover today'], ['volume', 'Volume'], ['equal', 'Equal']]} onChange={(sizeBy) => update({ sizeBy })} />
          <Choice label="Group by" small value={s.groupBy} options={[['sector', 'Sector'], ['none', 'None']]} onChange={(groupBy) => update({ groupBy })} />
        </>
      ) : (
        <Choice label="Sort by (tap again to reverse)" small value={s.sort} options={[['name', 'Name'], ...COLS.map(([k, h]) => [k, h] as [string, string])]}
          onChange={(sort) => update(sort === s.sort ? { dir: s.dir === 1 ? -1 : 1 } : { sort, dir: -1 })} />
      )}
      <TextInput placeholder="My watchlist (comma separated, added to the map)" placeholderTextColor={c.muted} defaultValue={s.watchlist} autoCapitalize="characters"
        onEndEditing={(e) => update({ watchlist: e.nativeEvent.text.trim() })}
        style={{ borderWidth: 1, borderColor: c.border, borderRadius: 9, paddingHorizontal: 10, paddingVertical: 8, color: c.text, backgroundColor: c.panel }} />
      <TextInput placeholder="filter symbols or sectors…" placeholderTextColor={c.muted} value={search} onChangeText={setSearch} autoCapitalize="characters"
        style={{ borderWidth: 1, borderColor: c.border, borderRadius: 9, paddingHorizontal: 10, paddingVertical: 6, color: c.text, backgroundColor: c.panel }} />
      {error ? <ErrorBox message={error} onRetry={() => load(true)} /> : null}
      {busy && !data ? <Loading text="Downloading daily bars…" done={progress[0]} total={progress[1]} /> : null}
      {data ? (
        <>
          <Row gap={6}>
            <T muted size={11}>{m.fmt(sc.kind === 'seq' ? sc.center : sc.center - sc.limit)}</T>
            <View style={{ flex: 1, height: 8, borderRadius: 4, flexDirection: 'row', overflow: 'hidden' }}>
              {(sc.kind === 'seq' ? [SCALE_COLORS.mid, SCALE_COLORS.seq] : [SCALE_COLORS.neg, SCALE_COLORS.mid, SCALE_COLORS.pos]).map((col) => <View key={col} style={{ flex: 1, backgroundColor: col }} />)}
            </View>
            <T muted size={11}>{m.fmt(sc.center + sc.limit)}{sc.kind === 'seq' ? '+' : ''}</T>
          </Row>
          <T muted size={11.5}>{rows.length} of {data.count} stocks · {new Date(data.generated_at).toLocaleTimeString()} ({data.took_s.toFixed(1)}s){busy ? ' · refreshing…' : ''}{data.meta_pending ? ' · market caps loading' : ''}</T>
          {s.view === 'table' ? <Table rows={sorted} sort={s.sort} dir={s.dir} /> : null}
          <View onLayout={(e) => setWidth(Math.floor(e.nativeEvent.layout.width))} style={{ height: s.view === 'map' ? H : 0, borderRadius: 8, overflow: 'hidden', backgroundColor: c.panel2 }}>
            {tiles.groups.map((g) => (
              <View key={g.item.name} style={{ position: 'absolute', left: g.x, top: g.y, width: g.w, height: g.h, borderWidth: 1, borderColor: c.bg }}>
                <Text numberOfLines={1} style={{ color: c.muted, fontSize: 10, fontWeight: '700', paddingHorizontal: 3, height: 15 }}>{g.item.name.toUpperCase()}</Text>
              </View>
            ))}
            {tiles.tiles.map((t) => {
              const r: ScreenerRow = t.item.r, big = t.w > 46 && t.h > 30;
              return (
                <Pressable key={r.symbol} onPress={() => router.navigate({ pathname: '/chart', params: { symbol: r.symbol } })}
                  style={{ position: 'absolute', left: t.x + 1, top: t.y + 1, width: Math.max(0, t.w - 2), height: Math.max(0, t.h - 2), backgroundColor: colorFor((r as any)[s.colorBy], sc), borderRadius: 3, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
                  {t.w > 30 && t.h > 16 ? <Text numberOfLines={1} style={{ color: '#fff', fontSize: big ? 11 : 9, fontWeight: '800' }}>{r.name}</Text> : null}
                  {big ? <Text numberOfLines={1} style={{ color: '#fff', fontSize: 10 }}>{m.fmt((r as any)[s.colorBy])}</Text> : null}
                </Pressable>
              );
            })}
          </View>
          {s.view === 'map' ? <Card>
            <T bold>Top {Math.min(10, rows.length)} by {m.label}</T>
            {rows.slice().sort((a, b) => ((b as any)[s.colorBy] ?? -1e9) - ((a as any)[s.colorBy] ?? -1e9)).slice(0, 10).map((r) => (
              <Pressable key={r.symbol} onPress={() => router.navigate({ pathname: '/chart', params: { symbol: r.symbol } })}>
                <Row style={{ justifyContent: 'space-between', paddingVertical: 4 }}>
                  <T bold>{r.name}</T>
                  <T muted size={12}>{fmt(r.price)} · <T size={12} color={toneOf(c, r.chg_1d)}>{signed(r.chg_1d)}</T>{s.colorBy !== 'chg_1d' ? ` · ${m.fmt((r as any)[s.colorBy])}` : ''}</T>
                </Row>
              </Pressable>
            ))}
          </Card> : null}
        </>
      ) : null}
    </Screen>
  );
}

/** The web app's sortable Table view: one row per stock; scroll sideways for every column. */
function Table({ rows, sort, dir }: { rows: ScreenerRow[]; sort: string; dir: 1 | -1 }) {
  const c = useColors();
  const W = 64;
  const tone = (k: string, r: ScreenerRow) => (['chg_1d', 'gap', 'chg_5d', 'chg_20d', 'bias'].includes(k) ? toneOf(c, (r as any)[k]) : c.text);
  const arrow = dir === -1 ? ' ▼' : ' ▲';
  return (
    <Card style={{ padding: 0, gap: 0 }}>
      <ScrollView horizontal showsHorizontalScrollIndicator>
        <View>
          <Row gap={0} style={{ borderBottomWidth: 1, borderBottomColor: c.border, paddingVertical: 6 }}>
            <T bold size={11} style={{ width: 100, paddingLeft: 8 }}>Symbol{sort === 'name' ? arrow : ''}</T>
            {COLS.map(([k, h]) => <T key={k} bold size={11} style={{ width: W, textAlign: 'right' }} color={k === sort ? c.accent : c.muted}>{h}{k === sort ? arrow : ''}</T>)}
          </Row>
          {rows.map((r) => (
            <Pressable key={r.symbol} onPress={() => router.navigate({ pathname: '/chart', params: { symbol: r.symbol } })}>
              <Row gap={0} style={{ borderBottomWidth: 1, borderBottomColor: c.border, paddingVertical: 6 }}>
                <View style={{ width: 100, paddingLeft: 8 }}><T bold size={12} numberOfLines={1}>{r.name}</T><T muted size={9.5} numberOfLines={1}>{r.sector}</T></View>
                {COLS.map(([k, , f]) => <T key={k} size={12} style={{ width: W, textAlign: 'right' }} color={tone(k, r)}>{f(r)}</T>)}
              </Row>
            </Pressable>
          ))}
        </View>
      </ScrollView>
    </Card>
  );
}
