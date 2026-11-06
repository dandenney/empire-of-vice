// The PixiJS renderer for the map (GDD §10, architecture §2). It draws a placed
// scene (scene.ts) and holds nothing else: no game state, no selection of its
// own (the UI store has that). Each `draw` redraws from scratch, which is cheap
// at M001's handful of shapes.
//
// The ticker never runs: the map renders once per draw call (a new snapshot,
// a resize, or a hover change), so an idle map costs nothing and a screenshot
// always shows the last drawn snapshot.
//
// Renderer: WebGL, falling back to PixiJS's canvas renderer where WebGL isn't
// available (some headless browsers). WebGPU is left out: it's not yet steady
// enough across browsers and CI for screenshot baselines.
//
// Placeholder shapes, per kind: brass square for the distillery, wide bottle-
// green block for storage, green triangle for a supplier, brass-rimmed disc
// for a buyer, a line per route (red while closed), a small box per truck (red
// while delayed).

import { Application, Container, Graphics, Text } from "pixi.js";
import type { LocationId } from "@eov/contracts";
import { MAP_COLORS, MAP_GRID_STEP, MAP_LABEL_FONT } from "./palette.ts";
import { MAP_METRICS, toScreen, type MapView, type PlacedEntity } from "./scene.ts";

export interface MapHighlights {
  readonly selected: LocationId | null;
  /** Hovered or keyboard-focused. */
  readonly hovered: LocationId | null;
}

export class PixiMap {
  private readonly ground = new Graphics();
  private readonly roads = new Graphics();
  private readonly marks = new Graphics();
  private readonly trucks = new Graphics();
  private readonly labels = new Container();
  private readonly labelById = new Map<string, Text>();

  private constructor(private readonly app: Application) {
    app.stage.addChild(this.ground, this.roads, this.marks, this.labels, this.trucks);
  }

  /** Creates the renderer and puts its canvas in `host`. Rejects if the browser can't draw at all. */
  static async create(host: HTMLElement, width: number, height: number): Promise<PixiMap> {
    const app = new Application();
    await app.init({
      preference: ["webgl", "canvas"],
      width,
      height,
      background: MAP_COLORS.ground,
      antialias: true,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
      autoStart: false,
      sharedTicker: false,
    });
    app.canvas.setAttribute("aria-hidden", "true");
    app.canvas.style.display = "block";
    host.append(app.canvas);
    return new PixiMap(app);
  }

  get rendererName(): string {
    return this.app.renderer.name;
  }

  draw(placed: readonly PlacedEntity[], view: MapView, highlights: MapHighlights): void {
    if (this.app.renderer.width !== view.width || this.app.renderer.height !== view.height) {
      this.app.renderer.resize(view.width, view.height);
    }
    this.drawGround(view);
    this.roads.clear();
    this.marks.clear();
    this.trucks.clear();
    const seen = new Set<string>();

    for (const { entity, screen, radius } of placed) {
      if (entity.kind === "ROUTE") {
        const path = entity.waypoints.map((w) => toScreen(view, w));
        this.roads.moveTo(path[0]!.x, path[0]!.y);
        for (const p of path.slice(1)) this.roads.lineTo(p.x, p.y);
        this.roads.stroke({ width: 3, color: entity.open ? MAP_COLORS.road : MAP_COLORS.roadClosed, cap: "round", join: "round" });
        continue;
      }
      if (entity.kind === "VEHICLE") {
        this.trucks
          .roundRect(screen.x - 7, screen.y - 4.5, 14, 9, 2)
          .fill(entity.delayed ? MAP_COLORS.truckDelayed : MAP_COLORS.truck)
          .stroke({ width: 1.5, color: MAP_COLORS.outline });
        continue;
      }

      const id = entity.locationId;
      if (id !== null && id === highlights.selected) {
        this.marks.circle(screen.x, screen.y, radius + 6).stroke({ width: 2, color: MAP_COLORS.brassBright });
      } else if (id !== null && id === highlights.hovered) {
        this.marks.circle(screen.x, screen.y, radius + 5).stroke({ width: 1.5, color: MAP_COLORS.brassDark });
      }
      const { x, y } = screen;
      if (entity.kind === "FACILITY" && entity.facilityKind === "WAREHOUSE") {
        this.marks.rect(x - 14, y - 9, 28, 18).fill(MAP_COLORS.bottleGreen).stroke({ width: 2, color: MAP_COLORS.brass });
      } else if (entity.kind === "FACILITY") {
        this.marks.rect(x - 11, y - 11, 22, 22).fill(MAP_COLORS.brass).stroke({ width: 2, color: MAP_COLORS.outline });
      } else if (entity.kind === "SUPPLIER") {
        this.marks.poly([x, y - 12, x + 12, y + 9, x - 12, y + 9]).fill(MAP_COLORS.bottleGreenLight).stroke({ width: 2, color: MAP_COLORS.outline });
      } else {
        this.marks.circle(x, y, 10).fill(MAP_COLORS.buyerFill).stroke({ width: 2.5, color: MAP_COLORS.brass });
      }

      const key = `${entity.kind}:${entity.id}`;
      seen.add(key);
      const label = this.labelFor(key, entity.label);
      label.position.set(Math.round(x), Math.round(y + MAP_METRICS.locationRadius + 8));
    }

    for (const [key, label] of this.labelById) {
      if (seen.has(key)) continue;
      label.destroy();
      this.labelById.delete(key);
    }
    this.app.render();
  }

  destroy(): void {
    this.app.destroy({ removeView: true }, { children: true });
  }

  private labelFor(key: string, text: string): Text {
    let label = this.labelById.get(key);
    if (!label) {
      label = new Text({
        text,
        style: { fontFamily: [...MAP_LABEL_FONT.family], fontSize: MAP_LABEL_FONT.size, fill: MAP_COLORS.label },
      });
      label.anchor.set(0.5, 0);
      this.labels.addChild(label);
      this.labelById.set(key, label);
    } else if (label.text !== text) {
      label.text = text;
    }
    return label;
  }

  private drawGround(view: MapView): void {
    const g = this.ground.clear();
    const step = MAP_GRID_STEP * view.scale;
    if (step < 8) return;
    const startX = view.offsetX - Math.ceil(view.offsetX / step) * step;
    const startY = view.offsetY - Math.ceil(view.offsetY / step) * step;
    for (let x = startX; x <= view.width; x += step) g.moveTo(Math.round(x) + 0.5, 0).lineTo(Math.round(x) + 0.5, view.height);
    for (let y = startY; y <= view.height; y += step) g.moveTo(0, Math.round(y) + 0.5).lineTo(view.width, Math.round(y) + 0.5);
    g.stroke({ width: 1, color: MAP_COLORS.grid });
  }
}
