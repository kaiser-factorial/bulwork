import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { Tier } from "./tiers.js";
import type { FocusTask } from "./types.js";

// The learned-decision store (Epic 0.2): remembers your clarify answers and corrections per
// (focusKey, scope, unit) so the same target isn't re-adjudicated under the same focus — which
// also cuts latency and API cost on repeats. Mirrors config-store.ts conventions (invalid file →
// empty store, never a throw).

export type LearnedScope = "domain" | "page";

export interface LearnedDecision {
  focusKey: string; // projectId ?? normalize(task)
  scope: LearnedScope; // granularity of `unit`
  unit: string; // the domain, or a per-page key (e.g. a YouTube video id)
  decision: "allow" | "block";
  via: "clarify" | "correction";
  at: string; // ISO timestamp
  sampleUrl?: string; // the URL that produced this entry — lets 0.6 rebuild exact eval cases
}

const DATA_DIR =
  process.env.BRICK_DATA_DIR ?? fileURLToPath(new URL("../.data/", import.meta.url));
const DECISIONS_PATH = join(DATA_DIR, "decisions.json");
const MAX_ENTRIES = 5000; // bound the persisted store

/** Stable focus identity: the Ledger project when present, else the normalized task text. */
export function focusKeyOf(focus: FocusTask): string {
  return focus.projectId?.trim() || normalizeTask(focus.task);
}

export function normalizeTask(task: string): string {
  return task.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 200);
}

/** The domain unit for a URL (host without a leading www), used for `scope: "domain"` entries. */
export function domainUnit(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

/** Derive the per-page unit for a page-scoped domain (review fix): centralizing this SERVER-SIDE
 *  means every caller gets correct per-video scoping automatically — including callers that can't
 *  (or forget to) compute it themselves, like the background worker's tab-activation re-check.
 *  Also fixes youtu.be short links, whose video id lives in the path, not a `?v=` query param. */
export function derivePageUnit(url: string, pageScopeDomains: string[]): string | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  const host = u.hostname.replace(/^www\./, "").toLowerCase();
  const scoped = pageScopeDomains.some((d) => host === d || host.endsWith("." + d));
  if (!scoped) return undefined;
  if (host === "youtube.com" || host.endsWith(".youtube.com")) {
    return u.searchParams.get("v") || undefined;
  }
  if (host === "youtu.be") {
    return u.pathname.replace(/^\//, "").split("/")[0] || undefined;
  }
  return undefined; // unknown page-scoped domain — no unit rule yet, falls back to domain scope
}

function isEntry(v: unknown): v is LearnedDecision {
  if (!v || typeof v !== "object") return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.focusKey === "string" &&
    (e.scope === "domain" || e.scope === "page") &&
    typeof e.unit === "string" &&
    (e.decision === "allow" || e.decision === "block") &&
    (e.via === "clarify" || e.via === "correction")
  );
}

/** Load the persisted store. Missing/invalid file → empty array (never throws). */
export async function loadDecisions(): Promise<LearnedDecision[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(DECISIONS_PATH, "utf8"));
    if (Array.isArray(parsed)) return parsed.filter(isEntry).slice(0, MAX_ENTRIES);
  } catch {
    /* no/invalid file → empty store */
  }
  return [];
}

async function persist(list: LearnedDecision[]): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(DECISIONS_PATH, JSON.stringify(list.slice(0, MAX_ENTRIES), null, 2), "utf8");
}

/** Add or replace a learned decision (dedup by focusKey+scope+unit — newest wins). */
export async function learnDecision(
  entry: Omit<LearnedDecision, "at"> & { at?: string },
): Promise<LearnedDecision> {
  const list = await loadDecisions();
  const at = entry.at ?? new Date().toISOString();
  const record: LearnedDecision = { ...entry, at };
  const kept = list.filter(
    (e) => !(e.focusKey === record.focusKey && e.scope === record.scope && e.unit === record.unit),
  );
  kept.push(record);
  await persist(kept);
  return record;
}

/** Wipe the store (the privacy valve / options-page "clear learned decisions"). */
export async function clearDecisions(): Promise<void> {
  try {
    await unlink(DECISIONS_PATH);
  } catch {
    /* may not exist — fine */
  }
}

/** Find the applicable learned decision for a focus + URL. Prefers a `page`-scope match (unit
 *  supplied by the caller, e.g. a YouTube video id — Epic 0.7) over a `domain`-scope match. */
export function findLearned(
  list: LearnedDecision[],
  focusKey: string,
  url: string,
  pageUnit?: string,
): LearnedDecision | null {
  const domain = domainUnit(url);
  if (pageUnit) {
    const page = list.find(
      (e) => e.focusKey === focusKey && e.scope === "page" && e.unit === pageUnit,
    );
    if (page) return page;
  }
  const dom = list.find(
    (e) => e.focusKey === focusKey && e.scope === "domain" && e.unit === domain,
  );
  return dom ?? null;
}

export interface Resolution {
  decision: "allow" | "block";
  reason: string;
  confidence: number;
  via: "tier1" | "tier3" | "learned";
}

/** PURE precedence resolver (Epic 0.2) — unit-testable without any API key.
 *
 *  Order (top wins):  Tier-1 block > learned block > learned allow > Tier-3 allow > model.
 *  Returns null when nothing short-circuits and the model must decide. */
export function resolvePrecedence(tier: Tier, learned: LearnedDecision | null): Resolution | null {
  if (tier === "tier1") {
    return { decision: "block", reason: "Tier-1 always-blocked site.", confidence: 1, via: "tier1" };
  }
  if (learned?.decision === "block") {
    return { decision: "block", reason: "learned", confidence: 1, via: "learned" };
  }
  if (learned?.decision === "allow") {
    return { decision: "allow", reason: "learned", confidence: 1, via: "learned" };
  }
  if (tier === "tier3") {
    return { decision: "allow", reason: "Tier-3 always-allowed site.", confidence: 1, via: "tier3" };
  }
  return null; // fall through to the model
}

/** Convert learned decisions into eval cases (task, url, expected) so `npm run eval` can score
 *  accuracy against your real clarify answers + corrections (Epic 0.6). Uses the captured
 *  `sampleUrl` when present, else reconstructs a domain URL from the unit. */
export function decisionsToCases(
  list: LearnedDecision[],
): Array<{ task: string; url: string; expected: "allow" | "block" }> {
  return list
    .map((e) => ({
      task: e.focusKey,
      url: e.sampleUrl || (e.scope === "domain" && e.unit ? `https://${e.unit}` : ""),
      expected: e.decision,
    }))
    .filter((c) => c.url); // drop page-scope entries with no captured URL (can't rebuild)
}

/** Provenance/decision counts for the options-page gatekeeper readout (Epic 0.5 surfaces these). */
export function decisionCounts(list: LearnedDecision[]): {
  total: number;
  allow: number;
  block: number;
  clarify: number;
  correction: number;
} {
  return {
    total: list.length,
    allow: list.filter((e) => e.decision === "allow").length,
    block: list.filter((e) => e.decision === "block").length,
    clarify: list.filter((e) => e.via === "clarify").length,
    correction: list.filter((e) => e.via === "correction").length,
  };
}
