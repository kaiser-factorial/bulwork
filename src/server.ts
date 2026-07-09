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
  derivePageUnit,
  domainUnit,
  findLearned,
  focusKeyOf,
  learnDecision,
  loadDecisions,
  resolvePrecedence,
} from "./decisions-store.js";
import { answerHelp } from "./help.js";
import {
  advanceBlock,
  completeBlock,
  editPlan,
  endPlan,
  planView,
  restorePlan,
  startPlan,
  toggleStep,
  undoAdvance,
} from "./plan-runtime.js";
import type { StartBlockInput } from "./plan-runtime.js";
import { LocalTemplateStore, expandTemplate, liftPlanToTemplate } from "./template-store.js";
import type { SlotBinding } from "./template-store.js";
import { getPlan } from "./plan-runtime.js";
import type { ChatTurn } from "./providers/index.js";
import type { FocusRef, GitPredicate, StopCondition, WorkflowTemplate } from "./types.js";

/** Light validation of user-posted stop conditions (Epic B): keep only recognizable shapes; the
 *  runtime forces `met:false` and the evaluators fail open on anything broken at runtime. */
function parseStopConditions(v: unknown): StopCondition[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: StopCondition[] = [];
  for (const raw of v.slice(0, 8)) {
    if (!raw || typeof raw !== "object") continue;
    const c = raw as Record<string, unknown>;
    if (c.type === "git" && typeof c.repoPath === "string" && c.predicate && typeof c.predicate === "object") {
      const p = c.predicate as Record<string, unknown>;
      let predicate: GitPredicate | null = null;
      if (p.kind === "head-advanced") predicate = { kind: "head-advanced", ref: typeof p.ref === "string" ? p.ref : undefined };
      else if (p.kind === "merge-commit" && typeof p.intoRef === "string") predicate = { kind: "merge-commit", intoRef: p.intoRef };
      else if (p.kind === "message-match" && typeof p.regex === "string") predicate = { kind: "message-match", regex: p.regex };
      if (predicate) out.push({ type: "git", repoPath: c.repoPath, predicate, met: false });
    } else if (c.type === "ledger" && typeof c.projectId === "string") {
      out.push({ type: "ledger", projectId: c.projectId, on: "next-action-change", from: typeof c.from === "string" ? c.from : undefined, met: false });
    } else if (c.type === "command" && typeof c.cmd === "string") {
      out.push({ type: "command", cmd: c.cmd, cwd: typeof c.cwd === "string" ? c.cwd : undefined, expectExit: typeof c.expectExit === "number" ? c.expectExit : undefined, met: false });
    } else if (c.type === "manual") {
      out.push({ type: "manual", met: false });
    }
  }
  return out.length ? out : undefined;
}
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
// Review fix: the most recent adjudicator fail-open, so an outage is observable on /health instead
// of looking identical to the model genuinely allowing every page.
let lastProviderError: { at: string; reason: string } | null = null;

// Tier config: persisted (.data/tiers.json), editable via the options page / POST /config/tiers.
let tiers = await loadTiers();
// Learned-decision store (Epic 0.2): kept in memory so a hit short-circuits the model at ~0 latency.
let decisions = await loadDecisions();
// App settings (R2): the configurable adjudicator model lives here (.data/settings.json).
let settings = await loadSettings();
// Plan layer (Epic A): re-hydrate a persisted mid-flight plan so the queue survives restarts.
await restorePlan();
// Workflow templates (Epic T): CRUD store, local JSON now / Ledger-native later.
const templates = new LocalTemplateStore();

/** Resolve a fully-bound FocusRef to a FocusTask (explicit task, or Ledger project lookup). */
async function focusFromRef(ref: FocusRef): Promise<FocusTask> {
  if ("task" in ref) return { task: ref.task, source: "explicit" };
  if ("projectId" in ref) return resolveFocusTask({ projectId: ref.projectId });
  throw new Error(`slot "${ref.slot}" was not bound`);
}
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
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
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

  // Parameterized route: DELETE /templates/:id (the only non-static path).
  if (req.method === "DELETE" && url.pathname.startsWith("/templates/")) {
    const id = decodeURIComponent(url.pathname.slice("/templates/".length));
    const removed = await templates.remove(id);
    return removed
      ? sendJson(res, 200, { ok: true })
      : sendJson(res, 404, { error: `no template: ${id}` });
  }

  switch (route) {
    case "GET /health":
      return sendJson(res, 200, {
        ok: true,
        provider: PROVIDER,
        model: effectiveModel(),
        hasApiKey: hasApiKey(),
        grounding: groundingEnabled(),
        lastProviderError,
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
        lastProviderError,
      });

    case "POST /config/settings": {
      const body = await readJson(req);
      const patch: BrickSettings = {};
      // Accept a model override; a blank string clears it (revert to the seed).
      if (typeof body.model === "string") patch.model = body.model;
      if (Array.isArray(body.pageScopeDomains)) patch.pageScopeDomains = body.pageScopeDomains as string[];
      if (Array.isArray(body.rabbitHoleDomains)) patch.rabbitHoleDomains = body.rabbitHoleDomains as string[];
      if (typeof body.rabbitHoleMinutes === "number") patch.rabbitHoleMinutes = body.rabbitHoleMinutes;
      if (body.advanceMode === "auto" || body.advanceMode === "manual") patch.advanceMode = body.advanceMode;
      if (typeof body.undoWindowSec === "number") patch.undoWindowSec = body.undoWindowSec;
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
      // DERIVED SERVER-SIDE when the caller didn't send one (review fix): the background worker's
      // tab-activation re-check never computed it, so a page-scope allow was invisible to it.
      // Deriving it once here, from the target URL, makes every caller correct automatically.
      const pageUnit =
        str(body, "unit") ?? derivePageUnit(target, settings.pageScopeDomains ?? ["youtube.com", "youtu.be"]);
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
        providerError?: boolean;
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
        result = {
          decision: r.decision,
          reason: r.reason,
          confidence: r.confidence,
          stub: false,
          model: r.model,
          providerError: r.providerError,
        };
        // Review fix: a fail-open from a provider outage is NOT a judged verdict — track it so
        // /health can surface an outage instead of it looking like silent, permanent allow.
        if (r.providerError) lastProviderError = { at: new Date().toISOString(), reason: r.reason };
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
      const via = str(body, "via") === "correction" ? "correction" : "clarify";
      // Page-scope derives the unit server-side when the caller didn't send one (review fix: the
      // client's own video-id extraction misses some URL shapes, e.g. youtu.be — deriving it here,
      // the same way /adjudicate does, is the single source of truth instead of two copies
      // drifting). If page scope was requested but no unit can be derived (an unknown page-scoped
      // domain, or a stale client/server settings snapshot), downgrade to domain scope explicitly
      // rather than writing a scope:"page" entry keyed by a domain-shaped unit.
      const wantsPage = str(body, "scope") === "page";
      const explicitUnit = str(body, "unit");
      const derivedPageUnit =
        wantsPage && !explicitUnit && target
          ? derivePageUnit(target, settings.pageScopeDomains ?? ["youtube.com", "youtu.be"])
          : undefined;
      const scope = wantsPage && (explicitUnit || derivedPageUnit) ? "page" : "domain";
      const unit =
        scope === "page" ? explicitUnit ?? derivedPageUnit : target ? domainUnit(target) : undefined;
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

    case "GET /plan":
      // Current plan + advisory budget readout + monotonic stateVersion (null when no plan).
      return sendJson(res, 200, { plan: planView() });

    case "POST /plan/start": {
      const body = await readJson(req);
      const raw = Array.isArray(body.blocks) ? (body.blocks as Array<Record<string, unknown>>) : [];
      if (!raw.length) return sendJson(res, 400, { error: "blocks required (task or projectId each)" });
      const blocks: StartBlockInput[] = [];
      for (const b of raw) {
        const task = typeof b.task === "string" && b.task.trim() ? b.task.trim() : undefined;
        const projectId =
          typeof b.projectId === "string" && b.projectId.trim() ? b.projectId.trim() : undefined;
        if (!task && !projectId) return sendJson(res, 400, { error: "each block needs task or projectId" });
        const focus: FocusTask = projectId
          ? await resolveFocusTask({ projectId })
          : { task: task!, source: "explicit" };
        blocks.push({
          focus,
          budgetMinutes: typeof b.budgetMinutes === "number" ? b.budgetMinutes : undefined,
          steps: Array.isArray(b.steps) ? (b.steps as unknown[]).map(String).slice(0, 20) : undefined,
          stopConditions: parseStopConditions(b.stopConditions),
          advanceMode: b.advanceMode === "auto" || b.advanceMode === "manual" ? b.advanceMode : undefined,
          completionPolicy: b.completionPolicy === "all" ? "all" : b.completionPolicy === "any" ? "any" : undefined,
          repeat:
            b.repeat && typeof b.repeat === "object"
              ? {
                  mode: "requeue",
                  maxPerDay:
                    typeof (b.repeat as Record<string, unknown>).maxPerDay === "number"
                      ? ((b.repeat as Record<string, unknown>).maxPerDay as number)
                      : undefined,
                }
              : undefined,
          swapMode:
            b.swapMode === "condition" || b.swapMode === "time" || b.swapMode === "first" || b.swapMode === "both"
              ? b.swapMode
              : undefined,
        });
      }
      const plan = await startPlan({
        label: str(body, "label"),
        blocks,
        workMinutes: typeof body.workMinutes === "number" ? body.workMinutes : undefined,
        breakMinutes: typeof body.breakMinutes === "number" ? body.breakMinutes : undefined,
      });
      return sendJson(res, 200, { plan });
    }

    case "POST /plan/block/advance": {
      const body = await readJson(req);
      const how = str(body, "how") === "skipped" ? "skipped" : "done";
      return sendJson(res, 200, { plan: await advanceBlock(str(body, "blockId"), how) });
    }

    case "POST /plan/block/step": {
      const body = await readJson(req);
      const stepId = str(body, "stepId");
      if (!stepId) return sendJson(res, 400, { error: "stepId required" });
      return sendJson(res, 200, { plan: await toggleStep(str(body, "blockId"), stepId) });
    }

    case "POST /plan/block/complete": {
      const body = await readJson(req);
      return sendJson(res, 200, { plan: await completeBlock(str(body, "blockId")) });
    }

    case "POST /plan/reorder": {
      const body = await readJson(req);
      const insertRaw = body.insert as Record<string, unknown> | undefined;
      let insert: StartBlockInput | undefined;
      if (insertRaw && typeof insertRaw === "object") {
        const task = typeof insertRaw.task === "string" && insertRaw.task.trim() ? insertRaw.task.trim() : undefined;
        if (!task) return sendJson(res, 400, { error: "insert needs a task" });
        insert = {
          focus: { task, source: "explicit" },
          budgetMinutes: typeof insertRaw.budgetMinutes === "number" ? insertRaw.budgetMinutes : undefined,
          steps: Array.isArray(insertRaw.steps) ? (insertRaw.steps as unknown[]).map(String) : undefined,
          stopConditions: parseStopConditions(insertRaw.stopConditions),
          advanceMode: insertRaw.advanceMode === "auto" || insertRaw.advanceMode === "manual" ? insertRaw.advanceMode : undefined,
          completionPolicy: insertRaw.completionPolicy === "all" ? "all" : insertRaw.completionPolicy === "any" ? "any" : undefined,
        };
      }
      const plan = await editPlan({
        order: Array.isArray(body.order) ? (body.order as unknown[]).map(String) : undefined,
        drop: str(body, "drop"),
        budget:
          body.budget && typeof body.budget === "object"
            ? {
                blockId: String((body.budget as Record<string, unknown>).blockId ?? ""),
                budgetMinutes: Number((body.budget as Record<string, unknown>).budgetMinutes ?? 0),
              }
            : undefined,
        insert,
      });
      return sendJson(res, 200, { plan });
    }

    case "POST /plan/end":
      return sendJson(res, 200, { plan: await endPlan() });

    case "POST /plan/undo-advance":
      // Revert the last auto-advance within its undo window (Epic B3).
      return sendJson(res, 200, { plan: await undoAdvance() });

    case "GET /templates":
      return sendJson(res, 200, { templates: await templates.list() });

    case "POST /templates": {
      const body = await readJson(req);
      // Two creation modes: save the CURRENT plan as a template, or post a full template object.
      if (body.fromCurrent && typeof body.fromCurrent === "object") {
        const fc = body.fromCurrent as Record<string, unknown>;
        const plan = getPlan();
        if (!plan) return sendJson(res, 400, { error: "no active plan to save" });
        const name = typeof fc.name === "string" && fc.name.trim() ? fc.name.trim() : "saved plan";
        const tpl = liftPlanToTemplate(plan, name, Boolean(fc.parameterize));
        return sendJson(res, 200, { template: await templates.save(tpl) });
      }
      const t = body.template as Record<string, unknown> | undefined;
      if (!t || typeof t.name !== "string" || !Array.isArray(t.blocks) || !t.blocks.length) {
        return sendJson(res, 400, { error: "template needs a name and blocks (or use fromCurrent)" });
      }
      const tpl: WorkflowTemplate = {
        id: typeof t.id === "string" && t.id.trim() ? t.id.trim() : `tpl_${Date.now().toString(36)}`,
        name: t.name.trim(),
        slots: Array.isArray(t.slots) ? (t.slots as WorkflowTemplate["slots"]) : undefined,
        blocks: t.blocks as WorkflowTemplate["blocks"],
        pattern: t.pattern && typeof t.pattern === "object" ? (t.pattern as WorkflowTemplate["pattern"]) : undefined,
        createdAt: new Date().toISOString(),
      };
      return sendJson(res, 200, { template: await templates.save(tpl) });
    }

    case "POST /plan/from-template": {
      const body = await readJson(req);
      const templateId = str(body, "templateId");
      if (!templateId) return sendJson(res, 400, { error: "templateId required" });
      const tpl = await templates.get(templateId);
      if (!tpl) return sendJson(res, 404, { error: `no template: ${templateId}` });
      const bindings: Record<string, SlotBinding> = {};
      if (body.bindings && typeof body.bindings === "object") {
        for (const [k, v] of Object.entries(body.bindings as Record<string, unknown>)) {
          if (v && typeof v === "object" && typeof (v as Record<string, unknown>).projectId === "string") {
            bindings[k] = { projectId: (v as Record<string, unknown>).projectId as string };
          } else if (v && typeof v === "object" && typeof (v as Record<string, unknown>).task === "string") {
            bindings[k] = { task: (v as Record<string, unknown>).task as string };
          }
        }
      }
      const expanded = expandTemplate(tpl, bindings); // throws a clear error on unbound slots
      const blocks: StartBlockInput[] = [];
      for (const b of expanded) {
        blocks.push({
          focus: await focusFromRef(b.focusRef),
          budgetMinutes: b.budgetMinutes,
          steps: b.steps,
          repeat: b.repeat,
          swapMode: b.swapMode,
          stopConditions: b.stopConditions,
          advanceMode: b.advanceMode,
          completionPolicy: b.completionPolicy,
        });
      }
      const plan = await startPlan({
        label: str(body, "label") ?? tpl.name,
        blocks,
        workMinutes: typeof body.workMinutes === "number" ? body.workMinutes : undefined,
        breakMinutes: typeof body.breakMinutes === "number" ? body.breakMinutes : undefined,
      });
      return sendJson(res, 200, { plan });
    }

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
