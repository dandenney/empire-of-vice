// The producer coverage test (ADR 0021 decisions 6, 7 and 11).
//
// Every transaction producer (an idempotency-key family) that can post without a
// founder command must be known by rule 1, or have a row in each table it can
// post to: the cash-posting table for a CASH leg, the books table for entries
// with no CASH leg. Producers with no entries never reach the books (rule 4).
//
// The registry is checked against the simulation itself: every
// `idempotencyKey(...)` call site under packages/simulation/src must name a
// registered producer, and every registered producer must have a call site. The
// source is read as text (contracts can't import the simulation).

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CASH_POSTING_REVEALS,
  idempotencyKey,
  PENDING_BOOKS_CONCERNS,
  SUBJECT_KINDS,
  TRANSACTION_PRODUCERS,
  transactionProducerOf,
  type TransactionKind,
  type TransactionProducer,
  type TransactionProducerDefinition,
} from "../src/index.ts";

const producers = Object.entries(TRANSACTION_PRODUCERS) as [TransactionProducer, TransactionProducerDefinition][];
const cashRows: Readonly<Record<string, unknown>> = CASH_POSTING_REVEALS;
const bookRows: Readonly<Record<string, unknown>> = PENDING_BOOKS_CONCERNS;
const knownByRule1 = (p: TransactionProducerDefinition) => p.trigger !== "WORLD";

describe("producer coverage (ADR 0021 decisions 6 and 7)", () => {
  it.each(producers.filter(([, p]) => !knownByRule1(p)))("%s has a row in each table it can post to", (name, p) => {
    if (p.legs.includes("CASH")) expect(cashRows[name], `${name} posts cash: needs a cash-posting row`).toBeDefined();
    if (p.legs.includes("NON_CASH")) expect(bookRows[name], `${name} posts entries without cash: needs a books row`).toBeDefined();
  });

  it("has no table rows for producers that can't post there", () => {
    for (const name of Object.keys(cashRows)) {
      const p = TRANSACTION_PRODUCERS[name as TransactionProducer];
      expect(p.trigger, name).toBe("WORLD");
      expect(p.legs, name).toContain("CASH");
    }
    for (const name of Object.keys(bookRows)) {
      const p = TRANSACTION_PRODUCERS[name as TransactionProducer];
      expect(p.trigger, name).toBe("WORLD");
      expect(p.legs, name).toContain("NON_CASH");
    }
  });

  it("classifies ADR 0022's deal producers (decision 9): the founder's own AGREE_DEAL, and an agreement expiring by time", () => {
    // AGREE_DEAL: rule 1, the founder's own command. No entries.
    expect(TRANSACTION_PRODUCERS["DAILY_SETTLEMENT:DEAL_AGREED"]).toEqual({ trigger: "FOUNDER_COMMAND", legs: ["NO_ENTRIES"] });
    // DEAL_EXPIRED: an agreement's state, always known, never a world posting. No entries.
    expect(TRANSACTION_PRODUCERS["DAILY_SETTLEMENT:DEAL_EXPIRED"]).toEqual({ trigger: "AGREED_CHARGE", legs: ["NO_ENTRIES"] });
    // A deal dispatch (and a repeated sale's re-agreement, in the same transaction) is the DISPATCH producer.
    expect(TRANSACTION_PRODUCERS.DISPATCH.trigger).toBe("FOUNDER_COMMAND");
    // A deal's settlement, fall-through or seizure posts through the M001 producers, already classified.
    for (const name of ["SALE", "DISPATCH:FELL_THROUGH", "CARGO_LOSS"] as const) expect(TRANSACTION_PRODUCERS[name].trigger).toBe("WORLD");
    for (const name of ["DAILY_SETTLEMENT:DEAL_AGREED", "DAILY_SETTLEMENT:DEAL_EXPIRED"]) {
      expect(cashRows[name], name).toBeUndefined();
      expect(bookRows[name], name).toBeUndefined();
    }
  });

  it("classifies every M001 producer from the ADR's tables", () => {
    // Rule 1: midnight wages and overhead are agreed charges, known with or without cash.
    expect(TRANSACTION_PRODUCERS["DAILY_SETTLEMENT:WAGES"].trigger).toBe("AGREED_CHARGE");
    expect(TRANSACTION_PRODUCERS["DAILY_SETTLEMENT:OVERHEAD"].trigger).toBe("AGREED_CHARGE");
    // Decision 6: production, installment settlement and VEHICLE_RETURN post with or without a cash leg.
    for (const name of ["PRODUCTION", "PRODUCTION_WRITE_OFF", "INSTALLMENT_SETTLEMENT", "VEHICLE_RETURN"] as const) {
      expect(cashRows[name], name).toBeDefined();
      expect(bookRows[name], name).toBeDefined();
    }
    expect(Object.keys(cashRows).sort()).toEqual(
      ["DAILY_SETTLEMENT:PAYROLL", "DAILY_SETTLEMENT:PENALTIES", "INSTALLMENT_SETTLEMENT", "LOSS:SHAKEDOWN", "PRODUCTION", "PRODUCTION_WRITE_OFF", "SALE", "VEHICLE_RETURN"].sort(),
    );
    expect(PENDING_BOOKS_CONCERNS).toEqual({
      PRODUCTION: "FACILITY_STOCK",
      PRODUCTION_WRITE_OFF: "FACILITY_STOCK",
      INSTALLMENT_SETTLEMENT: "CONTRACT_PROGRESS",
      VEHICLE_RETURN: "VEHICLE_WHEREABOUTS",
      CARGO_LOSS: "NEWS",
      TRANSFER: "FACILITY_STOCK",
    });
    for (const row of Object.values(CASH_POSTING_REVEALS)) for (const s of row.subjects) expect(SUBJECT_KINDS).toContain(s);
  });

  it("classifies production's prepaid conversion cost (ADR 0022 decision 7)", () => {
    // PRODUCTION_START: rule 1, the founder's own command. It pays cash, or posts nothing at a zero cost.
    expect(TRANSACTION_PRODUCERS.PRODUCTION_START).toEqual({ trigger: "FOUNDER_COMMAND", legs: ["CASH", "NO_ENTRIES"] });
    expect(cashRows["PRODUCTION_START"]).toBeUndefined();
    expect(bookRows["PRODUCTION_START"]).toBeUndefined();
    // It replaces M001's entry-less RESERVATION:<jobId>, which nothing posts any more.
    expect(Object.hasOwn(TRANSACTION_PRODUCERS, "RESERVATION")).toBe(false);
    // A prepaid completion or failure is non-cash: ADR 0021 decision 7's books row.
    expect(PENDING_BOOKS_CONCERNS.PRODUCTION).toBe("FACILITY_STOCK");
    expect(PENDING_BOOKS_CONCERNS.PRODUCTION_WRITE_OFF).toBe("FACILITY_STOCK");
    // A migrated job (conversionPrepaid: null) still pays at settlement: decision 6's cash row.
    expect(cashRows["PRODUCTION"]).toBeDefined();
    expect(cashRows["PRODUCTION_WRITE_OFF"]).toBeDefined();
    for (const name of ["PRODUCTION", "PRODUCTION_WRITE_OFF"] as const) expect(TRANSACTION_PRODUCERS[name].legs).toEqual(["CASH", "NON_CASH", "NO_ENTRIES"]);
  });

  it("classifies the founder's two-stage producers (ADR 0029 decision 12)", () => {
    // A mash: rule 1, the founder's command. Cash, or nothing at a zero cost.
    expect(TRANSACTION_PRODUCERS["PRODUCTION_START:MASH"]).toEqual({ trigger: "FOUNDER_COMMAND", legs: ["CASH", "NO_ENTRIES"] });
    // A run start: rule 1, never any entries (the prepaid amount moves from washes to the job unposted).
    expect(TRANSACTION_PRODUCERS["PRODUCTION_START:RUN"]).toEqual({ trigger: "FOUNDER_COMMAND", legs: ["NO_ENTRIES"] });
    for (const name of ["PRODUCTION_START:MASH", "PRODUCTION_START:RUN"]) {
      expect(cashRows[name], name).toBeUndefined();
      expect(bookRows[name], name).toBeUndefined();
    }
    // The employee families land with their call sites in E1 (#180).
    for (const family of Object.keys(TRANSACTION_PRODUCERS)) expect(family.startsWith("PRODUCTION_START:EMPLOYEE"), family).toBe(false);
    // The keys decision 5 names resolve to the new families, not to O1b's PRODUCTION_START.
    expect(transactionProducerOf(idempotencyKey("PRODUCTION_START", "MASH", "distillery-main", 4_200))).toBe("PRODUCTION_START:MASH");
    expect(transactionProducerOf(idempotencyKey("PRODUCTION_START", "RUN", "job-4"))).toBe("PRODUCTION_START:RUN");
  });
});

// ---------------------------------------------------------------------------
// The registry against the simulation's call sites
// ---------------------------------------------------------------------------

const SIM_SRC = fileURLToPath(new URL("../../simulation/src/", import.meta.url));

/**
 * Producers registered ahead of their call sites, with the task that adds them.
 * ADR 0029 decision 16 registers the founder's two-stage families in TS1 (#243),
 * the contract task, and puts their call sites in TS2 (#244).
 */
const AWAITING_CALL_SITES: Readonly<Record<string, string>> = {
  "PRODUCTION_START:MASH": "TS2 (#244)",
  "PRODUCTION_START:RUN": "TS2 (#244)",
};

/**
 * Call sites whose kind or tag is a variable rather than a literal, with the
 * values it takes. A new non-literal call site fails the scan until it's listed.
 */
const VARIABLE_TAGS: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  "production/jobs.ts": { kind: ["PRODUCTION", "PRODUCTION_WRITE_OFF"] },
  "production/settlement.ts": { part: ["WAGES", "OVERHEAD", "PAYROLL"] },
};
/**
 * Every non-literal argument that isn't ID-shaped, by file: values (ticks, days,
 * indexes, a reason) that never name the producer. ID-shaped arguments
 * (`delivery.id`, `dealId`, `ctx.envelope.id`) pass without a listing, because an
 * ID is lowercase and never a tag. Anything else fails the scan until it's listed
 * here, so a bare variable can't slip a new tag into a registered family
 * (`idempotencyKey("DISPATCH", d, outcome)`, issue #192).
 */
const VALUE_ARGUMENTS: Readonly<Record<string, readonly string[]>> = {
  "commands/repeat.ts": ["link"],
  "contracts/contracts.ts": ["ctx.tick", "dayIndex(ctx.tick) - 1", "index"],
  "economy/market/market.ts": ["day", "ctx.tick"],
  "events/shakedown.ts": ["event.reason", "ctx.tick", "event.sequence"],
  "logistics/logistics.ts": ["ctx.tick"],
  "production/settlement.ts": ["day"],
  "progression/reputation.ts": ["event.installmentIndex"],
};

function sourceFiles(dir: string, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sourceFiles(`${dir}${entry.name}/`, `${prefix}${entry.name}/`)
      : entry.name.endsWith(".ts")
        ? [`${prefix}${entry.name}`]
        : [],
  );
}

/** The top-level, comma-separated arguments of the call starting at `open` (the index of its "("). */
function callArguments(text: string, open: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) {
        args.push(text.slice(start, i).trim());
        return args.filter((a) => a.length > 0);
      }
    } else if (c === "," && depth === 1) {
      args.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  throw new Error("Unbalanced call");
}

const LITERAL_TAG = /^"([A-Z][A-Z0-9_]*)"$/;
/** A property path ending in `id` or `<name>Id`: `deliveryId`, `delivery.id`, `ctx.envelope.id`, `def.buyerId`. */
const ID_SHAPED = /^(?:[a-zA-Z_$][\w$]*\.)*(?:id|[a-z][a-zA-Z0-9]*Id)$/;

/** Value arguments the scan met, by file, to check VALUE_ARGUMENTS has no stale entries. */
const valueArgumentsSeen = new Map<string, Set<string>>();

/** The producer families one call site can produce. */
function familiesAt(file: string, args: readonly string[]): string[] {
  let families: string[][] = [[]];
  args.forEach((arg, index) => {
    const literal = LITERAL_TAG.exec(arg);
    const variable = VARIABLE_TAGS[file]?.[arg];
    if (literal) families = families.map((f) => [...f, literal[1]!]);
    else if (variable) families = families.flatMap((f) => variable.map((v) => [...f, v]));
    else if (index === 0) throw new Error(`${file}: idempotencyKey's kind must be a literal or listed in VARIABLE_TAGS: ${arg}`);
    else if (/^"/.test(arg)) throw new Error(`${file}: string argument that isn't a tag: ${arg}`);
    else if (ID_SHAPED.test(arg)) return;
    else if (VALUE_ARGUMENTS[file]?.includes(arg)) {
      if (!valueArgumentsSeen.has(file)) valueArgumentsSeen.set(file, new Set());
      valueArgumentsSeen.get(file)!.add(arg);
    } else {
      throw new Error(`${file}: can't tell whether ${arg} is a tag; list it in VARIABLE_TAGS or VALUE_ARGUMENTS`);
    }
  });
  return families.map((f) => f.join(":"));
}

function simulationFamilies(): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  for (const file of sourceFiles(SIM_SRC)) {
    const text = readFileSync(SIM_SRC + file, "utf8");
    for (const match of text.matchAll(/\bidempotencyKey\(/g)) {
      const open = match.index + match[0].length - 1;
      for (const family of familiesAt(file, callArguments(text, open))) {
        if (!found.has(family)) found.set(family, new Set());
        found.get(family)!.add(file);
      }
    }
  }
  return found;
}

describe("the producer registry matches the simulation", () => {
  const found = simulationFamilies();
  // repeat.ts only looks up MATERIAL_PURCHASE keys; it never posts. Every other site posts.

  it("finds the call sites", () => {
    expect(found.size).toBeGreaterThan(20);
  });

  it("every family the simulation posts is a registered producer", () => {
    const unregistered = [...found.keys()].filter((f) => !Object.hasOwn(TRANSACTION_PRODUCERS, f));
    expect(unregistered, "add these to TRANSACTION_PRODUCERS (and the tables, if they can post without a command)").toEqual([]);
  });

  it("every registered producer has a call site, except those whose call sites a named later task adds", () => {
    const unused = Object.keys(TRANSACTION_PRODUCERS).filter((f) => !found.has(f) && !Object.hasOwn(AWAITING_CALL_SITES, f));
    expect(unused).toEqual([]);
  });

  it("lists as awaiting only registered producers that still have no call site", () => {
    // When TS2 adds a call site, this fails until its entry is removed.
    for (const family of Object.keys(AWAITING_CALL_SITES)) {
      expect(Object.hasOwn(TRANSACTION_PRODUCERS, family), family).toBe(true);
      expect(found.has(family), `${family} has a call site now: remove it from AWAITING_CALL_SITES`).toBe(false);
    }
  });

  it("lists exactly the value arguments the simulation uses (no stale entries)", () => {
    const seen = Object.fromEntries([...valueArgumentsSeen].map(([file, args]) => [file, [...args].sort()]));
    const listed = Object.fromEntries(Object.entries(VALUE_ARGUMENTS).map(([file, args]) => [file, [...args].sort()]));
    expect(seen).toEqual(listed);
  });

  it("accepts only literal tags, listed variable tags, ID-shaped arguments and listed values", () => {
    // The #204 follow-up: a bare variable is not taken for an ID any more.
    expect(() => familiesAt("logistics/logistics.ts", ['"DISPATCH"', "d", "outcome"])).toThrow(/can't tell whether d is a tag/);
    expect(() => familiesAt("logistics/logistics.ts", ['"DISPATCH"', "delivery.id", "outcome"])).toThrow(/can't tell whether outcome is a tag/);
    expect(() => familiesAt("logistics/logistics.ts", ['"DISPATCH"', "delivery.id", "day"])).toThrow(/day/); // listed for another file only
    expect(familiesAt("logistics/logistics.ts", ['"DISPATCH"', "delivery.id", '"CLEAR"'])).toEqual(["DISPATCH:CLEAR"]);
    expect(familiesAt("economy/market/market.ts", ['"DAILY_SETTLEMENT"', '"DEAL_EXPIRED"', "deal.id"])).toEqual(["DAILY_SETTLEMENT:DEAL_EXPIRED"]);
    expect(familiesAt("economy/market/market.ts", ['"DAILY_SETTLEMENT"', '"MARKET"', "day"])).toEqual(["DAILY_SETTLEMENT:MARKET"]);
  });

  it("every family's first tag is a transaction kind", () => {
    const kinds: readonly TransactionKind[] = [
      "OPENING_BALANCE", "MATERIAL_PURCHASE", "PRODUCTION", "PRODUCTION_WRITE_OFF", "PRODUCTION_START", "EQUIPMENT_PURCHASE",
      "DISPATCH", "SALE", "TRANSFER", "CARGO_LOSS", "DAILY_SETTLEMENT", "INSTALLMENT_SETTLEMENT",
      "RESERVATION", "ASSET_SALE", "VEHICLE_RETURN", "LOSS", "PROGRESSION", "TELEPHONE", "LODGING",
    ];
    for (const family of Object.keys(TRANSACTION_PRODUCERS)) expect(kinds, family).toContain(family.split(":")[0]);
  });
});

describe("transactionProducerOf", () => {
  it.each([
    [idempotencyKey("SALE", "delivery-3"), "SALE"],
    [idempotencyKey("DISPATCH", "delivery-3"), "DISPATCH"],
    [idempotencyKey("DISPATCH", "delivery-3", "CLEAR"), "DISPATCH:CLEAR"],
    [idempotencyKey("DAILY_SETTLEMENT", "PAYROLL", 4), "DAILY_SETTLEMENT:PAYROLL"],
    [idempotencyKey("DAILY_SETTLEMENT", "CONTRACT_OFFER_EXPIRED", "offer-2"), "DAILY_SETTLEMENT:CONTRACT_OFFER_EXPIRED"],
    [idempotencyKey("PRODUCTION_START", "job-4"), "PRODUCTION_START"],
    [idempotencyKey("RESERVATION", "res-7", "RELEASE"), "RESERVATION:RELEASE"],
    [idempotencyKey("LOSS", "SHAKEDOWN", "RIVAL", 12_000, 3), "LOSS:SHAKEDOWN"],
    [idempotencyKey("EQUIPMENT_PURCHASE", "distillery-main", "copper-still", "cmd-9"), "EQUIPMENT_PURCHASE"],
    [idempotencyKey("PROGRESSION", "VICTORY"), "PROGRESSION:VICTORY"],
  ])("%s → %s", (key, producer) => {
    expect(transactionProducerOf(key)).toBe(producer);
  });

  it("returns null for an unknown family", () => {
    expect(transactionProducerOf("BRIBE:sheriff")).toBeNull();
    expect(transactionProducerOf("")).toBeNull();
  });
});
