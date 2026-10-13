/**
 * On-phone storage: one SQLite database (expo-sqlite) in the app's private folder - the phone's equivalent of
 * data/tradebot.db.  Nothing leaves the device.  `kv` is a small key-value table for settings and caches;
 * the other tables are created by the modules that own them via `migrate()`.
 */
import * as SQLite from 'expo-sqlite';

import type { KV } from '@/engine/meta';

export const db = SQLite.openDatabaseSync('tradebot.db');
db.execSync(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
`);

export const kv: KV & { del(key: string): Promise<void> } = {
  async get(key) {
    const r = await db.getFirstAsync<{ value: string }>('SELECT value FROM kv WHERE key = ?', key);
    return r?.value ?? null;
  },
  async set(key, value) {
    await db.runAsync('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
  },
  async del(key) {
    await db.runAsync('DELETE FROM kv WHERE key = ?', key);
  },
};

const migrated = new Set<string>();
/** Run a module's CREATE TABLE statements once per app start. */
export function migrate(name: string, sql: string) {
  if (migrated.has(name)) return;
  db.execSync(sql);
  migrated.add(name);
}

export async function getJson<T>(key: string, fallback: T): Promise<T> {
  try { const v = await kv.get(key); return v ? (JSON.parse(v) as T) : fallback; } catch { return fallback; }
}
export const setJson = (key: string, value: unknown) => kv.set(key, JSON.stringify(value));
