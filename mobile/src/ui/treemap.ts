/** Squarified treemap (Bruls, Huizing & van Wijk, 2000) and the map's colour scales - ported from static/screener.js. */
export interface Rect<T> { item: T; x: number; y: number; w: number; h: number }

export function squarify<T extends { size: number }>(items: T[], x: number, y: number, w: number, h: number): Rect<T>[] {
  const out: Rect<T>[] = [];
  const total = items.reduce((s, i) => s + i.size, 0);
  if (!items.length || total <= 0 || w <= 0 || h <= 0) return out;
  const scale = (w * h) / total;
  const list = items.slice().sort((a, b) => b.size - a.size).map((i) => ({ item: i, area: i.size * scale }));
  let cx = x, cy = y, cw = w, ch = h, row: typeof list = [], rowSum = 0;
  const worst = (r: typeof list, s: number, side: number) => {
    if (!side || !s) return Infinity;
    let mx = 0, mn = Infinity;
    for (const q of r) { mx = Math.max(mx, q.area); mn = Math.min(mn, q.area); }
    return Math.max((side * side * mx) / (s * s), (s * s) / (side * side * mn));
  };
  const layoutRow = () => {
    if (cw >= ch) { const rw = rowSum / ch; let oy = cy; for (const q of row) { const rh = q.area / rw; out.push({ item: q.item, x: cx, y: oy, w: rw, h: rh }); oy += rh; } cx += rw; cw -= rw; }
    else { const rh = rowSum / cw; let ox = cx; for (const q of row) { const rw = q.area / rh; out.push({ item: q.item, x: ox, y: cy, w: rw, h: rh }); ox += rw; } cy += rh; ch -= rh; }
    row = []; rowSum = 0;
  };
  for (const q of list) {
    const side = Math.min(cw, ch);
    if (!row.length) { row.push(q); rowSum = q.area; continue; }
    if (worst(row.concat(q), rowSum + q.area, side) <= worst(row, rowSum, side)) { row.push(q); rowSum += q.area; }
    else { layoutRow(); row.push(q); rowSum = q.area; }
  }
  if (row.length) layoutRow();
  return out;
}

export interface Metric { label: string; kind: 'div' | 'seq'; floor: number; center?: number; fmt: (v: number | null | undefined) => string }
const sg = (v: number | null | undefined, d = 2) => (v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(d)}%`);
export const METRICS: Record<string, Metric> = {
  chg_1d: { label: 'Day %', kind: 'div', floor: 1.5, fmt: (v) => sg(v) },
  gap: { label: 'Gap %', kind: 'div', floor: 1, fmt: (v) => sg(v) },
  chg_5d: { label: '5-day %', kind: 'div', floor: 3, fmt: (v) => sg(v) },
  chg_20d: { label: '20-day %', kind: 'div', floor: 6, fmt: (v) => sg(v) },
  rsi: { label: 'RSI 14', kind: 'div', center: 50, floor: 20, fmt: (v) => (v == null ? '—' : v.toFixed(0)) },
  pos_52w: { label: '52-week position', kind: 'div', center: 50, floor: 50, fmt: (v) => (v == null ? '—' : v.toFixed(0) + '%') },
  bias: { label: 'Trend bias', kind: 'div', floor: 5, fmt: (v) => (v == null ? '—' : (v > 0 ? '+' : '') + v) },
  vol_ratio: { label: 'Volume × 20-day', kind: 'seq', floor: 2, fmt: (v) => (v == null ? '—' : v.toFixed(1) + '×') },
  range_pct: { label: 'Day range %', kind: 'seq', floor: 3, fmt: (v) => (v == null ? '—' : v.toFixed(1) + '%') },
  ext_score: { label: 'Overextension', kind: 'seq', floor: 35, fmt: (v) => (v == null ? '—' : v.toFixed(0)) },
};
const C_NEG = [216, 67, 60], C_MID = [150, 158, 170], C_POS = [18, 144, 122], C_SEQ = [47, 111, 237], C_NA = [190, 196, 205];
const mix = (a: number[], b: number[], t: number) => a.map((x, i) => Math.round(x + (b[i] - x) * t));
export const rgb = (c: number[]) => `rgb(${c[0]},${c[1]},${c[2]})`;
export const SCALE_COLORS = { neg: rgb(C_NEG), mid: rgb(C_MID), pos: rgb(C_POS), seq: rgb(C_SEQ) };
export interface Scale { center: number; limit: number; kind: 'div' | 'seq' }
/** The 90th percentile of |value - center| sets the full-colour point, never below the metric's floor. */
export function scaleFor(key: string, rows: Record<string, any>[]): Scale {
  const m = METRICS[key], center = m.center ?? 0;
  const vals = rows.map((r) => r[key]).filter((v) => v != null).map((v: number) => Math.abs(v - center)).sort((a, b) => a - b);
  const p90 = vals.length ? vals[Math.floor(vals.length * 0.9)] : m.floor;
  return { center, limit: Math.max(m.floor, p90), kind: m.kind };
}
export function colorFor(v: number | null | undefined, sc: Scale): string {
  if (v == null) return rgb(C_NA);
  if (sc.kind === 'seq') return rgb(mix(C_MID, C_SEQ, Math.max(0, Math.min(1, (v - sc.center) / sc.limit))));
  const t = Math.max(-1, Math.min(1, (v - sc.center) / sc.limit));
  return rgb(t >= 0 ? mix(C_MID, C_POS, t) : mix(C_MID, C_NEG, -t));
}
