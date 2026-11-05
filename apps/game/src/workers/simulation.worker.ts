// The simulation worker (architecture §2, §4): runs the one authoritative
// simulation, and the speed scheduler that drives it (ADR 0014), off the UI
// thread. The logic lives in simulation-host.ts; this file only wires it to the
// worker global, its clock, and its timers.

import type { WorkerMessage, WorkerRequest } from "./protocol.ts";
import { SimulationHost } from "./simulation-host.ts";

// The app's tsconfig uses the DOM lib, not WebWorker, so type the worker scope by hand.
const scope = self as unknown as {
  postMessage(message: WorkerMessage): void;
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
};

const host = new SimulationHost({
  post: (message) => scope.postMessage(message),
  now: () => performance.now(),
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
});

scope.onmessage = (event) => host.receive(event.data);
