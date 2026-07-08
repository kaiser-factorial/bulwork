import OpenAI from "openai";
import type {
  ChatRequest,
  ChatResult,
  RawVerdict,
  VerdictProvider,
  VerdictRequest,
  VerdictResult,
} from "./provider.js";

let client: OpenAI | null = null;
function getClient(): OpenAI {
  // Lazy so the module imports without a key present (stub / dry-run paths).
  if (!client) {
    client = new OpenAI({
      apiKey: process.env.OPENROUTER_API_KEY,
      baseURL: "https://openrouter.ai/api/v1",
      // Optional attribution headers OpenRouter uses for its dashboard; harmless if unrecognised.
      defaultHeaders: { "X-Title": "BRICK MODE" },
    });
  }
  return client;
}

/** OpenRouter via the OpenAI SDK — one key, many models (Epic R default). Forced tool use through
 *  the OpenAI function-calling shape; the verdict arrives as a JSON *string* in tool_calls args. */
export class OpenRouterProvider implements VerdictProvider {
  readonly name = "openrouter" as const;
  // OpenRouter model ids are namespaced (provider/model); default to the same Haiku the native
  // path uses so a switch is behaviour-preserving.
  readonly defaultModel = "anthropic/claude-haiku-4.5";

  async recordVerdict(req: VerdictRequest): Promise<VerdictResult> {
    const response = await getClient().chat.completions.create({
      model: req.model,
      max_tokens: 256,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.user },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: req.tool.name,
            description: req.tool.description,
            parameters: req.tool.schema,
          },
        },
      ],
      tool_choice: { type: "function", function: { name: req.tool.name } },
    });

    const msg = response.choices?.[0]?.message;
    // Under a forced tool call the assistant content is usually null — coerce to "" so the canary
    // check still runs against whatever text (if any) came back.
    const text = typeof msg?.content === "string" ? msg.content : "";

    // The verdict is a JSON string in the tool call's arguments — parse defensively; malformed or
    // absent → empty verdict → adjudicate.ts fails open to allow (R3). Narrow the tool-call union
    // (a function call vs a custom tool call) before reading `.function`.
    let verdict: RawVerdict = {};
    const call = msg?.tool_calls?.[0];
    const argStr = call && call.type === "function" ? call.function.arguments : undefined;
    if (typeof argStr === "string" && argStr.trim()) {
      try {
        const parsed = JSON.parse(argStr);
        if (parsed && typeof parsed === "object") verdict = parsed as RawVerdict;
      } catch {
        /* malformed JSON args → fail open */
      }
    }

    return { verdict, text, modelUsed: response.model ?? req.model };
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const tools: OpenAI.Chat.ChatCompletionTool[] = (req.tools ?? []).map((t) => ({
      type: "function" as const,
      function: { name: t.name, description: t.description, parameters: t.schema },
    }));
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: "system", content: req.system },
      ...(req.history ?? []).map((h) => ({ role: h.role, content: h.content })),
      { role: "user", content: req.user },
    ];

    // Internal tool loop (tool_choice auto) — mirrors the Anthropic provider; a few cheap rounds.
    let modelUsed = req.model;
    for (let round = 0; round < 4; round += 1) {
      const response = await getClient().chat.completions.create({
        model: req.model,
        max_tokens: req.maxTokens ?? 1024,
        messages,
        ...(tools.length ? { tools } : {}),
      });
      modelUsed = response.model ?? req.model;
      const msg = response.choices?.[0]?.message;
      const calls = (msg?.tool_calls ?? []).filter(
        (c): c is OpenAI.Chat.ChatCompletionMessageFunctionToolCall => c.type === "function",
      );
      if (!msg || !calls.length) {
        return { text: typeof msg?.content === "string" ? msg.content : "", modelUsed };
      }

      messages.push(msg);
      for (const call of calls) {
        const tool = (req.tools ?? []).find((t) => t.name === call.function.name);
        let out = `unknown tool: ${call.function.name}`;
        if (tool) {
          try {
            let input: unknown = {};
            try {
              input = JSON.parse(call.function.arguments || "{}");
            } catch {
              /* malformed args → empty input */
            }
            out = await tool.run(input);
          } catch (e) {
            out = `tool error: ${e instanceof Error ? e.message : String(e)}`;
          }
        }
        messages.push({ role: "tool", tool_call_id: call.id, content: out });
      }
    }
    return { text: "(help agent: tool loop limit reached)", modelUsed };
  }
}
