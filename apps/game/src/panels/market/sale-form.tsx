// A spot sale to one buyer (ADR 0005): which want to fill, the cases' quality
// and count, the truck, and the route (the shared route picker, #77). One click
// agrees the deal at the `agreedUnitPrice` the panel shows for the chosen want,
// then dispatches the truck against it (ADR 0022 decision 6, `useSale`), so a
// price that moved before the agreement applied comes back as QUOTE_CHANGED with
// both prices, never as a silent re-price.
//
// What's picked here (want, quality, truck, route, quantity) is form input, not
// game state. Every option and enabled state comes from the snapshot. The
// quality list holds nothing below the want's minimum, and defaults to that
// minimum, so the default agreed price is the chosen want's quote (#128).

import { formatMoney, type BuyerSnapshot, type GameSnapshot, type QualityTier, type RouteId, type VehicleId } from "@eov/contracts";
import { useState } from "react";
import { formatQuality } from "../../components/format.ts";
import { MoneyFigure } from "../../ui/ledger.tsx";
import { chosenRoute, commandRouteId, routeOptions } from "../../ui/route-picker/route-options.ts";
import { RoutePicker } from "../../ui/route-picker/route-picker.tsx";
import { MARKET_COPY as C } from "./copy.ts";
import { CommandResult } from "./command-result.tsx";
import { saleQualities } from "./market-view.ts";
import { useSale } from "./use-sale.ts";

const wantKey = (w: { readonly productId: string; readonly minimumQuality: QualityTier }) => `${w.productId}:${w.minimumQuality}`;

export function SaleForm({ buyer, snapshot }: { readonly buyer: BuyerSnapshot; readonly snapshot: GameSnapshot }) {
  const command = useSale(`sale:${buyer.id}`);
  const [wantPick, setWantPick] = useState<string | null>(null);
  const [qualityPick, setQualityPick] = useState<QualityTier | null>(null);
  const [vehiclePick, setVehiclePick] = useState<VehicleId | null>(null);
  const [routePick, setRoutePick] = useState<RouteId | null>(null);
  const [quantity, setQuantity] = useState("1");
  const testId = `sale-${buyer.id}`;

  const want = buyer.wants.find((w) => wantKey(w) === wantPick) ?? buyer.wants[0]!;
  const idle = snapshot.vehicles.filter((v) => v.trip === null);
  const vehicle = snapshot.vehicles.find((v) => v.id === vehiclePick) ?? idle[0] ?? snapshot.vehicles[0] ?? null;
  const home = vehicle ? snapshot.facilities.find((f) => f.locationId === vehicle.homeLocationId) : undefined;
  const qualities = saleQualities(home?.products ?? [], want);
  const quality = qualities.find((q) => q.quality === qualityPick)?.quality ?? want.minimumQuality;
  const options = vehicle ? routeOptions(snapshot.routes, vehicle.homeLocationId, buyer.locationId) : [];
  const route = chosenRoute(options, routePick);

  const canSend = !command.pending && buyer.willDeal && vehicle !== null && vehicle.trip === null && route !== null;
  const send = () => {
    if (!vehicle || !route) return;
    void command.sell({
      vehicleId: vehicle.id,
      buyerId: buyer.id,
      productId: want.productId,
      quality,
      quantity: Number(quantity),
      agreedUnitPrice: want.unitPrice,
      routeId: commandRouteId(route),
    });
  };

  return (
    <form
      className="sale-form"
      data-testid={testId}
      aria-label={C.sellTitle(buyer.name)}
      onSubmit={(e) => {
        e.preventDefault();
        if (canSend) send();
      }}
    >
      <h5 className="field-label sale-title">{C.sellTitle(buyer.name)}</h5>
      <div className="sale-fields">
        {buyer.wants.length > 1 && (
          <label className="sale-field">
            <span className="field-label">{C.wantChoice}</span>
            <select className="input market-select" value={wantKey(want)} onChange={(e) => setWantPick(e.target.value)} aria-label={C.wantChoiceLabel(buyer.name)} data-testid={`${testId}-want`}>
              {buyer.wants.map((w) => (
                <option key={wantKey(w)} value={wantKey(w)}>
                  {C.wantOption(C.wantLine(w.productName, formatQuality(w.minimumQuality)), formatMoney(w.unitPrice))}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="sale-field">
          <span className="field-label">{C.quality}</span>
          <select className="input market-select" value={quality} onChange={(e) => setQualityPick(e.target.value as QualityTier)} aria-label={C.qualityLabel(buyer.name)} data-testid={`${testId}-quality`}>
            {qualities.map(({ quality: q, pool }) => (
              <option key={q} value={q}>
                {pool ? C.qualityOption(formatQuality(q), pool.quantity, pool.reservedQuantity) : C.qualityNoStock(formatQuality(q))}
              </option>
            ))}
          </select>
        </label>
        <label className="sale-field">
          <span className="field-label">{C.cases}</span>
          <input
            type="number"
            className="input market-quantity"
            min={1}
            step={1}
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            aria-label={C.casesLabel(buyer.name)}
            data-testid={`${testId}-quantity`}
          />
        </label>
        <label className="sale-field">
          <span className="field-label">{C.truck}</span>
          {vehicle === null ? (
            <span className="market-note">{C.noTruck}</span>
          ) : (
            <select className="input market-select" value={vehicle.id} onChange={(e) => setVehiclePick(e.target.value as VehicleId)} aria-label={C.truckLabel(buyer.name)} data-testid={`${testId}-truck`}>
              {snapshot.vehicles.map((v) => (
                <option key={v.id} value={v.id} disabled={v.trip !== null}>
                  {v.trip === null ? C.truckOption(v.name, v.capacity) : C.truckBusy(v.name)}
                </option>
              ))}
            </select>
          )}
        </label>
      </div>
      <RoutePicker options={options} chosen={route} onPick={setRoutePick} tick={snapshot.clock.tick} name={`${testId}-route`} />
      <div className="market-action sale-action">
        <span className="sale-price">
          <span className="field-label">{C.agreedPrice}</span>{" "}
          <span data-testid={`${testId}-price`}>
            <MoneyFigure amount={want.unitPrice} />
          </span>
        </span>
        <button type="submit" className="button button-primary" disabled={!canSend} data-testid={`${testId}-dispatch`}>
          {C.dispatch}
        </button>
        <CommandResult command={command} testId={`${testId}-result`} />
      </div>
    </form>
  );
}
