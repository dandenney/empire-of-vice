// The load-error screen: a save was refused (a typed SaveLoadError) or the
// worker couldn't resume it. Nothing was loaded, so the game in progress, if
// any, carries on; the player can go back or delete the save.

import { SAVES_COPY } from "./copy.ts";
import { Modal } from "./modal.tsx";
import type { LoadFailure } from "./save-library.ts";
import { describeLoadFailure } from "./saves-view.ts";

export interface FailedLoad {
  readonly slot: string;
  readonly label: string;
  readonly failure: LoadFailure;
}

export function LoadErrorScreen({
  failed,
  busy,
  onBack,
  onRemove,
}: {
  readonly failed: FailedLoad | null;
  readonly busy: boolean;
  readonly onBack: () => void;
  readonly onRemove: (slot: string, label: string) => void;
}) {
  const described = failed ? describeLoadFailure(failed.failure) : null;
  return (
    <Modal open={failed !== null} onClose={onBack} labelledBy="load-error-title" testId="load-error" className="load-error">
      {failed && described && (
        <>
          <h2 id="load-error-title" className="modal-title">
            {SAVES_COPY.errorTitle}
          </h2>
          <p className="load-error-save">{SAVES_COPY.errorSave(failed.label)}</p>
          <p className="load-error-reason" data-testid="load-error-reason">
            {described.reason}
          </p>
          <p className="load-error-note">{SAVES_COPY.errorUnchanged}</p>
          {described.details.length > 0 && (
            <details className="load-error-details">
              <summary>{SAVES_COPY.errorDetails}</summary>
              <ul data-testid="load-error-details">
                {described.details.map((d, i) => (
                  <li key={i}>
                    <code>{d}</code>
                  </li>
                ))}
              </ul>
            </details>
          )}
          <div className="modal-actions">
            <button type="button" className="button" data-testid="load-error-remove" disabled={busy} onClick={() => onRemove(failed.slot, failed.label)}>
              {SAVES_COPY.errorRemove}
            </button>
            <button type="button" className="button button-primary" data-testid="load-error-back" onClick={onBack}>
              {SAVES_COPY.errorBack}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
