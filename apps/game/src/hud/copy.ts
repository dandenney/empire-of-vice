// PLACEHOLDER copy (story decision): the founder's HUD (SK2b, #234). The
// wording is the human's call. Place and road names come from the snapshot.

import type { ActivityKind } from "@eov/contracts";

export const HUD_COPY = {
  label: "Founder status",
  placeholder: "Placeholder layout",
  time: "Time",
  status: "You",
  cash: "Cash",
  fastForward: "Fast-forwarding while you sleep",
  wake: "Wake up",
  tired: "Tired: everything takes longer",
  /** Where the founder is and what they're doing; `place` is the location's name. */
  whereabouts: {
    PRESENT: (place: string) => `At ${place}`,
    BUSY: (place: string) => `Busy at ${place}`,
    TRAVELLING: (place: string) => `Travelling to ${place}`,
    ON_DELIVERY: () => "Riding with the truck",
    RESTING: (place: string) => `Asleep at ${place}`,
  },
  detail: {
    free: "Free to act",
    busy: (activity: string, until: string) => `${activity} until ${until}`,
    travelling: (foot: boolean, road: string, leg: number, legs: number, arrives: string) =>
      `${foot ? "On foot" : "Driving"} on ${road}${legs > 1 ? ` (leg ${leg} of ${legs})` : ""}, there ${arrives}`,
    riding: "On the road",
    atStop: (place: string) => `Stopped at ${place}`,
    resting: (until: string) => `Wakes ${until}`,
  },
  progress: (percent: number) => `${percent}% of the way`,
  activity: {
    BUY_MATERIALS: "Buying",
    START_BATCH: "Setting up the still",
    LOAD_TRUCK: "Loading the truck",
    AGREE_DEAL: "Settling a deal",
    ACCEPT_CONTRACT: "Signing a contract",
    BUY_EQUIPMENT: "Buying equipment",
    SELL_EQUIPMENT: "Selling equipment",
    SET_WORKFORCE: "Seeing to the men",
    PHONE_CALL: "On the phone",
    PHONE_NO_ANSWER: "Ringing",
    INSTALL_PHONE: "Having a phone put in",
    CHECK_IN: "Checking in",
    HIRE: "Hiring",
    BRIEF_EMPLOYEE: "Briefing a hand",
  } satisfies Readonly<Record<ActivityKind, string>>,
  unknownPlace: "somewhere",
} as const;
