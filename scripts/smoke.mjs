// Service smoke test: unit-tests the pure precedence resolver, then spawns dist/server.js on a test
// port, exercises the endpoints, asserts. Run: npm run smoke  (requires a built dist/).
//
// Hermetic + key-free by design: the server runs against a throwaway BRICK_DATA_DIR (fresh default
// tiers, empty learned store) and every check drives the focus with an explicit `task` — so the
// suite needs neither a reachable ledger binary nor an API key (tier-2 falls to the stub path, and
// learned/tier short-circuits never call a model).
import { FAKE_LEDGER, setLedgerProjects } from "./smoke-env.mjs"; // MUST be first (sets LEDGER_BIN)
import { execFileSync, spawn } from "node:child_process";
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
import { conditionsSatisfied, decideSwap, deriveSwapMode } from "../dist/plan-runtime.js";
import { resolveModelForProvider } from "../dist/providers/index.js";
import { makeEvaluator } from "../dist/watchers.js";

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

// ---------- unit: swap-policy combinator (Epic B2, §12 truth table) — pure ----------
{
  // combos are (conditionMet, timeUp): FF, FT, TF, TT
  const TABLE = {
    condition: [false, false, true, true],
    time: [false, true, false, true],
    first: [false, true, true, true],
    both: [false, false, false, true],
  };
  let ok = true;
  for (const [mode, exp] of Object.entries(TABLE)) {
    const got = [
      decideSwap(mode, false, false),
      decideSwap(mode, false, true),
      decideSwap(mode, true, false),
      decideSwap(mode, true, true),
    ];
    if (got.join() !== exp.join()) ok = false;
  }
  check("decideSwap matches the §12 truth table (4 modes × 4 combos)", ok);
  check(
    "deriveSwapMode defaults: both→first, budget→time, conds→condition",
    deriveSwapMode({ budgetMinutes: 60, stopConditions: [{ type: "manual", met: false }] }) === "first" &&
      deriveSwapMode({ budgetMinutes: 60 }) === "time" &&
      deriveSwapMode({ stopConditions: [{ type: "manual", met: false }] }) === "condition",
  );
  check(
    "conditionsSatisfied: neither→never, steps gate, any/all policies",
    conditionsSatisfied({}) === false &&
      conditionsSatisfied({ steps: [{ id: "s", label: "x", done: true }] }) === true &&
      conditionsSatisfied({ stopConditions: [{ type: "manual", met: true }, { type: "manual", met: false }] }) === true &&
      conditionsSatisfied({ completionPolicy: "all", stopConditions: [{ type: "manual", met: true }, { type: "manual", met: false }] }) === false &&
      conditionsSatisfied({ steps: [{ id: "s", label: "x", done: false }], stopConditions: [{ type: "manual", met: true }] }) === false,
  );
}

// ---------- unit: model/provider namespace guard (review fix, V5) — pure, key-free ----------
{
  const openrouter = { name: "openrouter", defaultModel: "anthropic/claude-haiku-4.5" };
  const anthropic = { name: "anthropic", defaultModel: "claude-haiku-4-5" };
  check(
    "an Anthropic-form model on OpenRouter falls back to the provider default",
    resolveModelForProvider(openrouter, "claude-haiku-4-5") === "anthropic/claude-haiku-4.5",
  );
  check(
    "an OpenRouter-namespaced model on Anthropic falls back to the provider default",
    resolveModelForProvider(anthropic, "openai/gpt-5-mini") === "claude-haiku-4-5",
  );
  check(
    "a correctly-namespaced OpenRouter model passes through unchanged",
    resolveModelForProvider(openrouter, "openai/gpt-5-mini") === "openai/gpt-5-mini",
  );
  check(
    "a correctly-bare Anthropic model passes through unchanged",
    resolveModelForProvider(anthropic, "claude-opus-4-8") === "claude-opus-4-8",
  );
}

// ---------- unit: evaluators on a real scratch git repo + the fake ledger (Epic B1) ----------
const gitDir = await mkdtemp(join(tmpdir(), "brick-git-"));
const g = (...args) =>
  execFileSync("git", ["-C", gitDir, "-c", "user.email=s@s", "-c", "user.name=smoke", ...args], { stdio: "pipe" });
g("init", "-q");
g("commit", "--allow-empty", "-q", "-m", "init");
{
  // head-advanced: flips ONLY after a real commit; stays met.
  const cond = { type: "git", repoPath: gitDir, predicate: { kind: "head-advanced", ref: "HEAD" }, met: false };
  const ev = makeEvaluator(cond);
  await ev.arm({}, cond);
  check("git head-advanced: not met at baseline", (await ev.poll()) === false);
  g("commit", "--allow-empty", "-q", "-m", "work done");
  check("git head-advanced: met after a real commit", (await ev.poll()) === true);
  check("git head-advanced: stays met (monotonic)", (await ev.poll()) === true);

  // message-match since arm time.
  const mm = { type: "git", repoPath: gitDir, predicate: { kind: "message-match", regex: "ship it" }, met: false };
  const ev2 = makeEvaluator(mm);
  await ev2.arm({}, mm);
  check("git message-match: not met before the commit", (await ev2.poll()) === false);
  g("commit", "--allow-empty", "-q", "-m", "feat: ship it to prod");
  check("git message-match: met on a matching subject", (await ev2.poll()) === true);

  // Broken repoPath never flips (fail-open).
  const bad = { type: "git", repoPath: "/nonexistent/repo/xyz", predicate: { kind: "head-advanced", ref: "HEAD" }, met: false };
  const ev3 = makeEvaluator(bad);
  await ev3.arm({}, bad);
  check("git broken repoPath: never met (fail-open)", (await ev3.poll()) === false);
}
{
  // command evaluator: OFF unless BRICK_ALLOW_COMMAND_CONDITIONS is set.
  const cond = { type: "command", cmd: "true", met: false };
  const ev = makeEvaluator(cond);
  await ev.arm({}, cond);
  delete process.env.BRICK_ALLOW_COMMAND_CONDITIONS;
  check("command evaluator gated off by default", (await ev.poll()) === false);
  process.env.BRICK_ALLOW_COMMAND_CONDITIONS = "1";
  check("command evaluator: exit 0 met when enabled", (await ev.poll()) === true);
  const fail = { type: "command", cmd: "exit 3", met: false };
  const ev2 = makeEvaluator(fail);
  await ev2.arm({}, fail);
  check("command evaluator: wrong exit code not met", (await ev2.poll()) === false);
  const expected = { type: "command", cmd: "exit 3", expectExit: 3, met: false };
  const ev3 = makeEvaluator(expected);
  await ev3.arm({}, expected);
  check("command evaluator: expectExit matches non-zero", (await ev3.poll()) === true);
  delete process.env.BRICK_ALLOW_COMMAND_CONDITIONS;
}
{
  // ledger evaluator against the fake LEDGER_BIN: next-action change is the completion signal.
  setLedgerProjects([{ id: "p1", name: "Proj One", nextAction: "step A" }]);
  const cond = { type: "ledger", projectId: "p1", on: "next-action-change", met: false };
  const ev = makeEvaluator(cond);
  await ev.arm({}, cond);
  check("ledger evaluator: baseline captured, not met", (await ev.poll()) === false);
  setLedgerProjects([{ id: "p1", name: "Proj One", nextAction: "step B" }]);
  check("ledger evaluator: met when nextAction changes", (await ev.poll()) === true);
  setLedgerProjects([{ id: "p1", name: "Proj One", nextAction: "step A" }]);
  check("ledger evaluator: stays met after a revert (monotonic)", (await ev.poll()) === true);
}

// ---------- integration: the running service ----------
let dataDir;
let srv;

function spawnServer(dir) {
  return spawn("node", ["dist/server.js"], {
    // Blank both provider keys so the run is genuinely key-free (tier-2 takes the stub path and no
    // check ever calls a model) even on a machine whose .env/environment has real keys. An
    // empty-string var also blocks process.loadEnvFile from re-populating it (no override).
    env: {
      ...process.env,
      BRICK_PORT: PORT,
      BRICK_DATA_DIR: dir,
      ANTHROPIC_API_KEY: "",
      OPENROUTER_API_KEY: "",
      BRICK_WATCH_INTERVAL_MS: "150", // fast watcher ticks so Epic-B checks settle in <1s
      LEDGER_BIN: FAKE_LEDGER.bin,
      BRICK_TMINUS_MIN: "0.005", // 0.3s — fractional escalation thresholds for the C1 checks
      BRICK_GRACE_MIN: "0.005",
    },
    stdio: "ignore",
  });
}

async function waitHealthy() {
  for (let i = 0; i < 25; i += 1) {
    try {
      await fetch(BASE + "/health");
      return;
    } catch {
      await sleep(150);
    }
  }
}

// Kill the current server and spawn a fresh one against the SAME data dir — simulates a service
// restart mid-plan (review fix regression coverage: restorePlan must re-anchor the session).
async function restartServer() {
  srv.kill();
  await sleep(200);
  srv = spawnServer(dataDir);
  await waitHealthy();
}

try {
  dataDir = await mkdtemp(join(tmpdir(), "brick-smoke-"));
  srv = spawnServer(dataDir);
  await waitHealthy();

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

  // ---------- Epic B: watchers + swap + advance mode + undo (live service, 150ms ticks) ----------
  const settle = () => sleep(700); // several watcher ticks

  // Settings round-trip first (B3/B4 surface).
  const setB = await post("/config/settings", { advanceMode: "manual", undoWindowSec: 12 });
  check("advance-mode settings persist", setB.settings.advanceMode === "manual" && setB.settings.undoWindowSec === 12);
  check("GET /config reflects advance mode", (await get("/config")).settings.advanceMode === "manual");
  await post("/config/settings", { advanceMode: "auto", undoWindowSec: 5 });

  // AUTO: a git head-advanced condition auto-advances the queue with an undo window.
  const gitCond = { type: "git", repoPath: gitDir, predicate: { kind: "head-advanced", ref: "HEAD" } };
  const bp = await post("/plan/start", {
    blocks: [
      { task: "watched block", stopConditions: [gitCond] },
      { task: "next block" },
    ],
  });
  const watchedId = bp.plan.blocks[0].id;
  await sleep(400); // let the watcher arm + tick at baseline
  check("condition not met at baseline → no advance", (await get("/plan")).plan.activeBlockId === watchedId);
  g("commit", "--allow-empty", "-q", "-m", "push!");
  await settle();
  let bplan = (await get("/plan")).plan;
  check("auto: met condition advanced the queue", bplan.activeBlockId === bplan.blocks[1].id && bplan.blocks[0].status === "done");
  check("auto: condition met flag persisted", bplan.blocks[0].stopConditions[0].met === true);
  check("auto: undo offered with a deadline", bplan.undo?.fromBlockId === watchedId && typeof bplan.undo.availableUntil === "string");
  const undone = await post("/plan/undo-advance", {});
  check("undo returns to the watched block, marked ready", undone.plan.activeBlockId === watchedId && undone.plan.blocks[0].ready === true);
  check("undo re-anchored the session", (await get("/session")).session?.focus.task === "watched block");
  await settle();
  check("undone block does NOT auto-re-advance (no fire loop)", (await get("/plan")).plan.activeBlockId === watchedId);
  await post("/plan/end", {});

  // MANUAL: the queue waits for the tap; the block lights up ready.
  await post("/config/settings", { advanceMode: "manual" });
  const mp = await post("/plan/start", {
    blocks: [{ task: "manual watched", stopConditions: [gitCond] }, { task: "manual next" }],
  });
  const manualId = mp.plan.blocks[0].id;
  await sleep(300);
  g("commit", "--allow-empty", "-q", "-m", "another push");
  await settle();
  bplan = (await get("/plan")).plan;
  check("manual: block marked ready, queue did NOT move", bplan.activeBlockId === manualId && bplan.blocks[0].ready === true);
  const tapped = await post("/plan/block/advance", {});
  check("manual: the tap advances", tapped.plan.activeBlockId === tapped.plan.blocks[1].id);
  await post("/plan/end", {});
  await post("/config/settings", { advanceMode: "auto" });

  // TIME: budget expiry nudges (ready) but never silently flips the queue (§12).
  const tp = await post("/plan/start", {
    blocks: [{ task: "timed block", budgetMinutes: 0.003, swapMode: "time" }, { task: "after time" }],
  });
  const timedId = tp.plan.blocks[0].id;
  await settle();
  bplan = (await get("/plan")).plan;
  check("time: budget expiry → ready (nudge), no silent flip", bplan.activeBlockId === timedId && bplan.blocks[0].ready === true);
  await post("/plan/end", {});

  // LEDGER: advancing the project in (fake) Ledger completes the block — the keystone signal.
  setLedgerProjects([{ id: "p1", name: "Proj One", nextAction: "phase one" }]);
  await post("/plan/start", {
    blocks: [
      { task: "ledger watched", stopConditions: [{ type: "ledger", projectId: "p1" }] },
      { task: "ledger next" },
    ],
  });
  await sleep(400);
  setLedgerProjects([{ id: "p1", name: "Proj One", nextAction: "phase two" }]);
  await settle();
  bplan = (await get("/plan")).plan;
  check("ledger: next-action change auto-advanced the block", bplan.activeBlockId === bplan.blocks[1].id && bplan.blocks[0].stopConditions[0].met === true);
  await post("/plan/end", {});

  // ---------- Epic C1: escalation clock — levels advance at the thresholds, version bumps ----------
  // budget 0.01min (0.6s), thresholds 0.005min (0.3s): none → t-minus (~0.3s) → t-0 (~0.6s) → grace (~0.9s)
  const cp = await post("/plan/start", {
    blocks: [{ task: "escalating block", budgetMinutes: 0.01 }, { task: "calm block" }],
  });
  const v0c = cp.plan.stateVersion;
  const seen = [];
  const deadlineC = Date.now() + 2500;
  while (Date.now() < deadlineC) {
    const p = (await get("/plan")).plan;
    if (!p) break;
    const lvl = p.active?.escalation;
    if (lvl && seen[seen.length - 1] !== lvl) seen.push(lvl);
    if (lvl === "grace") break;
    await sleep(100);
  }
  const order = ["none", "t-minus", "t-0", "grace"];
  const seenOrdered = seen.every((l, i) => i === 0 || order.indexOf(l) > order.indexOf(seen[i - 1]));
  check(`escalation levels advance in order (saw: ${seen.join("→")})`, seenOrdered && seen.includes("t-minus") && seen.includes("t-0") && seen.includes("grace"));
  check("stateVersion bumps on level transitions", (await get("/plan")).plan.stateVersion > v0c);
  await post("/plan/end", {});

  // ---------- Review fixes: restart re-anchoring, hijack guard, undo-hold survival ----------
  {
    const rp = await post("/plan/start", { blocks: [{ task: "restart alpha" }, { task: "restart beta" }] });
    check("plan started before restart", rp.plan.blocks[0].status === "active");
    await restartServer();
    const afterRestart = await get("/plan");
    check("plan survives restart with the same active block", afterRestart.plan.activeBlockId === rp.plan.blocks[0].id);
    // The real regression: adjudicate with NO task must not 500 (session re-anchored) and a
    // per-call task must still not override the plan's focus (hijack guard intact post-restart).
    const adjAfterRestart = await fetch(BASE + "/adjudicate", {
      method: "POST",
      headers: H,
      body: JSON.stringify({ url: "https://nytimes.com" }),
    });
    check("adjudicate with no task doesn't 500 after restart (session re-anchored)", adjAfterRestart.status === 200);
    const hijackAfterRestart = await post("/adjudicate", { url: "https://nytimes.com", task: "unrelated hijack attempt" });
    check("hijack guard still holds after restart", hijackAfterRestart.focusKey === "restart alpha");
    await post("/plan/end", {});
  }

  {
    // Time-nudge must not disarm a later condition fire (the exact bug: budget expiry consuming
    // the block's one dedup slot forever under swapMode "first").
    const gitCond = { type: "git", repoPath: gitDir, predicate: { kind: "head-advanced", ref: "HEAD" } };
    const tp2 = await post("/plan/start", {
      blocks: [
        { task: "time-then-condition", budgetMinutes: 0.003, stopConditions: [gitCond] },
        { task: "after both" },
      ],
    });
    const twId = tp2.plan.blocks[0].id;
    await sleep(400); // let the budget expire and fire the time-nudge first
    let p2 = (await get("/plan")).plan;
    check("time-nudge fires first (ready, still active)", p2.activeBlockId === twId && p2.blocks[0].ready === true);
    g("commit", "--allow-empty", "-q", "-m", "push after the time nudge");
    await sleep(500); // give the watcher a few ticks to see the now-met condition
    p2 = (await get("/plan")).plan;
    check("condition fire still lands AFTER a prior time-nudge (not eaten)", p2.activeBlockId === p2.blocks[1].id);
    await post("/plan/end", {});
  }

  {
    // Undo-hold must survive a restart: the restored block must NOT auto-re-advance once its
    // condition (already met before the undo) is still met after the service comes back.
    const gitCond = { type: "git", repoPath: gitDir, predicate: { kind: "head-advanced", ref: "HEAD" } };
    g("commit", "--allow-empty", "-q", "-m", "pre-undo-restart baseline");
    const up = await post("/plan/start", {
      blocks: [{ task: "undo restart watched", stopConditions: [gitCond] }, { task: "undo restart next" }],
    });
    const uwId = up.plan.blocks[0].id;
    await sleep(300);
    g("commit", "--allow-empty", "-q", "-m", "trigger the auto-advance");
    await sleep(700); // auto-advance fires
    const undone = await post("/plan/undo-advance", {});
    check("undo restores the watched block before the restart test", undone.plan.activeBlockId === uwId);
    await restartServer();
    await sleep(700); // give the watcher a few ticks post-restart
    const afterUndoRestart = await get("/plan");
    check("undo-hold survives a restart (no re-advance)", afterUndoRestart.plan.activeBlockId === uwId);
    await post("/plan/end", {});
  }

  {
    // advancePlan must reject advancing a non-active block (the two-actives bug).
    const np = await post("/plan/start", { blocks: [{ task: "na1" }, { task: "na2" }, { task: "na3" }] });
    const pendingId = np.plan.blocks[1].id;
    const rejected = await fetch(BASE + "/plan/block/advance", {
      method: "POST",
      headers: H,
      body: JSON.stringify({ blockId: pendingId }),
    });
    const rejectedBody = await rejected.json();
    check("advancing a non-active block is rejected, not silently accepted", rejectedBody.plan === undefined && !!rejectedBody.error);
    check("the active block is unaffected", (await get("/plan")).plan.blocks[0].status === "active");
    await post("/plan/end", {});
  }

  {
    // Budget edit must reject non-finite / absent values instead of coercing to 1 or NaN.
    const bp2 = await post("/plan/start", { blocks: [{ task: "budget-edit-target", budgetMinutes: 10 }] });
    const targetId = bp2.plan.blocks[0].id;
    const badEdit = await fetch(BASE + "/plan/reorder", {
      method: "POST",
      headers: H,
      body: JSON.stringify({ budget: { blockId: targetId } }), // no budgetMinutes at all
    });
    check("a budget edit with no minutes is rejected (not silently 1)", badEdit.status >= 400);
    const badEdit2 = await fetch(BASE + "/plan/reorder", {
      method: "POST",
      headers: H,
      body: JSON.stringify({ budget: { blockId: targetId, budgetMinutes: "abc" } }),
    });
    check("a non-numeric budget edit is rejected (not silently NaN)", badEdit2.status >= 400);
    check("the original budget is untouched", (await get("/plan")).plan.blocks[0].budgetMinutes === 10);
    await post("/plan/end", {});
  }

  {
    // completionPolicy:"all" must be honored by the automatic watcher (was unreachable through
    // /plan/start before this fix). NOTE: /plan/block/complete is the documented manual escape
    // hatch — Appendix A says manual is "always available... the escape hatch" — so it always
    // advances regardless of policy; it is NOT the right tool to test policy enforcement with.
    // This test drives it through a real met condition instead, with a second condition that
    // structurally never fires (command conditions are gated off in this server's env).
    const gitCond = { type: "git", repoPath: gitDir, predicate: { kind: "head-advanced", ref: "HEAD" } };
    const allPlan = await post("/plan/start", {
      blocks: [
        { task: "needs both conditions", completionPolicy: "all", stopConditions: [gitCond, { type: "command", cmd: "false" }] },
        { task: "after both met" },
      ],
    });
    await sleep(300);
    g("commit", "--allow-empty", "-q", "-m", "only one of two conditions met");
    await sleep(500);
    const stillActive = await get("/plan");
    const conds = stillActive.plan.blocks[0].stopConditions;
    check(
      "completionPolicy 'all' keeps the block active when only ONE of two conditions is met",
      stillActive.plan.activeBlockId === allPlan.plan.blocks[0].id &&
        conds.find((c) => c.type === "git").met === true &&
        conds.find((c) => c.type === "command").met === false,
    );
    await post("/plan/end", {});
  }

  {
    // Template round-trip must carry stopConditions/advanceMode/completionPolicy through save AND
    // relaunch (was silently stripped both ways).
    const gitCond = { type: "git", repoPath: gitDir, predicate: { kind: "head-advanced", ref: "HEAD" } };
    await post("/plan/start", {
      blocks: [{ task: "carries watchers", stopConditions: [gitCond], advanceMode: "manual", completionPolicy: "all" }],
    });
    const savedTpl = await post("/templates", { fromCurrent: { name: "watcher template" } });
    check(
      "save-as-template keeps stopConditions/advanceMode/completionPolicy",
      savedTpl.template.blocks[0].stopConditions?.length === 1 &&
        savedTpl.template.blocks[0].advanceMode === "manual" &&
        savedTpl.template.blocks[0].completionPolicy === "all",
    );
    await post("/plan/end", {});
    const relaunched = await post("/plan/from-template", { templateId: savedTpl.template.id });
    check(
      "relaunching the template restores the watcher (unmet, ready for a fresh push)",
      relaunched.plan.blocks[0].stopConditions?.[0]?.met === false &&
        relaunched.plan.blocks[0].advanceMode === "manual",
    );
    await post("/plan/end", {});
  }

  {
    // editPlan.insert must also carry stopConditions/advanceMode (was silently dropped).
    const ip = await post("/plan/start", { blocks: [{ task: "insert-base" }] });
    const insertRes = await post("/plan/reorder", {
      insert: {
        task: "inserted with a watcher",
        stopConditions: [{ type: "manual" }],
        advanceMode: "manual",
      },
    });
    const inserted = insertRes.plan.blocks.find((b) => b.focus.task === "inserted with a watcher");
    check("editPlan.insert keeps stopConditions/advanceMode", inserted?.stopConditions?.length === 1 && inserted.advanceMode === "manual");
    await post("/plan/end", {});
  }

  {
    // Model/provider namespace guard: a mismatched model id must fall back, never 404-loop silently.
    await post("/config/settings", { model: "not-a-namespaced-openrouter-id" });
    const afterBadModel = await get("/config");
    check("a saved model is NOT silently corrected at save time (guard applies at call time)", afterBadModel.model === "not-a-namespaced-openrouter-id");
    await post("/config/settings", { model: "" }); // clean up for any later checks
  }

  {
    // Restore youtu.be to the page-scope list — an earlier test ("focus-tuning settings persist")
    // overwrote pageScopeDomains with ["youtube.com", "vimeo.com"], dropping the default. This test
    // needs it back regardless of suite ordering.
    await post("/config/settings", { pageScopeDomains: ["youtube.com", "youtu.be"] });

    // Per-page unit derivation server-side: enforceTab (no client unit) must still hit a page-scope
    // learned entry — the bug was that only content-guard's own computed unit worked.
    await post("/decisions/learn", {
      task: TASK,
      url: "https://youtube.com/watch?v=zzz999",
      decision: "allow",
      via: "clarify",
      scope: "page",
      unit: "zzz999",
    });
    const noUnitGiven = await post("/adjudicate", { url: "https://youtube.com/watch?v=zzz999", task: TASK }); // no `unit` in the request — as enforceTab used to send it
    check("server derives the page unit when the caller omits it (enforceTab fix)", noUnitGiven.via === "learned" && noUnitGiven.decision === "allow");
    // youtu.be short-link form — the id lives in the PATH, not a ?v= query param.
    const ytbLearn = await post("/decisions/learn", {
      task: TASK,
      url: "https://youtu.be/abc123",
      decision: "block",
      via: "clarify",
      scope: "page", // client requests page scope without an explicit unit — server derives it
    });
    check("youtu.be path-based id is derived server-side (not silently domain-scoped)", ytbLearn.learned.scope === "page" && ytbLearn.learned.unit === "abc123");
    const ytbCheck = await post("/adjudicate", { url: "https://youtu.be/abc123", task: TASK });
    check("the youtu.be page-scope learn short-circuits correctly", ytbCheck.via === "learned" && ytbCheck.decision === "block");
    await post("/decisions/clear", {});
  }
} finally {
  if (srv) srv.kill();
  if (dataDir) await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  await rm(gitDir, { recursive: true, force: true }).catch(() => {});
  await rm(FAKE_LEDGER.dir, { recursive: true, force: true }).catch(() => {});
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
