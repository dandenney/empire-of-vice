// Stands in for a panel another task builds (Market, Contracts, Facility: T04c #50).

import { COMMON_COPY } from "./copy.ts";

export function PanelPlaceholder({ title }: { readonly title: string }) {
  return <p data-testid="panel-placeholder">{COMMON_COPY.comingSoon(title)}</p>;
}
