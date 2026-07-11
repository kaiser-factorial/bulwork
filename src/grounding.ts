import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FocusTask } from "./types.js";
import { bulworkEnv } from "./env.js";

const execFileAsync = promisify(execFile);

// Ground adjudication in the project's own memory via the Unified Memory Hub's `mem` CLI,
// so "on-topic" is judged against what the project actually is — not just the one-line task string.
// Inert unless BULWORK_MEM_BIN is set (deprecated BRICK_MEM_BIN still works), e.g.:
//   BULWORK_MEM_BIN="node /path/to/MEMORY/bin/mem.js"   (or just "mem" if linked globally)
// Requires the Hub configured (Gemini embedding key). Always fails open — never blocks adjudication.
const MEM_BIN = bulworkEnv("MEM_BIN");

export function groundingEnabled(): boolean {
  return Boolean(MEM_BIN);
}

interface MemQueryResponse {
  results?: Array<{ content?: string }>;
}

async function runQuery(
  cmd: string,
  base: string[],
  queryText: string,
  extraArgs: string[] = [],
): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      cmd,
      [...base, "query", queryText, "--limit", "3", "--json", ...extraArgs],
      { timeout: 4000, maxBuffer: 4 * 1024 * 1024 },
    );
    const parsed: unknown = JSON.parse(stdout);
    // mem query --json returns { query, count, results: [...] }, not a raw array.
    const rows: Array<{ content?: string }> = Array.isArray(parsed)
      ? parsed
      : ((parsed as MemQueryResponse).results ?? []);
    return rows.map((r) => r?.content?.slice(0, 300) ?? "").filter(Boolean);
  } catch {
    return [];
  }
}

export async function groundFocus(focus: FocusTask): Promise<string | undefined> {
  if (!MEM_BIN) return undefined;
  const parts = MEM_BIN.split(" ");
  const cmd = parts[0];
  const base = parts.slice(1);

  // Two queries in parallel: task-level (what are we doing?) and project-level (what is this project?).
  // The project query targets voice logs and docs tagged with the projectId for richer context.
  const [taskSnippets, projectSnippets] = await Promise.all([
    runQuery(cmd, base, focus.task),
    focus.projectId
      ? runQuery(cmd, base, focus.projectId, ["--tags", focus.projectId])
      : Promise.resolve([] as string[]),
  ]);

  // Deduplicate by content prefix before merging.
  const seen = new Set<string>();
  const all: string[] = [];
  for (const s of [...taskSnippets, ...projectSnippets]) {
    const key = s.slice(0, 80);
    if (!seen.has(key)) { seen.add(key); all.push(s); }
  }

  return all.length ? all.join("\n---\n") : undefined;
}
