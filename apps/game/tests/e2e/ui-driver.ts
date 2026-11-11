// Plays game commands through the real panels (T06c, #137): each command a
// headless plan sends is entered in the panel a player would use (Market,
// Production, Contracts, Facility) and sent with that panel's button. Time
// moves only through the test hook's `advance`, which runs exactly the ticks
// asked for, so a plan replayed here reaches the same state as the headless
// run that recorded it.
//
// Every command waits for its own result: the state hash moves, and the panel
// shows it (the form's result line reads "Done.", or the accepted offer or
// bought equipment moves to its new place).

import { formatMoney, qualityRank, type GameCommand, type GameSnapshot } from "@eov/contracts";
import { newGame as newHeadlessGame } from "@eov/simulation";
import { expect, type Page } from "@playwright/test";
import { advanceTo, snapshot, type PlanStep, type VictoryPlan } from "../end-screen/campaign.ts";

export const DONE = "Done.";

export const stateHash = (page: Page): Promise<string | null> => page.evaluate(() => window.__eov?.stateHash ?? null);

/** Opens a panel from the icon rail, unless it's already open. */
export async function openPanel(page: Page, id: string): Promise<void> {
  const button = page.getByTestId(`open-${id}`);
  if ((await button.getAttribute("aria-pressed")) !== "true") await button.click();
  await expect(page.getByTestId(`panel-${id}`)).toBeVisible();
}

/** Clicks a game-menu button and waits until the shell is idle again. */
export async function press(page: Page, testId: string): Promise<void> {
  await page.getByTestId(testId).click();
  await expect(page.getByTestId("new-game")).toBeEnabled();
}

/** The want a buyer prices a case at: its highest-minimum want the case meets, as the simulation quotes it. */
function pricingWant(s: GameSnapshot, buyerId: string, productId: string, quality: string) {
  const buyer = s.market.buyers.find((b) => b.id === buyerId)!;
  const fits = buyer.wants.filter((w) => w.productId === productId && qualityRank(w.minimumQuality) <= qualityRank(quality as never));
  return { buyer, want: fits.sort((a, b) => qualityRank(b.minimumQuality) - qualityRank(a.minimumQuality))[0]! };
}

/**
 * Enters one command in its panel and sends it. Returns once the command has
 * applied: the state hash has moved and the panel's result line says so.
 */
export async function sendThroughUi(page: Page, command: GameCommand): Promise<void> {
  const before = await stateHash(page);
  const s = await snapshot(page);
  let result: string | null = null;
  switch (command.type) {
    case "PURCHASE_MATERIALS": {
      await openPanel(page, "market");
      const row = `material-${command.supplierId}-${command.materialId}`;
      await page.getByTestId(`supplier-${command.supplierId}-facility`).selectOption(command.facilityId);
      await page.getByTestId(`${row}-quantity`).fill(String(command.quantity));
      await page.getByTestId(`${row}-buy`).click();
      result = `${row}-result`;
      break;
    }
    case "START_PRODUCTION": {
      await openPanel(page, "production");
      const row = page.getByTestId(`facility-${command.facilityId}`).getByTestId(`recipe-${command.recipeId}`);
      await row.getByTestId(`recipe-${command.recipeId}-quantity`).fill(String(command.quantity));
      await row.getByTestId(`recipe-${command.recipeId}-start`).click();
      await expect(row.getByTestId(`recipe-${command.recipeId}-result`)).toHaveText(DONE);
      break;
    }
    case "DISPATCH_DELIVERY": {
      if (command.cargo.length !== 1) throw new Error(`The panels send one cargo line: ${JSON.stringify(command)}`);
      const line = command.cargo[0]!;
      const purpose = command.purpose;
      if (purpose.kind === "SALE") {
        await openPanel(page, "market");
        const { buyer, want } = pricingWant(s, purpose.buyerId, line.productId, line.quality);
        expect(want.unitPrice, `${buyer.name}'s quote`).toBe(purpose.agreedUnitPrice);
        const form = `sale-${buyer.id}`;
        if (buyer.wants.length > 1) await page.getByTestId(`${form}-want`).selectOption(`${want.productId}:${want.minimumQuality}`);
        await page.getByTestId(`${form}-quality`).selectOption(line.quality);
        await page.getByTestId(`${form}-truck`).selectOption(command.vehicleId);
        await page.getByTestId(`${form}-quantity`).fill(String(line.quantity));
        await pickRoute(page, `${form}-route`, command.routeId);
        await expect(page.getByTestId(`${form}-price`)).toHaveText(formatMoney(purpose.agreedUnitPrice));
        await page.getByTestId(`${form}-dispatch`).click();
        result = `${form}-result`;
      } else if (purpose.kind === "CONTRACT_INSTALLMENT") {
        await openPanel(page, "contracts");
        const form = `deliver-${purpose.contractId}`;
        await page.getByTestId(`${form}-quality`).selectOption(line.quality);
        await page.getByTestId(`${form}-truck`).selectOption(command.vehicleId);
        await page.getByTestId(`${form}-quantity`).fill(String(line.quantity));
        await pickRoute(page, `${form}-route`, command.routeId);
        await page.getByTestId(`${form}-dispatch`).click();
        result = `${form}-result`;
      } else {
        throw new Error(`No panel sends a ${purpose.kind} delivery`);
      }
      break;
    }
    case "ACCEPT_CONTRACT": {
      await openPanel(page, "contracts");
      await page.getByTestId(`offer-${command.contractOfferId}-accept`).click();
      await expect(page.getByTestId(`offer-${command.contractOfferId}`)).toHaveCount(0);
      break;
    }
    case "PURCHASE_EQUIPMENT": {
      await openPanel(page, "facility");
      const option = `option-${command.facilityId}-${command.equipmentId}`;
      await expect(page.getByTestId(`${option}-blocked`)).toHaveCount(0);
      await page.getByTestId(`${option}-buy`).click();
      await expect(page.getByTestId(`equipment-${command.facilityId}-${command.equipmentId}-book`)).toBeVisible();
      break;
    }
    case "SET_WORKFORCE": {
      await openPanel(page, "facility");
      const w = `facility-${command.facilityId}-workforce`;
      await page.getByTestId(`${w}-input`).fill(String(command.workerCount));
      await page.getByTestId(`${w}-set`).click();
      result = `${w}-result`;
      break;
    }
    default:
      throw new Error(`No panel step for ${command.type}`);
  }
  if (result !== null) await expect(page.getByTestId(result)).toHaveText(DONE);
  await expect.poll(() => stateHash(page), { message: `${command.type} applied` }).not.toBe(before);
}

/** Picks a route in a route picker: the default (Safe) one for null, else the named one. */
async function pickRoute(page: Page, picker: string, routeId: string | null): Promise<void> {
  if (routeId === null) {
    const checked = page.locator(`label[data-testid^="${picker}-"][data-checked="true"]`);
    await expect(checked.locator(".route-badge[data-safety]")).toHaveText("Safe");
    return;
  }
  await page.getByTestId(`${picker}-${routeId}`).click();
  await expect(page.getByTestId(`${picker}-${routeId}-radio`)).toBeChecked();
}

/**
 * Plays a plan in order and keeps its place, across page reloads too: through
 * the panels, or (to get somewhere quickly) straight through the test hook.
 */
export class PlanPlayer {
  #next = 0;

  constructor(
    readonly page: Page,
    readonly plan: VictoryPlan,
  ) {}

  /** Sends the plan's next `count` steps through the panels, advancing to each one's tick. */
  async next(count: number): Promise<void> {
    for (let i = 0; i < count; i++) {
      const step = this.plan.steps[this.#next++];
      if (!step) throw new Error("The plan is done");
      await this.#sendThroughUi(step);
    }
  }

  async #sendThroughUi(step: PlanStep): Promise<void> {
    await advanceTo(this.page, step.tick);
    expect((await snapshot(this.page)).clock.tick).toBe(step.tick);
    expect(step.status, JSON.stringify(step.command)).toBe("applied");
    await sendThroughUi(this.page, step.command);
  }

  /** Sends the plan's steps on or before `until` (before it, with `exclusive`) through the panels, then advances to `until`. */
  async throughUi(until: number, { exclusive = false } = {}): Promise<void> {
    for (const step of this.#take(until, exclusive)) await this.#sendThroughUi(step);
    await advanceTo(this.page, until);
  }

  /** Sends the plan's steps before `until` straight through the test hook (no panels), then advances to `until`. */
  async throughHook(until: number): Promise<void> {
    for (const step of this.#take(until, true)) {
      await advanceTo(this.page, step.tick);
      const outcome = await this.page.evaluate((r) => window.__eov!.dispatchRaw(r), { command: step.command });
      expect(outcome, JSON.stringify(step.command)).toMatchObject({ kind: "result", result: { status: step.status } });
    }
    await advanceTo(this.page, until);
  }

  /** The next unsent step, or null once the plan is done. */
  peek(): PlanStep | null {
    return this.plan.steps[this.#next] ?? null;
  }

  *#take(until: number, exclusive: boolean): Generator<PlanStep> {
    for (;;) {
      const step = this.plan.steps[this.#next];
      if (!step || (exclusive ? step.tick >= until : step.tick > until)) return;
      this.#next++;
      yield step;
    }
  }
}

/** The headless run's state hash at `tick`: the plan's commands replayed in Node. */
export function headlessHashAt(plan: VictoryPlan, tick: number): string {
  const sim = newHeadlessGame();
  for (const step of plan.steps) {
    if (step.tick > tick) break;
    if (step.tick > sim.snapshot().clock.tick) sim.advance(step.tick - sim.snapshot().clock.tick);
    sim.dispatch({ command: step.command });
  }
  if (tick > sim.snapshot().clock.tick) sim.advance(tick - sim.snapshot().clock.tick);
  return sim.stateHash();
}
