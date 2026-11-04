// Proves the package-boundary lint rules in the root eslint.config.js fire.
// Runs ESLint programmatically against fixture text, placed at virtual file
// paths so the real config's `files` globs decide which rules apply.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

const BOUNDARY_RULES = new Set([
  "no-restricted-imports",
  "no-restricted-globals",
  "no-restricted-properties",
  "no-restricted-syntax",
]);

const DETERMINISM_RULES = new Set(["no-restricted-properties", "no-restricted-syntax"]);

type Finding = `${number}:${string}`;

const eslint = new ESLint({ cwd: repoRoot });

async function boundaryFindings(code: string, filePath: string): Promise<Finding[]> {
  const [result] = await eslint.lintText(code, { filePath });
  if (!result) throw new Error("ESLint returned no result");
  const fatal = result.messages.filter((m) => m.fatal);
  expect(fatal, "fixture must parse").toEqual([]);
  return result.messages
    .filter((m) => m.ruleId !== null && BOUNDARY_RULES.has(m.ruleId))
    .map((m): Finding => `${m.line}:${m.ruleId ?? ""}`)
    .sort();
}

function expectedFindings(code: string): Finding[] {
  return code
    .split("\n")
    .flatMap((text, index): Finding[] => {
      const match = /\/\/ expect: ([\w-]+)/.exec(text);
      return match?.[1] ? [`${index + 1}:${match[1]}`] : [];
    })
    .sort();
}

describe("simulation package-boundary lint rules", () => {
  const violations = fixture("boundary-violations.ts");

  it("reports every forbidden import, browser global, and non-deterministic call", async () => {
    const expected = expectedFindings(violations);
    expect(expected.length).toBeGreaterThan(20);

    const actual = await boundaryFindings(
      violations,
      "packages/simulation/src/boundary-violations.ts",
    );
    expect(actual).toEqual(expected);
  });

  it("also applies to simulation test files", async () => {
    const actual = await boundaryFindings(
      violations,
      "packages/simulation/test/boundary-violations.test.ts",
    );
    expect(actual).toEqual(expectedFindings(violations));
  });

  it("allows ordinary deterministic simulation code", async () => {
    const actual = await boundaryFindings(
      fixture("boundary-clean.ts"),
      "packages/simulation/src/boundary-clean.ts",
    );
    expect(actual).toEqual([]);
  });

  it("applies import and browser-global rules, not determinism rules, to packages the simulation imports", async () => {
    // Determinism findings drop out, except `globalThis.window`, which is a
    // browser-global finding that happens to use no-restricted-properties.
    const lines = violations.split("\n");
    const expected = expectedFindings(violations).filter((finding) => {
      const [line, rule] = finding.split(":") as [string, string];
      return !DETERMINISM_RULES.has(rule) || lines[Number(line) - 1]?.includes("globalThis.");
    });

    for (const pkg of ["contracts", "game-data"]) {
      const actual = await boundaryFindings(violations, `packages/${pkg}/src/boundary-violations.ts`);
      expect(actual, pkg).toEqual(expected);
    }
  });

  it("does not restrict the browser app", async () => {
    const actual = await boundaryFindings(violations, "apps/game/src/boundary-violations.ts");
    expect(actual).toEqual([]);
  });
});
