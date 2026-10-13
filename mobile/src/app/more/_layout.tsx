/** The More section: History & feedback, Accuracy, Strategy guide, Learning, Backtest - a stack with headers. */
import { Stack } from 'expo-router';

import { useColors } from '@/ui/kit';

export default function MoreLayout() {
  const c = useColors();
  return (
    <Stack screenOptions={{
      headerStyle: { backgroundColor: c.panel }, headerTintColor: c.text, headerTitleStyle: { fontWeight: '700' },
      contentStyle: { backgroundColor: c.bg }, headerShadowVisible: false,
    }}>
      <Stack.Screen name="index" options={{ title: 'More' }} />
      <Stack.Screen name="history" options={{ title: 'History & feedback' }} />
      <Stack.Screen name="accuracy" options={{ title: 'Accuracy' }} />
      <Stack.Screen name="guide" options={{ title: 'Strategy guide' }} />
      <Stack.Screen name="learning" options={{ title: 'Learning' }} />
      <Stack.Screen name="backtest" options={{ title: 'Backtest' }} />
    </Stack>
  );
}
