// Telephones, calls in, messages and arrangements (ADR 0024, as amended by
// ADR 0027). Definition types per ADR 0012, built from contract primitives.
//
// Which places have phones, and who may use them or leave word there, is the
// human's decision on #203 (ADR 0027 decision 2). Every number is PLACEHOLDER
// tuning for the playtests (R1, PT3, T-LAB).
//
// Read only with `founderRules: true`; the phone behaviour is C1's (#179). The
// M001 scenario plays exactly as before.
//
// Validated when this module loads, like the presence and knowledge tables: a bad
// table throws PhoneDataError before any game starts.

import {
  ARRANGEMENT_PRIVILEGES,
  cents,
  compareIds,
  TICKS_PER_DAY,
  type ArrangementPrivilege,
  type CallInReason,
  type LocationId,
  type Money,
  type PartyKind,
  type SubjectKind,
  type UnlockId,
} from "@eov/contracts";
import { KNOWLEDGE_VISIBILITY } from "./knowledge.ts";
import { KESSLER_PHARMACY, LAKEVIEW, LOCATIONS, MILLERS_FEED_LOCATION, RIVERSIDE_DEPOT, type LocationDefinition } from "./map.ts";
import { hoursIntervalsProblem, LAKEVIEW_LOBBY_HOURS, ROOMS, type PlaceHoursInterval, type RoomDefinition } from "./presence.ts";
import { SUPPLIERS, type SupplierDefinition } from "./suppliers.ts";

export class PhoneDataError extends Error {
  override readonly name = "PhoneDataError";
}

// ---------------------------------------------------------------------------
// Phones at places (ADR 0027 decisions 1 and 2)
// ---------------------------------------------------------------------------

/** Whether, and on what basis, the founder may call out from a phone (privilege 2). */
export type PhoneUseRule =
  /** Anyone, during the phone's hours. A connected call costs `fee` instead of CALL_COST. */
  | { readonly kind: "PUBLIC"; readonly fee: Money }
  /** A guest: the founder holds a room here (ROOMS). */
  | { readonly kind: "GUEST" }
  /** The keeper lets the founder use it under the place's arrangement (ARRANGEMENTS). */
  | { readonly kind: "ARRANGEMENT" }
  /** The keeper's own line. Never the founder's to use. */
  | { readonly kind: "PRIVATE" };

/** Whether the keeper takes messages for the family (privilege 3). */
export type MessageTakingRule = "NEVER" | "ARRANGEMENT";

export interface PhoneDefinition {
  /** Privilege 1: the place has a phone. At most one entry per location. */
  readonly locationId: LocationId;
  /**
   * When it can be used, answered, or take a message: minute-of-day intervals,
   * as in PLACE_HOURS. null: the place's PLACE_HOURS (always, if it has none).
   */
  readonly hours: readonly PlaceHoursInterval[] | null;
  readonly use: PhoneUseRule;
  readonly messages: MessageTakingRule;
}

/** The phones at places, sorted by location ID (ADR 0027 decision 2). The places and privileges are #203's; the fee is PLACEHOLDER. */
const PHONE_ENTRIES: readonly PhoneDefinition[] = [
  // Kessler's private business line: he answers for business; the founder gets no use of it.
  { locationId: KESSLER_PHARMACY, hours: null, use: { kind: "PRIVATE" }, messages: "NEVER" },
  // The lobby/guest phone, on the lobby's hours, not the back room's 20:00–02:00.
  { locationId: LAKEVIEW, hours: LAKEVIEW_LOBBY_HOURS, use: { kind: "GUEST" }, messages: "NEVER" },
  // Miller's business phone: use and message-taking are both earned (ARRANGEMENTS).
  { locationId: MILLERS_FEED_LOCATION, hours: null, use: { kind: "ARRANGEMENT" }, messages: "ARRANGEMENT" },
  // The depot's public phone, during the depot's hours (always open), for a fee. PLACEHOLDER 10¢.
  { locationId: RIVERSIDE_DEPOT, hours: null, use: { kind: "PUBLIC", fee: cents(10) }, messages: "NEVER" },
  // The Crossroads: no phone. Hollow Creek: none until INSTALL_PHONE (ADR 0024 decision 2).
];
export const PHONES: readonly PhoneDefinition[] = [...PHONE_ENTRIES].sort((a, b) => compareIds(a.locationId, b.locationId));

// ---------------------------------------------------------------------------
// The family's own line (ADR 0024 decision 2)
// ---------------------------------------------------------------------------

export interface PhoneLineDefinition {
  /** Paid at installation; the line's book value. */
  readonly price: Money;
  readonly requiredUnlockId: UnlockId | null;
}

/** PLACEHOLDER: $50, no unlock needed. */
export const PHONE_LINE: PhoneLineDefinition = { price: cents(5_000), requiredUnlockId: null };

// ---------------------------------------------------------------------------
// Calls out and in (ADR 0024 decisions 3, 5 and 7)
// ---------------------------------------------------------------------------

/** What a connected call costs, except from a PUBLIC phone (its own fee). PLACEHOLDER: 5¢. */
export const CALL_COST: Money = cents(5);

/** The chance, in parts per million, that a party answers a call out while open (keyed draw). PLACEHOLDER. */
export const CALL_ANSWER_PPM: Readonly<Record<Exclude<PartyKind, "FACILITY">, number>> = { BUYER: 850_000, SUPPLIER: 900_000 };

export interface CallInRule {
  readonly partyKind: Exclude<PartyKind, "FACILITY">;
  readonly reason: CallInReason;
  /** The subject the trigger reads. Validated: in KNOWLEDGE_VISIBILITY.PHONE[partyKind] and .MESSAGE[partyKind]. */
  readonly subjectKind: SubjectKind;
  /** Chance per window while the trigger holds, in parts per million. */
  readonly chancePpm: number;
  /** INSTALLMENT_DUE only: how close the deadline must be. null for other reasons. */
  readonly withinTicks: number | null;
}

/** Why parties call the family. PLACEHOLDER tuning; suppliers have no rules in M002. */
export const CALL_IN_RULES: readonly CallInRule[] = [
  { partyKind: "BUYER", reason: "NEW_CONTRACT_OFFER", subjectKind: "CONTRACT_OFFERS", chancePpm: 250_000, withinTicks: null },
  { partyKind: "BUYER", reason: "INSTALLMENT_DUE", subjectKind: "CONTRACT_PROGRESS", chancePpm: 250_000, withinTicks: 1_440 },
];

/** Calls in are tried once per window, on ticks that are a multiple of this. PLACEHOLDER: once an hour, on the hour. */
export const CALL_IN_INTERVAL_TICKS = 60;

/** Messages held per place; past it the oldest drops and is counted. PLACEHOLDER. */
export const MESSAGE_LIMIT = 10;

// ---------------------------------------------------------------------------
// Arrangements (ADR 0027 decision 3)
// ---------------------------------------------------------------------------

/** What counts as a dealing with a contact. M002: buying from the supplier at the place. */
export type DealingKind = "SUPPLY_PURCHASE";

export interface ArrangementDefinition {
  readonly locationId: LocationId;
  /** The contact's name, for copy ("left word with Miller"). */
  readonly contactName: string;
  readonly dealing: DealingKind;
  /** Dealing days needed for each privilege. Whole numbers of at least 1. */
  readonly dealingDaysNeeded: Readonly<Record<ArrangementPrivilege, number>>;
  /** The arrangement lapses when no dealing happens for longer than this. At least 2 × TICKS_PER_DAY. */
  readonly lapseTicks: number;
}

/** One entry per contact, sorted by location ID. */
export const ARRANGEMENTS: readonly ArrangementDefinition[] = [
  {
    locationId: MILLERS_FEED_LOCATION,
    contactName: "Miller", // #203
    dealing: "SUPPLY_PURCHASE",
    // PLACEHOLDER tuning: the first purchase earns the phone; three days of trade earn messages.
    dealingDaysNeeded: { PHONE_USE: 1, TAKES_MESSAGES: 3 },
    lapseTicks: 7 * TICKS_PER_DAY, // PLACEHOLDER: a week without buying
  },
];

// ---------------------------------------------------------------------------
// The bundle (ADR 0027 decision 17)
// ---------------------------------------------------------------------------

export interface PhoneData {
  readonly phones: readonly PhoneDefinition[]; // PHONES
  readonly phoneLine: PhoneLineDefinition; // PHONE_LINE
  readonly callCost: Money; // CALL_COST
  readonly callAnswerPpm: Readonly<Record<Exclude<PartyKind, "FACILITY">, number>>; // CALL_ANSWER_PPM
  readonly callInRules: readonly CallInRule[]; // CALL_IN_RULES
  readonly callInIntervalTicks: number; // CALL_IN_INTERVAL_TICKS
  readonly messageLimit: number; // MESSAGE_LIMIT
  readonly arrangements: readonly ArrangementDefinition[]; // ARRANGEMENTS
}

const PPM_SCALE = 1_000_000;

/**
 * Checks the phone tables (ADR 0024 decision 15, ADR 0027 decisions 1 and 3).
 * Returns them unchanged; throws PhoneDataError.
 * - PHONES: at most one entry per location, sorted by `compareIds`, at known
 *   locations; `hours`, if set, passes the place-hours interval checks; a PUBLIC
 *   fee is a whole number of cents of at least 1, so a connected call always
 *   posts a non-empty CASH leg; a GUEST phone's location has a ROOMS entry; an
 *   ARRANGEMENT rule, in `use` or `messages`, has an ARRANGEMENTS entry there.
 * - PHONE_LINE's price and CALL_COST are whole cents of at least 1.
 * - CALL_ANSWER_PPM and every rule's `chancePpm` are in 0..1 000 000.
 * - CALL_IN_RULES: each rule's subject is in both KNOWLEDGE_VISIBILITY.PHONE and
 *   .MESSAGE for its party kind (ADR 0024 decision 6); `withinTicks` is set (≥ 1)
 *   exactly for INSTALLMENT_DUE.
 * - CALL_IN_INTERVAL_TICKS and MESSAGE_LIMIT are whole numbers of at least 1.
 * - ARRANGEMENTS: one entry per location, sorted, at a location with a supplier
 *   (for SUPPLY_PURCHASE); thresholds are whole numbers of at least 1;
 *   `lapseTicks ≥ 2 × TICKS_PER_DAY`, so a founder who buys on every calendar day
 *   never lapses; `contactName` isn't empty.
 */
export function validatePhones(
  data: PhoneData,
  rooms: readonly RoomDefinition[] = ROOMS,
  locations: readonly LocationDefinition[] = LOCATIONS,
  suppliers: readonly SupplierDefinition[] = SUPPLIERS,
): PhoneData {
  const wholeAtLeast = (name: string, value: number, min: number) => {
    if (!Number.isSafeInteger(value) || value < min) throw new PhoneDataError(`${name} must be a whole number of at least ${min}, got ${value}`);
  };
  const ppm = (name: string, value: number) => {
    if (!Number.isSafeInteger(value) || value < 0 || value > PPM_SCALE) throw new PhoneDataError(`${name} must be a whole number in 0..${PPM_SCALE}, got ${value}`);
  };
  const sortedUnique = (table: readonly { readonly locationId: LocationId }[], name: string) => {
    table.forEach((entry, i) => {
      const previous = table[i - 1];
      if (previous && compareIds(previous.locationId, entry.locationId) >= 0) {
        throw new PhoneDataError(`${name} needs at most one entry per location, sorted by location ID`);
      }
    });
  };
  const known = new Set<string>(locations.map((l) => l.id));
  const arrangementAt = new Set<string>(data.arrangements.map((a) => a.locationId));

  sortedUnique(data.phones, "PHONES");
  for (const phone of data.phones) {
    const where = `PHONES.${phone.locationId}`;
    if (!known.has(phone.locationId)) throw new PhoneDataError(`PHONES: unknown location ${phone.locationId}`);
    if (phone.hours !== null) {
      const problem = hoursIntervalsProblem(phone.hours);
      if (problem !== null) throw new PhoneDataError(`${where}.hours: ${problem}`);
    }
    if (phone.use.kind === "PUBLIC") wholeAtLeast(`${where}.use.fee`, phone.use.fee, 1);
    if (phone.use.kind === "GUEST" && !rooms.some((r) => r.locationId === phone.locationId)) {
      throw new PhoneDataError(`${where}: a GUEST phone needs a ROOMS entry at its location`);
    }
    if ((phone.use.kind === "ARRANGEMENT" || phone.messages === "ARRANGEMENT") && !arrangementAt.has(phone.locationId)) {
      throw new PhoneDataError(`${where}: an ARRANGEMENT rule needs an ARRANGEMENTS entry at its location`);
    }
  }

  wholeAtLeast("PHONE_LINE.price", data.phoneLine.price, 1);
  wholeAtLeast("CALL_COST", data.callCost, 1);
  for (const [kind, value] of Object.entries(data.callAnswerPpm)) ppm(`CALL_ANSWER_PPM.${kind}`, value);

  data.callInRules.forEach((rule, i) => {
    const where = `CALL_IN_RULES[${i}] (${rule.partyKind} ${rule.reason})`;
    ppm(`${where}.chancePpm`, rule.chancePpm);
    for (const source of ["PHONE", "MESSAGE"] as const) {
      if (!KNOWLEDGE_VISIBILITY[source][rule.partyKind].includes(rule.subjectKind)) {
        throw new PhoneDataError(`${where}: ${rule.subjectKind} isn't in KNOWLEDGE_VISIBILITY.${source}.${rule.partyKind}`);
      }
    }
    if (rule.reason === "INSTALLMENT_DUE") {
      if (rule.withinTicks === null) throw new PhoneDataError(`${where}: INSTALLMENT_DUE needs withinTicks`);
      wholeAtLeast(`${where}.withinTicks`, rule.withinTicks, 1);
    } else if (rule.withinTicks !== null) {
      throw new PhoneDataError(`${where}: withinTicks is for INSTALLMENT_DUE only`);
    }
  });
  wholeAtLeast("CALL_IN_INTERVAL_TICKS", data.callInIntervalTicks, 1);
  wholeAtLeast("MESSAGE_LIMIT", data.messageLimit, 1);

  sortedUnique(data.arrangements, "ARRANGEMENTS");
  for (const arrangement of data.arrangements) {
    const where = `ARRANGEMENTS.${arrangement.locationId}`;
    if (!known.has(arrangement.locationId)) throw new PhoneDataError(`ARRANGEMENTS: unknown location ${arrangement.locationId}`);
    if (arrangement.dealing === "SUPPLY_PURCHASE" && !suppliers.some((s) => s.locationId === arrangement.locationId)) {
      throw new PhoneDataError(`${where}: SUPPLY_PURCHASE needs a supplier at the location`);
    }
    if (arrangement.contactName.trim() === "") throw new PhoneDataError(`${where}.contactName is empty`);
    for (const privilege of ARRANGEMENT_PRIVILEGES) wholeAtLeast(`${where}.dealingDaysNeeded.${privilege}`, arrangement.dealingDaysNeeded[privilege], 1);
    if (Object.keys(arrangement.dealingDaysNeeded).length !== ARRANGEMENT_PRIVILEGES.length) {
      throw new PhoneDataError(`${where}.dealingDaysNeeded has an unknown privilege`);
    }
    wholeAtLeast(`${where}.lapseTicks`, arrangement.lapseTicks, 2 * TICKS_PER_DAY);
  }
  return data;
}

/** The phone tables, validated. */
export const PHONE_DATA: PhoneData = validatePhones({
  phones: PHONES,
  phoneLine: PHONE_LINE,
  callCost: CALL_COST,
  callAnswerPpm: CALL_ANSWER_PPM,
  callInRules: CALL_IN_RULES,
  callInIntervalTicks: CALL_IN_INTERVAL_TICKS,
  messageLimit: MESSAGE_LIMIT,
  arrangements: ARRANGEMENTS,
});
