// Design tokens (#48 visual direction): the one place colours, fonts, sizes,
// and spacing are defined. Noir palette (charcoal, brass gold, muted bottle
// green), dark theme, compact density.
//
// Both renderers read these values:
//   - CSS gets them as custom properties (`tokenCss()`, mounted by
//     <TokenStyle /> in ./token-style.tsx). Component CSS uses `var(--…)` only,
//     never a raw colour (tests/unit/ui/tokens.test.ts checks).
//   - The PixiJS map gets its colours from `MAP_TOKENS` through
//     src/map/palette.ts, and its label font from `FONT_STACK`.
//
// Text contrast against these surfaces is checked in
// tests/unit/ui/contrast.test.ts (WCAG AA).

/** Raw palette. Components use the semantic roles below, not these. */
export const PALETTE = {
  ink: "#0d0d0e",
  charcoal950: "#121315",
  charcoal900: "#18191b",
  charcoal875: "#1c1d20",
  charcoal850: "#1f2124",
  charcoal800: "#26282c",
  charcoal700: "#33363b",
  charcoal600: "#4a4e55",
  parchment100: "#ece5d3",
  parchment300: "#d8d0bc",
  parchment500: "#a9a290",
  umber500: "#5b5649",
  brass300: "#e0c27e",
  brass500: "#c2a165",
  brass700: "#6e5a35",
  brass900: "#3a301d",
  bottle300: "#8fc1a0",
  bottle500: "#6f9a7d",
  bottle700: "#3f5f4c",
  bottle900: "#22342a",
  oxblood300: "#ef8f82",
  oxblood500: "#c0574c",
  oxblood700: "#8c3a33",
  oxblood900: "#3d1f1c",
} as const;

const P = PALETTE;

/** Semantic colour roles for the shell and panels. CSS: `--color-<kebab name>`. */
export const COLOR = {
  /** The page behind everything (and the map's ground). */
  bg: P.charcoal900,
  /** The docked panel. */
  surface: P.charcoal850,
  /** Bars, table heads, cards inside the panel. */
  surfaceRaised: P.charcoal800,
  /** Pressed or selected controls. */
  surfaceActive: P.bottle900,
  /** Hairlines between ledger rows. */
  rule: P.charcoal700,
  /** Column rules, control borders, total rules. */
  ruleStrong: P.charcoal600,
  text: P.parchment100,
  textMuted: P.parchment500,
  /** Brass gold: display headings, the Deco frame, the selected rail item. */
  accent: P.brass500,
  accentStrong: P.brass300,
  accentDim: P.brass700,
  accentWash: P.brass900,
  /** Gains and good news. */
  gain: P.bottle300,
  gainLine: P.bottle700,
  /** Losses and bad news. Never the only signal: figures also carry a minus sign. */
  loss: P.oxblood300,
  lossLine: P.oxblood700,
  lossWash: P.oxblood900,
  /** Keyboard focus ring. */
  focus: P.brass300,
  /** Text on a brass fill (primary buttons). */
  onAccent: P.ink,
  shadow: P.ink,
} as const;

/** Map roles, for src/map/palette.ts (PixiJS wants 0xRRGGBB; it converts). */
export const MAP_TOKENS = {
  ground: COLOR.bg,
  grid: P.charcoal875,
  road: P.umber500,
  roadClosed: P.oxblood700,
  brass: P.brass500,
  brassBright: P.brass300,
  brassDark: P.brass700,
  bottleGreen: P.bottle700,
  bottleGreenLight: P.bottle500,
  buyerFill: P.charcoal800,
  truck: P.parchment300,
  truckDelayed: P.oxblood500,
  label: P.parchment300,
  outline: P.ink,
} as const;

/**
 * Font families, most preferred first. The web fonts are bundled (./fonts.ts),
 * never fetched from a CDN. CSS: `--font-<name>`.
 *   display: the era face, for headings only (Limelight, Art Deco).
 *   ui:      everything else (IBM Plex Sans).
 *   mono:    typewriter figures and ledgers, tabular by construction (Courier Prime).
 */
export const FONT_STACK = {
  display: ["Limelight", "Georgia", "serif"],
  ui: ["IBM Plex Sans", "system-ui", "sans-serif"],
  mono: ["Courier Prime", "Courier New", "monospace"],
} as const;

/** Compact type scale, in px. CSS: `--text-<name>`. */
export const TEXT_SIZE = {
  xs: 11,
  sm: 12,
  md: 13,
  lg: 15,
  xl: 18,
  xxl: 22,
} as const;

export const FONT_WEIGHT = {
  regular: 400,
  medium: 500,
  bold: 600,
} as const;

/** Spacing scale, in px. CSS: `--space-<n>`. */
export const SPACE = {
  0: 0,
  1: 2,
  2: 4,
  3: 6,
  4: 8,
  5: 12,
  6: 16,
  7: 24,
  8: 32,
} as const;

export const RADIUS = {
  sm: 2,
  md: 4,
} as const;

/** Shell geometry, in px. CSS: `--layout-<kebab name>`. */
export const LAYOUT = {
  topbarHeight: 48,
  railWidth: 56,
  dockWidth: 520,
  toastWidth: 340,
  controlHeight: 26,
} as const;

/** Motion, in ms. Reduced-motion users get none (shell.css). */
export const DURATION = {
  fast: 120,
  toast: 180,
} as const;

const kebab = (name: string): string => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const family = (stack: readonly string[]): string => stack.map((f) => (/\s/.test(f) ? `'${f}'` : f)).join(", ");

/** Every token as a CSS custom property, `--group-name: value`. */
export function tokenProperties(): readonly (readonly [string, string])[] {
  const group = <T extends Record<string | number, string | number | readonly string[]>>(prefix: string, values: T, unit: (v: T[keyof T]) => string) =>
    Object.entries(values).map(([k, v]) => [`--${prefix}-${kebab(k)}`, unit(v as T[keyof T])] as const);
  return [
    ...group("color", COLOR, String),
    ...group("font", FONT_STACK, (v) => family(v as readonly string[])),
    ...group("text", TEXT_SIZE, (v) => `${v}px`),
    ...group("weight", FONT_WEIGHT, String),
    ...group("space", SPACE, (v) => `${v}px`),
    ...group("radius", RADIUS, (v) => `${v}px`),
    ...group("layout", LAYOUT, (v) => `${v}px`),
    ...group("duration", DURATION, (v) => `${v}ms`),
  ];
}

/** The `:root` rule that defines every token for CSS. */
export function tokenCss(): string {
  return `:root{${tokenProperties()
    .map(([name, value]) => `${name}:${value};`)
    .join("")}}`;
}

/** "#rrggbb" → 0xrrggbb, for PixiJS. Every token is #rrggbb (tests/unit/ui/tokens.test.ts). */
export function hexToNumber(hex: string): number {
  return Number.parseInt(hex.slice(1), 16);
}
