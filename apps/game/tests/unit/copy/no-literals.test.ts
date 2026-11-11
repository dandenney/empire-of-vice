// Issue #58: every player-facing string in apps/game/src comes from a copy.ts
// marked PLACEHOLDER copy (story decision), so a copy pass changes wording
// without touching components. A copy.ts whose wording the human has approved
// says so instead, in a first-line header that cites the approving issue:
// `// APPROVED copy (#145): ...` (#155).
//
// The scan parses every source file outside copy.ts and flags:
//   - JSX text with anything but whitespace;
//   - string literals rendered as JSX children (`{"Save"}`, `{cond ? "a" : b}`);
//   - string literals in player-facing JSX props (title, aria-label, ...);
//   - string literals in `title` / `label` object properties (panel registry,
//     option lists, createElement props);
//   - Error messages written as literals, which reach the player through
//     SHELL_COPY.error, except the developer-only ones in ALLOWED_ERRORS.
// Whitespace-only and empty strings are allowed. data-testid, className, keys,
// ids, and other non-visible strings aren't scanned.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { describeReason, formatGameDate, formatQuality } from "../../../src/components/format.ts";

const SRC = fileURLToPath(new URL("../../../src", import.meta.url));

/** JSX props a player reads or hears. */
const PLAYER_FACING_PROPS = new Set([
  "title",
  "alt",
  "placeholder",
  "label",
  "aria-label",
  "aria-description",
  "aria-placeholder",
  "aria-roledescription",
  "aria-valuetext",
]);

/** Object properties that carry a player-visible label. */
const LABEL_PROPERTIES = new Set(["title", "label"]);

/** Error constructors whose message can reach the player. */
const ERROR_CONSTRUCTORS = new Set(["Error", "RangeError", "TypeError", "GatewayError"]);

/** Developer-only errors: they fire before any UI exists, never in front of a player. */
const ALLOWED_ERRORS: readonly { readonly file: string; readonly text: string }[] = [
  { file: "index.tsx", text: "index.html has no #root element" },
  { file: "state/app-context.tsx", text: "AppProvider is missing" },
];

const EQUALITY_OPERATORS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
  readonly text: string;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

const isCopyFile = (path: string): boolean => /(^|\/)copy\.ts$/.test(path);

const PLACEHOLDER_MARKER = "PLACEHOLDER copy (story decision)";
/** An approved copy file's first line: the marker and the issue that approved it. */
const APPROVED_HEADER = /^\/\/ APPROVED copy \(#\d+\)/;

/** A copy.ts is still placeholder wording, or its first line says which issue approved it. */
const isMarkedCopy = (code: string): boolean => code.includes(PLACEHOLDER_MARKER) || APPROVED_HEADER.test(code);

/** The literal text of a string or template literal (template parts only), or null. */
function literalText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join("");
  return null;
}

const visible = (text: string | null): text is string => text !== null && text.trim() !== "";

/** Visible literals in an expression, not descending into JSX (that's scanned on its own). */
function literalsIn(node: ts.Node): string[] {
  const text = literalText(node);
  if (text !== null) return visible(text) ? [text] : [];
  if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) return [];
  // A comparison renders a boolean, never its operands (`side === "DEBIT" ? ...`).
  if (ts.isBinaryExpression(node) && EQUALITY_OPERATORS.has(node.operatorToken.kind)) return [];
  const found: string[] = [];
  node.forEachChild((child) => {
    found.push(...literalsIn(child));
  });
  return found;
}

function nameOf(node: ts.Node): string | null {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node)) return node.text;
  if (ts.isJsxNamespacedName(node)) return `${node.namespace.text}:${node.name.text}`;
  return null;
}

/** Scans one file's text. */
function scan(file: string, code: string): Violation[] {
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const violations: Violation[] = [];
  const report = (node: ts.Node, rule: string, text: string): void => {
    violations.push({ file, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, rule, text: text.trim() });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node) && visible(node.text)) report(node, "JSX text", node.text);

    if (ts.isJsxExpression(node) && node.expression && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) {
      for (const text of literalsIn(node.expression)) report(node, "JSX child literal", text);
    }

    if (ts.isJsxAttribute(node) && PLAYER_FACING_PROPS.has(nameOf(node.name) ?? "") && node.initializer) {
      const init = node.initializer;
      const texts = ts.isJsxExpression(init) ? (init.expression ? literalsIn(init.expression) : []) : literalsIn(init);
      for (const text of texts) report(node, `"${nameOf(node.name)}" prop literal`, text);
    }

    if (ts.isPropertyAssignment(node) && LABEL_PROPERTIES.has(nameOf(node.name) ?? "")) {
      for (const text of literalsIn(node.initializer)) report(node, `"${nameOf(node.name)}" property literal`, text);
    }

    if ((ts.isNewExpression(node) || ts.isCallExpression(node)) && ts.isIdentifier(node.expression) && ERROR_CONSTRUCTORS.has(node.expression.text)) {
      const message = node.arguments?.[0];
      // Every literal in the message expression, so `cond ? m : \`Unexpected ...\`` is caught too.
      for (const text of message ? literalsIn(message) : []) {
        if (!ALLOWED_ERRORS.some((a) => file.endsWith(a.file) && a.text === text)) report(node, "error message literal", text);
      }
    }

    node.forEachChild(visit);
  };
  visit(source);
  return violations;
}

describe("player-facing strings live in copy.ts (#58)", () => {
  const files = sourceFiles(SRC);

  it("finds the app's source files", () => {
    expect(files.some((f) => f.endsWith(".tsx"))).toBe(true);
    expect(files.filter(isCopyFile).length).toBeGreaterThan(0);
  });

  it("no component or module outside copy.ts holds a player-facing literal", () => {
    const violations = files
      .filter((f) => !isCopyFile(f))
      .flatMap((f) => scan(relative(SRC, f), readFileSync(f, "utf8")))
      .map((v) => `${v.file}:${v.line} ${v.rule}: ${JSON.stringify(v.text)}`);
    expect(violations).toEqual([]);
  });

  it("every copy.ts is marked PLACEHOLDER copy (story decision), or APPROVED copy (#N) in its header", () => {
    const unmarked = files.filter(isCopyFile).filter((f) => !isMarkedCopy(readFileSync(f, "utf8")));
    expect(unmarked.map((f) => relative(SRC, f))).toEqual([]);
  });

  it("the copy marker check accepts only the two markers (#155)", () => {
    expect(isMarkedCopy(`// ${PLACEHOLDER_MARKER}: shell strings.\nexport const A = "a";`)).toBe(true);
    expect(isMarkedCopy(`// APPROVED copy (#145): save/load strings.\nexport const A = "a";`)).toBe(true);
    // A copy file with neither marker is caught.
    expect(isMarkedCopy(`// Shell strings.\nexport const A = "a";`)).toBe(false);
    // Approval cites the approving issue, and is the file's header, not a passing mention.
    expect(isMarkedCopy(`// APPROVED copy: save/load strings.\nexport const A = "a";`)).toBe(false);
    expect(isMarkedCopy(`// Shell strings.\n// APPROVED copy (#145)\nexport const A = "a";`)).toBe(false);
  });

  it("the scan catches each kind of literal it's meant to", () => {
    const code = [
      `const a = <p>Hello</p>;`,
      `const b = <p>{"Hi"}</p>;`,
      `const c = <p>{x ? "Yes" : y}</p>;`,
      `const d = <svg aria-label="Map" />;`,
      `const e = <svg title={\`Map \${n}\`} />;`,
      `const f = { label: "Pause" };`,
      `throw new Error("Something broke");`,
      `throw new GatewayError(r.type === "ERROR" ? r.message : \`Bad response \${r.type}\`);`,
      `const ok = <p data-testid="fine" className="fine">{x}{" "}{y ? z : ""}{s === "DEBIT" ? d : c}</p>;`,
    ].join("\n");
    expect(scan("fixture.tsx", code).map((v) => [v.line, v.text])).toEqual([
      [1, "Hello"],
      [2, "Hi"],
      [3, "Yes"],
      [4, "Map"],
      [5, "Map"],
      [6, "Pause"],
      [7, "Something broke"],
      [8, "Bad response"],
    ]);
  });
});

describe("copy maps keep today's wording", () => {
  it("rejection reasons: label, code, then fields", () => {
    expect(describeReason({ code: "INSUFFICIENT_MATERIALS", materialId: "corn" as never, required: 4, available: 0 })).toBe(
      "Not enough materials (INSUFFICIENT_MATERIALS, materialId: corn, required: 4, available: 0)",
    );
    expect(describeReason({ code: "INSUFFICIENT_STOCK", productId: "moonshine" as never, quality: "basic", requested: 2, available: 1 })).toBe(
      "Not enough stock (INSUFFICIENT_STOCK, productId: moonshine, quality: basic, requested: 2, available: 1)",
    );
  });

  it("quality tiers", () => {
    expect(formatQuality("basic")).toBe("basic");
  });

  it("the game date", () => {
    expect(formatGameDate({ year: 1920, month: 1, day: 7, hour: 9, minute: 5 } as never)).toBe("1920-01-07 09:05");
  });
});
