/** Yes / no dialog: a native alert on the phone, window.confirm in the browser preview. */
import { Alert, Platform } from 'react-native';

export function confirmAsk(title: string, body: string): Promise<boolean> {
  if (Platform.OS === 'web') return Promise.resolve(typeof window !== 'undefined' && window.confirm(`${title}\n\n${body}`));
  return new Promise((ok) => Alert.alert(title, body, [{ text: 'Cancel', style: 'cancel', onPress: () => ok(false) }, { text: 'OK', onPress: () => ok(true) }]));
}
