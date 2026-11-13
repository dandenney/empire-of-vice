// The founder-rules map (SK2b, #234; GDD §18): the PixiJS map drawn from the
// player snapshot alone (map/player-scene.ts), with the founder as a token.
// The player picks a destination and the token travels: a click (or Enter) on
// a place opens a small travel card for it (walk there, or drive the truck if
// it's known to be parked where the founder stands), and a click on the place
// the founder is at goes back into its scene. While travelling the token moves
// along the leg and the HUD shows how far along it is.
//
// Same DOM hit-target layer and test queries as M001's map (map-slot.tsx), as
// `window.__eov.map`. The destination picked is UI-only state.

import type { LocationId, PlayerSnapshot } from "@eov/contracts";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { describeOutcome } from "../../components/format.ts";
import { useCommand } from "../../components/use-command.ts";
import { MAP_COPY } from "../../map/copy.ts";
import { MAP_COLORS } from "../../map/palette.ts";
import type { PixiMap } from "../../map/pixi-map.ts";
import { fitPlayerView, sceneOfPlayer } from "../../map/player-scene.ts";
import { entitiesAt, place, type MapEntity, type MapView, type PlacedEntity } from "../../map/scene.ts";
import type { MapEntityInfo } from "../map-slot.tsx";
import { registerMap } from "../test-hook.ts";
import { FOUNDER_COPY as C } from "./copy.ts";

const MIN_HEIGHT = 480;
const css = (color: number) => `#${color.toString(16).padStart(6, "0")}`;

const info = ({ entity, screen }: PlacedEntity): MapEntityInfo => ({
  kind: entity.kind,
  id: entity.id,
  label: entity.label,
  locationId: entity.locationId,
  x: screen.x,
  y: screen.y,
});

interface Latest {
  readonly scene: readonly MapEntity[];
  readonly view: MapView | null;
  readonly placed: readonly PlacedEntity[];
  readonly selected: LocationId | null;
}

/** Why the founder can't set out now, from always-known state; null if they can. */
function travelBlock(player: PlayerSnapshot): string | null {
  const w = player.founder.whereabouts;
  switch (w.kind) {
    case "PRESENT":
      return w.busy === null ? null : C.travel.busy;
    case "TRAVELLING":
      return C.travel.travelling;
    case "ON_DELIVERY":
      return C.travel.riding;
    case "RESTING":
      return C.travel.resting;
  }
}

function TravelCard({ player, destination, onClose }: { readonly player: PlayerSnapshot; readonly destination: LocationId; readonly onClose: () => void }) {
  const command = useCommand(`travel:${destination}`);
  const name = player.places.find((p) => p.id === destination)?.name ?? destination;
  const block = travelBlock(player);
  const w = player.founder.whereabouts;
  const here = w.kind === "PRESENT" ? w.locationId : null;
  // Drive only with a truck known to be parked where the founder stands.
  const truck = player.vehicles.find((v) => v.whereabouts !== null && v.whereabouts.value.parkedAt !== null && v.whereabouts.value.parkedAt === here) ?? null;
  const go = (transport: { readonly kind: "FOOT" } | { readonly kind: "VEHICLE"; readonly vehicleId: (typeof player.vehicles)[number]["id"] }) =>
    void command.send({ command: { type: "TRAVEL", destinationLocationId: destination, transport, via: null } });
  return (
    <div className="travel-card" data-testid="travel-card" data-destination={destination} role="dialog" aria-label={C.travel.title(name)}>
      <p className="travel-card-title">{C.travel.title(name)}</p>
      <div className="travel-card-buttons">
        <button type="button" className="button button-primary" data-testid="travel-walk" disabled={block !== null || command.pending} onClick={() => go({ kind: "FOOT" })}>
          {C.travel.walk}
        </button>
        {truck && (
          <button type="button" className="button" data-testid="travel-drive" disabled={block !== null || command.pending} onClick={() => go({ kind: "VEHICLE", vehicleId: truck.id })}>
            {C.travel.drive(truck.name)}
          </button>
        )}
        <button type="button" className="button" data-testid="travel-cancel" onClick={onClose}>
          {C.travel.cancel}
        </button>
      </div>
      {block !== null && <p className="travel-card-note">{block}</p>}
      {command.outcome && (
        <p role="status" className="travel-card-note" data-testid="travel-result" data-status={command.outcome.kind === "invalid" ? "invalid" : command.outcome.result.status}>
          {describeOutcome(command.outcome)}
        </p>
      )}
      {command.error && <p className="travel-card-note">{command.error}</p>}
    </div>
  );
}

export function FounderMap({ player, onOpenScene }: { readonly player: PlayerSnapshot; readonly onOpenScene: (locationId: LocationId) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const canvasHost = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ readonly width: number; readonly height: number } | null>(null);
  const [renderer, setRenderer] = useState<PixiMap | null>(null);
  const [failed, setFailed] = useState(false);
  const [hovered, setHovered] = useState<LocationId | null>(null);
  const [destination, setDestination] = useState<LocationId | null>(null);

  const w = player.founder.whereabouts;
  const here = w.kind === "PRESENT" ? w.locationId : null;
  const heading = w.kind === "TRAVELLING" ? w.destinationLocationId : null;
  const selected = destination ?? heading;

  // Setting out closes the card: the token's travel is the feedback.
  useEffect(() => {
    if (w.kind === "TRAVELLING") setDestination(null);
  }, [w.kind]);

  const scene = useMemo(() => sceneOfPlayer(player), [player]);
  const view = useMemo(() => (size ? fitPlayerView(player, size.width, size.height) : null), [player, size]);
  const placed = useMemo(() => (view ? place(scene, view) : []), [scene, view]);

  const latest = useRef<Latest>({ scene, view, placed, selected });
  useLayoutEffect(() => {
    latest.current = { scene, view, placed, selected };
  }, [scene, view, placed, selected]);

  useEffect(() => {
    registerMap({
      scene: () => latest.current.scene,
      entities: () => latest.current.placed.map(info),
      entitiesAt: (x: number, y: number) => {
        const { placed: p, view: v } = latest.current;
        return v ? entitiesAt(p, v, x, y).map(info) : [];
      },
      selected: () => {
        const { placed: p, selected: id } = latest.current;
        const hit = p.find((e) => e.entity.kind !== "FOUNDER" && e.entity.locationId !== null && e.entity.locationId === id);
        return hit ? info(hit) : null;
      },
    });
  }, []);

  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      const width = Math.max(1, Math.round(r.width));
      const height = Math.max(1, Math.round(r.height));
      setSize((s) => (s && s.width === width && s.height === height ? s : { width, height }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const el = host.current;
    const canvasEl = canvasHost.current;
    if (!el || !canvasEl) return;
    let cancelled = false;
    let made: PixiMap | null = null;
    import("../../map/pixi-map.ts")
      .then(({ PixiMap: Renderer }) => {
        const r = el.getBoundingClientRect();
        return Renderer.create(canvasEl, Math.max(1, Math.round(r.width)), Math.max(1, Math.round(r.height)));
      })
      .then(
        (map) => {
          if (cancelled) map.destroy();
          else {
            made = map;
            el.dataset["renderer"] = map.rendererName;
            setRenderer(map);
          }
        },
        () => {
          if (!cancelled) setFailed(true);
        },
      );
    return () => {
      cancelled = true;
      made?.destroy();
      setRenderer(null);
    };
  }, []);

  useEffect(() => {
    const el = host.current;
    if (!el || !view) return;
    if (renderer) renderer.draw(placed, view, { selected, hovered });
    if (renderer || failed) el.dataset["tick"] = String(player.clock.tick);
  }, [renderer, failed, placed, view, selected, hovered, player.clock.tick]);

  const choose = (locationId: LocationId) => {
    if (locationId === here) {
      setDestination(null);
      onOpenScene(locationId);
    } else setDestination(locationId);
  };

  const overlay = placed.map(({ entity, screen, radius }) => {
    if (entity.kind === "ROUTE") return null;
    const key = `${entity.kind}:${entity.id}`;
    const box = { position: "absolute", left: screen.x - radius, top: screen.y - radius, width: 2 * radius, height: 2 * radius } as const;
    if (entity.kind === "VEHICLE" || entity.kind === "FOUNDER") {
      return <span key={key} data-shape={entity.kind.toLowerCase()} data-id={entity.id} aria-hidden="true" style={{ ...box, pointerEvents: "none" }} />;
    }
    const locationId = entity.locationId!;
    return (
      <button
        key={key}
        type="button"
        data-shape={entity.kind.toLowerCase()}
        data-id={entity.id}
        data-testid={`place-${entity.id}`}
        aria-label={locationId === here ? C.travel.goIn(entity.label) : C.travel.title(entity.label)}
        aria-current={locationId === selected ? "true" : undefined}
        onClick={() => choose(locationId)}
        onPointerEnter={() => setHovered(locationId)}
        onPointerLeave={() => setHovered((h) => (h === locationId ? null : h))}
        onFocus={() => setHovered(locationId)}
        onBlur={() => setHovered((h) => (h === locationId ? null : h))}
        style={{ ...box, padding: 0, border: 0, borderRadius: "50%", background: "transparent", cursor: "pointer", pointerEvents: "auto" }}
      />
    );
  });

  const hereName = here === null ? null : (player.places.find((p) => p.id === here)?.name ?? null);

  return (
    <div
      ref={host}
      data-testid="founder-map"
      role="region"
      aria-label={MAP_COPY.label}
      style={{ position: "relative", width: "100%", height: "100%", minHeight: MIN_HEIGHT, overflow: "hidden", background: css(MAP_COLORS.ground) }}
    >
      <div ref={canvasHost} style={{ position: "absolute", inset: 0 }} />
      {failed && <p style={{ position: "absolute", margin: 8, color: css(MAP_COLORS.label) }}>{MAP_COPY.unavailable}</p>}
      <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>{overlay}</div>
      <div className="founder-map-bar">
        <span className="placeholder-tag">{C.placeholderArt}</span>
        <span className="founder-map-hint">{C.travel.hint}</span>
        {hereName !== null && (
          <button type="button" className="button" data-testid="open-scene" onClick={() => onOpenScene(here!)}>
            {C.travel.goIn(hereName)}
          </button>
        )}
      </div>
      {destination !== null && destination !== here && <TravelCard key={destination} player={player} destination={destination} onClose={() => setDestination(null)} />}
    </div>
  );
}
