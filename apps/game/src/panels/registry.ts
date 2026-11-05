// Every management panel: id, title, and component. The shell's navigation
// and `openPanel` / `openPanelForLocation` use these ids.
//
// Market is a placeholder until T04c (#50), which also adds Contracts and
// Facility.

import type { GameSnapshot, LocationId, LocationOccupant } from "@eov/contracts";
import { createElement, type ComponentType } from "react";
import { PanelPlaceholder } from "../components/panel-placeholder.tsx";
import type { PanelId } from "../state/ui-store.ts";
import { DASHBOARD_COPY } from "./dashboard/copy.ts";
import { DashboardPanel } from "./dashboard/dashboard-panel.tsx";
import { FINANCE_COPY } from "./finance/copy.ts";
import { FinancePanel } from "./finance/finance-panel.tsx";
import { PRODUCTION_COPY } from "./production/copy.ts";
import { ProductionPanel } from "./production/production-panel.tsx";

export interface PanelProps {
  /** The latest snapshot. Panels render from it alone. */
  readonly snapshot: GameSnapshot;
}

export interface PanelDefinition {
  readonly id: PanelId;
  readonly title: string;
  readonly component: ComponentType<PanelProps>;
}

/** PLACEHOLDER copy (story decision): the Market panel's title, until T04c gives it a copy.ts. */
const MARKET_TITLE = "Market";

const MarketPlaceholder: ComponentType<PanelProps> = () => createElement(PanelPlaceholder, { title: MARKET_TITLE });

export const PANELS: readonly PanelDefinition[] = [
  { id: "dashboard", title: DASHBOARD_COPY.title, component: DashboardPanel },
  { id: "production", title: PRODUCTION_COPY.title, component: ProductionPanel },
  { id: "finance", title: FINANCE_COPY.title, component: FinancePanel },
  { id: "market", title: MARKET_TITLE, component: MarketPlaceholder },
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
