// The First Hire's placeholder shell (SK2a, #174). Under founder rules the
// M001 panels aren't shown (they read the world snapshot, which never reaches
// the UI now). Until SK2b (#234) brings the map token, the place scenes, the
// ledger and the HUD, this shows that the game runs: the time, where the
// founder is, the purse, and the activity feed's length, all from the player
// snapshot (ADR 0021 decision 8). The fast-forward note reads the scheduler
// status (ADR 0023 decision 9).

import { formatMoney, type PlayerSnapshot } from "@eov/contracts";
import { THE_FIRST_HIRE_SCENARIO } from "@eov/game-data";
import { formatGameDate } from "../../components/format.ts";
import type { SchedulerStatus } from "../../workers/scheduler.ts";
import { FOUNDER_COPY } from "./copy.ts";

/** Where the founder is and what they're doing, in words, from always-known state. */
export function describeFounder(player: PlayerSnapshot): string {
  const placeName = (id: string): string => player.places.find((p) => p.id === id)?.name ?? id;
  const w = player.founder.whereabouts;
  const says = FOUNDER_COPY.whereabouts;
  switch (w.kind) {
    case "PRESENT":
      return w.busy === null ? says.PRESENT(placeName(w.locationId)) : says.BUSY(placeName(w.locationId));
    case "TRAVELLING":
      return says.TRAVELLING(placeName(w.destinationLocationId));
    case "ON_DELIVERY":
      return says.ON_DELIVERY();
    case "RESTING":
      return says.RESTING(placeName(w.locationId));
  }
}

export function FounderShell({ player, scheduler }: { readonly player: PlayerSnapshot; readonly scheduler: SchedulerStatus }) {
  return (
    <section className="founder-shell" data-testid="founder-shell" aria-label={FOUNDER_COPY.statusLabel}>
      <p className="founder-shell-note">{FOUNDER_COPY.placeholder(THE_FIRST_HIRE_SCENARIO.name)}</p>
      <dl className="founder-shell-facts">
        <dt>{FOUNDER_COPY.time}</dt>
        <dd data-testid="founder-time">{formatGameDate(player.clock.date)}</dd>
        <dt>{FOUNDER_COPY.founder}</dt>
        <dd data-testid="founder-status" data-kind={player.founder.whereabouts.kind}>
          {describeFounder(player)}
        </dd>
        <dt>{FOUNDER_COPY.cash}</dt>
        <dd data-testid="founder-cash">{formatMoney(player.finance.cash)}</dd>
        <dt>{FOUNDER_COPY.activity}</dt>
        <dd data-testid="founder-activity">{player.activity.length}</dd>
      </dl>
      {scheduler.fastForward && (
        <p role="status" className="banner banner-notice" data-testid="fast-forward">
          {FOUNDER_COPY.fastForward}
        </p>
      )}
    </section>
  );
}
