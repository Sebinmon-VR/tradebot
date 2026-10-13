/** Browser-preview prediction store: in memory only (the phone uses SQLite, see prediction-store.ts). */
import type { StrategyStats } from '@/engine/ensemble';

import type { FeedbackRow, PredStore, PredictionRow } from './predictions';

export function predictionStore(): PredStore {
  const rows: PredictionRow[] = [];
  const feedback: FeedbackRow[] = [];
  let stats: StrategyStats = {};
  let nextId = 1;
  return {
    async insert(row) { const id = nextId++; rows.push({ ...row, id }); return id; },
    async update(id, patch) { const r = rows.find((x) => x.id === id); if (r) Object.assign(r, patch); },
    async list({ symbol, status, source, limit = 100 } = {}) {
      return rows.filter((r) => (!symbol || r.symbol.startsWith(symbol.toUpperCase())) && (!status || r.status === status) && (!source || r.source === source))
        .slice().sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : b.id - a.id)).slice(0, limit);
    },
    async get(id) { return rows.find((x) => x.id === id) ?? null; },
    async graded() { return rows.filter((r) => r.status === 'resolved' || r.user_verdict != null); },
    async addFeedback(id, verdict, rating, note, at) {
      const r = rows.find((x) => x.id === id);
      if (!r) return;
      Object.assign(r, { user_verdict: verdict, user_rating: rating, user_note: note });
      feedback.push({ id: feedback.length + 1, prediction_id: id, verdict, rating, note, created_at: at });
    },
    async saveStats(s) { stats = s; },
    async loadStats() { return stats; },
    async delete(id) {
      const k = rows.findIndex((x) => x.id === id);
      if (k < 0) return false;
      rows.splice(k, 1);
      for (let i = feedback.length - 1; i >= 0; i--) if (feedback[i].prediction_id === id) feedback.splice(i, 1);
      return true;
    },
    async listFeedback(predictionId, limit = 200) {
      const out = feedback.filter((f) => predictionId == null || f.prediction_id === predictionId).slice().reverse().slice(0, limit);
      if (predictionId != null) return out;
      return out.map((f) => { const p = rows.find((x) => x.id === f.prediction_id); return { ...f, symbol: p?.symbol, direction: p?.direction }; });
    },
  };
}
