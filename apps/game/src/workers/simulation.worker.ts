// The simulation gateway (architecture §2, §4): runs the one authoritative
// simulation off the UI thread.
//
// - Every command request is validated with `commandRequestSchema` before it
//   reaches `dispatch`. A malformed request never touches the simulation.
// - After every unit of work the worker posts its events (notify-level ones on
//   their own first, per EVENT_IMPORTANCE) and a fresh snapshot.
// - The UI never sees GameState, only snapshots. The one exception is
//   SERIALIZE, whose SaveGame goes straight to persistence.

import { commandRequestSchema, EVENT_IMPORTANCE, formatIssues, type GameEvent, type Simulation } from "@eov/contracts";
import { loadGame, newGame } from "@eov/simulation";
import type { WorkerMessage, WorkerRequest, WorkerResponse } from "./protocol.ts";

// The app's tsconfig uses the DOM lib, not WebWorker, so type the worker scope by hand.
const scope = self as unknown as {
  postMessage(message: WorkerMessage): void;
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
};

let sim: Simulation | null = null;

function post(message: WorkerMessage): void {
  scope.postMessage(message);
}

/** Events first (notify immediately, then the log batch), then the snapshot. */
function publish(game: Simulation): void {
  const events = game.takeEvents();
  const notify: GameEvent[] = events.filter((e) => EVENT_IMPORTANCE[e.type] === "notify");
  const log: GameEvent[] = events.filter((e) => EVENT_IMPORTANCE[e.type] === "log");
  if (notify.length > 0) post({ type: "EVENTS", importance: "notify", events: notify });
  post({ type: "SNAPSHOT", snapshot: game.snapshot(), stateHash: game.stateHash() });
  if (log.length > 0) post({ type: "EVENTS", importance: "log", events: log });
}

function running(): Simulation {
  if (!sim) throw new Error("No game is running: start a new game or load a save first");
  return sim;
}

function handle(request: WorkerRequest): WorkerResponse {
  const { requestId } = request;
  switch (request.type) {
    case "NEW_GAME": {
      sim = newGame();
      // The opening balance is booked while building the state, before the
      // simulation exists, so a new game starts with no pending events.
      publish(sim);
      return { type: "READY", requestId };
    }
    case "LOAD_GAME": {
      sim = loadGame(request.save);
      publish(sim);
      return { type: "READY", requestId };
    }
    case "DISPATCH": {
      const game = running();
      const parsed = commandRequestSchema.safeParse(request.request);
      if (!parsed.success) return { type: "INVALID_REQUEST", requestId, issues: formatIssues(parsed.error) };
      const result = game.dispatch(parsed.data);
      publish(game);
      return { type: "COMMAND_RESULT", requestId, result };
    }
    case "ADVANCE": {
      const game = running();
      // advance() throws RangeError on anything but a non-negative whole number; reported as ERROR.
      game.advance(request.ticks);
      publish(game);
      return { type: "READY", requestId };
    }
    case "SERIALIZE":
      return { type: "SAVE_GAME", requestId, save: running().serialize() };
  }
}

scope.onmessage = (event) => {
  const request = event.data;
  let response: WorkerResponse;
  try {
    response = handle(request);
  } catch (error) {
    response = { type: "ERROR", requestId: request.requestId, message: error instanceof Error ? error.message : String(error) };
  }
  post(response);
};
