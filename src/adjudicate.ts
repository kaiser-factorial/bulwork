import { outputLeakedCanary, onShieldEvent, emitShieldEvent } from "@local/shield";
import type { AdjudicationInput, AdjudicationResult, Decision, Verdict } from "./types.js";
import { SYSTEM_PROMPT, SYSTEM_CANARY, buildUserPrompt } from "./prompt.js";
import { groundFocus } from "./grounding.js";
import { resolveModelForProvider, selectProvider } from "./providers/index.js";
import type { RawVerdict, VerdictTool } from "./providers/index.js";

onShieldEvent((ev) => {
  process.stderr.write(
    `[shield:${ev.type}] source=${ev.source} score=${ev.score?.toFixed(2) ?? "n/a"} patterns=${ev.patterns?.join(",") ?? ""}\n`,
  );
});

const MIN_BLOCK_CONFIDENCE = Number(process.env.BRICK_MIN_BLOCK_CONFIDENCE ?? "0.6");

// Forced tool use is the verdict channel: it guarantees a structured {decision, reason, confidence}
// without parsing free text. Provider-neutral schema (Anthropic input_schema / OpenAI parameters).
const RECORD_VERDICT_TOOL: VerdictTool = {
  name: "record_verdict",
  description: "Record the allow/block/ask decision for the URL against the focus task.",
  schema: {
    type: "object",
    properties: {
      decision: {
        type: "string",
        enum: ["allow", "block", "ask"],
        description:
          "allow = consistent with the focus; block = clearly off-task; ask = the focus is too " +
          "vague to judge this page against (route to a clarify prompt, not a block).",
      },
      reason: { type: "string", description: "One short sentence explaining the decision." },
      confidence: { type: "number", description: "Certainty in the decision, 0.0 to 1.0." },
    },
    required: ["decision", "reason", "confidence"],
  },
};

const VALID_DECISIONS: readonly Decision[] = ["allow", "block", "ask"];

export async function adjudicate(input: AdjudicationInput): Promise<AdjudicationResult> {
  const start = Date.now();
  const provider = selectProvider();
  // R2: per-request override wins; then the env seed; then the active provider's default — guarded
  // against a cross-provider id, which would 404 every call and silently fail open forever.
  const model = resolveModelForProvider(
    provider,
    input.model ?? process.env.BRICK_MODEL ?? provider.defaultModel,
  );
  // Fast-follow: enrich with project context from the Memory Hub (no-op unless BRICK_MEM_BIN set).
  const grounding = input.grounding ?? (await groundFocus(input.focus));

  // R3 / fail-open ethos: any provider or network error degrades to allow, never a hard block.
  let text = "";
  let raw: RawVerdict = {};
  let modelUsed = model;
  try {
    const res = await provider.recordVerdict({
      system: SYSTEM_PROMPT,
      user: buildUserPrompt({ ...input, grounding }),
      tool: RECORD_VERDICT_TOOL,
      model,
    });
    text = res.text;
    raw = res.verdict;
    modelUsed = res.modelUsed;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[brick:provider_error] url=${input.url} ${msg.slice(0, 200)}\n`);
    return {
      decision: "allow",
      reason: "Adjudicator error — failing open (allow).",
      confidence: 0,
      focus: input.focus,
      url: input.url,
      title: input.title,
      model: modelUsed,
      latencyMs: Date.now() - start,
      downgraded: false,
      providerError: true, // observable fail-open — never a judged allow (review fix)
    };
  }

  const latencyMs = Date.now() - start;

  // Check for canary leak before trusting any output — a leak means the model was manipulated into
  // echoing its system context, which invalidates the verdict.
  if (outputLeakedCanary(text, SYSTEM_CANARY)) {
    emitShieldEvent({ type: "canary_leaked", source: input.url, detail: text.slice(0, 200) });
    return {
      decision: "block",
      reason: "Security: canary leak detected — verdict suppressed.",
      confidence: 1,
      focus: input.focus,
      url: input.url,
      title: input.title,
      model: modelUsed,
      latencyMs: Date.now() - start,
      downgraded: false,
    };
  }

  // Coerce the raw tool args into a trusted Verdict. Malformed/absent (empty raw) → allow, conf 0.
  const decision: Decision = VALID_DECISIONS.includes(raw.decision as Decision)
    ? (raw.decision as Decision)
    : "allow";
  const confidence =
    typeof raw.confidence === "number" && Number.isFinite(raw.confidence)
      ? Math.min(1, Math.max(0, raw.confidence))
      : 0;
  const verdict: Verdict = {
    decision,
    reason: typeof raw.reason === "string" ? raw.reason : "",
    confidence,
  };

  // Conservative-allow: downgrade a low-confidence block to allow so the MVP never interrupts
  // legitimate work on a shaky call. (`ask` is already non-blocking, so it's left untouched.)
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
    model: modelUsed,
    latencyMs,
    downgraded,
  };
}
