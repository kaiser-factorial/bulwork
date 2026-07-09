import type { VerdictProvider } from "./provider.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenRouterProvider } from "./openrouter.js";

export type {
  ChatRequest,
  ChatResult,
  ChatTool,
  ChatTurn,
  RawVerdict,
  VerdictProvider,
  VerdictRequest,
  VerdictResult,
  VerdictTool,
} from "./provider.js";

/** Which provider is active. `BRICK_PROVIDER` wins if set; otherwise the default is `openrouter`,
 *  but we gracefully fall back to `anthropic` when only the Anthropic key is present — so an
 *  existing Anthropic-only install keeps adjudicating instead of silently failing open. */
export function activeProviderName(): "openrouter" | "anthropic" {
  const explicit = process.env.BRICK_PROVIDER?.trim().toLowerCase();
  if (explicit === "anthropic") return "anthropic";
  if (explicit === "openrouter") return "openrouter";
  const hasOpenRouter = Boolean(process.env.OPENROUTER_API_KEY);
  const hasAnthropic = Boolean(process.env.ANTHROPIC_API_KEY);
  if (!hasOpenRouter && hasAnthropic) return "anthropic";
  return "openrouter"; // default
}

export function selectProvider(): VerdictProvider {
  return activeProviderName() === "anthropic" ? new AnthropicProvider() : new OpenRouterProvider();
}

/** True when the *active* provider has its API key set — drives the server's stub path. */
export function providerHasKey(): boolean {
  return activeProviderName() === "anthropic"
    ? Boolean(process.env.ANTHROPIC_API_KEY)
    : Boolean(process.env.OPENROUTER_API_KEY);
}

/** Guard a model id against the active provider's namespace (review fix): OpenRouter ids are
 *  `vendor/model`, Anthropic ids are bare. A cross-provider id would 404 on EVERY call and, since
 *  adjudication fails open, silently disable all Tier-2 blocking — so a mismatched id falls back
 *  to the provider's default with a loud stderr warning instead. */
export function resolveModelForProvider(provider: VerdictProvider, model: string): string {
  const namespaced = model.includes("/");
  const mismatch = provider.name === "openrouter" ? !namespaced : namespaced;
  if (!mismatch) return model;
  process.stderr.write(
    `[brick:model_mismatch] "${model}" is not a valid ${provider.name} model id — using the provider default "${provider.defaultModel}". Fix BRICK_MODEL / the options-page model.\n`,
  );
  return provider.defaultModel;
}
