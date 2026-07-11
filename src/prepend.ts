import type { FocusTask } from "./types.js";

/**
 * "nudge"  — the assistant checks in before answering an off-topic message (default; soft).
 * "strict" — the assistant declines off-topic messages and redirects (the original BRICK doc).
 */
export type PrependStyle = "nudge" | "strict";

/**
 * Build the focus header that bulwork prepends to outgoing AI-chat messages
 * (claude.ai / Gemini / ChatGPT) when no system prompt is available.
 *
 * Framing note: this is phrased as the user's OWN self-imposed reminder, not a command
 * to refuse the user. A model is trained to help the user and to resist instructions that
 * appear to work against them — so "I set this for myself; redirect me if I drift" earns
 * cooperation, where "decline to answer the user" invites push-back. It's a soft nudge by
 * design (locked decision): real enforcement is the URL adjudicator + tier lists, not this.
 */
export function buildPrependHeader(
  focus: FocusTask,
  opts: { style?: PrependStyle } = {},
): string {
  const style = opts.style ?? "nudge";
  const ask =
    style === "strict"
      ? "If this message is not directly related to my focus task, please decline to answer and redirect me back to it."
      : "If this message looks unrelated to my focus task, first remind me of the task and ask whether I really want to go down this path before answering.";
  return [
    "[BULWORK MODE — focus session active]",
    `My focus task: ${focus.task}`,
    `I set this reminder for myself to stay on task. ${ask} If it is on-task, just answer normally.`,
    "[end BULWORK MODE]",
  ].join("\n");
}

/** Prepend the header to a user message: header + blank line + message. */
export function wrapMessage(
  message: string,
  focus: FocusTask,
  opts: { style?: PrependStyle } = {},
): string {
  return `${buildPrependHeader(focus, opts)}\n\n${message}`;
}
