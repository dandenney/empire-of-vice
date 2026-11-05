// State lists of simulation-created records use the shared ID order (issue #34):
// `res-9` before `res-10`, which plain text order gets wrong.

import { asId, compareIds, DYNAMIC_ID_PREFIXES, type ReservationState } from "@eov/contracts";
import { CORN, DISTILLERY_MAIN } from "@eov/game-data";
import { describe, expect, it } from "vitest";
import { newGame } from "../../src/game/index.ts";
import { addReservation } from "../../src/inventory/index.ts";
import { ID_PREFIXES } from "../../src/kernel/ids.ts";

const reservation = (n: number): ReservationState => ({
  id: asId("Reservation", `res-${n}`),
  facilityId: DISTILLERY_MAIN,
  goods: { kind: "MATERIAL", materialId: CORN },
  quantity: 1,
  holder: { kind: "PRODUCTION_JOB", jobId: asId("ProductionJob", `job-${n}`) },
});

describe("ID order in state", () => {
  it("mints IDs with the prefixes compareIds recognizes", () => {
    expect(ID_PREFIXES).toEqual(DYNAMIC_ID_PREFIXES);
  });

  it("keeps reservations in compareIds order, not text order", () => {
    let state = newGame().state;
    for (const n of [10, 9, 2, 100]) state = addReservation(state, reservation(n));
    const ids = state.reservations.map((r) => r.id);
    expect(ids).toEqual(["res-2", "res-9", "res-10", "res-100"]);
    expect(ids).toEqual([...ids].sort(compareIds));
    expect(ids).not.toEqual([...ids].sort());
  });
});
