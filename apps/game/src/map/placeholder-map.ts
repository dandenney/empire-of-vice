// S0 stub: replaced by T04b (the PixiJS isometric map).
//
// Placeholder shapes, drawn from the snapshot alone: a square for each
// facility, a triangle for each supplier, a circle for each buyer, a line for
// each route, and a small rectangle for each truck. Styling is PLACEHOLDER; the
// visual design is the human's call.
//
// A truck on the road is positioned at (tick − departedAt) / (arrivesAt −
// departedAt) along its route's waypoints (ADR 0003, VehicleTrip), reversed on
// the return leg. Each waypoint segment gets an equal share of the trip.

import type { GameSnapshot, WorldPoint } from "@eov/contracts";

/** One drawn shape, in world units. The test hook exposes these as the map scene query (architecture §4). */
export interface SceneShape {
  readonly kind: "FACILITY" | "SUPPLIER" | "BUYER" | "ROUTE" | "VEHICLE";
  readonly id: string;
  readonly label: string;
  readonly position: WorldPoint;
}

const SVG_NS = "http://www.w3.org/2000/svg";
const SCALE = 16;
const MARGIN = 4;

function along(points: readonly WorldPoint[], progress: number): WorldPoint {
  if (points.length === 1) return points[0]!;
  const segments = points.length - 1;
  const clamped = Math.min(Math.max(progress, 0), 1);
  const index = Math.min(Math.floor(clamped * segments), segments - 1);
  const local = clamped * segments - index;
  const a = points[index]!;
  const b = points[index + 1]!;
  return { x: a.x + (b.x - a.x) * local, y: a.y + (b.y - a.y) * local };
}

/** The scene for a snapshot: every shape the map draws, with its world position. */
export function sceneOf(snapshot: GameSnapshot): readonly SceneShape[] {
  const shapes: SceneShape[] = [];
  const locations = new Map(snapshot.locations.map((l) => [l.id, l]));
  for (const route of snapshot.routes) {
    shapes.push({ kind: "ROUTE", id: route.id, label: route.name, position: route.waypoints[0]! });
  }
  for (const location of snapshot.locations) {
    const kind = location.occupant.kind;
    const id =
      location.occupant.kind === "FACILITY"
        ? location.occupant.facilityId
        : location.occupant.kind === "SUPPLIER"
          ? location.occupant.supplierId
          : location.occupant.buyerId;
    shapes.push({ kind, id, label: location.name, position: location.position });
  }
  for (const vehicle of snapshot.vehicles) {
    let position = locations.get(vehicle.homeLocationId)?.position ?? { x: 0, y: 0 };
    if (vehicle.trip) {
      const route = snapshot.routes.find((r) => r.id === vehicle.trip!.routeId);
      if (route) {
        const { departedAt, arrivesAt, leg } = vehicle.trip;
        const span = arrivesAt - departedAt;
        const progress = span > 0 ? (snapshot.clock.tick - departedAt) / span : 1;
        position = along(leg === "OUTBOUND" ? route.waypoints : [...route.waypoints].reverse(), progress);
      }
    }
    shapes.push({ kind: "VEHICLE", id: vehicle.id, label: vehicle.name, position });
  }
  return shapes;
}

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

/** Draws the scene into an <svg>. Returns the scene it drew. */
export function renderMap(svg: SVGSVGElement, snapshot: GameSnapshot): readonly SceneShape[] {
  const scene = sceneOf(snapshot);
  const points = snapshot.locations.map((l) => l.position);
  const minX = Math.min(...points.map((p) => p.x)) - MARGIN;
  const minY = Math.min(...points.map((p) => p.y)) - MARGIN;
  const maxX = Math.max(...points.map((p) => p.x)) + MARGIN;
  const maxY = Math.max(...points.map((p) => p.y)) + MARGIN;
  svg.setAttribute("viewBox", `0 0 ${(maxX - minX) * SCALE} ${(maxY - minY) * SCALE}`);
  const at = (p: WorldPoint) => ({ x: (p.x - minX) * SCALE, y: (p.y - minY) * SCALE });

  svg.replaceChildren();
  for (const route of snapshot.routes) {
    const d = route.waypoints.map((p, i) => `${i === 0 ? "M" : "L"}${at(p).x},${at(p).y}`).join(" ");
    svg.append(el("path", { d, fill: "none", stroke: route.status.open ? "#999" : "#c33", "stroke-width": 2, "data-route": route.id }));
  }
  for (const shape of scene) {
    const { x, y } = at(shape.position);
    let node: SVGElement;
    if (shape.kind === "FACILITY") node = el("rect", { x: x - 10, y: y - 10, width: 20, height: 20, fill: "#865" });
    else if (shape.kind === "SUPPLIER") node = el("polygon", { points: `${x},${y - 10} ${x + 10},${y + 8} ${x - 10},${y + 8}`, fill: "#686" });
    else if (shape.kind === "BUYER") node = el("circle", { cx: x, cy: y, r: 9, fill: "#568" });
    else if (shape.kind === "VEHICLE") node = el("rect", { x: x - 7, y: y - 4, width: 14, height: 8, fill: "#222" });
    else continue;
    node.setAttribute("data-shape", shape.kind.toLowerCase());
    node.setAttribute("data-id", shape.id);
    const title = el("title", {});
    title.textContent = shape.label;
    node.append(title);
    svg.append(node);
    if (shape.kind !== "VEHICLE") {
      const text = el("text", { x, y: y + 22, "text-anchor": "middle", "font-size": 11, fill: "#333" });
      text.textContent = shape.label;
      svg.append(text);
    }
  }
  return scene;
}
