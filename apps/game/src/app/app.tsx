// PLACEHOLDER: visual direction pending #48. The shell's layout and styling
// are functional stand-ins; the look of the UI is the human's call.
//
// The shell: title bar with the game date, speed controls, and the S0 game
// buttons (New game, Save, Reload save; T06 replaces them with the save/load
// UI), panel navigation from the registry, the open panel, and the map slot.
// Everything game-related is rendered from the latest snapshot.

import { useState } from "react";
import { SHELL_COPY } from "../components/copy.ts";
import { describeLoadError, formatGameDate } from "../components/format.ts";
import { SpeedControls } from "../components/speed-controls.tsx";
import { DEFAULT_PANEL_ID, PANELS, panelById } from "../panels/registry.ts";
import { useGateway, useGatewayView, useUi } from "../state/app-context.tsx";
import { MapSlot } from "./map-slot.tsx";
import "./shell.css";

/** S0 stub: replaced by T06 (save slots and the save/load UI). */
const SAVE_SLOT = "sprint-zero";

function GameButtons({ busy, setBusy, say }: { readonly busy: boolean; readonly setBusy: (b: boolean) => void; readonly say: (m: string) => void }) {
  const gateway = useGateway();
  const { snapshot } = useGatewayView();
  const run = (action: () => Promise<string>) => async () => {
    setBusy(true);
    try {
      say(await action());
    } catch (error) {
      say(SHELL_COPY.error(error instanceof Error ? error.message : String(error)));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="game-buttons">
      <button
        type="button"
        data-testid="new-game"
        disabled={busy}
        onClick={run(async () => {
          await gateway.newGame();
          return SHELL_COPY.newGameStarted;
        })}
      >
        {SHELL_COPY.newGame}
      </button>
      <button
        type="button"
        data-testid="save"
        disabled={busy || !snapshot}
        onClick={run(async () => {
          await gateway.save(SAVE_SLOT, SHELL_COPY.saveLabel);
          return SHELL_COPY.saved;
        })}
      >
        {SHELL_COPY.save}
      </button>
      <button
        type="button"
        data-testid="reload"
        disabled={busy}
        onClick={run(async () => {
          const loaded = await gateway.load(SAVE_SLOT);
          return loaded.ok ? SHELL_COPY.saveReloaded : SHELL_COPY.reloadFailed(describeLoadError(loaded.error));
        })}
      >
        {SHELL_COPY.reloadSave}
      </button>
    </div>
  );
}

export function App({ showStateHash }: { readonly showStateHash: boolean }) {
  const { snapshot, stateHash, fault } = useGatewayView();
  const openPanelId = useUi((s) => s.openPanelId);
  const openPanel = useUi((s) => s.openPanel);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>(SHELL_COPY.noGame);
  const panel = panelById(openPanelId) ?? panelById(DEFAULT_PANEL_ID)!;
  const Panel = panel.component;

  return (
    <div className="shell" data-testid="shell">
      <header className="shell-header">
        <h1>{SHELL_COPY.title}</h1>
        <small>{SHELL_COPY.placeholderNotice}</small>
        {snapshot && <span data-testid="game-date">{formatGameDate(snapshot.clock.date)}</span>}
        <SpeedControls disabled={busy || !snapshot} />
        <GameButtons busy={busy} setBusy={setBusy} say={setMessage} />
      </header>
      <p role="status" data-testid="message">
        {message}
      </p>
      {fault && (
        <p role="alert" data-testid="fault">
          {SHELL_COPY.fault(fault)}
        </p>
      )}
      {showStateHash && stateHash && <code data-testid="state-hash">{stateHash}</code>}
      <nav aria-label={SHELL_COPY.panelNav} className="panel-nav">
        {PANELS.map((p) => (
          <button key={p.id} type="button" data-testid={`open-${p.id}`} aria-pressed={p.id === panel.id} onClick={() => openPanel(p.id)}>
            {p.title}
          </button>
        ))}
      </nav>
      <div className="shell-body">
        <main className="panel">{snapshot ? <Panel snapshot={snapshot} /> : <p>{SHELL_COPY.noGame}</p>}</main>
        <aside className="map-slot">{snapshot && <MapSlot snapshot={snapshot} />}</aside>
      </div>
    </div>
  );
}
