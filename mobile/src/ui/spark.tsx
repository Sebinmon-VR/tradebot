/** Sparkline (react-native-svg): price lines plus labelled horizontal levels, drawn to the card's width. */
import { useState } from 'react';
import { View } from 'react-native';
import Svg, { Circle, Line, Polyline, Text as SvgText } from 'react-native-svg';

export interface SparkLine { values: (number | null)[]; color: string; width?: number; dash?: string; dot?: boolean }
export interface SparkLevel { value: number | null | undefined; color: string; label?: string }

export function Spark({ lines, levels = [], slots, height = 64 }: { lines: SparkLine[]; levels?: SparkLevel[]; slots?: number; height?: number }) {
  const [w, setW] = useState(0);
  const P = 3;
  const lv = levels.filter((l): l is SparkLevel & { value: number } => l.value != null && Number.isFinite(l.value));
  const all = lines.flatMap((l) => l.values.filter((v): v is number => v != null)).concat(lv.map((l) => l.value));
  const len = Math.max(2, slots ?? 0, ...lines.map((l) => l.values.length));
  if (all.length < 2) return <View style={{ height }} />;
  const lo = Math.min(...all), hi = Math.max(...all), span = hi - lo || 1;
  const px = (i: number) => P + (i * (w - 2 * P)) / (len - 1);
  const py = (v: number) => height - P - ((v - lo) / span) * (height - 2 * P);
  return (
    <View style={{ height }} onLayout={(e) => setW(e.nativeEvent.layout.width)}>
      {w > 0 ? (
        <Svg width={w} height={height}>
          {lv.map((l, i) => (
            <Line key={`l${i}`} x1={0} x2={w} y1={py(l.value)} y2={py(l.value)} stroke={l.color} strokeWidth={0.8} strokeDasharray="3 3" />
          ))}
          {lv.map((l, i) => (l.label ? <SvgText key={`t${i}`} x={w - 2} y={py(l.value) - 2} fontSize={8} fill={l.color} textAnchor="end">{l.label}</SvgText> : null))}
          {lines.map((l, i) => {
            const pts = l.values.map((v, j) => (v == null ? null : `${px(j).toFixed(1)},${py(v).toFixed(1)}`)).filter(Boolean).join(' ');
            return <Polyline key={`p${i}`} points={pts} fill="none" stroke={l.color} strokeWidth={l.width ?? 1.6} strokeDasharray={l.dash} />;
          })}
          {lines.filter((l) => l.dot).map((l, i) => {
            const j = l.values.length - 1, v = l.values[j];
            return v == null ? null : <Circle key={`c${i}`} cx={px(j)} cy={py(v)} r={2.6} fill={l.color} />;
          })}
        </Svg>
      ) : null}
    </View>
  );
}
