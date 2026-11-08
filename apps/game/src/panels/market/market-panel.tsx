// Market (ECO-001, GDD §4 and §7): the daily market report with each spot
// price explained, suppliers with PURCHASE_MATERIALS, buyers with their wants
// and a spot sale (DISPATCH_DELIVERY, purpose SALE, through the shared route
// picker), and REPEAT_OPERATION for the last purchase and the last sale.
//
// Every figure and every enabled state comes from the snapshot (ADR 0007).
// Flavor lines, shortage names, and route descriptions are game-data's static
// definitions (#81, #77; decision on #50). Quantities aren't clamped: a request
// the simulation rejects shows its typed reason.

import { formatMoney, type BuyerSnapshot, type FacilityId, type GameSnapshot, type SupplierSnapshot } from "@eov/contracts";
import { useEffect, useRef, useState } from "react";
import { COMMON_COPY } from "../../components/copy.ts";
import { formatQuality } from "../../components/format.ts";
import { useCommand } from "../../components/use-command.ts";
import { useUi } from "../../state/app-context.tsx";
import { LedgerTable, MoneyFigure } from "../../ui/ledger.tsx";
import type { PanelProps } from "../registry.ts";
import { MARKET_COPY as C } from "./copy.ts";
import { CommandResult } from "./command-result.tsx";
import { buyerFlavor, formatRatio, repeatOffers, shortageName, shortagesMoving, supplierFlavor, type RepeatOffer } from "./market-view.ts";
import { SaleForm } from "./sale-form.tsx";
import "./market.css";

const priceKey = (p: GameSnapshot["market"]["products"][number]) => `${p.productId}-${p.quality}`;
const wantRowKey = (testId: string, w: BuyerSnapshot["wants"][number]) => `${testId}-want-${w.productId}-${w.minimumQuality}`;

function RepeatRow({ kind, label, offer, note }: { readonly kind: "purchase" | "sale"; readonly label: string; readonly offer: RepeatOffer; readonly note?: string }) {
  const command = useCommand(`repeat-${kind}`);
  const repeat = () => command.send({ command: { type: "REPEAT_OPERATION", sourceCommandId: offer.sourceCommandId } });
  return (
    <li className="repeat" data-testid={`repeat-${kind}`}>
      <div className="repeat-text">
        <span className="field-label">{label}</span>
        <span className="repeat-line" data-testid={`repeat-${kind}-line`}>
          {offer.line}
        </span>
        {note !== undefined && <span className="market-note">{note}</span>}
      </div>
      <button type="button" className="button" onClick={repeat} disabled={command.pending} aria-label={C.repeatLabel(offer.line)} data-testid={`repeat-${kind}-button`}>
        {C.repeat}
      </button>
      <CommandResult command={command} testId={`repeat-${kind}-result`} />
    </li>
  );
}

function RepeatSection({ snapshot }: { readonly snapshot: GameSnapshot }) {
  const { purchase, sale } = repeatOffers(snapshot);
  if (!purchase && !sale) return null;
  return (
    <section aria-labelledby="market-repeat-title" data-testid="market-repeat">
      <h3 className="group-title" id="market-repeat-title">
        {C.repeatTitle}
      </h3>
      <ul className="repeats">
        {purchase && <RepeatRow kind="purchase" label={C.lastPurchase} offer={purchase} />}
        {sale && <RepeatRow kind="sale" label={C.lastSale} offer={sale} note={C.repeatSaleNote} />}
      </ul>
    </section>
  );
}

function PricesSection({ snapshot }: { readonly snapshot: GameSnapshot }) {
  const { market } = snapshot;
  return (
    <section aria-labelledby="market-prices-title">
      <h3 className="section-title" id="market-prices-title">
        {C.pricesTitle}
      </h3>
      {market.products.length === 0 ? (
        <p className="panel-empty">{C.noPrices}</p>
      ) : (
        <LedgerTable caption={C.pricesCaption(market.dayIndex)} className="ledger-columns market-prices" testId="market-prices">
          <thead>
            <tr>
              <th scope="col">{C.product}</th>
              <th scope="col" className="figure">
                {C.yesterday}
              </th>
              <th scope="col" className="figure">
                {C.today}
              </th>
            </tr>
          </thead>
          {market.products.map((p) => {
            const key = priceKey(p);
            const causes = shortagesMoving(snapshot, p.productId, p.quality);
            return (
              <tbody key={key} data-testid={`price-${key}`}>
                <tr>
                  <th scope="row">{C.productQuality(p.productName, formatQuality(p.quality))}</th>
                  <td className="figure" data-testid={`price-${key}-previous`}>
                    {p.previousSpotPrice === null ? <span className="money-none">{COMMON_COPY.none}</span> : <MoneyFigure amount={p.previousSpotPrice} />}
                  </td>
                  <td className="figure" data-testid={`price-${key}-spot`}>
                    <MoneyFigure amount={p.spotPrice} />
                  </td>
                </tr>
                <tr className="price-why">
                  <td colSpan={3} data-testid={`price-${key}-why`}>
                    {C.explanation(formatMoney(p.basePrice), formatRatio(p.demandRatioPpm), formatRatio(p.supplyRatioPpm), formatRatio(p.eventRatioPpm))}
                    {causes.length > 0 && (
                      <span className="price-cause" data-testid={`price-${key}-cause`}>
                        {C.eventCause(causes)}
                      </span>
                    )}
                  </td>
                </tr>
              </tbody>
            );
          })}
        </LedgerTable>
      )}
    </section>
  );
}

/** Scrolls a card into view when the map selects its location. */
function useSelected(locationId: string) {
  const selected = useUi((s) => s.selectedLocationId) === locationId;
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView?.({ block: "nearest" });
  }, [selected]);
  return { selected, ref };
}

function SupplierCard({ supplier, snapshot }: { readonly supplier: SupplierSnapshot; readonly snapshot: GameSnapshot }) {
  const facilities = snapshot.facilities.filter((f) => f.recipes.length > 0);
  const [facilityPick, setFacilityPick] = useState<FacilityId | null>(null);
  const facility = facilities.find((f) => f.id === facilityPick) ?? facilities[0] ?? null;
  const flavor = supplierFlavor(supplier.id);
  const { selected, ref } = useSelected(supplier.locationId);
  const testId = `supplier-${supplier.id}`;
  return (
    <article className="market-card" data-selected={selected} data-testid={testId} aria-labelledby={`${testId}-name`} ref={ref}>
      <h4 className="market-card-name" id={`${testId}-name`}>
        {supplier.name}
      </h4>
      {flavor !== null && (
        <p className="market-flavor" data-testid={`${testId}-flavor`}>
          {flavor}
        </p>
      )}
      {facility === null ? (
        <p className="panel-empty">{C.noFacility}</p>
      ) : (
        <label className="field market-deliver">
          <span className="field-label">{C.deliverTo}</span>
          <select className="input market-select" value={facility.id} onChange={(e) => setFacilityPick(e.target.value as FacilityId)} aria-label={C.deliverToLabel(supplier.name)} data-testid={`${testId}-facility`}>
            {facilities.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <ul className="market-lines">
        {supplier.materials.map((m) => (
          <MaterialRow key={m.materialId} supplier={supplier} material={m} facilityId={facility?.id ?? null} />
        ))}
      </ul>
    </article>
  );
}

function MaterialRow({ supplier, material, facilityId }: { readonly supplier: SupplierSnapshot; readonly material: SupplierSnapshot["materials"][number]; readonly facilityId: FacilityId | null }) {
  const command = useCommand(`purchase:${supplier.id}:${material.materialId}`);
  const [quantity, setQuantity] = useState("1");
  const testId = `material-${supplier.id}-${material.materialId}`;
  const shortage = material.shortage ? shortageName(supplier.id, material.materialId) : null;
  const buy = () => {
    if (facilityId === null) return;
    void command.send({
      command: { type: "PURCHASE_MATERIALS", supplierId: supplier.id, materialId: material.materialId, quantity: Number(quantity), facilityId },
    });
  };
  return (
    <li className="market-line" data-testid={testId}>
      <div className="market-line-head">
        <span className="market-line-name">{material.materialName}</span>
        {material.shortage && (
          <span className="market-badge" data-tone="bad" data-testid={`${testId}-shortage`}>
            {shortage === null ? C.shortage : C.shortageNamed(shortage)}
          </span>
        )}
      </div>
      <dl className="market-facts">
        <div>
          <dt>{C.price}</dt>
          <dd data-testid={`${testId}-price`}>
            <MoneyFigure amount={material.unitPrice} />
          </dd>
        </div>
        <div>
          <dt>{C.available}</dt>
          <dd className="market-figure" data-testid={`${testId}-available`}>
            {material.available}
          </dd>
        </div>
      </dl>
      <div className="market-action">
        <input
          type="number"
          className="input market-quantity"
          min={1}
          step={1}
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
          aria-label={C.buyQuantityLabel(material.materialName)}
          data-testid={`${testId}-quantity`}
        />
        <button type="button" className="button button-primary" onClick={buy} disabled={command.pending || facilityId === null} data-testid={`${testId}-buy`}>
          {C.buy}
        </button>
        <CommandResult command={command} testId={`${testId}-result`} />
      </div>
    </li>
  );
}

function BuyerCard({ buyer, snapshot }: { readonly buyer: BuyerSnapshot; readonly snapshot: GameSnapshot }) {
  const flavor = buyerFlavor(buyer.id);
  const { selected, ref } = useSelected(buyer.locationId);
  const testId = `buyer-${buyer.id}`;
  return (
    <article className="market-card" data-selected={selected} data-will-deal={buyer.willDeal} data-testid={testId} aria-labelledby={`${testId}-name`} ref={ref}>
      <h4 className="market-card-name" id={`${testId}-name`}>
        {buyer.name}
      </h4>
      {flavor !== null && (
        <p className="market-flavor" data-testid={`${testId}-flavor`}>
          {flavor}
        </p>
      )}
      <p className="market-deal" data-will-deal={buyer.willDeal} data-testid={`${testId}-deal`}>
        {buyer.willDeal ? C.willDeal : C.minimumReputation(buyer.minimumReputation, snapshot.family.reputation)}
      </p>
      <dl className="market-facts">
        <div>
          <dt>{C.budgetRemaining}</dt>
          <dd data-testid={`${testId}-budget`}>
            <MoneyFigure amount={buyer.budgetRemaining} />
          </dd>
        </div>
      </dl>
      {buyer.wants.length === 0 ? (
        <p className="panel-empty">{C.noWants}</p>
      ) : (
        <LedgerTable caption={C.wantsCaption} className="ledger-columns market-wants" testId={`${testId}-wants`}>
          <thead>
            <tr>
              <th scope="col">{C.want}</th>
              <th scope="col" className="figure">
                {C.unitPrice}
              </th>
              <th scope="col" className="figure">
                {C.demandRemaining}
              </th>
              <th scope="col" className="figure">
                {C.willTake}
              </th>
            </tr>
          </thead>
          <tbody>
            {buyer.wants.map((w) => {
              const key = wantRowKey(testId, w);
              return (
                <tr key={key} data-testid={key}>
                  <th scope="row">{C.wantLine(w.productName, formatQuality(w.minimumQuality))}</th>
                  <td className="figure" data-testid={`${key}-price`}>
                    <MoneyFigure amount={w.unitPrice} />
                  </td>
                  <td className="figure" data-testid={`${key}-demand`}>
                    {w.demandRemaining}
                  </td>
                  <td className="figure" data-testid={`${key}-max`}>
                    {w.maxAcceptableQuantity}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </LedgerTable>
      )}
      {buyer.wants.length > 0 && <SaleForm buyer={buyer} snapshot={snapshot} />}
    </article>
  );
}

export function MarketPanel({ snapshot }: PanelProps) {
  const { suppliers, buyers } = snapshot.market;
  return (
    <section className="panel" data-testid="panel-market" aria-labelledby="market-title">
      <h2 className="panel-title" id="market-title">
        {C.title}
      </h2>
      <p className="market-intro">{C.intro}</p>
      <RepeatSection snapshot={snapshot} />
      <PricesSection snapshot={snapshot} />
      <section aria-labelledby="market-suppliers-title">
        <h3 className="section-title" id="market-suppliers-title">
          {C.suppliersTitle}
        </h3>
        {suppliers.length === 0 ? <p className="panel-empty">{C.noSuppliers}</p> : suppliers.map((s) => <SupplierCard key={s.id} supplier={s} snapshot={snapshot} />)}
      </section>
      <section aria-labelledby="market-buyers-title">
        <h3 className="section-title" id="market-buyers-title">
          {C.buyersTitle}
        </h3>
        {buyers.length === 0 ? <p className="panel-empty">{C.noBuyers}</p> : buyers.map((b) => <BuyerCard key={b.id} buyer={b} snapshot={snapshot} />)}
      </section>
    </section>
  );
}
