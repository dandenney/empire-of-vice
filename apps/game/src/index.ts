// @eov/game: browser entry point.
//
// Sprint Zero (S0b): starts the simulation worker, the gateway client, the
// placeholder UI, and (in test builds) the `window.__eov` test hook.

import { mountSprintZeroUi } from "./app/sprint-zero-ui.ts";
import { installTestHook } from "./app/test-hook.ts";
import { LocalStorageAdapter } from "./state/browser-storage.ts";
import { GatewayClient } from "./state/gateway-client.ts";

/** Test builds: anything but a production build (`vite` dev, or `vite build --mode test`). */
const TEST_BUILD = import.meta.env.MODE !== "production";

const worker = new Worker(new URL("./workers/simulation.worker.ts", import.meta.url), { type: "module" });
const gateway = new GatewayClient(worker, new LocalStorageAdapter());
const root = document.getElementById("root");
if (!root) throw new Error("index.html has no #root element");
const ui = mountSprintZeroUi(root, gateway, { showStateHash: TEST_BUILD });
if (TEST_BUILD) installTestHook(gateway, ui);
