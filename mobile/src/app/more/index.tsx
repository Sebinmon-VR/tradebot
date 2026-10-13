/** More: the web app's drawer tabs and pop-ups (History, Accuracy, Guide, Learning, Backtest). */
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { View } from 'react-native';

import { Body } from '@/components/more/common';
import { latestAnalysis } from '@/services/last-analysis';
import { overallStats } from '@/services/predictions';
import { Card, Row, T, pct, useColors } from '@/ui/kit';

type Item = { href: string; icon: string; title: string; sub: (s: Awaited<ReturnType<typeof overallStats>> | null) => string };
const ITEMS: Item[] = [
  { href: '/more/history', icon: '🗂', title: 'History & feedback', sub: (s) => (s ? `${s.total_predictions} predictions · ${s.pending} pending` : 'every stored prediction') + ' · review, grade, delete' },
  { href: '/more/accuracy', icon: '🎯', title: 'Accuracy', sub: (s) => `hit rate of calls${s?.accuracy != null ? ` ${pct(s.accuracy, 1)}` : ''} · per-strategy track record and weights` },
  { href: '/more/learning', icon: '🧠', title: 'Learning', sub: () => { const a = latestAnalysis(); return a ? `what the learner learned on ${a.symbol} ${a.interval}` : 'what the walk-forward learner learned (analyse a chart first)'; } },
  { href: '/more/backtest', icon: '⏪', title: 'Backtest', sub: () => 'run the full analysis at past points and grade each call' },
  { href: '/more/guide', icon: '📖', title: 'Strategy guide', sub: () => 'every strategy, model and learner with its origin and rules' },
];

export default function MoreIndex() {
  const c = useColors();
  const [stats, setStats] = useState<Awaited<ReturnType<typeof overallStats>> | null>(null);
  useFocusEffect(useCallback(() => { overallStats().then(setStats).catch(() => setStats(null)); }, []));
  return (
    <Body>
      {ITEMS.map((it) => (
        <Card key={it.href} onPress={() => router.push(it.href as any)}>
          <Row gap={12}>
            <View style={{ width: 40, height: 40, borderRadius: 10, backgroundColor: c.panel2, alignItems: 'center', justifyContent: 'center' }}>
              <T size={20}>{it.icon}</T>
            </View>
            <View style={{ flex: 1 }}>
              <T bold size={15}>{it.title}</T>
              <T muted size={12}>{it.sub(stats)}</T>
            </View>
            <T muted size={20}>›</T>
          </Row>
        </Card>
      ))}
      <T muted size={11.5} style={{ textAlign: 'center', marginTop: 4 }}>Everything here runs and is stored on this phone.</T>
    </Body>
  );
}
