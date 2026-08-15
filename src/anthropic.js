// Thin wrapper around the Anthropic SDK. Lazy-loaded so the app (and --demo mode)
// runs even when the SDK isn't installed or no API key is set.

let _client = null;

export function hasApiKey() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export const ORCH_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";
export const SUBAGENT_MODEL = process.env.SUBAGENT_MODEL || process.env.ANTHROPIC_MODEL || "claude-sonnet-5";

export async function getClient() {
  if (_client) return _client;
  if (!hasApiKey()) {
    throw new Error("ANTHROPIC_API_KEY is not set. Run with --demo for the offline stub pipeline.");
  }
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

// Run one bounded tool-use loop against a set of local tool handlers.
// tools:    array of { name, description, input_schema } passed to the API.
// handlers: { [toolName]: (input) => resultObject }  (sync or async)
// Returns { finalText, transcript, toolCalls }.
export async function runToolLoop({ model, system, messages, tools, handlers, maxTurns = 8, onToolCall }) {
  const client = await getClient();
  const convo = [...messages];
  const toolCalls = [];

  for (let turn = 0; turn < maxTurns; turn++) {
    const resp = await client.messages.create({
      model,
      max_tokens: 2048,
      system,
      tools: tools && tools.length ? tools : undefined,
      messages: convo,
    });

    convo.push({ role: "assistant", content: resp.content });

    const toolUses = resp.content.filter((b) => b.type === "tool_use");
    if (resp.stop_reason !== "tool_use" || toolUses.length === 0) {
      const finalText = resp.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      return { finalText, transcript: convo, toolCalls };
    }

    const toolResults = [];
    for (const tu of toolUses) {
      const handler = handlers[tu.name];
      let result;
      try {
        result = handler ? await handler(tu.input) : { error: `No handler for tool ${tu.name}` };
      } catch (err) {
        result = { error: String(err && err.message ? err.message : err) };
      }
      toolCalls.push({ name: tu.name, input: tu.input, result });
      if (onToolCall) onToolCall({ name: tu.name, input: tu.input, result });
      toolResults.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: JSON.stringify(result),
      });
    }
    convo.push({ role: "user", content: toolResults });
  }

  return { finalText: "", transcript: convo, toolCalls, exhausted: true };
}

// Pull the last fenced ```json block out of an agent's text answer.
export function extractJsonBlock(text) {
  if (!text) return null;
  const matches = [...text.matchAll(/```json\s*([\s\S]*?)```/gi)];
  const raw = matches.length ? matches[matches.length - 1][1] : null;
  const candidate = raw ?? sniffBareJson(text);
  if (!candidate) return null;
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

function sniffBareJson(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}
