// TripContext: the single shared JSON object the Orchestrator owns and every
// sub-agent reads/writes. Matches the schema in the prompt pack.

export function createTripContext(overrides = {}) {
  const base = {
    destination: "",
    origin: "",
    start_date: "",
    end_date: "",
    traveler_count: 1,
    budget_total: null,
    budget_currency: "USD",
    preferences: {
      cuisine: [],
      dietary_restrictions: [],
      interests: [],
      pace: "moderate", // "relaxed" | "moderate" | "packed"
    },
    constraints: [],
    sub_agent_outputs: {
      flights: null,
      hotels: null,
      attractions: null,
      itinerary: null,
      food: null,
      budget: null,
    },
  };
  return deepMerge(base, overrides);
}

// Number of nights between start_date and end_date (0 if unknown/invalid).
export function tripNights(ctx) {
  const s = Date.parse(ctx.start_date);
  const e = Date.parse(ctx.end_date);
  if (Number.isNaN(s) || Number.isNaN(e) || e <= s) return 0;
  return Math.round((e - s) / (1000 * 60 * 60 * 24));
}

// Number of days on the ground (nights + 1). Used to size attractions/itinerary.
export function tripDays(ctx) {
  const nights = tripNights(ctx);
  return nights > 0 ? nights + 1 : 1;
}

// A minimal slice of context to hand a sub-agent. Keeps prompts small and makes
// it obvious in the logs what each agent was allowed to see.
export function contextSlice(ctx, keys) {
  const out = {};
  for (const k of keys) {
    if (k in ctx) out[k] = ctx[k];
  }
  return out;
}

export function deepMerge(target, source) {
  const out = Array.isArray(target) ? [...target] : { ...target };
  for (const [k, v] of Object.entries(source || {})) {
    if (v && typeof v === "object" && !Array.isArray(v) && typeof out[k] === "object" && out[k] !== null) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// Lightweight validation so we fail loudly on missing essentials before spending
// API calls. Returns an array of human-readable problems (empty === valid).
export function validateForPlanning(ctx) {
  const problems = [];
  if (!ctx.destination) problems.push("destination is required");
  if (!ctx.start_date || !ctx.end_date) problems.push("start_date and end_date are required");
  if (tripNights(ctx) <= 0 && ctx.start_date && ctx.end_date) {
    problems.push("end_date must be after start_date");
  }
  if (!Number.isInteger(ctx.traveler_count) || ctx.traveler_count < 1) {
    problems.push("traveler_count must be a positive integer");
  }
  return problems;
}
