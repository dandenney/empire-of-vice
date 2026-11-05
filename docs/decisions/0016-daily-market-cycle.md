# 0016: Daily market cycle, buyer terms, and shortages

Status: accepted (decided while refreshing T02d, issue #8)

## Context

GDD §7 (ECO-001) gives the spot price formula, its clamps, the order of the midnight cycle, and the buyer-liquidity cap. It doesn't say how demand `D` and supply `S` move from day to day, how a shortage is configured or timed, which transaction carries the midnight update (ADR 0010's amendment allows no events outside the coordinator), how multipliers are rounded, or how buyer commitments interact with the daily refresh. GDD §14.4 leaves the buyer configuration open.

## Decision

### Spot price

- `M_D = clamp(ratioOf(D, D₀), 0.80, 1.25)`, `M_S = clamp(ratioOf(S₀, max(S, 1)), 0.80, 1.25)`, and `M_E = clamp(eventRatio, 0.90, 1.10)`, each a ppm `Ratio` (ADR 0002). `P_spot = applyRatios(P_base, [M_D, M_S, M_E])`, rounded once, half up to the cent. The bounds live in game-data (`MARKET_PRICE_BOUNDS`). The snapshot reports these exact multipliers, so `applyRatios(base, reported) === spotPrice`.
- Invalid market data (`D₀` or `S₀` ≤ 0, a buyer want without a market, and the other checks listed in T02d) fails validation when the market system registers.

### Daily dynamics

- `D` for the new day is `D₀` plus a seeded integer drift in ±`floor(D₀ × demandDriftPpm / 10⁶)`, drawn from the `market` RNG stream in market order.
- `S` for the new day is `S₀` plus the cases buyers took from that market the previous day (the sum of `dailyDemand − demandRemaining` over the wants priced from it). Flooding a market lowers tomorrow's price, down to the 0.80 floor.
- `M_E` is the product of the active shortages' effects on that market, or 1.0 if there are none.
- `MarketState` holds the inputs of today's quote and never changes mid-day. Mid-day effects of trades live in supplier stock and in buyers' remaining demand and budget.

### Midnight cycle

One `DAILY_SETTLEMENT` transaction with no ledger entries, keyed `DAILY_SETTLEMENT:MARKET:<dayIndex>`, runs GDD §7's steps in order:

1. Reset supplier stock to its daily level (`floor(dailyStock × supplyRatio)` and `def.unitPrice × priceRatio` during a shortage).
2. Record sold volume, then reset buyer budgets and demand. Outstanding commitments stay.
3. On day 1, schedule each configured shortage. Set `eventRatio`.
4. Compute prices and buyer quotes (`spot × priceRatio`).
5. Emit `MARKET_UPDATED`.

### Why DAILY_SETTLEMENT

SIM-001 step 5 is "settle recurring costs, replenish supply, update demand/prices". Reusing the kind needs no contract change. Other midnight settlements, such as T02c's wages, use their own key namespace (for example `DAILY_SETTLEMENT:WAGES:<day>`). If the finance panel needs to tell these apart, a `MARKET_UPDATE` kind is a small follow-up contract task.

### Shortages

- A shortage is configured on a supplier stock line: a start-day window, a duration in days, a stock ratio, a price ratio, and effects on product markets.
- At the first midnight (day 1) its start day is rolled from the `market` stream and `SHORTAGE_START` is scheduled for that day's midnight tick.
- The `SHORTAGE_START` and `SHORTAGE_END` world-event handlers each commit a no-entry `DAILY_SETTLEMENT` transaction keyed `DAILY_SETTLEMENT:SHORTAGE_START|SHORTAGE_END:<supplier>:<material>:<tick>`. Start sets the stock line's `shortage` and schedules the end; end clears it.
- World events run in SIM-001 step 4, before midnight's step 5, so the effects take hold in that tick's cycle.
- M001 always has exactly one shortage, so player action 8 is guaranteed. Its timing varies by seed.

### Buyer terms and deals (extends ADR 0005)

- A buyer has one minimum reputation. Below it, a quote is rejected with `REPUTATION_TOO_LOW`.
- A cargo line matches the buyer's most specific want: the highest `minimumQuality` at or below the line's quality. A buyer has at most one want per `(product, minimumQuality)`.
- Budgets and demand reset each midnight. A deal that falls through (`releaseDeal`) restores demand and budget capped at the daily values, so no release can push a buyer past one day's limits.

## Consequences

- Each multiplier has one explainable cause: drift, the player's own sales, or an event. Repeat arbitrage is bounded by each buyer's daily caps and by the price response to flooding.
- `quoteDeal` needs game-data, so logistics passes `data` to it.
- Saves need no new state: sold volume is derived from buyers' wants, and shortage effects from the stock line plus game-data.
- Numbers are placeholder tuning in game-data, validated by T07a. Buyer and supplier names stay as placeholders until the story issue for M001 names is decided.
