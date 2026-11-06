// The snapshot's `contracts` section (T02e, issue #9; ADR 0018; ADR 0007 rules).
//
// - Offers carry display names and `blockedBy`: the rejection ACCEPT_CONTRACT
//   would return if dispatched now (it applies on the next tick), from the same
//   rule the handler uses.
// - Active contracts are in ID order. Closed (COMPLETED) contracts are most
//   recent first: by last deadline, latest first, then by ID, latest first.
// - `reservationIds` and `reservedQuantity` count active reservations only
//   (decision 4); `inTransit` attributes outbound cases to installments with the
//   arrival crediting rule, as if each delivery arrived at its `arrivesAt`
//   (decision 6). Nothing here is stored.

import {
  compareIds,
  tick,
  type ContractOfferSnapshot,
  type ContractSnapshot,
  type ContractState,
  type ContractsSnapshot,
  type GameState,
} from "@eov/contracts";
import type { GameData } from "@eov/game-data";
import { acceptRejection, activeReservations, creditCases, type Installment } from "./rules.ts";

function nameOf(list: readonly { readonly id: string; readonly name: string }[], id: string, what: string): string {
  const found = list.find((x) => x.id === id);
  if (!found) throw new RangeError(`Snapshot: unknown ${what} ${id}`);
  return found.name;
}

/** Cases on outbound deliveries attributed to each installment, by the arrival crediting rule. */
function inTransitByInstallment(state: GameState, contract: ContractState): readonly number[] {
  const arrivals = state.deliveries
    .filter((d) => d.status === "OUTBOUND" && d.purpose.kind === "CONTRACT_INSTALLMENT" && d.purpose.contractId === contract.id)
    .map((d) => {
      const trip = state.vehicles.find((v) => v.trip?.deliveryId === d.id && v.trip.leg === "OUTBOUND")?.trip;
      if (!trip) throw new RangeError(`Snapshot: outbound delivery ${d.id} has no vehicle on its way`);
      return { id: d.id, arrivesAt: trip.arrivesAt, cases: d.cargo.reduce((n, l) => n + l.quantity, 0) };
    })
    .sort((a, b) => a.arrivesAt - b.arrivesAt || compareIds(a.id, b.id));
  let projected: readonly Installment[] = contract.installments;
  const inTransit = contract.installments.map(() => 0);
  for (const arrival of arrivals) {
    const credit = creditCases(projected, arrival.cases, arrival.arrivesAt);
    projected = projected.map((i, k) => ({ ...i, delivered: i.delivered + credit[k]! }));
    credit.forEach((n, k) => (inTransit[k]! += n));
  }
  return inTransit;
}

function projectContract(state: GameState, contract: ContractState, data: GameData): ContractSnapshot {
  const active = activeReservations(state, contract.id);
  const inTransit = contract.status === "ACTIVE" ? inTransitByInstallment(state, contract) : contract.installments.map(() => 0);
  return {
    id: contract.id,
    buyerId: contract.buyerId,
    buyerName: nameOf(data.buyers, contract.buyerId, "buyer"),
    productId: contract.productId,
    productName: nameOf(data.products, contract.productId, "product"),
    minimumQuality: contract.minimumQuality,
    quantityPerInstallment: contract.quantityPerInstallment,
    unitPrice: contract.unitPrice,
    installmentCount: contract.installmentCount,
    intervalTicks: contract.intervalTicks,
    penaltyRatePpm: contract.penaltyRatePpm,
    status: contract.status,
    installments: contract.installments.map((i, index) => ({
      index,
      deadline: i.deadline,
      required: i.required,
      delivered: i.delivered,
      inTransit: inTransit[index]!,
      outcome: i.outcome,
      penalty: i.penalty,
    })),
    reservationIds: active.map((r) => r.id),
    reservedQuantity: active.reduce((n, r) => n + r.quantity, 0),
  };
}

const lastDeadline = (c: ContractState): number => c.installments.at(-1)?.deadline ?? 0;

export function projectContracts(state: GameState, data: GameData): ContractsSnapshot {
  const nextTick = tick(state.tick + 1);
  const offers = state.contractOffers.map(
    (o): ContractOfferSnapshot => ({
      ...o,
      buyerName: nameOf(data.buyers, o.buyerId, "buyer"),
      productName: nameOf(data.products, o.productId, "product"),
      blockedBy: acceptRejection(state, data, o.id, nextTick),
    }),
  );
  const active = state.contracts.filter((c) => c.status === "ACTIVE").map((c) => projectContract(state, c, data));
  const closed = state.contracts
    .filter((c) => c.status === "COMPLETED")
    .sort((a, b) => lastDeadline(b) - lastDeadline(a) || compareIds(b.id, a.id))
    .map((c) => projectContract(state, c, data));
  return { offers, active, closed };
}
