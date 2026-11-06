// PLACEHOLDER: map colours as local constants, from the #48 noir direction
// (charcoal, brass gold, muted bottle green, dark theme). T04d (#61) defines
// the shell's palette as CSS tokens; switch these to those tokens then. Values
// are 0xRRGGBB for PixiJS.

export const MAP_COLORS = {
  /** Charcoal ground. */
  ground: 0x18191b,
  /** Faint survey grid over the ground. */
  grid: 0x222427,
  /** An open road. */
  road: 0x5b5649,
  /** A closed road (rival or police trouble). */
  roadClosed: 0x8c3a33,
  /** Brass gold: the distillery and the selection ring. */
  brass: 0xb8975a,
  brassBright: 0xe0c27e,
  brassDark: 0x6e5a35,
  /** Muted bottle green: suppliers and storage. */
  bottleGreen: 0x3f5f4c,
  bottleGreenLight: 0x6f9a7d,
  /** Buyers: charcoal disc with a brass rim. */
  buyerFill: 0x2a2c2f,
  /** Trucks. */
  truck: 0xd8d0bc,
  truckDelayed: 0xc0574c,
  /** Location labels. */
  label: 0xd8d0bc,
  /** Outline under shapes, so they read against the ground. */
  outline: 0x0d0d0e,
} as const;

/** Label typeface. PLACEHOLDER until T04d picks the shell's fonts. */
export const MAP_LABEL_FONT = { family: ["Georgia", "Times New Roman", "serif"], size: 12 } as const;

/** World units between survey-grid lines. */
export const MAP_GRID_STEP = 2;
