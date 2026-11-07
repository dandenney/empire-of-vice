// Victory (T05f, issue #105; GDD §2 approved assumption 5, §7; ADR 0020
// decisions 7 and 8).
//
// - Checked every tick in the progression `deadlines` hook, after reputation and
//   tier promotion, and only while `outcome` is PLAYING (the first outcome wins
//   and is never evaluated again).
// - The conditions, all read from `progression.victory`: net worth ≥ the
//   threshold, reputation ≥ the threshold, and at least the required number of
//   contracts with status COMPLETED, whatever their installment outcomes
//   (GDD §7's "completed").
// - One PROGRESSION transaction with no entries, keyed `PROGRESSION:VICTORY`. It
//   sets `outcome = { WON, tick }` and emits VICTORY_ACHIEVED with the net worth,
//   the reputation, and the first COMPLETED contract in `state.contracts` order.

import { idempotencyKey, type GameState, type TransactionCoordinator } from "@eov/contracts";
import type { GameData } from "@eov/game-data";
import { balanceSheet } from "../economy/ledger/ledger.ts";
import type { TickContext } from "../kernel/registry.ts";

/** Records the victory if every condition holds this tick while the game is still PLAYING. */
export function checkVictory(state: GameState, data: GameData, coordinator: TransactionCoordinator, ctx: TickContext): GameState {
  if (state.outcome.status !== "PLAYING") return state;
  const victory = data.progression.victory;
  const reputation = state.family.reputation;
  if (reputation < victory.reputation) return state;
  const completed = state.contracts.filter((c) => c.status === "COMPLETED");
  const first = completed[0];
  if (first === undefined || completed.length < victory.completedContracts) return state;
  const netWorth = balanceSheet(state).netWorth;
  if (netWorth < victory.netWorth) return state;

  const tx = coordinator.begin(state, {
    kind: "PROGRESSION",
    idempotencyKey: idempotencyKey("PROGRESSION", "VICTORY"),
    tick: ctx.tick,
    causedBy: null,
  });
  if (tx.status === "duplicate") return state;
  tx.update((s) => ({ ...s, outcome: { status: "WON", tick: ctx.tick } }));
  tx.emit({ type: "VICTORY_ACHIEVED", netWorth, reputation, completedContractId: first.id });
  const result = tx.commit();
  if (result.status !== "committed") throw new Error(`Victory was rejected: ${JSON.stringify(result.reason)}`);
  return result.state;
}
