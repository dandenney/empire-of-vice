// The line under a Contracts command button: pending, the error, or the
// outcome with its typed reason.

import { COMMON_COPY } from "../../components/copy.ts";
import { describeOutcome } from "../../components/format.ts";
import type { CommandHandle } from "../../components/use-command.ts";

export function CommandResult({ command, testId }: { readonly command: CommandHandle; readonly testId: string }) {
  return (
    <p role="status" className="contract-result" data-testid={testId}>
      {command.pending ? COMMON_COPY.pending : command.error ? command.error : command.outcome ? describeOutcome(command.outcome) : ""}
    </p>
  );
}
