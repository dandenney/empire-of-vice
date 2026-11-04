// S0 stub: extended by T02d (ECO-001 daily market, buyers, suppliers, shortages).
//
// What's here is only what the Sprint Zero path needs:
// - opening market, supplier, and buyer state from game-data,
// - PURCHASE_MATERIALS at the supplier's current price,
// - spot deals struck at dispatch (ADR 0005): the buyer's quote, the liquidity
//   cap, and committing/settling the buyer's demand and budget.
// No midnight cycle yet: prices, stock, and buyer demand stay at their opening
// values until T02d adds replenishment, refresh, and the spot price formula.

import {
  applyRatios,
  idempotencyKey,
  multiplyMoney,
  qualityRank,
  RATIO_ONE,
  subtractMoney,
  type BuyerId,
  type BuyerState,
  type CargoLine,
  type DeliveryId,
  type GameState,
  type MarketState,
  type Money,
  type RejectionReason,
  type SupplierState,
  type TransactionCoordinator,
} from "@eov/contracts";
import type { GameData, ScenarioDefinition } from "@eov/game-data";
import type { SystemRegistry } from "../../kernel/registry.ts";
import { addMaterial } from "../../inventory/pools.ts";
import { cashBalance } from "../ledger/ledger.ts";

// ---------------------------------------------------------------------------
// Opening state
// ---------------------------------------------------------------------------

/** The market's opening quote: base price, with demand and supply at baseline (all multipliers 1.0×). */
export function initialMarkets(data: GameData): readonly MarketState[] {
  return data.markets.map((m) => {
    const product = data.products.find((p) => p.id === m.productId);
    if (!product) throw new RangeError(`Market for unknown product ${m.productId}`);
    return {
      productId: m.productId,
      quality: m.quality,
      demand: m.baselineDemand,
      supply: m.baselineSupply,
      eventRatio: RATIO_ONE,
      spotPrice: product.basePrice[m.quality],
      previousSpotPrice: null,
    };
  });
}

export function initialSuppliers(data: GameData, scenario: ScenarioDefinition): readonly SupplierState[] {
  return [...scenario.supplierIds].sort().map((id) => {
    const def = data.suppliers.find((s) => s.id === id);
    if (!def) throw new RangeError(`Scenario references unknown supplier ${id}`);
    return {
      id,
      stock: def.stock.map((st) => ({ materialId: st.materialId, available: st.dailyStock, unitPrice: st.unitPrice, shortage: null })),
    };
  });
}

/** Buyers' opening quotes: the market spot price times the buyer's price ratio. */
export function initialBuyers(data: GameData, scenario: ScenarioDefinition, markets: readonly MarketState[]): readonly BuyerState[] {
  return [...scenario.buyerIds].sort().map((id) => {
    const def = data.buyers.find((b) => b.id === id);
    if (!def) throw new RangeError(`Scenario references unknown buyer ${id}`);
    return {
      id,
      budgetRemaining: def.dailyBudget,
      wants: def.wants.map((w) => {
        const market = markets.find((m) => m.productId === w.productId && m.quality === w.minimumQuality);
        if (!market) throw new RangeError(`Buyer ${id} wants ${w.productId} with no ${w.minimumQuality} market`);
        return {
          productId: w.productId,
          minimumQuality: w.minimumQuality,
          unitPrice: applyRatios(market.spotPrice, [w.priceRatio]),
          demandRemaining: w.dailyDemand,
        };
      }),
      commitments: [],
    };
  });
}

// ---------------------------------------------------------------------------
// Spot deals (ADR 0005)
// ---------------------------------------------------------------------------

export interface Deal {
  readonly buyerId: BuyerId;
  readonly unitPrice: Money;
  readonly quantity: number;
  readonly amount: Money;
}

/**
 * Checks a spot deal for one cargo line against the buyer's current quote and
 * liquidity (GDD §7: min(offered, demand remaining, budget / price)). No partial
 * sales: anything the buyer won't fully take is rejected.
 */
export function quoteDeal(state: GameState, buyerId: BuyerId, agreedUnitPrice: Money, line: CargoLine): Deal | RejectionReason {
  const buyer = state.buyers.find((b) => b.id === buyerId);
  if (!buyer) return { code: "UNKNOWN_ENTITY", kind: "Buyer", id: buyerId };
  const want = buyer.wants.find((w) => w.productId === line.productId && qualityRank(line.quality) >= qualityRank(w.minimumQuality));
  if (!want) return { code: "PRODUCT_NOT_WANTED", buyerId, productId: line.productId, quality: line.quality };
  if (want.unitPrice !== agreedUnitPrice) {
    return { code: "QUOTE_CHANGED", buyerId, agreed: agreedUnitPrice, current: want.unitPrice };
  }
  const affordable = want.unitPrice > 0 ? Math.floor(buyer.budgetRemaining / want.unitPrice) : want.demandRemaining;
  const acceptable = Math.min(want.demandRemaining, affordable);
  if (line.quantity > acceptable) return { code: "BUYER_WILL_TAKE_LESS", buyerId, requested: line.quantity, acceptable };
  return { buyerId, unitPrice: want.unitPrice, quantity: line.quantity, amount: multiplyMoney(want.unitPrice, line.quantity) };
}

/** Commits the buyer's demand and budget to a deal at dispatch. */
export function commitDeal(state: GameState, deal: Deal, deliveryId: DeliveryId, line: CargoLine): GameState {
  return {
    ...state,
    buyers: state.buyers.map((b) => {
      if (b.id !== deal.buyerId) return b;
      let taken = false;
      return {
        ...b,
        budgetRemaining: subtractMoney(b.budgetRemaining, deal.amount),
        wants: b.wants.map((w) => {
          if (taken || w.productId !== line.productId || qualityRank(line.quality) < qualityRank(w.minimumQuality)) return w;
          taken = true;
          return { ...w, demandRemaining: w.demandRemaining - deal.quantity };
        }),
        commitments: [...b.commitments, { deliveryId, productId: line.productId, quantity: deal.quantity, amount: deal.amount }],
      };
    }),
  };
}

/** The commitment a delivery is carrying out, if any. */
export function findCommitment(state: GameState, buyerId: BuyerId, deliveryId: DeliveryId): BuyerState["commitments"][number] | undefined {
  return state.buyers.find((b) => b.id === buyerId)?.commitments.find((c) => c.deliveryId === deliveryId);
}

/** Removes a fulfilled commitment. Its demand and budget stay spent. */
export function settleDeal(state: GameState, buyerId: BuyerId, deliveryId: DeliveryId): GameState {
  return {
    ...state,
    buyers: state.buyers.map((b) => (b.id === buyerId ? { ...b, commitments: b.commitments.filter((c) => c.deliveryId !== deliveryId) } : b)),
  };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerMarket(registry: SystemRegistry, _data: GameData, coordinator: TransactionCoordinator): void {
  registry.onCommand("PURCHASE_MATERIALS", {
    validate: (_state, command) =>
      Number.isSafeInteger(command.quantity) && command.quantity > 0
        ? null
        : { code: "INVALID_QUANTITY", field: "quantity", value: command.quantity },
    apply: (state, command, ctx) => {
      const tx = coordinator.begin(state, {
        kind: "MATERIAL_PURCHASE",
        idempotencyKey: idempotencyKey("MATERIAL_PURCHASE", ctx.envelope.id),
        tick: ctx.tick,
        causedBy: ctx.envelope.id,
      });
      if (tx.status === "duplicate") return { status: "applied", state };

      const { quantity, supplierId, materialId, facilityId } = command;
      const supplier = tx.state.suppliers.find((s) => s.id === supplierId);
      const stock = supplier?.stock.find((s) => s.materialId === materialId);
      let total: Money | null = null;
      if (!Number.isSafeInteger(quantity) || quantity <= 0) {
        tx.reject({ code: "INVALID_QUANTITY", field: "quantity", value: quantity });
      } else if (!tx.state.facilities.some((f) => f.id === facilityId)) {
        tx.reject({ code: "UNKNOWN_ENTITY", kind: "Facility", id: facilityId });
      } else if (!supplier) {
        tx.reject({ code: "UNKNOWN_ENTITY", kind: "Supplier", id: supplierId });
      } else if (!stock) {
        tx.reject({ code: "MATERIAL_NOT_SOLD", supplierId, materialId });
      } else if (stock.available < quantity) {
        tx.reject({ code: "SUPPLIER_STOCK_LOW", materialId, requested: quantity, available: stock.available });
      } else {
        total = multiplyMoney(stock.unitPrice, quantity);
        const cash = cashBalance(tx.state);
        if (cash < total) tx.reject({ code: "INSUFFICIENT_FUNDS", required: total, available: cash });
      }

      if (total !== null && stock && tx.status === "staging") {
        const cost = total;
        tx.update((s) => ({
          ...s,
          suppliers: s.suppliers.map((sup) =>
            sup.id === supplierId
              ? { ...sup, stock: sup.stock.map((st) => (st.materialId === materialId ? { ...st, available: st.available - quantity } : st)) }
              : sup,
          ),
        }));
        tx.update((s) => addMaterial(s, facilityId, materialId, quantity, cost));
        if (cost > 0) {
          tx.post([
            { account: "RAW_MATERIALS", side: "DEBIT", amount: cost },
            { account: "CASH", side: "CREDIT", amount: cost },
          ]);
        }
        tx.emit({
          type: "MATERIALS_PURCHASED",
          supplierId,
          materialId,
          quantity,
          unitPrice: stock.unitPrice,
          total: cost,
          facilityId,
          transactionId: tx.transactionId,
        });
      }

      const result = tx.commit();
      return result.status === "committed" ? { status: "applied", state: result.state } : { status: "rejected", reason: result.reason };
    },
  });
}

