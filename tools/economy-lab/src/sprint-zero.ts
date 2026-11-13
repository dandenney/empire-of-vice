// Sprint Zero, headless (issue #4): "One Case of Moonshine" in Node.
//
//   pnpm --filter @eov/economy-lab sprint-zero
//
// Create game → buy ingredients → produce one case → dispatch truck → deliver →
// sell → record profit → save → reload → continue. Prints the final ledger, net
// worth, and the state hash, and checks that the resumed game ends with the same
// hash as an uninterrupted run (the replay hash quoted in PRs, factory.md §4).

import { formatMoney, LEDGER_ACCOUNTS, type GameCommand, type LedgerAccount, type Money, type SaveMeta } from "@eov/contracts";
import {
  BASIC_MOONSHINE_RECIPE,
  CROSSROADS_ROADHOUSE,
  DISTILLERY_MAIN,
  GAME_DATA,
  MILLERS_FEED,
  MODEL_TT_TRUCK,
  type RecipeDefinition,
} from "@eov/game-data";
import { MemoryStorageAdapter, readSave, writeSave } from "@eov/persistence";
import { accountBalances, balanceSheet, loadGame, newGame, type BalanceSheet, type KernelSimulation } from "@eov/simulation";

export interface SprintZeroStep {
  readonly step: string;
  readonly tick: number;
  readonly events: readonly string[];
}

export interface SprintZeroReport {
  readonly steps: readonly SprintZeroStep[];
  readonly ledger: KernelSimulation["state"]["ledger"]["transactions"];
  readonly balances: Readonly<Partial<Record<LedgerAccount, Money>>>;
  readonly balanceSheet: BalanceSheet;
  /** Hash of the uninterrupted run at the end tick. */
  readonly stateHash: string;
  /** Hash of the run that was saved, reloaded, and continued to the same tick. */
  readonly resumedStateHash: string;
  readonly finalTick: number;
}

/** Wall-clock metadata is the app's, not the simulation's; fixed here so runs are reproducible. */
const SAVE_META: SaveMeta = { slot: "sprint-zero", label: "Sprint Zero", savedAt: "2026-01-01T00:00:00.000Z", appVersion: "economy-lab" };

function apply(sim: KernelSimulation, command: GameCommand): void {
  const result = sim.dispatch({ command });
  if (result.status !== "applied") throw new Error(`${command.type} was ${result.status}: ${JSON.stringify(result)}`);
}

function advanceTo(sim: KernelSimulation, target: number): void {
  if (target > sim.state.tick) sim.advance(target - sim.state.tick);
}

export async function runSprintZero(): Promise<SprintZeroReport> {
  const recipe: RecipeDefinition = GAME_DATA.recipes.find((r) => r.id === BASIC_MOONSHINE_RECIPE)!;
  const steps: SprintZeroStep[] = [];
  const sim = newGame();
  const record = (step: string): void => {
    steps.push({ step, tick: sim.state.tick, events: sim.takeEvents().map((e) => e.type) });
  };
  record("Create game");

  for (const input of recipe.inputsPerCase) {
    apply(sim, { type: "PURCHASE_MATERIALS", supplierId: MILLERS_FEED, materialId: input.materialId, quantity: input.quantity, facilityId: DISTILLERY_MAIN });
  }
  record("Buy ingredients");

  apply(sim, { type: "START_PRODUCTION", facilityId: DISTILLERY_MAIN, recipeId: BASIC_MOONSHINE_RECIPE, quantity: 1 });
  advanceTo(sim, sim.state.productionJobs[0]!.completesAt);
  record("Produce one case");

  // ADR 0022 decision 6: agree the deal at the quote, then dispatch the truck against it.
  const quote = sim.state.buyers.find((b) => b.id === CROSSROADS_ROADHOUSE)!.wants[0]!.unitPrice;
  apply(sim, { type: "AGREE_DEAL", buyerId: CROSSROADS_ROADHOUSE, productId: recipe.productId, quality: recipe.quality, quantity: 1, agreedUnitPrice: quote });
  apply(sim, {
    type: "DISPATCH_DELIVERY",
    vehicleId: MODEL_TT_TRUCK,
    cargo: [{ productId: recipe.productId, quality: recipe.quality, quantity: 1 }],
    purpose: { kind: "SALE", buyerId: CROSSROADS_ROADHOUSE, dealId: sim.state.heldDeals.at(-1)!.id },
    routeId: null,
    driver: { kind: "FOUNDER" },
  });
  record("Dispatch truck");

  advanceTo(sim, sim.state.vehicles[0]!.trip!.arrivesAt);
  record("Deliver and sell");

  // Save through persistence, reload, and continue both runs until the truck is home.
  const storage = new MemoryStorageAdapter();
  await writeSave(storage, sim, SAVE_META);
  const loaded = await readSave(storage, SAVE_META.slot);
  if (!loaded.ok) throw new Error(`Reload failed: ${JSON.stringify(loaded.error)}`);
  const resumed = loadGame(loaded.file.save);
  record("Save and reload");

  const finalTick = sim.state.vehicles[0]!.trip!.arrivesAt;
  advanceTo(sim, finalTick);
  advanceTo(resumed, finalTick);
  record("Truck returns");

  const all = accountBalances(sim.state.ledger.transactions);
  const balances: Partial<Record<LedgerAccount, Money>> = {};
  for (const account of Object.keys(LEDGER_ACCOUNTS) as LedgerAccount[]) if (all[account] !== 0) balances[account] = all[account];

  return {
    steps,
    ledger: sim.state.ledger.transactions,
    balances,
    balanceSheet: balanceSheet(sim.state),
    stateHash: sim.stateHash(),
    resumedStateHash: resumed.stateHash(),
    finalTick,
  };
}

export function formatReport(report: SprintZeroReport): string {
  const lines: string[] = ["Sprint Zero: One Case of Moonshine (placeholder game-data)", ""];
  for (const s of report.steps) lines.push(`  tick ${String(s.tick).padStart(4)}  ${s.step.padEnd(18)} ${s.events.join(", ")}`);
  lines.push("", "Ledger");
  for (const t of report.ledger) {
    lines.push(`  ${t.id}  tick ${t.tick}  ${t.kind}  (${t.idempotencyKey})`);
    for (const e of t.entries) {
      const money = formatMoney(e.amount);
      lines.push(e.side === "DEBIT" ? `      Dr ${e.account.padEnd(20)} ${money}` : `          Cr ${e.account.padEnd(20)} ${money}`);
    }
  }
  lines.push("", "Account balances");
  for (const account of Object.keys(LEDGER_ACCOUNTS) as LedgerAccount[]) {
    const amount = report.balances[account];
    if (amount !== undefined) lines.push(`  ${account.padEnd(20)} ${formatMoney(amount)}`);
  }
  const b = report.balanceSheet;
  lines.push(
    "",
    `Assets ${formatMoney(b.assets)} = liabilities ${formatMoney(b.liabilities)} + equity ${formatMoney(b.equity)} + net income ${formatMoney(b.netIncome)}`,
    `Revenue ${formatMoney(b.revenue)}, expenses ${formatMoney(b.expenses)}`,
    `Net worth ${formatMoney(b.netWorth)}`,
    "",
    `State hash (tick ${report.finalTick}): ${report.stateHash}`,
    `Save → load → continue:  ${report.resumedStateHash} ${report.resumedStateHash === report.stateHash ? "(match)" : "(MISMATCH)"}`,
  );
  return lines.join("\n");
}

if (import.meta.main) {
  const report = await runSprintZero();
  console.log(formatReport(report));
  if (report.resumedStateHash !== report.stateHash) process.exitCode = 1;
}
