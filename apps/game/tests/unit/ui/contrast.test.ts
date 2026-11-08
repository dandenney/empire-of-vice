// Issue #61: text contrast against the noir palette meets WCAG 2.2 AA.
// Body text needs 4.5:1; large text (the display headings) and non-text UI
// (icons, focus rings, control borders that carry state) need 3:1.
// Every pair below is a combination the shell or a panel actually renders.

import { describe, expect, it } from "vitest";
import { COLOR, MAP_TOKENS } from "../../../src/ui/tokens.ts";

/** WCAG relative luminance of #rrggbb. */
function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const TEXT = 4.5;
const LARGE_OR_UI = 3;

const PAIRS: readonly { readonly what: string; readonly fg: string; readonly bg: string; readonly min: number }[] = [
  { what: "body text on the panel", fg: COLOR.text, bg: COLOR.surface, min: TEXT },
  { what: "body text on bars, tiles, cards, toasts", fg: COLOR.text, bg: COLOR.surfaceRaised, min: TEXT },
  { what: "body text on the page / map", fg: COLOR.text, bg: COLOR.bg, min: TEXT },
  { what: "muted text on the panel", fg: COLOR.textMuted, bg: COLOR.surface, min: TEXT },
  { what: "muted text on bars and tiles", fg: COLOR.textMuted, bg: COLOR.surfaceRaised, min: TEXT },
  { what: "muted text on the map (state hash)", fg: COLOR.textMuted, bg: COLOR.bg, min: TEXT },
  { what: "brass captions and group titles on the panel", fg: COLOR.accent, bg: COLOR.surface, min: TEXT },
  { what: "brass masthead and badges on raised surfaces", fg: COLOR.accent, bg: COLOR.surfaceRaised, min: TEXT },
  { what: "bright brass section titles on the panel", fg: COLOR.accentStrong, bg: COLOR.surface, min: TEXT },
  { what: "clock digits on the readout", fg: COLOR.accentStrong, bg: COLOR.shadow, min: TEXT },
  { what: "selected rail icon on its wash", fg: COLOR.accentStrong, bg: COLOR.accentWash, min: LARGE_OR_UI },
  { what: "rail icons at rest", fg: COLOR.textMuted, bg: COLOR.surface, min: LARGE_OR_UI },
  { what: "primary button label on brass", fg: COLOR.onAccent, bg: COLOR.accent, min: TEXT },
  { what: "primary button label on bright brass (hover)", fg: COLOR.onAccent, bg: COLOR.accentStrong, min: TEXT },
  { what: "pressed speed / period button label", fg: COLOR.gain, bg: COLOR.surfaceActive, min: TEXT },
  { what: "losses on the panel", fg: COLOR.loss, bg: COLOR.surface, min: TEXT },
  { what: "losses on cards and toasts", fg: COLOR.loss, bg: COLOR.surfaceRaised, min: TEXT },
  { what: "good-news toast titles", fg: COLOR.gain, bg: COLOR.surfaceRaised, min: TEXT },
  { what: "neutral toast titles", fg: COLOR.accent, bg: COLOR.surfaceRaised, min: TEXT },
  { what: "notice banner text", fg: COLOR.text, bg: COLOR.accentWash, min: TEXT },
  { what: "fault banner text", fg: COLOR.text, bg: COLOR.lossWash, min: TEXT },
  { what: "focus ring against the panel", fg: COLOR.focus, bg: COLOR.surface, min: LARGE_OR_UI },
  { what: "focus ring against the map", fg: COLOR.focus, bg: COLOR.bg, min: LARGE_OR_UI },
  { what: "map location labels", fg: MAP_TOKENS.label, bg: MAP_TOKENS.ground, min: TEXT },
];

describe("WCAG AA contrast (issue #61)", () => {
  it.each(PAIRS)("$what", ({ fg, bg, min }) => {
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(min);
  });

  it("measures known values correctly", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
  });

  it("prints the measurements (for the PR)", () => {
    const rows = PAIRS.map((p) => `${contrast(p.fg, p.bg).toFixed(2).padStart(6)}:1 (min ${p.min}) ${p.what} — ${p.fg} on ${p.bg}`);
    console.log(rows.join("\n"));
    expect(rows).toHaveLength(PAIRS.length);
  });
});
