// Structured logging of every agent call so conflicting recommendations can be
// debugged after the fact. Each run gets its own JSONL file under LOG_DIR, and a
// human-readable line is echoed to the console.

import fs from "node:fs";
import path from "node:path";

const LOG_DIR = process.env.LOG_DIR || path.join(process.cwd(), "logs");

function ensureDir() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

export function createRunLogger({ quiet = false } = {}) {
  ensureDir();
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(LOG_DIR, `run-${runId}.jsonl`);
  let seq = 0;

  function write(record) {
    const entry = { seq: seq++, ts: new Date().toISOString(), ...record };
    fs.appendFileSync(file, JSON.stringify(entry) + "\n");
    if (!quiet) {
      const tag = record.event.padEnd(16);
      const detail = record.agent ? `[${record.agent}] ` : "";
      console.error(`  · ${tag} ${detail}${record.summary || ""}`);
    }
    return entry;
  }

  return {
    runId,
    file,
    // Full record of one sub-agent invocation: exactly what it saw and returned.
    logAgentCall({ agent, input, output, summary, error }) {
      return write({ event: "agent_call", agent, input, output, error, summary });
    },
    // Data-source (stub API) calls made from inside a sub-agent.
    logToolCall({ agent, tool, input, output }) {
      return write({
        event: "tool_call",
        agent,
        tool,
        input,
        output,
        summary: `${tool}()`,
      });
    },
    logOrchestrator({ summary, detail }) {
      return write({ event: "orchestrator", summary, detail });
    },
    logConflict({ kind, summary, detail }) {
      return write({ event: "conflict", kind, summary, detail });
    },
    info(summary, detail) {
      return write({ event: "info", summary, detail });
    },
  };
}
