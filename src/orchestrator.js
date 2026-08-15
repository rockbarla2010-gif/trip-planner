// The Orchestrator. Two ways to drive the same shared TripContext:
//
//   runOrchestratorLLM  — a real Claude call that owns the conversation and calls
//                         the six sub-agents as tools (supervisor pattern).
//   runDeterministicPipeline — the same mandated order, computed offline from the
//                         stub data sources; used by --demo and when no API key.
//
// Both funnel through the same conflict-resolution check and the same formatter.

import { ORCHESTRATOR_PROMPT } from "./prompts.js";
import { runToolLoop, ORCH_MODEL } from "./anthropic.js";
import {
  SUBAGENT_CONFIG,
  OUTPUT_KEY,
  deterministic,
  runSubAgentLLM,
  computeBudget,
} from "./subAgents.js";
import { tripNights, tripDays } from "./tripContext.js";

const OVERAGE_THRESHOLD_PCT = 10;
const GEO_MISMATCH_KM = 5;

// ---------------------------------------------------------------------------
// Deterministic pipeline (offline). Order matches the Orchestrator's rules:
// attractions -> hotel -> itinerary -> food -> flights -> budget last.
// ---------------------------------------------------------------------------
const PIPELINE_ORDER = [
  "attractions_agent",
  "hotel_agent",
  "itinerary_agent",
  "food_agent",
  "flight_agent",
  "budget_agent",
];

export async function runDeterministicPipeline(ctx, logger) {
  logger.logOrchestrator({ summary: "start deterministic pipeline", detail: { order: PIPELINE_ORDER } });

  for (const agent of PIPELINE_ORDER) {
    const input = { context_keys: SUBAGENT_CONFIG[agent].contextKeys, dependsOn: SUBAGENT_CONFIG[agent].dependsOn };
    const { data, note } = await deterministic[agent](ctx);
    ctx.sub_agent_outputs[OUTPUT_KEY[agent]] = data;
    logger.logAgentCall({ agent, input, output: data, summary: note });
  }

  resolveConflicts(ctx, logger, { deterministic: true });
  return ctx;
}

// ---------------------------------------------------------------------------
// LLM orchestrator. Exposes each sub-agent as a tool; the tool handler runs the
// sub-agent (its own Claude call) and writes the result into TripContext.
// ---------------------------------------------------------------------------
export async function runOrchestratorLLM(ctx, userRequest, logger) {
  const tools = Object.keys(SUBAGENT_CONFIG).map((name) => ({
    name,
    description: `Delegate to the ${name.replace("_", " ")}. Pass an optional 'note' with specific instructions (e.g. "find a cheaper option").`,
    input_schema: {
      type: "object",
      properties: { note: { type: "string", description: "Optional instruction for the sub-agent." } },
    },
  }));

  const handlers = {};
  for (const name of Object.keys(SUBAGENT_CONFIG)) {
    handlers[name] = async ({ note }) => {
      const { data, raw } = await runSubAgentLLM(name, ctx, { logger, note });
      ctx.sub_agent_outputs[OUTPUT_KEY[name]] = data || { text: raw, note: "unstructured" };
      return data || { text: raw };
    };
  }

  const messages = [
    {
      role: "user",
      content:
        `Trip request: ${userRequest}\n\n` +
        `Current TripContext (JSON):\n\`\`\`json\n${JSON.stringify(ctx, null, 2)}\n\`\`\`\n\n` +
        `Plan this trip. Delegate to the sub-agents per your rules, reconcile their outputs, ` +
        `and present a concise day-by-day plan with total cost.`,
    },
  ];

  logger.logOrchestrator({ summary: "start LLM orchestration", detail: { request: userRequest } });

  let result = await runToolLoop({
    model: ORCH_MODEL,
    system: ORCHESTRATOR_PROMPT,
    messages,
    tools,
    handlers,
    maxTurns: 16,
  });

  // Deterministic safety net: even if the model didn't catch it, check for
  // budget overage / geographic mismatch and feed the conflict back once.
  const conflicts = detectConflicts(ctx);
  if (conflicts.length) {
    conflicts.forEach((c) => logger.logConflict(c));
    result.transcript.push({
      role: "user",
      content:
        `Conflict check found issues before presenting to the user:\n` +
        conflicts.map((c) => `- ${c.summary}`).join("\n") +
        `\n\nRe-delegate to the responsible sub-agent(s) to resolve, then present the final plan.`,
    });
    result = await runToolLoop({
      model: ORCH_MODEL,
      system: ORCHESTRATOR_PROMPT,
      messages: result.transcript,
      tools,
      handlers,
      maxTurns: 12,
    });
  }

  return { ctx, finalText: result.finalText };
}

// ---------------------------------------------------------------------------
// Conflict resolution (shared)
// ---------------------------------------------------------------------------
export function detectConflicts(ctx) {
  const conflicts = [];
  const budget = ctx.sub_agent_outputs.budget;
  if (budget && budget.over_budget && budget.overage_pct > OVERAGE_THRESHOLD_PCT) {
    conflicts.push({
      kind: "budget_overage",
      summary: `Budget overage ${budget.overage_pct}% (> ${OVERAGE_THRESHOLD_PCT}%); largest driver: ${budget.largest_category}.`,
      detail: { overage_pct: budget.overage_pct, largest_category: budget.largest_category },
    });
  }
  const hotels = ctx.sub_agent_outputs.hotels;
  if (hotels && hotels.options) {
    const rec = hotels.options[hotels.recommended_index || 0];
    if (rec && rec.distance_to_clusters_km > GEO_MISMATCH_KM) {
      conflicts.push({
        kind: "geo_mismatch",
        summary: `Recommended hotel (${rec.name}) is ${rec.distance_to_clusters_km}km from planned activity clusters.`,
        detail: { hotel: rec.name, distance_km: rec.distance_to_clusters_km },
      });
    }
  }
  return conflicts;
}

// Deterministic resolution: re-delegate to the biggest cost driver for a cheaper
// alternative, then recompute budget. Bounded retries.
export function resolveConflicts(ctx, logger, { deterministic: isDet = false } = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const conflicts = detectConflicts(ctx);
    if (!conflicts.length) return ctx;
    conflicts.forEach((c) => logger.logConflict(c));

    let changed = false;
    for (const c of conflicts) {
      if (c.kind === "geo_mismatch") {
        // Pick the closest hotel option instead.
        const hotels = ctx.sub_agent_outputs.hotels;
        const closest = hotels.options
          .map((o, i) => [o.distance_to_clusters_km, i])
          .sort((a, b) => a[0] - b[0])[0][1];
        if (closest !== (hotels.recommended_index || 0)) {
          hotels.recommended_index = closest;
          changed = true;
          logger.logOrchestrator({ summary: `resolve geo_mismatch -> hotel #${closest}` });
        }
      }
      if (c.kind === "budget_overage") {
        const largest = c.detail.largest_category;
        if (largest === "Hotel") {
          const hotels = ctx.sub_agent_outputs.hotels;
          const cheapest = hotels.options
            .map((o, i) => [o.price_per_night, i])
            .sort((a, b) => a[0] - b[0])[0][1];
          if (cheapest !== (hotels.recommended_index || 0)) {
            hotels.recommended_index = cheapest;
            changed = true;
            logger.logOrchestrator({ summary: `resolve budget_overage -> cheaper hotel #${cheapest}` });
          }
        } else if (largest === "Flights") {
          const flights = ctx.sub_agent_outputs.flights;
          // options are sorted cheapest-first; ensure option 0 is used (already is).
          // Downgrade signal only — nothing cheaper available in stub set.
          logger.logOrchestrator({ summary: "budget_overage: flights already at cheapest option" });
        } else if (largest === "Food") {
          // Downgrade any $$$ picks to the cheaper alternative per day.
          const food = ctx.sub_agent_outputs.food;
          if (food && food.by_day) {
            for (const d of food.by_day) {
              if (d.options && d.options[0] && d.options[0].price_range === "$$$" && d.options[1]) {
                d.options.reverse();
                changed = true;
              }
            }
            if (changed) logger.logOrchestrator({ summary: "resolve budget_overage -> cheaper dining picks" });
          }
        }
      }
    }

    // Recompute budget after any change.
    ctx.sub_agent_outputs.budget = computeBudget(ctx);
    logger.logAgentCall({
      agent: "budget_agent",
      input: { reason: "recompute after conflict resolution" },
      output: ctx.sub_agent_outputs.budget,
      summary: `re-totalled: group ${ctx.sub_agent_outputs.budget.group_total} ${ctx.sub_agent_outputs.budget.currency}`,
    });

    if (!changed) {
      logger.logOrchestrator({ summary: "conflicts remain but no further deterministic lever available" });
      return ctx;
    }
  }
  return ctx;
}

// ---------------------------------------------------------------------------
// Formatting: the concise, user-facing plan (day-by-day + total cost).
// ---------------------------------------------------------------------------
export function formatPlan(ctx) {
  const o = ctx.sub_agent_outputs;
  const L = [];
  const cur = ctx.budget_currency || "USD";
  L.push(`# Trip Plan: ${ctx.destination || "?"}`);
  L.push(
    `${ctx.origin ? ctx.origin + " -> " : ""}${ctx.destination}  ·  ${ctx.start_date} to ${ctx.end_date}  ·  ` +
      `${ctx.traveler_count} traveler(s)  ·  ${tripNights(ctx)} nights`
  );
  L.push("");
  const tag = (ds) =>
    ds === "amadeus" ? "live (Amadeus)" : ds === "google" ? "live (Google)" : ds === "stub-fallback" ? "estimated (API error)" : "estimated";
  L.push(
    `_Data — flights: ${tag(o.flights?.data_source)} · hotels: ${tag(o.hotels?.data_source)} · ` +
      `attractions: ${tag(o.attractions?.data_source)} · food: ${tag(o.food?.data_source)}. ` +
      `"Estimated" = placeholder stub, not a live quote._`
  );
  L.push("");

  // Flights
  if (o.flights && o.flights.options) {
    const flSrc =
      o.flights.data_source === "amadeus"
        ? " _(live — Amadeus)_"
        : o.flights.data_source === "stub-fallback"
        ? ` _(estimated — Amadeus error: ${o.flights.amadeus_error})_`
        : " _(estimated)_";
    L.push("## Flights" + flSrc);
    o.flights.options.slice(0, 3).forEach((f, i) => {
      L.push(
        `${i + 1}. ${f.airline} — $${f.price_per_person}/pp (group $${f.price_total}), ${f.total_travel_time}` +
          (f.transit_warnings && f.transit_warnings.length ? `  ⚠ ${f.transit_warnings.join(" ")}` : "")
      );
    });
    L.push("");
  }

  // Hotel
  if (o.hotels && o.hotels.options && o.hotels.options.length) {
    const rec = o.hotels.options[o.hotels.recommended_index || 0];
    const hSrc = o.hotels.data_source === "amadeus" ? " _(live — Amadeus)_" : o.hotels.data_source === "stub-fallback" ? ` _(estimated — Amadeus error: ${o.hotels.amadeus_error})_` : " _(estimated)_";
    const dist = rec.distance_to_clusters_km != null ? `${rec.distance_to_clusters_km}km to activity clusters` : "distance n/a";
    const rating = rec.rating != null ? `, rating ${rec.rating}` : "";
    L.push("## Hotel (recommended)" + hSrc);
    L.push(`${rec.name} — $${rec.price_per_night}/night, ${rec.area} (${dist})${rating}`);
    L.push("");
  }

  // Day-by-day
  if (o.itinerary && o.itinerary.days) {
    L.push("## Day-by-day");
    const food = (o.food && o.food.by_day) || [];
    for (const d of o.itinerary.days) {
      L.push(`**Day ${d.day} — ${d.cluster}**`);
      L.push(`- Morning: ${d.morning}`);
      L.push(`- Afternoon: ${d.afternoon}`);
      L.push(`- Evening: ${d.evening}`);
      const fd = food.find((x) => x.day === d.day);
      if (fd && fd.options.length) {
        const dining = fd.options
          .map((r) => `${r.name} (${r.cuisine}, ${r.price_range})${r.dietary_conflict && r.dietary_conflict.length ? ` ⚠ ${r.dietary_conflict.join("; ")}` : ""}`)
          .join(" · ");
        L.push(`- Dining: ${dining}`);
      }
      L.push("");
    }
  }

  // Budget
  if (o.budget) {
    const b = o.budget;
    L.push("## Budget");
    L.push(`| Category | Est. cost (${cur}) | % of total |`);
    L.push(`| --- | ---: | ---: |`);
    for (const row of b.breakdown) {
      L.push(`| ${row.category} | ${row.estimated_cost} | ${row.pct_of_total}% |`);
    }
    L.push(`| **Group total** | **${b.group_total}** | 100% |`);
    L.push("");
    L.push(`Per traveler: ~$${b.per_traveler_total} ${cur}. Budget ceiling: ${b.budget_total != null ? "$" + b.budget_total : "not set"}.`);
    if (b.over_budget) {
      L.push(`⚠ **Over budget by ${b.overage_pct}%.** Largest driver: ${b.largest_category}. Suggestion: ${b.trade_off}`);
    } else if (b.budget_total != null) {
      L.push(`✅ Within budget.`);
    }
  }

  return L.join("\n");
}
