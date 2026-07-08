// The provider seam (Epic R). The single model call is extracted behind VerdictProvider so the
// rest of adjudicate.ts (canary check, conservative-allow, shield) is provider-agnostic. Each
// provider adapts its own SDK's forced-tool shape to this neutral contract.

/** The unvalidated verdict a provider extracts from the model's forced tool call. Fields are
 *  `unknown` on purpose — adjudicate.ts validates/coerces them (NaN→0, bad decision→allow). */
export interface RawVerdict {
  decision?: unknown;
  reason?: unknown;
  confidence?: unknown;
}

/** A forced-tool definition, in provider-neutral form. `schema` is a JSON Schema object; the
 *  Anthropic provider passes it as `input_schema`, the OpenRouter provider as `parameters`. */
export interface VerdictTool {
  name: string;
  description: string;
  schema: Record<string, unknown>;
}

export interface VerdictRequest {
  system: string;
  user: string;
  tool: VerdictTool;
  model: string;
}

export interface VerdictResult {
  /** The parsed tool arguments (may be empty if the model returned no/malformed tool call). */
  verdict: RawVerdict;
  /** Any assistant non-tool text — fed to the canary/shield leak check. Often "" under a forced
   *  tool call (Anthropic omits text; OpenAI's `message.content` is usually null). */
  text: string;
  /** The model id the provider actually used (echoed back for logging). */
  modelUsed: string;
}

export interface VerdictProvider {
  readonly name: "openrouter" | "anthropic";
  /** A sensible default model id for this provider, used when BRICK_MODEL is unset. */
  readonly defaultModel: string;
  recordVerdict(req: VerdictRequest): Promise<VerdictResult>;
}
