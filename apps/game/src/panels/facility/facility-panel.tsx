// Facility (GDD §4 action 6, GDD §9, ADR 0017, ADR 0020 decision 9): each
// facility's storage and production capacity, its workforce with
// SET_WORKFORCE, its owned equipment with book and resale value and
// SELL_EQUIPMENT, and the equipment it could buy with PURCHASE_EQUIPMENT and
// each option's `blockedBy`. A LOCKED option names its unlock and the tier
// that grants it, with that tier's requirements, from the snapshot.
//
// Every figure and enabled state comes from the snapshot (ADR 0007). The crew
// count isn't clamped to the maximum: a request the simulation rejects shows
// its typed reason.

import { formatMoney, type EquipmentOption, type FacilitySnapshot, type GameSnapshot } from "@eov/contracts";
import { useState } from "react";
import { COMMON_COPY } from "../../components/copy.ts";
import { describeOutcome } from "../../components/format.ts";
import { useCommand, type CommandHandle } from "../../components/use-command.ts";
import { LedgerTable, MoneyFigure } from "../../ui/ledger.tsx";
import type { PanelProps } from "../registry.ts";
import { FACILITY_COPY as C } from "./copy.ts";
import { describeBlocker } from "./facility-view.ts";
import "./facility.css";

function CommandResult({ command, testId }: { readonly command: CommandHandle; readonly testId: string }) {
  return (
    <p role="status" className="facility-result" data-testid={testId}>
      {command.pending ? COMMON_COPY.pending : command.error ? command.error : command.outcome ? describeOutcome(command.outcome) : ""}
    </p>
  );
}

function WorkforceForm({ facility }: { readonly facility: FacilitySnapshot }) {
  const command = useCommand(`set-workforce:${facility.id}`);
  const [workers, setWorkers] = useState(String(facility.workforce.workers));
  const testId = `facility-${facility.id}-workforce`;
  const set = () => command.send({ command: { type: "SET_WORKFORCE", facilityId: facility.id, workerCount: Number(workers) } });
  return (
    <section aria-labelledby={`${testId}-title`} data-testid={testId}>
      <h4 className="group-title" id={`${testId}-title`}>
        {C.workforceTitle}
      </h4>
      <dl className="facility-facts">
        <div>
          <dt>{C.workers}</dt>
          <dd data-testid={`${testId}-workers`}>{C.workersLine(facility.workforce.workers, facility.workforce.maximum)}</dd>
        </div>
        <div>
          <dt>{C.wagePerWorker}</dt>
          <dd data-testid={`${testId}-wage`}>
            <MoneyFigure amount={facility.workforce.dailyWagePerWorker} />
          </dd>
        </div>
      </dl>
      <form
        className="facility-action"
        onSubmit={(e) => {
          e.preventDefault();
          if (!command.pending) void set();
        }}
      >
        <label className="field">
          <span className="field-label">{C.workersInput}</span>
          <input
            type="number"
            className="input facility-quantity"
            min={0}
            step={1}
            value={workers}
            onChange={(e) => setWorkers(e.target.value)}
            aria-label={C.workersLabel(facility.name)}
            data-testid={`${testId}-input`}
          />
        </label>
        <button type="submit" className="button button-primary" disabled={command.pending} data-testid={`${testId}-set`}>
          {C.setWorkforce}
        </button>
        <CommandResult command={command} testId={`${testId}-result`} />
      </form>
    </section>
  );
}

function OwnedRow({ facility, item }: { readonly facility: FacilitySnapshot; readonly item: FacilitySnapshot["equipment"][number] }) {
  const command = useCommand(`sell-equipment:${facility.id}:${item.id}`);
  const [confirming, setConfirming] = useState(false);
  const testId = `equipment-${facility.id}-${item.id}`;
  const price = formatMoney(item.resaleValue);
  const sell = () => {
    setConfirming(false);
    void command.send({ command: { type: "SELL_EQUIPMENT", facilityId: facility.id, equipmentId: item.id } });
  };
  return (
    <tbody data-testid={testId}>
      <tr>
        <th scope="row">{item.name}</th>
        <td className="figure" data-testid={`${testId}-book`}>
          <MoneyFigure amount={item.bookValue} />
        </td>
        <td className="figure" data-testid={`${testId}-resale`}>
          <MoneyFigure amount={item.resaleValue} />
        </td>
      </tr>
      <tr className="facility-row-action">
        <td colSpan={3}>
          <div className="facility-action">
            {confirming ? (
              <>
                <button type="button" className="button button-primary" onClick={sell} disabled={command.pending} aria-label={C.confirmSellLabel(item.name, price)} data-testid={`${testId}-confirm`}>
                  {C.confirmSell(price)}
                </button>
                <button type="button" className="button" onClick={() => setConfirming(false)} data-testid={`${testId}-cancel`}>
                  {C.cancel}
                </button>
              </>
            ) : (
              <button type="button" className="button" onClick={() => setConfirming(true)} disabled={command.pending} aria-label={C.sellLabel(item.name)} data-testid={`${testId}-sell`}>
                {C.sell}
              </button>
            )}
            <CommandResult command={command} testId={`${testId}-result`} />
          </div>
        </td>
      </tr>
    </tbody>
  );
}

function EquipmentSection({ facility }: { readonly facility: FacilitySnapshot }) {
  const testId = `facility-${facility.id}-equipment`;
  return (
    <section aria-labelledby={`${testId}-title`}>
      <h4 className="group-title" id={`${testId}-title`}>
        {C.equipmentTitle}
      </h4>
      <p className="facility-note" data-testid={`${testId}-slots`}>
        {C.slots(facility.equipmentSlots.used, facility.equipmentSlots.total)}
      </p>
      {facility.equipment.length === 0 ? (
        <p className="panel-empty" data-testid={`${testId}-none`}>
          {C.noEquipment}
        </p>
      ) : (
        <>
          <LedgerTable className="ledger-columns facility-owned" testId={testId}>
            <thead>
              <tr>
                <th scope="col">{C.equipment}</th>
                <th scope="col" className="figure">
                  {C.bookValue}
                </th>
                <th scope="col" className="figure">
                  {C.resaleValue}
                </th>
              </tr>
            </thead>
            {facility.equipment.map((item) => (
              <OwnedRow key={item.id} facility={facility} item={item} />
            ))}
          </LedgerTable>
          <p className="facility-note">{C.sellNote}</p>
        </>
      )}
    </section>
  );
}

function OptionCard({ facility, option, snapshot }: { readonly facility: FacilitySnapshot; readonly option: EquipmentOption; readonly snapshot: GameSnapshot }) {
  const command = useCommand(`purchase-equipment:${facility.id}:${option.equipmentId}`);
  const testId = `option-${facility.id}-${option.equipmentId}`;
  const buy = () => command.send({ command: { type: "PURCHASE_EQUIPMENT", facilityId: facility.id, equipmentId: option.equipmentId } });
  return (
    <li className="facility-option" data-blocked={option.blockedBy !== null} data-testid={testId}>
      <div className="facility-option-head">
        <span className="facility-option-name">{option.name}</span>
        <span className="facility-option-price" data-testid={`${testId}-price`}>
          <MoneyFigure amount={option.price} />
        </span>
      </div>
      <p className="facility-note">{option.description}</p>
      {option.blockedBy !== null && (
        <p className="facility-blocked" data-testid={`${testId}-blocked`}>
          <span className="field-label">{C.blockedBy}</span>{" "}
          {describeBlocker(snapshot, option.blockedBy).map((line, i) => (
            <span key={i} className="facility-blocked-line">
              {line}
            </span>
          ))}
        </p>
      )}
      <div className="facility-action">
        <button type="button" className="button button-primary" onClick={buy} disabled={command.pending || option.blockedBy !== null} aria-label={C.buyLabel(option.name)} data-testid={`${testId}-buy`}>
          {C.buy}
        </button>
        <CommandResult command={command} testId={`${testId}-result`} />
      </div>
    </li>
  );
}

function FacilitySection({ facility, snapshot }: { readonly facility: FacilitySnapshot; readonly snapshot: GameSnapshot }) {
  const testId = `facility-${facility.id}`;
  const { used, capacity } = facility.storage;
  return (
    <section className="facility-card" data-testid={`${testId}-manage`} aria-labelledby={`${testId}-manage-title`}>
      <h3 className="section-title" id={`${testId}-manage-title`}>
        {facility.name}
      </h3>
      <p className="facility-note" data-testid={`${testId}-kind`}>
        {C.kinds[facility.kind]}
      </p>
      <dl className="facility-facts">
        <div>
          <dt>{C.storage}</dt>
          <dd data-testid={`${testId}-storage`}>{C.storageLine(used, capacity)}</dd>
          <dd>
            <meter className="facility-meter" min={0} max={Math.max(capacity, 1)} value={used} aria-label={C.storageMeterLabel(facility.name)} data-testid={`${testId}-storage-meter`} />
          </dd>
        </div>
        <div>
          <dt>{C.capacity}</dt>
          <dd data-testid={`${testId}-capacity`}>{C.capacityLine(facility.productionCapacityPerDay)}</dd>
        </div>
      </dl>
      <WorkforceForm facility={facility} />
      <EquipmentSection facility={facility} />
      <h4 className="group-title">{C.optionsTitle}</h4>
      {facility.equipmentOptions.length === 0 ? (
        <p className="panel-empty">{C.noOptions}</p>
      ) : (
        <ul className="facility-options" data-testid={`${testId}-options`}>
          {facility.equipmentOptions.map((o) => (
            <OptionCard key={o.equipmentId} facility={facility} option={o} snapshot={snapshot} />
          ))}
        </ul>
      )}
    </section>
  );
}

export function FacilityPanel({ snapshot }: PanelProps) {
  return (
    <section className="panel" data-testid="panel-facility" aria-labelledby="facility-title">
      <h2 className="panel-title" id="facility-title">
        {C.title}
      </h2>
      {snapshot.facilities.length === 0 ? (
        <p className="panel-empty">{C.noFacilities}</p>
      ) : (
        snapshot.facilities.map((f) => <FacilitySection key={f.id} facility={f} snapshot={snapshot} />)
      )}
    </section>
  );
}
