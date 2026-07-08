import Anthropic from "@anthropic-ai/sdk";
import { outputLeakedCanary, onShieldEvent, emitShieldEvent } from "@local/shield";
import type { AdjudicationInput, AdjudicationResult, Verdict } from "./types.js";
import { SYSTEM_PROMPT, SYSTEM_CANARY, buildUserPrompt } from "./prompt.js";
import { groundFocus } from "./grounding.js";

onShieldEvent((ev) => {
  process.stderr.write(
    `[shield:${ev.type}] source=${ev.source} score=${ev.score?.toFixed(2) ?? "n/a"} patterns=${ev.patterns?.join(",") ?? ""}\n`,
  );
});

const MODEL = process.env.BRICK_MODEL ?? "claude-haiku-4-5";
const MIN_BLOCK_CONFIDENCE = Number(process.env.BRICK_MIN_BLOCK_CONFIDENCE ?? "0.6");

// Forced tool use is the verdict channel: it's well-typed across SDK versions and
// guarantees a structured {decision, reason, confidence} without parsing free text.
const RECORD_VERDICT_TOOL: Anthropic.Tool = {
  name: "record_verdict",
  description: "Record the allow/block decision for the URL against the focus task.",
  input_schema: {
    type: "object",
    properties: {
      decision: {
        type: "string",
        enum: ["allow", "block"],
        description: "Whether to allow or block the URL for this focus task.",
      },
      reason: {
        type: "string",
        description: "One short sentence explaining the decision.",
      },
      confidence: {
        type: "number",
        description: "Certainty in the decision, 0.0 to 1.0.",
      },
    },
    required: ["decision", "reason", "confidence"],
  },
};

let client: Anthropic | null = null;
function getClient(): Anthropic {
  // Constructed lazily so --dry-run works without an API key.
  if (!client) client = new Anthropic(); // reads ANTHROPIC_API_KEY from the env
  return client;
}

export async function adjudicate(input: AdjudicationInput): Promise<AdjudicationResult> {
  const start = Date.now();
  // Fast-follow: enrich with project context from the Memory Hub (no-op unless BRICK_MEM_BIN set).
  const grounding = input.grounding ?? (await groundFocus(input.focus));
  const response = await getClient().messages.create({
    model: MODEL,
    max_tokens: 256,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildUserPrompt({ ...input, grounding }) }],
    tools: [RECORD_VERDICT_TOOL],
    tool_choice: { type: "tool", name: "record_verdict" },
  });
  const latencyMs = Date.now() - start;

  // Check for canary leak before trusting any output — a leak means the model was
  // manipulated into echoing its system context, which invalidates the verdict.
  const textBlocks = response.content.filter((b) => b.type === "text").map((b) => (b as { type: "text"; text: string }).text).join("");
  if (outputLeakedCanary(textBlocks, SYSTEM_CANARY)) {
    emitShieldEvent({ type: "canary_leaked", source: input.url, detail: textBlocks.slice(0, 200) });
    return { decision: "block", reason: "Security: canary leak detected — verdict suppressed.", confidence: 1, focus: input.focus, url: input.url, title: input.title, model: response.model, latencyMs: Date.now() - start, downgraded: false };
  }

  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error("Adjudicator did not return a verdict.");
  }
  const verdict = toolUse.input as Verdict;

  // Defend against a malformed tool input (NaN / out-of-range / non-numeric confidence).
  verdict.confidence =
    typeof verdict.confidence === "number" && Number.isFinite(verdict.confidence)
      ? Math.min(1, Math.max(0, verdict.confidence))
      : 0;
  if (verdict.decision !== "allow" && verdict.decision !== "block") verdict.decision = "allow";

  // Conservative-allow: downgrade a low-confidence block to allow so the MVP never
  // interrupts legitimate work on a shaky call.
  let downgraded = false;
  if (verdict.decision === "block" && verdict.confidence < MIN_BLOCK_CONFIDENCE) {
    downgraded = true;
    verdict.decision = "allow";
  }

  return {
    ...verdict,
    focus: input.focus,
    url: input.url,
    title: input.title,
    model: response.model,
    latencyMs,
    downgraded,
  };
}
