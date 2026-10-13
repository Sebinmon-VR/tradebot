/**
 * Browser stand-in for src/storage/db.ts, used only to preview the screens with `expo start --web` during
 * development (expo-sqlite's web build needs WASM + cross-origin isolation).  The phone app uses SQLite.
 */
import type { KV } from '@/engine/meta';

const ls = () => (typeof localStorage === 'undefined' ? null : localStorage);
export const db = null;
export const kv: KV & { del(key: string): Promise<void> } = {
  async get(key) { try { return ls()?.getItem('tb:' + key) ?? null; } catch { return null; } },
  async set(key, value) { try { ls()?.setItem('tb:' + key, value); } catch { /* storage full or blocked */ } },
  async del(key) { try { ls()?.removeItem('tb:' + key); } catch { /* ignore */ } },
};
export function migrate(_name: string, _sql: string) { /* no tables on web */ }
export async function getJson<T>(key: string, fallback: T): Promise<T> {
  try { const v = await kv.get(key); return v ? (JSON.parse(v) as T) : fallback; } catch { return fallback; }
}
export const setJson = (key: string, value: unknown) => kv.set(key, JSON.stringify(value));
