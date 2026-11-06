// The contracts system (T02e, issue #9; GDD §7 ECO-001; ADR 0018).
//
// - ACCEPT_CONTRACT (decision 3): OFFER_UNAVAILABLE, LOCKED, REPUTATION_TOO_LOW
//   in that order, judged at the tick being processed. On success one RESERVATION
//   transaction (no entries) keyed `RESERVATION:<contractId>:ACCEPT` turns the
//   offer into an ACTIVE contract and reserves stock for its first installment.
// - CONTRACT_OFFER world event (decision 2): offers to the named buyer if it's
//   eligible; does nothing on a midnight tick (that tick's midnight hook offers).
// - Deadlines phase (decision 7): each ACTIVE contract in ID order settles its
//   due installments in index order, each in its own INSTALLMENT_SETTLEMENT
//   transaction keyed by (contract, index). Arrivals run earlier in the tick, so
//   an arrival on the deadline tick counts as on time.
// - Midnight (decisions 2 and 8), after market and production: expire offers,
//   pay down PENALTIES_PAYABLE, then make new offers.
//
// Dispatch and arrival of installment cargo live in logistics (decision 12) and
// use rules.ts. Contracts draw no random numbers (decision 13).

import {
  cents,
  compareById,
  dayIndex,
  idempotencyKey,
  type ContractId,
  type ContractOfferId,
  type GameState,
  type TransactionCoordinator,
  type TransactionDraft,
} from "@eov/contracts";
import type { ContractBuyerDefinition, GameData } from "@eov/game-data";
import { cashBalance, ledgerBalances } from "../economy/ledger/ledger.ts";
import { payDownEntries, payOrAccrueEntries } from "../economy/ledger/postings.ts";
import { releaseContractReservations } from "../inventory/pools.ts";
import { allocateId, formatId } from "../kernel/ids.ts";
import type { SystemRegistry, TickContext } from "../kernel/registry.ts";
import {
  acceptRejection,
  buildOffer,
  contractBuyer,
  contractBuyers,
  contractFromOffer,
  installmentOutcome,
  installmentPenalty,
  offerEligible,
  reserveForCurrentInstallment,
  withContract,
} from "./rules.ts";

function commitOrThrow(tx: TransactionDraft, what: string): GameState {
  const result = tx.commit();
  if (result.status !== "committed") throw new Error(`${what} was rejected: ${JSON.stringify(result.reason)}`);
  return result.state;
}

/** A buyer's offer, in a no-entry DAILY_SETTLEMENT keyed by buyer and tick. */
function makeOffer(state: GameState, def: ContractBuyerDefinition, data: GameData, coordinator: TransactionCoordinator, ctx: TickContext): GameState {
  const tx = coordinator.begin(state, {
    kind: "DAILY_SETTLEMENT",
    idempotencyKey: idempotencyKey("DAILY_SETTLEMENT", "CONTRACT_OFFER", def.buyerId, ctx.tick),
    tick: ctx.tick,
    causedBy: null,
  });
  if (tx.status === "duplicate") return state;
  const id = formatId("ContractOffer", tx.state.counters.nextId.ContractOffer);
  const offer = buildOffer(tx.state, data, def, id, ctx.tick);
  tx.update((s) => {
    const minted = allocateId(s, "ContractOffer").state;
    return { ...minted, contractOffers: [...minted.contractOffers, offer].sort(compareById) };
  });
  tx.emit({ type: "CONTRACT_OFFERED", contractOfferId: id, buyerId: def.buyerId, expiresAt: offer.expiresAt });
  return commitOrThrow(tx, `Contract offer from ${def.buyerId}`);
}

function expireOffer(state: GameState, offerId: ContractOfferId, coordinator: TransactionCoordinator, ctx: TickContext): GameState {
  const tx = coordinator.begin(state, {
    kind: "DAILY_SETTLEMENT",
    idempotencyKey: idempotencyKey("DAILY_SETTLEMENT", "CONTRACT_OFFER_EXPIRED", offerId),
    tick: ctx.tick,
    causedBy: null,
  });
  if (tx.status === "duplicate") return state;
  tx.update((s) => ({ ...s, contractOffers: s.contractOffers.filter((o) => o.id !== offerId) }));
  tx.emit({ type: "CONTRACT_OFFER_EXPIRED", contractOfferId: offerId });
  return commitOrThrow(tx, `Expiry of ${offerId}`);
}

/** Pays what cash allows of PENALTIES_PAYABLE, keyed by the day that just ended; skipped at 0 (decision 8). */
function payDownPenalties(state: GameState, coordinator: TransactionCoordinator, ctx: TickContext): GameState {
  const owed = ledgerBalances(state.ledger.transactions).PENALTIES_PAYABLE;
  const cash = cashBalance(state);
  const amount = Math.max(0, Math.min(owed, cash));
  if (amount === 0) return state;
  const tx = coordinator.begin(state, {
    kind: "DAILY_SETTLEMENT",
    idempotencyKey: idempotencyKey("DAILY_SETTLEMENT", "PENALTIES", dayIndex(ctx.tick) - 1),
    tick: ctx.tick,
    causedBy: null,
  });
  if (tx.status === "duplicate") return state;
  tx.post(payDownEntries(cents(amount), "PENALTIES_PAYABLE"));
  return commitOrThrow(tx, "Penalty paydown");
}

function runMidnight(state: GameState, data: GameData, coordinator: TransactionCoordinator, ctx: TickContext): GameState {
  let s = state;
  for (const offer of state.contractOffers) {
    if (offer.expiresAt <= ctx.tick) s = expireOffer(s, offer.id, coordinator, ctx);
  }
  s = payDownPenalties(s, coordinator, ctx);
  for (const def of contractBuyers(data)) {
    if (offerEligible(s, data, def.buyerId)) s = makeOffer(s, def, data, coordinator, ctx);
  }
  return s;
}

/** Settles installment `index` of a contract (decision 7), in its own keyed transaction. */
function settleInstallment(
  state: GameState,
  contractId: ContractId,
  index: number,
  coordinator: TransactionCoordinator,
  ctx: TickContext,
): GameState {
  const tx = coordinator.begin(state, {
    kind: "INSTALLMENT_SETTLEMENT",
    idempotencyKey: idempotencyKey("INSTALLMENT_SETTLEMENT", contractId, index),
    tick: ctx.tick,
    causedBy: null,
  });
  if (tx.status === "duplicate") return state;

  const contract = tx.state.contracts.find((c) => c.id === contractId)!;
  const installment = contract.installments[index]!;
  const outcome = installmentOutcome(installment.required, installment.delivered);
  const penalty = installmentPenalty(contract, installment);
  if (penalty > 0) {
    tx.post(payOrAccrueEntries({ amount: penalty, expense: "PENALTY_EXPENSE", payable: "PENALTIES_PAYABLE", cashAvailable: cashBalance(tx.state) }));
  }
  const installments = contract.installments.map((i, k) => (k === index ? { ...i, outcome, penalty } : i));
  const settled = { ...contract, installments };
  tx.update((s) => withContract(s, settled));
  tx.emit({
    type: "INSTALLMENT_SETTLED",
    contractId,
    installmentIndex: index,
    required: installment.required,
    delivered: installment.delivered,
    outcome,
    penalty,
    transactionId: tx.transactionId,
  });

  if (installments.every((i) => i.outcome !== null)) {
    // The final installment: the contract ends, and what it still holds is released.
    const ended = releaseContractReservations(withContract(tx.state, { ...settled, status: "COMPLETED" }), contractId);
    tx.update(() => ended.state);
    for (const reservationId of ended.released) tx.emit({ type: "RESERVATION_RELEASED", reservationId, reason: "CONTRACT_ENDED" });
    tx.emit({ type: "CONTRACT_COMPLETED", contractId, outcomes: installments.map((i) => i.outcome!) });
  } else {
    const topUp = reserveForCurrentInstallment(tx.state, contractId);
    tx.update(() => topUp.state);
  }
  return commitOrThrow(tx, `Settlement of ${contractId} installment ${index}`);
}

function settleDue(state: GameState, coordinator: TransactionCoordinator, ctx: TickContext): GameState {
  let s = state;
  for (const { id } of state.contracts) {
    const contract = s.contracts.find((c) => c.id === id)!;
    if (contract.status !== "ACTIVE") continue;
    contract.installments.forEach((i, k) => {
      if (i.outcome === null && i.deadline <= ctx.tick) s = settleInstallment(s, id, k, coordinator, ctx);
    });
  }
  return s;
}

export function registerContracts(registry: SystemRegistry, data: GameData, coordinator: TransactionCoordinator): void {
  registry.onCommand("ACCEPT_CONTRACT", {
    apply: (state, command, ctx) => {
      const { contractOfferId } = command;
      const rejection = acceptRejection(state, data, contractOfferId, ctx.tick);
      if (rejection) return { status: "rejected", reason: rejection };

      const offer = state.contractOffers.find((o) => o.id === contractOfferId)!;
      const contractId = formatId("Contract", state.counters.nextId.Contract);
      const tx = coordinator.begin(state, {
        kind: "RESERVATION",
        idempotencyKey: idempotencyKey("RESERVATION", contractId, "ACCEPT"),
        tick: ctx.tick,
        causedBy: ctx.envelope.id,
      });
      if (tx.status === "duplicate") return { status: "applied", state };

      tx.update((s) => {
        const minted = allocateId(s, "Contract").state;
        const withoutOffer = { ...minted, contractOffers: minted.contractOffers.filter((o) => o.id !== contractOfferId) };
        return withContract(withoutOffer, contractFromOffer(offer, contractId));
      });
      const reserved = reserveForCurrentInstallment(tx.state, contractId);
      tx.update(() => reserved.state);
      tx.emit({ type: "CONTRACT_ACCEPTED", contractOfferId, contractId, buyerId: offer.buyerId, reservationIds: reserved.created });

      const result = tx.commit();
      return result.status === "committed" ? { status: "applied", state: result.state } : { status: "rejected", reason: result.reason };
    },
  });

  registry.onWorldEvent("CONTRACT_OFFER", (state, event, ctx) => {
    // On a midnight tick the midnight hook makes the offer, after the market sets the day's prices.
    if (ctx.isMidnight) return state;
    const def = contractBuyer(data, event.buyerId);
    if (!def || !offerEligible(state, data, def.buyerId)) return state;
    return makeOffer(state, def, data, coordinator, ctx);
  });

  registry.onPhase("deadlines", "contract-installment-settlement", (state, ctx) => settleDue(state, coordinator, ctx));
  registry.onPhase("midnight", "contract-offers-and-penalties", (state, ctx) => runMidnight(state, data, coordinator, ctx));
}
