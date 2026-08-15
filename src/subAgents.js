// The six specialist sub-agents. Each has:
//   - a narrow system prompt (from prompts.js)
//   - a slice of TripContext it is allowed to see
//   - the data-source tools it may call
//   - upstream outputs it depends on
//
// Two execution paths share this definition:
//   runSubAgentLLM(...)  -> a real Claude call with tool use (needs API key)
//   deterministic.<x>()  -> pure stub-driven computation (offline / --demo)
// Both return the SAME structured `data` shape, so the rest of the system
// (formatting, conflict resolution) doesn't care which produced it.

import {
  searchFlights,
  searchHotels,
  searchAttractions,
  searchRestaurants,
} from "./dataSources.js";
import { contextSlice, tripDays, tripNights } from "./tripContext.js";
import { SUBAGENT_PROMPTS } from "./prompts.js";
import { runToolLoop, extractJsonBlock, SUBAGENT_MODEL } from "./anthropic.js";

// --- data-source tools, described for the API and wired to handlers ---------
const TOOLS = {
  search_flights: {
    def: {
      name: "search_flights",
      description: "Search flight options for a route and dates. Returns ranked estimated options (stub data).",
      input_schema: {
        type: "object",
        properties: {
          origin: { type: "string" },
          destination: { type: "string" },
          start_date: { type: "string" },
          end_date: { type: "string" },
          traveler_count: { type: "integer" },
          budget_ceiling: { type: ["number", "null"] },
          currency: { type: "string", description: "ISO currency code, e.g. USD." },
        },
        required: ["origin", "destination", "start_date", "end_date"],
      },
    },
    handler: (input) => searchFlights(input),
  },
  search_hotels: {
    def: {
      name: "search_hotels",
      description: "Search hotels for a destination/date range, optionally biased toward given attraction clusters.",
      input_schema: {
        type: "object",
        properties: {
          destination: { type: "string" },
          start_date: { type: "string" },
          end_date: { type: "string" },
          traveler_count: { type: "integer" },
          budget: { type: ["number", "null"] },
          near_clusters: { type: "array", items: { type: "string" } },
        },
        required: ["destination"],
      },
    },
    handler: (input) => searchHotels(input),
  },
  search_attractions: {
    def: {
      name: "search_attractions",
      description: "Return a shortlist of attractions for a destination, sized to trip length and biased by interests.",
      input_schema: {
        type: "object",
        properties: {
          destination: { type: "string" },
          interests: { type: "array", items: { type: "string" } },
          trip_days: { type: "integer" },
        },
        required: ["destination"],
      },
    },
    handler: (input) => searchAttractions(input),
  },
  search_restaurants: {
    def: {
      name: "search_restaurants",
      description: "Return restaurant options for a destination, optionally filtered to an area/cluster and dietary needs.",
      input_schema: {
        type: "object",
        properties: {
          destination: { type: "string" },
          cuisine: { type: "array", items: { type: "string" } },
          dietary_restrictions: { type: "array", items: { type: "string" } },
          budget_level: { type: "string" },
          area: { type: ["string", "null"] },
          lat: { type: ["number", "null"], description: "Latitude of the day's cluster centroid, for proximity bias." },
          lon: { type: ["number", "null"], description: "Longitude of the day's cluster centroid." },
        },
        required: ["destination"],
      },
    },
    handler: (input) => searchRestaurants(input),
  },
};

export const SUBAGENT_CONFIG = {
  attractions_agent: { contextKeys: ["destination", "preferences", "start_date", "end_date"], tools: ["search_attractions"], dependsOn: [] },
  hotel_agent: { contextKeys: ["destination", "start_date", "end_date", "traveler_count", "budget_total", "budget_currency"], tools: ["search_hotels"], dependsOn: ["attractions"] },
  itinerary_agent: { contextKeys: ["destination", "start_date", "end_date", "preferences"], tools: [], dependsOn: ["attractions", "hotels"] },
  food_agent: { contextKeys: ["destination", "preferences", "budget_currency"], tools: ["search_restaurants"], dependsOn: ["itinerary"] },
  flight_agent: { contextKeys: ["origin", "destination", "start_date", "end_date", "traveler_count", "budget_total"], tools: ["search_flights"], dependsOn: [] },
  budget_agent: { contextKeys: ["budget_total", "budget_currency", "traveler_count"], tools: [], dependsOn: ["flights", "hotels", "food"] },
};

// Build the user-turn payload a sub-agent sees: its context slice + the upstream
// outputs it depends on. This is exactly what gets logged as "input".
function buildAgentInput(name, ctx, extraNote) {
  const cfg = SUBAGENT_CONFIG[name];
  const slice = contextSlice(ctx, cfg.contextKeys);
  const upstream = {};
  for (const dep of cfg.dependsOn) {
    upstream[dep] = ctx.sub_agent_outputs[dep] || null;
  }
  return {
    trip_context: slice,
    trip_days: tripDays(ctx),
    upstream_outputs: upstream,
    orchestrator_note: extraNote || null,
  };
}

// --- LLM path ---------------------------------------------------------------
export async function runSubAgentLLM(name, ctx, { logger, note } = {}) {
  const cfg = SUBAGENT_CONFIG[name];
  const input = buildAgentInput(name, ctx, note);
  const tools = cfg.tools.map((t) => TOOLS[t].def);
  const handlers = Object.fromEntries(cfg.tools.map((t) => [t, TOOLS[t].handler]));

  const userMessage =
    `Here is the relevant TripContext and any upstream agent outputs as JSON:\n\n` +
    "```json\n" + JSON.stringify(input, null, 2) + "\n```\n\n" +
    `Do your job for this trip and finish with your JSON result block.`;

  const { finalText, toolCalls } = await runToolLoop({
    model: SUBAGENT_MODEL,
    system: SUBAGENT_PROMPTS[name],
    messages: [{ role: "user", content: userMessage }],
    tools,
    handlers,
    onToolCall: ({ name: tool, input: tinput, result }) =>
      logger && logger.logToolCall({ agent: name, tool, input: tinput, output: result }),
  });

  const data = extractJsonBlock(finalText);
  logger && logger.logAgentCall({
    agent: name,
    input,
    output: { text: finalText, data },
    summary: data ? "returned structured result" : "returned text only",
  });
  return { raw: finalText, data, toolCalls };
}

// --- Deterministic path (offline / --demo) ----------------------------------
// Same output shapes, computed straight from the stub data sources.

const PRICE_LEVEL = { $: 18, $$: 40, $$$: 80 };

function srcLabel(ds) {
  if (ds === "amadeus") return "LIVE Amadeus";
  if (ds === "google") return "LIVE Google";
  if (ds === "stub-fallback") return "stub (API error)";
  return "stub";
}

export const deterministic = {
  async attractions_agent(ctx) {
    const out = await searchAttractions({
      destination: ctx.destination,
      interests: ctx.preferences.interests,
      trip_days: tripDays(ctx),
    });
    const src = srcLabel(out.data_source);
    return {
      data: {
        attractions: out.attractions,
        clusters: out.clusters,
        cluster_centroids: out.cluster_centroids || [],
        is_placeholder: out.is_placeholder !== false,
        data_source: out.data_source,
        amadeus_error: out.amadeus_error || null,
      },
      note: `[${src}] ${out.attractions.length} spots; clusters: ${out.clusters.join(", ") || "n/a"}`,
    };
  },

  async hotel_agent(ctx) {
    const att = ctx.sub_agent_outputs.attractions || {};
    const out = await searchHotels({
      destination: ctx.destination,
      start_date: ctx.start_date,
      end_date: ctx.end_date,
      traveler_count: ctx.traveler_count,
      budget: ctx.budget_total,
      currency: ctx.budget_currency,
      near_clusters: att.clusters || [],
      near_cluster_centroids: att.cluster_centroids || [],
    });
    const src = srcLabel(out.data_source);
    const top = out.options[0];
    return {
      data: {
        options: out.options,
        recommended_index: 0,
        is_placeholder: out.is_placeholder !== false,
        data_source: out.data_source,
        amadeus_error: out.amadeus_error || null,
      },
      note: top
        ? `[${src}] ${out.options.length} hotels; top = ${top.name} (${top.area}, ${top.distance_to_clusters_km ?? "?"}km)`
        : `[${src}] no hotels returned${out.error ? ` (${out.error})` : ""}`,
    };
  },

  itinerary_agent(ctx) {
    const attractions = (ctx.sub_agent_outputs.attractions && ctx.sub_agent_outputs.attractions.attractions) || [];
    const hotel =
      ctx.sub_agent_outputs.hotels &&
      ctx.sub_agent_outputs.hotels.options[ctx.sub_agent_outputs.hotels.recommended_index || 0];
    const days = buildItinerary(attractions, tripDays(ctx), ctx.preferences.pace);
    return {
      data: { days, base_hotel: hotel ? hotel.name : null, base_area: hotel ? hotel.area : null },
      note: `${days.length}-day plan anchored at ${hotel ? hotel.area : "hotel"}`,
    };
  },

  async food_agent(ctx) {
    const days = (ctx.sub_agent_outputs.itinerary && ctx.sub_agent_outputs.itinerary.days) || [];
    const centroids = (ctx.sub_agent_outputs.attractions && ctx.sub_agent_outputs.attractions.cluster_centroids) || [];
    const by_day = [];
    let src, err;
    for (const d of days) {
      const c = centroids.find((x) => x.label === d.cluster);
      const res = await searchRestaurants({
        destination: ctx.destination,
        cuisine: ctx.preferences.cuisine,
        dietary_restrictions: ctx.preferences.dietary_restrictions,
        budget_level: "$$",
        area: d.cluster,
        lat: c ? c.lat : null,
        lon: c ? c.lon : null,
      });
      src = res.data_source;
      err = err || res.google_error || res.error || null;
      const options = res.options.slice(0, 2).map((r) => ({
        name: r.name,
        cuisine: r.cuisine,
        price_range: r.price_range,
        rating: r.rating ?? null,
        why: r.why || `${r.cuisine} near ${r.cluster || d.cluster}, walkable from the day's stops`,
        dietary_conflict: r.dietary_conflict,
      }));
      by_day.push({ day: d.day, cluster: d.cluster, options });
    }
    return {
      data: { by_day, data_source: src, is_placeholder: src !== "google", google_error: err },
      note: `[${srcLabel(src)}] dining for ${by_day.length} days`,
    };
  },

  async flight_agent(ctx) {
    const out = await searchFlights({
      origin: ctx.origin,
      destination: ctx.destination,
      start_date: ctx.start_date,
      end_date: ctx.end_date,
      traveler_count: ctx.traveler_count,
      budget_ceiling: ctx.budget_total,
      currency: ctx.budget_currency,
    });
    const top = out.options[0];
    const src = srcLabel(out.data_source);
    return {
      data: { options: out.options, is_placeholder: out.is_placeholder !== false, data_source: out.data_source, amadeus_error: out.amadeus_error || null },
      note: out.options.length
        ? `[${src}] ${out.options.length} flights; cheapest ${top.airline} $${top.price_per_person}/pp`
        : `[${src}] no flights returned${out.error ? ` (${out.error})` : ""}`,
    };
  },

  budget_agent(ctx) {
    return { data: computeBudget(ctx), note: "totalled all cost categories" };
  },
};

// Distribute attractions across days, one cluster-focused day at a time to
// minimize backtracking; pace controls how many stops land in each day.
function buildItinerary(attractions, days, pace) {
  const perDayCap = pace === "packed" ? 3 : pace === "relaxed" ? 2 : 3;
  const byCluster = new Map();
  for (const a of attractions) {
    if (!byCluster.has(a.cluster)) byCluster.set(a.cluster, []);
    byCluster.get(a.cluster).push(a);
  }
  // Round-robin clusters into day buckets.
  const clusterQueues = [...byCluster.entries()];
  const dayBuckets = Array.from({ length: days }, () => []);
  let di = 0;
  for (const [, items] of clusterQueues) {
    for (const item of items) {
      // find the next day bucket with room, preferring same-cluster grouping
      let placed = false;
      for (let hop = 0; hop < days; hop++) {
        const idx = (di + hop) % days;
        const bucket = dayBuckets[idx];
        const clusterMatch = bucket.length === 0 || bucket[0].cluster === item.cluster;
        if (bucket.length < perDayCap && clusterMatch) {
          bucket.push(item);
          placed = true;
          break;
        }
      }
      if (!placed) {
        // overflow: drop into the least-full day
        const idx = dayBuckets.map((b, i) => [b.length, i]).sort((a, b) => a[0] - b[0])[0][1];
        dayBuckets[idx].push(item);
      }
    }
    di = (di + 1) % days;
  }

  return dayBuckets.map((bucket, i) => {
    const cluster = bucket[0] ? bucket[0].cluster : "Flexible / rest";
    const [m, a, e] = [bucket[0], bucket[1], bucket[2]];
    return {
      day: i + 1,
      cluster,
      morning: m ? `${m.name} (${m.category}, ~${m.time_needed_hrs}h${m.booking && m.booking !== "None" ? `, ${m.booking}` : ""})` : "Free morning / flexible",
      afternoon: a ? `${a.name} (${a.category}, ~${a.time_needed_hrs}h)` : "Explore " + cluster + " at leisure",
      evening: e ? `${e.name} (${e.category}, ~${e.time_needed_hrs}h)` : "Dinner & downtime near " + cluster,
    };
  });
}

// Sum flights + hotel + food into a budget breakdown with overage detection.
export function computeBudget(ctx) {
  const currency = ctx.budget_currency || "USD";
  const travelers = ctx.traveler_count || 1;
  const nights = tripNights(ctx) || 1;
  const days = tripDays(ctx);

  const flights = ctx.sub_agent_outputs.flights;
  const hotels = ctx.sub_agent_outputs.hotels;
  const food = ctx.sub_agent_outputs.food;

  const flightPerPerson = flights && flights.options && flights.options[0] ? flights.options[0].price_per_person : 0;
  const flightTotal = flightPerPerson * travelers;

  const hotel = hotels && hotels.options ? hotels.options[hotels.recommended_index || 0] : null;
  const hotelTotal = hotel ? hotel.price_per_night * nights : 0; // room shared by group

  // Food: assume 2 meals out/day/person, using the mid price level of each day's picks.
  let foodTotal = 0;
  if (food && food.by_day) {
    for (const d of food.by_day) {
      const lvl = d.options && d.options[0] ? d.options[0].price_range : "$$";
      foodTotal += (PRICE_LEVEL[lvl] || 40) * 2 * travelers;
    }
  } else {
    foodTotal = 40 * 2 * travelers * days;
  }

  const group_total = flightTotal + hotelTotal + foodTotal;
  const per_traveler_total = Math.round(group_total / travelers);
  const budget_total = ctx.budget_total;
  const over_budget = budget_total != null && group_total > budget_total;
  const overage_pct = budget_total ? +(((group_total - budget_total) / budget_total) * 100).toFixed(1) : 0;

  const cats = [
    { category: "Flights", estimated_cost: flightTotal },
    { category: "Hotel", estimated_cost: hotelTotal },
    { category: "Food", estimated_cost: foodTotal },
  ];
  const breakdown = cats.map((c) => ({
    ...c,
    pct_of_total: group_total ? +((c.estimated_cost / group_total) * 100).toFixed(1) : 0,
  }));
  const largest = [...cats].sort((a, b) => b.estimated_cost - a.estimated_cost)[0];

  let trade_off = null;
  if (over_budget) {
    if (largest.category === "Flights") trade_off = "Shift to the cheaper flight option or nearby dates to cut the largest cost driver.";
    else if (largest.category === "Hotel") trade_off = "Pick the 2nd hotel option (slightly farther out) or reduce by one night.";
    else trade_off = "Swap one $$$ dinner/day for a $$ option; food is the top overage driver.";
  }

  return {
    currency,
    traveler_count: travelers,
    per_traveler_total,
    group_total: Math.round(group_total),
    budget_total,
    over_budget,
    overage_pct,
    largest_category: largest.category,
    trade_off,
    breakdown,
    is_placeholder: true,
  };
}

export const OUTPUT_KEY = {
  attractions_agent: "attractions",
  hotel_agent: "hotels",
  itinerary_agent: "itinerary",
  food_agent: "food",
  flight_agent: "flights",
  budget_agent: "budget",
};
