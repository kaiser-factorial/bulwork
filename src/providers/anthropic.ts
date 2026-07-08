import Anthropic from "@anthropic-ai/sdk";
import type {
  ChatRequest,
  ChatResult,
  RawVerdict,
  VerdictProvider,
  VerdictRequest,
  VerdictResult,
} from "./provider.js";

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

  async chat(req: ChatRequest): Promise<ChatResult> {
    const tools: Anthropic.Tool[] = (req.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.schema as Anthropic.Tool["input_schema"],
    }));
    const messages: Anthropic.MessageParam[] = [
      ...(req.history ?? []).map((h) => ({ role: h.role, content: h.content })),
      { role: "user" as const, content: req.user },
    ];

    // Internal tool loop (tool_choice auto): run any requested read-only tools and continue, a few
    // rounds at most — the help agent's tools are cheap local reads.
    let modelUsed = req.model;
    for (let round = 0; round < 4; round += 1) {
      const response = await getClient().messages.create({
        model: req.model,
        max_tokens: req.maxTokens ?? 1024,
        system: req.system,
        messages,
        ...(tools.length ? { tools } : {}),
      });
      modelUsed = response.model;
      const toolUses = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
      );
      const text = response.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { type: "text"; text: string }).text)
        .join("");
      if (!toolUses.length) return { text, modelUsed };

      messages.push({ role: "assistant", content: response.content });
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const tu of toolUses) {
        const tool = (req.tools ?? []).find((t) => t.name === tu.name);
        let out = `unknown tool: ${tu.name}`;
        if (tool) {
          try {
            out = await tool.run(tu.input);
          } catch (e) {
            out = `tool error: ${e instanceof Error ? e.message : String(e)}`;
          }
        }
        results.push({ type: "tool_result", tool_use_id: tu.id, content: out });
      }
      messages.push({ role: "user", content: results });
    }
    return { text: "(help agent: tool loop limit reached)", modelUsed };
  }
}
