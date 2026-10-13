/** Browser-preview tabs (the phone uses native tabs, see app-tabs.tsx): a bottom bar like the app's. */
import { TabList, TabSlot, TabTrigger, TabTriggerSlotProps, Tabs } from 'expo-router/ui';
import { Pressable, Text, View } from 'react-native';

import { useColors } from '@/ui/kit';

const TABS: [string, string, string][] = [['index', '/', '▦ Map'], ['scan', '/scan', '⤴ Today'], ['chart', '/chart', '▮ Chart'], ['portfolio', '/portfolio', '₹ Portfolio'], ['more', '/more', '☰ More']];

export default function AppTabs() {
  const c = useColors();
  return (
    <Tabs>
      <TabSlot style={{ height: '100%' }} />
      <TabList asChild>
        <View style={{ position: 'absolute', bottom: 0, left: 0, right: 0, flexDirection: 'row', backgroundColor: c.panel, borderTopWidth: 1, borderTopColor: c.border, paddingVertical: 6 }}>
          {TABS.map(([name, href, label]) => (
            <TabTrigger key={name} name={name} href={href as any} asChild>
              <TabButton>{label}</TabButton>
            </TabTrigger>
          ))}
        </View>
      </TabList>
    </Tabs>
  );
}

function TabButton({ children, isFocused, ...props }: TabTriggerSlotProps) {
  const c = useColors();
  return (
    <Pressable {...props} style={{ flex: 1, alignItems: 'center', paddingVertical: 6 }}>
      <Text style={{ color: isFocused ? c.accent : c.muted, fontWeight: isFocused ? '700' : '500', fontSize: 12.5 }}>{children}</Text>
    </Pressable>
  );
}
