// Economy smoke loop (T07a, issue #12): an early balance warning.
//
//   pnpm --filter @eov/economy-lab smoke --seeds 50 [--days 10] [--first-seed 1] [--json]
//
// Runs the greedy spot-sale strategy on seeds first-seed … first-seed + N − 1
// (each overrides the scenario seed) for D game days, and prints the report:
// per-seed metrics, their distribution, and the GDD §13 comparison. The exit
// code is non-zero only if a seed crashes or breaks an invariant. Missed balance
// targets are reported, not failed, so placeholder tuning can't turn CI red.

import { STRATEGY } from "./greedy-spot.ts";
import { formatSmokeReport, summarize, type SeedFailure, type SmokeSummary } from "./smoke-report.ts";
import { DEFAULT_DAYS, runSmokeSeed, type SeedReport, type SmokeOptions } from "./smoke-run.ts";

export interface SmokeArgs {
  readonly seeds: number;
  readonly firstSeed: number;
  readonly days: number;
  readonly json: boolean;
}

export class SmokeArgsError extends Error {
  override readonly name = "SmokeArgsError";
}

const USAGE = "usage: smoke --seeds N [--days D] [--first-seed S] [--json]";

export function parseSmokeArgs(argv: readonly string[]): SmokeArgs {
  let seeds = 1;
  let firstSeed = 1;
  let days = DEFAULT_DAYS;
  let json = false;
  const int = (flag: string, value: string | undefined, min: number): number => {
    const n = Number(value);
    if (value === undefined || !Number.isSafeInteger(n) || n < min) throw new SmokeArgsError(`${flag} needs an integer ≥ ${min}. ${USAGE}`);
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
        seeds = int(flag, value(), 1);
        break;
      case "--days":
        days = int(flag, value(), 1);
        break;
      case "--first-seed":
        firstSeed = int(flag, value(), Number.MIN_SAFE_INTEGER);
        break;
      case "--json":
        json = true;
        break;
      default:
        throw new SmokeArgsError(`Unknown argument ${arg}. ${USAGE}`);
    }
  }
  return { seeds, firstSeed, days, json };
}

export interface SmokeResult {
  readonly reports: readonly SeedReport[];
  readonly summary: SmokeSummary;
}

/** Runs every seed. A seed that throws is recorded as a failure; the others still run. */
export function runSmoke(args: Pick<SmokeArgs, "seeds" | "firstSeed" | "days">, options: Omit<SmokeOptions, "days"> = {}): SmokeResult {
  const reports: SeedReport[] = [];
  const failures: SeedFailure[] = [];
  for (let i = 0; i < args.seeds; i++) {
    const seed = args.firstSeed + i;
    try {
      reports.push(runSmokeSeed(seed, { ...options, days: args.days }));
    } catch (error) {
      const e = error instanceof Error ? error : new Error(String(error));
      failures.push({ seed, error: e.name, message: e.message });
    }
  }
  return { reports, summary: summarize(reports, failures, args.days) };
}

if (import.meta.main) {
  let args: SmokeArgs;
  try {
    args = parseSmokeArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
  const { reports, summary } = runSmoke(args);
  if (args.json) console.log(JSON.stringify({ strategy: STRATEGY.name, summary, reports }, null, 2));
  else console.log(formatSmokeReport(summary, reports));
  if (summary.failures.length > 0) {
    console.error(`${summary.failures.length} of ${summary.seeds} seeds crashed or broke an invariant.`);
    process.exitCode = 1;
  }
}
