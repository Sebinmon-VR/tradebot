/** Browser-preview version of the chart: the same page in an iframe (react-native-webview has no web build). */
import { createElement, forwardRef, useImperativeHandle, useMemo, useRef } from 'react';
import { useColorScheme, View } from 'react-native';

import { ChartPayload, ChartTail, chartHtml } from './chart-html';

export interface ChartHandle { set(p: ChartPayload): void; tail(t: ChartTail): void; reset(): void }

export const ChartView = forwardRef<ChartHandle, { height: number | `${number}%` }>(function ChartView({ height }, ref) {
  const dark = useColorScheme() === 'dark';
  const frame = useRef<HTMLIFrameElement | null>(null);
  const ready = useRef(false);
  const queued = useRef<{ fn: string; arg: unknown }[]>([]);
  const html = useMemo(() => chartHtml(dark), [dark]);
  const send = (fn: string, arg: unknown) => {
    const w = frame.current?.contentWindow as any;
    if (ready.current && w?.tb) w.tb[fn](arg); else queued.current.push({ fn, arg });
  };
  useImperativeHandle(ref, () => ({ set: (p) => send('set', p), tail: (t) => send('tail', t), reset: () => send('reset', null) }));
  return (
    <View style={{ height, borderRadius: 10, overflow: 'hidden' }}>
      {createElement('iframe', {
        ref: frame, srcDoc: html, style: { border: 0, width: '100%', height: '100%' },
        onLoad: () => {
          ready.current = true;
          const w = frame.current?.contentWindow as any;
          for (const q of queued.current) w?.tb?.[q.fn](q.arg);
          queued.current = [];
        },
      })}
    </View>
  );
});
