// Simple line icons (#48): 20-unit grid, 1.5 stroke, currentColor. Decorative
// only (aria-hidden): whatever they sit in carries the accessible name.

import type { ReactNode } from "react";
import type { ToastTone } from "./toasts/toast-view.ts";

function Icon({ children, size = 20 }: { readonly children: ReactNode; readonly size?: number }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/** A dial: the overview. */
export const DashboardIcon = () => (
  <Icon>
    <path d="M3.5 13.5a6.5 6.5 0 1 1 13 0" />
    <path d="M10 13.5l3.2-4" />
    <path d="M3 16.5h14" />
  </Icon>
);

/** A still: pot, column, and coil. */
export const ProductionIcon = () => (
  <Icon>
    <path d="M4 16.5h7" />
    <path d="M5 16.5v-5a2.5 2.5 0 0 1 5 0v5" />
    <path d="M7.5 9V5.5h5.5v3" />
    <path d="M13 8.5c2 0 2.5 1 2.5 2s-1.5 1-1.5 2 1.5 1 1.5 2-0.5 2-2 2" />
  </Icon>
);

/** A ledger book. */
export const FinanceIcon = () => (
  <Icon>
    <path d="M5 3.5h10v13H5a1.5 1.5 0 0 1-1.5-1.5V5A1.5 1.5 0 0 1 5 3.5z" />
    <path d="M7 7h5.5M7 9.5h5.5M7 12h3" />
  </Icon>
);

/** A market stall. */
export const MarketIcon = () => (
  <Icon>
    <path d="M3 7.5l1.5-4h11l1.5 4" />
    <path d="M3 7.5c0 1.2 1 2 2.3 2s2.4-.8 2.4-2c0 1.2 1 2 2.3 2s2.3-.8 2.3-2c0 1.2 1 2 2.4 2S17 8.7 17 7.5" />
    <path d="M4.5 9.5v7h11v-7" />
    <path d="M8.5 16.5v-4h3v4" />
  </Icon>
);

/** A signed agreement: a page with lines and a signature flourish. */
export const ContractsIcon = () => (
  <Icon>
    <path d="M5 2.5h7.5l2.5 2.5v12.5H5z" />
    <path d="M12.5 2.5V5H15" />
    <path d="M7.5 7.5h5M7.5 10h5" />
    <path d="M7.5 14.5c1-1.5 1.8-1.5 2.2 0s1.2 1.5 2.8-.5" />
  </Icon>
);

/** A works: a sawtooth roof over a wide door. */
export const FacilityIcon = () => (
  <Icon>
    <path d="M2.5 16.5h15" />
    <path d="M3.5 16.5V8l4 2.5V8l4 2.5V8l5 3v5.5" />
    <path d="M8 16.5v-3.5h4v3.5" />
  </Icon>
);

/** Fallback for a panel without its own icon. */
export const PanelIcon = () => (
  <Icon>
    <rect x="3.5" y="3.5" width="13" height="13" rx="1" />
    <path d="M3.5 7.5h13" />
  </Icon>
);

export const CloseIcon = () => (
  <Icon size={14}>
    <path d="M5 5l10 10M15 5L5 15" />
  </Icon>
);

/** Good news: a check. Bad news: a warning sign. Neutral: a dot in a ring. */
export function ToneIcon({ tone }: { readonly tone: ToastTone }) {
  return (
    <span className="toast-icon">
      {tone === "good" ? (
        <Icon size={16}>
          <circle cx="10" cy="10" r="7" />
          <path d="M6.8 10.2l2.2 2.2 4.2-4.6" />
        </Icon>
      ) : tone === "bad" ? (
        <Icon size={16}>
          <path d="M10 3l7.5 13.5h-15z" />
          <path d="M10 8.5v3.5M10 14.3v.2" />
        </Icon>
      ) : (
        <Icon size={16}>
          <circle cx="10" cy="10" r="7" />
          <circle cx="10" cy="10" r="1.5" />
        </Icon>
      )}
    </span>
  );
}

/** Pause bars, for the pause button. */
export const PauseIcon = () => (
  <Icon size={14}>
    <path d="M7 4.5v11M13 4.5v11" />
  </Icon>
);

/** The rail icon for each panel id in the registry. */
export const PANEL_ICONS: Readonly<Record<string, () => ReactNode>> = {
  dashboard: DashboardIcon,
  production: ProductionIcon,
  finance: FinanceIcon,
  market: MarketIcon,
  contracts: ContractsIcon,
  facility: FacilityIcon,
};
