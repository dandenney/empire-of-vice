// @eov/economy-lab: headless runner for seeded playthroughs and balance reports.
// T07a adds the economy smoke loop (greedy spot-sale strategy and its report).
export * from "./greedy-spot.ts";
export * from "./smoke-report.ts";
export * from "./smoke-run.ts";
export { parseSmokeArgs, runSmoke, SmokeArgsError, type SmokeArgs, type SmokeResult } from "./smoke.ts";
