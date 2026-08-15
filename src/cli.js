#!/usr/bin/env node
// CLI entry point. Two modes:
//   node src/cli.js --demo [flags]   -> deterministic offline pipeline (no key)
//   node src/cli.js [flags] --request "..."  -> LLM orchestrator (needs ANTHROPIC_API_KEY)
//
// If no API key is present it automatically falls back to the demo pipeline.

import { loadDotEnv } from "./env.js";
loadDotEnv();

import { createTripContext, validateForPlanning } from "./tripContext.js";
import { createRunLogger } from "./logger.js";
import { hasApiKey } from "./anthropic.js";
import { runDeterministicPipeline, runOrchestratorLLM, formatPlan } from "./orchestrator.js";

function parseArgs(argv) {
  const args = { flags: {}, bools: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        args.bools.add(key);
      } else {
        args.flags[key] = next;
        i++;
      }
    }
  }
  return args;
}

function csv(v) {
  return v ? v.split(",").map((s) => s.trim()).filter(Boolean) : [];
}

function buildContext(flags) {
  return createTripContext({
    destination: flags.to || flags.destination || "Tokyo",
    origin: flags.from || flags.origin || "New York",
    start_date: flags.start || "2026-09-10",
    end_date: flags.end || "2026-09-14",
    traveler_count: flags.travelers ? parseInt(flags.travelers, 10) : 2,
    budget_total: flags.budget ? Number(flags.budget) : 3000,
    budget_currency: flags.currency || "USD",
    preferences: {
      cuisine: csv(flags.cuisine),
      dietary_restrictions: csv(flags.dietary),
      interests: csv(flags.interests) .length ? csv(flags.interests) : ["Culture", "Food"],
      pace: flags.pace || "moderate",
    },
    constraints: csv(flags.constraints),
  });
}

function printHelp() {
  console.log(`Multi-Agent Trip Planner

Usage:
  node src/cli.js --demo [options]              Offline deterministic pipeline (no API key)
  node src/cli.js --request "plan my trip" [options]   LLM orchestrator (needs ANTHROPIC_API_KEY)

Options:
  --to <city>            Destination (default: Tokyo; try "Paris" for curated data)
  --from <city>         Origin (default: New York)
  --start <YYYY-MM-DD>  Start date (default: 2026-09-10)
  --end <YYYY-MM-DD>    End date (default: 2026-09-14)
  --travelers <n>       Traveler count (default: 2)
  --budget <amount>     Budget ceiling total (default: 3000). Set low to trigger conflict resolution.
  --currency <code>     Currency (default: USD)
  --interests a,b,c     e.g. Culture,Food,Art
  --cuisine a,b         Cuisine preferences
  --dietary a,b         e.g. vegan,gluten-free (drives dietary-conflict flags)
  --pace <p>            relaxed | moderate | packed
  --request "<text>"    Natural-language request for the LLM orchestrator
  --help                Show this help

Examples:
  node src/cli.js --demo
  node src/cli.js --demo --to Paris --budget 1500 --dietary vegan --travelers 2
  node src/cli.js --request "5 relaxed days in Paris for 2, budget 4000, love art and food" --to Paris`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.bools.has("help")) return printHelp();

  const ctx = buildContext(args.flags);
  const problems = validateForPlanning(ctx);
  if (problems.length) {
    console.error("TripContext problems:\n - " + problems.join("\n - "));
    process.exit(1);
  }

  const useLLM = !args.bools.has("demo") && hasApiKey();
  const logger = createRunLogger();

  console.error(`\n▶ Planning ${ctx.destination} (${ctx.start_date}→${ctx.end_date}) for ${ctx.traveler_count} · budget $${ctx.budget_total} ${ctx.budget_currency}`);
  console.error(`  mode: ${useLLM ? "LLM orchestrator" : "deterministic demo pipeline"}   log: ${logger.file}\n`);

  let finalText = null;
  if (useLLM) {
    const request = args.flags.request || `Plan a trip to ${ctx.destination}.`;
    const out = await runOrchestratorLLM(ctx, request, logger);
    finalText = out.finalText;
  } else {
    if (!args.bools.has("demo") && !hasApiKey()) {
      console.error("  (no ANTHROPIC_API_KEY found — running the offline demo pipeline)\n");
    }
    await runDeterministicPipeline(ctx, logger);
  }

  console.log("\n" + "=".repeat(70));
  // In LLM mode we show the model's own concise summary; we also always print the
  // deterministic formatted plan from the final TripContext for a stable view.
  if (finalText) {
    console.log("\n[Orchestrator summary]\n");
    console.log(finalText);
    console.log("\n" + "-".repeat(70));
  }
  console.log("\n[Consolidated plan from TripContext]\n");
  console.log(formatPlan(ctx));
  console.log("\n" + "=".repeat(70));
  console.error(`\n✔ Done. Full agent trace: ${logger.file}`);
}

main().catch((err) => {
  console.error("\n✖ Error:", err.message);
  process.exit(1);
});
