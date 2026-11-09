// The saves dialog: save the running game to a new named slot, and load or
// delete any save. Saves that won't load are listed with the reason.

import type { SaveSummary } from "@eov/persistence";
import { useState } from "react";
import { SAVES_COPY } from "./copy.ts";
import { Modal } from "./modal.tsx";
import { describeLoadError, formatSavedAt, saveLabel } from "./saves-view.ts";

export function SavesDialog({
  open,
  onClose,
  saves,
  currentSlot,
  defaultLabel,
  busy,
  onSave,
  onLoad,
  onRemove,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly saves: readonly SaveSummary[];
  readonly currentSlot: string | null;
  /** The new save's suggested name, or null when no game is running (nothing to save). */
  readonly defaultLabel: string | null;
  readonly busy: boolean;
  readonly onSave: (label: string) => void;
  readonly onLoad: (summary: SaveSummary) => void;
  readonly onRemove: (summary: SaveSummary) => void;
}) {
  return (
    <Modal open={open} onClose={onClose} labelledBy="saves-title" testId="saves-dialog" className="saves">
      <header className="modal-header">
        <h2 id="saves-title" className="modal-title">
          {SAVES_COPY.dialogTitle}
        </h2>
        <button type="button" className="button" data-testid="saves-close" onClick={onClose}>
          {SAVES_COPY.close}
        </button>
      </header>
      <NewSave defaultLabel={defaultLabel} busy={busy} onSave={onSave} />
      <h3 className="group-title">{SAVES_COPY.listTitle}</h3>
      {saves.length === 0 ? (
        <p className="panel-empty" data-testid="saves-empty">
          {SAVES_COPY.empty}
        </p>
      ) : (
        <ul className="save-list" data-testid="save-list">
          {saves.map((s) => (
            <SaveRow key={s.slot} summary={s} current={s.slot === currentSlot} busy={busy} onLoad={onLoad} onRemove={onRemove} />
          ))}
        </ul>
      )}
    </Modal>
  );
}

function NewSave({ defaultLabel, busy, onSave }: { readonly defaultLabel: string | null; readonly busy: boolean; readonly onSave: (label: string) => void }) {
  // Suggested when the dialog opens (it mounts then), and kept while the player types.
  const [label, setLabel] = useState(defaultLabel ?? "");
  if (defaultLabel === null) return <p className="panel-empty">{SAVES_COPY.noGameToSave}</p>;
  return (
    <form
      className="save-new"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(label.trim() || defaultLabel);
      }}
    >
      <label className="field">
        <span className="field-label">{SAVES_COPY.saveAsNew}</span>
        <input className="input" data-testid="save-new-label" value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)} />
      </label>
      <button type="submit" className="button button-primary" data-testid="save-new" disabled={busy}>
        {SAVES_COPY.saveNew}
      </button>
    </form>
  );
}

function SaveRow({
  summary,
  current,
  busy,
  onLoad,
  onRemove,
}: {
  readonly summary: SaveSummary;
  readonly current: boolean;
  readonly busy: boolean;
  readonly onLoad: (summary: SaveSummary) => void;
  readonly onRemove: (summary: SaveSummary) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const when = formatSavedAt(summary.meta.savedAt);
  return (
    <li className="save-row" data-testid={`save-${summary.slot}`} data-ok={summary.ok}>
      <div className="save-info">
        <span className="save-name">{saveLabel(summary)}</span>
        <span className="save-meta">
          {when && <span>{SAVES_COPY.savedAt(when)}</span>}
          {current && <span className="tag">{SAVES_COPY.current}</span>}
          {summary.ok && summary.gameDataChanged && (
            <span className="tag" title={SAVES_COPY.otherGameDataNote(summary.gameDataVersion)}>
              {SAVES_COPY.otherGameData}
            </span>
          )}
          {!summary.ok && <span className="tag tag-bad">{SAVES_COPY.wontLoad}</span>}
        </span>
        {!summary.ok && (
          <span className="save-problem" data-testid={`save-${summary.slot}-problem`}>
            {describeLoadError(summary.error)}
          </span>
        )}
      </div>
      <div className="save-actions">
        {confirming ? (
          <>
            <button type="button" className="button" data-testid={`save-${summary.slot}-keep`} onClick={() => setConfirming(false)}>
              {SAVES_COPY.cancel}
            </button>
            <button
              type="button"
              className="button button-danger"
              data-testid={`save-${summary.slot}-confirm-remove`}
              disabled={busy}
              onClick={() => onRemove(summary)}
            >
              {SAVES_COPY.confirmRemove}
            </button>
          </>
        ) : (
          <>
            <button type="button" className="button" data-testid={`save-${summary.slot}-remove`} disabled={busy} onClick={() => setConfirming(true)}>
              {SAVES_COPY.remove}
            </button>
            <button type="button" className="button button-primary" data-testid={`save-${summary.slot}-load`} disabled={busy} onClick={() => onLoad(summary)}>
              {SAVES_COPY.load}
            </button>
          </>
        )}
      </div>
    </li>
  );
}
