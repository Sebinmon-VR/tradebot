/** Candlestick chart for the phone: Lightweight Charts inside a WebView, fed through injectJavaScript. */
import { forwardRef, useImperativeHandle, useMemo, useRef } from 'react';
import { useColorScheme, View } from 'react-native';
import { WebView } from 'react-native-webview';

import { ChartPayload, ChartTail, chartHtml } from './chart-html';

export interface ChartHandle { set(p: ChartPayload): void; tail(t: ChartTail): void; reset(): void }

export const ChartView = forwardRef<ChartHandle, { height: number | `${number}%` }>(function ChartView({ height }, ref) {
  const dark = useColorScheme() === 'dark';
  const web = useRef<WebView>(null);
  const ready = useRef(false);
  const queued = useRef<string[]>([]);
  const html = useMemo(() => chartHtml(dark), [dark]);
  const send = (fn: string, arg: unknown) => {
    const js = `window.tb && window.tb.${fn}(${JSON.stringify(arg)}); true;`;
    if (ready.current) web.current?.injectJavaScript(js); else queued.current.push(js);
  };
  const lastSet = useRef<ChartPayload | null>(null);   // re-sent when the page reloads (e.g. dark-mode switch)
  useImperativeHandle(ref, () => ({
    set: (p) => { lastSet.current = p; queued.current = queued.current.filter((q) => !q.includes('.set(')); send('set', p); },
    tail: (t) => send('tail', t),
    reset: () => send('reset', null),
  }));
  return (
    <View style={{ height, borderRadius: 10, overflow: 'hidden' }}>
      <WebView
        ref={web} originWhitelist={['*']} source={{ html }} javaScriptEnabled scrollEnabled={false} bounces={false} overScrollMode="never"
        nestedScrollEnabled setBuiltInZoomControls={false} setDisplayZoomControls={false} style={{ backgroundColor: 'transparent' }}
        onMessage={(e) => {
          try {
            if (JSON.parse(e.nativeEvent.data).ready) {
              const reload = ready.current;
              ready.current = true;
              if (reload && lastSet.current) send('set', { ...lastSet.current, fit: true });
              for (const js of queued.current) web.current?.injectJavaScript(js);
              queued.current = [];
            }
          } catch { /* not ours */ }
        }}
      />
    </View>
  );
});
