// Named hook points for the knowledge behaviour (SK1b, #199; ADR 0021 decisions
// 5 and 7). SK1a calls each one at the moment ADR 0023 names, and they change
// nothing yet. SK1b fills them in:
//
// - `founderDeparting`: every end of presence persists the live view at that
//   moment (ADR 0023 decision 2). By command: TRAVEL and REST, inside their
//   transactions. By tick: loading finishing and the founder riding out, in the
//   founder phase.
// - `founderArrived`: every arrival runs the arrival catch-up (decision 2a): a
//   TRAVEL destination, a halt at a closure (which also writes that route's
//   ROUTE_CONDITION record as IN_PERSON, decision 3), the truck's return, and a
//   delivery stop (observation, decision 2).
// - `founderWoke`: waking counts as an arrival (decision 2). At the rest's end
//   it runs in the founder phase; an early WAKE runs it inside its own command.
//
// Each takes and returns GameState so SK1b can write knowledge in place. They
// run only with founder rules on.

import type { GameState, LocationId, RouteId, Tick } from "@eov/contracts";

/** Why the founder stops being present. */
export type Departure = "TRAVEL" | "REST" | "DELIVERY";

/** How the founder came to be somewhere (or, for STOP, to observe there). */
export type Arrival =
  | { readonly kind: "DESTINATION" }
  | { readonly kind: "HALTED"; readonly routeId: RouteId }
  | { readonly kind: "RETURNED" }
  | { readonly kind: "STOP" };

/** The founder is about to leave `locationId` (still present there). SK1b: persist the live view. */
export const founderDeparting: (state: GameState, locationId: LocationId, why: Departure, tick: Tick) => GameState = (state) => state;

/** The founder arrived at (or, for STOP, observes at) `locationId`. SK1b: the arrival catch-up. */
export const founderArrived: (state: GameState, locationId: LocationId, how: Arrival, tick: Tick) => GameState = (state) => state;

/** The founder woke at `locationId`, `early` by WAKE. SK1b: the catch-up. */
export const founderWoke: (state: GameState, locationId: LocationId, early: boolean, tick: Tick) => GameState = (state) => state;
