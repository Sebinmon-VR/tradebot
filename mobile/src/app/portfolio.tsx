/**
 * Portfolio - port of static/portfolio.html/.js: paper trades kept on this phone, Groww charges on every
 * fill, stops / targets / deadlines checked every 30 s while the screen is open, an order ticket with a
 * live charges preview, and the capital / risk / fee settings.
 */
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, RefreshControl, Switch, TextInput, View } from 'react-native';

import type { Portfolio, Trade, TradingSettings } from '@/engine/trading';
import { OrderTicket } from '@/components/order-ticket';
import { trader } from '@/services/trader';
import { Badge, Button, Card, Choice, ErrorBox, Header, Row, Screen, Stat, T, Tile, fmt, inr, useColors } from '@/ui/kit';
import { confirmAsk } from '@/ui/confirm';
import { Spark } from '@/ui/spark';

const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
const REASON: Record<string, ['bad' | 'ok' | 'mid' | 'plain', string]> = { stop: ['bad', 'stop'], target: ['ok', 'target'], deadline: ['mid', 'deadline'], manual: ['plain', 'manual'], squareoff: ['bad', 'square-off'], expired: ['plain', 'expired'] };


export default function PortfolioScreen() {
  const c = useColors();
  const [p, setP] = useState<Portfolio | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  const load = useCallback(async () => {
    try { setP(await trader().portfolio()); setError(null); } catch (e) { setError((e as Error).message); }
  }, []);
  // while the screen is open: fill pending orders and apply stops / targets / deadlines every 30 s
  useFocusEffect(useCallback(() => {
    let alive = true;
    const tick = async () => { try { await trader().checkTrades(); } catch { /* shown on the next load */ } if (alive) await load(); };
    tick();
    const id = setInterval(tick, 30000);
    return () => { alive = false; clearInterval(id); };
  }, [load]));

  const close = async (t: Trade) => {
    const pending = t.status === 'pending';
    if (!(await confirmAsk(pending ? 'Cancel order' : 'Close position', `${pending ? 'Cancel' : 'Close'} paper trade #${t.id} (${t.symbol}) ${pending ? '' : 'at the current price'}?`))) return;
    try { if (pending) await trader().cancelTrade(t.id); else await trader().closeTrade(t.id); await load(); } catch (e) { setError((e as Error).message); }
  };
  const s = p?.stats;
  const tone = (v: number | null | undefined) => (v == null || v === 0 ? c.text : v > 0 ? c.up : c.down);
  const money = (v: number | null | undefined) => (v == null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${inr(Math.abs(v))}`);
  const curve = p ? [p.capital, ...p.equity_curve.map((e) => e.equity)] : [];

  return (
    <Screen refresh={<RefreshControl refreshing={false} onRefresh={load} />}>
      <Header title="Portfolio" sub="paper trades stored on this phone · Groww charges on every fill"
        right={<Button title="Check now" kind="plain" onPress={async () => { const r = await trader().checkTrades(); setMsg(`Checked: ${r.filled.length} filled, ${r.closed.length} closed${r.errors.length ? `, ${r.errors.length} errors` : ''}.`); await load(); }} />} />
      {error ? <ErrorBox message={error} onRetry={load} /> : null}
      {msg ? <T muted size={12}>{msg}</T> : null}
      {p && s ? (
        <>
          <Row wrap gap={6}>
            <Tile k="Equity" v={inr(p.equity, 0)} /><Tile k="Cash" v={inr(p.cash, 0)} /><Tile k="Invested" v={inr(p.invested, 0)} />
            <Tile k="Unrealised" v={money(p.unrealised)} color={tone(p.unrealised)} /><Tile k="Realised net" v={money(s.net_pnl)} color={tone(s.net_pnl)} />
            <Tile k="Return" v={s.return_pct == null ? '—' : `${s.return_pct > 0 ? '+' : ''}${s.return_pct}%`} color={tone(s.return_pct)} />
            <Tile k="Closed trades" v={s.trades} /><Tile k="Win rate" v={s.win_rate == null ? '—' : `${Math.round(s.win_rate * 100)}%`} />
            <Tile k="Profit factor" v={s.profit_factor ?? '—'} /><Tile k="Charges paid" v={inr(s.charges)} /><Tile k="Max drawdown" v={`${s.max_drawdown_pct}%`} />
          </Row>
          {curve.length > 2 ? <Card><T bold>Equity</T><Spark height={90} lines={[{ values: curve, color: c.accent, dot: true }]} levels={[{ value: p.capital, color: c.muted, label: 'capital' }]} /></Card> : null}

          <T bold size={16}>Open positions <T muted size={12}>{p.open.length} · limit {p.settings.max_positions}</T></T>
          {p.open.length ? p.open.map((t) => (
            <Card key={t.id} accent={(t.unrealised ?? 0) >= 0 ? c.up : c.down}>
              <Row style={{ justifyContent: 'space-between' }}>
                <T bold size={15}>{t.symbol.replace(/\.(NS|BO)$/, '')} <T muted size={11}>#{t.id} · {t.interval}</T></T>
                <Row gap={4}><Badge tone={t.side === 'short' ? 'bad' : 'ok'}>{t.side === 'short' ? 'SHORT' : 'LONG'}</Badge><Badge>{t.mode}</Badge></Row>
              </Row>
              <Row wrap gap={12}>
                <Stat k="qty" v={t.qty} /><Stat k="fill" v={fmt(t.fill_price)} /><Stat k="last" v={fmt(t.last_price)} />
                <Stat k="stop" v={fmt(t.stop)} /><Stat k="target" v={fmt(t.target)} /><Stat k="progress" v={t.progress == null ? '—' : `${t.progress}%`} />
                <Stat k="P&L (net)" v={money(t.unrealised)} color={tone(t.unrealised)} />
              </Row>
              <T muted size={11.5}>entered {when(t.entry_time)} · {t.deadline ? `exit by ${when(t.deadline)}` : t.squareoff ? `square-off ${when(t.squareoff)}` : 'until sold'}</T>
              <View style={{ alignSelf: 'flex-start' }}><Button title="Close now" kind="danger" onPress={() => close(t)} /></View>
            </Card>
          )) : <T muted>No open positions.</T>}

          {p.pending.length ? <T bold size={16}>Pending orders</T> : null}
          {p.pending.map((t) => (
            <Card key={t.id}>
              <Row style={{ justifyContent: 'space-between' }}>
                <T bold>{t.symbol.replace(/\.(NS|BO)$/, '')} <T muted size={11}>#{t.id}</T></T>
                <Badge tone={t.side === 'short' ? 'bad' : 'ok'}>{`${t.side === 'short' ? 'SHORT' : 'LONG'} · ${t.entry_type === 'sl' ? 'SL' : 'limit'} ${fmt(t.entry_price)}`}</Badge>
              </Row>
              <T muted size={12}>qty {t.qty} · stop {fmt(t.stop)} · target {fmt(t.target)} · placed {when(t.created_at)}</T>
              <View style={{ alignSelf: 'flex-start' }}><Button title="Cancel" kind="plain" onPress={() => close(t)} /></View>
            </Card>
          ))}

          <OrderTicket onPlaced={load} />

          <T bold size={16}>History</T>
          {p.closed.length ? p.closed.slice(0, 50).map((t) => {
            const r = REASON[t.exit_reason ?? ''] ?? ['plain', t.exit_reason ?? ''];
            return (
              <Card key={t.id}>
                <Row style={{ justifyContent: 'space-between' }}>
                  <T bold>{t.symbol.replace(/\.(NS|BO)$/, '')} <T muted size={11}>#{t.id} · {when(t.exit_time)}</T></T>
                  <T bold color={tone(t.net_pnl)}>{money(t.net_pnl)}</T>
                </Row>
                <Row wrap gap={6}>
                  <Badge tone={r[0]}>{r[1]}</Badge>
                  <T muted size={12}>{t.side === 'short' ? 'short' : 'long'} {t.qty} · {fmt(t.fill_price)} → {fmt(t.exit_price)} · gross {money(t.gross_pnl)} · charges {inr(t.charges)}</T>
                </Row>
              </Card>
            );
          }) : <T muted>No closed trades yet.</T>}

          <Pressable onPress={() => setShowSettings((x) => !x)}><T color={c.accent} bold>{showSettings ? '▾' : '▸'} Capital, risk and Groww fees</T></Pressable>
          {showSettings ? <SettingsEditor settings={p.settings} onSaved={load} /> : null}
          <T muted size={11.5}>Paper trading for research and practice only - no real orders are sent anywhere. Fees follow Groww's published equity schedule; edit them if it changes.</T>
        </>
      ) : null}
    </Screen>
  );
}

// ------------------------------------------------------------ settings
const FIELDS: [keyof TradingSettings, string, string][] = [
  ['capital', 'Capital ₹', 'decimal-pad'], ['risk_pct', 'Risk per trade %', 'decimal-pad'], ['max_positions', 'Max open positions', 'number-pad'],
  ['leverage', 'Intraday leverage ×', 'decimal-pad'], ['intraday_exit', 'Intraday exit (HH:MM)', 'default'], ['squareoff_time', 'Broker square-off (HH:MM)', 'default'],
  ['min_trade_value', 'Min trade value ₹', 'decimal-pad'], ['max_cost_share', 'Max charges share of target', 'decimal-pad'],
  ['stop_atr', 'Stop beyond level (ATR)', 'decimal-pad'], ['entry_zone_atr', 'Entry zone (ATR)', 'decimal-pad'],
];
const FEE_FIELDS = ['brokerage_pct', 'brokerage_cap', 'brokerage_min', 'stt_delivery_pct', 'stt_intraday_sell_pct', 'stamp_delivery_pct', 'stamp_intraday_pct', 'exchange_pct', 'sebi_pct', 'ipft_pct', 'gst_pct', 'dp_charge', 'dp_waive_below', 'auto_squareoff', 'slippage_pct'];

function SettingsEditor({ settings, onSaved }: { settings: TradingSettings; onSaved: () => void }) {
  const c = useColors();
  const [draft, setDraft] = useState<Record<string, any>>({ ...settings, fees: { ...settings.fees } });
  const [note, setNote] = useState<string | null>(null);
  const input = { borderWidth: 1, borderColor: c.border, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 5, color: c.text, backgroundColor: c.panel, minWidth: 90, textAlign: 'right' } as const;
  const field = (label: string, value: any, set: (v: string) => void, kb: any = 'decimal-pad') => (
    <Row key={label} style={{ justifyContent: 'space-between' }}><T size={12.5} style={{ flex: 1 }}>{label}</T><TextInput value={String(value ?? '')} onChangeText={set} keyboardType={kb} style={input} /></Row>
  );
  const save = async () => {
    try {
      const patch: Record<string, any> = {};
      for (const [k, , kb] of FIELDS) patch[k] = kb === 'default' ? draft[k] : Number(draft[k]);
      patch.allow_overnight = !!draft.allow_overnight;
      patch.fees = Object.fromEntries(Object.entries(draft.fees).map(([k, v]) => [k, k === 'broker' ? v : Number(v)]));
      const st = await trader().saveSettings(patch);
      setDraft({ ...st, fees: { ...st.fees } }); setNote('Saved.'); onSaved();
    } catch (e) { setNote((e as Error).message); }
  };
  const reset = async () => {
    if (!(await confirmAsk('Reset settings', 'Reset capital, risk and every fee to the defaults?'))) return;
    const st = await trader().resetSettings();
    setDraft({ ...st, fees: { ...st.fees } }); setNote('Defaults restored.'); onSaved();
  };
  return (
    <Card>
      {FIELDS.map(([k, label, kb]) => field(label, draft[k], (v) => setDraft((d) => ({ ...d, [k]: v })), kb))}
      <Row style={{ justifyContent: 'space-between' }}><T size={12.5}>Allow overnight (delivery) trades</T><Switch value={!!draft.allow_overnight} onValueChange={(v) => setDraft((d) => ({ ...d, allow_overnight: v }))} /></Row>
      <T bold style={{ marginTop: 6 }}>Fees · {draft.fees.broker}</T>
      {FEE_FIELDS.map((k) => field(k.replace(/_/g, ' '), draft.fees[k], (v) => setDraft((d) => ({ ...d, fees: { ...d.fees, [k]: v } }))))}
      <Row gap={8}><Button title="Save" onPress={save} /><Button title="Reset to defaults" kind="plain" onPress={reset} /></Row>
      {note ? <T muted size={12}>{note}</T> : null}
    </Card>
  );
}
