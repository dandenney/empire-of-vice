// PLACEHOLDER copy (story decision): the worker and gateway error messages
// that reach the player through SHELL_COPY.error (#48, #58). Plain data only:
// the worker imports this, so nothing here touches the DOM.

export const WORKER_COPY = {
  notASpeed: (speed: string) => `Not a speed: ${speed}`,
  tabHidden: "The tab is hidden: the game stays paused until it's visible",
  noGame: "No game is running: start a new game or load a save first",
  unexpectedResponse: (type: string) => `Unexpected worker response ${type}`,
  unknownScenario: (id: string) => `This version doesn't play the scenario ${id}`,
} as const;
