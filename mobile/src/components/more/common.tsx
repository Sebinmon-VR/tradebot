/** Small shared pieces for the More screens (History, Accuracy, Guide, Learning, Backtest). */
import { ReactNode } from 'react';
import { ScrollView, Text, View, ViewStyle } from 'react-native';

import { Badge, T, useColors } from '@/ui/kit';

/** Scrolling body under a Stack header (the header already handles the top safe area). */
export function Body({ children, refresh }: { children: ReactNode; refresh?: ReactNode }) {
  const c = useColors();
  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.bg }} contentContainerStyle={{ padding: 12, paddingBottom: 110, gap: 10 }}
      keyboardShouldPersistTaps="handled" refreshControl={refresh as any}>
      {children}
    </ScrollView>
  );
}

/** Section heading inside a card or between cards. */
export function H({ children, sub }: { children: ReactNode; sub?: string }) {
  const c = useColors();
  return (
    <View style={{ marginTop: 4 }}>
      <Text style={{ color: c.muted, fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 }}>{children}</Text>
      {sub ? <Text style={{ color: c.muted, fontSize: 11.5, marginTop: 1 }}>{sub}</Text> : null}
    </View>
  );
}

/** A plain note paragraph. */
export function Note({ children }: { children: ReactNode }) {
  return <T muted size={12.5} style={{ lineHeight: 18 }}>{children}</T>;
}

/** A compact table: `cols` gives flex widths; the first column is left-aligned, the rest right-aligned. */
export function Table({ head, rows, flex, highlight }: { head: string[]; rows: ReactNode[][]; flex?: number[]; highlight?: (i: number) => boolean }) {
  const c = useColors();
  const f = flex ?? head.map((_, i) => (i === 0 ? 2.2 : 1));
  const cell = (i: number): ViewStyle => ({ flex: f[i], alignItems: i === 0 ? 'flex-start' : 'flex-end', justifyContent: 'center' });
  return (
    <View>
      <View style={{ flexDirection: 'row', paddingVertical: 5, borderBottomWidth: 1, borderBottomColor: c.border, gap: 6 }}>
        {head.map((h, i) => <View key={i} style={cell(i)}><Text style={{ color: c.muted, fontSize: 10.5, textTransform: 'uppercase', letterSpacing: 0.3 }}>{h}</Text></View>)}
      </View>
      {rows.map((r, k) => (
        <View key={k} style={{ flexDirection: 'row', paddingVertical: 6, borderBottomWidth: k === rows.length - 1 ? 0 : 1, borderBottomColor: c.border, gap: 6, backgroundColor: highlight?.(k) ? c.accent + '18' : undefined }}>
          {r.map((v, i) => <View key={i} style={cell(i)}>{typeof v === 'string' || typeof v === 'number' ? <T size={12.5}>{v}</T> : v}</View>)}
        </View>
      ))}
    </View>
  );
}

/** Key / value pair in a two-column grid. */
export function KV({ k, v, sub }: { k: string; v: ReactNode; sub?: string }) {
  const c = useColors();
  return (
    <View style={{ flexBasis: '47%', flexGrow: 1, backgroundColor: c.panel2, borderRadius: 8, padding: 8 }}>
      <Text style={{ color: c.muted, fontSize: 10.5, textTransform: 'uppercase', letterSpacing: 0.3 }}>{k}</Text>
      {typeof v === 'string' || typeof v === 'number' ? <T bold size={14}>{v}</T> : v}
      {sub ? <Text style={{ color: c.muted, fontSize: 11 }}>{sub}</Text> : null}
    </View>
  );
}
export function Grid({ children }: { children: ReactNode }) {
  return <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>{children}</View>;
}

/** ISO string -> Date; a naive ISO (bar times are naive UTC) is read as UTC. */
export function parseWhen(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const s = /[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso + 'Z';
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}
export function when(iso: string | null | undefined, withYear = false) {
  const d = parseWhen(iso);
  return d ? d.toLocaleString('en-IN', { day: 'numeric', month: 'short', ...(withYear ? { year: '2-digit' } : null), hour: '2-digit', minute: '2-digit' }) : '—';
}
/** A bar's time: date only for daily / weekly bars. */
export function whenBar(iso: string | null | undefined, interval: string) {
  const d = parseWhen(iso);
  if (!d) return '—';
  return interval === '1d' || interval === '1wk'
    ? d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
    : d.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function OutcomeBadge({ o, pendingLabel = 'pending' }: { o: string | null | undefined; pendingLabel?: string }) {
  if (!o) return <Badge>{pendingLabel}</Badge>;
  if (o === 'no_call') return <Badge>no call</Badge>;
  return <Badge tone={o === 'correct' ? 'ok' : o === 'partial' ? 'mid' : 'bad'}>{o}</Badge>;
}
export function CallBadge({ d }: { d: string }) {
  return d === 'UP' ? <Badge tone="ok">▲ UP</Badge> : d === 'DOWN' ? <Badge tone="bad">▼ DOWN</Badge> : <Badge>◆ NO CALL</Badge>;
}
export function VoteText({ d }: { d: number }) {
  const c = useColors();
  return d > 0 ? <T size={12} bold color={c.up}>▲ UP</T> : d < 0 ? <T size={12} bold color={c.down}>▼ DOWN</T> : <T size={12} muted>– neutral</T>;
}
export const stars = (n: number | null | undefined) => (n ? '★'.repeat(n) + '☆'.repeat(Math.max(0, 5 - n)) : '');

export const CAT_LABEL: Record<string, string> = { trend: 'Trend', momentum: 'Momentum', volatility: 'Volatility', volume: 'Volume', price_action: 'Price action', levels: 'Levels', statistical: 'Statistical', model: 'Statistical', ml: 'Machine learning', regime: 'Regime', error: 'Error' };
export const EVIDENCE_LABEL: Record<string, string> = { strong: 'strong (beats the drift)', weak: 'weak (probably beats the drift)', drift: 'drift only (follows the prevailing trend)', none: 'none (no validated edge)' };
