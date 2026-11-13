// The line under a Market command button: pending, the error, or the outcome
// with its typed reason (QUOTE_CHANGED and BUYER_WILL_TAKE_LESS with their numbers).

import { COMMON_COPY } from "../../components/copy.ts";
import type { CommandHandle } from "../../components/use-command.ts";
import { describeMarketOutcome } from "./market-view.ts";

export function CommandResult({ command, testId }: { readonly command: Pick<CommandHandle, "pending" | "outcome" | "error">; readonly testId: string }) {
  return (
    <p role="status" className="market-result" data-testid={testId}>
      {command.pending ? COMMON_COPY.pending : command.error ? command.error : command.outcome ? describeMarketOutcome(command.outcome) : ""}
    </p>
  );
}
