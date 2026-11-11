// The end screen (#136, ADR 0020 decision 16): a modal over the shell when
// the game is won or lost, in the #99 wording. It shows when
// `snapshot.outcome` leaves PLAYING, and again whenever a VICTORY_ACHIEVED or
// GAME_LOST event arrives; never on the scheduler's status.
//
// "Review the operation" closes it so the player can look over the panels
// (the outcome is sticky and the game still runs, ADR 0020 decision 8). On a
// loss, "Start again" starts a new game through the same action as the game
// menu's New game, which also clears the current save slot. It holds only
// which outcome was dismissed: UI state, not game state (CLAUDE.md rule 7).

import { useEffect, useRef, useState } from "react";
import { formatDayTime } from "../../ui/format/time-format.ts";
import { useGateway, useGatewayView, useStartNewGame } from "../../state/app-context.tsx";
import { MoneyFigure } from "../../ui/ledger.tsx";
import { END_SCREEN_COPY as C } from "./copy.ts";
import { endScreenFor, type EndScreenView } from "./end-screen-view.ts";
import "./end-screen.css";

function Facts({ view }: { readonly view: EndScreenView }) {
  return (
    <dl className="end-facts" data-testid="end-facts">
      <div>
        <dt>{C.when}</dt>
        <dd data-testid="end-when">{formatDayTime(view.tick)}</dd>
      </div>
      {view.kind === "victory" ? (
        <>
          <div>
            <dt>{C.netWorth}</dt>
            <dd data-testid="end-net-worth">
              <MoneyFigure amount={view.netWorth} />
            </dd>
          </div>
          <div>
            <dt>{C.reputation}</dt>
            <dd data-testid="end-reputation">{view.reputation}</dd>
          </div>
          <div>
            <dt>{C.completedContracts}</dt>
            <dd data-testid="end-completed-contracts">{view.completedContracts}</dd>
          </div>
        </>
      ) : (
        <div>
          <dt>{C.cash}</dt>
          <dd data-testid="end-cash">
            <MoneyFigure amount={view.cash} />
          </dd>
        </div>
      )}
    </dl>
  );
}

export function EndScreen() {
  const gateway = useGateway();
  const startNewGame = useStartNewGame();
  const { snapshot } = useGatewayView();
  const view = endScreenFor(snapshot);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const open = view !== null && dismissed !== view.key;

  // The outcome events bring the screen back, even over an earlier dismissal.
  useEffect(
    () =>
      gateway.onEvents((events) => {
        if (events.some((e) => e.type === "VICTORY_ACHIEVED" || e.type === "GAME_LOST")) setDismissed(null);
      }),
    [gateway],
  );

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  if (!view) return null;
  const text = view.kind === "victory" ? C.victory : C.loss;
  const dismiss = () => setDismissed(view.key);
  const startAgain = async () => {
    setStarting(true);
    setError(null);
    try {
      await startNewGame();
    } catch (e) {
      setError(C.error(e instanceof Error ? e.message : String(e)));
    } finally {
      setStarting(false);
    }
  };

  return (
    <dialog
      ref={dialog}
      className="end-screen"
      data-outcome={view.kind}
      aria-labelledby="end-title"
      aria-describedby="end-lead"
      data-testid={`end-screen-${view.kind}`}
      onCancel={(e) => {
        // Escape: the same as reviewing the operation.
        e.preventDefault();
        dismiss();
      }}
    >
      <p className="end-eyebrow">{view.kind === "victory" ? C.victoryEyebrow : C.lossEyebrow}</p>
      <h2 className="end-title" id="end-title" data-testid="end-title">
        {text.title}
      </h2>
      <p className="end-lead" id="end-lead" data-testid="end-lead">
        {text.lead}
      </p>
      <p className="end-support" data-testid="end-support">
        {text.support}
      </p>
      <Facts view={view} />
      <div className="end-actions">
        {view.kind === "loss" && (
          <button type="button" className="button button-primary" onClick={() => void startAgain()} disabled={starting} data-testid="end-start-again">
            {starting ? C.starting : C.startAgain}
          </button>
        )}
        <button type="button" className={view.kind === "victory" ? "button button-primary" : "button"} onClick={dismiss} autoFocus={view.kind === "victory"} data-testid="end-review">
          {C.review}
        </button>
      </div>
      {error && (
        <p role="alert" className="end-error" data-testid="end-error">
          {error}
        </p>
      )}
    </dialog>
  );
}
