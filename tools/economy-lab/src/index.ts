// @eov/economy-lab: headless runner for seeded playthroughs and balance reports.
// T07a adds the economy smoke loop (greedy spot-sale strategy and its report);
// T05g adds the contract-taking variant and the tier, victory, and insolvency metrics.
// T07b adds the four GDD §13 strategies and the seeded batch runner; T07c the
// shared GDD §13 targets and the balance report.
export * from "./batch-run.ts";
export * from "./batch.ts";
export * from "./contract-taker.ts";
export * from "./headless-strategy.ts";
export * from "./prng.ts";
export * from "./strategies.ts";
export * from "./greedy-spot.ts";
export * from "./smoke-report.ts";
export * from "./smoke-run.ts";
export { parseSmokeArgs, runSmoke, SmokeArgsError, type SmokeArgs, type SmokeResult } from "./smoke.ts";
export * from "./targets.ts";
export * from "./report.ts";
export * from "./setback-scenario.ts";
