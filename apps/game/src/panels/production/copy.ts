// PLACEHOLDER copy (story decision): Production panel strings (#48).

export const PRODUCTION_COPY = {
  title: "Production",
  noFacilities: "No facilities.",
  capacity: (casesPerDay: number) => `Capacity: ${casesPerDay} cases per day`,
  storage: (used: number, capacity: number) => `Storage: ${used} of ${capacity}`,
  workforce: (workers: number, maximum: number) => `Workers: ${workers} of ${maximum}`,
  /** "Capacity … · Storage … · Workers …". Separate parts, so each renders as its own text node, as before #58. */
  facilitySummary: (capacity: string, storage: string, workforce: string): readonly string[] => [capacity, " · ", storage, " ·", " ", workforce],
  materials: "Materials",
  noMaterials: "No materials in stock.",
  materialLine: (name: string, quantity: number, reserved: number) => `${name}: ${quantity} (${reserved} reserved)`,
  products: "Finished goods",
  noProducts: "No finished goods.",
  productLine: (name: string, quality: string, quantity: number, reserved: number) => `${name} (${quality}): ${quantity} cases (${reserved} reserved)`,
  recipes: "Recipes",
  recipe: "Recipe",
  quality: "Quality",
  inputsPerCase: "Inputs per case",
  inputLine: (name: string, quantity: number) => `${quantity} × ${name}`,
  canStart: "Can start now",
  blockedBy: "Blocked by",
  notBlocked: "Nothing",
  quantity: "Cases",
  quantityLabel: (recipe: string) => `Cases of ${recipe} to start`,
  start: "Start production",
  jobs: "Running jobs",
  noJobs: "Nothing in production.",
  jobLine: (quantity: number, recipe: string, quality: string) => `${quantity} × ${recipe} (${quality})`,
  jobTiming: (startedAt: number, completesAt: number) => `started tick ${startedAt}, completes tick ${completesAt}`,
  /** Separate parts, so each renders as its own text node, as before #58. */
  jobSummary: (line: string, timing: string): readonly string[] => [line, ", ", timing],
  jobProgressLabel: (recipe: string) => `Progress of ${recipe}`,

  // Repeat the last run (REPEAT_OPERATION, ADR 0020 decision 11)
  repeatTitle: "Repeat the last run",
  repeatLine: (quantity: number, recipe: string, facility: string) => `${quantity} × ${recipe} at ${facility}`,
  repeatNote: "Checked again against today's stock, capacity, and cash.",
  repeat: "Repeat",
  repeatLabel: (line: string) => `Repeat: ${line}`,
} as const;
