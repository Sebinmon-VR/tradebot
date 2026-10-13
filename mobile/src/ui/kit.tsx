/** Small shared UI kit for the four screens: colours (light / dark), chips, cards, badges, number formatting. */
import { ReactNode } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextStyle, View, ViewStyle, useColorScheme } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

const LIGHT = {
  bg: '#f5f6f8', panel: '#ffffff', panel2: '#eef0f4', border: '#dde1e7', text: '#1d2430', muted: '#6b7383',
  accent: '#2f6fed', up: '#12907a', down: '#d8433c', flat: '#b8800a', badge: '#eef0f4', chip: '#ffffff', chipOn: '#2f6fed',
};
const DARK: typeof LIGHT = {
  bg: '#0e1116', panel: '#171b22', panel2: '#20252e', border: '#2b313c', text: '#e6e9ee', muted: '#8b93a1',
  accent: '#5b8ff9', up: '#2bb593', down: '#ef6a62', flat: '#d9a53a', badge: '#232833', chip: '#171b22', chipOn: '#5b8ff9',
};
export type Palette = typeof LIGHT;
export function useColors(): Palette {
  return useColorScheme() === 'dark' ? DARK : LIGHT;
}

// ------------------------------------------------------------ formatting
export const fmt = (v: number | null | undefined, d = 2) => (v == null || !Number.isFinite(v) ? '—' : v.toLocaleString('en-IN', { maximumFractionDigits: d, minimumFractionDigits: d }));
export const signed = (v: number | null | undefined, d = 2) => (v == null || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(d)}%`);
export const pct = (v: number | null | undefined, d = 0) => (v == null ? '—' : `${(v * 100).toFixed(d)}%`);
export const inr = (v: number | null | undefined, d = 2) => (v == null || !Number.isFinite(v) ? '—' : `₹${fmt(v, d)}`);
export function crore(v: number | null | undefined) {
  if (v == null) return '—';
  const cr = v / 1e7;
  return cr >= 1e5 ? `₹${(cr / 1e5).toFixed(1)} L cr` : `₹${fmt(cr, 0)} cr`;
}
export const toneOf = (c: Palette, v: number | null | undefined) => (v == null || v === 0 ? c.text : v > 0 ? c.up : c.down);

// ------------------------------------------------------------ layout
export function Screen({ children, scroll = true, refresh }: { children: ReactNode; scroll?: boolean; refresh?: ReactNode }) {
  const c = useColors();
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: c.bg }} edges={['top', 'left', 'right']}>
      {scroll ? (
        <ScrollView contentContainerStyle={{ padding: 12, paddingBottom: 110, gap: 10 }} keyboardShouldPersistTaps="handled" refreshControl={refresh as any}>
          {children}
        </ScrollView>
      ) : <View style={{ flex: 1, padding: 12, gap: 10 }}>{children}</View>}
    </SafeAreaView>
  );
}
export function Header({ title, sub, right }: { title: string; sub?: string; right?: ReactNode }) {
  const c = useColors();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
      <View style={{ flex: 1 }}>
        <Text style={{ color: c.text, fontSize: 22, fontWeight: '800' }}>{title}</Text>
        {sub ? <Text style={{ color: c.muted, fontSize: 12.5, marginTop: 2 }}>{sub}</Text> : null}
      </View>
      {right}
    </View>
  );
}
export function Card({ children, style, onPress, accent }: { children: ReactNode; style?: ViewStyle; onPress?: () => void; accent?: string }) {
  const c = useColors();
  const box: ViewStyle = { backgroundColor: c.panel, borderRadius: 12, borderWidth: 1, borderColor: c.border, padding: 12, gap: 6, ...(accent ? { borderLeftWidth: 4, borderLeftColor: accent } : null), ...style };
  return onPress ? <Pressable onPress={onPress} style={({ pressed }) => [box, pressed && { opacity: 0.85 }]}>{children}</Pressable> : <View style={box}>{children}</View>;
}
export function T({ children, style, muted, bold, size, color, numberOfLines }: { children: ReactNode; style?: TextStyle; muted?: boolean; bold?: boolean; size?: number; color?: string; numberOfLines?: number }) {
  const c = useColors();
  return <Text numberOfLines={numberOfLines} style={[{ color: color ?? (muted ? c.muted : c.text), fontSize: size ?? 13.5, fontWeight: bold ? '700' : '400', fontVariant: ['tabular-nums'] }, style]}>{children}</Text>;
}

// ------------------------------------------------------------ controls
export function Chip({ label, on, onPress, small }: { label: string; on?: boolean; onPress?: () => void; small?: boolean }) {
  const c = useColors();
  return (
    <Pressable onPress={onPress} hitSlop={4} style={{ paddingHorizontal: small ? 9 : 12, paddingVertical: small ? 5 : 7, borderRadius: 999, borderWidth: 1, borderColor: on ? c.chipOn : c.border, backgroundColor: on ? c.chipOn : c.chip }}>
      <Text style={{ color: on ? '#fff' : c.text, fontSize: small ? 12 : 13, fontWeight: on ? '700' : '500' }}>{label}</Text>
    </Pressable>
  );
}
/** One-of-many choice as a horizontally scrolling chip row. */
export function Choice<K extends string | number>({ value, options, onChange, label, small }: { value: K; options: [K, string][]; onChange: (k: K) => void; label?: string; small?: boolean }) {
  const c = useColors();
  return (
    <View style={{ gap: 4 }}>
      {label ? <Text style={{ color: c.muted, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</Text> : null}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
        {options.map(([k, text]) => <Chip key={String(k)} label={text} on={k === value} small={small} onPress={() => onChange(k)} />)}
      </ScrollView>
    </View>
  );
}
export function Button({ title, onPress, kind = 'primary', disabled, busy }: { title: string; onPress: () => void; kind?: 'primary' | 'plain' | 'danger'; disabled?: boolean; busy?: boolean }) {
  const c = useColors();
  const bg = kind === 'primary' ? c.accent : kind === 'danger' ? c.down : c.panel2;
  return (
    <Pressable onPress={onPress} disabled={disabled || busy} style={({ pressed }) => ({ backgroundColor: bg, opacity: disabled ? 0.5 : pressed ? 0.8 : 1, paddingHorizontal: 14, paddingVertical: 9, borderRadius: 9, flexDirection: 'row', gap: 6, alignItems: 'center', justifyContent: 'center' })}>
      {busy ? <ActivityIndicator size="small" color={kind === 'plain' ? c.text : '#fff'} /> : null}
      <Text style={{ color: kind === 'plain' ? c.text : '#fff', fontWeight: '700', fontSize: 13.5 }}>{title}</Text>
    </Pressable>
  );
}
export type BadgeTone = 'bad' | 'ok' | 'mid' | 'plain';
export function Badge({ children, tone = 'plain' }: { children: ReactNode; tone?: BadgeTone }) {
  const c = useColors();
  const col = tone === 'bad' ? c.down : tone === 'ok' ? c.up : tone === 'mid' ? c.flat : c.muted;
  return (
    <View style={{ maxWidth: '100%', borderRadius: 6, paddingHorizontal: 7, paddingVertical: 3, backgroundColor: tone === 'plain' ? c.badge : col + '22', borderWidth: 1, borderColor: tone === 'plain' ? c.border : col + '66' }}>
      <Text style={{ color: tone === 'plain' ? c.text : col, fontSize: 11.5, fontWeight: '600' }}>{children}</Text>
    </View>
  );
}
export function Tile({ k, v, sub, color }: { k: string; v: ReactNode; sub?: string; color?: string }) {
  const c = useColors();
  return (
    <View style={{ backgroundColor: c.panel2, borderRadius: 9, padding: 10, minWidth: 96, flexGrow: 1, flexBasis: '30%' }}>
      <Text style={{ color: c.muted, fontSize: 10.5, textTransform: 'uppercase', letterSpacing: 0.4 }}>{k}</Text>
      <Text style={{ color: color ?? c.text, fontSize: 20, fontWeight: '800', marginTop: 2, fontVariant: ['tabular-nums'] }}>{v}</Text>
      {sub ? <Text style={{ color: c.muted, fontSize: 11 }}>{sub}</Text> : null}
    </View>
  );
}
export function Stat({ k, v, color }: { k: string; v: ReactNode; color?: string }) {
  const c = useColors();
  return (
    <View style={{ minWidth: 62 }}>
      <Text style={{ color: c.muted, fontSize: 9.5, textTransform: 'uppercase', letterSpacing: 0.4 }}>{k}</Text>
      <Text style={{ color: color ?? c.text, fontSize: 13, fontWeight: '600', fontVariant: ['tabular-nums'] }}>{v}</Text>
    </View>
  );
}
export function Row({ children, gap = 6, wrap, style }: { children: ReactNode; gap?: number; wrap?: boolean; style?: ViewStyle }) {
  return <View style={[{ flexDirection: 'row', alignItems: 'center', gap, flexWrap: wrap ? 'wrap' : 'nowrap' }, style]}>{children}</View>;
}
export function Loading({ text, done, total }: { text: string; done?: number; total?: number }) {
  const c = useColors();
  return (
    <Card style={{ alignItems: 'center', paddingVertical: 22 }}>
      <ActivityIndicator color={c.accent} />
      <T muted>{text}{total ? ` ${done ?? 0}/${total}` : ''}</T>
      {total ? <View style={{ height: 4, alignSelf: 'stretch', backgroundColor: c.panel2, borderRadius: 2, overflow: 'hidden' }}><View style={{ height: 4, width: `${((done ?? 0) / total) * 100}%`, backgroundColor: c.accent }} /></View> : null}
    </Card>
  );
}
export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const c = useColors();
  return (
    <Card style={{ borderColor: c.down }}>
      <T color={c.down} bold>Something went wrong</T>
      <T muted>{message}</T>
      {onRetry ? <View style={{ alignSelf: 'flex-start' }}><Button title="Try again" onPress={onRetry} kind="plain" /></View> : null}
    </Card>
  );
}
export const styles = StyleSheet.create({ grow: { flex: 1 } });
