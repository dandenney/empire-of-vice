// Issue #61: one source of truth for colours, fonts, and spacing.
//   - every token colour is #rrggbb;
//   - component CSS uses tokens only: no raw colour values, and every
//     `var(--…)` it reads is a defined token (or a property the same file sets);
//   - the map's PixiJS colours are the tokens, converted.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MAP_COLORS, MAP_LABEL_FONT } from "../../../src/map/palette.ts";
import { COLOR, FONT_STACK, MAP_TOKENS, PALETTE, hexToNumber, tokenCss, tokenProperties } from "../../../src/ui/tokens.ts";

const SRC = fileURLToPath(new URL("../../../src", import.meta.url));

function cssFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return cssFiles(path);
    return entry.name.endsWith(".css") ? [path] : [];
  });
}

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

describe("design tokens", () => {
  it("every colour token is #rrggbb", () => {
    for (const [name, value] of Object.entries({ ...PALETTE, ...COLOR, ...MAP_TOKENS })) {
      expect(value, name).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("semantic and map roles only use palette colours", () => {
    const palette = new Set<string>(Object.values(PALETTE));
    for (const [name, value] of Object.entries({ ...COLOR, ...MAP_TOKENS })) expect(palette.has(value), name).toBe(true);
  });

  it("tokenCss defines each token once, on :root", () => {
    const css = tokenCss();
    expect(css.startsWith(":root{")).toBe(true);
    const names = tokenProperties().map(([n]) => n);
    expect(new Set(names).size).toBe(names.length);
    expect(css).toContain("--color-bg:#18191b;");
    expect(css).toContain("--font-mono:'Courier Prime', 'Courier New', monospace;");
    expect(css).toContain("--space-4:8px;");
  });
});

describe("component CSS uses tokens only", () => {
  const files = cssFiles(SRC);
  const defined = new Set(tokenProperties().map(([n]) => n));

  it("finds the app's stylesheets", () => {
    expect(files.map((f) => relative(SRC, f)).sort()).toEqual(expect.arrayContaining(["app/shell.css", "ui/components.css"]));
  });

  it("has no raw colour values", () => {
    const raw = files.flatMap((f) => {
      const css = stripComments(readFileSync(f, "utf8"));
      const hits = css.match(/#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/g) ?? [];
      return hits.map((h) => `${relative(SRC, f)}: ${h}`);
    });
    expect(raw).toEqual([]);
  });

  it("only reads custom properties that are defined", () => {
    const undefinedVars = files.flatMap((f) => {
      const css = stripComments(readFileSync(f, "utf8"));
      const local = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]!));
      return [...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]!).filter((v) => !defined.has(v) && !local.has(v)).map((v) => `${relative(SRC, f)}: ${v}`);
    });
    expect(undefinedVars).toEqual([]);
  });

  it("sets fonts through the font tokens", () => {
    const literalFamilies = files.flatMap((f) =>
      [...stripComments(readFileSync(f, "utf8")).matchAll(/font-family:\s*([^;]+);/g)].map((m) => m[1]!.trim()).filter((v) => !v.startsWith("var(--font-")).map((v) => `${relative(SRC, f)}: ${v}`),
    );
    expect(literalFamilies).toEqual([]);
  });
});

describe("the map palette reads the same tokens", () => {
  it("each map colour is its token as 0xRRGGBB", () => {
    for (const role of Object.keys(MAP_TOKENS) as (keyof typeof MAP_TOKENS)[]) {
      expect(MAP_COLORS[role], role).toBe(hexToNumber(MAP_TOKENS[role]));
    }
    expect(MAP_COLORS.ground).toBe(0x18191b);
    expect(MAP_TOKENS.ground).toBe(COLOR.bg);
  });

  it("labels use the shell's UI face", () => {
    expect(MAP_LABEL_FONT.family).toEqual(FONT_STACK.ui);
  });
});
