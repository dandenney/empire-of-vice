// Economy smoke loop (T07a, issue #12; T05g, issue #106): an early balance warning.
//
//   pnpm --filter @eov/economy-lab smoke --seeds 50 [--strategy greedy-spot|contract-taker] [--days 10] [--first-seed 1] [--json]
//
// Runs a strategy (the greedy spot seller by default, or the contract-taking
// variant) on seeds first-seed … first-seed + N − 1 (each overrides the scenario
// seed) for D game days, and prints the report: per-seed metrics, their
// distribution, and the GDD §13 comparison. Both report tiers, victory, and
// insolvency; run the contract-taking variant with `--days 15` for ADR 0020
// decision 15's feasibility check. The exit code is non-zero only if a seed
// crashes or breaks an invariant. Missed balance targets are reported, not
// failed, so placeholder tuning can't turn CI red.

import { formatSmokeReport, summarize, type SeedFailure, type SmokeSummary } from "./smoke-report.ts";
import { DEFAULT_DAYS, runSmokeSeed, STRATEGY_NAMES, type SeedReport, type SmokeOptions, type StrategyName } from "./smoke-run.ts";

export interface SmokeArgs {
  readonly seeds: number;
  readonly firstSeed: number;
  readonly days: number;
  readonly strategy: StrategyName;
  readonly json: boolean;
}

export class SmokeArgsError extends Error {
  override readonly name = "SmokeArgsError";
}

const USAGE = `usage: smoke --seeds N [--strategy ${STRATEGY_NAMES.join("|")}] [--days D] [--first-seed S] [--json]`;

export function parseSmokeArgs(argv: readonly string[]): SmokeArgs {
  let seeds = 1;
  let firstSeed = 1;
  let days = DEFAULT_DAYS;
  let strategy: StrategyName = STRATEGY_NAMES[0];
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
      case "--strategy": {
        const name = value();
        const known = STRATEGY_NAMES.find((s) => s === name);
        if (known === undefined) throw new SmokeArgsError(`--strategy needs one of ${STRATEGY_NAMES.join(", ")}. ${USAGE}`);
        strategy = known;
        break;
      }
      case "--json":
        json = true;
        break;
      default:
        throw new SmokeArgsError(`Unknown argument ${arg}. ${USAGE}`);
    }
  }
  return { seeds, firstSeed, days, strategy, json };
}

export interface SmokeResult {
  readonly reports: readonly SeedReport[];
  readonly summary: SmokeSummary;
}

/** Runs every seed. A seed that throws is recorded as a failure; the others still run. */
export function runSmoke(
  args: Pick<SmokeArgs, "seeds" | "firstSeed" | "days"> & { readonly strategy?: StrategyName },
  options: Omit<SmokeOptions, "days" | "strategy"> = {},
): SmokeResult {
  const strategy = args.strategy ?? STRATEGY_NAMES[0];
  const reports: SeedReport[] = [];
  const failures: SeedFailure[] = [];
  for (let i = 0; i < args.seeds; i++) {
    const seed = args.firstSeed + i;
    try {
      reports.push(runSmokeSeed(seed, { ...options, days: args.days, strategy }));
    } catch (error) {
      const e = error instanceof Error ? error : new Error(String(error));
      failures.push({ seed, error: e.name, message: e.message });
    }
  }
  return { reports, summary: summarize(reports, failures, args.days, strategy) };
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
  if (args.json) console.log(JSON.stringify({ strategy: summary.strategy, summary, reports }, null, 2));
  else console.log(formatSmokeReport(summary, reports));
  if (summary.failures.length > 0) {
    console.error(`${summary.failures.length} of ${summary.seeds} seeds crashed or broke an invariant.`);
    process.exitCode = 1;
  }
}
