import OpenAI from "openai";
import type { RawVerdict, VerdictProvider, VerdictRequest, VerdictResult } from "./provider.js";

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
}
