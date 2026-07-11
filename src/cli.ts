#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolveFocusTask } from "./ledger.js";
import { SYSTEM_PROMPT, buildUserPrompt } from "./prompt.js";
import { adjudicate } from "./adjudicate.js";
import type { AdjudicationResult, FocusTask } from "./types.js";

// Auto-load .env if present (Node 20.6+). Harmless if the key is already in the env.
try {
  process.loadEnvFile();
} catch {
  /* no .env file — rely on the ambient environment */
}

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
};

const HELP = `bulwork — focus-task-aware allow/block adjudicator (BULWORK MODE Phase 1)

Usage:
  bulwork <url> [options]

Options:
  --task "<text>"     Focus task for free-typed / untracked work
  --project <id>      Adjudicate against a specific Ledger project (by Firestore id)
  --last              Use the most recently touched Ledger project
  --title "<text>"    Page title, if known (improves the judgment)
  --json              Emit the result as JSON
  --dry-run           Resolve the focus task and print the prompt; no API call (no key needed)
  -h, --help          Show this help

You must choose a focus (--task / --project / --last) — Ledger has no "active project"
state, so with none of them bulwork lists your projects and asks you to pick.

Examples:
  bulwork https://github.com/kaiser-factorial/ledger --task "Fix the OAuth redirect bug"
  bulwork https://news.ycombinator.com --last
  bulwork https://twitter.com/home --project <id> --dry-run
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      task: { type: "string" },
      project: { type: "string" },
      last: { type: "boolean", default: false },
      title: { type: "string" },
      json: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    process.stdout.write(HELP);
    return;
  }

  const url = positionals[0];
  if (!url) {
    process.stderr.write("Error: a URL is required.\n\n" + HELP);
    process.exitCode = 2;
    return;
  }

  const focus = await resolveFocusTask({
    explicit: values.task,
    projectId: values.project,
    last: values.last,
  });

  if (values["dry-run"]) {
    printDryRun(focus, url, values.title);
    return;
  }

  const result = await adjudicate({ focus, url, title: values.title });

  if (values.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    printPretty(result);
  }
}

function focusLine(focus: FocusTask): string {
  const origin =
    focus.source === "explicit"
      ? "explicit"
      : `${focus.projectName ?? "?"} · ${focus.source}`;
  return `${C.bold}Focus:${C.reset} ${focus.task} ${C.dim}(${origin})${C.reset}`;
}

function printDryRun(focus: FocusTask, url: string, title?: string): void {
  process.stdout.write(`${focusLine(focus)}\n`);
  process.stdout.write(`${C.bold}URL:${C.reset}   ${url}\n`);
  process.stdout.write(`${C.dim}--- system ---${C.reset}\n${SYSTEM_PROMPT}\n`);
  process.stdout.write(
    `${C.dim}--- user ---${C.reset}\n${buildUserPrompt({ focus, url, title })}\n`,
  );
  process.stdout.write(`${C.dim}(dry run — no API call made)${C.reset}\n`);
}

function printPretty(r: AdjudicationResult): void {
  const allow = r.decision === "allow";
  const tag = allow ? `${C.green}● ALLOW${C.reset}` : `${C.red}■ BLOCK${C.reset}`;
  const pct = Math.round(r.confidence * 100);
  process.stdout.write(`${tag}  ${C.dim}${pct}% · ${r.latencyMs}ms · ${r.model}${C.reset}\n`);
  process.stdout.write(`${focusLine(r.focus)}\n`);
  process.stdout.write(`${C.bold}URL:${C.reset}   ${r.url}\n`);
  process.stdout.write(`${C.bold}Why:${C.reset}   ${r.reason}\n`);
  if (r.downgraded) {
    process.stdout.write(
      `${C.yellow}↳ block downgraded to allow (confidence below threshold — conservative-allow)${C.reset}\n`,
    );
  }
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${C.red}bulwork: ${msg}${C.reset}\n`);
  process.exitCode = 1;
});
