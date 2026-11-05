# 0016: Daily market cycle, buyer terms, and shortages

Status: accepted (decided while refreshing T02d, issue #8)

## Context

GDD §7 (ECO-001) gives the spot price formula, its clamps, the order of the midnight cycle, and the buyer-liquidity cap. It doesn't say how demand `D` and supply `S` move from day to day, how a shortage is configured or timed, which transaction carries the midnight update (ADR 0010's amendment allows no events outside the coordinator), how multipliers are rounded, or how buyer commitments interact with the daily refresh. GDD §14.4 leaves the buyer configuration open.

## Decision

### Spot price

- `M_D = clamp(ratioOf(D, D₀), 0.80, 1.25)`, `M_S = clamp(ratioOf(S₀, max(S, 1)), 0.80, 1.25)`, and `M_E = clamp(eventRatio, 0.90, 1.10)`, each a ppm `Ratio` (ADR 0002). `P_spot = applyRatios(P_base, [M_D, M_S, M_E])`, rounded once, half up to the cent. The bounds live in game-data (`MARKET_PRICE_BOUNDS`). The snapshot reports these exact multipliers, so `applyRatios(base, reported) === spotPrice`.
- The buyer quote for a want is `applyRatios(spotPrice, [want.priceRatio])`. That is a second rounding, applied to the already-rounded spot price, so the quote is always derivable from the reported spot. During a shortage, the supplier price is `applyRatios(def.unitPrice, [shortage.priceRatio])`.
- Invalid market data fails validation when the market system registers. That covers `D₀` or `S₀` ≤ 0, a buyer want without a market, `demandDriftPpm` outside `0 ≤ x < 1 000 000`, more than one configured shortage affecting the same market, and the other checks listed in T02d.
- Because `S ≥ S₀` always holds (below), `M_S` never exceeds 1.0, so the reachable combined multiplier is 0.576–1.375. T07a should tune within that range.

### Daily dynamics

- `D` for the new day is `D₀` plus a seeded integer drift `nextIntBetween(−k, k)` (inclusive), where `k = floor(D₀ × demandDriftPpm / 10⁶)`. Drift is drawn from the `market` RNG stream once per market every midnight, even when `k = 0`, in **market order**: product ID, then quality rank.
- `S` for the new day is `S₀` plus the cases buyers took from that market the previous day (the sum of `dailyDemand − demandRemaining` over the wants priced from it). Flooding a market lowers tomorrow's price, down to the 0.80 floor.
- `M_E` is the `eventRatio` of the one active shortage affecting that market, or `RATIO_ONE` if there is none. Validation allows at most one configured shortage per market, so there is no fold and no extra rounding.
- `MarketState` holds the inputs of today's quote and never changes mid-day. Mid-day effects of trades live in supplier stock and in buyers' remaining demand and budget.

### Midnight cycle

One `DAILY_SETTLEMENT` transaction with no ledger entries runs GDD §7's steps in order. It is keyed `DAILY_SETTLEMENT:MARKET:<dayIndex>`, where `<dayIndex>` is `dayIndex(tick)` at the midnight tick: **the day that is starting**. The same value goes in `MARKET_UPDATED.dayIndex`. Production's settlement (ADR 0017) keys by the day that just ended. The second key part (`MARKET` vs `WAGES`, `OVERHEAD`, `PAYROLL`) differs, so the two conventions can't collide.

1. Reset each supplier stock line to its daily level. Normally that is `available = dailyStock` and `unitPrice = def.unitPrice`. During a shortage it is `available = floor(dailyStock × supplyRatio)` and `unitPrice = applyRatios(def.unitPrice, [priceRatio])`.
2. Record sold volume, then reset buyer budgets and demand. Outstanding commitments stay.
3. On day 1, schedule each configured shortage. Set `eventRatio`.
4. Draw drift and compute prices, then buyer quotes as `applyRatios(spotPrice, [want.priceRatio])`.

On day 1, step 3's shortage rolls therefore come before step 4's drift draws on the `market` stream.
5. Emit `MARKET_UPDATED`.

### Why DAILY_SETTLEMENT

SIM-001 step 5 is "settle recurring costs, replenish supply, update demand/prices". Reusing the kind needs no contract change. It does go a little against ADR 0010's reason for specific transaction kinds, namely that a kind tells you what happened. That's accepted because these transactions carry no ledger entries. Other midnight settlements, such as T02c's wages, use their own key namespace (for example `DAILY_SETTLEMENT:WAGES:<day>`). If the finance panel needs to tell these apart, a `MARKET_UPDATE` kind is a small follow-up contract task.

### Shortages

- A shortage is configured on a supplier stock line: a start-day window, a duration in days, a stock ratio, a price ratio, and effects on product markets.
- At the midnight that starts day 1, each configured shortage rolls its start day as `nextIntBetween(earliestStartDay, latestStartDay)` (inclusive) from the `market` stream. The rolls are made in supplier ID order, then material ID order, over the suppliers in game-data. `SHORTAGE_START` is then scheduled at `startDay × TICKS_PER_DAY`.
- The rolled day is stored **only** as that scheduled `SHORTAGE_START` world event. It carries its tick, plus `supplyRatio` and `durationTicks = durationDays × TICKS_PER_DAY`, copied from the config. Saves and replays need nothing else. `priceRatio` and `marketEffects` are read from game-data while the shortage is active.
- The `SHORTAGE_START` and `SHORTAGE_END` world-event handlers each commit a no-entry `DAILY_SETTLEMENT` transaction keyed `DAILY_SETTLEMENT:SHORTAGE_START:<supplier>:<material>:<tick>` and `DAILY_SETTLEMENT:SHORTAGE_END:<supplier>:<material>:<tick>` respectively. Start sets the stock line's `shortage` and schedules the end; end clears it.
- World events run in SIM-001 step 4, before midnight's step 5, so the effects take hold in that tick's cycle.
- M001 always has exactly one shortage, so player action 8 is guaranteed. Its timing varies by seed.

### Buyer terms and deals (extends ADR 0005)

- A buyer has one minimum reputation. Below it, a quote is rejected with `REPUTATION_TOO_LOW`.
- A cargo line matches the buyer's most specific want: the highest `minimumQuality` at or below the line's quality. A buyer has at most one want per `(product, minimumQuality)`.
- Budgets and demand reset each midnight. When a deal falls through, `releaseDeal` finds the want from the delivery's cargo quality, so T03 must call it before clearing the cargo. It sets `want.demandRemaining = min(want.dailyDemand, want.demandRemaining + quantity)` and `budgetRemaining = min(dailyBudget, budgetRemaining + quantity × agreedUnitPrice)`, so no release can push a buyer past one day's limits.

## Consequences

- Each multiplier has one explainable cause: drift, the player's own sales, or an event. Repeat arbitrage is bounded by each buyer's daily caps and by the price response to flooding.
- `quoteDeal` needs game-data, so logistics passes `data` to it.
- Saves need no new state: sold volume is derived from buyers' wants, and shortage effects from the stock line plus game-data.
- Numbers are placeholder tuning in game-data, validated by T07a. Buyer and supplier names stay as placeholders until the story issue for M001 names is decided.
