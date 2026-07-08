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
  domainUnit,
  findLearned,
  focusKeyOf,
  resolvePrecedence,
} from "../dist/decisions-store.js";

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
check("focusKeyOf: projectId wins over task", focusKeyOf({ task: "x", source: "explicit", projectId: "p9" }) === "p9");
check("domainUnit: strips www", domainUnit("https://www.example.com/a?b=1") === "example.com");

// ---------- integration: the running service ----------
let dataDir;
let srv;
try {
  dataDir = await mkdtemp(join(tmpdir(), "brick-smoke-"));
  srv = spawn("node", ["dist/server.js"], {
    env: { ...process.env, BRICK_PORT: PORT, BRICK_DATA_DIR: dataDir },
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
  check("gatekeeper readout counts corrections", cfgCounts.correction === 1 && cfgCounts.total === 3);

  // Clear resets the store — the learned nytimes allow no longer short-circuits.
  const cleared = await post("/decisions/clear");
  check("clear empties the store", cleared.counts.total === 0);
  const afterClear = await post("/adjudicate", { url: "https://nytimes.com/section/world", task: TASK });
  check("cleared: nytimes no longer learned", afterClear.via !== "learned");

  // Session lifecycle (explicit focus — no ledger needed).
  const start = await post("/session/start", { task: TASK });
  check("session starts", Boolean(start.session && start.session.id));

  const prep = await post("/prepend", {});
  check("prepend uses session focus", typeof prep.header === "string" && prep.header.includes("BRICK MODE"));

  await post("/session/stop", {});
  const after = await get("/session");
  check("session stops", after.session === null);
} finally {
  if (srv) srv.kill();
  if (dataDir) await rm(dataDir, { recursive: true, force: true }).catch(() => {});
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
