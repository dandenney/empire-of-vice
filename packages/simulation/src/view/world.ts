// What an order's checks may read (ADR 0022 decision 2): the domain state an
// issuer's view is made of, without the simulation's plumbing.
//
// `WorldSlice` is GameState minus what no issuer ever sees: the RNG, the ID and
// sequence counters, the event journal, scheduled world events, the command
// queue, the seed, the scenario ID and the outcome, and the deliveries' own
// status (the founder knows their trips through VEHICLE_WHEREABOUTS, below). The
// read-only rule helpers (stock, storage, crew, quotes, contracts) take a
// WorldSlice, so the same rule reads the world when a command is staged and the
// issuer's view when it's judged. A GameState is a WorldSlice; an IssuerView's
// `world` is a masked one (`issuer-view.ts`).

import type { BuyerId, ContractOfferId, DeliveryId, DeliveryPurpose, GameState, Money } from "@eov/contracts";
import { ledgerBalances } from "../economy/ledger/ledger.ts";

export type WorldSlice = Pick<
  GameState,
  | "tick"
  | "founder"
  | "family"
  | "facilities"
  | "productPools"
  | "materialPools"
  | "reservations"
  | "productionJobs"
  | "vehicles"
  | "heldDeals"
  | "buyers"
  | "suppliers"
  | "contractOffers"
  | "contracts"
  | "routes"
  | "ledger"
  | "commandLog"
  | "knowledge"
>;

/** An outbound trip the issuer knows of (ADR 0021 decision 8's `inTransit` rule). */
export interface KnownTrip {
  readonly deliveryId: DeliveryId;
  readonly purpose: DeliveryPurpose;
  readonly cases: number;
}

/** A contract offer the issuer can name: in the live view, or in a known CONTRACT_OFFERS record. */
export interface KnownOffer {
  readonly id: ContractOfferId;
  readonly buyerId: BuyerId;
}

/**
 * The issuer's view of the world, as a WorldSlice plus what only a view has.
 * `contractOffers` is the live view's (an offer still on the table); `knownOffers`
 * is every offer the issuer can name (gate 1). `trips` replaces the deliveries.
 */
export interface ViewWorld extends WorldSlice {
  readonly knownOffers: readonly KnownOffer[];
  readonly trips: readonly KnownTrip[];
}

/** The purse: always known (ADR 0021 decision 3). */
export function cashOf(world: Pick<WorldSlice, "ledger">): Money {
  return ledgerBalances(world.ledger.transactions).CASH;
}
