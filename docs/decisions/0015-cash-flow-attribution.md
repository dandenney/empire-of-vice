# 0015: cash flow attribution

Status: accepted (decided while refreshing T02b, issue #6, decision 3)

## Context

The cash flow statement (`CashFlowStatement` in contracts, FIN-001) reports each period's net cash movement in categories: `SALES`, `ASSET_SALES`, `MATERIALS`, `EQUIPMENT`, `WAGES`, `OVERHEAD`, `TRANSPORT`, `PENALTIES`. A `LedgerEntry` has no category, so the projection has to infer one per transaction.

The Sprint Zero projection filed a transaction's cash under its `TransactionKind` only. A daily settlement that pays wages and overhead in one transaction therefore reported both as `WAGES`, and so did a settlement that only pays overhead. Options:

- A. Keep kind-only.
- B. Use the category of the transaction's non-cash accounts when they all agree; otherwise the kind's default.
- C. Split one transaction's cash across categories in proportion to its non-cash lines. This needs a rounding rule for every split (ADR 0002) and still guesses for lines that aren't cash-like (inventory, COGS).
- D. Add a category to `LedgerEntry`. A contract change, and a second source of truth next to the account.

## Decision

**B.** For each transaction with a non-zero net cash movement (the sum of its `CASH` debits minus `CASH` credits):

1. Look up the category of every non-cash entry's account:

   | Account | Category |
   |---|---|
   | `WAGES_EXPENSE`, `WAGES_PAYABLE` | `WAGES` |
   | `OVERHEAD_EXPENSE` | `OVERHEAD` |
   | `PENALTY_EXPENSE`, `PENALTIES_PAYABLE` | `PENALTIES` |
   | `TRANSPORT_EXPENSE` | `TRANSPORT` |
   | `SALES_REVENUE` | `SALES` |
   | `RAW_MATERIALS` | `MATERIALS` |
   | `EQUIPMENT`, `VEHICLES`, `FACILITIES` | `EQUIPMENT` |
   | `GAIN_ON_ASSET_SALE` | `ASSET_SALES` |

   Every other account (`FINISHED_GOODS`, `GOODS_IN_TRANSIT`, `RECEIVABLES`, `OWNER_EQUITY`, `COST_OF_GOODS_SOLD`, `LOSSES`) has no category.
2. If every non-cash entry maps to the same category, the whole net cash movement goes there.
3. Otherwise (the accounts disagree, or any non-cash account has no category), it goes to the kind's default (`CASH_FLOW_CATEGORY` in `packages/simulation/src/projection/finance.ts`). A kind whose default is null and whose accounts don't settle the category is a projection error, as before.

The whole amount always goes to one category: no split, no rounding. Each period's lines still sum to its `netChange`, and `closingCash = openingCash + netChange`.

Examples:

- Dr `OVERHEAD_EXPENSE` / Cr `CASH`: `OVERHEAD` (kind-only reported `WAGES`).
- Dr `WAGES_PAYABLE` / Cr `CASH` (paying down accrued wages): `WAGES`.
- Dr `WAGES_EXPENSE` + Dr `OVERHEAD_EXPENSE` / Cr `CASH`: the accounts disagree, so the `DAILY_SETTLEMENT` default, `WAGES`, for the whole amount.
- A sale with COGS (Dr `CASH` / Cr `SALES_REVENUE`, Dr `COST_OF_GOODS_SOLD` / Cr `GOODS_IN_TRANSIT`): COGS and transit have no category, so the `SALE` default, `SALES`.
- Selling equipment at a gain (Cr `EQUIPMENT` + Cr `GAIN_ON_ASSET_SALE`): disagree, so `ASSET_SALES`.

### Production's capitalized conversion cost stays under WAGES

Production capitalizes labor and overhead into the goods (Dr `FINISHED_GOODS` / Cr `RAW_MATERIALS` / Cr `CASH` or `WAGES_PAYABLE`, FIN-001). `FINISHED_GOODS` has no category, so the cash goes to the `PRODUCTION` default, `WAGES`, including the overhead share. That's deliberate: the cash is conversion cost paid at job completion, and splitting it into labor and overhead would need option C's rounding. If the report needs overhead apart, the production flow (T02c) can book the conversion cash as separate transactions.

## Consequences

- Flows that want wages and overhead reported apart post them as separate transactions (T02c's daily settlement does). One mixed transaction still reports under its kind's default.
- The rule reads only accounts and kinds, so it needs no contract change and works on every existing save: reports are derived (ADR 0008), so old logs are simply re-reported.
- A new account or kind must be added to the table or to `CASH_FLOW_CATEGORY`. An unmapped account falls back to the kind's default, so forgetting one misfiles cash but never breaks the reconciliation (`lines` sum to `netChange` either way).
- State hashes are unaffected: the rule changes only the projection.
