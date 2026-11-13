// The founder's HUD (SK2b, #234): the date and time, where the founder is and
// what they're doing (present, busy until, travelling, riding, resting), the
// purse, and the rest fast-forward (ADR 0023 decision 9). From the player
// snapshot and the scheduler status only. PLACEHOLDER layout.

import { formatMoney, type PlayerSnapshot } from "@eov/contracts";
import { formatGameDate } from "../components/format.ts";
import { useCommand } from "../components/use-command.ts";
import { formatDayTime } from "../ui/format/time-format.ts";
import type { SchedulerStatus } from "../workers/scheduler.ts";
import { HUD_COPY as C } from "./copy.ts";
import { founderStatus } from "./hud-view.ts";
import "./hud.css";

export function Hud({ player, scheduler, title }: { readonly player: PlayerSnapshot; readonly scheduler: SchedulerStatus; readonly title: string }) {
  const status = founderStatus(player);
  const wake = useCommand("hud:wake");
  return (
    <section className="hud" data-testid="hud" aria-label={C.label}>
      <h2 className="hud-title">
        {title} <span className="placeholder-tag">{C.placeholder}</span>
      </h2>
      <dl className="hud-facts">
        <div className="hud-fact">
          <dt>{C.time}</dt>
          <dd data-testid="founder-time">
            {formatGameDate(player.clock.date)} <span className="hud-day">{formatDayTime(player.clock.tick)}</span>
          </dd>
        </div>
        <div className="hud-fact hud-fact-status">
          <dt>{C.status}</dt>
          <dd>
            <span data-testid="founder-status" data-kind={player.founder.whereabouts.kind} data-status={status.kind}>
              {status.headline}
            </span>
            <span className="hud-detail" data-testid="founder-detail">
              {status.detail}
            </span>
            {status.progressPercent !== null && (
              <span className="hud-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={status.progressPercent} aria-valuetext={C.progress(status.progressPercent)} data-testid="founder-progress">
                <span className="hud-progress-bar" style={{ width: `${status.progressPercent}%` }} />
              </span>
            )}
            {status.tired && <span className="hud-tired">{C.tired}</span>}
          </dd>
        </div>
        <div className="hud-fact">
          <dt>{C.cash}</dt>
          <dd data-testid="founder-cash" className="hud-cash">
            {formatMoney(player.finance.cash)}
          </dd>
        </div>
      </dl>
      {player.founder.whereabouts.kind === "RESTING" && (
        <button type="button" className="button" data-testid="wake" disabled={wake.pending} onClick={() => void wake.send({ command: { type: "WAKE" } })}>
          {C.wake}
        </button>
      )}
      {scheduler.fastForward && (
        <p role="status" className="hud-fast-forward" data-testid="fast-forward">
          {C.fastForward}
        </p>
      )}
    </section>
  );
}
