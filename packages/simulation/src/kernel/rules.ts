// The scenario's rule switches a system reads when it registers (ADR 0023
// decision 9). They're fixed for the life of a simulation: changing the rules
// mid-run would change what a command means, so they live in the registry's
// composition, not in GameState.

export interface GameRules {
  /**
   * The founder's presence rules (ADR 0023): travel, rest, busy, hours, the
   * founder phase and the founder as driver. Off for the M001 scenario and the
   * lab, where the founder state never changes.
   */
  readonly founderRules: boolean;
}

/** M001's rules: the default for every caller that doesn't pass a scenario's. */
export const M001_RULES: GameRules = { founderRules: false };
