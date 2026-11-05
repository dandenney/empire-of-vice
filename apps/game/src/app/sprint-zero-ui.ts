// S0 stub: replaced by T04a (React panels, Zustand UI state, the speed scheduler).
//
// Plain buttons for every step of the Sprint Zero path, plus a status readout,
// all rendered from the latest snapshot:
//
//   New game → Buy ingredients → Produce one case → Advance N ticks →
//   Dispatch truck → Advance N ticks (deliver, sell, return) → Save → Reload save
//
// Every command's inputs (IDs, quantities, the buyer's quote) are read from the
// snapshot when the button is clicked; the UI keeps no game values of its own.
// Styling is PLACEHOLDER: the visual design is the human's call.

import { formatMoney, type CommandRequest, type GameEvent, type GameSnapshot, type RejectionReason } from "@eov/contracts";
import { renderMap, type SceneShape } from "../map/placeholder-map.ts";
import type { DispatchOutcome, GatewayClient, GatewayView } from "../state/gateway-client.ts";

const SAVE_SLOT = "sprint-zero";
const EVENT_LOG_LENGTH = 12;

export interface SprintZeroUi {
  /** The shapes last drawn on the placeholder map. */
  readonly scene: () => readonly SceneShape[];
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { testId?: string } = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const { testId, ...rest } = props;
  const node = Object.assign(document.createElement(tag), rest);
  if (testId) node.dataset["testid"] = testId;
  node.append(...children);
  return node;
}

const describeReason = (reason: RejectionReason): string => {
  const { code, ...details } = reason;
  const parts = Object.entries(details).map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
  return parts.length > 0 ? `${code} (${parts.join(", ")})` : code;
};

const pad2 = (n: number): string => String(n).padStart(2, "0");

// ---------------------------------------------------------------------------
// Commands built from the snapshot
// ---------------------------------------------------------------------------

function distilleryOf(s: GameSnapshot) {
  return s.facilities.find((f) => f.kind === "DISTILLERY") ?? null;
}

/** One case's worth of each input of the distillery's first recipe, from the supplier that sells it. */
function buyIngredientRequests(s: GameSnapshot): CommandRequest[] | string {
  const facility = distilleryOf(s);
  const recipe = facility?.recipes[0];
  if (!facility || !recipe) return "No distillery recipe";
  const requests: CommandRequest[] = [];
  for (const input of recipe.inputsPerCase) {
    const supplier = s.market.suppliers.find((sup) => sup.materials.some((m) => m.materialId === input.materialId));
    if (!supplier) return `No supplier sells ${input.materialId}`;
    requests.push({
      command: { type: "PURCHASE_MATERIALS", supplierId: supplier.id, materialId: input.materialId, quantity: input.quantity, facilityId: facility.id },
    });
  }
  return requests;
}

function produceRequest(s: GameSnapshot): CommandRequest | string {
  const facility = distilleryOf(s);
  const recipe = facility?.recipes[0];
  if (!facility || !recipe) return "No distillery recipe";
  return { command: { type: "START_PRODUCTION", facilityId: facility.id, recipeId: recipe.recipeId, quantity: 1 } };
}

/** One case to the chosen buyer at today's quote (ADR 0005: the deal is struck at dispatch). */
function dispatchRequest(s: GameSnapshot, buyerId: string): CommandRequest | string {
  const facility = distilleryOf(s);
  const pool = facility?.products.find((p) => p.quantity - p.reservedQuantity >= 1);
  if (!pool) return "No case in stock";
  const vehicle = s.vehicles.find((v) => v.trip === null);
  if (!vehicle) return "No idle truck";
  const buyer = s.market.buyers.find((b) => b.id === buyerId);
  const want = buyer?.wants.find((w) => w.productId === pool.productId);
  if (!buyer || !want) return "That buyer doesn't want this product";
  return {
    command: {
      type: "DISPATCH_DELIVERY",
      vehicleId: vehicle.id,
      cargo: [{ productId: pool.productId, quality: pool.quality, quantity: 1 }],
      purpose: { kind: "SALE", buyerId: buyer.id, agreedUnitPrice: want.unitPrice },
      routeId: null,
    },
  };
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

export function mountSprintZeroUi(root: HTMLElement, gateway: GatewayClient, options: { readonly showStateHash: boolean }): SprintZeroUi {
  let scene: readonly SceneShape[] = [];
  const eventLog: string[] = [];

  const message = h("p", { testId: "message" }, "Start a new game, or reload a save.");
  const say = (text: string): void => {
    message.textContent = text;
  };

  const run = (action: () => Promise<void>) => async () => {
    buttons.forEach((b) => (b.disabled = true));
    try {
      await action();
    } catch (error) {
      say(`Error: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      render(gateway.view);
    }
  };

  const report = (outcome: DispatchOutcome, what: string): boolean => {
    if (outcome.kind === "invalid") {
      say(`${what}: invalid request (${outcome.issues.join("; ")})`);
      return false;
    }
    const { result } = outcome;
    if (result.status === "rejected") {
      say(`${what}: rejected, ${describeReason(result.reason)}`);
      return false;
    }
    say(`${what}: ${result.status}`);
    return true;
  };

  const snapshotOrThrow = (): GameSnapshot => {
    const s = gateway.view.snapshot;
    if (!s) throw new Error("No game is running");
    return s;
  };

  const ticksInput = h("input", { type: "number", min: "1", step: "1", value: "1", testId: "ticks" });
  ticksInput.setAttribute("aria-label", "Ticks to advance");
  const buyerSelect = h("select", { testId: "buyer" });
  buyerSelect.setAttribute("aria-label", "Buyer");

  const newGameButton = h("button", { textContent: "New game", testId: "new-game" });
  const buyButton = h("button", { textContent: "Buy ingredients", testId: "buy" });
  const produceButton = h("button", { textContent: "Produce one case", testId: "produce" });
  const advanceButton = h("button", { textContent: "Advance N ticks", testId: "advance" });
  const dispatchButton = h("button", { textContent: "Dispatch truck", testId: "dispatch" });
  const saveButton = h("button", { textContent: "Save", testId: "save" });
  const reloadButton = h("button", { textContent: "Reload save", testId: "reload" });
  const buttons = [newGameButton, buyButton, produceButton, advanceButton, dispatchButton, saveButton, reloadButton];

  newGameButton.onclick = run(async () => {
    await gateway.newGame();
    eventLog.length = 0;
    say("New game started.");
  });
  buyButton.onclick = run(async () => {
    const requests = buyIngredientRequests(snapshotOrThrow());
    if (typeof requests === "string") return say(requests);
    for (const request of requests) {
      if (!report(await gateway.dispatch(request), "Buy ingredients")) return;
    }
  });
  produceButton.onclick = run(async () => {
    const request = produceRequest(snapshotOrThrow());
    if (typeof request === "string") return say(request);
    report(await gateway.dispatch(request), "Produce one case");
  });
  advanceButton.onclick = run(async () => {
    const ticks = Number(ticksInput.value);
    if (!Number.isSafeInteger(ticks) || ticks < 1) return say("Advance: enter a whole number of ticks, 1 or more");
    await gateway.advance(ticks);
    say(`Advanced ${ticks} ticks.`);
  });
  dispatchButton.onclick = run(async () => {
    const request = dispatchRequest(snapshotOrThrow(), buyerSelect.value);
    if (typeof request === "string") return say(request);
    report(await gateway.dispatch(request), "Dispatch truck");
  });
  saveButton.onclick = run(async () => {
    await gateway.save(SAVE_SLOT, "Sprint Zero");
    say("Saved.");
  });
  reloadButton.onclick = run(async () => {
    const loaded = await gateway.load(SAVE_SLOT);
    eventLog.length = 0;
    say(loaded.ok ? "Save reloaded." : `Reload failed: ${loaded.error.code}`);
  });

  const status = h("dl", { testId: "status" });
  const inventory = h("ul", { testId: "inventory" });
  const events = h("ol", { testId: "events" });
  const map = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  map.dataset["testid"] = "map";
  map.setAttribute("width", "640");
  map.setAttribute("role", "img");
  map.setAttribute("aria-label", "Placeholder map");

  root.replaceChildren(
    h("h1", {}, "Empire of Vice: Sprint Zero (placeholder UI)"),
    h(
      "div",
      { className: "controls" },
      newGameButton,
      buyButton,
      produceButton,
      ticksInput,
      advanceButton,
      buyerSelect,
      dispatchButton,
      saveButton,
      reloadButton,
    ),
    message,
    map,
    h("h2", {}, "Status"),
    status,
    h("h2", {}, "Inventory"),
    inventory,
    h("h2", {}, "Events"),
    events,
  );

  const row = (label: string, value: string, testId: string): Node[] => [h("dt", {}, label), h("dd", { testId }, value)];

  function render(view: GatewayView): void {
    const s = view.snapshot;
    newGameButton.disabled = false;
    reloadButton.disabled = false;
    if (!s) {
      for (const b of [buyButton, produceButton, advanceButton, dispatchButton, saveButton]) b.disabled = true;
      return;
    }
    const facility = distilleryOf(s);
    const recipe = facility?.recipes[0] ?? null;
    buyButton.disabled = false;
    // blockedBy is the reason the handler would reject (ADR 0007); the UI only shows it.
    produceButton.disabled = recipe === null || recipe.blockedBy !== null;
    produceButton.title = recipe?.blockedBy ? describeReason(recipe.blockedBy) : "";
    advanceButton.disabled = false;
    dispatchButton.disabled = false;
    saveButton.disabled = false;

    const chosen = buyerSelect.value;
    buyerSelect.replaceChildren(
      ...s.market.buyers.map((b) => {
        const want = b.wants[0];
        const label = want ? `${b.name}: ${formatMoney(want.unitPrice)}/case, takes ${want.maxAcceptableQuantity}` : b.name;
        return h("option", { value: b.id, textContent: label });
      }),
    );
    if (s.market.buyers.some((b) => b.id === chosen)) buyerSelect.value = chosen;

    const d = s.clock.date;
    const profit = s.finance.toDate.profit;
    const job = s.productionJobs[0];
    const truck = s.vehicles[0];
    const truckStatus = !truck
      ? "none"
      : truck.trip
        ? `${truck.trip.leg === "OUTBOUND" ? "out" : "returning"} on ${truck.trip.routeId}, arrives tick ${truck.trip.arrivesAt}`
        : "parked at home";
    status.replaceChildren(
      ...row("Date", `${d.year}-${pad2(d.month)}-${pad2(d.day)} ${pad2(d.hour)}:${pad2(d.minute)} (day ${s.clock.dayIndex})`, "date"),
      ...row("Tick", String(s.clock.tick), "tick"),
      ...row("Cash", formatMoney(s.finance.cash), "cash"),
      ...row("Net worth", formatMoney(s.finance.netWorth), "net-worth"),
      ...row("Revenue to date", formatMoney(profit.revenue), "revenue"),
      ...row("Cost of goods sold", formatMoney(profit.costOfGoodsSold), "cogs"),
      ...row("Net profit to date", formatMoney(profit.netProfit), "profit"),
      ...row("Production", job ? `${job.quantity} case(s), completes tick ${job.completesAt}` : "idle", "production"),
      ...row("Truck", truckStatus, "truck"),
      ...(options.showStateHash && view.stateHash ? row("State hash", view.stateHash, "state-hash") : []),
    );
    inventory.replaceChildren(
      ...(facility?.materials ?? []).map((m) => h("li", {}, `${m.materialName}: ${m.quantity} (${m.reservedQuantity} reserved)`)),
      ...(facility?.products ?? []).map((p) => h("li", {}, `${p.productName} (${p.quality}): ${p.quantity} case(s), ${formatMoney(p.averageUnitCost)} each`)),
    );
    events.replaceChildren(...eventLog.slice(-EVENT_LOG_LENGTH).map((line) => h("li", {}, line)));
    scene = renderMap(map, s);
  }

  gateway.onEvents((batch: readonly GameEvent[], importance) => {
    for (const e of batch) eventLog.push(`tick ${e.tick}: ${e.type}${importance === "notify" ? " (!)" : ""}`);
  });
  gateway.onSnapshot(render);
  render(gateway.view);

  return { scene: () => scene };
}
