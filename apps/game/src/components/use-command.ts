// Sends one command through the gateway, with a pending flag in the UI store
// and the outcome (applied, queued, or the typed rejection) kept for display.
// The outcome is a request's result, not game state.

import { useCallback, useState } from "react";
import type { CommandRequest } from "@eov/contracts";
import { useGateway, useUi } from "../state/app-context.tsx";
import type { DispatchOutcome } from "../state/gateway-client.ts";

export interface CommandHandle {
  readonly pending: boolean;
  readonly outcome: DispatchOutcome | null;
  readonly error: string | null;
  send(request: CommandRequest): Promise<void>;
}

export function useCommand(key: string): CommandHandle {
  const gateway = useGateway();
  const pending = useUi((s) => key in s.pending);
  const setPending = useUi((s) => s.setPending);
  const [outcome, setOutcome] = useState<DispatchOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);

  const send = useCallback(
    async (request: CommandRequest) => {
      setPending(key, true);
      setError(null);
      try {
        setOutcome(await gateway.dispatch(request));
      } catch (e) {
        setOutcome(null);
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setPending(key, false);
      }
    },
    [gateway, key, setPending],
  );

  return { pending, outcome, error, send };
}
