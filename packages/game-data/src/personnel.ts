// S0 stub: extended by T02c (PROD-001 workforce, GDD §14.3 wages). Definition types per ADR 0012.
// PLACEHOLDER values. Not used on the Sprint Zero path: wages and daily settlement
// arrive with T02b/T02c.

import { asId, cents, type CharacterId, type Money } from "@eov/contracts";

export interface CharacterDefinition {
  readonly id: CharacterId;
  readonly name: string;
  readonly role: "FOUNDER" | "FOREMAN";
  readonly dailyWage: Money;
}

export interface WorkforceDefinition {
  /** Daily wage of one generic worker. */
  readonly workerDailyWage: Money;
}

export const CHARACTERS: readonly CharacterDefinition[] = [
  { id: asId("Character", "thomas-kerrigan"), name: "Thomas Kerrigan", role: "FOUNDER", dailyWage: cents(0) }, // PLACEHOLDER
  { id: asId("Character", "walt-hagen"), name: "Walt Hagen", role: "FOREMAN", dailyWage: cents(300) }, // PLACEHOLDER
];

export const WORKFORCE: WorkforceDefinition = {
  workerDailyWage: cents(200), // PLACEHOLDER
};
