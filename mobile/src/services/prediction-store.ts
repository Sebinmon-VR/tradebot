/** SQLite storage for predictions / feedback / strategy_stats (the tables of app/db.py). */
import type { StrategyStats } from '@/engine/ensemble';
import { db, migrate } from '@/storage/db';

import { PREDICTIONS_SCHEMA_SQL, type FeedbackRow, type PredStore, type PredictionRow } from './predictions';

export function predictionStore(): PredStore {
  migrate('predictions', PREDICTIONS_SCHEMA_SQL);
  return {
    async insert(row) {
      const cols = Object.keys(row);
      const r = await db.runAsync(`INSERT INTO predictions (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map((k) => (row as any)[k] ?? null));
      return r.lastInsertRowId;
    },
    async update(id, patch) {
      const keys = Object.keys(patch);
      if (keys.length) await db.runAsync(`UPDATE predictions SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...keys.map((k) => (patch as any)[k] ?? null), id]);
    },
    async list({ symbol, status, source, limit = 100 } = {}) {
      const where: string[] = [], args: (string | number)[] = [];
      if (symbol) { where.push('symbol LIKE ?'); args.push(symbol.toUpperCase() + '%'); }
      if (status) { where.push('status = ?'); args.push(status); }
      if (source) { where.push('source = ?'); args.push(source); }
      return db.getAllAsync<PredictionRow>(`SELECT * FROM predictions${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC, id DESC LIMIT ?`, [...args, limit]);
    },
    async get(id) {
      return (await db.getFirstAsync<PredictionRow>('SELECT * FROM predictions WHERE id = ?', id)) ?? null;
    },
    async graded() {
      return db.getAllAsync<PredictionRow>("SELECT * FROM predictions WHERE status = 'resolved' OR user_verdict IS NOT NULL");
    },
    async addFeedback(id, verdict, rating, note, at) {
      await db.runAsync('INSERT INTO feedback (prediction_id, verdict, rating, note, created_at) VALUES (?, ?, ?, ?, ?)', id, verdict, rating, note, at);
      await db.runAsync('UPDATE predictions SET user_verdict = ?, user_rating = ?, user_note = ? WHERE id = ?', verdict, rating, note, id);
    },
    async saveStats(stats) {
      await db.withTransactionAsync(async () => {
        await db.runAsync('DELETE FROM strategy_stats');
        for (const [k, v] of Object.entries(stats)) {
          await db.runAsync('INSERT INTO strategy_stats (key, name, category, correct, incorrect, neutral) VALUES (?, ?, ?, ?, ?, ?)', k, v.name ?? k, v.category ?? '', v.correct, v.incorrect, v.neutral ?? 0);
        }
      });
    },
    async delete(id) {
      await db.runAsync('DELETE FROM feedback WHERE prediction_id = ?', id);
      const r = await db.runAsync('DELETE FROM predictions WHERE id = ?', id);
      return r.changes > 0;
    },
    async listFeedback(predictionId, limit = 200) {
      if (predictionId == null) {
        return db.getAllAsync<FeedbackRow>('SELECT f.*, p.symbol, p.direction FROM feedback f JOIN predictions p ON p.id = f.prediction_id ORDER BY f.created_at DESC, f.id DESC LIMIT ?', limit);
      }
      return db.getAllAsync<FeedbackRow>('SELECT * FROM feedback WHERE prediction_id = ? ORDER BY created_at DESC, id DESC LIMIT ?', predictionId, limit);
    },
    async loadStats() {
      const rows = await db.getAllAsync<{ key: string; name: string; category: string; correct: number; incorrect: number; neutral: number }>('SELECT * FROM strategy_stats');
      const out: StrategyStats = {};
      for (const r of rows) out[r.key] = r;
      return out;
    },
  };
}
