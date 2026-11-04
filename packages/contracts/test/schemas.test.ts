import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";
import { day0Save, day0SaveFile, ids } from "../fixtures/index.ts";
import {
  cents,
  commandEnvelopeSchema,
  commandRequestSchema,
  formatIssues,
  gameCommandSchema,
  gameEventSchema,
  gameStateSchema,
  ledgerTransactionSchema,
  rejectionReasonSchema,
  saveFileSchema,
  saveGameSchema,
  saveHeaderSchema,
  type CommandEnvelope,
  type CommandRequest,
  type GameCommand,
  type GameEvent,
  type GameState,
  type LedgerTransaction,
  type Money,
  type RejectionReason,
  type SaveFile,
  type SaveGame,
} from "../src/index.ts";

/** Strips readonly all the way down, so a schema's (mutable) output can be compared to a readonly contract type. */
type DeepMutable<T> = T extends string | number | boolean | null | undefined
  ? T
  : { -readonly [K in keyof T]: DeepMutable<T[K]> };

describe("schemas match the contract types exactly", () => {
  it("at compile time", () => {
    expectTypeOf<z.infer<typeof gameCommandSchema>>().toEqualTypeOf<DeepMutable<GameCommand>>();
    expectTypeOf<z.infer<typeof commandRequestSchema>>().toEqualTypeOf<DeepMutable<CommandRequest>>();
    expectTypeOf<z.infer<typeof commandEnvelopeSchema>>().toEqualTypeOf<DeepMutable<CommandEnvelope>>();
    expectTypeOf<z.infer<typeof rejectionReasonSchema>>().toEqualTypeOf<DeepMutable<RejectionReason>>();
    expectTypeOf<z.infer<typeof gameEventSchema>>().toEqualTypeOf<DeepMutable<GameEvent>>();
    expectTypeOf<z.infer<typeof ledgerTransactionSchema>>().toEqualTypeOf<DeepMutable<LedgerTransaction>>();
    expectTypeOf<z.infer<typeof gameStateSchema>>().toEqualTypeOf<DeepMutable<GameState>>();
    expectTypeOf<z.infer<typeof saveGameSchema>>().toEqualTypeOf<DeepMutable<SaveGame>>();
    expectTypeOf<z.infer<typeof saveFileSchema>>().toEqualTypeOf<DeepMutable<SaveFile>>();
  });

  it("and the comparison really detects drift", () => {
    // If these ever pass as *equal*, the checks above are vacuous.
    expectTypeOf<z.infer<typeof gameStateSchema>>().not.toEqualTypeOf<DeepMutable<Omit<GameState, "seed">>>();
    expectTypeOf<z.infer<typeof gameStateSchema>>().not.toEqualTypeOf<DeepMutable<GameState & { extra: number }>>();
    expectTypeOf<z.infer<typeof gameCommandSchema>>().not.toEqualTypeOf<DeepMutable<Exclude<GameCommand, { type: "SET_WORKFORCE" }>>>();
    // Brands survive: schema output is Money, not a plain number.
    expectTypeOf<z.infer<typeof saveGameSchema>["state"]["materialPools"][number]["totalCost"]>().toEqualTypeOf<Money>();
    expectTypeOf<Money>().not.toEqualTypeOf<number>();
  });
});

function withoutKey(value: object | undefined, key: string): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...value };
  delete copy[key];
  return copy;
}

const roundTrip = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;

const commands: GameCommand[] = [
  { type: "PURCHASE_MATERIALS", supplierId: ids.supplier, materialId: ids.corn, quantity: 40, facilityId: ids.distillery },
  { type: "START_PRODUCTION", facilityId: ids.distillery, recipeId: ids.basicRecipe, quantity: 10 },
  {
    type: "DISPATCH_DELIVERY",
    vehicleId: ids.truck,
    cargo: [{ productId: ids.moonshine, quality: "basic", quantity: 8 }],
    purpose: { kind: "SALE", buyerId: ids.speakeasy, agreedUnitPrice: cents(1_520) },
    routeId: ids.routeSpeakeasyBack,
  },
  {
    type: "DISPATCH_DELIVERY",
    vehicleId: ids.truck,
    cargo: [{ productId: ids.moonshine, quality: "basic", quantity: 8 }],
    purpose: { kind: "TRANSFER", destinationFacilityId: ids.barn },
    routeId: null,
  },
  { type: "ACCEPT_CONTRACT", contractOfferId: "offer-2" as never },
  { type: "PURCHASE_EQUIPMENT", facilityId: ids.distillery, equipmentId: ids.condenser },
  { type: "SET_WORKFORCE", facilityId: ids.distillery, workerCount: 0 },
  { type: "RELEASE_RESERVATION", reservationId: "res-4" as never },
  { type: "REPEAT_OPERATION", sourceCommandId: "cmd-1" as never },
];

describe("commands", () => {
  it.each(commands.map((c) => [c.type, c] as const))("%s round-trips through JSON", (_type, command) => {
    expect(gameCommandSchema.parse(roundTrip(command))).toEqual(command);
  });

  it.each([
    ["zero quantity", { ...commands[0], quantity: 0 }],
    ["fractional quantity", { ...commands[0], quantity: 1.5 }],
    ["bad ID", { ...commands[0], supplierId: "Miller's" }],
    ["unknown key", { ...commands[0], discount: 5 }],
    ["missing routeId (must be explicit null)", withoutKey(commands[3], "routeId")],
    ["empty cargo", { ...commands[2], cargo: [] }],
    ["fractional price", { ...commands[2], purpose: { kind: "SALE", buyerId: ids.speakeasy, agreedUnitPrice: 15.2 } }],
    ["unknown command", { type: "BRIBE_SHERIFF" }],
  ])("rejects %s", (_label, bad) => {
    expect(gameCommandSchema.safeParse(bad).success).toBe(false);
  });

  it("accepts a request with or without a scheduled tick, never a negative one", () => {
    expect(commandRequestSchema.safeParse({ command: commands[0] }).success).toBe(true);
    expect(commandRequestSchema.safeParse({ command: commands[0], scheduledTick: 1_920 }).success).toBe(true);
    expect(commandRequestSchema.safeParse({ command: commands[0], scheduledTick: -1 }).success).toBe(false);
  });
});

describe("saves", () => {
  it("the fixture save round-trips through JSON unchanged", () => {
    expect(saveGameSchema.parse(roundTrip(day0Save))).toEqual(day0Save);
    expect(saveFileSchema.parse(roundTrip(day0SaveFile))).toEqual(day0SaveFile);
  });

  it("rejects an unbalanced ledger transaction", () => {
    const [opening] = day0Save.state.ledger.transactions;
    const unbalanced = { ...opening, entries: opening!.entries.slice(1) };
    const result = ledgerTransactionSchema.safeParse(roundTrip(unbalanced));
    expect(result.success).toBe(false);
    if (!result.success) expect(formatIssues(result.error).join("\n")).toContain("Debits must equal credits");
  });

  it("rejects a single-entry transaction", () => {
    const [, purchase] = day0Save.state.ledger.transactions;
    expect(ledgerTransactionSchema.safeParse(roundTrip({ ...purchase, entries: purchase!.entries.slice(0, 1) })).success).toBe(false);
  });

  it("rejects a save from another version, with readable issues", () => {
    const result = saveGameSchema.safeParse({ ...roundTrip(day0Save) as object, schemaVersion: 2 });
    expect(result.success).toBe(false);
    if (!result.success) expect(formatIssues(result.error)).toContainEqual(expect.stringContaining("schemaVersion"));
  });

  it("rejects a state missing an RNG stream or ID counter", () => {
    const save = roundTrip(day0Save) as { state: { rng: Record<string, unknown>; counters: { nextId: Record<string, unknown> } } };
    delete save.state.rng.routes;
    expect(saveGameSchema.safeParse(save).success).toBe(false);
    const save2 = roundTrip(day0Save) as typeof save;
    delete save2.state.counters.nextId.Delivery;
    expect(saveGameSchema.safeParse(save2).success).toBe(false);
  });

  it("reads just the header of any version, so persistence can pick a migration path", () => {
    expect(saveHeaderSchema.parse({ format: "empire-of-vice/save", schemaVersion: 7, whatever: true }).schemaVersion).toBe(7);
    expect(saveHeaderSchema.safeParse({ format: "something-else", schemaVersion: 1 }).success).toBe(false);
  });
});
