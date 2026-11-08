// Stands in for a panel another task builds (Market, Contracts, Facility: T04c #50).

import { COMMON_COPY } from "./copy.ts";

export function PanelPlaceholder({ title }: { readonly title: string }) {
  return (
    <section className="panel" aria-label={title}>
      <h2 className="panel-title">{title}</h2>
      <p className="panel-empty" data-testid="panel-placeholder">
        {COMMON_COPY.comingSoon(title)}
      </p>
    </section>
  );
}
