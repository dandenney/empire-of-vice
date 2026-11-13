// The shell, in the #48 visual direction: a top bar over the map (the digital
// game date, speed controls, and the game menu with the save/load UI), a
// vertical icon rail of the registry's panels, the map filling the rest of the
// screen, the open panel docked on the right under the game's masthead, and
// event toasts in a corner. Everything game-related is
// rendered from the latest snapshot.
//
// Under founder rules (the First Hire) the view holds only the player
// snapshot: no rail, no map, no M001 panels, and no toasts reach it (the
// worker forwards no world events). The dock shows the placeholder founder
// shell until SK2b (#234). The First Hire's placeholder new-game choice sits
// in the dock whenever no world snapshot is shown.

import { useState } from "react";
import { SHELL_COPY } from "../components/copy.ts";
import { formatGameDate } from "../components/format.ts";
import { SpeedControls } from "../components/speed-controls.tsx";
import { DEFAULT_PANEL_ID, PANELS, panelById } from "../panels/registry.ts";
import { useGatewayView, useUi } from "../state/app-context.tsx";
import { FontsReady } from "../ui/fonts-ready.tsx";
import { IconRail } from "../ui/icon-rail.tsx";
import { TokenStyle } from "../ui/token-style.tsx";
import { ToastHost } from "../ui/toasts/toast-host.tsx";
import "../ui/fonts.ts";
import "../ui/components.css";
import { EndScreen } from "./end-screen/end-screen.tsx";
import { FounderShell } from "./founder/founder-shell.tsx";
import { NewGameChoice } from "./founder/new-game-choice.tsx";
import "./founder/founder-shell.css";
import { MapSlot } from "./map-slot.tsx";
import { GameMenu } from "./saves/game-menu.tsx";
import type { SaveLibrary } from "./saves/save-library.ts";
import "./shell.css";

export function App({ showStateHash, saves }: { readonly showStateHash: boolean; readonly saves: SaveLibrary }) {
  const { snapshot, playerSnapshot, stateHash, fault, scheduler } = useGatewayView();
  const clock = snapshot?.clock ?? playerSnapshot?.clock ?? null;
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
          {clock && (
            <span className="clock-readout" data-testid="game-date">
              {formatGameDate(clock.date)}
            </span>
          )}
        </div>
        <SpeedControls disabled={busy || !clock} />
        <GameMenu library={saves} busy={busy} setBusy={setBusy} say={setMessage} />
      </header>
      {fault && (
        <p role="alert" className="banner banner-fault" data-testid="fault">
          {SHELL_COPY.fault(fault)}
        </p>
      )}
      {!playerSnapshot && <IconRail items={PANELS} openId={panel.id} onOpen={openPanel} label={SHELL_COPY.panelNav} />}
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
        <main>
          {snapshot && <Panel snapshot={snapshot} />}
          {playerSnapshot && <FounderShell player={playerSnapshot} scheduler={scheduler} />}
          {/* No world snapshot: no game yet, or a First Hire game. M001's dock is unchanged. */}
          {!snapshot && <NewGameChoice busy={busy} setBusy={setBusy} say={setMessage} />}
        </main>
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
