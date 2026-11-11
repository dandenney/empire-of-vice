// Scripted runs for the end-screen and activity specs (#136), played in the
// browser through the test hook (`window.__eov.dispatchRaw` and `advance`).
//
// Victory: the economy lab's contract taker plays a headless new game in
// Node, and every command it sends is recorded with the tick it was sent on.
// The simulation is deterministic and the browser's new game is the same
// scenario, so replaying those commands at those ticks reaches the same
// victory through the real worker and gateway. The lab only plans the run;
// the browser plays it. (T06c, #137, covers a campaign through the UI.)
//
// Loss: sell the copper still, then buy it back and sell it again while cash
// allows. Each round loses the gap between price and resale; once the cash
// can't rebuy the still and a run, midnight finds the family insolvent
// (ADR 0020 decision 10), with some cash still in hand.

import { TICKS_PER_DAY, type CommandResult, type GameCommand, type GameEvent, type GameSnapshot } from "@eov/contracts";
import { GAME_DATA } from "@eov/game-data";
import { newGame as newHeadlessGame } from "@eov/simulation";
import { expect, type Page } from "@playwright/test";
import { createStrategy } from "../../../../tools/economy-lab/src/index.ts";

export const snapshot = async (page: Page): Promise<GameSnapshot> => (await page.evaluate(() => window.__eov!.snapshot))!;

export async function advance(page: Page, ticks: number): Promise<void> {
  if (ticks > 0) await page.evaluate((n) => window.__eov!.advance(n), ticks);
}

export async function advanceTo(page: Page, at: number): Promise<void> {
  await advance(page, at - (await snapshot(page)).clock.tick);
}

export async function dispatch(page: Page, command: GameCommand, status: CommandResult["status"] = "applied"): Promise<void> {
  const outcome = await page.evaluate((r) => window.__eov!.dispatchRaw(r), { command });
  expect(outcome, JSON.stringify(command)).toMatchObject({ kind: "result", result: { status } });
}

export async function newGame(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByTestId("new-game").click();
  await expect(page.getByTestId("panel-dashboard")).toBeVisible();
}

export interface PlanStep {
  readonly tick: number;
  readonly command: GameCommand;
  readonly status: CommandResult["status"];
}

export interface VictoryPlan {
  readonly steps: readonly PlanStep[];
  /** Every event the headless run produced, for picking where to stop. */
  readonly events: readonly GameEvent[];
  readonly victoryTick: number;
}

/** Plays the contract taker headlessly to victory and records its commands. */
export function planVictory(maxDays = 40): VictoryPlan {
  const sim = newHeadlessGame();
  const bot = createStrategy("contract-taker", sim.snapshot(), GAME_DATA);
  const steps: PlanStep[] = [];
  const events: GameEvent[] = [];
  const gateway = {
    dispatch(request: { readonly command: GameCommand }) {
      const result = sim.dispatch(request);
      steps.push({ tick: sim.snapshot().clock.tick, command: request.command, status: result.status });
      return result;
    },
    snapshot: () => sim.snapshot(),
  };
  for (;;) {
    bot.act(gateway);
    events.push(...sim.takeEvents());
    const s = sim.snapshot();
    if (s.outcome.status === "WON") return { steps, events, victoryTick: s.outcome.tick };
    if (s.outcome.status === "LOST" || s.clock.tick >= maxDays * TICKS_PER_DAY) throw new Error(`No victory to replay: ${JSON.stringify(s.outcome)} at tick ${s.clock.tick}`);
    const now = s.clock.tick;
    let next = (Math.floor(now / TICKS_PER_DAY) + 1) * TICKS_PER_DAY;
    for (const job of s.productionJobs) if (job.completesAt > now) next = Math.min(next, job.completesAt);
    for (const v of s.vehicles) if (v.trip && v.trip.arrivesAt > now) next = Math.min(next, v.trip.arrivesAt);
    for (const t of bot.wakeTicks(s)) if (t > now) next = Math.min(next, t);
    sim.advance(next - now);
  }
}

/** Replays the plan's commands sent on or before `until`, then advances to `until`. */
export async function replay(page: Page, plan: VictoryPlan, until: number): Promise<void> {
  for (const step of plan.steps) {
    if (step.tick > until) break;
    await advanceTo(page, step.tick);
    await dispatch(page, step.command, step.status);
  }
  await advanceTo(page, until);
}

/** Drains cash by selling and rebuying the still, then runs to midnight: GAME_LOST. */
export async function playToLoss(page: Page): Promise<void> {
  const start = await snapshot(page);
  const facility = start.facilities[0]!;
  // The still: owned, or (already sold) the unblocked option to buy it back.
  const stillId = facility.equipment[0]?.id ?? facility.equipmentOptions.find((o) => o.blockedBy === null)!.equipmentId;
  const sell: GameCommand = { type: "SELL_EQUIPMENT", facilityId: facility.id, equipmentId: stillId };
  const buy: GameCommand = { type: "PURCHASE_EQUIPMENT", facilityId: facility.id, equipmentId: stillId };
  if (facility.equipment.some((e) => e.id === stillId)) await dispatch(page, sell);
  for (;;) {
    const s = await snapshot(page);
    const price = s.facilities[0]!.equipmentOptions.find((o) => o.equipmentId === stillId)!.price;
    if (s.finance.cash < price) break;
    await dispatch(page, buy);
    await dispatch(page, sell);
  }
  await advanceTo(page, (Math.floor((await snapshot(page)).clock.tick / TICKS_PER_DAY) + 1) * TICKS_PER_DAY);
}
