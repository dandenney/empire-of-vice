# 0002: Money, rounding, and fixed-point multipliers

Status: proposed (T00b, issue #2)

## Context

GDD §8 (FIN-001) requires integer cents, checked arithmetic, and balanced double-entry. GDD §7 (ECO-001) prices goods as `roundHalfUpToCent(P_base × M_D × M_S × M_E)` with fractional multipliers. Architecture §8 forbids engine-dependent float math in the simulation, because the same seed has to give the same state hash in every browser and in Node.

So we need a money type the compiler can tell apart from other numbers, a multiplier representation without floats, and one rounding rule used everywhere.

## Decision

All of this lives in `packages/contracts/src/money.ts`.

### Money

- `Money` is a **branded `number` holding signed integer cents**. A plain `number` (a quantity, a tick) can't be passed where cents are expected without going through `cents()`.
- It's a `number`, not a `bigint`, because cents in M001 stay far below `Number.MAX_SAFE_INTEGER` (about $90 trillion). That keeps Money JSON-serializable for saves and snapshots.
- `cents()` rejects fractions, `NaN`, infinities, and unsafe integers. It normalizes `-0` to `0` so it never reaches a state hash.
- **Every operation is checked.** `addMoney`, `subtractMoney`, `multiplyMoney` (by a whole number only), `sumMoney`, and the rounding functions throw `MoneyRangeError` if a result leaves the safe-integer range. Overflow is a bug, not a gameplay outcome, so it throws rather than returning a rejection. The transaction coordinator computes amounts while staging, before anything commits, so a throw can't partially mutate state.
- **Money is signed.** Deltas, liabilities, and net worth can be negative (GDD §8 allows negative net worth). "Cash can't go negative" is a ledger rule enforced by the coordinator (T02b), not by the type.

### Ratios (fixed-point multipliers)

- `Ratio` is a **branded integer in parts per million**: `1_000_000` means 1.0×. All GDD multipliers are exact at this scale: clamps 0.80/1.25 and 0.90/1.10, the 95% contract price, the 20% penalty.
- `ratioOf(D, D₀)` turns an integer fraction into a Ratio, rounding to the nearest ppm. That's the only rounding a ratio goes through.
- `game-data` stores multipliers as ppm integers (e.g. `800_000`), never as decimal floats.

### Rounding

- `applyRatios(amount, ratios)` multiplies the amount by every ratio with **exact BigInt arithmetic and rounds once, at the end**. Rounding after each multiplier would make the result depend on the order the multipliers are applied in.
- `roundHalfUpToCent` rounds ties **away from zero** (2.5¢ → 3¢, −2.5¢ → −3¢). For the positive prices the GDD uses, that's half up. For negative amounts it's symmetric, so negating a value never changes its size, which keeps debits and credits mirror images.
- `divideMoney` (rounded to the nearest cent) is for display values like average unit cost. **Allocating cost basis on partial inventory removal is T02a's job** and isn't done with `divideMoney`, because FIN-001 says the final removal takes the rounding residue.

### Formatting

`formatMoney` prints `$1,234.56` / `-$0.05` without `Intl`, so output is identical across engines and stable in snapshot tests.

## Consequences

- The GDD §7 example ($20 × 1.10 × 1.25 = $27.50) and the 95% contract price (26.125 → $26.13) are covered by tests in `packages/contracts/test/money.test.ts`.
- BigInt is used only inside `applyRatios` and the rounding functions. It never appears in state, saves, or snapshots.
- Converting `D / D₀` to ppm rounds once (at most ±0.5 ppm). That's deterministic, and far below a cent at M001 prices.
- If money ever needs to exceed about $90 trillion, `Money` becomes a `bigint` and the saves need a migration. That isn't expected in this game.
