// The map slot: the PixiJS map (T04b, #17), drawn from the latest snapshot
// alone (CLAUDE.md rule 7). It fills its container, and follows its size, so
// when T04d (#61) makes the map region full-bleed behind the docked panel
// (#48) the canvas fills the viewport.
//
// Over the canvas sits a layer of DOM hit targets laid out from the same scene
// (src/map/scene.ts): a transparent button on each location, so the map works
// with a keyboard and a screen reader, and a marker on each truck. A click or
// Enter on a location calls the store's `openPanelForLocation`, which also
// selects it. Hover and focus are transient view state, kept here; the
// selection is the store's.
//
// Test builds get these queries as `window.__eov.map` (architecture §4).
// Points are CSS pixels from the map's top-left corner:
//   entitiesAt(x, y): what's under the point, frontmost first
//   selected():       the selected location's entity, or null
//   entities():       every drawn entity and its screen position
//   scene():          S0's world-unit scene query, kept for `__eov.scene`
// The map element's `data-tick` is the tick it last drew.

import type { GameSnapshot, LocationId } from "@eov/contracts";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { MAP_COPY } from "../map/copy.ts";
import { MAP_COLORS } from "../map/palette.ts";
import type { PixiMap } from "../map/pixi-map.ts";
import { entitiesAt, fitView, place, sceneOf, type MapEntity, type MapView, type PlacedEntity } from "../map/scene.ts";
import { useUi } from "../state/app-context.tsx";
import { registerMap } from "./test-hook.ts";

/** Until the shell gives the map region a height (T04d), the map keeps at least this much, in CSS pixels. */
const MIN_HEIGHT = 480;

const css = (color: number) => `#${color.toString(16).padStart(6, "0")}`;

/** What the test queries return for an entity: plain data, so it crosses `page.evaluate`. */
export interface MapEntityInfo {
  readonly kind: MapEntity["kind"];
  readonly id: string;
  readonly label: string;
  readonly locationId: LocationId | null;
  /** Screen position, CSS pixels from the map's top-left. */
  readonly x: number;
  readonly y: number;
}

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

export function MapSlot({ snapshot }: { readonly snapshot: GameSnapshot }) {
  const host = useRef<HTMLDivElement>(null);
  /** The canvas's own element: React renders no children into it, so PixiJS can own it. */
  const canvasHost = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ readonly width: number; readonly height: number } | null>(null);
  const [renderer, setRenderer] = useState<PixiMap | null>(null);
  const [failed, setFailed] = useState(false);
  const [hovered, setHovered] = useState<LocationId | null>(null);
  const selected = useUi((s) => s.selectedLocationId);
  const openPanelForLocation = useUi((s) => s.openPanelForLocation);

  const scene = useMemo(() => sceneOf(snapshot), [snapshot]);
  const view = useMemo(() => (size ? fitView(snapshot, size.width, size.height) : null), [snapshot, size]);
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
        const hit = p.find((e) => e.entity.locationId !== null && e.entity.locationId === id);
        return hit ? info(hit) : null;
      },
    });
  }, []);

  // Follow the container's size.
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

  // Create the renderer once. PixiJS loads as its own chunk, so the shell doesn't wait on it.
  // Under StrictMode the first renderer is destroyed as soon as it's ready.
  useEffect(() => {
    const el = host.current;
    const canvasEl = canvasHost.current;
    if (!el || !canvasEl) return;
    let cancelled = false;
    let made: PixiMap | null = null;
    import("../map/pixi-map.ts")
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
    if (renderer || failed) el.dataset["tick"] = String(snapshot.clock.tick);
  }, [renderer, failed, placed, view, selected, hovered, snapshot.clock.tick]);

  const overlay = placed.map(({ entity, screen, radius }) => {
    if (entity.kind === "ROUTE") return null;
    const key = `${entity.kind}:${entity.id}`;
    const box = { position: "absolute", left: screen.x - radius, top: screen.y - radius, width: 2 * radius, height: 2 * radius } as const;
    if (entity.kind === "VEHICLE") return <span key={key} data-shape="vehicle" data-id={entity.id} aria-hidden="true" style={{ ...box, pointerEvents: "none" }} />;
    const locationId = entity.locationId!;
    return (
      <button
        key={key}
        type="button"
        data-shape={entity.kind.toLowerCase()}
        data-id={entity.id}
        aria-label={entity.label}
        aria-current={locationId === selected ? "true" : undefined}
        onClick={() => openPanelForLocation(locationId)}
        onPointerEnter={() => setHovered(locationId)}
        onPointerLeave={() => setHovered((h) => (h === locationId ? null : h))}
        onFocus={() => setHovered(locationId)}
        onBlur={() => setHovered((h) => (h === locationId ? null : h))}
        style={{ ...box, padding: 0, border: 0, borderRadius: "50%", background: "transparent", cursor: "pointer", pointerEvents: "auto" }}
      />
    );
  });

  return (
    <div
      ref={host}
      data-testid="map"
      role="region"
      aria-label={MAP_COPY.label}
      style={{ position: "relative", width: "100%", height: "100%", minHeight: MIN_HEIGHT, overflow: "hidden", background: css(MAP_COLORS.ground) }}
    >
      <div ref={canvasHost} style={{ position: "absolute", inset: 0 }} />
      {failed && <p style={{ position: "absolute", margin: 8, color: css(MAP_COLORS.label) }}>{MAP_COPY.unavailable}</p>}
      <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
        {overlay}
      </div>
    </div>
  );
}
