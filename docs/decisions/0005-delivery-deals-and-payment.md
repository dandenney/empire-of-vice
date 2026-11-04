# 0005: Delivery deals and payment timing

Status: proposed (T00b, issue #2). Settles GDD §14.7.

## Context

GDD §4 has the player "assign inventory and a truck to a delivery", and GDD §7 gives the spot price and a buyer-liquidity cap (`min(offered, demand remaining, budget / price)`). The GDD doesn't say **when** a sale is priced and accepted: at dispatch, or when the truck arrives. GDD §14.7 leaves payment timing open, recommending immediate payment.

The genre answers the first question. A Prohibition bootlegger didn't drive contraband into town and look for a buyer at whatever the market paid. A speakeasy or saloon keeper placed an order ("ten cases Thursday, $22 a case"), the run was the risky part, and the buyer paid cash on delivery. Showing up with cases nobody ordered meant driving around with illegal goods and no buyer.

## Decision

### A sale is a deal struck at dispatch

- `DISPATCH_DELIVERY` with purpose `SALE` **fixes the quantity and unit price when the command applies**, using the buyer's quote for that day (GDD §7 spot price with the buyer's terms).
- **The buyer's remaining demand and budget are committed at once.** This matches GDD §7: "actual purchases and sales reduce stock and remaining demand immediately."
- **The command carries the `agreedUnitPrice` the player saw.** If the quote has changed by the time the command applies (most likely for a queued command), it's rejected with `QUOTE_CHANGED { agreed, current }`, not executed at a different price.
- **No partial sales.** If the cargo is more than the buyer's demand or budget allows, the command is rejected with `BUYER_WILL_TAKE_LESS { requested, acceptable }`. The UI can say "Buyer will only take 6 cases", and the player adjusts. Commands stay all-or-nothing.
- The cargo is held for the deal: it's in the truck, so it's no longer available for anything else.

### Payment: cash on delivery

- **The buyer pays the agreed amount immediately when the delivery completes** (GDD §14.7, recommended option). Revenue and cost of goods sold are recognized at that moment (FIN-001: on sale, not on production or dispatch).
- No receivables in M001. The ledger keeps a receivables account, so a later milestone can add credit terms without changing the chart of accounts.

### When a run fails

- If a disruption delays the truck past what the deal allows, or seizes the cargo, **the deal falls through**. The buyer's committed demand and budget are released, and any lost cargo is written off explicitly as a loss (FIN-001: "cargo loss is recorded explicitly").
- What counts as too late, and any reputation penalty for not showing up, belong to T02d and T03 and are tuned in game-data.

### Spot deals and contracts share one path

A spot sale is a one-off order; a contract is a recurring order with a pre-agreed price (GDD §7: 95% of spot when signed). Both go through the same flow: commit buyer, load cargo, dispatch, deliver, cash on delivery. A contract installment's cargo comes from its reservation.

## Consequences

- This goes slightly beyond GDD §7, which doesn't say when a sale is priced. Recorded here, and flagged in the T00b PR.
- T02d implements buyer commitments and quotes, T03 implements failed runs, and T02b settles payment through the coordinator.
- Selling is predictable for the player (the price you agree is the price you get) and the risk sits where the genre puts it: on the road.
- The extra machinery is small, because contracts already need inventory reservations, and buyer commitments use the same release-on-failure pattern.
