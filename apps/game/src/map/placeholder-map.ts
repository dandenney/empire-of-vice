// S0's placeholder SVG map is gone: T04b (#17) replaced it with the PixiJS map
// (pixi-map.ts, drawn from scene.ts). This file stays only because
// src/app/test-hook.ts, outside T04b's owned files, imports `SceneShape` from
// here. Point that import at ./scene.ts and delete this file in a follow-up.

export type { SceneShape } from "./scene.ts";
