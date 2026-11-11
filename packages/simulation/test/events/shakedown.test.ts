// The SHAKEDOWN scheduled world event (T07f, issue #129).

import { cents, gameStateSchema, tick, TICKS_PER_DAY, type EventOfType, type GameState, type LedgerTransaction } from "@eov/contracts";
import { FIRST_SHIPMENT_SCENARIO, GAME_DATA, type ScenarioDefinition, type ScenarioShakedown } from "@eov/game-data";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  balanceSheet,
  cashBalance,
  checkInvariants,
  createInitialState,
  createSimulation,
  journalOf,
  newGame,
  replayJournal,
  ScenarioSetupError,
  simulationOptions,
  type KernelSimulation,
} from "../../src/index.ts";
import { shakedownAssessment } from "../../src/events/shakedown.ts";

/** Before any midnight, so nothing else moves money first: opening cash $1,000, net worth $2,500. */
const AT = 100;
const OPENING_CASH = cents(100_000);
const OPENING_NET_WORTH = cents(250_000);

const shakedown = (netWorthSharePpm: number, patch: Partial<ScenarioShakedown> = {}): ScenarioShakedown => ({
  kind: "SHAKEDOWN",
  tick: tick(AT),
  reason: "RIVAL",
  netWorthSharePpm,
  ...patch,
});

/** The First Shipment with its building pinned at $800, so the sheet these tests assume doesn't move with tuning (#159 set it to $400). */
const scenarioWith = (...events: ScenarioShakedown[]): ScenarioDefinition => ({
  ...FIRST_SHIPMENT_SCENARIO,
  openingBalance: { ...FIRST_SHIPMENT_SCENARIO.openingBalance, buildings: cents(80_000) },
  scheduledEvents: [...FIRST_SHIPMENT_SCENARIO.scheduledEvents, ...events],
});

function runTo(scenario: ScenarioDefinition, at = AT): { sim: KernelSimulation; booked: EventOfType<"LOSS_BOOKED">[] } {
  const sim = newGame({ scenario });
  sim.advance(at);
  const booked = sim.takeEvents().filter((e): e is EventOfType<"LOSS_BOOKED"> => e.type === "LOSS_BOOKED");
  return { sim, booked };
}

const txOf = (state: GameState, id: string): LedgerTransaction => state.ledger.transactions.find((t) => t.id === id)!;

describe("SHAKEDOWN", () => {
  it("starts from the opening sheet the tests assume", () => {
    const state = newGame({ scenario: scenarioWith(shakedown(150_000)) }).state;
    expect(cashBalance(state)).toBe(OPENING_CASH);
    expect(balanceSheet(state).netWorth).toBe(OPENING_NET_WORTH);
    expect(state.scheduledEvents.filter((e) => e.kind === "SHAKEDOWN")).toEqual([
      { kind: "SHAKEDOWN", tick: AT, sequence: 2, reason: "RIVAL", netWorthSharePpm: 150_000 },
    ]);
  });

  it("books exactly netWorth × ppm / 1 000 000 at its tick, as one balanced Dr LOSSES / Cr CASH transaction", () => {
    const sim = newGame({ scenario: scenarioWith(shakedown(150_000)) });
    sim.advance(AT - 1);
    expect(sim.takeEvents().some((e) => e.type === "LOSS_BOOKED")).toBe(false);
    const before = sim.state;
    sim.advance(1);
    const [e, ...rest] = sim.takeEvents().filter((x): x is EventOfType<"LOSS_BOOKED"> => x.type === "LOSS_BOOKED");
    expect(rest).toEqual([]);
    // $2,500 × 15% = $375.
    expect(e).toMatchObject({ tick: AT, causedBy: null, reason: "RIVAL", assessed: cents(37_500), amount: cents(37_500), netWorthBefore: OPENING_NET_WORTH });
    const tx = txOf(sim.state, e!.transactionId);
    expect(tx).toMatchObject({ tick: AT, kind: "LOSS", idempotencyKey: `LOSS:SHAKEDOWN:RIVAL:${AT}:2`, eventIds: [e!.id] });
    expect(tx.entries).toEqual([
      { account: "LOSSES", side: "DEBIT", amount: cents(37_500) },
      { account: "CASH", side: "CREDIT", amount: cents(37_500) },
    ]);
    expect(cashBalance(sim.state)).toBe(cashBalance(before) - 37_500);
    expect(balanceSheet(sim.state).netWorth).toBe(balanceSheet(before).netWorth - 37_500);
    expect(checkInvariants(sim.state, tx)).toEqual([]);
    expect(sim.state.scheduledEvents.some((x) => x.kind === "SHAKEDOWN")).toBe(false);
  });

  it("files the cash it takes on the LOSSES cash flow line, as the income statement does (#159)", () => {
    const { sim } = runTo(scenarioWith(shakedown(150_000)));
    const today = sim.snapshot().finance.today;
    const line = (category: string) => today.cashFlow.lines.find((l) => l.category === category)?.amount;
    expect(line("LOSSES")).toBe(-37_500);
    expect(line("WAGES")).toBe(0);
    expect(today.cashFlow.netChange).toBe(-37_500);
    expect(today.profit.expenses.find((e) => e.category === "LOSSES")?.amount).toBe(37_500);
  });

  it("rounds once, half away from zero, in integer cents", () => {
    // 250 000 × 150 002 / 1 000 000 = 37 500.5 → 37 501; × 333 333 → 83 333.25 → 83 333; × 2 → 0.5 → 1.
    expect(runTo(scenarioWith(shakedown(150_002))).booked[0]!.amount).toBe(37_501);
    expect(runTo(scenarioWith(shakedown(333_333))).booked[0]!.amount).toBe(83_333);
    expect(runTo(scenarioWith(shakedown(2))).booked[0]!.amount).toBe(1);
    for (const [nw, ppm] of [[1, 499_999], [999_999_999, 123_457], [7, 1_000_000]] as const) {
      expect(shakedownAssessment(cents(nw), ppm)).toBe(Math.round((nw * ppm) / 1_000_000));
    }
  });

  it("caps the loss at cash when the share is more than cash", () => {
    // 60% of $2,500 is $1,500, more than the $1,000 cash.
    const { sim, booked } = runTo(scenarioWith(shakedown(600_000, { reason: "POLICE" })));
    expect(booked).toHaveLength(1);
    expect(booked[0]).toMatchObject({ reason: "POLICE", assessed: cents(150_000), amount: OPENING_CASH, netWorthBefore: OPENING_NET_WORTH });
    expect(txOf(sim.state, booked[0]!.transactionId).entries).toEqual([
      { account: "LOSSES", side: "DEBIT", amount: OPENING_CASH },
      { account: "CASH", side: "CREDIT", amount: OPENING_CASH },
    ]);
    expect(cashBalance(sim.state)).toBe(0);
    expect(balanceSheet(sim.state).netWorth).toBe(OPENING_NET_WORTH - OPENING_CASH);
  });

  it("books nothing when there's no cash left, but still reports the event; same-tick shakedowns apply in order", () => {
    const { sim, booked } = runTo(scenarioWith(shakedown(1_000_000), shakedown(150_000)));
    expect(booked.map((e) => [e.assessed, e.amount, e.netWorthBefore])).toEqual([
      [cents(250_000), OPENING_CASH, OPENING_NET_WORTH],
      // Net worth after the first: $1,500; 15% is $225, but cash is gone.
      [cents(22_500), cents(0), cents(150_000)],
    ]);
    const second = txOf(sim.state, booked[1]!.transactionId);
    expect(second.entries).toEqual([]);
    expect(second.eventIds).toEqual([booked[1]!.id]);
    expect(cashBalance(sim.state)).toBe(0);
  });

  it("assesses nothing on a net worth at or below zero", () => {
    expect(shakedownAssessment(cents(0), 150_000)).toBe(0);
    expect(shakedownAssessment(cents(-50_000), 150_000)).toBe(0);
    expect(() => shakedownAssessment(cents(100), 1.5)).toThrow(RangeError);
  });

  it("is a no-op once the game is over", () => {
    const scenario = scenarioWith(shakedown(150_000));
    const state = createInitialState(scenario, GAME_DATA);
    const won: GameState = { ...state, outcome: { status: "WON", tick: tick(0) } };
    const sim = createSimulation(won, simulationOptions({ scenario }));
    const ledger = sim.state.ledger.transactions.length;
    sim.advance(AT);
    expect(sim.takeEvents().some((e) => e.type === "LOSS_BOOKED")).toBe(false);
    expect(sim.state.ledger.transactions).toHaveLength(ledger);
    expect(cashBalance(sim.state)).toBe(OPENING_CASH);
  });

  it("is deterministic: the same scenario gives the same state, and a replay of the run matches", () => {
    const scenario = scenarioWith(shakedown(150_000));
    const a = runTo(scenario, AT + 50).sim;
    const b = runTo(scenario, AT + 50).sim;
    expect(a.stateHash()).toBe(b.stateHash());
    const replayed = newGame({ scenario });
    replayJournal(replayed, journalOf(a.state), a.state.tick);
    expect(replayed.stateHash()).toBe(a.stateHash());
    // Without the shakedown, the run differs only by it.
    expect(runTo(FIRST_SHIPMENT_SCENARIO, AT + 50).sim.stateHash()).not.toBe(a.stateHash());
  });

  it("round-trips through the save schema: scheduled, then booked", () => {
    const scheduled = newGame({ scenario: scenarioWith(shakedown(150_000)) }).state;
    expect(gameStateSchema.parse(JSON.parse(JSON.stringify(scheduled)))).toEqual(scheduled);
    const { sim } = runTo(scenarioWith(shakedown(150_000)));
    expect(sim.state.eventJournal.some((e) => e.type === "LOSS_BOOKED")).toBe(true);
    expect(gameStateSchema.parse(JSON.parse(JSON.stringify(sim.state)))).toEqual(sim.state);
    const bad = { ...scheduled, scheduledEvents: scheduled.scheduledEvents.map((e) => (e.kind === "SHAKEDOWN" ? { ...e, netWorthSharePpm: 1_000_001 } : e)) };
    expect(gameStateSchema.safeParse(bad).success).toBe(false);
  });

  it("checks the scenario's shakedown at load: tick ≥ 1 and a share of 1..1 000 000 ppm", () => {
    const load = (e: ScenarioShakedown) => () => createInitialState(scenarioWith(e), GAME_DATA);
    expect(load(shakedown(0))).toThrow(ScenarioSetupError);
    expect(load(shakedown(1_000_001))).toThrow(ScenarioSetupError);
    expect(load(shakedown(150_000, { tick: tick(0) }))).toThrow(ScenarioSetupError);
    expect(load(shakedown(1))).not.toThrow();
    expect(load(shakedown(1_000_000))).not.toThrow();
  });
});

/** Exact `netWorth × ppm / 1 000 000`, half away from zero, in BigInt: the reference the assessment must match. */
function exactShare(netWorth: number, ppm: number): number {
  if (netWorth <= 0) return 0;
  const n = BigInt(netWorth) * BigInt(ppm);
  const q = n / 1_000_000n;
  return Number(n % 1_000_000n >= 500_000n ? q + 1n : q);
}

describe("SHAKEDOWN properties", () => {
  it("assesses exactly netWorth × ppm / 1 000 000 in integer cents, never more than net worth", () => {
    fc.assert(
      fc.property(fc.integer({ min: -1_000_000_000_000, max: 1_000_000_000_000 }), fc.integer({ min: 0, max: 1_000_000 }), (nw, ppm) => {
        const a = shakedownAssessment(cents(nw), ppm);
        expect(Number.isSafeInteger(a)).toBe(true);
        expect(a).toBe(exactShare(nw, ppm));
        expect(a).toBeGreaterThanOrEqual(0);
        if (nw > 0) expect(a).toBeLessThanOrEqual(nw);
      }),
      { numRuns: 2_000 },
    );
  });

  it("books min(cash, assessment) as one balanced transaction on any tick, share and balance sheet, deterministically", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        // Any tick over the first five days but a midnight, so nothing else moves money on the tick. Midnights
        // before it pay wages and overhead (accruing what cash can't cover), so cash and net worth vary (#159, N2).
        fc.integer({ min: 1, max: 5 * TICKS_PER_DAY - 1 }).filter((t) => t % TICKS_PER_DAY !== 0),
        fc.constantFrom<ScenarioShakedown["reason"]>("RIVAL", "POLICE"),
        // The opening balance sheet: from no cash at all to well past the First Shipment's.
        fc.integer({ min: 0, max: 5_000_000 }),
        fc.integer({ min: 0, max: 500_000 }),
        (ppm, at, reason, cash0, buildings) => {
          const base = scenarioWith(shakedown(ppm, { tick: tick(at), reason }));
          const scenario: ScenarioDefinition = { ...base, openingBalance: { cash: cents(cash0), buildings: cents(buildings) } };
          const run = () => {
            const sim = newGame({ scenario });
            sim.advance(at - 1);
            sim.takeEvents();
            const before = sim.state;
            sim.advance(1);
            return { sim, before, events: sim.takeEvents() };
          };
          const { sim, before, events } = run();
          const booked = events.filter((e): e is EventOfType<"LOSS_BOOKED"> => e.type === "LOSS_BOOKED");
          if (before.outcome.status !== "PLAYING") {
            // The game ended first (insolvent at a midnight): a no-op, with no transaction.
            expect(booked).toEqual([]);
            expect(sim.state.ledger.transactions.length).toBe(before.ledger.transactions.length);
            return;
          }
          expect(booked).toHaveLength(1);
          const e = booked[0]!;
          const nw = balanceSheet(before).netWorth;
          const cash = cashBalance(before);
          const assessed = exactShare(nw, ppm);
          expect(e).toMatchObject({ tick: at, reason, assessed, amount: Math.min(cash, assessed), netWorthBefore: nw });
          const tx = txOf(sim.state, e.transactionId);
          expect(tx.entries).toEqual(
            e.amount === 0
              ? []
              : [
                  { account: "LOSSES", side: "DEBIT", amount: e.amount },
                  { account: "CASH", side: "CREDIT", amount: e.amount },
                ],
          );
          // Exactly one transaction was added, and nothing else moved: cash and net worth fall by the amount.
          expect(sim.state.ledger.transactions.length).toBe(before.ledger.transactions.length + 1);
          expect(cashBalance(sim.state)).toBe(cash - e.amount);
          expect(cashBalance(sim.state)).toBeGreaterThanOrEqual(0);
          expect(balanceSheet(sim.state).netWorth).toBe(nw - e.amount);
          expect(checkInvariants(sim.state, tx)).toEqual([]);
          // Its cash is on the LOSSES cash flow line (#159); nothing else posts to LOSSES here.
          expect(sim.snapshot().finance.today.cashFlow.lines.find((l) => l.category === "LOSSES")?.amount).toBe(e.amount === 0 ? 0 : -e.amount);
          // Same inputs, same state.
          expect(run().sim.stateHash()).toBe(sim.stateHash());
        },
      ),
      { numRuns: 60 },
    );
  });
});
