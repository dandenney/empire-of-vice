// #136: EQUIPMENT_SOLD is a log event, but the #99 sign-off gives it a
// notification: "Sold {equipmentName} for {amount}.", from the event.

import { asId, cents, formatMoney, tick, type GameEvent } from "@eov/contracts";
import { ids, midGameSnapshot } from "@eov/contracts/fixtures";
import { describe, expect, it } from "vitest";
import { toastsFor } from "../../../src/ui/toasts/toast-view.ts";

const sold = (equipmentId: string): GameEvent => ({
  id: asId("Event", `evt-sold-${equipmentId}`),
  tick: tick(10),
  causedBy: asId("Command", "cmd-1"),
  type: "EQUIPMENT_SOLD",
  facilityId: ids.distillery,
  equipmentId: asId("Equipment", equipmentId),
  bookValue: cents(30_000),
  proceeds: cents(15_000),
  transactionId: asId("Transaction", "txn-1"),
});

describe("EQUIPMENT_SOLD toast", () => {
  it("uses the #99 line, with the name from the snapshot and the proceeds from the event", () => {
    const [toast] = toastsFor([sold(ids.copperStill)], midGameSnapshot);
    expect(toast).toMatchObject({ eventType: "EQUIPMENT_SOLD", body: `Sold Copper still for ${formatMoney(cents(15_000))}.` });
  });

  it("finds the name among the items on offer once the sold one has left the owned list", () => {
    const [toast] = toastsFor([sold(ids.condenser)], midGameSnapshot);
    const name = midGameSnapshot.facilities[0]!.equipmentOptions.find((o) => o.equipmentId === ids.condenser)!.name;
    expect(toast!.body).toBe(`Sold ${name} for $150.00.`);
  });

  it("falls back to the id when the snapshot has no such item", () => {
    expect(toastsFor([sold("mystery-kit")], midGameSnapshot)[0]!.body).toBe("Sold mystery-kit for $150.00.");
  });

  it("one toast per event, however the batch is delivered", () => {
    expect(toastsFor([sold(ids.copperStill), { ...sold(ids.copperStill), id: asId("Event", "evt-other"), type: "MARKET_UPDATED", dayIndex: 1 } as GameEvent], midGameSnapshot)).toHaveLength(1);
  });
});
