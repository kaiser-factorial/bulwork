#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolveFocusTask } from "./ledger.js";
import { buildPrependHeader, wrapMessage } from "./prepend.js";

try {
  process.loadEnvFile();
} catch {
  /* rely on ambient env */
}

const HELP = `bulwork-prepend — build the BULWORK MODE focus header for AI-chat messages

Usage:
  bulwork-prepend [options]

Options:
  --task "<text>"      Free-typed focus task
  --project <id>       Use a specific Ledger project (by Firestore id)
  --last               Use the most recently touched Ledger project
  --message "<text>"   Wrap this message: header + blank line + message
  --strict             Ask the assistant to decline off-topic queries (default: gentle redirect)
  -h, --help           Show this help

Choose a focus (--task / --project / --last) — with none, lists your projects to pick from.

Examples:
  bulwork-prepend --task "Prepare the Q3 VAT return"
  bulwork-prepend --last
  bulwork-prepend --project <id> --message "what's a good pasta recipe?"
`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      task: { type: "string" },
      project: { type: "string" },
      last: { type: "boolean", default: false },
      message: { type: "string" },
      strict: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    process.stdout.write(HELP);
    return;
  }

  const focus = await resolveFocusTask({
    explicit: values.task,
    projectId: values.project,
    last: values.last,
  });
  const style = values.strict ? "strict" : "nudge";

  const out = values.message
    ? wrapMessage(values.message, focus, { style })
    : buildPrependHeader(focus, { style });
  process.stdout.write(out + "\n");
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`bulwork-prepend: ${msg}\n`);
  process.exitCode = 1;
});
