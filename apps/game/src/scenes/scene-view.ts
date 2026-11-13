// A place scene's view model (SK2b, #234; GDD §18): the layers it shows and
// the actions it offers, from the player snapshot alone (ADR 0021 decision 8).
//
// Layers are known values: the live view while the founder stands there, a
// remembered record otherwise, each with when it was learned. Actions are what
// can be done *there* (ADR 0022 decision 3): buy at the supplier, start a batch
// and load the truck at the family's facility, agree a deal at a buyer, and
// rest anywhere. Each is offered from known state, with the reason it can't be
// done now (busy, closed, nothing known, nothing to load…) worked out only from
// always-known or known values. These are hints: the simulation's gates decide,
// and a scene reports the command's result.

import {
  compareIds,
  QUALITY_TIERS,
  qualityRank,
  type BuyerId,
  type DealId,
  type FacilityId,
  type KnowledgeSource,
  type LocationId,
  type MaterialId,
  type Money,
  type PlayerPlace,
  type PlayerSnapshot,
  type ProductId,
  type QualityTier,
  type RecipeId,
  type RejectionReason,
  type RouteId,
  type SupplierId,
  type Tick,
  type VehicleId,
} from "@eov/contracts";
import { PRODUCTS, REST_PLACES } from "@eov/game-data";
import { hoursAt, type HoursView } from "./hours.ts";
import { restUntilMorning } from "./rest.ts";

/** Why an action can't be taken now, as far as the founder knows. */
export type ActionBlock =
  | { readonly code: "NOT_HERE" }
  | { readonly code: "BUSY"; readonly until: Tick }
  | { readonly code: "CLOSED"; readonly opensAt: Tick | null }
  | { readonly code: "NOT_KNOWN" }
  | { readonly code: "WONT_DEAL" }
  | { readonly code: "NONE_LEFT" }
  | { readonly code: "NO_TRUCK" }
  | { readonly code: "NOTHING_TO_LOAD" }
  | { readonly code: "NO_BUYER" }
  /** A recomputed affordance's reason (`blockedBy`, ADR 0021 decision 8). */
  | { readonly code: "REASON"; readonly reason: RejectionReason };

export interface Choice<T extends string> {
  readonly id: T;
  readonly name: string;
}

export interface BuyAction {
  readonly kind: "BUY";
  readonly key: string;
  readonly supplierId: SupplierId;
  readonly materialId: MaterialId;
  readonly materialName: string;
  readonly unitPrice: Money;
  readonly available: number;
  /** Where the goods go: the family's facilities. */
  readonly facilities: readonly Choice<FacilityId>[];
  readonly blocked: ActionBlock | null;
}

export interface StartBatchAction {
  readonly kind: "START_BATCH";
  readonly key: string;
  readonly facilityId: FacilityId;
  readonly recipeId: RecipeId;
  readonly name: string;
  readonly maxQuantity: number;
  readonly blocked: ActionBlock | null;
}

export interface CargoChoice {
  readonly key: string;
  readonly productId: ProductId;
  readonly productName: string;
  readonly quality: QualityTier;
  /** Known on hand, less what's reserved. */
  readonly available: number;
}

export interface RouteChoice {
  readonly id: RouteId;
  readonly name: string;
  readonly durationTicks: number;
  readonly riskPpm: number;
  /** Known closed (an unknown closure isn't shown). */
  readonly knownClosed: boolean;
}

export interface BuyerChoice {
  readonly buyerId: BuyerId;
  readonly name: string;
  readonly locationId: LocationId;
  /** Roads from here to the buyer: safe first, then quickest, then by id. */
  readonly routes: readonly RouteChoice[];
}

export interface DealChoice {
  /** Command handle only (ADR 0022 decision 6); never shown. */
  readonly dealId: DealId;
  readonly buyerId: BuyerId;
  readonly buyerName: string;
  readonly productId: ProductId;
  readonly productName: string;
  readonly quality: QualityTier;
  readonly quantity: number;
  readonly unitPrice: Money;
  readonly expiresAt: Tick;
}

export interface DispatchAction {
  readonly kind: "DISPATCH";
  readonly key: string;
  readonly vehicleId: VehicleId | null;
  readonly vehicleName: string | null;
  readonly cargo: readonly CargoChoice[];
  readonly buyers: readonly BuyerChoice[];
  /** Held deals the truck could carry out. */
  readonly deals: readonly DealChoice[];
  readonly blocked: ActionBlock | null;
}

export interface AgreeDealAction {
  readonly kind: "AGREE_DEAL";
  readonly key: string;
  readonly buyerId: BuyerId;
  readonly productId: ProductId;
  readonly productName: string;
  readonly minimumQuality: QualityTier;
  /** The qualities the deal could be for: the want's minimum and better. */
  readonly qualities: readonly QualityTier[];
  readonly unitPrice: Money;
  readonly maxQuantity: number;
  readonly blocked: ActionBlock | null;
}

export interface RestAction {
  readonly kind: "REST";
  readonly key: string;
  readonly untilTick: Tick;
  /** A proper bed (REST_PLACES), or sleeping rough. */
  readonly restPlace: boolean;
  readonly blocked: ActionBlock | null;
}

export type SceneAction = BuyAction | StartBatchAction | DispatchAction | AgreeDealAction | RestAction;

/** A state layer in the scene's picture (GDD §18): stock, the truck, the still, wants… */
export type SceneLayer =
  | { readonly kind: "CRATES"; readonly cases: number; readonly seen: Seen | null }
  | { readonly kind: "MATERIALS"; readonly lines: readonly { readonly name: string; readonly quantity: number }[]; readonly seen: Seen | null }
  | { readonly kind: "STILL"; readonly batches: number; readonly doneAt: Tick | null; readonly seen: Seen | null }
  | { readonly kind: "TRUCK"; readonly here: boolean | null; readonly seen: Seen | null }
  | { readonly kind: "SHELVES"; readonly lines: readonly { readonly name: string; readonly available: number; readonly unitPrice: Money }[]; readonly seen: Seen | null }
  | {
      readonly kind: "WANTS";
      readonly willDeal: boolean;
      readonly lines: readonly { readonly name: string; readonly minimumQuality: QualityTier; readonly unitPrice: Money; readonly demand: number }[];
      readonly seen: Seen | null;
    }
  | { readonly kind: "BUDGET"; readonly amount: Money | null; readonly seen: Seen | null }
  | { readonly kind: "EMPTY" };

export interface Seen {
  readonly learnedAt: Tick;
  readonly source: KnowledgeSource;
}

export interface SceneView {
  readonly locationId: LocationId;
  readonly name: string;
  readonly kind: PlayerPlace["kind"];
  readonly hours: HoursView;
  /** The founder is PRESENT here (busy or not). */
  readonly present: boolean;
  /** The founder's timed activity here runs through this tick; null when free. */
  readonly busyUntil: Tick | null;
  readonly layers: readonly SceneLayer[];
  readonly actions: readonly SceneAction[];
}

const seenOf = (known: { readonly learnedAt: Tick; readonly source: KnowledgeSource } | null): Seen | null =>
  known === null ? null : { learnedAt: known.learnedAt, source: known.source };

const productName = (id: ProductId): string => PRODUCTS.find((p) => p.id === id)?.name ?? id;

/** Whether the founder can start a timed activity here now, as far as always-known state goes. */
function presenceBlock(player: PlayerSnapshot, locationId: LocationId): ActionBlock | null {
  const w = player.founder.whereabouts;
  if (w.kind !== "PRESENT" || w.locationId !== locationId) return { code: "NOT_HERE" };
  if (w.busy !== null) return { code: "BUSY", until: w.busy.until };
  return null;
}

/** As presenceBlock, plus the place's hours for dealings with a party (ADR 0023 decision 6). */
function partyBlock(player: PlayerSnapshot, locationId: LocationId, hours: HoursView): ActionBlock | null {
  const block = presenceBlock(player, locationId);
  if (block) return block;
  if (hours.kind === "HOURS" && !hours.open) return { code: "CLOSED", opensAt: hours.opensAt };
  return null;
}

function routeChoices(player: PlayerSnapshot, from: LocationId, to: LocationId): readonly RouteChoice[] {
  return player.routes
    .filter((r) => r.fromLocationId === from && r.toLocationId === to)
    .map((r) => ({
      id: r.id,
      name: r.name,
      durationTicks: r.durationTicks,
      riskPpm: r.riskPpm,
      knownClosed: r.condition !== null && !r.condition.value.status.open,
    }))
    .sort((a, b) => Number(a.riskPpm > 0) - Number(b.riskPpm > 0) || a.durationTicks - b.durationTicks || compareIds(a.id, b.id));
}

function facilityScene(player: PlayerSnapshot, place: Extract<PlayerPlace, { kind: "FACILITY" }>): Pick<SceneView, "layers" | "actions"> {
  const f = place.facility;
  const stock = f.stock;
  const ops = f.operations;
  const truck = player.vehicles[0] ?? null;
  const truckHere = truck?.whereabouts ? truck.whereabouts.value.parkedAt === place.id : null;
  const layers: SceneLayer[] = [
    { kind: "CRATES", cases: stock ? stock.value.products.reduce((n, p) => n + p.quantity, 0) : 0, seen: seenOf(stock) },
    { kind: "MATERIALS", lines: stock ? stock.value.materials.filter((m) => m.quantity > 0).map((m) => ({ name: m.materialName, quantity: m.quantity })) : [], seen: seenOf(stock) },
    {
      kind: "STILL",
      batches: ops ? ops.value.jobs.length : 0,
      doneAt: ops && ops.value.jobs.length > 0 ? Math.max(...ops.value.jobs.map((j) => j.completesAt)) as Tick : null,
      seen: seenOf(ops),
    },
    { kind: "TRUCK", here: truckHere, seen: seenOf(truck?.whereabouts ?? null) },
  ];

  const here = presenceBlock(player, place.id);
  // Recipes this still's equipment can't make aren't offered: that's the family's own equipment, always known.
  const actions: SceneAction[] = f.recipes.filter((r) => r.blockedBy?.code !== "RECIPE_NOT_SUPPORTED").map((r) => ({
    kind: "START_BATCH",
    key: `start:${f.id}:${r.recipeId}`,
    facilityId: f.id,
    recipeId: r.recipeId,
    name: r.name,
    maxQuantity: r.maxStartableQuantity,
    blocked: here ?? (r.blockedBy ? { code: "REASON", reason: r.blockedBy } : r.maxStartableQuantity <= 0 ? { code: "NONE_LEFT" } : null),
  }));

  const cargo: CargoChoice[] = (stock?.value.products ?? [])
    .map((p) => ({ key: `${p.productId}:${p.quality}`, productId: p.productId, productName: p.productName, quality: p.quality, available: p.quantity - p.reservedQuantity }))
    .filter((c) => c.available > 0);
  const buyers: BuyerChoice[] = player.places
    .filter((p): p is Extract<PlayerPlace, { kind: "BUYER" }> => p.kind === "BUYER")
    .map((p) => ({ buyerId: p.buyer.id, name: p.name, locationId: p.id, routes: routeChoices(player, place.id, p.id) }))
    .filter((b) => b.routes.length > 0);
  const buyerName = (id: BuyerId) => player.places.find((p) => p.kind === "BUYER" && p.buyer.id === id)?.name ?? id;
  const deals: DealChoice[] = player.deals
    .filter((d) => d.status === "HELD")
    .map((d) => ({
      dealId: d.id,
      buyerId: d.buyerId,
      buyerName: buyerName(d.buyerId),
      productId: d.productId,
      productName: productName(d.productId),
      quality: d.quality,
      quantity: d.quantity,
      unitPrice: d.unitPrice,
      expiresAt: d.expiresAt,
    }));
  actions.push({
    kind: "DISPATCH",
    key: `dispatch:${f.id}`,
    vehicleId: truck?.id ?? null,
    vehicleName: truck?.name ?? null,
    cargo,
    buyers,
    deals,
    blocked: here ?? (truckHere !== true ? { code: "NO_TRUCK" } : cargo.length === 0 ? { code: "NOTHING_TO_LOAD" } : buyers.length === 0 ? { code: "NO_BUYER" } : null),
  });
  return { layers, actions };
}

function supplierScene(player: PlayerSnapshot, place: Extract<PlayerPlace, { kind: "SUPPLIER" }>, hours: HoursView): Pick<SceneView, "layers" | "actions"> {
  const offer = place.supplier.offer;
  const layers: SceneLayer[] = [
    {
      kind: "SHELVES",
      lines: offer ? offer.value.materials.map((m) => ({ name: m.materialName, available: m.available, unitPrice: m.unitPrice })) : [],
      seen: seenOf(offer),
    },
  ];
  const facilities = player.places
    .filter((p): p is Extract<PlayerPlace, { kind: "FACILITY" }> => p.kind === "FACILITY")
    .map((p) => ({ id: p.facility.id, name: p.name }));
  const block = partyBlock(player, place.id, hours);
  const actions: SceneAction[] = offer
    ? offer.value.materials.map((m) => ({
        kind: "BUY",
        key: `buy:${place.supplier.id}:${m.materialId}`,
        supplierId: place.supplier.id,
        materialId: m.materialId,
        materialName: m.materialName,
        unitPrice: m.unitPrice,
        available: m.available,
        facilities,
        blocked: block ?? (m.available <= 0 ? { code: "NONE_LEFT" } : null),
      }))
    : [];
  return { layers, actions };
}

function buyerScene(player: PlayerSnapshot, place: Extract<PlayerPlace, { kind: "BUYER" }>, hours: HoursView): Pick<SceneView, "layers" | "actions"> {
  const b = place.buyer;
  const wants = b.wants;
  const layers: SceneLayer[] = [
    {
      kind: "WANTS",
      willDeal: wants?.value.willDeal ?? false,
      lines: wants ? wants.value.wants.map((w) => ({ name: w.productName, minimumQuality: w.minimumQuality, unitPrice: w.unitPrice, demand: w.demandRemaining })) : [],
      seen: seenOf(wants),
    },
    { kind: "BUDGET", amount: b.budget?.value.budgetRemaining ?? null, seen: seenOf(b.budget) },
  ];
  const block = partyBlock(player, place.id, hours);
  const actions: SceneAction[] =
    wants === null
      ? []
      : wants.value.wants.map((w) => ({
          kind: "AGREE_DEAL",
          key: `deal:${b.id}:${w.productId}:${w.minimumQuality}`,
          buyerId: b.id,
          productId: w.productId,
          productName: w.productName,
          minimumQuality: w.minimumQuality,
          qualities: QUALITY_TIERS.filter((q) => qualityRank(q) >= qualityRank(w.minimumQuality)),
          unitPrice: w.unitPrice,
          maxQuantity: w.maxAcceptableQuantity,
          blocked: block ?? (!wants.value.willDeal ? { code: "WONT_DEAL" } : w.maxAcceptableQuantity <= 0 ? { code: "NONE_LEFT" } : null),
        }));
  return { layers, actions };
}

/** The scene for the place `locationId`, or null if there's no such place. */
export function sceneView(player: PlayerSnapshot, locationId: LocationId): SceneView | null {
  const place = player.places.find((p) => p.id === locationId);
  if (!place) return null;
  const hours = hoursAt(place.id, player.clock.tick);
  const w = player.founder.whereabouts;
  const present = w.kind === "PRESENT" && w.locationId === place.id;
  const busyUntil = present && w.busy !== null ? w.busy.until : null;
  const body =
    place.kind === "FACILITY"
      ? facilityScene(player, place)
      : place.kind === "SUPPLIER"
        ? supplierScene(player, place, hours)
        : place.kind === "BUYER"
          ? buyerScene(player, place, hours)
          : { layers: [{ kind: "EMPTY" } as const], actions: [] };
  const rest: RestAction = {
    kind: "REST",
    key: `rest:${place.id}`,
    untilTick: restUntilMorning(player.clock.tick),
    restPlace: REST_PLACES.includes(place.id),
    blocked: presenceBlock(player, place.id),
  };
  return { locationId: place.id, name: place.name, kind: place.kind, hours, present, busyUntil, layers: body.layers, actions: [...body.actions, rest] };
}
