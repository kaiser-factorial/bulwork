#!/usr/bin/env node
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fetchProjects, resolveFocusTask } from "./ledger.js";
import { adjudicate } from "./adjudicate.js";
import { buildPrependHeader, wrapMessage } from "./prepend.js";
import { classify } from "./tiers.js";
import { groundingEnabled } from "./grounding.js";
import { loadSettings, loadTiers, resetTiers, saveSettings, saveTiers } from "./config-store.js";
import type { BrickSettings } from "./config-store.js";
import { activeProviderName, providerHasKey, selectProvider } from "./providers/index.js";
import {
  clearDecisions,
  decisionCounts,
  domainUnit,
  findLearned,
  focusKeyOf,
  learnDecision,
  loadDecisions,
  resolvePrecedence,
} from "./decisions-store.js";
import { answerHelp } from "./help.js";
import type { ChatTurn } from "./providers/index.js";
import {
  endSession,
  getSession,
  recordAdjudication,
  refocusSession,
  setPhase,
  startSession,
} from "./session.js";
import type { FocusTask } from "./types.js";

try {
  process.loadEnvFile();
} catch {
  /* ambient env */
}

const PORT = Number(process.env.BRICK_PORT ?? "7373");
// The active provider (Epic R) determines the effective default model and which key gates tier-2.
const PROVIDER = activeProviderName();
// The seed model: BRICK_MODEL env, else the active provider's default. Persisted settings (R2) layer
// on top — a saved model wins, and clearing it reverts to this seed.
const SEED_MODEL = process.env.BRICK_MODEL ?? selectProvider().defaultModel;
const hasApiKey = (): boolean => providerHasKey();

// Tier config: persisted (.data/tiers.json), editable via the options page / POST /config/tiers.
let tiers = await loadTiers();
// Learned-decision store (Epic 0.2): kept in memory so a hit short-circuits the model at ~0 latency.
let decisions = await loadDecisions();
// App settings (R2): the configurable adjudicator model lives here (.data/settings.json).
let settings = await loadSettings();
const effectiveModel = (): string => settings.model?.trim() || SEED_MODEL;

type Body = Record<string, unknown>;

function readJson(req: IncomingMessage): Promise<Body> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data) as Body);
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

// SECURITY: a localhost service is reachable by any web page the user visits. Two defenses:
//  1. Only reflect Access-Control-Allow-Origin for the extension / localhost (never "*"), so a
//     random site can't read GET responses (e.g. exfiltrate the project list).
//  2. Require an X-Brick-Client header on every request. A cross-origin "simple" request can't set
//     custom headers; adding one forces a CORS preflight that only succeeds for allowed origins —
//     so a malicious page's request never reaches the handler. The extension/CLI set it explicitly.
function isAllowedOrigin(origin: string): boolean {
  if (!origin) return true; // non-browser clients (curl, the CLI) send no Origin
  if (origin.startsWith("chrome-extension://")) return true;
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

function applyCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin ?? "";
  if (origin && isAllowedOrigin(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Brick-Client");
}

function authorized(req: IncomingMessage): boolean {
  return Boolean(req.headers["x-brick-client"]);
}

// R2 model picker: the tool-call-capable OpenRouter catalog, fetched server-side (the key never
// leaves the service) and cached. Only models whose `supported_parameters` include "tools" are
// offered — the adjudicator depends on forced tool calls, so non-tool models would just fail open.
interface ModelChoice {
  id: string;
  name: string;
  prompt?: string; // per-token prompt price (USD, as OpenRouter reports it)
  completion?: string; // per-token completion price
  context?: number;
}
let modelCache: { at: number; models: ModelChoice[] } | null = null;
const MODEL_CACHE_MS = 60 * 60 * 1000; // 1h — the catalog changes slowly

async function listToolModels(): Promise<{ models: ModelChoice[]; error?: string }> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return { models: [], error: "no OPENROUTER_API_KEY (model dropdown is OpenRouter-only)" };
  if (modelCache && Date.now() - modelCache.at < MODEL_CACHE_MS) return { models: modelCache.models };
  try {
    const r = await fetch("https://openrouter.ai/api/v1/models", {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!r.ok) return { models: [], error: `openrouter models ${r.status}` };
    const d = (await r.json()) as { data?: Array<Record<string, unknown>> };
    const models: ModelChoice[] = (d.data ?? [])
      .filter(
        (m) =>
          Array.isArray(m.supported_parameters) &&
          (m.supported_parameters as unknown[]).includes("tools"),
      )
      .map((m) => {
        const pricing = (m.pricing ?? {}) as { prompt?: string; completion?: string };
        return {
          id: String(m.id),
          name: String(m.name ?? m.id),
          prompt: pricing.prompt,
          completion: pricing.completion,
          context: typeof m.context_length === "number" ? m.context_length : undefined,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    modelCache = { at: Date.now(), models };
    return { models };
  } catch (e) {
    return { models: [], error: e instanceof Error ? e.message : String(e) };
  }
}

/** Privacy: send only origin+path to the model, never query strings / fragments. */
function modelUrl(u: string): string {
  try {
    const x = new URL(u);
    return x.origin + x.pathname;
  } catch {
    return u;
  }
}

function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  res.setHeader("Content-Type", "application/json");
  res.statusCode = status;
  res.end(JSON.stringify(obj));
}

function str(body: Body, key: string): string | undefined {
  const v = body[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** Resolve the focus. During an active session the session's focus wins — a per-call `task` in the
 *  body can't hijack the adjudication target. Only outside a session do explicit fields apply. */
async function focusFor(body: Body): Promise<FocusTask> {
  const s = getSession();
  if (s) return s.focus;
  if (body.task || body.projectId || body.last) {
    return resolveFocusTask({
      explicit: str(body, "task"),
      projectId: str(body, "projectId"),
      last: Boolean(body.last),
    });
  }
  throw new Error("No active session and no focus given (pass task / projectId / last).");
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const route = `${req.method} ${url.pathname}`;

  applyCors(req, res);

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (!authorized(req)) {
    return sendJson(res, 403, { error: "missing X-Brick-Client header" });
  }

  switch (route) {
    case "GET /health":
      return sendJson(res, 200, {
        ok: true,
        provider: PROVIDER,
        model: effectiveModel(),
        hasApiKey: hasApiKey(),
        grounding: groundingEnabled(),
      });

    case "GET /config":
      return sendJson(res, 200, {
        tiers,
        provider: PROVIDER,
        model: effectiveModel(),
        seedModel: SEED_MODEL,
        settings,
        hasApiKey: hasApiKey(),
        grounding: groundingEnabled(),
        decisions: decisionCounts(decisions),
      });

    case "POST /config/settings": {
      const body = await readJson(req);
      const patch: BrickSettings = {};
      // Accept a model override; a blank string clears it (revert to the seed).
      if (typeof body.model === "string") patch.model = body.model;
      if (Array.isArray(body.pageScopeDomains)) patch.pageScopeDomains = body.pageScopeDomains as string[];
      if (Array.isArray(body.rabbitHoleDomains)) patch.rabbitHoleDomains = body.rabbitHoleDomains as string[];
      if (typeof body.rabbitHoleMinutes === "number") patch.rabbitHoleMinutes = body.rabbitHoleMinutes;
      settings = await saveSettings(patch);
      return sendJson(res, 200, { settings, model: effectiveModel() });
    }

    case "GET /models": {
      const listed = await listToolModels();
      return sendJson(res, 200, { ...listed, current: effectiveModel(), provider: PROVIDER });
    }

    case "POST /config/tiers": {
      const body = await readJson(req);
      tiers = await saveTiers({ tier1: body.tier1, tier3: body.tier3 });
      return sendJson(res, 200, { tiers });
    }

    case "POST /config/tiers/reset": {
      tiers = await resetTiers();
      return sendJson(res, 200, { tiers });
    }

    case "GET /projects":
      return sendJson(res, 200, { projects: await fetchProjects() });

    case "GET /session":
      return sendJson(res, 200, { session: getSession() });

    case "POST /session/start": {
      const body = await readJson(req);
      const focus = await focusFor(body);
      const session = await startSession({
        focus,
        workMinutes: typeof body.workMinutes === "number" ? body.workMinutes : undefined,
        breakMinutes: typeof body.breakMinutes === "number" ? body.breakMinutes : undefined,
      });
      return sendJson(res, 200, { session });
    }

    case "POST /session/phase": {
      const body = await readJson(req);
      const phase = str(body, "phase");
      if (phase !== "work" && phase !== "break" && phase !== "ended") {
        return sendJson(res, 400, { error: "phase must be work|break|ended" });
      }
      return sendJson(res, 200, { session: await setPhase(phase) });
    }

    case "POST /session/stop":
      return sendJson(res, 200, { session: await endSession() });

    case "POST /session/refocus": {
      const body = await readJson(req);
      const task = str(body, "task");
      if (!task) return sendJson(res, 400, { error: "task required" });
      return sendJson(res, 200, { session: await refocusSession(task) });
    }

    case "POST /adjudicate": {
      const body = await readJson(req);
      const target = str(body, "url");
      if (!target) return sendJson(res, 400, { error: "url required" });
      const focus = await focusFor(body);
      const tier = classify(target, tiers);
      const focusKey = focusKeyOf(focus);
      // A per-page unit (e.g. a YouTube video id) lets high-variance domains learn per page (0.7).
      const pageUnit = str(body, "unit");
      const learned = findLearned(decisions, focusKey, target, pageUnit);
      // Precedence: Tier-1 block > learned block > learned allow > Tier-3 allow > model (0.2).
      const pre = resolvePrecedence(tier, learned);

      let result: {
        decision: string;
        reason: string;
        confidence: number;
        stub: boolean;
        via?: string;
        learned?: boolean;
        model?: string;
      };
      if (pre) {
        result = {
          decision: pre.decision,
          reason: pre.reason,
          confidence: pre.confidence,
          stub: false,
          via: pre.via,
          learned: pre.via === "learned",
        };
      } else if (!hasApiKey()) {
        // PLACEHOLDER: no provider key → don't block, but mark as a stub so the UI can show it.
        result = {
          decision: "allow",
          reason: "(stub — no provider API key; tier-2 not adjudicated)",
          confidence: 0,
          stub: true,
        };
      } else {
        const r = await adjudicate({
          focus,
          url: modelUrl(target),
          title: str(body, "title"),
          model: effectiveModel(),
        });
        result = { decision: r.decision, reason: r.reason, confidence: r.confidence, stub: false, model: r.model };
      }

      await recordAdjudication(target, result.decision, tier);
      return sendJson(res, 200, { ...result, model: result.model ?? effectiveModel(), tier, url: target, focus, focusKey });
    }

    case "POST /decisions/learn": {
      const body = await readJson(req);
      const decision = str(body, "decision");
      if (decision !== "allow" && decision !== "block") {
        return sendJson(res, 400, { error: "decision must be allow|block" });
      }
      const target = str(body, "url");
      const scope = str(body, "scope") === "page" ? "page" : "domain";
      const via = str(body, "via") === "correction" ? "correction" : "clarify";
      // Page-scope needs an explicit unit (e.g. video id); domain-scope derives it from the URL.
      const unit = str(body, "unit") ?? (target ? domainUnit(target) : undefined);
      if (!unit) return sendJson(res, 400, { error: "url or unit required" });
      const focus = await focusFor(body);
      const record = await learnDecision({
        focusKey: focusKeyOf(focus),
        scope,
        unit,
        decision,
        via,
        sampleUrl: target,
      });
      decisions = await loadDecisions();
      return sendJson(res, 200, { learned: record, counts: decisionCounts(decisions) });
    }

    case "POST /decisions/clear": {
      await clearDecisions();
      decisions = await loadDecisions();
      return sendJson(res, 200, { ok: true, counts: decisionCounts(decisions) });
    }

    case "GET /decisions":
      return sendJson(res, 200, { decisions, counts: decisionCounts(decisions) });

    case "POST /help": {
      // Grounded usage Q&A (Epic H): answers only from the help/ corpus (+ read-only state tools).
      const body = await readJson(req);
      const question = str(body, "question");
      if (!question) return sendJson(res, 400, { error: "question required" });
      if (!hasApiKey()) {
        return sendJson(res, 503, {
          error: `no ${PROVIDER} API key — the help assistant needs the same key as adjudication`,
        });
      }
      // Sanitize the optional short history the panel sends.
      const history: ChatTurn[] = Array.isArray(body.history)
        ? (body.history as Array<Record<string, unknown>>)
            .filter(
              (h) =>
                h &&
                (h.role === "user" || h.role === "assistant") &&
                typeof h.content === "string" &&
                h.content.trim(),
            )
            .slice(-6)
            .map((h) => ({ role: h.role as "user" | "assistant", content: String(h.content).slice(0, 2000) }))
        : [];
      const result = await answerHelp(question.slice(0, 2000), history);
      return sendJson(res, 200, result);
    }

    case "POST /prepend": {
      const body = await readJson(req);
      const focus = await focusFor(body);
      const style = body.strict ? "strict" : "nudge";
      const message = str(body, "message");
      const header = buildPrependHeader(focus, { style });
      return sendJson(res, 200, {
        header,
        wrapped: message ? wrapMessage(message, focus, { style }) : undefined,
        focus,
      });
    }

    default:
      return sendJson(res, 404, { error: `no route: ${route}` });
  }
}

createServer((req, res) => {
  handle(req, res).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    sendJson(res, 500, { error: msg });
  });
}).listen(PORT, "127.0.0.1", () => {
  process.stdout.write(
    `brick service on http://127.0.0.1:${PORT}  (provider: ${PROVIDER}, model: ${effectiveModel()}, key: ${hasApiKey() ? "set" : "MISSING — tier-2 stubbed"})\n`,
  );
});
