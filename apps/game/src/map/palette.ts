// Map colours and label font, derived from the shell's design tokens
// (src/ui/tokens.ts, the #48 noir direction), so the map and the panels share
// one source of truth. Values are 0xRRGGBB for PixiJS.

import { FONT_STACK, hexToNumber, MAP_TOKENS } from "../ui/tokens.ts";

type MapColorRole = keyof typeof MAP_TOKENS;

export const MAP_COLORS: Readonly<Record<MapColorRole, number>> = Object.fromEntries(
  (Object.keys(MAP_TOKENS) as MapColorRole[]).map((role) => [role, hexToNumber(MAP_TOKENS[role])]),
) as Record<MapColorRole, number>;

/** Location labels use the shell's UI face (bundled; the map mounts once it has loaded). */
export const MAP_LABEL_FONT = { family: FONT_STACK.ui, size: 12 } as const;

/** World units between survey-grid lines. */
export const MAP_GRID_STEP = 2;
