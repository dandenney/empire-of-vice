// A batch worker thread (T07b, issue #119): runs its share of (strategy, seed)
// pairs and posts the results back. Each run is independent and deterministic, so
// how the runs are split across threads never changes the results file.

import { parentPort, workerData } from "node:worker_threads";
import { runBatchSeed, type BatchRunResult } from "./batch-run.ts";
import type { HeadlessStrategyName } from "./headless-strategy.ts";

export interface BatchWorkerInput {
  readonly days: number;
  readonly tasks: readonly { readonly strategy: HeadlessStrategyName; readonly seed: number }[];
}

if (parentPort) {
  const input = workerData as BatchWorkerInput;
  const results: BatchRunResult[] = input.tasks.map((t) => runBatchSeed(t.strategy, t.seed, { days: input.days }));
  parentPort.postMessage(results);
}
