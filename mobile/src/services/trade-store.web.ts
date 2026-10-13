/** Browser-preview ledger: in memory only (the phone keeps trades in SQLite, see trade-store.ts). */
import { MemoryTradeStore, TradeStore } from '@/engine/trading';

export function sqliteTradeStore(): TradeStore {
  return new MemoryTradeStore();
}
