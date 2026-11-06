// Leaders and the generic workforce (T02c2, issue #63; GDD §10; ADR 0017 decisions 7, 9, 10).
// Definition types per ADR 0012. The family's leaders are every character here.
// PLACEHOLDER values: T07a/T07 tune wages; skill and loyalty have no mechanical
// effect in M001.

import { asId, cents, type CharacterId, type Money } from "@eov/contracts";

export interface CharacterDefinition {
  readonly id: CharacterId;
  readonly name: string;
  readonly role: "FOUNDER" | "FOREMAN";
  /** 0–100. Shown in the snapshot; no mechanical effect in M001. */
  readonly skill: number;
  /** 0–100. Shown in the snapshot; no mechanical effect in M001. */
  readonly loyalty: number;
  /** Expensed at each midnight (ADR 0017 decision 9). */
  readonly dailyWage: Money;
}

export interface WorkforceDefinition {
  /** Daily wage of one generic worker, expensed at each midnight. */
  readonly workerDailyWage: Money;
}

export const CHARACTERS: readonly CharacterDefinition[] = [
  { id: asId("Character", "thomas-kerrigan"), name: "Thomas Kerrigan", role: "FOUNDER", skill: 60, loyalty: 100, dailyWage: cents(0) }, // PLACEHOLDER
  { id: asId("Character", "walt-hagen"), name: "Walt Hagen", role: "FOREMAN", skill: 55, loyalty: 70, dailyWage: cents(300) }, // PLACEHOLDER
];

export const WORKFORCE: WorkforceDefinition = {
  workerDailyWage: cents(200), // PLACEHOLDER
};
