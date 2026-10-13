# Trading Analytics & Prediction

A stock-market analytics system that runs **40 real-world trading strategies** and **4 statistical
models** over any chart, feeds their votes into a **walk-forward validated learner**, and outputs one
call: **UP, DOWN or NO CALL** for the next *N* bars, with a calibrated probability, the out-of-sample
accuracy of calls that strong on this very chart, a target and a stop. Every prediction is stored;
you grade it (correct / partial / incorrect, with a note), the system also auto-grades it once the
horizon passes, and per-strategy hit rates feed back into the ensemble weights.

Built for the Indian market: NSE and BSE stocks and indices (NIFTY, BANKNIFTY, SENSEX, INDIA VIX)
through Yahoo Finance data.

## Quick start

```bash
pip install -r requirements.txt
python run.py
```

Open <http://127.0.0.1:8000>.

Type a symbol (`RELIANCE`, `TCS`, `NIFTY`, `BANKNIFTY`), pick the exchange, interval (15 min by
default) and horizon (bars ahead), and press **Analyze**. The first analysis of a chart trains and validates the model
(20-40 s); later runs on the same chart take about a second.

The chart is real-time: trades stream in over a WebSocket and move the forming candle as they
happen, and Yahoo's official bars are reconciled every few seconds (see *Live chart* below).

## What it does

1. **Data** – OHLCV from yfinance (1m to weekly; 5 years of daily bars, 2 years of hourly). Full
   history is downloaded every 10 minutes; in between only the latest session is re-downloaded
   (a few hundred milliseconds) and merged over it, so every request sees bars that are at most
   two seconds old (`app/data.py`). Live trades come from Yahoo's streaming endpoint through one
   shared connection (`app/live.py`).
2. **Indicators** – SMA/EMA/HMA, RSI, MACD, Stochastic, Williams %R, CCI, MFI, ATR, Bollinger,
   Keltner, Donchian, ADX/DMI, Supertrend, Parabolic SAR, Ichimoku, OBV, VWAP, CMF, Heikin-Ashi,
   pivots, Fibonacci, swing points, Hurst exponent (`app/indicators.py`).
3. **Strategies** – each is a published system implemented with its standard parameters and votes
   up / down / neutral with a confidence and the rule that fired (`app/strategies.py`):

   | Category | Strategies |
   |---|---|
   | Trend | Golden/Death Cross, EMA 9/21, ADX/DMI (Wilder), Supertrend (Seban), Parabolic SAR (Wilder), Ichimoku (Hosoda), Hull MA, Elder Triple Screen, Chandelier Exit (LeBeau), Heikin-Ashi, Alligator (Williams) |
   | Momentum | RSI 14 (Wilder), Connors RSI-2, MACD (Appel), Stochastic (Lane), CCI (Lambert), Williams %R, Academic Momentum 12-1 (Jegadeesh-Titman), 52-Week High (George-Hwang) |
   | Volatility / breakout | Bollinger Squeeze, Bollinger %B mean reversion, TTM Squeeze (Carter), Turtle/Donchian breakout (Dennis-Eckhardt), Keltner pullback (Raschke), Volume-confirmed breakout (Weinstein), Opening Range Breakout (Crabel, intraday) |
   | Volume | On-Balance Volume (Granville), VWAP, VWAP σ-bands (Shannon), Money Flow Index, Chaikin Money Flow |
   | Price action | Candlestick patterns (Nison), Opening gap (Andrews), NR7 narrow range (Crabel) |
   | Levels | Floor-trader pivots, Central Pivot Range (Ochoa), Camarilla (Scott), Market Profile value area / POC (Steidlmayer), Fibonacci retracement, Swing support/resistance |

   On intraday charts every level-based strategy uses the **previous session** (the previous day's
   high, low, close and volume-at-price), on daily and weekly charts the previous bar.

4. **Statistical models** – Linear-regression trend, AR(5) on returns, Monte Carlo GBM and kNN
   pattern analogs vote like strategies; a Hurst regime detector tells the rule ensemble whether to
   favour trend-followers or oscillators (`app/models.py`).
5. **Rule ensemble** – weight = base weight (by category) × regime multiplier (Hurst) × track-record
   multiplier from the strategy's graded history. Bull and bear scores give a rule probability and
   the agreement figure (`app/ensemble.py`).
6. **Walk-forward learner** – the layer that decides the call (`app/learner.py`). Every strategy's
   vote is computed at every past bar of the chart (cached in `data/cache/`), and together with
   technical features, time-of-day, day-of-week and the NIFTY 50 market factor (a stock's recent
   index returns and its return relative to the index) they train four published learners:
   L2 logistic regression, Random Forest (Breiman 2001), histogram gradient boosting (Friedman 2001)
   and a stacked model over the strategy votes alone (Wolpert 1992). They are validated with
   **purged walk-forward cross-validation** (López de Prado 2018): the most recent 60% of history is
   predicted in five expanding folds, each by a model trained only on bars that finished before the
   fold, with `horizon` bars purged so overlapping labels cannot leak. The out-of-fold probabilities
   are averaged and **Platt-scaled** (Platt 1999), so *P(up) = 65%* means calls of that strength were
   right about 65% of the time on this chart.
7. **The call** – a direction is called only where out-of-sample calls of the same strength were
   right at least 55% of the time (the lowest such strength tier is the threshold). Otherwise the
   card shows **NO CALL** with the lean and the reason. Each call carries its *validated accuracy*
   (the out-of-sample hit rate of calls at least this strong), the number of bars behind it, and an
   *evidence* grade: **strong** / **weak** = calls beat simply following the drift by 1.64 / 0.8
   standard errors (counting roughly one independent outcome per `horizon` bars); **drift** = the
   calls are reliable only because the market has been drifting one way; **none** = no validated
   edge. Targets and stops are sized from ATR and the Monte Carlo distribution.
8. **Feedback loop** – predictions are saved in SQLite (`data/tradebot.db`). The evaluator checks
   pending predictions every 10 minutes and grades them once the horizon bars have printed. A no-call
   is recorded as `no_call` and counted in neither the numerator nor the denominator of the accuracy
   figure, but every strategy's vote on that bar is still graded, so per-strategy hit rates keep
   learning. Your verdict overrides the system's. Grading and backtests ignore a bar that is still
   forming (`app/db.py`, `app/evaluator.py`).

## How accuracy is measured

Three different numbers appear in the UI; they answer different questions.

- **Validated accuracy** (prediction card) – out-of-sample: of all past bars on this chart where the
  model's calibrated probability was at least as strong as today's, how many did it get right? It is
  computed by walk-forward cross-validation before the call is made, so it is a forecast of how the
  call will do, not a record of how past calls did. The card also shows the whole strength ladder
  ("≥0.55: 61% (260) · ≥0.58: 64% (175) …"), the base rate you would get by always calling the drift,
  and each learner's own walk-forward accuracy.
- **Accuracy of calls** (Accuracy tab) – the realised record: graded UP/DOWN predictions that were
  right, divided by all graded UP/DOWN predictions. No-calls are excluded. This is the number to
  watch over time; it should converge toward the validated accuracy shown on the cards.
- **Per-strategy hit rate** (Accuracy tab and Signals table) – how often each strategy's vote agreed
  with what the market did next, across every graded bar, including no-call bars. It drives the
  track-record multiplier in the rule ensemble. The **Learned** column on the Signals tab is
  different: it is the weight the stacked model assigned the strategy on the current chart, and a
  negative value means the strategy has been contrarian on that chart.

Nothing here guarantees future accuracy. Short-horizon direction is close to a coin flip for most
liquid instruments; the point of the learner is to say so honestly (NO CALL) rather than to emit a
confident guess, and to concentrate calls where the chart has actually shown an edge.

More strategies do not by themselves mean more accuracy: most indicators are transformations of
the same price series, so a new one only helps if it carries information the others do not (session
levels, volume-at-price, the market factor, time of day). The learner shows which strategies earn
weight on a chart; the rest are averaged out, at the cost of compute for every historical bar.

## Paper trading with Groww charges

Every live analysis also produces a **trade plan** on the call card in the direction of the call: a
long bought at a support level, or, on an intraday chart with a DOWN call, a short sold at a
resistance level (intraday only, since cash delivery cannot short; a DOWN call on a daily chart gets
no plan). A long plan buys at the nearest support level below the price (previous-session
pivot / S1 / S2, CPR bottom, Camarilla L3 / L4, VWAP and its bands, value-area low, swing low), at
market when price is already within 0.35 ATR of the level or as a limit order to wait for the
pullback; the stop sits 0.4 ATR below the level; the target is the resistance above that gives the
best net expectancy. Two exit modes are costed and the better one chosen: **intraday** (exit before
Groww's auto square-off, default 15:10 IST) or **overnight** (a delivery order held into the next
session, which pays STT on both sides and the DP charge). The plan shows quantity for your capital
and risk per trade, every charge line by line from Groww's published schedule (brokerage, STT,
stamp duty, exchange, SEBI, IPFT, GST, DP charge, modelled slippage), the break-even move, the net
profit if the target or the stop is hit, the probabilities of target-first / stop-first / time-out
measured on the chart's own history and tilted by the calibrated forecast, and the expected net
profit in rupees. The verdict is BUY NOW, WAIT FOR PULLBACK or NO TRADE, with the reasons (bearish
forecast, negative expectancy, charges too large a share of the profit, trade too small, capital,
position limit).

The **order ticket** at the top of the analytics page works like a broker's panel: BUY or SELL,
Intraday (MIS, short-selling allowed, squared off by the broker at 15:20 IST with the ₹50 charge if
still open) or Delivery (CNC, no short-selling), Market / Limit / SL (trigger) orders, quantity,
optional stop-loss and target, a live preview of what the order does (buy, sell from holding, short,
cover) and what it costs, and a positions strip with one-click exit. **From plan** fills the ticket
from the prediction card's plan. A SELL against a holding exits it (market now, limit = sets the
target, SL = sets the stop; partial quantities split the position). Every minute the server fills
pending orders against real bars and exits open positions on stop, target, deadline or square-off
(both touched in one bar counts as a stop; slippage is paid in the fill; the fill bar is judged on
its close only). The **Portfolio** page shows capital, cash,
open positions with live P&L net of the sell charges still to pay, pending orders, closed trades
with their charges, the equity curve, and the record: net and gross P&L, charges paid, win rate,
profit factor, expectancy per trade, max drawdown. Its **settings panel** sets the capital, risk per
trade, position limit, whether overnight holds are allowed, leverage (off by default), the intraday
exit time and every fee, with a reset to the Groww defaults.

The barrier probabilities are unconditional history tilted by today's forecast; a walk-forward trade
simulator that conditions them on the setup, and a model that learns which setups make money from
the ledger, are the next steps.

## Market map (screener)

Open <http://127.0.0.1:8000/screener> (or the **Screener** button) to see the whole list at once as
a **heat-map of tiles**: every stock is a tile, tiles are grouped into sector blocks (Financials, IT,
Oil & Gas, FMCG, Auto, ...), the tile's **colour** is the metric you choose (day %, gap %, 5-day %,
20-day %, RSI, 52-week position, trend bias, volume vs 20-day average, day range, ATR) and its
**size** is market cap (default), turnover, volume or equal. Each sector block's header shows the
size-weighted value of the colour metric, so you can read "banks are down, IT is up" at a glance.
Hover a tile for its full numbers; click it to open the analytics page with that symbol and your
chosen interval. The quick filters (top gainers, losers, most active, most volatile, least movement,
gaps, oversold, overbought, near 52-week high/low, bullish/bearish trends) dim the tiles that do not
match and switch the colour metric to the relevant one; the search box works the same way. Universes:
NIFTY 50, NIFTY 100, SENSEX 30 (BSE), NIFTY 100 names on BSE, plus your own watchlist symbols.
**Auto** refreshes every minute. A **Table** toggle gives the sortable columns (including sector and
market cap) instead of the map.

Market caps, and the sector of any watchlist name outside the built-in sector map, come from Yahoo in
a background thread and are cached for a day in `data/cache/screener_meta.json`; until they arrive
the map sizes by turnover.

## Overextended (due for a pullback)

Open <http://127.0.0.1:8000/overextended> (the ⤵ icon) for the list of stocks that have run too far,
too fast. Every name in the universe (plus your watchlist) gets an **overextension score** from 0 to
100 that adds up ten published overbought and exhaustion rules on daily bars, each scaled from "just
triggered" to "extreme" (`app/overextended.py`):

| Rule | Weight | Origin |
|---|---|---|
| RSI-14 above 70 | 12 | Wilder, *New Concepts in Technical Trading Systems* (1978) |
| RSI-2 above 90 | 10 | Connors & Alvarez, *Short Term Trading Strategies That Work* (2009) |
| Close above the upper Bollinger Band (%B > 1) | 12 | Bollinger, *Bollinger on Bollinger Bands* (2001) |
| More than 1.5 ATR above the 20-day SMA | 14 | Raschke & Connors, *Street Smarts* (1995): distance from the mean in ATR units |
| More than 3 ATR above the 50-day SMA | 8 | same idea on the intermediate mean |
| 4 or more consecutive up closes | 8 | Connors & Alvarez (2009) |
| 20-day return above 1.5× its own volatility | 10 | Pring, *Technical Analysis Explained*: rate-of-change extremes |
| Buying-climax volume (≥ 2× average on an up day at a 20-day high) | 8 | Wyckoff (1930s); Weinstein, *Secrets for Profiting in Bull and Bear Markets* (1988) |
| Bearish reversal candle at the highs (shooting star, bearish engulfing, dark cloud cover, gravestone doji) | 10 | Nison, *Japanese Candlestick Charting Techniques* (1991) |
| Bearish RSI divergence (new 20-day high, RSI-14 5+ points below its peak) | 8 | Wilder (1978); Cardwell |

**Stretched** = 50 and above, **extended** = 35-49, **warming up** = 20-34. The tiers were set from two
years of NIFTY 100 daily bars: a score of 20+ appears on about six names a day, 35+ on two, 50+ on
fewer than one, so on a quiet day the list is honestly short (lower "Show from score" to see the
names closest to it). Each card shows the score bar, a 60-session sparkline with the 20-day SMA, the
readings (RSI-14, RSI-2, %B, ATR distance from the SMA, streak, 20-day run in volatility units,
volume ratio), every rule that fired with its points and the reading behind it, and the distance back
to the 20-day mean. Sort chips: most stretched, reversal signs first (candle, divergence, climax),
best pullback record, biggest 20-day run, highest RSI, furthest from SMA20, volume climax.
**Analyze** opens the chart in the analytics page with your chosen interval.

Being stretched is a statement about the next few *sessions*, not the trend: the momentum research
(Jegadeesh & Titman 1993; George & Hwang 2004) finds that strong stocks keep going for months, while
the short-term work (Connors, Bollinger) finds that the sessions right after an extreme tend to give
some of it back. So every card also carries the stock's own record: each time in the last two years
its score crossed 35, was it lower five sessions later, by how much on average, and how deep was the
typical dip within ten sessions, next to the unconditional base rate for that stock (how often *any*
bar closed lower five sessions later). A record clearly above the base rate is labelled **tends to pull
back**, one below it **tends to keep running**; fewer than three episodes is **too few to judge**. The
summary strip gives the same numbers pooled over the whole universe. On NIFTY 100 in September 2026
the pooled record was: crossings of 35 were lower five sessions later 58% of the time (average −0.5%,
median dip −3.8% within ten sessions) against 49% for any bar, and the edge fades at the most extreme
scores, where continuation takes over. Treat the score as a warning to take profits or tighten stops,
not as a short signal on its own; run the full analysis on the chart first.

The market map also carries the score: the **Overextended ⤵** chip, an "Overextension score" colour
metric and a **Stretch** column in the table (`GET /api/screener` returns it as `ext_score`).

## Live chart, live mode and the forecast

- **Live chart.** As soon as a symbol is loaded the page opens a WebSocket (`/ws/ticks`) and the
  server relays every trade from Yahoo's streamer (NSE/BSE trades arrive within about a second).
  Each tick updates the forming candle's high/low/close and volume, the price in the chart header
  (with the day's change) and the **Now** row on the prediction card (move since entry, progress
  toward target, target reached / stop hit). Every 4 seconds (20 s on daily/weekly) the page also
  fetches Yahoo's official bars from the last candle onward (`/api/chart/tail`, a few KB) to
  reconcile the tick-built candle, append new bars and refresh all indicator lines. The badge next
  to the price shows the feed state: **● LIVE** with the time of the last trade, *no trades* when
  the stream is connected but the market is quiet or closed, *polling* when the stream is down
  (it reconnects automatically). While a chart loads, or if it could not load, a message sits over
  the chart and a failed load retries by itself (4 s, then doubling to 30 s). Coming back to the page
  through the browser's back button reloads the chart and reconnects the stream. Dragging a price axis
  fixes its range (double-click the axis to make it automatic again); switching to another symbol or
  timeframe resets both axes to automatic, so a stock at ₹239 never ends up hidden below a ₹600 axis.
- **Interactive requests come first.** Every Yahoo call goes through one gate (Yahoo throttles
  overlapping requests): a chart load, an analysis or a quote registers as interactive and background
  work - the market map's batch download (in chunks of 25 tickers) and the market-cap fetch loop -
  waits until no interactive request is pending, so a chart never sits blank behind a scan started on
  another page. Pages and static files are sent with `Cache-Control: no-cache`, so a browser
  navigating back always revalidates `app.js` against the server.
- **Closed-bar signals.** Every indicator, strategy and model is computed on completed bars only.
  A half-finished candle would distort RSI, MACD, breakouts and candlestick rules and make the
  vote flip-flop within the bar. The forming bar's latest trade (or the streamed tick) is used
  as the entry price, so targets and stops are measured from where the market actually is.
- The prediction covers the next *N* bars after the last **closed** bar (horizon 1 = the candle
  that is forming right now). The card shows a **Current candle** / **Next candle** call with an
  expected close and an 80% range, and the chart draws the projected path for the whole horizon
  as a dashed line with a probability band.
- With **Auto** on, every open tab is re-analysed (unsaved) in the background whenever its own bar
  closes, and at least every two minutes so entry/target/stop follow the live price on slow
  timeframes. The learner is refitted only after `horizon / 2` new bars (or an hour); in between the
  fitted model is reused, so re-analysis is fast. Nothing is saved unless you press Analyze or "Save
  this prediction".

## Testing on previous days

Two ways to check the system against history without waiting for the future:

- **As of** – set the "As of" date/time next to the Analyze button. The analysis is run using only
  the bars available at that moment (the learner is trained only on those bars too), saved with
  source `asof`, and graded immediately against what the market actually did over the next *N*
  bars. The result appears on the prediction card and in History.
- **Backtest** – choose the number of points and press **Backtest**. The system steps back through
  history one horizon at a time, makes a prediction at each point and grades it. Results are saved
  with source `backtest`, summarised in the status bar (calls, hits, no-calls), listed in History,
  and used to update the per-strategy accuracy and weights.

Both use the same code path as a live prediction, so their accuracy is representative. Each point
takes 5-15 seconds because the learner is retrained on the history available at that point.

## UI

Symbols open as **tabs** below the header (up to 8, one per symbol and timeframe): press Analyze on a
new symbol to open a tab, click a tab to switch, × to close. Each tab keeps its last call (with the
direction glyph and P(up) on the tab itself) and its chart; tabs, the active tab, the last calls and
every option you set (overlays, indicator pane, Auto, Details, order product and type) are saved in
the browser, so coming back from the map or the portfolio restores the page exactly as it was and only
refreshes the call in the background.

Tabs are analysed **in the background** by a queue that runs one analysis at a time (a first run on a
chart trains the model for 20-40 s, so running them in parallel would only slow each other down): when
the page opens, every tab that has never been analysed is queued after the active one; switching to a
tab whose call is older than 90 s queues it at the front; and with **Auto** on (the default) each tab
is re-queued when its own bar closes (computed from the bar the call was made on) and at least every
two minutes. A tab shows a spinning ⟳ while it is being analysed and ⋯ while it waits, so you can open
several symbols and switch between them while the calls fill in; the Auto countdown next to the header
shows the seconds until the active tab is refreshed. Switching tabs while a chart or a bar poll is still
loading is safe: a slower request for the previous tab is discarded rather than drawn over the new chart.

The page is light-themed and deliberately compact: a header with the symbol, timeframe and Analyze,
the order ticket, the chart and a short call card. Everything else sits behind the **icon bar** at the
top right: ⚙︎ options (exchange, horizon, as-of date, backtest), 〰︎ chart overlays and indicator pane,
☰ more (a drawer with signals, indicators, history, accuracy and the strategy guide as tabs),
◉ learning pop-up, ▦ market map, ⤵ overextended list, ▣ portfolio and settings. **Details ▾** on the call card reveals the
next-candle forecast, the walk-forward summary, confidence, agreement, regime and the category split.

- **Chart** – candles, volume, toggleable overlays (EMAs, SMAs, Bollinger, Keltner, Supertrend,
  PSAR, VWAP, Ichimoku cloud), **pivot lines** (floor pivot P with R1-R3 / S1-S3 and the CPR band,
  on by default; Camarilla H3/H4/L3/L4 as a second toggle) computed from the previous session and
  refreshed when a new session starts, indicator pane (RSI, MACD, ADX, Stochastic, OBV, CCI, MFI),
  and the prediction's entry / target / stop lines.
- **Prediction card** – direction or NO CALL, calibrated P(up), validated accuracy, evidence grade,
  the walk-forward summary (bars, folds, strength ladder, per-learner accuracy), confidence,
  agreement, target, stop, risk:reward, expected move, validity time, regime, and the bull/bear
  split per category.
- **Learning & prediction pop-up** – the 🧠 button on the card (and on any saved prediction in
  History) opens a small window that shows how the call was made and what the model learned on
  this chart: raw and calibrated P(up), the call threshold, validated accuracy and evidence, each
  learner's vote and walk-forward accuracy, the rule ensemble's own probability, the training
  summary, accuracy by call strength, the weight learned for every strategy (positive = trust its
  vote here, negative = fade it) and the most informative inputs.
- **Indicators** – latest indicator values, classic pivots, CPR and Camarilla levels, Fibonacci
  retracement.
- **Signals** – every strategy's vote, confidence, rule-ensemble weight, learned weight on this
  chart, historical hit rate and reason; the four learners and the calibrated ensemble appear in
  the *Machine learning* category with their walk-forward accuracy. Click a row for the rule and raw
  values.
- **History & Feedback** – all predictions with system and user outcomes (including no-call);
  review any prediction with a verdict, 1–5 star rating and note; trigger auto-evaluation manually.
- **Accuracy** – accuracy of calls, no-call count, breakdown by direction, per-strategy hit rates
  and the weight multiplier each has earned.
- **Strategy Guide** – origin and rules of every strategy, model and learner.

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/chart?symbol=&interval=&exchange=` | candles + indicator series |
| GET | `/api/chart/tail?symbol=&interval=&exchange=&since=` | bars at/after `since` (unix s) for incremental refresh |
| WS | `/ws/ticks?symbol=&exchange=` | real-time trades as JSON `{price, time, day_volume, change_percent, …}` |
| GET | `/api/live/status` | streamer connection state and watched symbols |
| POST | `/api/analyze` `{symbol, exchange, interval, horizon, save, live_price?, as_of?}` | run the full analysis (closed bars; `live_price` or the last streamed tick is the entry). `summary.learner` carries the walk-forward validation |
| POST | `/api/backtest` `{symbol, exchange, interval, horizon, steps, step_bars?, save}` | predict and grade at N past points |
| GET | `/api/predictions?symbol=&status=&source=` | prediction history |
| GET | `/api/predictions/{id}` | one prediction with all signals and feedback |
| POST | `/api/predictions/{id}/feedback` `{verdict, rating, note}` | record your verdict |
| DELETE | `/api/predictions/{id}` | remove a prediction |
| POST | `/api/resolve` | auto-grade due predictions now |
| GET | `/api/stats` | accuracy of calls, no-call count and per-strategy accuracy |
| GET | `/api/screener?universe=&symbols=` | movement metrics, sector and market cap for every symbol in a universe (+ watchlist) |
| GET | `/api/universes` | the screener universes |
| GET | `/api/overextended?universe=&symbols=&min_score=` | overextension score, the rules that fired, readings, sparkline and the stock's own pullback record for every name at or above `min_score`, plus the pooled base rate |
| GET/PUT | `/api/settings` | capital, risk, fee schedule (`POST /api/settings/reset` restores Groww defaults) |
| GET | `/api/portfolio` | cash, positions with live P&L, closed trades, stats, equity curve |
| GET | `/api/trades?status=` | paper trades |
| POST | `/api/orders` `{symbol, side, product, order_type, qty, price?, trigger?, stop?, target?}` | place a paper order (`/api/orders/preview` costs it without placing) |
| GET | `/api/quote?symbol=` | last traded price (tick or last bar) |
| POST | `/api/trades` `{symbol, interval, plan, prediction_id?, live_price?}` | record a paper trade from a plan |
| POST | `/api/trades/{id}/close` `{price?}` | close (or cancel) a paper trade |
| POST | `/api/trades/check` | fill / exit paper trades against real bars now |
| GET | `/api/search?q=` | symbol lookup |
| GET | `/api/catalog` | strategy / model / learner reference |

## Configuration

- `TRADEBOT_DB` – path of the SQLite file (default `data/tradebot.db`).
- `TRADEBOT_CACHE` – directory for the per-chart strategy-vote cache and the screener's market-cap
  cache (default `data/cache/`). Safe to delete; it is rebuilt on the next analysis / scan.
- `TRADEBOT_RESOLVE_SECONDS` – auto-evaluator interval (default 600).

## Disclaimer

This is an analytics and research tool. It is not investment advice, and no combination of
indicators predicts markets reliably. Use the feedback loop and the Accuracy tab to measure how it
actually performs on the instruments and timeframes you care about before trusting it with anything.
