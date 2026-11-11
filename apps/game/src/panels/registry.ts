// Every management panel: id, title, and component. The shell's navigation
// and `openPanel` / `openPanelForLocation` use these ids.

import type { GameSnapshot, LocationId, LocationOccupant } from "@eov/contracts";
import type { ComponentType } from "react";
import type { PanelId } from "../state/ui-store.ts";
import { ACTIVITY_COPY } from "./activity/copy.ts";
import { ActivityPanel } from "./activity/activity-panel.tsx";
import { CONTRACTS_COPY } from "./contracts/copy.ts";
import { ContractsPanel } from "./contracts/contracts-panel.tsx";
import { DASHBOARD_COPY } from "./dashboard/copy.ts";
import { DashboardPanel } from "./dashboard/dashboard-panel.tsx";
import { FACILITY_COPY } from "./facility/copy.ts";
import { FacilityPanel } from "./facility/facility-panel.tsx";
import { FINANCE_COPY } from "./finance/copy.ts";
import { FinancePanel } from "./finance/finance-panel.tsx";
import { MARKET_COPY } from "./market/copy.ts";
import { MarketPanel } from "./market/market-panel.tsx";
import { PRODUCTION_COPY } from "./production/copy.ts";
import { ProductionPanel } from "./production/production-panel.tsx";
import { PROGRESSION_COPY } from "./progression/copy.ts";
import { ProgressionPanel } from "./progression/progression-panel.tsx";

export interface PanelProps {
  /** The latest snapshot. Panels render from it alone. */
  readonly snapshot: GameSnapshot;
}

export interface PanelDefinition {
  readonly id: PanelId;
  readonly title: string;
  readonly component: ComponentType<PanelProps>;
}

export const PANELS: readonly PanelDefinition[] = [
  { id: "dashboard", title: DASHBOARD_COPY.title, component: DashboardPanel },
  { id: "production", title: PRODUCTION_COPY.title, component: ProductionPanel },
  { id: "finance", title: FINANCE_COPY.title, component: FinancePanel },
  { id: "market", title: MARKET_COPY.title, component: MarketPanel },
  { id: "contracts", title: CONTRACTS_COPY.title, component: ContractsPanel },
  { id: "facility", title: FACILITY_COPY.title, component: FacilityPanel },
  { id: "progression", title: PROGRESSION_COPY.title, component: ProgressionPanel },
  { id: "activity", title: ACTIVITY_COPY.title, component: ActivityPanel },
];

export const DEFAULT_PANEL_ID: PanelId = "dashboard";

/** Which panel a map location opens, by what occupies it. */
export const PANEL_FOR_OCCUPANT: Readonly<Record<LocationOccupant["kind"], PanelId>> = {
  FACILITY: "production",
  SUPPLIER: "market",
  BUYER: "market",
};

export function panelById(id: PanelId): PanelDefinition | undefined {
  return PANELS.find((p) => p.id === id);
}

/** The panel for a location in this snapshot, or null if there's no snapshot or no such location. */
export function panelForLocation(snapshot: GameSnapshot | null, locationId: LocationId): PanelId | null {
  const location = snapshot?.locations.find((l) => l.id === locationId);
  return location ? PANEL_FOR_OCCUPANT[location.occupant.kind] : null;
}
