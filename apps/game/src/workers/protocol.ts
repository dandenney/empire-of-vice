// Messages between the UI thread and the simulation worker (architecture §2, §4).
//
// The worker owns the one authoritative simulation. The UI sends requests and
// receives read-only snapshots, events, and results. Everything here is plain
// data, so it survives postMessage's structured clone.
//
// These are transport types for the gateway, not domain types: commands,
// results, events, snapshots, and saves all come from @eov/contracts.

import type { CommandResult, GameEvent, GameSnapshot, SaveGame } from "@eov/contracts";

/** Correlates a response with its request. Assigned by the UI side, per page. */
export type RequestId = number;

export type WorkerRequest =
  | { readonly type: "NEW_GAME"; readonly requestId: RequestId }
  /** A SaveGame that persistence has already read and checked (schema, hash). */
  | { readonly type: "LOAD_GAME"; readonly requestId: RequestId; readonly save: SaveGame }
  /** `request` is untrusted: the worker validates it with `commandRequestSchema` before dispatch. */
  | { readonly type: "DISPATCH"; readonly requestId: RequestId; readonly request: unknown }
  /** S0 stub: replaced by T04a (the speed scheduler decides how many ticks to advance). */
  | { readonly type: "ADVANCE"; readonly requestId: RequestId; readonly ticks: number }
  | { readonly type: "SERIALIZE"; readonly requestId: RequestId };

export type WorkerResponse =
  | { readonly type: "READY"; readonly requestId: RequestId }
  | { readonly type: "COMMAND_RESULT"; readonly requestId: RequestId; readonly result: CommandResult }
  /**
   * The request failed `commandRequestSchema`, so it never reached `dispatch`.
   * There's no RejectionReason for a malformed request (a contract gap listed
   * in the S0b PR), so the gateway reports the schema issues instead.
   */
  | { readonly type: "INVALID_REQUEST"; readonly requestId: RequestId; readonly issues: readonly string[] }
  | { readonly type: "SAVE_GAME"; readonly requestId: RequestId; readonly save: SaveGame }
  | { readonly type: "ERROR"; readonly requestId: RequestId; readonly message: string };

/** Pushed by the worker, not tied to a request. */
export type WorkerPush =
  /**
   * The latest projection, after every unit of work (S0: every request).
   * `stateHash` is for the test hook's parity check (ADR 0008 hash), not for gameplay UI.
   */
  | { readonly type: "SNAPSHOT"; readonly snapshot: GameSnapshot; readonly stateHash: string }
  /**
   * Events emitted since the last push. `notify` events (EVENT_IMPORTANCE) are
   * posted on their own as soon as the unit of work ends, before the snapshot;
   * `log` events travel in one batch after it.
   */
  | { readonly type: "EVENTS"; readonly importance: "notify" | "log"; readonly events: readonly GameEvent[] };

export type WorkerMessage = WorkerResponse | WorkerPush;
