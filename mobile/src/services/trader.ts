/** One paper-trading ledger for the whole app: the ported engine (engine/trading.ts) over on-phone storage + Yahoo prices. */
import { PaperTrader } from '@/engine/trading';
import { fetchBars } from '@/engine/yahoo';

import { sqliteTradeStore } from './trade-store';

let instance: PaperTrader | null = null;
export function trader(): PaperTrader {
  if (!instance) {
    instance = new PaperTrader({
      store: sqliteTradeStore(),
      getBars: async (symbol, interval) => (await fetchBars(symbol, interval)).bars,
    });
  }
  return instance;
}
