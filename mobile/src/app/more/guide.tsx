/** Strategy guide - port of the web app's Guide tab: every strategy, model and learner, grouped and searchable. */
import { useMemo, useState } from 'react';
import { Pressable, TextInput, View } from 'react-native';

import { Body, CAT_LABEL } from '@/components/more/common';
import { guideRows, GuideRow } from '@/components/more/catalog';
import { latestAnalysis } from '@/services/last-analysis';
import { Badge, Card, Chip, Row, T, useColors } from '@/ui/kit';

const ORDER = ['trend', 'momentum', 'volatility', 'volume', 'price_action', 'levels', 'statistical', 'regime', 'ml'];
const KIND_LABEL: Record<GuideRow['kind'], string> = { strategy: 'strategy', model: 'model', regime: 'regime', learner: 'learner' };

export default function GuideScreen() {
  const c = useColors();
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<string>('');
  const [open, setOpen] = useState<string | null>(null);
  const all = useMemo(() => guideRows((latestAnalysis()?.result.signals as any[]) ?? []), []);
  const cats = useMemo(() => ORDER.filter((k) => all.some((r) => r.category === k)).concat([...new Set(all.map((r) => r.category))].filter((k) => !ORDER.includes(k))), [all]);
  const needle = q.trim().toLowerCase();
  const shown = all.filter((r) => (!cat || r.category === cat) && (!needle || `${r.name} ${r.key} ${r.origin} ${r.rules} ${r.doc}`.toLowerCase().includes(needle)));

  return (
    <Body>
      <TextInput value={q} onChangeText={setQ} placeholder={`Search ${all.length} strategies, models and learners`} placeholderTextColor={c.muted} autoCorrect={false}
        style={{ borderWidth: 1, borderColor: c.border, borderRadius: 9, paddingHorizontal: 10, paddingVertical: 8, color: c.text, backgroundColor: c.panel }} />
      <Row wrap gap={6}>
        <Chip small label="All" on={!cat} onPress={() => setCat('')} />
        {cats.map((k) => <Chip key={k} small label={`${CAT_LABEL[k] ?? k} ${all.filter((r) => r.category === k).length}`} on={cat === k} onPress={() => setCat(cat === k ? '' : k)} />)}
      </Row>
      {cats.filter((k) => shown.some((r) => r.category === k)).map((k) => (
        <View key={k} style={{ gap: 6 }}>
          <T muted bold size={11.5} style={{ textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 4 }}>{CAT_LABEL[k] ?? k}</T>
          {shown.filter((r) => r.category === k).map((r) => {
            const isOpen = open === r.key || !!needle;
            const [first, ...rest] = r.doc.split('\n');
            return (
              <Card key={r.key} onPress={() => setOpen(open === r.key ? null : r.key)} style={{ gap: 4 }}>
                <Row gap={6}><T bold size={14} style={{ flex: 1 }}>{r.name}</T><Badge>{KIND_LABEL[r.kind]}</Badge></Row>
                {r.origin ? <T muted size={12} style={{ fontStyle: 'italic' }}>{r.origin}</T> : null}
                {r.doc ? <T size={12.5} numberOfLines={isOpen ? undefined : 2}>{first}{rest.length ? ' ' + rest.join(' ') : ''}</T> : null}
                {isOpen && r.rules ? <T size={12.5}><T bold size={12.5}>Rules: </T>{r.rules}</T> : null}
                {!isOpen && r.rules ? <Pressable onPress={() => setOpen(r.key)}><T size={11.5} color={c.accent}>Rules ›</T></Pressable> : null}
              </Card>
            );
          })}
        </View>
      ))}
      {!shown.length ? <Card><T muted>Nothing matches “{q}”.</T></Card> : null}
    </Body>
  );
}
