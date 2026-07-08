import { appendFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { FocusTask } from "./types.js";

const DATA_DIR =
  process.env.BRICK_DATA_DIR ?? fileURLToPath(new URL("../.data/", import.meta.url));
const LOG_PATH = join(DATA_DIR, "sessions.jsonl");

export type Phase = "work" | "break" | "ended";

export interface FocusSession {
  id: string;
  focus: FocusTask;
  startedAt: string;
  workMinutes: number;
  breakMinutes: number;
  phase: Phase;
  adjudications: number;
  blocks: number;
}

let current: FocusSession | null = null;

export function getSession(): FocusSession | null {
  return current;
}

async function logEvent(type: string, data: Record<string, unknown>): Promise<void> {
  const line = JSON.stringify({ ts: new Date().toISOString(), type, ...data }) + "\n";
  try {
    await mkdir(DATA_DIR, { recursive: true });
    await appendFile(LOG_PATH, line, "utf8");
  } catch (err) {
    // Logging must never break a session.
    process.stderr.write(`brick session log write failed: ${(err as Error).message}\n`);
  }
  // PLACEHOLDER (Phase 3+): write a Firestore session-index doc. Needs service-account creds.
  await syncToFirestore({ type, ...data });
}

// PLACEHOLDER — stubbed cloud sync. See SESSION_LOG.md "Placeholders in play".
async function syncToFirestore(_event: Record<string, unknown>): Promise<void> {
  /* TODO: requires the same Firestore creds as ledger-cli (GOOGLE_APPLICATION_CREDENTIALS). */
}

export async function startSession(opts: {
  focus: FocusTask;
  workMinutes?: number;
  breakMinutes?: number;
}): Promise<FocusSession> {
  current = {
    id: `brick_${Date.now().toString(36)}`,
    focus: opts.focus,
    startedAt: new Date().toISOString(),
    workMinutes: opts.workMinutes ?? 25,
    breakMinutes: opts.breakMinutes ?? 5,
    phase: "work",
    adjudications: 0,
    blocks: 0,
  };
  await logEvent("session.start", { id: current.id, focus: current.focus });
  return current;
}

/** Re-set the active session's focus to a tighter free-typed string (0.3 specificity shortcut). */
export async function refocusSession(task: string): Promise<FocusSession | null> {
  if (!current) return null;
  current.focus = { task, source: "explicit" };
  await logEvent("session.refocus", { id: current.id, focus: current.focus });
  return current;
}

export async function setPhase(phase: Phase): Promise<FocusSession | null> {
  if (!current) return null;
  current.phase = phase;
  await logEvent("session.phase", { id: current.id, phase });
  return current;
}

export async function endSession(): Promise<FocusSession | null> {
  if (!current) return null;
  current.phase = "ended";
  await logEvent("session.end", {
    id: current.id,
    adjudications: current.adjudications,
    blocks: current.blocks,
  });
  const ended = current;
  current = null;
  return ended;
}

export async function recordAdjudication(
  url: string,
  decision: string,
  tier: string,
): Promise<void> {
  if (current) {
    current.adjudications += 1;
    if (decision === "block") current.blocks += 1;
  }
  await logEvent("adjudication", { url, decision, tier, sessionId: current?.id ?? null });
}
