// Lint fixture: every line marked `expect:` must be reported by the boundary rules.
// Not compiled or linted directly (see eslint.config.js ignores and tsconfig.test.json).
// The test lints this text as if it lived at packages/simulation/src/.
import React from "react"; // expect: no-restricted-imports
import { createRoot } from "react-dom/client"; // expect: no-restricted-imports
import { Application } from "pixi.js"; // expect: no-restricted-imports
import Dexie from "dexie"; // expect: no-restricted-imports
import { App } from "@eov/game"; // expect: no-restricted-imports
import { Panel } from "../../../apps/game/src/panel"; // expect: no-restricted-imports

export const used = [React, createRoot, Application, Dexie, App, Panel];

export const w = window.innerWidth; // expect: no-restricted-globals
export const d = document.title; // expect: no-restricted-globals
export const idb = indexedDB.open("saves"); // expect: no-restricted-globals
export const ls = localStorage.getItem("save"); // expect: no-restricted-globals
export const gw = globalThis.window; // expect: no-restricted-properties

export const r = Math.random(); // expect: no-restricted-properties
export const now = Date.now(); // expect: no-restricted-properties
export const e = Math.exp(1); // expect: no-restricted-properties
export const p = Math.pow(2, 0.5); // expect: no-restricted-properties
export const l = Math.log(10); // expect: no-restricted-properties
export const s = Math.sin(1); // expect: no-restricted-properties
export const c = Math.cos(1); // expect: no-restricted-properties
export const t = Math.tan(1); // expect: no-restricted-properties
export const a2 = Math.atan2(1, 2); // expect: no-restricted-properties
const { random } = Math; // expect: no-restricted-properties
export const rr = random();
export const sq = 2 ** 0.5; // expect: no-restricted-syntax
export const today = new Date(); // expect: no-restricted-syntax
