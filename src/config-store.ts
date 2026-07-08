import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { DEFAULT_TIERS } from "./tiers.js";
import type { TierConfig } from "./tiers.js";

const DATA_DIR =
  process.env.BRICK_DATA_DIR ?? fileURLToPath(new URL("../.data/", import.meta.url));
const TIERS_PATH = join(DATA_DIR, "tiers.json");
const SETTINGS_PATH = join(DATA_DIR, "settings.json");

const MAX_ENTRIES = 1000; // bound the persisted lists (defends the write endpoint)

function normalize(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return [
    ...new Set(
      list
        .slice(0, MAX_ENTRIES)
        .map((s) => String(s).trim().toLowerCase().slice(0, 253))
        .filter(Boolean)
        .map((s) => s.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "")),
    ),
  ];
}

/** Load persisted tier config (`.data/tiers.json`), falling back to the built-in defaults. */
export async function loadTiers(): Promise<TierConfig> {
  try {
    const parsed: unknown = JSON.parse(await readFile(TIERS_PATH, "utf8"));
    if (parsed && typeof parsed === "object") {
      const p = parsed as { tier1?: unknown; tier3?: unknown };
      return { tier1: normalize(p.tier1), tier3: normalize(p.tier3) };
    }
  } catch {
    /* no/invalid file → defaults */
  }
  return { tier1: [...DEFAULT_TIERS.tier1], tier3: [...DEFAULT_TIERS.tier3] };
}

/** Delete the persisted tier config, reverting to built-in defaults. Returns the defaults. */
export async function resetTiers(): Promise<TierConfig> {
  try {
    await unlink(TIERS_PATH);
  } catch {
    /* file may not exist — fine */
  }
  return { tier1: [...DEFAULT_TIERS.tier1], tier3: [...DEFAULT_TIERS.tier3] };
}

/** Persist (and normalize) a tier config. Returns the cleaned config. */
export async function saveTiers(cfg: { tier1?: unknown; tier3?: unknown }): Promise<TierConfig> {
  const clean: TierConfig = { tier1: normalize(cfg.tier1), tier3: normalize(cfg.tier3) };
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(TIERS_PATH, JSON.stringify(clean, null, 2), "utf8");
  return clean;
}

// Persisted app settings (`.data/settings.json`) — the options page's home for non-tier config.
// R2 adds `model`; 0.7/0.8 add the per-page + rabbit-hole knobs; Epic B will add advanceMode here.
export interface BrickSettings {
  /** Adjudicator model id sent per-request (OpenRouter or Anthropic id). Unset → env/provider seed. */
  model?: string;
  /** Domains judged per-page rather than per-domain (0.7). Unset → defaults applied by the client. */
  pageScopeDomains?: string[];
  /** Domains that accrue a rabbit-hole time nudge (0.8). */
  rabbitHoleDomains?: string[];
  /** Minutes of active foreground time on a flagged domain before the first nudge (0.8). */
  rabbitHoleMinutes?: number;
}

const MAX_DOMAINS = 100;
function domainList(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = [
    ...new Set(
      v
        .slice(0, MAX_DOMAINS)
        .map((s) => String(s).trim().toLowerCase().slice(0, 253))
        .filter(Boolean)
        .map((s) => s.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "")),
    ),
  ];
  return out;
}

function sanitizeSettings(p: Record<string, unknown>): BrickSettings {
  const out: BrickSettings = {};
  // An empty/blank model is treated as "unset" (revert to the env/provider default seed).
  if (typeof p.model === "string" && p.model.trim()) out.model = p.model.trim().slice(0, 200);
  const page = domainList(p.pageScopeDomains);
  if (page) out.pageScopeDomains = page;
  const rabbit = domainList(p.rabbitHoleDomains);
  if (rabbit) out.rabbitHoleDomains = rabbit;
  if (typeof p.rabbitHoleMinutes === "number" && Number.isFinite(p.rabbitHoleMinutes)) {
    out.rabbitHoleMinutes = Math.min(600, Math.max(1, Math.round(p.rabbitHoleMinutes)));
  }
  return out;
}

/** Load persisted settings. Missing/invalid file → empty settings (never throws). */
export async function loadSettings(): Promise<BrickSettings> {
  try {
    const parsed: unknown = JSON.parse(await readFile(SETTINGS_PATH, "utf8"));
    if (parsed && typeof parsed === "object") return sanitizeSettings(parsed as Record<string, unknown>);
  } catch {
    /* no/invalid file → empty settings */
  }
  return {};
}

/** Merge a partial patch into persisted settings and return the merged, sanitized result. */
export async function saveSettings(patch: Partial<BrickSettings>): Promise<BrickSettings> {
  const current = await loadSettings();
  const merged = sanitizeSettings({ ...current, ...patch } as Record<string, unknown>);
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(SETTINGS_PATH, JSON.stringify(merged, null, 2), "utf8");
  return merged;
}
