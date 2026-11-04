// Logical world coordinates. See docs/decisions/0003-identifiers-time-and-coordinates.md.
//
// The simulation and game-data place things on a flat logical grid measured in
// whole world units. x grows east, y grows south. These are NOT screen or
// isometric coordinates: projecting them for display is the map's job (T04b),
// so changing the art style never touches simulation data.
//
// Vehicles in transit have no stored position. Their position comes from route
// progress (ticks elapsed / route duration), which the map interpolates along
// the route's waypoints. The simulation never needs fractional coordinates.

export interface WorldPoint {
  readonly x: number;
  readonly y: number;
}

export function isWorldPoint(value: unknown): value is WorldPoint {
  if (typeof value !== "object" || value === null) return false;
  const { x, y } = value as Record<string, unknown>;
  return Number.isSafeInteger(x) && Number.isSafeInteger(y);
}
