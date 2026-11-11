// The top bar's game menu (T06a, #135), replacing the S0 New game / Save /
// Reload buttons:
//   - New game;
//   - while a game runs, Save: overwrites the slot this game was last saved
//     to or loaded from, keeping that slot's name (#145); with no such slot,
//     a new one named after the in-game date and time;
//   - while none does (a fresh page), Continue in its place: loads the newest
//     save;
//   - Saves…: the saves dialog (save to a new named slot, load, delete).
// A failed load opens the load-error screen; nothing is loaded.
//
// The current slot and the save list are UI state; game state stays in the
// worker. The list is re-read from storage on opening the dialog and after
// every change.

import type { SaveSummary } from "@eov/persistence";
import { useCallback, useEffect, useState } from "react";
import { formatGameDate } from "../../components/format.ts";
import { useGateway, useGatewayView } from "../../state/app-context.tsx";
import { SAVES_COPY } from "./copy.ts";
import { LoadErrorScreen, type FailedLoad } from "./load-error.tsx";
import { continueTarget, type SavedTo, type SaveLibrary } from "./save-library.ts";
import { SavesDialog } from "./saves-dialog.tsx";
import { saveLabel } from "./saves-view.ts";
import "./saves.css";

export function GameMenu({
  library,
  busy,
  setBusy,
  say,
}: {
  readonly library: SaveLibrary;
  readonly busy: boolean;
  readonly setBusy: (busy: boolean) => void;
  readonly say: (message: string) => void;
}) {
  const gateway = useGateway();
  const { snapshot } = useGatewayView();
  const [saves, setSaves] = useState<readonly SaveSummary[]>([]);
  const [currentSlot, setCurrentSlot] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [failed, setFailed] = useState<FailedLoad | null>(null);

  const refresh = useCallback(async () => setSaves(await library.list()), [library]);
  useEffect(() => {
    refresh().catch((error: unknown) => say(SAVES_COPY.error(messageOf(error))));
  }, [refresh, say]);

  /** Runs one action with the shell busy, then shows its message (if any). */
  const run = (action: () => Promise<string | null>) => async () => {
    setBusy(true);
    try {
      const message = await action();
      if (message !== null) say(message);
    } catch (error) {
      say(SAVES_COPY.error(messageOf(error)));
    } finally {
      setBusy(false);
    }
  };

  const defaultLabel = snapshot ? SAVES_COPY.defaultLabel(formatGameDate(snapshot.clock.date)) : null;

  const save = (write: () => Promise<SavedTo>) =>
    run(async () => {
      const saved = await write();
      setCurrentSlot(saved.slot);
      await refresh();
      return SAVES_COPY.saved(saved.label);
    });

  const load = (summary: SaveSummary) =>
    run(async () => {
      const attempt = await library.load(summary.slot);
      if (!attempt.ok) {
        setFailed({ slot: summary.slot, label: saveLabel(summary), failure: attempt.failure });
        return null;
      }
      setCurrentSlot(attempt.slot);
      setDialogOpen(false);
      return attempt.otherGameData === null ? SAVES_COPY.loaded : SAVES_COPY.loadedOtherData(attempt.otherGameData);
    });

  const remove = (slot: string, label: string) =>
    run(async () => {
      await library.remove(slot);
      if (slot === currentSlot) setCurrentSlot(null);
      setFailed(null);
      await refresh();
      return SAVES_COPY.removed(label);
    });

  /** Opens the dialog on a fresh list: storage may have changed (another tab). */
  const openDialog = run(async () => {
    await refresh();
    setDialogOpen(true);
    return null;
  });

  const latest = continueTarget(saves);

  return (
    <div className="game-buttons" role="group" aria-label={SAVES_COPY.menuLabel}>
      <button
        type="button"
        className="button button-primary"
        data-testid="new-game"
        disabled={busy}
        onClick={run(async () => {
          await gateway.newGame();
          setCurrentSlot(null);
          return SAVES_COPY.newGameStarted;
        })}
      >
        {SAVES_COPY.newGame}
      </button>
      {defaultLabel !== null ? (
        <button type="button" className="button" data-testid="save" disabled={busy} onClick={() => void save(() => library.quickSave(currentSlot, defaultLabel))()}>
          {SAVES_COPY.save}
        </button>
      ) : (
        <button type="button" className="button" data-testid="reload" disabled={busy || latest === null} onClick={() => latest && void load(latest)()}>
          {SAVES_COPY.continue}
        </button>
      )}
      <button type="button" className="button" data-testid="open-saves" disabled={busy} onClick={openDialog}>
        {SAVES_COPY.openSaves}
      </button>
      <SavesDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        saves={saves}
        currentSlot={currentSlot}
        defaultLabel={defaultLabel}
        busy={busy}
        onSave={(label) => void save(() => library.saveNew(label))()}
        onLoad={(summary) => void load(summary)()}
        onRemove={(summary) => void remove(summary.slot, saveLabel(summary))()}
      />
      <LoadErrorScreen failed={failed} busy={busy} onBack={() => setFailed(null)} onRemove={(slot, label) => void remove(slot, label)()} />
    </div>
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
