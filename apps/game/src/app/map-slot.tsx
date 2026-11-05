// The map slot: where the map sits in the shell. For now it draws S0's
// placeholder SVG map (src/map/placeholder-map.ts, unchanged) on every
// snapshot, registers its `scene` query for the test hook, and turns clicks on
// a location's shape into `openPanelForLocation`. T04b takes this file over
// for the PixiJS map.

import type { GameSnapshot, LocationSnapshot } from "@eov/contracts";
import { useEffect, useRef, type MouseEvent } from "react";
import { SHELL_COPY } from "../components/copy.ts";
import { renderMap, type SceneShape } from "../map/placeholder-map.ts";
import { useUi } from "../state/app-context.tsx";
import { registerMap } from "./test-hook.ts";

function occupantId(location: LocationSnapshot): string {
  const o = location.occupant;
  return o.kind === "FACILITY" ? o.facilityId : o.kind === "SUPPLIER" ? o.supplierId : o.buyerId;
}

export function MapSlot({ snapshot }: { readonly snapshot: GameSnapshot }) {
  const svg = useRef<SVGSVGElement>(null);
  const scene = useRef<readonly SceneShape[]>([]);
  const openPanelForLocation = useUi((s) => s.openPanelForLocation);

  useEffect(() => {
    registerMap({ scene: () => scene.current });
  }, []);

  useEffect(() => {
    if (!svg.current) return;
    scene.current = renderMap(svg.current, snapshot);
    // Lets tests wait until the map has drawn a given tick.
    svg.current.dataset["tick"] = String(snapshot.clock.tick);
  }, [snapshot]);

  const onClick = (event: MouseEvent<SVGSVGElement>) => {
    const shape = (event.target as Element).closest("[data-shape]");
    const kind = shape?.getAttribute("data-shape")?.toUpperCase();
    const id = shape?.getAttribute("data-id");
    const location = snapshot.locations.find((l) => l.occupant.kind === kind && occupantId(l) === id);
    if (location) openPanelForLocation(location.id);
  };

  return <svg ref={svg} data-testid="map" width={640} role="img" aria-label={SHELL_COPY.mapLabel} onClick={onClick} />;
}
