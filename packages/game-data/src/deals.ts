// Held deals (ADR 0022 decision 6). PLACEHOLDER tuning for the playtests (PT1, #175).

import { TICKS_PER_DAY } from "@eov/contracts";

/**
 * How long a buyer holds an agreed deal before it expires undispatched:
 * `expiresAt = agreedAt + DEAL_HOLD_TICKS`. A dispatch's deal deadline is
 * `min(expiresAt, arrival + dealGraceTicks)`. Two game days is longer than any
 * M001 round trip, so a sale dispatched when it's agreed (the lab, the M001 sale
 * form) keeps M001's deadline. PLACEHOLDER.
 */
export const DEAL_HOLD_TICKS = 2 * TICKS_PER_DAY; // PLACEHOLDER: 2 880 ticks
