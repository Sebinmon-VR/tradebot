/**
 * Paper order ticket (the web app's #ticket): buy / sell, intraday / delivery, market / limit / stop-loss,
 * quantity, optional stop and target, "From plan" to fill it from the analysis' trade plan, a live Groww
 * charges preview, and the open positions in this symbol with a close button.
 */
import { useCallback, useEffect, useState } from 'react';
import { TextInput, View } from 'react-native';

import type { OrderPreview, Trade, TradePlan } from '@/engine/trading';
import { normalizeSymbol } from '@/engine/yahoo';
import { trader } from '@/services/trader';
import { confirmAsk } from '@/ui/confirm';
import { Badge, Button, Card, Choice, Row, Stat, T, fmt, inr, useColors } from '@/ui/kit';

const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');

export function OrderTicket({ symbol: fixedSymbol, interval = '15m', plan, livePrice, onPlaced, predictionId }: {
  symbol?: string; interval?: string; plan?: TradePlan | null; livePrice?: number | null; onPlaced?: () => void; predictionId?: number | null;
}) {
  const c = useColors();
  const [symbol, setSymbol] = useState(fixedSymbol ?? '');
  const [side, setSide] = useState<'BUY' | 'SELL'>('BUY');
  const [product, setProduct] = useState<'intraday' | 'overnight'>('intraday');
  const [type, setType] = useState<'market' | 'limit' | 'sl'>('market');
  const [qty, setQty] = useState('1');
  const [price, setPrice] = useState('');
  const [stop, setStop] = useState('');
  const [target, setTarget] = useState('');
  const [preview, setPreview] = useState<OrderPreview | null>(null);
  const [positions, setPositions] = useState<Trade[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => { if (fixedSymbol) setSymbol(fixedSymbol); }, [fixedSymbol]);

  const sym = (() => { try { return symbol.trim() ? normalizeSymbol(symbol, 'NSE') : ''; } catch { return ''; } })();
  const req = useCallback(() => {
    if (!sym) return null;
    const px = Number(price), st = Number(stop), tg = Number(target);
    return {
      symbol: sym, side, product, order_type: type, qty: Math.max(0, Math.floor(Number(qty) || 0)), interval,
      price: type === 'limit' && px ? px : null, trigger: type === 'sl' && px ? px : null,
      stop: st > 0 ? st : null, target: tg > 0 ? tg : null, live_price: livePrice ?? null, prediction_id: predictionId ?? null,
    };
  }, [sym, side, product, type, qty, price, stop, target, interval, livePrice, predictionId]);

  useEffect(() => {
    const r = req();
    if (!r || !r.qty) { setPreview(null); return; }
    const t = setTimeout(() => trader().previewOrder(r).then(setPreview).catch((e) => setMsg({ text: (e as Error).message, ok: false })), 400);
    return () => clearTimeout(t);
  }, [req, nonce]);
  useEffect(() => {
    if (!sym) { setPositions([]); return; }
    trader().openPositions(sym).then(setPositions).catch(() => setPositions([]));
  }, [sym, nonce]);

  const fromPlan = () => {
    if (!plan?.available) { setMsg({ text: plan?.reason ?? 'Run an analysis first - the plan fills this ticket.', ok: false }); return; }
    setSide(plan.side ?? 'BUY'); setQty(String(plan.qty ?? 1));
    if (plan.best) setProduct(plan.best.mode);
    if (plan.entry_type === 'limit' && plan.entry) { setType('limit'); setPrice(String(plan.entry)); } else { setType('market'); setPrice(''); }
    setStop(plan.stop ? String(plan.stop) : ''); setTarget(plan.best?.target ? String(plan.best.target) : '');
    setMsg({ text: `Filled from the plan (${plan.verdict}).`, ok: true });
  };
  const place = async () => {
    const r = req();
    if (!r) return;
    setBusy(true); setMsg(null);
    try {
      const res = await trader().placeOrder(r);
      setMsg({ text: `${res.action.replace('_', ' ')} · ${res.trades.map((t) => `#${t.id}`).join(', ')}${res.notes.length ? ' · ' + res.notes.join(' ') : ''}`, ok: true });
      setNonce((n) => n + 1); onPlaced?.();
    } catch (e) { setMsg({ text: (e as Error).message, ok: false }); }
    finally { setBusy(false); }
  };
  const close = async (t: Trade) => {
    if (!(await confirmAsk('Close position', `Close paper trade #${t.id} (${t.qty} ${t.symbol}) at the current price?`))) return;
    try { await trader().closeTrade(t.id); setNonce((n) => n + 1); onPlaced?.(); } catch (e) { setMsg({ text: (e as Error).message, ok: false }); }
  };
  const input = { borderWidth: 1, borderColor: c.border, borderRadius: 8, paddingHorizontal: 9, paddingVertical: 7, color: c.text, backgroundColor: c.panel, flex: 1, minWidth: 80 } as const;

  return (
    <Card>
      <Row style={{ justifyContent: 'space-between' }}>
        <T bold size={15}>Order ticket (paper){sym ? ` · ${sym.replace(/\.(NS|BO)$/, '')}` : ''}</T>
        {plan !== undefined ? <Button title="From plan" kind="plain" onPress={fromPlan} /> : null}
      </Row>
      {!fixedSymbol ? <TextInput placeholder="Symbol, e.g. ELECTCAST" placeholderTextColor={c.muted} value={symbol} onChangeText={setSymbol} autoCapitalize="characters" style={input} /> : null}
      <Choice small value={side} options={[['BUY', 'Buy'], ['SELL', 'Sell / short']]} onChange={setSide} />
      <Choice small value={product} options={[['intraday', 'Intraday (MIS)'], ['overnight', 'Delivery (CNC)']]} onChange={setProduct} />
      <Choice small value={type} options={[['market', 'Market'], ['limit', 'Limit'], ['sl', 'Stop-loss entry']]} onChange={setType} />
      <Row gap={8} wrap>
        <TextInput placeholder="Qty" placeholderTextColor={c.muted} value={qty} onChangeText={setQty} keyboardType="number-pad" style={input} />
        {type !== 'market' ? <TextInput placeholder={type === 'sl' ? 'Trigger ₹' : 'Limit ₹'} placeholderTextColor={c.muted} value={price} onChangeText={setPrice} keyboardType="decimal-pad" style={input} /> : null}
      </Row>
      <Row gap={8} wrap>
        <TextInput placeholder="Stop-loss ₹ (optional)" placeholderTextColor={c.muted} value={stop} onChangeText={setStop} keyboardType="decimal-pad" style={input} />
        <TextInput placeholder="Target ₹ (optional)" placeholderTextColor={c.muted} value={target} onChangeText={setTarget} keyboardType="decimal-pad" style={input} />
      </Row>
      {preview ? (
        <View style={{ gap: 3 }}>
          {preview.errors.map((e) => <T key={e} color={c.down} size={12}>{e}</T>)}
          <T size={12.5}>{preview.action?.replace('_', ' ')} · LTP {fmt(preview.ltp)} · value {inr(preview.value)} · charges {inr(preview.charges?.total)}{preview.breakeven_pct != null ? ` · break-even ${preview.breakeven_pct}%` : ''}</T>
          <T muted size={12}>margin {inr(preview.margin)} · cash after {inr(preview.cash_after)}{preview.squareoff ? ` · broker square-off ${when(preview.squareoff)}` : ''}</T>
          {preview.notes.map((n) => <T key={n} muted size={11.5}>{n}</T>)}
        </View>
      ) : null}
      {msg ? <T color={msg.ok ? c.up : c.down} size={12}>{msg.text}</T> : null}
      <View style={{ alignSelf: 'flex-start' }}>
        <Button title={`${side === 'BUY' ? 'BUY' : 'SELL'} ${qty || ''} (paper)`} kind={side === 'BUY' ? 'primary' : 'danger'} onPress={place} busy={busy} disabled={!preview || preview.errors.length > 0} />
      </View>
      {positions.length ? (
        <View style={{ gap: 6, borderTopWidth: 1, borderTopColor: c.border, paddingTop: 6 }}>
          <T bold size={13}>Open in {sym.replace(/\.(NS|BO)$/, '')}</T>
          {positions.map((t) => (
            <Row key={t.id} wrap gap={10} style={{ justifyContent: 'space-between' }}>
              <Badge tone={t.side === 'short' ? 'bad' : 'ok'}>{`#${t.id} ${t.side === 'short' ? 'SHORT' : 'LONG'} ${t.qty}`}</Badge>
              <Stat k="fill" v={fmt(t.fill_price)} /><Stat k="stop" v={fmt(t.stop)} /><Stat k="target" v={fmt(t.target)} />
              <Button title="Close" kind="plain" onPress={() => close(t)} />
            </Row>
          ))}
        </View>
      ) : null}
    </Card>
  );
}
