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
