// @eov/simulation/game: the composition root and the S0 economic systems.
// Exposed as a subpath export because `src/index.ts` is the kernel's (T01) file;
// folding these into the main entry point is left to a later task (see the S0a PR).

export { createInitialState, loadGame, newGame, ScenarioSetupError, simulationOptions, type GameSetup } from "./new-game.ts";
export { createGameRegistry, SYSTEMS, type RegisterSystem, type SystemEntry } from "./systems.ts";
export { checkInvariants, CoordinatorError, createCoordinator } from "../economy/coordinator/index.ts";
export {
  accountBalances,
  balanceSheet,
  cargoLossEntries,
  cashBalance,
  dispatchEntries,
  entryTotals,
  equipmentPurchaseEntries,
  impairmentEntries,
  ledgerBalances,
  materialPurchaseEntries,
  payDownEntries,
  payOrAccrueEntries,
  productionEntries,
  productionWriteOffEntries,
  returnFromTransitEntries,
  saleEntries,
  type AccountBalances,
  type BalanceSheet,
  type ExpenseAccount,
  type PayOrAccrueCharge,
  type ProductionCosts,
  type SaleAmounts,
} from "../economy/ledger/index.ts";
export { allocateRemovalCost, availableMaterial, availableProduct } from "../inventory/index.ts";
