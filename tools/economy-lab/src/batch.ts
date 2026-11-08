// Seeded batch runner (T07b, issue #119):
//
//   pnpm --filter @eov/economy-lab batch --seeds N [--strategy name] [--days D] [--out path] [--jobs J]
//
// Plays every GDD §13 strategy (or one) on seeds 1..N, each run until victory,
// loss, or the day cap, and writes the raw results as JSON. The file holds no
// timestamps or timings, so the same arguments give a byte-identical file; the
// wall time goes to stderr. The exit code is non-zero if any run broke an
// invariant or its replay diverged. Balance targets aren't judged here: the
// formatted report against GDD §13 is T07c's.
//
// Runs are split across J worker threads (default: the machine's parallelism, up
// to 8). Every run is independent and the results are put back in (strategy,
// seed) order, so J never changes the file.

import { mkdirSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { GAME_DATA_VERSION } from "@eov/game-data";
import { DEFAULT_BATCH_DAYS, runBatchSeed, type BatchRunOptions, type BatchRunResult } from "./batch-run.ts";
import type { BatchWorkerInput } from "./batch-worker.ts";
import { HEADLESS_STRATEGY_NAMES, type HeadlessStrategyName } from "./headless-strategy.ts";
import { distribution, type Distribution } from "./smoke-report.ts";
import { TICKS_PER_REAL_MINUTE } from "./smoke-run.ts";

/** Bumped when the results file's shape changes. */
export const BATCH_FORMAT_VERSION = 2;

/** Where the results go by default, relative to the working directory (`dist/` is git-ignored). */
export const DEFAULT_BATCH_OUT = "dist/batch-results.json";

/** Default worker threads: the machine's parallelism, capped. */
export const DEFAULT_BATCH_JOBS = Math.min(8, availableParallelism());

export interface BatchArgs {
  readonly seeds: number;
  readonly days: number;
  /** null: every strategy. */
  readonly strategy: HeadlessStrategyName | null;
  readonly out: string;
  /** Worker threads. 1 runs everything on the main thread. */
  readonly jobs: number;
}

export class BatchArgsError extends Error {
  override readonly name = "BatchArgsError";
}

const USAGE = `usage: batch --seeds N [--strategy ${HEADLESS_STRATEGY_NAMES.join("|")}] [--days D] [--out path] [--jobs J]`;

export function parseBatchArgs(argv: readonly string[]): BatchArgs {
  let seeds: number | null = null;
  let days = DEFAULT_BATCH_DAYS;
  let strategy: HeadlessStrategyName | null = null;
  let out = DEFAULT_BATCH_OUT;
  let jobs = DEFAULT_BATCH_JOBS;
  const int = (flag: string, value: string | undefined): number => {
    const n = Number(value);
    if (value === undefined || !Number.isSafeInteger(n) || n < 1) throw new BatchArgsError(`${flag} needs an integer ≥ 1. ${USAGE}`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const [flag, inline] = arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
    const value = (): string | undefined => inline ?? argv[++i];
    switch (flag) {
      case "--":
        break;
      case "--seeds":
        seeds = int(flag, value());
        break;
      case "--days":
        days = int(flag, value());
        break;
      case "--jobs":
        jobs = int(flag, value());
        break;
      case "--strategy": {
        const name = value();
        const known = HEADLESS_STRATEGY_NAMES.find((s) => s === name);
        if (known === undefined) throw new BatchArgsError(`--strategy needs one of ${HEADLESS_STRATEGY_NAMES.join(", ")}. ${USAGE}`);
        strategy = known;
        break;
      }
      case "--out": {
        const path = value();
        if (!path) throw new BatchArgsError(`--out needs a path. ${USAGE}`);
        out = path;
        break;
      }
      default:
        throw new BatchArgsError(`Unknown argument ${arg}. ${USAGE}`);
    }
  }
  if (seeds === null) throw new BatchArgsError(`--seeds is required. ${USAGE}`);
  return { seeds, days, strategy, out, jobs };
}

/** A tick distribution, with the median in real minutes at 1×. */
export interface TimeDistribution extends Distribution {
  readonly medianRealMinutes: number;
}

export interface StrategySummary {
  readonly strategy: HeadlessStrategyName;
  readonly runs: number;
  readonly won: number;
  readonly lost: number;
  readonly dayCap: number;
  /** won / runs, in percent, two decimals. */
  readonly winRatePercent: number;
  readonly timeToVictory: TimeDistribution | null;
  readonly firstProfitableSale: TimeDistribution | null;
  readonly firstUpgrade: TimeDistribution | null;
  readonly runsWithInvariantViolations: number;
  readonly replayDivergences: number;
}

export interface BatchFile {
  readonly format: number;
  readonly gameDataVersion: string;
  readonly seeds: { readonly first: number; readonly last: number };
  readonly days: number;
  readonly strategies: readonly HeadlessStrategyName[];
  readonly summary: readonly StrategySummary[];
  readonly runs: readonly BatchRunResult[];
}

function times(values: readonly number[]): TimeDistribution | null {
  const d = distribution(values);
  return d ? { ...d, medianRealMinutes: d.median / TICKS_PER_REAL_MINUTE } : null;
}

export function summarizeStrategy(strategy: HeadlessStrategyName, runs: readonly BatchRunResult[]): StrategySummary {
  const mine = runs.filter((r) => r.strategy === strategy);
  const won = mine.filter((r) => r.outcome === "WON").length;
  const ticks = (pick: (r: BatchRunResult) => { readonly tick: number } | null): number[] => mine.flatMap((r) => (pick(r) ? [pick(r)!.tick] : []));
  return {
    strategy,
    runs: mine.length,
    won,
    lost: mine.filter((r) => r.outcome === "LOST").length,
    dayCap: mine.filter((r) => r.outcome === "DAY_CAP").length,
    winRatePercent: mine.length === 0 ? 0 : Math.round((won * 10_000) / mine.length) / 100,
    timeToVictory: times(ticks((r) => r.victory)),
    firstProfitableSale: times(ticks((r) => r.firstProfitableSale)),
    firstUpgrade: times(ticks((r) => r.firstUpgrade)),
    runsWithInvariantViolations: mine.filter((r) => r.invariantViolationCount > 0).length,
    replayDivergences: mine.filter((r) => r.replayDiverged).length,
  };
}

type Plan = Pick<BatchArgs, "seeds" | "days" | "strategy">;

const strategiesOf = (args: Plan): HeadlessStrategyName[] => (args.strategy === null ? [...HEADLESS_STRATEGY_NAMES] : [args.strategy]);

/** Every run, in file order: each strategy in GDD order, seeds 1..N. */
export function batchTasks(args: Plan): { readonly strategy: HeadlessStrategyName; readonly seed: number }[] {
  return strategiesOf(args).flatMap((strategy) => Array.from({ length: args.seeds }, (_, i) => ({ strategy, seed: i + 1 })));
}

function assemble(args: Plan, runs: readonly BatchRunResult[]): BatchFile {
  const strategies = strategiesOf(args);
  return {
    format: BATCH_FORMAT_VERSION,
    gameDataVersion: GAME_DATA_VERSION,
    seeds: { first: 1, last: args.seeds },
    days: args.days,
    strategies,
    summary: strategies.map((s) => summarizeStrategy(s, runs)),
    runs,
  };
}

/** Runs the batch on this thread. */
export function runBatch(args: Plan, options: Omit<BatchRunOptions, "days"> = {}): BatchFile {
  return assemble(
    args,
    batchTasks(args).map((t) => runBatchSeed(t.strategy, t.seed, { ...options, days: args.days })),
  );
}

/** Runs the batch on `jobs` worker threads, each taking a contiguous share of the runs. Same file as `runBatch`. */
export async function runBatchParallel(args: Plan, jobs: number): Promise<BatchFile> {
  const tasks = batchTasks(args);
  const threads = Math.max(1, Math.min(jobs, tasks.length));
  const size = Math.ceil(tasks.length / threads);
  const shares = Array.from({ length: threads }, (_, i) => tasks.slice(i * size, (i + 1) * size)).filter((share) => share.length > 0);
  const parts = await Promise.all(
    shares.map(
      (share) =>
        new Promise<BatchRunResult[]>((resolveShare, reject) => {
          const workerData: BatchWorkerInput = { days: args.days, tasks: share };
          const worker = new Worker(new URL("./batch-worker.ts", import.meta.url), { workerData });
          let posted = false;
          worker.once("message", (results: BatchRunResult[]) => {
            posted = true;
            resolveShare(results);
          });
          worker.once("error", reject);
          // Settles the promise on every exit: a worker that exits cleanly without
          // posting its results is an error too, not a hang (#122 review).
          worker.once("exit", (code) => {
            if (code !== 0) reject(new Error(`Batch worker exited with code ${code}`));
            else if (!posted) reject(new Error("Batch worker exited without posting its results"));
          });
        }),
    ),
  );
  return assemble(args, parts.flat());
}

/** The results file's text. Deterministic: plain objects built in a fixed key order. */
export function formatBatchFile(file: BatchFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** Whether the batch failed: any invariant violation or replay divergence. */
export function batchFailed(file: BatchFile): boolean {
  return file.summary.some((s) => s.runsWithInvariantViolations > 0 || s.replayDivergences > 0);
}

/** A one-line-per-strategy summary for the console. */
export function formatBatchSummary(file: BatchFile): string {
  const lines = [`Batch: ${file.strategies.length} strategies × seeds ${file.seeds.first}..${file.seeds.last}, day cap ${file.days} (game-data ${file.gameDataVersion})`];
  lines.push("| Strategy | Runs | Won | Lost | Day cap | Win rate | Median time to victory | Invariant runs | Replay divergences |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const s of file.summary) {
    const median = s.timeToVictory ? `${s.timeToVictory.median} ticks (${s.timeToVictory.medianRealMinutes.toFixed(1)} min)` : "none";
    lines.push(`| ${s.strategy} | ${s.runs} | ${s.won} | ${s.lost} | ${s.dayCap} | ${s.winRatePercent.toFixed(2)}% | ${median} | ${s.runsWithInvariantViolations} | ${s.replayDivergences} |`);
  }
  return lines.join("\n");
}

export interface BatchIo {
  readonly write: (path: string, text: string) => void;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  /** Milliseconds, for the wall time on stderr only. Never written to the results file. */
  readonly now: () => number;
}

const NODE_IO: BatchIo = {
  write: (path, text) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  },
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  now: () => performance.now(),
};

/**
 * The CLI. Returns the exit code: 0, 1 for an invariant violation or replay
 * divergence, 2 for bad arguments. `options` (test hooks) can't cross into worker
 * threads, so passing any runs the batch on this thread.
 */
export async function batchMain(argv: readonly string[], io: BatchIo = NODE_IO, options: Omit<BatchRunOptions, "days"> = {}): Promise<number> {
  let args: BatchArgs;
  try {
    args = parseBatchArgs(argv);
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return 2;
  }
  const onThread = args.jobs === 1 || Object.keys(options).length > 0;
  const started = io.now();
  const file = onThread ? runBatch(args, options) : await runBatchParallel(args, args.jobs);
  const seconds = (io.now() - started) / 1000;
  const path = resolve(args.out);
  io.write(path, formatBatchFile(file));
  io.out(formatBatchSummary(file));
  io.out(`Wrote ${path}`);
  io.err(`Wall time: ${seconds.toFixed(1)} s for ${file.runs.length} runs on ${onThread ? 1 : Math.min(args.jobs, file.runs.length)} thread(s)`);
  if (batchFailed(file)) {
    const bad = file.summary.reduce((n, s) => n + s.runsWithInvariantViolations, 0);
    const diverged = file.summary.reduce((n, s) => n + s.replayDivergences, 0);
    io.err(`${bad} run(s) broke an invariant and ${diverged} replay(s) diverged.`);
    return 1;
  }
  return 0;
}

if (import.meta.main) process.exitCode = await batchMain(process.argv.slice(2));
