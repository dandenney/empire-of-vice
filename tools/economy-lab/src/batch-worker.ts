// A batch worker thread (T07b, issue #119): runs its share of (strategy, seed)
// pairs and posts the results back. Each run is independent and deterministic, so
// how the runs are split across threads never changes the results file.

import { parentPort, workerData } from "node:worker_threads";
import type { BatchRunResult } from "./batch-run.ts";
import { runBatchTask, type BatchTask } from "./batch.ts";

export interface BatchWorkerInput {
  readonly days: number;
  readonly tasks: readonly BatchTask[];
}

if (parentPort) {
  const input = workerData as BatchWorkerInput;
  const results: BatchRunResult[] = input.tasks.map((t) => runBatchTask(t, { days: input.days }));
  parentPort.postMessage(results);
}
