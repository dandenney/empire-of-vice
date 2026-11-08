// The shared dispatch route picker (#50, #77): one radio per route to the
// destination, each with its name, Safe/Risky label, description, travel time,
// transport cost, and disruption chance. A closed route is shown closed, with
// its reopening time when known, and its radio is disabled, so it can't be
// picked. The Market panel's sales use it now; the Contracts panel (T04e) reuses it.
//
// The picker only reports the player's pick. Callers resolve what a dispatch
// would use with `chosenRoute` and send `commandRouteId` of it.

import type { RouteId } from "@eov/contracts";
import { MoneyFigure } from "../ledger.tsx";
import { ROUTE_PICKER_COPY as C } from "./copy.ts";
import { closureNote, formatRisk, formatTicks, type RouteOption } from "./route-options.ts";
import "./route-picker.css";

export interface RoutePickerProps {
  readonly options: readonly RouteOption[];
  /** The route a dispatch would use now (`chosenRoute`), or null if none is open. */
  readonly chosen: RouteOption | null;
  readonly onPick: (routeId: RouteId) => void;
  /** The snapshot's current tick, for "reopens in". */
  readonly tick: number;
  /** Radio group name and test-id prefix; unique on the page. */
  readonly name: string;
  readonly disabled?: boolean;
}

export function RoutePicker({ options, chosen, onPick, tick, name, disabled }: RoutePickerProps) {
  return (
    <fieldset className="route-picker" data-testid={name} disabled={disabled}>
      <legend className="field-label">{C.legend}</legend>
      {options.length === 0 ? (
        <p className="route-picker-note">{C.noRoutes}</p>
      ) : (
        <ul className="route-options">
          {options.map((option) => (
            <RouteChoice key={option.route.id} option={option} checked={chosen?.route.id === option.route.id} onPick={onPick} tick={tick} name={name} />
          ))}
        </ul>
      )}
      {options.length > 0 && chosen === null && (
        <p className="route-picker-note" role="status" data-testid={`${name}-none-open`}>
          {C.noOpenRoute}
        </p>
      )}
    </fieldset>
  );
}

function RouteChoice({ option, checked, onPick, tick, name }: { readonly option: RouteOption; readonly checked: boolean; readonly onPick: (routeId: RouteId) => void; readonly tick: number; readonly name: string }) {
  const { route, description, safety, open } = option;
  const testId = `${name}-${route.id}`;
  const notes = closureNote(route, tick);
  return (
    <li>
      <label className="route-option" data-safety={safety} data-open={open} data-checked={checked} data-testid={testId}>
        <input
          type="radio"
          className="route-radio"
          name={name}
          value={route.id}
          checked={checked}
          disabled={!open}
          onChange={() => onPick(route.id)}
          data-testid={`${testId}-radio`}
        />
        <span className="route-head">
          <span className="route-name">{route.name}</span>
          <span className="route-badges">
            <span className="route-badge" data-safety={safety} data-testid={`${testId}-safety`}>
              {safety === "SAFE" ? C.safe : C.risky}
            </span>
            {!open && (
              <span className="route-badge" data-closed="true" data-testid={`${testId}-closed`}>
                {C.closed}
              </span>
            )}
          </span>
        </span>
        {description !== null && (
          <span className="route-description" data-testid={`${testId}-description`}>
            {description}
          </span>
        )}
        <span className="route-facts">
          <span className="route-fact">
            <span className="route-fact-label">{C.travelTime}</span>
            <span className="route-fact-value" data-testid={`${testId}-time`}>
              {formatTicks(route.durationTicks)}
            </span>
          </span>
          <span className="route-fact">
            <span className="route-fact-label">{C.transportCost}</span>
            <span className="route-fact-value" data-testid={`${testId}-cost`}>
              <MoneyFigure amount={route.transportCost} />
            </span>
          </span>
          <span className="route-fact">
            <span className="route-fact-label">{C.risk}</span>
            <span className="route-fact-value" data-testid={`${testId}-risk`}>
              {formatRisk(route.riskPpm)}
            </span>
          </span>
        </span>
        {notes.length > 0 && (
          <span className="route-closure" data-testid={`${testId}-closure`}>
            {notes.join(" ")}
          </span>
        )}
      </label>
    </li>
  );
}
