// The migration runner (ADR 0009), with made-up chains, and the real steps.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EMPTY_KNOWLEDGE, SAVE_SCHEMA_VERSION, saveGameSchema, type SaveMigration } from "@eov/contracts";
import { loadGame } from "@eov/simulation";
import { describe, expect, it } from "vitest";
import { migrateSave, SAVE_MIGRATIONS } from "../src/index.ts";

const renameCash: SaveMigration = {
  fromVersion: 1,
  toVersion: 2,
  migrate: ({ money, ...rest }) => ({ ...rest, cash: money }),
};
const addFlag: SaveMigration = {
  fromVersion: 2,
  toVersion: 3,
  migrate: (save) => ({ ...save, flag: false }),
};

describe("v1 → v2: empty knowledge (K1, ADR 0021 decision 10)", () => {
  const v1 = JSON.parse(readFileSync(fileURLToPath(new URL("../fixtures/save-v1.json", import.meta.url)), "utf8")) as {
    save: Record<string, unknown> & { state: Record<string, unknown> };
  };

  it("adds GameState.knowledge with no records, news, books, activity or catch-up, and changes nothing else", () => {
    const result = migrateSave(v1.save, 1, SAVE_MIGRATIONS, 2);
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    const { knowledge, ...rest } = result.save["state"] as Record<string, unknown>;
    expect(knowledge).toEqual({ records: [], pendingNews: [], pendingBooks: [], activity: [], lastCatchUp: null });
    expect(knowledge).toEqual(EMPTY_KNOWLEDGE);
    expect(rest).toEqual(v1.save.state);
    expect(result.save["schemaVersion"]).toBe(2);
    expect(v1.save.state).not.toHaveProperty("knowledge");
  });

  it("fails cleanly on a state that isn't an object or already has knowledge", () => {
    expect(migrateSave({ schemaVersion: 1, state: null }, 1, SAVE_MIGRATIONS, 2)).toMatchObject({
      ok: false,
      error: { code: "MIGRATION_FAILED", fromVersion: 1, toVersion: 2 },
    });
    expect(migrateSave({ schemaVersion: 1, state: { knowledge: {} } }, 1, SAVE_MIGRATIONS, 2)).toMatchObject({
      ok: false,
      error: { code: "MIGRATION_FAILED", message: "save.state already has knowledge" },
    });
  });
});

describe("v2 → v3: the founder and parked vehicles (P1, ADR 0023 decision 10)", () => {
  type RawSave = Record<string, unknown> & { state: Record<string, unknown> & { tick: number; vehicles: Record<string, unknown>[] } };
  const v2 = JSON.parse(readFileSync(fileURLToPath(new URL("../fixtures/save-v2.json", import.meta.url)), "utf8")) as { save: RawSave };
  const migrate = (save: Readonly<Record<string, unknown>>) => migrateSave(save, 2, SAVE_MIGRATIONS, 3);
  const withState = (patch: Record<string, unknown>): RawSave => ({ ...v2.save, state: { ...v2.save.state, ...patch } });

  it("puts the founder at Hollow Creek, not busy, awake since the save's tick, and changes nothing else", () => {
    const result = migrate(v2.save);
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    const { founder, vehicles, ...rest } = result.save["state"] as Record<string, unknown>;
    expect(founder).toEqual({ whereabouts: { kind: "PRESENT", locationId: "hollow-creek", busy: null }, awakeSince: v2.save.state.tick });
    const { vehicles: oldVehicles, ...oldRest } = v2.save.state;
    expect(rest).toEqual(oldRest);
    expect(result.save["schemaVersion"]).toBe(3);
    expect(v2.save.state).not.toHaveProperty("founder");
    // The fixture's truck is out on a delivery: on the road, not parked.
    expect(oldVehicles.map((v) => v["trip"] === null)).toEqual([false]);
    expect(vehicles).toEqual(oldVehicles.map((v) => ({ ...v, parkedAt: null })));
  });

  it("parks an idle truck at Hollow Creek", () => {
    const idle = withState({ vehicles: v2.save.state.vehicles.map((v) => ({ ...v, trip: null })) });
    const result = migrate(idle);
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect((result.save["state"] as RawSave["state"]).vehicles).toEqual([{ id: "model-tt-truck", parkedAt: "hollow-creek", trip: null }]);
  });

  it("reads only the save: the placement is a frozen literal and the founder is awake since the save's own tick", () => {
    const result = migrate(withState({ tick: 9_999 }));
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect((result.save["state"] as Record<string, unknown>)["founder"]).toEqual({
      whereabouts: { kind: "PRESENT", locationId: "hollow-creek", busy: null },
      awakeSince: 9_999,
    });
  });

  it.each([
    ["another scenario", withState({ scenarioId: "the-first-hire" }), /only first-shipment saves migrate/],
    ["a state that already has a founder", withState({ founder: {} }), /already has founder/],
    ["a vehicle that already has parkedAt", withState({ vehicles: [{ id: "model-tt-truck", parkedAt: null, trip: null }] }), /already has parkedAt/],
    ["a missing tick", withState({ tick: undefined }), /tick/],
    ["vehicles that aren't a list", withState({ vehicles: {} }), /vehicles/],
  ])("fails cleanly on %s", (_label, save, message) => {
    const result = migrate(save);
    expect(result).toMatchObject({ ok: false, error: { code: "MIGRATION_FAILED", fromVersion: 2, toVersion: 3 } });
    if (!result.ok && result.error.code === "MIGRATION_FAILED") expect(result.error.message).toMatch(message);
  });

  it("chains from v1 through v2", () => {
    const v1 = JSON.parse(readFileSync(fileURLToPath(new URL("../fixtures/save-v1.json", import.meta.url)), "utf8")) as { save: Record<string, unknown> };
    const result = migrateSave(v1.save, 1);
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result.save["schemaVersion"]).toBe(SAVE_SCHEMA_VERSION);
    expect(result.save["state"]).toHaveProperty("knowledge");
    expect(result.save["state"]).toHaveProperty("founder");
  });
});

/** A copy without the given keys. */
function omit(value: Readonly<Record<string, unknown>>, ...keys: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([k]) => !keys.includes(k)));
}

describe("v3 → v4: held deals, driver, tripCount and the issuer (O1a, ADR 0022 Consequences)", () => {
  type Obj = Record<string, unknown>;
  type RawSave = Obj & { state: Obj & { deliveries: Obj[]; buyers: (Obj & { commitments: Obj[]; wants: Obj[] })[]; vehicles: Obj[]; commandLog: Obj[]; queuedCommands: Obj[]; eventJournal: Obj[]; reservations: Obj[] } };
  const v3 = JSON.parse(readFileSync(fileURLToPath(new URL("../fixtures/save-v3.json", import.meta.url)), "utf8")) as { save: RawSave };
  const migrate = (save: Readonly<Record<string, unknown>>) => migrateSave(save, 3, SAVE_MIGRATIONS, 4);
  const withState = (patch: Obj): RawSave => ({ ...v3.save, state: { ...v3.save.state, ...patch } });
  const migrated = (save: RawSave = v3.save): RawSave["state"] & { heldDeals: Obj[]; counters: Obj & { nextId: Obj } } => {
    const result = migrate(save);
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result.save["schemaVersion"]).toBe(4);
    return result.save["state"] as never;
  };

  it("turns the in-flight sale's commitment into a DISPATCHED deal, from the save's own fields", () => {
    const old = v3.save.state;
    const delivery = old.deliveries[0]!;
    // The fixture: the truck is on its way to the roadhouse with one case, agreed at $31.20.
    expect(delivery).toMatchObject({ id: "delivery-1", status: "OUTBOUND", purpose: { kind: "SALE", buyerId: "crossroads-roadhouse", agreedUnitPrice: 3120 }, dealDeadline: 441 });
    const s = migrated();
    expect(s.heldDeals).toEqual([
      {
        id: "deal-1",
        buyerId: "crossroads-roadhouse",
        productId: "moonshine",
        quality: "basic",
        quantity: 1,
        unitPrice: 3120, // the purpose's agreedUnitPrice
        agreedAt: 201, // the outbound trip's departedAt
        expiresAt: 441, // the delivery's dealDeadline, which still governs arrival
        budgetCommitted: true,
        status: "DISPATCHED",
        deliveryId: "delivery-1",
      },
    ]);
    expect(s.counters.nextId["Deal"]).toBe(2);
    expect(s.buyers[0]!.commitments).toEqual([{ dealId: "deal-1", productId: "moonshine", quality: "basic", quantity: 1, amount: 3120 }]);
    expect(s.deliveries).toEqual([{ ...delivery, purpose: { kind: "SALE", buyerId: "crossroads-roadhouse", dealId: "deal-1" }, driver: null }]);
    expect(s.vehicles).toEqual(old.vehicles.map((v) => ({ ...v, tripCount: 0 })));
    // The journal's DELIVERY_DISPATCHED names the deal too; nothing else in it changes.
    const dispatched = s.eventJournal.find((e) => e["type"] === "DELIVERY_DISPATCHED");
    expect(dispatched).toEqual({ ...old.eventJournal.find((e) => e["type"] === "DELIVERY_DISPATCHED"), purpose: { kind: "SALE", buyerId: "crossroads-roadhouse", dealId: "deal-1" } });
    expect(s.eventJournal.filter((e) => e["type"] !== "DELIVERY_DISPATCHED")).toEqual(old.eventJournal.filter((e) => e["type"] !== "DELIVERY_DISPATCHED"));
  });

  it("gives every command envelope the FOUNDER issuer, and the logged M001 sale dealId null and driver null", () => {
    const old = v3.save.state;
    const s = migrated();
    for (const key of ["commandLog", "queuedCommands"] as const) {
      expect(s[key].map((e) => e["issuer"])).toEqual(old[key].map(() => ({ kind: "FOUNDER" })));
    }
    const sale = s.commandLog.find((e) => (e["command"] as Obj)["type"] === "DISPATCH_DELIVERY")!;
    expect(sale["command"]).toMatchObject({ purpose: { kind: "SALE", buyerId: "crossroads-roadhouse", dealId: null }, driver: null });
    const others = (log: Obj[]) => log.filter((e) => (e["command"] as Obj)["type"] !== "DISPATCH_DELIVERY").map((e) => omit(e, "issuer"));
    expect(others(s.commandLog)).toEqual(others(old.commandLog));
    expect(s.queuedCommands.map((e) => omit(e, "issuer"))).toEqual(old.queuedCommands);
  });

  it("changes nothing else", () => {
    const strip = (s: Obj) => omit(s, "heldDeals", "counters", "vehicles", "deliveries", "buyers", "commandLog", "queuedCommands", "eventJournal");
    expect(strip(migrated())).toEqual(strip(v3.save.state));
    expect(migrated().buyers.map((b) => omit(b, "commitments"))).toEqual(v3.save.state.buyers.map((b) => omit(b, "commitments")));
  });

  it("with no want matching the cargo, records the cargo's quality, so a release gives back budget only (as releaseDeal did)", () => {
    const buyers = v3.save.state.buyers.map((b) => (b["id"] === "crossroads-roadhouse" ? { ...b, wants: b.wants.map((w) => ({ ...w, minimumQuality: "standard" })) } : b));
    const s = migrated(withState({ buyers }));
    expect(s.buyers[0]!.commitments).toEqual([{ dealId: "deal-1", productId: "moonshine", quality: "basic", quantity: 1, amount: 3120 }]);
    expect(s.heldDeals).toHaveLength(1);
  });

  it("matches the most specific want at or below the cargo's quality", () => {
    const deliveries = v3.save.state.deliveries.map((d) => ({ ...d, cargo: (d["cargo"] as Obj[]).map((c) => ({ ...c, quality: "premium" })) }));
    const buyers = v3.save.state.buyers.map((b) =>
      b["id"] === "crossroads-roadhouse" ? { ...b, wants: [...b.wants, { ...b.wants[0]!, minimumQuality: "standard" }] } : b,
    );
    const s = migrated(withState({ deliveries, buyers }));
    expect(s.buyers[0]!.commitments).toMatchObject([{ dealId: "deal-1", quality: "standard" }]);
    expect(s.heldDeals).toMatchObject([{ quality: "premium" }]);
  });

  it("gives finished sales dealId null and mints no deal for them", () => {
    const deliveries = v3.save.state.deliveries.map((d) => ({ ...d, status: "DELIVERED" }));
    const buyers = v3.save.state.buyers.map((b) => ({ ...b, commitments: [] }));
    const s = migrated(withState({ deliveries, buyers }));
    expect(s.heldDeals).toEqual([]);
    expect(s.counters.nextId["Deal"]).toBe(1);
    expect(s.deliveries[0]).toMatchObject({ purpose: { kind: "SALE", buyerId: "crossroads-roadhouse", dealId: null }, driver: null });
  });

  it("names a queued RELEASE_RESERVATION's facility: the reservation's if it's active, else the save's first facility", () => {
    const envelope = (n: number, reservationId: string) => ({
      id: `cmd-${n}`,
      scheduledTick: 2_000,
      sequence: n,
      command: { type: "RELEASE_RESERVATION", reservationId },
    });
    const reservations = [
      { id: "res-7", facilityId: "riverside-warehouse", goods: { kind: "PRODUCT", productId: "moonshine", quality: "basic" }, quantity: 1, holder: { kind: "CONTRACT", contractId: "contract-1" } },
    ];
    const s = migrated(withState({ reservations, queuedCommands: [envelope(8, "res-7"), envelope(9, "res-404")] }));
    expect(s.queuedCommands.map((e) => e["command"])).toEqual([
      { type: "RELEASE_RESERVATION", facilityId: "riverside-warehouse", reservationId: "res-7" },
      { type: "RELEASE_RESERVATION", facilityId: "distillery-main", reservationId: "res-404" },
    ]);
  });

  it.each([
    ["a state that already has heldDeals", () => withState({ heldDeals: [] }), /already has heldDeals/],
    ["an in-flight sale with no commitment", () => withState({ buyers: v3.save.state.buyers.map((b) => ({ ...b, commitments: [] })) }), /no commitment/],
    [
      "a commitment with no in-flight sale",
      () => withState({ deliveries: v3.save.state.deliveries.map((d) => ({ ...d, status: "FAILED" })) }),
      /belongs to no in-flight sale/,
    ],
    ["an in-flight sale with no outbound trip", () => withState({ vehicles: v3.save.state.vehicles.map((v) => ({ ...v, trip: null })) }), /no outbound trip/],
    ["an envelope that already has an issuer", () => withState({ queuedCommands: v3.save.state.queuedCommands.map((e) => ({ ...e, issuer: { kind: "FOUNDER" } })) }), /already has an issuer/],
  ])("fails cleanly on %s", (_label, save, message) => {
    const result = migrate(save());
    expect(result).toMatchObject({ ok: false, error: { code: "MIGRATION_FAILED", fromVersion: 3, toVersion: 4 } });
    if (!result.ok && result.error.code === "MIGRATION_FAILED") expect(result.error.message).toMatch(message);
  });

  it("loads, and the migrated deal settles on arrival at its agreed price, then leaves heldDeals", () => {
    const result = migrateSave(v3.save, 3);
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    const sim = loadGame(saveGameSchema.parse(result.save));
    sim.advance(321 - sim.state.tick);
    const sale = sim.takeEvents().find((e) => e.type === "SALE_COMPLETED");
    expect(sale).toMatchObject({ deliveryId: "delivery-1", buyerId: "crossroads-roadhouse", revenue: 3120 });
    expect(sim.state.heldDeals).toEqual([]);
    expect(sim.state.buyers.find((b) => b.id === "crossroads-roadhouse")!.commitments).toEqual([]);
  });

  it("chains from v1", () => {
    const v1 = JSON.parse(readFileSync(fileURLToPath(new URL("../fixtures/save-v1.json", import.meta.url)), "utf8")) as { save: Record<string, unknown> };
    const result = migrateSave(v1.save, 1);
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result.save["schemaVersion"]).toBe(SAVE_SCHEMA_VERSION);
    expect(saveGameSchema.safeParse(result.save).success).toBe(true);
    expect((result.save["state"] as { heldDeals: unknown[] }).heldDeals).toMatchObject([{ id: "deal-1", status: "DISPATCHED", unitPrice: 1400 }]);
  });
});

describe("migrateSave", () => {
  it("has one n → n + 1 step for every version below the current one", () => {
    expect(SAVE_MIGRATIONS.map((m) => [m.fromVersion, m.toVersion])).toEqual(
      Array.from({ length: SAVE_SCHEMA_VERSION - 1 }, (_, i) => [i + 1, i + 2]),
    );
  });

  it("is the identity at the current version", () => {
    const save = { format: "x", schemaVersion: SAVE_SCHEMA_VERSION };
    expect(migrateSave(save, SAVE_SCHEMA_VERSION)).toEqual({ ok: true, save });
  });

  it("runs every step in order and stamps each step's version", () => {
    const result = migrateSave({ schemaVersion: 1, money: 5 }, 1, [addFlag, renameCash], 3);
    expect(result).toEqual({ ok: true, save: { schemaVersion: 3, cash: 5, flag: false } });
  });

  it("doesn't touch its input", () => {
    const input = Object.freeze({ schemaVersion: 1, money: 5 });
    migrateSave(input, 1, [renameCash, addFlag], 3);
    expect(input).toEqual({ schemaVersion: 1, money: 5 });
  });

  it("reports a missing step", () => {
    expect(migrateSave({ schemaVersion: 1 }, 1, [renameCash], 3)).toEqual({ ok: false, error: { code: "MISSING_MIGRATION", fromVersion: 2 } });
    expect(migrateSave({ schemaVersion: 1 }, 1, [], 2)).toEqual({ ok: false, error: { code: "MISSING_MIGRATION", fromVersion: 1 } });
    // A step that skips a version isn't the n → n + 1 step.
    const skip: SaveMigration = { fromVersion: 1, toVersion: 3, migrate: (s) => s };
    expect(migrateSave({ schemaVersion: 1 }, 1, [skip], 3)).toEqual({ ok: false, error: { code: "MISSING_MIGRATION", fromVersion: 1 } });
  });

  it("reports a step that throws or returns something that isn't an object", () => {
    const throws: SaveMigration = {
      fromVersion: 1,
      toVersion: 2,
      migrate: () => {
        throw new Error("no money field");
      },
    };
    expect(migrateSave({}, 1, [throws], 2)).toEqual({
      ok: false,
      error: { code: "MIGRATION_FAILED", fromVersion: 1, toVersion: 2, message: "no money field" },
    });
    const nothing: SaveMigration = { fromVersion: 1, toVersion: 2, migrate: () => null as unknown as Record<string, unknown> };
    expect(migrateSave({}, 1, [nothing], 2)).toMatchObject({ ok: false, error: { code: "MIGRATION_FAILED", fromVersion: 1, toVersion: 2 } });
  });
});
