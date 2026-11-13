// The placeholder new-game choice for the First Hire (SK2a, #174): one button,
// shown in the dock while no game runs and in the First Hire's placeholder
// shell. The top bar's New game still starts the First Shipment, so M001's
// shell is unchanged. SK2b (#234) owns the real new-game screen.

import { THE_FIRST_HIRE_SCENARIO } from "@eov/game-data";
import { useStartNewGame } from "../../state/app-context.tsx";
import { SAVES_COPY } from "../saves/copy.ts";
import { FOUNDER_COPY } from "./copy.ts";

export function NewGameChoice({
  busy,
  setBusy,
  say,
}: {
  readonly busy: boolean;
  readonly setBusy: (busy: boolean) => void;
  readonly say: (message: string) => void;
}) {
  const startNewGame = useStartNewGame();
  const start = async () => {
    setBusy(true);
    try {
      await startNewGame(THE_FIRST_HIRE_SCENARIO.id);
      say(SAVES_COPY.newGameStarted);
    } catch (error) {
      say(SAVES_COPY.error(error instanceof Error ? error.message : String(error)));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="new-game-choice">
      <button type="button" className="button" data-testid="new-game-first-hire" disabled={busy} onClick={() => void start()}>
        {FOUNDER_COPY.newGame(THE_FIRST_HIRE_SCENARIO.name)}
      </button>
    </div>
  );
}
