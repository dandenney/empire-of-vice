// The save migration chain (ADR 0009).
//
// SAVE_SCHEMA_VERSION goes up by one for any change to SaveGame or GameState,
// and every bump adds a SaveMigration from n to n + 1 to SAVE_MIGRATIONS, with
// a fixture save at the old version under fixtures/ (test/fixtures.test.ts
// loads every one). Migrations work on raw JSON, are pure, and never read
// game-data. The result is validated against the current schema by the caller
// (save-file.ts), never trusted.
//
// Each step writes its new fields as frozen literals, never from current
// contract constants, so a later change to those constants can't change what an
// old save migrates to.

import { SAVE_SCHEMA_VERSION, type SaveLoadError, type SaveMigration } from "@eov/contracts";

/**
 * v1 → v2 (K1, ADR 0021 decision 10): `GameState.knowledge`, empty. Records are
 * copies of world projections and migrations never read game-data, so nothing
 * can be rebuilt here. The live view shows the founder's place at once, and the
 * rest of the world starts out unknown. With no pending books, the whole M001
 * ledger counts as known, which fits: M001 players saw everything.
 */
export const migrateV1ToV2: SaveMigration = {
  fromVersion: 1,
  toVersion: 2,
  migrate: (save) => {
    const state = save["state"];
    if (typeof state !== "object" || state === null || Array.isArray(state)) throw new Error("save.state is not an object");
    if ("knowledge" in state) throw new Error("save.state already has knowledge");
    return {
      ...save,
      state: {
        ...state,
        knowledge: { records: [], pendingNews: [], pendingBooks: [], activity: [], lastCatchUp: null },
      },
    };
  },
};

/**
 * The M001 scenario's one start location, frozen (ADR 0023 decision 10). M001's
 * founder and its one truck both live at Hollow Creek. A literal, not a
 * game-data read, so later edits to game-data can't change what a v2 save
 * becomes.
 */
const M001_SCENARIO_ID = "first-shipment";
const M001_START_LOCATION_ID = "hollow-creek";

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * v2 → v3 (P1, ADR 0023 decision 10): `GameState.founder` and
 * `VehicleState.parkedAt`, from the save's own fields only:
 * - only an M001 save (`state.scenarioId` "first-shipment") can migrate; any
 *   other scenario fails as MIGRATION_FAILED;
 * - the founder is PRESENT at Hollow Creek, not busy, awake since the save's tick;
 * - an idle truck (`trip: null`) is parked at Hollow Creek; a truck with a trip
 *   is on the road (`parkedAt: null`).
 * M001 saves load into the M001 scenario (`founderRules: false`), so the founder
 * just sits at Hollow Creek and the game plays exactly as before.
 * (`DeliveryState.driver` and `DISPATCH_DELIVERY.driver` are v3 → v4's.)
 */
export const migrateV2ToV3: SaveMigration = {
  fromVersion: 2,
  toVersion: 3,
  migrate: (save) => {
    const state = save["state"];
    if (!isObject(state)) throw new Error("save.state is not an object");
    if ("founder" in state) throw new Error("save.state already has founder");
    if (state["scenarioId"] !== M001_SCENARIO_ID) {
      throw new Error(`save.state.scenarioId ${JSON.stringify(state["scenarioId"])} has no frozen founder placement; only ${M001_SCENARIO_ID} saves migrate`);
    }
    const tick = state["tick"];
    if (typeof tick !== "number" || !Number.isSafeInteger(tick) || tick < 0) throw new Error("save.state.tick is not a tick");
    const vehicles = state["vehicles"];
    if (!Array.isArray(vehicles)) throw new Error("save.state.vehicles is not an array");
    return {
      ...save,
      state: {
        ...state,
        vehicles: vehicles.map((vehicle: unknown, i) => {
          if (!isObject(vehicle)) throw new Error(`save.state.vehicles[${i}] is not an object`);
          if ("parkedAt" in vehicle) throw new Error(`save.state.vehicles[${i}] already has parkedAt`);
          const { id, ...rest } = vehicle;
          // Key order as in the contract: id, parkedAt, trip (canonical JSON sorts keys anyway).
          return { id, parkedAt: vehicle["trip"] === null ? M001_START_LOCATION_ID : null, ...rest };
        }),
        founder: {
          whereabouts: { kind: "PRESENT", locationId: M001_START_LOCATION_ID, busy: null },
          awakeSince: tick,
        },
      },
    };
  },
};

/**
 * Quality tiers in rank order, frozen for v3 → v4 (ADR 0016's ranking as of
 * M001), so a later tier list can't change what a v3 save becomes.
 */
const V3_QUALITY_RANK: Readonly<Record<string, number>> = { basic: 0, standard: 1, premium: 2 };

function rankOf(quality: unknown, where: string): number {
  const rank = typeof quality === "string" ? V3_QUALITY_RANK[quality] : undefined;
  if (rank === undefined) throw new Error(`${where} has no known quality: ${JSON.stringify(quality)}`);
  return rank;
}

/**
 * A frozen copy of ADR 0016's want matching over the save's own `buyer.wants`:
 * the want for the product with the highest minimum quality at or below the
 * cargo's. Its `minimumQuality`, or null when no want matches.
 */
function matchedWantQuality(wants: readonly unknown[], productId: unknown, quality: unknown, where: string): string | null {
  const cargoRank = rankOf(quality, where);
  let best: string | null = null;
  let bestRank = -1;
  for (const [i, want] of wants.entries()) {
    if (!isObject(want)) throw new Error(`${where}.wants[${i}] is not an object`);
    if (want["productId"] !== productId) continue;
    const rank = rankOf(want["minimumQuality"], `${where}.wants[${i}]`);
    if (rank <= cargoRank && rank > bestRank) {
      best = want["minimumQuality"] as string;
      bestRank = rank;
    }
  }
  return best;
}

const asArray = (value: unknown, where: string): readonly unknown[] => {
  if (!Array.isArray(value)) throw new Error(`${where} is not an array`);
  return value;
};

const asObject = (value: unknown, where: string): Readonly<Record<string, unknown>> => {
  if (!isObject(value)) throw new Error(`${where} is not an object`);
  return value;
};

/** A v3 SALE purpose (`{ kind, buyerId, agreedUnitPrice }`) with its deal named instead (ADR 0022 decision 6). */
function salePurpose(purpose: Readonly<Record<string, unknown>>, dealId: string | null): Record<string, unknown> {
  if (!("agreedUnitPrice" in purpose)) throw new Error("a SALE purpose has no agreedUnitPrice");
  return { kind: "SALE", buyerId: purpose["buyerId"], dealId };
}

/**
 * Rewrites what v4 reshapes inside a subtree copied from the world (commands in
 * activity items, trips in VEHICLE_WHEREABOUTS records, DELIVERY_DISPATCHED
 * events): every SALE purpose next to a `deliveryId` names that delivery's
 * migrated deal (else null), and every DISPATCH_DELIVERY or RELEASE_RESERVATION
 * command gets v4's fields.
 */
function rewriteNested(node: unknown, dealOf: ReadonlyMap<string, string>, command: (c: Readonly<Record<string, unknown>>) => Record<string, unknown>): unknown {
  if (Array.isArray(node)) return node.map((n) => rewriteNested(n, dealOf, command));
  if (!isObject(node)) return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) out[key] = rewriteNested(value, dealOf, command);
  if (node["type"] === "DISPATCH_DELIVERY" || node["type"] === "RELEASE_RESERVATION") return command(out);
  const purpose = out["purpose"];
  if (isObject(purpose) && purpose["kind"] === "SALE" && "agreedUnitPrice" in purpose) {
    const deliveryId = node["deliveryId"];
    out["purpose"] = salePurpose(purpose, typeof deliveryId === "string" ? (dealOf.get(deliveryId) ?? null) : null);
  }
  return out;
}

/**
 * v3 → v4 (O1a, ADR 0022 Consequences "save.ts", and ADR 0023 decision 10's
 * `driver`), from the save's own fields only (ADR 0009):
 * - **In-flight sales:** each OUTBOUND M001 SALE delivery's buyer commitment
 *   becomes a held deal (`deal-1`, `deal-2`, ... in delivery order), DISPATCHED
 *   with that delivery, so the commitment isn't counted twice. Its unit price is
 *   the purpose's `agreedUnitPrice`; quantity and quality come from the cargo;
 *   `agreedAt` is the outbound trip's `departedAt`; `expiresAt` is the
 *   delivery's `dealDeadline`, which still governs arrival; budget committed.
 *   The commitment is re-keyed to the deal and records the want quality it
 *   matched (a frozen `matchWant` over the save's own `buyer.wants`). With no
 *   matching want it records the cargo's quality, which no want has, so a later
 *   release gives back budget but no demand, as `releaseDeal` did.
 * - **Every other SALE purpose** (finished deliveries, commands, events) gets
 *   `dealId: null`. A queued M001 sale therefore goes on spec when it applies;
 *   a migrated `commandLog` is for debugging only.
 * - **Deliveries and DISPATCH_DELIVERY commands** get `driver: null` (pre-M002, no driver).
 * - **RELEASE_RESERVATION commands** name the facility of the reservation if it's
 *   still active, else the save's first facility (the M001 save has one).
 * - **Command envelopes** get `issuer: { kind: "FOUNDER" }`.
 * - **Vehicles** get `tripCount: 0`, and `heldDeals` holds the migrated deals,
 *   with the `Deal` counter after them.
 */
export const migrateV3ToV4: SaveMigration = {
  fromVersion: 3,
  toVersion: 4,
  migrate: (save) => {
    const state = asObject(save["state"], "save.state");
    if ("heldDeals" in state) throw new Error("save.state already has heldDeals");
    const deliveries = asArray(state["deliveries"], "save.state.deliveries").map((d, i) => asObject(d, `save.state.deliveries[${i}]`));
    const buyers = asArray(state["buyers"], "save.state.buyers").map((b, i) => asObject(b, `save.state.buyers[${i}]`));
    const vehicles = asArray(state["vehicles"], "save.state.vehicles").map((v, i) => asObject(v, `save.state.vehicles[${i}]`));
    const facilities = asArray(state["facilities"], "save.state.facilities").map((f, i) => asObject(f, `save.state.facilities[${i}]`));
    const reservations = asArray(state["reservations"], "save.state.reservations").map((r, i) => asObject(r, `save.state.reservations[${i}]`));
    const counters = asObject(state["counters"], "save.state.counters");
    const nextId = asObject(counters["nextId"], "save.state.counters.nextId");

    // In-flight sales become DISPATCHED deals, in delivery order.
    const dealOf = new Map<string, string>();
    const heldDeals: Record<string, unknown>[] = [];
    const commitmentFor = new Map<string, { readonly dealId: string; readonly quality: string }>();
    deliveries.forEach((delivery, i) => {
      const where = `save.state.deliveries[${i}]`;
      const purpose = asObject(delivery["purpose"], `${where}.purpose`);
      if (purpose["kind"] !== "SALE" || delivery["status"] !== "OUTBOUND") return;
      const deliveryId = delivery["id"] as string;
      const buyerIndex = buyers.findIndex((b) => b["id"] === purpose["buyerId"]);
      if (buyerIndex < 0) throw new Error(`${where} sells to unknown buyer ${JSON.stringify(purpose["buyerId"])}`);
      const buyer = buyers[buyerIndex]!;
      const commitments = asArray(buyer["commitments"], `save.state.buyers[${buyerIndex}].commitments`).map((c) => asObject(c, "a commitment"));
      const commitment = commitments.find((c) => c["deliveryId"] === deliveryId);
      if (!commitment) throw new Error(`${where} is an in-flight sale with no commitment`);
      const cargo = asArray(delivery["cargo"], `${where}.cargo`).map((c) => asObject(c, `${where}.cargo line`));
      const line = cargo.find((c) => c["productId"] === commitment["productId"]);
      if (!line) throw new Error(`${where} carries no ${JSON.stringify(commitment["productId"])}`);
      const trip = vehicles.map((v) => v["trip"]).find((t) => isObject(t) && t["deliveryId"] === deliveryId && t["leg"] === "OUTBOUND");
      if (!isObject(trip)) throw new Error(`${where} is an in-flight sale with no outbound trip`);
      if (typeof delivery["dealDeadline"] !== "number") throw new Error(`${where} is an in-flight sale with no dealDeadline`);
      const dealId = `deal-${heldDeals.length + 1}`;
      dealOf.set(deliveryId, dealId);
      const wantQuality = matchedWantQuality(asArray(buyer["wants"], `save.state.buyers[${buyerIndex}].wants`), line["productId"], line["quality"], `save.state.buyers[${buyerIndex}]`);
      commitmentFor.set(deliveryId, { dealId, quality: wantQuality ?? (line["quality"] as string) });
      heldDeals.push({
        id: dealId,
        buyerId: purpose["buyerId"],
        productId: line["productId"],
        quality: line["quality"],
        quantity: line["quantity"],
        unitPrice: purpose["agreedUnitPrice"],
        agreedAt: trip["departedAt"],
        expiresAt: delivery["dealDeadline"],
        budgetCommitted: true,
        status: "DISPATCHED",
        deliveryId,
      });
    });

    const command = (c: Readonly<Record<string, unknown>>): Record<string, unknown> => {
      if (c["type"] === "RELEASE_RESERVATION") {
        if ("facilityId" in c) return { ...c };
        const active = reservations.find((r) => r["id"] === c["reservationId"]);
        const facilityId = active?.["facilityId"] ?? facilities[0]?.["id"];
        if (typeof facilityId !== "string") throw new Error("a RELEASE_RESERVATION has no facility to name");
        return { type: c["type"], facilityId, reservationId: c["reservationId"] };
      }
      const purpose = asObject(c["purpose"], "a DISPATCH_DELIVERY's purpose");
      return {
        ...c,
        purpose: purpose["kind"] === "SALE" && "agreedUnitPrice" in purpose ? salePurpose(purpose, null) : purpose,
        driver: "driver" in c ? c["driver"] : null,
      };
    };
    const envelopes = (key: "queuedCommands" | "commandLog") =>
      asArray(state[key], `save.state.${key}`).map((e, i) => {
        const envelope = asObject(e, `save.state.${key}[${i}]`);
        if ("issuer" in envelope) throw new Error(`save.state.${key}[${i}] already has an issuer`);
        const { id, scheduledTick, sequence, command: c } = envelope;
        return { id, scheduledTick, sequence, issuer: { kind: "FOUNDER" }, command: rewriteNested(c, dealOf, command) };
      });

    return {
      ...save,
      state: {
        ...state,
        counters: { ...counters, nextId: { ...nextId, Deal: heldDeals.length + 1 } },
        vehicles: vehicles.map((vehicle, i) => {
          if ("tripCount" in vehicle) throw new Error(`save.state.vehicles[${i}] already has tripCount`);
          const { id, parkedAt, ...rest } = vehicle;
          return { id, parkedAt, tripCount: 0, ...rest };
        }),
        deliveries: deliveries.map((delivery, i) => {
          if ("driver" in delivery) throw new Error(`save.state.deliveries[${i}] already has driver`);
          const purpose = asObject(delivery["purpose"], `save.state.deliveries[${i}].purpose`);
          const migrated = purpose["kind"] === "SALE" ? salePurpose(purpose, dealOf.get(delivery["id"] as string) ?? null) : purpose;
          return { ...delivery, purpose: migrated, driver: null };
        }),
        heldDeals,
        buyers: buyers.map((buyer, i) => ({
          ...buyer,
          commitments: asArray(buyer["commitments"], `save.state.buyers[${i}].commitments`).map((c, k) => {
            const old = asObject(c, `save.state.buyers[${i}].commitments[${k}]`);
            const deal = commitmentFor.get(old["deliveryId"] as string);
            if (!deal) throw new Error(`save.state.buyers[${i}].commitments[${k}] belongs to no in-flight sale`);
            return { dealId: deal.dealId, productId: old["productId"], quality: deal.quality, quantity: old["quantity"], amount: old["amount"] };
          }),
        })),
        queuedCommands: envelopes("queuedCommands"),
        commandLog: envelopes("commandLog"),
        eventJournal: rewriteNested(state["eventJournal"], dealOf, command),
        knowledge: rewriteNested(state["knowledge"], dealOf, command),
      },
    };
  },
};

/**
 * v4 → v5 (O1b, ADR 0022 decision 7): `ProductionJobState.conversionPrepaid`.
 * A running job in an older save paid nothing at its start (its transaction is the
 * entry-less `RESERVATION:<jobId>`), so it gets `null` and settles under the old
 * pay-at-settlement rule: cash first, then WAGES_PAYABLE. The ledger has no
 * PRODUCTION_IN_PROGRESS balance, which matches the new invariant (the balance
 * equals the sum of non-null `conversionPrepaid`). Nothing else changes.
 */
export const migrateV4ToV5: SaveMigration = {
  fromVersion: 4,
  toVersion: 5,
  migrate: (save) => {
    const state = asObject(save["state"], "save.state");
    const jobs = asArray(state["productionJobs"], "save.state.productionJobs").map((j, i) => {
      const job = asObject(j, `save.state.productionJobs[${i}]`);
      if ("conversionPrepaid" in job) throw new Error(`save.state.productionJobs[${i}] already has conversionPrepaid`);
      return { ...job, conversionPrepaid: null };
    });
    return { ...save, state: { ...state, productionJobs: jobs } };
  },
};

/**
 * v5 → v6 (PH1, ADR 0024 decision 13 and ADR 0027 decision 15): phones, rooms
 * and arrangements, from the save's own fields only (ADR 0009):
 * - `facilities[i].phoneLine: null`: no earlier save can own a line (no command
 *   could install one);
 * - `founder.whereabouts.call: null` when the founder is PRESENT (the save's own
 *   `whereabouts.kind`): no earlier save can be on a call;
 * - `founder.room: null`: no earlier save can hold a room;
 * - `knowledge.pendingMessages: []`: no earlier save can hold a message;
 * - `arrangements: []`. An earlier M002 save may hold founder purchases at
 *   Miller's in `commandLog`, but turning them into dealings would need
 *   game-data (which supplier is at which location), which ADR 0009 forbids.
 *   Arrangements start counting at this version.
 * `knowledge.lastCatchUp` and journaled KNOWLEDGE_CAUGHT_UP events don't change
 * (ADR 0024 decision 6), and the new union members are additive.
 */
export const migrateV5ToV6: SaveMigration = {
  fromVersion: 5,
  toVersion: 6,
  migrate: (save) => {
    const state = asObject(save["state"], "save.state");
    if ("arrangements" in state) throw new Error("save.state already has arrangements");
    const facilities = asArray(state["facilities"], "save.state.facilities").map((f, i) => {
      const facility = asObject(f, `save.state.facilities[${i}]`);
      if ("phoneLine" in facility) throw new Error(`save.state.facilities[${i}] already has phoneLine`);
      return { ...facility, phoneLine: null };
    });
    const founder = asObject(state["founder"], "save.state.founder");
    if ("room" in founder) throw new Error("save.state.founder already has room");
    const whereabouts = asObject(founder["whereabouts"], "save.state.founder.whereabouts");
    if ("call" in whereabouts) throw new Error("save.state.founder.whereabouts already has call");
    const knowledge = asObject(state["knowledge"], "save.state.knowledge");
    if ("pendingMessages" in knowledge) throw new Error("save.state.knowledge already has pendingMessages");
    return {
      ...save,
      state: {
        ...state,
        facilities,
        knowledge: { ...knowledge, pendingMessages: [] },
        founder: { ...founder, whereabouts: whereabouts["kind"] === "PRESENT" ? { ...whereabouts, call: null } : whereabouts, room: null },
        arrangements: [],
      },
    };
  },
};

/** A v6 message (held or delivered) with `report: null`: no v6 save can hold an employee's report. */
function withoutReport(message: Readonly<Record<string, unknown>>, where: string): Record<string, unknown> {
  if ("report" in message) throw new Error(`${where} already has report`);
  if (message["reason"] === "EMPLOYEE_REPORT") throw new Error(`${where} is an EMPLOYEE_REPORT message, which no v6 save can hold`);
  return { ...message, report: null };
}

/**
 * v6 → v7 (EM1, ADR 0025 decision 14), from the save's own fields only (ADR 0009):
 * - `employees: []` and `formerEmployees: []`: no earlier save can hold an
 *   employee or have dismissed one, because no command could hire;
 * - `counters.nextId.StandingOrder: 1`: no earlier save holds a standing order,
 *   and counters start at 1 (`new-game.ts`);
 * - `report: null` on every held message (`knowledge.pendingMessages[].items[]`)
 *   and every delivered one (`knowledge.activity[]` items of kind
 *   MESSAGE_DELIVERED, whose `message` ADR 0024 decision 15 saves there), read
 *   from the message's own `reason`: no earlier save can hold an EMPLOYEE_REPORT
 *   message, because the reason didn't exist.
 * Unchanged: `knowledge.records` (no earlier save holds an EMPLOYEE_PERFORMANCE
 * record, and the kind sorts last), production jobs, catch-ups, and command
 * envelopes (`issuer` is only ever FOUNDER). The new union members (commands,
 * events, reasons, activity kinds and items, the call-in reason, the transaction
 * kind) are additive. ADR 0028's `limitedBy` and `atArrival` are part of the first
 * version of their types, so they need nothing here.
 */
export const migrateV6ToV7: SaveMigration = {
  fromVersion: 6,
  toVersion: 7,
  migrate: (save) => {
    const state = asObject(save["state"], "save.state");
    if ("employees" in state) throw new Error("save.state already has employees");
    if ("formerEmployees" in state) throw new Error("save.state already has formerEmployees");
    const counters = asObject(state["counters"], "save.state.counters");
    const nextId = asObject(counters["nextId"], "save.state.counters.nextId");
    if ("StandingOrder" in nextId) throw new Error("save.state.counters.nextId already has StandingOrder");
    const knowledge = asObject(state["knowledge"], "save.state.knowledge");
    const pendingMessages = asArray(knowledge["pendingMessages"], "save.state.knowledge.pendingMessages").map((p, i) => {
      const place = asObject(p, `save.state.knowledge.pendingMessages[${i}]`);
      const items = asArray(place["items"], `save.state.knowledge.pendingMessages[${i}].items`).map((m, j) =>
        withoutReport(asObject(m, `save.state.knowledge.pendingMessages[${i}].items[${j}]`), `save.state.knowledge.pendingMessages[${i}].items[${j}]`),
      );
      return { ...place, items };
    });
    const activity = asArray(knowledge["activity"], "save.state.knowledge.activity").map((a, i) => {
      const item = asObject(a, `save.state.knowledge.activity[${i}]`);
      if (item["kind"] !== "MESSAGE_DELIVERED") return item;
      const where = `save.state.knowledge.activity[${i}].message`;
      return { ...item, message: withoutReport(asObject(item["message"], where), where) };
    });
    return {
      ...save,
      state: {
        ...state,
        counters: { ...counters, nextId: { ...nextId, StandingOrder: 1 } },
        knowledge: { ...knowledge, pendingMessages, activity },
        employees: [],
        formerEmployees: [],
      },
    };
  },
};

/** Every migration, oldest first. Add one per SAVE_SCHEMA_VERSION bump. */
export const SAVE_MIGRATIONS: readonly SaveMigration[] = [migrateV1ToV2, migrateV2ToV3, migrateV3ToV4, migrateV4ToV5, migrateV5ToV6, migrateV6ToV7];

export type MigrationResult =
  | { readonly ok: true; readonly save: Record<string, unknown> }
  | { readonly ok: false; readonly error: Extract<SaveLoadError, { code: "MISSING_MIGRATION" | "MIGRATION_FAILED" }> };

/**
 * Runs `save` (raw JSON at `fromVersion`) through the chain up to `toVersion`.
 * Each step must be the chain's `n → n + 1` migration; a gap is
 * MISSING_MIGRATION, a step that throws or returns something that isn't an
 * object is MIGRATION_FAILED. Each step's result gets the step's `toVersion`
 * as its `schemaVersion`, so a migration can't forget to bump it.
 */
export function migrateSave(
  save: Readonly<Record<string, unknown>>,
  fromVersion: number,
  chain: readonly SaveMigration[] = SAVE_MIGRATIONS,
  toVersion: number = SAVE_SCHEMA_VERSION,
): MigrationResult {
  let current: Record<string, unknown> = { ...save };
  for (let version = fromVersion; version < toVersion; version++) {
    const step = chain.find((m) => m.fromVersion === version);
    if (!step || step.toVersion !== version + 1) return { ok: false, error: { code: "MISSING_MIGRATION", fromVersion: version } };
    let next: unknown;
    try {
      next = step.migrate(current);
    } catch (error) {
      return { ok: false, error: { code: "MIGRATION_FAILED", fromVersion: version, toVersion: version + 1, message: messageOf(error) } };
    }
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      return {
        ok: false,
        error: { code: "MIGRATION_FAILED", fromVersion: version, toVersion: version + 1, message: "The migration didn't return an object" },
      };
    }
    current = { ...(next as Record<string, unknown>), schemaVersion: version + 1 };
  }
  return { ok: true, save: current };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
