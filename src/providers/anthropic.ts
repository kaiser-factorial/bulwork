import Anthropic from "@anthropic-ai/sdk";
import type { RawVerdict, VerdictProvider, VerdictRequest, VerdictResult } from "./provider.js";

let client: Anthropic | null = null;
function getClient(): Anthropic {
  // Lazy so the module imports without a key present (stub / dry-run paths).
  if (!client) client = new Anthropic(); // reads ANTHROPIC_API_KEY from the env
  return client;
}

/** The native Anthropic path — kept selectable (one less hop for Claude models, already proven). */
export class AnthropicProvider implements VerdictProvider {
  readonly name = "anthropic" as const;
  readonly defaultModel = "claude-haiku-4-5";

  async recordVerdict(req: VerdictRequest): Promise<VerdictResult> {
    const response = await getClient().messages.create({
      model: req.model,
      max_tokens: 256,
      system: req.system,
      messages: [{ role: "user", content: req.user }],
      tools: [
        {
          name: req.tool.name,
          description: req.tool.description,
          input_schema: req.tool.schema as Anthropic.Tool["input_schema"],
        },
      ],
      tool_choice: { type: "tool", name: req.tool.name },
    });

    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("");

    const toolUse = response.content.find((b) => b.type === "tool_use");
    // Missing tool call → empty verdict; adjudicate.ts coerces that to a fail-open allow (R3).
    const verdict: RawVerdict =
      toolUse && toolUse.type === "tool_use" ? (toolUse.input as RawVerdict) : {};

    return { verdict, text, modelUsed: response.model };
  }
}
