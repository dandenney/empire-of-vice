// @ts-check
import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * Package boundaries (CLAUDE.md rules 1 and 5, architecture §3 and §8).
 *
 * `packages/simulation` must run identically in a Web Worker and in Node, and
 * must be deterministic across JS engines. `packages/contracts` and
 * `packages/game-data` are imported by the simulation, so they get the same
 * import and browser-global restrictions (otherwise a UI or storage import
 * would reach the simulation transitively). The determinism restrictions
 * apply to the simulation only.
 */

const SIM_DEPENDENCY_CLOSURE = [
  "packages/simulation/**/*.{ts,tsx,js,mjs,cjs}",
  "packages/contracts/**/*.{ts,tsx,js,mjs,cjs}",
  "packages/game-data/**/*.{ts,tsx,js,mjs,cjs}",
];

const UI_OR_STORAGE_MESSAGE =
  "Simulation-side packages must run in a Web Worker and in Node: no UI, rendering, or browser-storage dependencies (CLAUDE.md rule 1).";

const forbiddenImports = {
  paths: [
    { name: "react", message: UI_OR_STORAGE_MESSAGE },
    { name: "react-dom", message: UI_OR_STORAGE_MESSAGE },
    { name: "pixi.js", message: UI_OR_STORAGE_MESSAGE },
    { name: "dexie", message: UI_OR_STORAGE_MESSAGE },
    { name: "zustand", message: UI_OR_STORAGE_MESSAGE },
    { name: "@eov/game", message: UI_OR_STORAGE_MESSAGE },
  ],
  patterns: [
    {
      group: [
        "react/*",
        "react-dom/*",
        "pixi.js/*",
        "@pixi/*",
        "dexie/*",
        "zustand/*",
        "@eov/game/*",
      ],
      message: UI_OR_STORAGE_MESSAGE,
    },
    {
      group: ["**/apps/**"],
      message: "Packages must never import from apps/ (CLAUDE.md rule 1).",
    },
  ],
};

const BROWSER_GLOBALS = [
  "window",
  "document",
  "indexedDB",
  "localStorage",
  "sessionStorage",
];

const forbiddenGlobals = BROWSER_GLOBALS.map((name) => ({
  name,
  message: `\`${name}\` is a browser API. ${UI_OR_STORAGE_MESSAGE}`,
}));

const forbiddenGlobalThisProps = BROWSER_GLOBALS.map((property) => ({
  object: "globalThis",
  property,
  message: `\`globalThis.${property}\` is a browser API. ${UI_OR_STORAGE_MESSAGE}`,
}));

const NONDETERMINISTIC_MESSAGE =
  "Non-deterministic. Use the seeded RNG / simulation clock (CLAUDE.md rule 5).";

const ENGINE_DEPENDENT_MESSAGE =
  "Engine-dependent floating-point result (architecture §8). Use integer/fixed-point math or a vetted pure-JS implementation.";

// Math functions whose results are not required to be correctly rounded by the
// spec and can differ between V8, SpiderMonkey, and JavaScriptCore.
const ENGINE_DEPENDENT_MATH = [
  "exp",
  "expm1",
  "pow",
  "log",
  "log1p",
  "log2",
  "log10",
  "sin",
  "cos",
  "tan",
  "asin",
  "acos",
  "atan",
  "atan2",
  "sinh",
  "cosh",
  "tanh",
  "asinh",
  "acosh",
  "atanh",
  "cbrt",
  "hypot",
];

const forbiddenDeterminismProps = [
  { object: "Math", property: "random", message: NONDETERMINISTIC_MESSAGE },
  { object: "Date", property: "now", message: NONDETERMINISTIC_MESSAGE },
  { object: "performance", property: "now", message: NONDETERMINISTIC_MESSAGE },
  ...ENGINE_DEPENDENT_MATH.map((property) => ({
    object: "Math",
    property,
    message: ENGINE_DEPENDENT_MESSAGE,
  })),
];

export default defineConfig(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/coverage/**",
      "**/test-results/**",
      "**/playwright-report/**",
      // Lint fixtures contain deliberate violations; tests lint them explicitly.
      "**/test/fixtures/**",
    ],
  },

  js.configs.recommended,
  tseslint.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
    },
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
  },

  // Root config files and Node-side tooling.
  {
    files: [
      "*.{js,mjs,cjs,ts}",
      "**/*.config.{js,mjs,cjs,ts}",
      "tools/**/*.{ts,js}",
      "**/test/**/*.ts",
    ],
    languageOptions: { globals: { ...globals.node } },
  },

  // Browser app.
  {
    files: ["apps/game/**/*.{ts,tsx}"],
    languageOptions: { globals: { ...globals.browser } },
  },

  // Simulation and the packages it depends on: no UI, storage, or browser globals.
  {
    files: SIM_DEPENDENCY_CLOSURE,
    rules: {
      "no-restricted-imports": ["error", forbiddenImports],
      "no-restricted-globals": ["error", ...forbiddenGlobals],
      "no-restricted-properties": ["error", ...forbiddenGlobalThisProps],
    },
  },

  // Simulation only: determinism across runs and across JS engines.
  {
    files: ["packages/simulation/**/*.{ts,tsx,js,mjs,cjs}"],
    rules: {
      // Repeats the globalThis entries: flat config replaces, not merges, rule options.
      "no-restricted-properties": [
        "error",
        ...forbiddenGlobalThisProps,
        ...forbiddenDeterminismProps,
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "BinaryExpression[operator='**']",
          message: `\`**\` is Math.pow. ${ENGINE_DEPENDENT_MESSAGE}`,
        },
        {
          selector: "AssignmentExpression[operator='**=']",
          message: `\`**=\` is Math.pow. ${ENGINE_DEPENDENT_MESSAGE}`,
        },
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message: `\`new Date()\` reads the wall clock. ${NONDETERMINISTIC_MESSAGE}`,
        },
        {
          selector: "CallExpression[callee.name='Date']",
          message: `\`Date()\` reads the wall clock. ${NONDETERMINISTIC_MESSAGE}`,
        },
      ],
    },
  },
);
