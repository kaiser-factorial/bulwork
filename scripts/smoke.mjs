// Service smoke test: unit-tests the pure precedence resolver, then spawns dist/server.js on a test
// port, exercises the endpoints, asserts. Run: npm run smoke  (requires a built dist/).
//
// Hermetic + key-free by design: the server runs against a throwaway BRICK_DATA_DIR (fresh default
// tiers, empty learned store) and every check drives the focus with an explicit `task` — so the
// suite needs neither a reachable ledger binary nor an API key (tier-2 falls to the stub path, and
// learned/tier short-circuits never call a model).
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  decisionsToCases,
  domainUnit,
  findLearned,
  focusKeyOf,
  resolvePrecedence,
} from "../dist/decisions-store.js";
import { loadCorpus, retrieveChunks } from "../dist/help.js";
import { expandTemplate, liftPlanToTemplate } from "../dist/template-store.js";

const PORT = process.env.SMOKE_PORT ?? "7399";
const BASE = `http://127.0.0.1:${PORT}`;
const TASK = "ship the ledger release"; // explicit focus → no ledger binary needed

// The service requires X-Brick-Client (CSRF defense); local callers set it explicitly.
const H = { "content-type": "application/json", "x-brick-client": "smoke" };
const post = (path, body) =>
  fetch(BASE + path, { method: "POST", headers: H, body: JSON.stringify(body ?? {}) }).then((r) =>
    r.json(),
  );
const get = (path) => fetch(BASE + path, { headers: H }).then((r) => r.json());

let failed = 0;
const check = (name, cond) => {
  console.log(`${cond ? "✓" : "✗"} ${name}`);
  if (!cond) failed += 1;
};

// ---------- unit: pure precedence resolver (Epic 0.2) — no server, no key ----------
// Order (top wins): Tier-1 block > learned block > learned allow > Tier-3 allow > model.
const lAllow = { focusKey: "k", scope: "domain", unit: "x.com", decision: "allow", via: "clarify", at: "" };
const lBlock = { focusKey: "k", scope: "domain", unit: "x.com", decision: "block", via: "correction", at: "" };
check("precedence: tier1 beats learned allow", resolvePrecedence("tier1", lAllow)?.decision === "block");
check("precedence: tier1 alone blocks", resolvePrecedence("tier1", null)?.via === "tier1");
check("precedence: learned block beats model (tier2)", resolvePrecedence("tier2", lBlock)?.decision === "block");
check("precedence: learned block beats tier3 allow", resolvePrecedence("tier3", lBlock)?.decision === "block");
check("precedence: learned allow beats model (tier2)", resolvePrecedence("tier2", lAllow)?.decision === "allow");
check("precedence: tier3 alone allows", resolvePrecedence("tier3", null)?.via === "tier3");
check("precedence: tier2 + nothing learned → model", resolvePrecedence("tier2", null) === null);

// findLearned: domain match by focusKey, and page-scope wins when a unit is supplied.
const list = [
  { focusKey: "proj_1", scope: "domain", unit: "nytimes.com", decision: "allow", via: "clarify", at: "" },
  { focusKey: "proj_1", scope: "page", unit: "vid123", decision: "block", via: "clarify", at: "" },
];
check("findLearned: domain hit", findLearned(list, "proj_1", "https://www.nytimes.com/x")?.decision === "allow");
check("findLearned: wrong focusKey misses", findLearned(list, "proj_9", "https://nytimes.com") === null);
check("findLearned: page-scope preferred over domain", findLearned(list, "proj_1", "https://nytimes.com", "vid123")?.scope === "page");
// 0.7: a page-scope block on one video must not leak to other videos (falls back to the domain entry).
check("findLearned: page block doesn't leak to other videos", findLearned(list, "proj_1", "https://nytimes.com", "OTHERVID")?.decision === "allow");
check("focusKeyOf: projectId wins over task", focusKeyOf({ task: "x", source: "explicit", projectId: "p9" }) === "p9");
check("domainUnit: strips www", domainUnit("https://www.example.com/a?b=1") === "example.com");

// 0.6: corrections/clarifies → eval cases (uses sampleUrl; page entries without a URL are dropped).
const cases06 = decisionsToCases([
  { focusKey: "proj", scope: "domain", unit: "nytimes.com", decision: "block", via: "correction", at: "", sampleUrl: "https://nytimes.com/x" },
  { focusKey: "proj", scope: "page", unit: "vid1", decision: "allow", via: "clarify", at: "" },
]);
check("0.6 decisionsToCases maps a correction to a scored case", cases06.length === 1 && cases06[0].task === "proj" && cases06[0].expected === "block" && cases06[0].url === "https://nytimes.com/x");

// ---------- unit: help corpus + retrieval (Epic H1/H2) — key-free ----------
const corpus = await loadCorpus();
check("help corpus loads (≥20 chunks across ≥5 docs)",
  corpus.length >= 20 && new Set(corpus.map((c) => c.doc)).size >= 5);
// H1 AC: each supported how-to question maps to a relevant corpus chunk.
const QMAP = [
  ["How do I add a Tier-1 site?", "blocking-and-tiers.md"],
  ["How do I change the adjudicator model?", "model-and-provider.md"],
  ["What does the remember checkbox on the clarify card do?", "gatekeeper.md"],
  ["Why is there a pause symbol on the badge?", null], // grace pause — sessions or getting-started
  ["How do I turn on sound cues?", "sessions-and-feedback.md"],
  ["Where does BRICK store its data?", "service-and-troubleshooting.md"],
  ["How does the rabbit hole nudge work?", "gatekeeper.md"],
];
for (const [q, doc] of QMAP) {
  const hits = retrieveChunks(q, corpus);
  const ok = hits.length > 0 && (doc === null || hits.some((h) => h.doc === doc));
  check(`retrieval: "${q}" → ${doc ?? "any"}`, ok);
}

// ---------- unit: template expansion (Epic T2) — pure, key-free ----------
const ALT = {
  id: "tpl_alt",
  name: "alternating deep work",
  slots: [
    { key: "A", label: "first project" },
    { key: "B", label: "second project" },
  ],
  blocks: [
    { focusRef: { slot: "A" }, budgetMinutes: 120, swapMode: "time" },
    { focusRef: { slot: "B" }, budgetMinutes: 120, swapMode: "time" },
  ],
  pattern: { repeat: "until-end-of-day" },
  createdAt: "",
};
// At 09:00 there are 900 minutes to midnight → floor(900/240) = 3 full A,B patterns.
const nineAM = new Date();
nineAM.setHours(9, 0, 0, 0);
const exp = expandTemplate(ALT, { A: { task: "proj X" }, B: { task: "proj Y" } }, nineAM);
check("until-end-of-day at 09:00 → 3 patterns (6 blocks)", exp.length === 6);
check(
  "expansion alternates A,B,A,B with bindings applied",
  exp[0].focusRef.task === "proj X" && exp[1].focusRef.task === "proj Y" && exp[2].focusRef.task === "proj X",
);
check("swapMode carries through expansion", exp.every((b) => b.swapMode === "time"));
let unboundThrew = false;
try {
  expandTemplate(ALT, { A: { task: "only A" } }, nineAM);
} catch {
  unboundThrew = true;
}
check("unbound slot throws a clear error", unboundThrew);
const NUM = { ...ALT, pattern: { repeat: 2 } };
check("numeric repeat: 2 → 4 blocks", expandTemplate(NUM, { A: { task: "x" }, B: { task: "y" } }).length === 4);
const defaulted = expandTemplate(
  { ...NUM, pattern: undefined, slots: [{ key: "A", label: "a", defaultProjectId: "proj_9" }, { key: "B", label: "b" }] },
  { B: { task: "y" } },
);
check("slot defaultProjectId fills a missing binding", defaulted[0].focusRef.projectId === "proj_9");

// liftPlanToTemplate: parameterize lifts distinct projects into slots; tasks stay pre-bound.
const lifted = liftPlanToTemplate(
  {
    id: "p",
    createdAt: "",
    blocks: [
      { id: "b1", focus: { task: "na1", source: "next-action", projectId: "p1", projectName: "One" }, status: "done", budgetMinutes: 60, steps: [{ id: "s", label: "draft", done: true }] },
      { id: "b2", focus: { task: "free typed", source: "explicit" }, status: "active" },
      { id: "b3", focus: { task: "na1 again", source: "next-action", projectId: "p1", projectName: "One" }, status: "pending" },
      { id: "b2~1", focus: { task: "clone", source: "explicit" }, status: "pending" },
    ],
  },
  "my day",
  true,
);
check(
  "liftPlanToTemplate parameterizes projects into one slot + keeps tasks + drops clones",
  lifted.slots?.length === 1 &&
    lifted.blocks.length === 3 &&
    "slot" in lifted.blocks[0].focusRef &&
    "task" in lifted.blocks[1].focusRef &&
    lifted.blocks[0].steps?.[0] === "draft",
);

// ---------- integration: the running service ----------
let dataDir;
let srv;
try {
  dataDir = await mkdtemp(join(tmpdir(), "brick-smoke-"));
  srv = spawn("node", ["dist/server.js"], {
    // Blank both provider keys so the run is genuinely key-free (tier-2 takes the stub path and no
    // check ever calls a model) even on a machine whose .env/environment has real keys. An
    // empty-string var also blocks process.loadEnvFile from re-populating it (no override).
    env: {
      ...process.env,
      BRICK_PORT: PORT,
      BRICK_DATA_DIR: dataDir,
      ANTHROPIC_API_KEY: "",
      OPENROUTER_API_KEY: "",
    },
    stdio: "ignore",
  });

  for (let i = 0; i < 25; i += 1) {
    try {
      await fetch(BASE + "/health");
      break;
    } catch {
      await sleep(150);
    }
  }

  // Auth gate: a request without the header is rejected.
  const noauth = await fetch(BASE + "/health");
  check("rejects missing X-Brick-Client", noauth.status === 403);

  const health = await get("/health");
  check("health ok", health.ok === true);
  check("health reports a provider", health.provider === "openrouter" || health.provider === "anthropic");

  // Tier classification (fresh default tiers from the temp data dir).
  const t1 = await post("/adjudicate", { url: "https://reddit.com/r/all", task: TASK });
  check("tier1 blocks", t1.tier === "tier1" && t1.decision === "block");

  const t3 = await post("/adjudicate", { url: "https://github.com/x", task: TASK });
  check("tier3 allows", t3.tier === "tier3" && t3.decision === "allow");

  const t2 = await post("/adjudicate", { url: "https://nytimes.com", task: TASK });
  check("tier2 resolves", t2.tier === "tier2" && typeof t2.confidence === "number");

  // Learned-decision store (Epic 0.2): learn → short-circuit → precedence → clear.
  await post("/decisions/learn", { url: "https://nytimes.com", task: TASK, decision: "allow", via: "clarify" });
  const t2learned = await post("/adjudicate", { url: "https://nytimes.com/section/world", task: TASK });
  check("learned allow short-circuits (via learned, no stub)", t2learned.decision === "allow" && t2learned.via === "learned" && t2learned.stub !== true);

  // Precedence: a Tier-1 site stays blocked even after a learned allow.
  await post("/decisions/learn", { url: "https://reddit.com", task: TASK, decision: "allow", via: "clarify" });
  const t1still = await post("/adjudicate", { url: "https://reddit.com/r/all", task: TASK });
  check("tier1 beats a learned allow", t1still.decision === "block" && t1still.via === "tier1");

  // A learned block (correction) beats a Tier-3 always-allow.
  await post("/decisions/learn", { url: "https://github.com", task: TASK, decision: "block", via: "correction" });
  const t3blocked = await post("/adjudicate", { url: "https://github.com/x", task: TASK });
  check("learned block beats tier3 allow", t3blocked.decision === "block" && t3blocked.via === "learned");

  const cfgCounts = (await get("/config")).decisions;
  check(
    "gatekeeper readout counts clarify + corrections",
    cfgCounts.correction === 1 && cfgCounts.clarify === 2 && cfgCounts.total === 3,
  );

  // Clear resets the store — the learned nytimes allow no longer short-circuits.
  const cleared = await post("/decisions/clear");
  check("clear empties the store", cleared.counts.total === 0);
  const afterClear = await post("/adjudicate", { url: "https://nytimes.com/section/world", task: TASK });
  check("cleared: nytimes no longer learned", afterClear.via !== "learned");

  // Configurable model (Epic R2): set → reflected in /config + /adjudicate → clear reverts to seed.
  const seed = (await get("/config")).seedModel;
  const setRes = await post("/config/settings", { model: "test/model-x" });
  check("settings save returns the model", setRes.model === "test/model-x");
  check("GET /config reflects the model", (await get("/config")).model === "test/model-x");
  const t1model = await post("/adjudicate", { url: "https://reddit.com/r/all", task: TASK });
  check("adjudicate response surfaces the model", t1model.model === "test/model-x");
  const clearedModel = await post("/config/settings", { model: "" });
  check("clearing the model reverts to the seed", clearedModel.model === seed);

  // Focus-tuning settings (0.7/0.8) persist + merge (model stays cleared).
  const tune = await post("/config/settings", { pageScopeDomains: ["youtube.com", "vimeo.com"], rabbitHoleMinutes: 2 });
  check(
    "focus-tuning settings persist",
    tune.settings.pageScopeDomains.includes("vimeo.com") && tune.settings.rabbitHoleMinutes === 2,
  );
  check("GET /config reflects focus tuning", (await get("/config")).settings.pageScopeDomains.includes("vimeo.com"));

  // 0.7: a page-scope learned allow short-circuits for its video (unit) with no model call.
  await post("/decisions/learn", { task: TASK, url: "https://youtube.com/watch?v=abc", decision: "allow", via: "clarify", scope: "page", unit: "abc" });
  const pv = await post("/adjudicate", { url: "https://youtube.com/watch?v=abc", task: TASK, unit: "abc" });
  check("page-scope learned allow short-circuits its video", pv.via === "learned" && pv.decision === "allow");
  await post("/decisions/clear");

  // /help without a key → clean 503 with a helpful error (never a crash or invented answer).
  const helpRes = await fetch(BASE + "/help", {
    method: "POST",
    headers: H,
    body: JSON.stringify({ question: "How do I add a Tier-1 site?" }),
  });
  const helpBody = await helpRes.json();
  check("key-free /help degrades cleanly (503 + error)", helpRes.status === 503 && typeof helpBody.error === "string");

  // Session lifecycle (explicit focus — no ledger needed).
  const start = await post("/session/start", { task: TASK });
  check("session starts", Boolean(start.session && start.session.id));

  // Refocus (Epic 0.3 "make focus more specific") updates the active session's focus.
  const refocused = await post("/session/refocus", { task: "tighten: p-values in the ADHD dataset" });
  check(
    "refocus updates the session focus",
    Boolean(refocused.session) &&
      refocused.session.focus.task.startsWith("tighten") &&
      refocused.session.focus.source === "explicit",
  );

  const prep = await post("/prepend", {});
  check("prepend uses session focus", typeof prep.header === "string" && prep.header.includes("BRICK MODE"));

  await post("/session/stop", {});
  const after = await get("/session");
  check("session stops", after.session === null);

  // ---------- Epic A: plan queue lifecycle (key-free — explicit tasks, no ledger) ----------
  const planStart = await post("/plan/start", {
    label: "smoke day",
    workMinutes: 25,
    breakMinutes: 5,
    blocks: [
      { task: "block one: write the intro", budgetMinutes: 1, steps: ["outline", "draft"] },
      { task: "block two: lab check", budgetMinutes: 1, repeat: { maxPerDay: 2 } },
      { task: "block three: review PRs", budgetMinutes: 1 },
    ],
  });
  const p0 = planStart.plan;
  check("plan starts with 3 blocks, first active", p0.blocks.length === 3 && p0.blocks[0].status === "active" && p0.activeBlockId === p0.blocks[0].id);
  check("plan start opened a session anchored to block 1", (await get("/session")).session?.focus.task.startsWith("block one"));
  check("plan view reports advisory budget", p0.active?.budgetMinutes === 1 && typeof p0.active?.elapsedMinutes === "number");
  const v0 = p0.stateVersion;

  // Safety property: a per-call task can't hijack adjudication while a plan anchors the focus.
  const hijack = await post("/adjudicate", { url: "https://nytimes.com", task: "totally different thing" });
  check("per-call task can't override the active block's focus", hijack.focusKey === "block one: write the intro");

  // Step toggle persists and bumps stateVersion.
  const stepId = p0.blocks[0].steps[0].id;
  const afterStep = await post("/plan/block/step", { stepId });
  check("step toggles + stateVersion bumps", afterStep.plan.blocks[0].steps[0].done === true && afterStep.plan.stateVersion > v0);
  check("step persists on re-read", (await get("/plan")).plan.blocks[0].steps[0].done === true);

  // Advance 1 → 2; session re-anchors.
  const adv1 = await post("/plan/block/advance", {});
  check("advance moves to block 2 + records actualMinutes", adv1.plan.activeBlockId === adv1.plan.blocks[1].id && typeof adv1.plan.blocks[0].actualMinutes === "number");
  check("session re-anchored to block 2", (await get("/session")).session?.focus.task.startsWith("block two"));

  // Advance the repeating block → it re-enqueues exactly once (then respects maxPerDay=2).
  const adv2 = await post("/plan/block/advance", {});
  const tail = adv2.plan.blocks[adv2.plan.blocks.length - 1];
  check("repeat block re-enqueued at the tail", adv2.plan.blocks.length === 4 && tail.focus.task.startsWith("block two") && tail.status === "pending");
  check("now active: block three", adv2.plan.activeBlockId === adv2.plan.blocks[2].id);

  // Reorder: move the requeued copy ahead — settled blocks keep position.
  const re = await post("/plan/reorder", { order: [tail.id] });
  check("reorder keeps settled blocks + moves pending", re.plan.blocks[3].id === tail.id && re.plan.blocks[2].status === "active");

  // Advance to the requeued copy, then advance it — maxPerDay=2 already reached → no new copy.
  await post("/plan/block/advance", {});
  const adv4 = await post("/plan/block/advance", {});
  check("maxPerDay caps the requeue (no third copy)", adv4.plan === null || adv4.plan.blocks.filter((b) => b.focus.task.startsWith("block two")).length === 2);
  check("advancing the last block ends the plan", (await get("/plan")).plan === null);
  check("plan end also ended the session", (await get("/session")).session === null);

  // Regression: single-focus session still works when no plan is active.
  const solo = await post("/session/start", { task: TASK });
  check("single session works after a plan", Boolean(solo.session?.id));
  await post("/session/stop", {});

  // Explicit end: start a fresh 2-block plan and end it outright.
  await post("/plan/start", { blocks: [{ task: "x1" }, { task: "x2" }] });
  const ended = await post("/plan/end", {});
  check("/plan/end skips remaining blocks + clears plan", ended.plan.activeBlockId === undefined && (await get("/plan")).plan === null);

  // ---------- Epic T: templates (save → launch → save-current → delete), key-free ----------
  const tplSave = await post("/templates", {
    template: {
      name: "alternating deep work",
      slots: [
        { key: "A", label: "first" },
        { key: "B", label: "second" },
      ],
      blocks: [
        { focusRef: { slot: "A" }, budgetMinutes: 60 },
        { focusRef: { slot: "B" }, budgetMinutes: 60 },
      ],
      pattern: { repeat: 2 },
    },
  });
  check("template saves with an id", typeof tplSave.template?.id === "string");
  check("GET /templates lists it", (await get("/templates")).templates.some((t) => t.id === tplSave.template.id));

  // Launch with task bindings → A,B,A,B.
  const fromTpl = await post("/plan/from-template", {
    templateId: tplSave.template.id,
    bindings: { A: { task: "proj alpha work" }, B: { task: "proj beta work" } },
  });
  const seq = fromTpl.plan.blocks.map((b) => b.focus.task[5]); // "alpha"/"beta" discriminator
  check("from-template expands to A,B,A,B", fromTpl.plan.blocks.length === 4 && seq.join("") === "abab");
  check("template launch anchored a session", (await get("/session")).session?.focus.task.includes("alpha"));

  // Save the running plan as a template (tasks stay pre-bound) and relaunch it — parity.
  const savedCur = await post("/templates", { fromCurrent: { name: "today snapshot" } });
  check("save-current produces a zero-slot template", savedCur.template?.blocks.length === 4 && !savedCur.template.slots);
  await post("/plan/end", {});
  const relaunch = await post("/plan/from-template", { templateId: savedCur.template.id });
  check("zero-slot template relaunches as-is (parity)", relaunch.plan.blocks.length === 4 && relaunch.plan.blocks[0].focus.task.includes("alpha"));
  await post("/plan/end", {});

  // Missing binding → clear 500-with-error, not a crash; delete removes.
  const bad = await fetch(BASE + "/plan/from-template", { method: "POST", headers: H, body: JSON.stringify({ templateId: tplSave.template.id }) });
  check("unbound launch fails with a clear error", !(await bad.json()).plan && bad.status >= 400);
  const del = await fetch(BASE + "/templates/" + tplSave.template.id, { method: "DELETE", headers: H });
  check("DELETE /templates/:id removes it", (await del.json()).ok === true && !(await get("/templates")).templates.some((t) => t.id === tplSave.template.id));
} finally {
  if (srv) srv.kill();
  if (dataDir) await rm(dataDir, { recursive: true, force: true }).catch(() => {});
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
