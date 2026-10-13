import { DarkTheme, DefaultTheme, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { Platform, useColorScheme } from 'react-native';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import AppTabs from '@/components/app-tabs';
import { useProxy } from '@/engine/net';
import { initLearner } from '@/services/learner';
import { resolvePending } from '@/services/predictions';
import { useEffect } from 'react';

SplashScreen.preventAutoHideAsync();
// a browser cannot call Yahoo directly (no CORS headers): the web preview goes through scripts/dev-proxy.js
if (Platform.OS === 'web' && __DEV__) useProxy('http://localhost:8787');
initLearner();

const GRADE_EVERY_MS = 10 * 60 * 1000;

export default function TabLayout() {
  const colorScheme = useColorScheme();
  // grade stored predictions whose horizon has passed (evaluator), now and every 10 minutes while open
  useEffect(() => {
    const run = () => resolvePending().catch(() => { /* retried next time */ });
    const first = setTimeout(run, 5000);
    const id = setInterval(run, GRADE_EVERY_MS);
    return () => { clearTimeout(first); clearInterval(id); };
  }, []);
  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <AnimatedSplashOverlay />
      <AppTabs />
    </ThemeProvider>
  );
}
