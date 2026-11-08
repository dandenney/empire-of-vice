// The shell, in the #48 visual direction: a top bar over the map (the digital
// game date, speed controls, and the S0 game buttons, which T06 replaces with
// the save/load UI), a vertical icon rail of the registry's panels, the map
// filling the rest of the screen, the open panel docked on the right under the
// game's masthead, and event toasts in a corner. Everything game-related is
// rendered from the latest snapshot.

import { useState } from "react";
import { SHELL_COPY } from "../components/copy.ts";
import { describeLoadError, formatGameDate } from "../components/format.ts";
import { SpeedControls } from "../components/speed-controls.tsx";
import { DEFAULT_PANEL_ID, PANELS, panelById } from "../panels/registry.ts";
import { useGateway, useGatewayView, useUi } from "../state/app-context.tsx";
import { FontsReady } from "../ui/fonts-ready.tsx";
import { IconRail } from "../ui/icon-rail.tsx";
import { TokenStyle } from "../ui/token-style.tsx";
import { ToastHost } from "../ui/toasts/toast-host.tsx";
import "../ui/fonts.ts";
import "../ui/components.css";
import { EndScreen } from "./end-screen/end-screen.tsx";
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
        className="button button-primary"
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
        className="button"
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
        className="button"
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
      <TokenStyle />
      <header className="topbar">
        <div className="clock">
          {snapshot && (
            <span className="clock-readout" data-testid="game-date">
              {formatGameDate(snapshot.clock.date)}
            </span>
          )}
        </div>
        <SpeedControls disabled={busy || !snapshot} />
        <GameButtons busy={busy} setBusy={setBusy} say={setMessage} />
      </header>
      {fault && (
        <p role="alert" className="banner banner-fault" data-testid="fault">
          {SHELL_COPY.fault(fault)}
        </p>
      )}
      <IconRail items={PANELS} openId={panel.id} onOpen={openPanel} label={SHELL_COPY.panelNav} />
      <div className="map-region">
        {snapshot && (
          <FontsReady>
            <MapSlot snapshot={snapshot} />
          </FontsReady>
        )}
      </div>
      <div className="dock">
        <header className="masthead">
          <h1 className="masthead-title">{SHELL_COPY.title}</h1>
          <p role="status" className="masthead-message" data-testid="message">
            {message}
          </p>
        </header>
        {/* With no game, the masthead's status line says so. */}
        <main>{snapshot && <Panel snapshot={snapshot} />}</main>
        {showStateHash && stateHash && (
          <footer className="dock-footer">
            <code className="state-hash" data-testid="state-hash">
              {stateHash}
            </code>
          </footer>
        )}
      </div>
      <ToastHost />
      <EndScreen />
    </div>
  );
}
