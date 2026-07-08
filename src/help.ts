// The in-app help agent (Epic H): grounded usage Q&A over the curated help/ corpus, with optional
// read-only state tools (H4) so it can answer "what am I focused on right now?" from live state.
// Like claude-code-guide, it answers ONLY from the corpus — unknown questions get an honest "not in
// the docs", never invented config. The corpus is small, so retrieval is light keyword scoring —
// no vector DB.
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { selectProvider } from "./providers/index.js";
import type { ChatTool, ChatTurn } from "./providers/index.js";
import { loadTiers, loadSettings } from "./config-store.js";
import { decisionCounts, loadDecisions } from "./decisions-store.js";
import { getSession } from "./session.js";

const HELP_DIR = process.env.BRICK_HELP_DIR ?? fileURLToPath(new URL("../help/", import.meta.url));

export interface HelpChunk {
  doc: string; // file name, e.g. "gatekeeper.md"
  heading: string; // the ## section title
  text: string;
}

let corpusCache: HelpChunk[] | null = null;

/** Load and chunk the corpus: one chunk per ## section of every help/*.md file. Cached. */
export async function loadCorpus(): Promise<HelpChunk[]> {
  if (corpusCache) return corpusCache;
  const chunks: HelpChunk[] = [];
  let files: string[] = [];
  try {
    files = (await readdir(HELP_DIR)).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return []; // missing corpus → empty (the route reports it)
  }
  for (const f of files) {
    let body = "";
    try {
      body = await readFile(join(HELP_DIR, f), "utf8");
    } catch {
      continue;
    }
    const sections = body.split(/^## /m).slice(1); // drop the H1 preamble
    for (const s of sections) {
      const nl = s.indexOf("\n");
      const heading = s.slice(0, nl).trim();
      const text = s.slice(nl + 1).trim();
      if (heading && text) chunks.push({ doc: f, heading, text });
    }
  }
  corpusCache = chunks;
  return chunks;
}

const STOP = new Set(
  "a an and are as at be by can do does for from how i in is it my of on or the to what when where which why with you your".split(
    " ",
  ),
);
const terms = (s: string): string[] =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w));

/** Light keyword retrieval: score chunks by query-term overlap; heading hits weigh extra. */
export function retrieveChunks(question: string, chunks: HelpChunk[], k = 4): HelpChunk[] {
  const q = terms(question);
  if (!q.length) return chunks.slice(0, k);
  const scored = chunks.map((c) => {
    const head = terms(c.heading);
    const body = new Set(terms(c.text));
    let score = 0;
    for (const t of q) {
      if (head.some((h) => h === t || h.startsWith(t) || t.startsWith(h))) score += 3;
      if (body.has(t)) score += 1;
    }
    return { c, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((s) => s.c);
}

// H4: read-only state tools — the help agent can inspect live state, never mutate it.
function stateTools(): ChatTool[] {
  const empty = { type: "object", properties: {} } as Record<string, unknown>;
  return [
    {
      name: "get_config",
      description:
        "Read BRICK's current configuration: tier lists, provider, model, and focus-tuning settings.",
      schema: empty,
      run: async () =>
        JSON.stringify({
          tiers: await loadTiers(),
          settings: await loadSettings(),
          provider: selectProvider().name,
        }),
    },
    {
      name: "get_session",
      description:
        "Read the current focus session, if any: the focus task, phase (work/break), and counters.",
      schema: empty,
      run: async () => JSON.stringify({ session: getSession() }),
    },
    {
      name: "get_learned_decisions",
      description:
        "Read the learned allow/block decisions (clarify answers and corrections) and their counts.",
      schema: empty,
      run: async () => {
        const list = await loadDecisions();
        return JSON.stringify({ counts: decisionCounts(list), decisions: list.slice(0, 50) });
      },
    },
  ];
}

const HELP_SYSTEM = [
  "You are BRICK MODE's help assistant. BRICK MODE is a focus-enforcement tool: a local service plus",
  "a browser extension that blocks or questions off-task pages during timed work sessions.",
  "",
  "Answer the user's usage question using ONLY the documentation excerpts provided below and, when",
  "the question is about current state (what is blocked, what am I focused on, what has been",
  "learned), the read-only tools. Rules:",
  "- Never invent settings, buttons, commands, or behavior that the excerpts don't describe.",
  "- If the answer is not covered by the excerpts, say you don't know and point the user to the",
  "  most relevant doc file for further reading. Do not guess.",
  "- Be concise and practical: lead with the how-to, mention where the control lives.",
  "- The tools are read-only; you cannot change any state for the user — explain how they can.",
].join("\n");

export interface HelpAnswer {
  answer: string;
  sources: string[];
  model: string;
}

export async function answerHelp(question: string, history?: ChatTurn[]): Promise<HelpAnswer> {
  const chunks = await loadCorpus();
  const hits = retrieveChunks(question, chunks);
  const excerpts = hits
    .map((c) => `--- ${c.doc} § ${c.heading} ---\n${c.text}`)
    .join("\n\n");

  const provider = selectProvider();
  const model = (await loadSettings()).model?.trim() || process.env.BRICK_MODEL || provider.defaultModel;
  const res = await provider.chat({
    system: HELP_SYSTEM,
    user: `Documentation excerpts:\n\n${excerpts || "(no matching documentation found)"}\n\nQuestion: ${question}`,
    history,
    model,
    maxTokens: 700,
    tools: stateTools(),
  });
  return {
    answer: res.text,
    sources: hits.map((c) => `${c.doc} § ${c.heading}`),
    model: res.modelUsed,
  };
}
