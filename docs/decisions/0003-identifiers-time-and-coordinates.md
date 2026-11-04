# 0003: Identifiers, time, and coordinates

Status: proposed (T00b, issue #2)

## Context

Architecture §8 asks T00b to settle command identity, map coordinates, and the clock representation. Every package passes these values around, and a mix-up (a buyer ID where a facility ID belongs, a quantity where a tick belongs) is easy to make and hard to spot in review.

## Decision

### Identifiers (`ids.ts`)

- **Each entity kind gets its own branded string type** (`FacilityId`, `BuyerId`, …, all `Id<K>`). They're plain strings at runtime, so saves and snapshots stay plain JSON.
- **Format:** lowercase letters and digits joined by single hyphens, at most 64 characters (`distillery-main`, `job-17`). `asId(kind, value)` validates and brands. Keeping IDs this strict means they're safe in URLs, test selectors, and log lines without escaping.
- **Static IDs** (locations, buyers, recipes, equipment, …) are written by hand in game-data and scenario files.
- **Dynamic IDs** (commands, events, transactions, jobs, deliveries, contracts, reservations) are **assigned by the simulation from per-kind counters stored in state**: `<prefix>-<n>`. They never come from wall-clock time or randomness, so a replay produces the same IDs. The counters are saved with the state.

### Time (`time.ts`)

- `Tick` is a **branded non-negative integer**. One tick is one game minute. Tick 0 is 00:00 on the scenario's start date.
- **`state.tick` is the number of ticks completed.** `advance(1)` processes tick `state.tick + 1`. A tick where `tick % 1440 === 0` is midnight, when settlement runs (SIM-001 tick order, step 5).
- `TICKS_PER_DAY` (1,440) and `TICKS_PER_HOUR` (60) live in contracts because they define the clock (SIM-001), not tuning. Speeds, durations, and intervals are tuning, and they live in game-data.
- Converting a tick to a calendar date (Gregorian, with leap years) needs the scenario start date, so the simulation does it (T01). Snapshots carry the computed date for the UI.

### Coordinates (`geometry.ts`)

- `WorldPoint` is an **integer `{x, y}` on a flat logical grid** (x east, y south), in world units. Game-data places locations and route waypoints with it.
- Isometric projection, tile size, and zoom belong to the map (T04b). Changing the art style never touches simulation data.
- **Vehicles in transit have no stored position.** The simulation tracks route progress in ticks, and the map interpolates along the route's waypoints. The simulation never needs fractional coordinates, so it stays in integer math.

### Goods (`goods.ts`)

- A finished good is **product + quality tier** (GDD §6). `QualityTier` is the fixed set `basic | standard | premium`, ranked for "minimum quality" checks. Product definitions and prices live in game-data.

## Consequences

- The compiler catches mixed-up IDs and tick/quantity confusion. Tests in `primitives.test.ts` cover the runtime checks.
- Quantities (cases, workers) stay plain `number`s, validated as positive safe integers at the gateway (the Zod schemas, later in T00b). Branding them too would add friction for little gain.
- An ID format change after saves exist needs a save migration (ADR on save policy).
