// Pause / 1× / 2× / 4× (SIM-001). The speed lives in the worker's scheduler;
// these buttons only send speed changes and show what the worker reports.

import { SPEED_MULTIPLIERS } from "@eov/game-data";
import { useState } from "react";
import { useGateway, useGatewayView } from "../state/app-context.tsx";
import type { Speed } from "../workers/scheduler.ts";
import { SHELL_COPY, SPEED_COPY } from "./copy.ts";

export function SpeedControls({ disabled }: { readonly disabled: boolean }) {
  const gateway = useGateway();
  const { scheduler } = useGatewayView();
  const [error, setError] = useState<string | null>(null);

  const choose = (speed: Speed) => async () => {
    setError(null);
    try {
      await gateway.setSpeed(speed);
    } catch (e) {
      setError(SHELL_COPY.error(e instanceof Error ? e.message : String(e)));
    }
  };

  const options: readonly { readonly speed: Speed; readonly label: string; readonly testId: string }[] = [
    { speed: 0, label: SPEED_COPY.pause, testId: "speed-pause" },
    ...SPEED_MULTIPLIERS.map((m) => ({ speed: m, label: SPEED_COPY.speed(m), testId: `speed-${m}x` })),
  ];

  return (
    <div className="speed" role="group" aria-label={SPEED_COPY.groupLabel} data-testid="speed-controls">
      <div className="segmented">
        {options.map((o) => (
          <button
            key={o.speed}
            type="button"
            className="segmented-button"
            data-testid={o.testId}
            aria-pressed={scheduler.speed === o.speed}
            disabled={disabled}
            onClick={choose(o.speed)}
          >
            {o.label}
          </button>
        ))}
      </div>
      <span className="speed-status" data-testid="speed-status" data-speed={scheduler.speed}>
        {scheduler.speed === 0 ? SPEED_COPY.paused : SPEED_COPY.running(scheduler.speed)}
      </span>
      {scheduler.autoPaused && (
        <span role="status" className="banner banner-notice" data-testid="auto-paused">
          {SPEED_COPY.autoPaused}
        </span>
      )}
      {error && (
        <span role="alert" className="banner banner-fault">
          {error}
        </span>
      )}
    </div>
  );
}
