/** The paper-trade ledger's storage on the phone: the `trades` and `settings` tables in tradebot.db (expo-sqlite). */
import { TRADES_SCHEMA_SQL, TRADE_INSERT_COLUMNS, TradeRow, TradeStore } from '@/engine/trading';
import { db, migrate } from '@/storage/db';

type Arg = string | number | null;
const arg = (v: unknown): Arg => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : (v as Arg));

export function sqliteTradeStore(): TradeStore {
  migrate('trades', TRADES_SCHEMA_SQL);
  return {
    async listTrades(status, limit = 500) {
      return status
        ? db.getAllAsync<TradeRow>('SELECT * FROM trades WHERE status = ? ORDER BY created_at DESC, id DESC LIMIT ?', status, limit)
        : db.getAllAsync<TradeRow>('SELECT * FROM trades ORDER BY created_at DESC, id DESC LIMIT ?', limit);
    },
    async getTrade(id) {
      return (await db.getFirstAsync<TradeRow>('SELECT * FROM trades WHERE id = ?', id)) ?? null;
    },
    async insertTrade(row) {
      const cols = [...TRADE_INSERT_COLUMNS];
      const r = await db.runAsync(`INSERT INTO trades (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map((k) => arg((row as any)[k])));
      return r.lastInsertRowId;
    },
    async updateTrade(id, patch) {
      const keys = Object.keys(patch);
      if (!keys.length) return;
      await db.runAsync(`UPDATE trades SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...keys.map((k) => arg((patch as any)[k])), id]);
    },
    async getSetting(key) {
      const r = await db.getFirstAsync<{ value: string }>('SELECT value FROM settings WHERE key = ?', key);
      return r ? JSON.parse(r.value) : null;
    },
    async setSetting(key, value) {
      await db.runAsync('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', key, JSON.stringify(value));
    },
  };
}
