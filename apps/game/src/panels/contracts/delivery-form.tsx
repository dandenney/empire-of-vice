// A contract delivery (GDD §7, ADR 0013): the cases' quality and count, the
// truck, and the route (the shared route picker, #50/#77). It sends
// DISPATCH_DELIVERY with purpose CONTRACT_INSTALLMENT. Which installment the
// cases count toward, and which reservations they draw on, is the
// simulation's call; the panel shows the result from the next snapshot.
//
// What's picked here is form input, not game state. Every option and enabled
// state comes from the snapshot. The default count is the contract's cases per
// delivery, from its terms.

import type { ContractSnapshot, GameSnapshot, QualityTier, RouteId, VehicleId } from "@eov/contracts";
import { useState } from "react";
import { formatQuality } from "../../components/format.ts";
import { useCommand } from "../../components/use-command.ts";
import { chosenRoute, commandRouteId, routeOptions } from "../../ui/route-picker/route-options.ts";
import { RoutePicker } from "../../ui/route-picker/route-picker.tsx";
import { CommandResult } from "./command-result.tsx";
import { CONTRACTS_COPY as C } from "./copy.ts";
import { buyerLocationId, deliveryQualities } from "./contracts-view.ts";

export function DeliveryForm({ contract, snapshot }: { readonly contract: ContractSnapshot; readonly snapshot: GameSnapshot }) {
  const command = useCommand(`contract-delivery:${contract.id}`);
  const [qualityPick, setQualityPick] = useState<QualityTier | null>(null);
  const [vehiclePick, setVehiclePick] = useState<VehicleId | null>(null);
  const [routePick, setRoutePick] = useState<RouteId | null>(null);
  const [quantity, setQuantity] = useState(String(contract.quantityPerInstallment));
  const testId = `deliver-${contract.id}`;

  const idle = snapshot.vehicles.filter((v) => v.trip === null);
  const vehicle = snapshot.vehicles.find((v) => v.id === vehiclePick) ?? idle[0] ?? snapshot.vehicles[0] ?? null;
  const home = vehicle ? snapshot.facilities.find((f) => f.locationId === vehicle.homeLocationId) : undefined;
  const qualities = deliveryQualities(home?.products ?? [], contract);
  const quality = qualities.find((q) => q.quality === qualityPick)?.quality ?? qualities[0]!.quality;
  const destination = buyerLocationId(snapshot, contract.buyerId);
  const options = vehicle && destination ? routeOptions(snapshot.routes, vehicle.homeLocationId, destination) : [];
  const route = chosenRoute(options, routePick);

  const canSend = !command.pending && vehicle !== null && vehicle.trip === null && route !== null;
  const send = () => {
    if (!vehicle || !route) return;
    void command.send({
      command: {
        type: "DISPATCH_DELIVERY",
        vehicleId: vehicle.id,
        cargo: [{ productId: contract.productId, quality, quantity: Number(quantity) }],
        purpose: { kind: "CONTRACT_INSTALLMENT", contractId: contract.id },
        routeId: commandRouteId(route),
        driver: { kind: "FOUNDER" },
      },
    });
  };

  return (
    <form
      className="contract-form"
      data-testid={testId}
      aria-label={C.deliverTitle(contract.buyerName)}
      onSubmit={(e) => {
        e.preventDefault();
        if (canSend) send();
      }}
    >
      <h5 className="field-label contract-form-title">{C.deliverTitle(contract.buyerName)}</h5>
      <div className="contract-fields">
        <label className="contract-field">
          <span className="field-label">{C.quality}</span>
          <select className="input contract-select" value={quality} onChange={(e) => setQualityPick(e.target.value as QualityTier)} aria-label={C.qualityLabel(contract.buyerName)} data-testid={`${testId}-quality`}>
            {qualities.map(({ quality: q, pool }) => (
              <option key={q} value={q}>
                {pool ? C.qualityOption(formatQuality(q), pool.quantity, pool.reservedQuantity) : C.qualityNoStock(formatQuality(q))}
              </option>
            ))}
          </select>
        </label>
        <label className="contract-field">
          <span className="field-label">{C.cases}</span>
          <input
            type="number"
            className="input contract-quantity"
            min={1}
            step={1}
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            aria-label={C.casesLabel(contract.buyerName)}
            data-testid={`${testId}-quantity`}
          />
        </label>
        <label className="contract-field">
          <span className="field-label">{C.truck}</span>
          {vehicle === null ? (
            <span className="contract-note">{C.noTruck}</span>
          ) : (
            <select className="input contract-select" value={vehicle.id} onChange={(e) => setVehiclePick(e.target.value as VehicleId)} aria-label={C.truckLabel(contract.buyerName)} data-testid={`${testId}-truck`}>
              {snapshot.vehicles.map((v) => (
                <option key={v.id} value={v.id} disabled={v.trip !== null}>
                  {v.trip === null ? C.truckOption(v.name, v.capacity) : C.truckBusy(v.name)}
                </option>
              ))}
            </select>
          )}
        </label>
      </div>
      {destination === null ? (
        <p className="contract-note">{C.noDestination}</p>
      ) : (
        <RoutePicker options={options} chosen={route} onPick={setRoutePick} tick={snapshot.clock.tick} name={`${testId}-route`} />
      )}
      <div className="contract-action contract-form-action">
        <button type="submit" className="button button-primary" disabled={!canSend} data-testid={`${testId}-dispatch`}>
          {C.dispatch}
        </button>
        <CommandResult command={command} testId={`${testId}-result`} />
      </div>
    </form>
  );
}
