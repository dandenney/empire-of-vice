// Lint fixture: allowed simulation code. Must produce no boundary errors.
import type { Thing } from "@eov/contracts";

export type Alias = Thing;

export const floor = Math.floor(7 / 2);
export const max = Math.max(1, 2);
export const abs = Math.abs(-3);
export const sqrt = Math.sqrt(16); // IEEE 754 requires correct rounding, so sqrt is allowed.
export const product = 3 * 4;
export const fixedDate = new Date(0);
export const timestamp = Date.UTC(1920, 0, 17);
