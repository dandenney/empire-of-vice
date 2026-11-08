// The Market panel's view helpers (#50). Figures come from the snapshot; the
// only other source is game-data's static definitions for flavor lines and
// shortage names (#60/#81, decision on #50: rule 7 is about game state, and
// these never change during a game). Nothing here computes a game value.

import { formatMoney, type CommandId, type EventOfType, type GameSnapshot, type MaterialId, type ProductId, type QualityTier, type SupplierId, type BuyerId } from "@eov/contracts";
import { BUYERS, SUPPLIERS } from "@eov/game-data";
import { describeOutcome } from "../../components/format.ts";
import { formatQuality } from "../../components/format.ts";
import { COMMON_COPY } from "../../components/copy.ts";
import type { DispatchOutcome } from "../../state/gateway-client.ts";
import { MARKET_COPY as C } from "./copy.ts";

/** A supplier's one-line flavor from game-data, or null. */
export function supplierFlavor(id: SupplierId): string | null {
  return SUPPLIERS.find((s) => s.id === id)?.flavor ?? null;
}

/** A buyer's one-line flavor from game-data, or null. */
export function buyerFlavor(id: BuyerId): string | null {
  return BUYERS.find((b) => b.id === id)?.flavor ?? null;
}

/** The in-world name of a stock line's shortage (game-data), or null if the line has none configured. */
export function shortageName(supplierId: SupplierId, materialId: MaterialId): string | null {
  return SUPPLIERS.find((s) => s.id === supplierId)?.stock.find((l) => l.materialId === materialId)?.shortage?.name ?? null;
}

/**
 * The shortages behind a market's event multiplier: every stock line the
 * snapshot reports in shortage whose game-data shortage moves this market.
 */
export function shortagesMoving(snapshot: GameSnapshot, productId: ProductId, quality: QualityTier): readonly string[] {
  return snapshot.market.suppliers.flatMap((supplier) =>
    supplier.materials
      .filter((m) => m.shortage)
      .flatMap((m) => {
        const shortage = SUPPLIERS.find((s) => s.id === supplier.id)?.stock.find((l) => l.materialId === m.materialId)?.shortage;
        return shortage && shortage.marketEffects.some((e) => e.productId === productId && e.quality === quality) ? [shortage.name] : [];
      }),
  );
}

/** A clamped multiplier in parts per million, as "1.05". */
export function formatRatio(ppm: number): string {
  return (ppm / 1_000_000).toFixed(2);
}

export interface RepeatOffer {
  readonly sourceCommandId: CommandId;
  readonly line: string;
}

export interface RepeatOffers {
  readonly purchase: RepeatOffer | null;
  readonly sale: RepeatOffer | null;
}

type Purchased = EventOfType<"MATERIALS_PURCHASED">;
type Dispatched = EventOfType<"DELIVERY_DISPATCHED">;

/**
 * The player's last material purchase and last sale dispatch, from the
 * snapshot's recent events. Each is offered for REPEAT_OPERATION on its
 * `causedBy` (ADR 0020 decision 11: "the UI can offer repeat on the causedBy of
 * the events it already shows"). Names come from the snapshot.
 */
export function repeatOffers(snapshot: GameSnapshot): RepeatOffers {
  let purchase: (Purchased & { causedBy: CommandId }) | null = null;
  let sale: (Dispatched & { causedBy: CommandId }) | null = null;
  for (const event of snapshot.recentEvents) {
    if (event.causedBy === null) continue;
    if (event.type === "MATERIALS_PURCHASED") purchase = { ...event, causedBy: event.causedBy };
    if (event.type === "DELIVERY_DISPATCHED" && event.purpose.kind === "SALE") sale = { ...event, causedBy: event.causedBy };
  }
  return {
    purchase: purchase && {
      sourceCommandId: purchase.causedBy,
      line: C.purchaseLine(purchase.quantity, materialName(snapshot, purchase.supplierId, purchase.materialId), supplierName(snapshot, purchase.supplierId)),
    },
    sale: sale && saleOffer(snapshot, sale),
  };
}

function saleOffer(snapshot: GameSnapshot, event: Dispatched & { causedBy: CommandId }): RepeatOffer | null {
  const cargo = event.cargo[0];
  if (!cargo || event.purpose.kind !== "SALE") return null;
  const buyerId = event.purpose.buyerId;
  const buyer = snapshot.market.buyers.find((b) => b.id === buyerId)?.name ?? buyerId;
  return { sourceCommandId: event.causedBy, line: C.saleLine(cargo.quantity, productName(snapshot, cargo.productId), formatQuality(cargo.quality), buyer) };
}

function supplierName(snapshot: GameSnapshot, id: SupplierId): string {
  return snapshot.market.suppliers.find((s) => s.id === id)?.name ?? id;
}

function materialName(snapshot: GameSnapshot, supplierId: SupplierId, id: MaterialId): string {
  return snapshot.market.suppliers.find((s) => s.id === supplierId)?.materials.find((m) => m.materialId === id)?.materialName ?? id;
}

export function productName(snapshot: GameSnapshot, id: ProductId): string {
  return snapshot.market.products.find((p) => p.productId === id)?.productName ?? snapshot.market.buyers.flatMap((b) => b.wants).find((w) => w.productId === id)?.productName ?? id;
}

/**
 * A command's outcome for the Market panel. QUOTE_CHANGED and
 * BUYER_WILL_TAKE_LESS spell out their numbers (ADR 0005); every other outcome
 * reads as it does elsewhere, with its typed reason.
 */
export function describeMarketOutcome(outcome: DispatchOutcome): string {
  if (outcome.kind === "result" && outcome.result.status === "rejected") {
    const reason = outcome.result.reason;
    if (reason.code === "QUOTE_CHANGED") {
      return COMMON_COPY.rejected(C.rejectedWithCode(C.quoteChanged(formatMoney(reason.agreed), formatMoney(reason.current)), reason.code));
    }
    if (reason.code === "BUYER_WILL_TAKE_LESS") {
      return COMMON_COPY.rejected(C.rejectedWithCode(C.buyerWillTakeLess(reason.requested, reason.acceptable), reason.code));
    }
  }
  return describeOutcome(outcome);
}
