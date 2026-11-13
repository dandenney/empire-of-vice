// The First Hire's founder-rules layout (SK2b, #234; replaces SK2a's
// placeholder shell). Everything is drawn from the player snapshot (ADR 0021
// decision 8, CLAUDE.md rule 7):
//
// - The stage (the map region): the map with the founder's token, or the scene
//   of the place the founder is at. Arriving somewhere (the snapshot's `here`
//   becoming that place, which includes waking there) opens its scene; leaving
//   the scene returns to the map, where picking a place travels there. Which
//   one shows is UI-only state.
// - The dock: the HUD (time, the founder's status, cash, the fast-forward) over
//   the ledger.

import type { LocationId, PlayerSnapshot } from "@eov/contracts";
import { useEffect, useRef, useState } from "react";
import { Hud } from "../../hud/hud.tsx";
import { LedgerPanel } from "../../ledger/ledger-panel.tsx";
import { PlaceScene } from "../../scenes/place-scene.tsx";
import type { SchedulerStatus } from "../../workers/scheduler.ts";
import { FounderMap } from "./founder-map.tsx";

export function FounderStage({ player }: { readonly player: PlayerSnapshot }) {
  const [open, setOpen] = useState<LocationId | null>(player.here);
  const previous = useRef(player.here);
  useEffect(() => {
    if (player.here === previous.current) return;
    previous.current = player.here;
    if (player.here !== null) setOpen(player.here);
  }, [player.here]);
  // Only the place the founder is at has a scene.
  const scene = open !== null && open === player.here ? open : null;
  return scene !== null ? (
    <PlaceScene key={scene} player={player} locationId={scene} onLeave={() => setOpen(null)} />
  ) : (
    <FounderMap player={player} onOpenScene={setOpen} />
  );
}

export function FounderDock({ player, scheduler, title }: { readonly player: PlayerSnapshot; readonly scheduler: SchedulerStatus; readonly title: string }) {
  return (
    <div className="founder-dock" data-testid="founder-shell">
      <Hud player={player} scheduler={scheduler} title={title} />
      <LedgerPanel player={player} />
    </div>
  );
}
