# BRICK MODE — Workload / Day-Plan design

**Status:** design proposal (Phase 3 candidate). Extends the single-focus session model into a
**fluid, ordered queue of project blocks** with per-block time budgets and/or auto-detected stop
conditions.

> Decisions locked with Corina: plan's eventual home is a **Ledger object**; stop conditions are
> **auto-detected** (with manual fallback); overrun behaviour is **escalating** (nudge, not a hard
> flip); alerts surface in the **extension popup, in-page, and OS notifications**. Guiding nuance:
> *fluid — each block can carry a timeframe and/or a stop-condition, and blocks can repeat.*

---

## 1. The idea in one paragraph

Today brick answers *"is this tab consistent with my one focus task?"* The focus task **is** a Ledger
project's Next Action (`ledger.ts` — the keystone). This design adds the layer above: a **Workload**
(a day plan) is an ordered list of **Blocks**; each Block *is* a focus session bound to a Ledger
project, plus a **budget** ("~2h on this") and/or a **stop-condition** ("done when I push to main").
The currently-active Block is exactly the `FocusSession` that already exists — so the adjudicator,
tiers, and Pomodoro all keep working unchanged, anchored to whichever block is active. brick's new job
is to run the *queue*: watch budgets and completion signals, and nudge you from Block A → B → C.

Two axes that are deliberately kept separate:

- **Budget = attention allocation.** "I want to spend ~2 hours here." Expiry is *advisory* — it
  triggers the escalating switch nudge, never a forced stop.
- **Stop-condition = definition of done.** "This block's goal is achieved." When met, the block is
  genuinely complete and the queue advances.

A block can have either, both, or neither (neither = purely manual "next"). Both is the interesting
case: the budget tells you *when to think about moving on*; the stop-condition tells you *whether the
work is actually finished*. They answer different questions and shouldn't be collapsed.

By default the budget is advisory (it escalates, §6). But a block can promote the budget to a real
**swap trigger** and choose how time and condition *combine* — swap on time, swap on the condition, or
swap on whichever comes first. That combination is the block's **swap policy** (§12). And a whole
recurring shape ("alternate X and Y in 2h blocks") can be saved and re-run as a **workflow template**
(§13).

---

## 2. Requirements

**Functional**
- Define an ordered, editable list of blocks for a work period ("today: new project → lab analysis").
- Per block: reference a Ledger project (or ad-hoc task), optional budget minutes, optional
  stop-condition(s), optional ordered **steps** (X, Y, Z to push), optional **repeat**.
- Track the active block; know elapsed vs. budget; know which steps/conditions are met.
- Auto-detect stop conditions (git push/merge, Ledger Next-Action change), with manual override.
- Escalating notifications as a budget nears/passes and when a block auto-completes.
- Surface state in extension popup/badge, an in-page overlay, and OS notifications.

**Non-functional**
- **Minimal blast radius:** the active block reuses the existing single-focus session; the
  adjudicator/prepend/tier pipeline stays untouched.
- **Fail-open & fail-safe:** a broken signal watcher never *falsely completes* a block and never
  blocks real work (consistent with the service's existing fail-open ethos).
- **Local-first, low latency:** signal polling on the order of ~30s; no cloud dependency to run.
- **Ledger as source of truth eventually**, without requiring un-verifiable mature-app edits *now*
  (see §7 sequencing).

**Constraints (from the repo today)**
- Ledger integration is **read-only** — brick shells out to `ledger status --json` (`ledger.ts`).
  There is no write path and **no "active project" state** in Ledger.
- Session state is a single in-memory `current` singleton (`session.ts`) plus a JSONL append log.
- The extension is a thin enforcement surface; the local service (`:7373`) is the brain
  (`server.ts`, `background.js`).

---

## 3. Data model

New types (brick `src/types.ts`), designed to be **Ledger-native** in shape so they can move into
Ledger later with no restructuring:

```ts
interface WorkloadPlan {
  id: string;                 // e.g. plan_<yyyy-mm-dd>
  label?: string;             // "Sunday", "deep-work AM", …
  blocks: WorkBlock[];        // ORDERED; the queue
  activeBlockId?: string;     // which block is live right now
  createdAt: string;
}

interface WorkBlock {
  id: string;
  focus: FocusTask;           // REUSED — ties to a Ledger project or an explicit task
  budgetMinutes?: number;     // optional attention allocation
  stopConditions?: StopCondition[];
  completionPolicy?: "any" | "all";   // when >1 condition (default "any")
  steps?: Step[];             // optional intra-block checklist
  repeat?: RepeatSpec;        // blocks can repeat (see §3.1)
  status: "pending" | "active" | "done" | "skipped";
  startedAt?: string;
  completedAt?: string;
  actualMinutes?: number;     // measured, for end-of-day review
}

interface Step { id: string; label: string; done: boolean }

type StopCondition =
  | { type: "git";    repoPath: string; predicate: GitPredicate; met: boolean; metAt?: string }
  | { type: "ledger"; projectId: string; on: "next-action-change"; from?: string; met: boolean; metAt?: string }
  | { type: "command"; cmd: string; cwd?: string; expectExit?: number; met: boolean; metAt?: string }
  | { type: "manual"; met: boolean; metAt?: string };

type GitPredicate =
  | { kind: "head-advanced"; ref?: string }        // e.g. origin/main moved
  | { kind: "merge-commit"; intoRef: string }      // a merge landed on <ref>
  | { kind: "message-match"; regex: string };      // commit subject matches

interface RepeatSpec {
  mode: "requeue";            // on complete, drop a fresh copy at the queue tail
  maxPerDay?: number;         // safety cap
}
```

Notes:
- `FocusTask` already carries `projectId` / `projectName` / `source`, so a block inherits the
  keystone property: **the block's focus is the Ledger Next Action, not a retyped string.**
- `manual` is always available as a fallback condition even when auto-signals are configured — the
  "I'll just say it's done" escape hatch.
- Completion rule: a block is **done** when its `steps` gate (if any) plus its `stopConditions`
  (per `completionPolicy`) are satisfied. **Budget is not part of completion** — it only drives the
  switch nudge.

### 3.1 Fluidity & repeats

"Fluid" means the plan is editable mid-day and blocks are cheap: reorder, insert, drop, extend a
budget, mark a condition met by hand. A **repeating** block (`repeat.mode: "requeue"`) re-enqueues a
clean copy of itself at the tail when it completes — good for "check lab job → back to project → check
lab job again". `maxPerDay` prevents an accidental infinite loop.

---

## 4. High-level architecture

```
                          ┌────────────────────────────────────────────────┐
                          │              brick service (:7373)               │
                          │                    "the brain"                   │
   Ledger CLI  ──read──►  │  PlanStore ──┐                                   │
  (projects,  ◄─write──   │             ├─► PlanRuntime ──► SignalWatchers   │
   plan*)                 │             │     (queue,        (git poll,       │
                          │             │      budgets,       ledger diff,    │
                          │  Session ◄──┘      active block)   command)       │
                          │  (existing single focus = active block)          │
                          │        │                                         │
                          │        └─► Adjudicator / Prepend / Tiers (as-is)  │
                          └───────────────┬──────────────────────────────────┘
                                          │ GET /plan  (extension polls on tick)
                                          ▼
                          ┌────────────────────────────────────────────────┐
                          │         MV3 extension (enforcement + UI)         │
                          │  background worker ─► NotificationDispatcher ──► │
                          │     • popup / badge   • in-page overlay          │
                          │     • chrome.notifications (OS)                  │
                          └────────────────────────────────────────────────┘
```

Everything new lives in the **service** (PlanStore, PlanRuntime, SignalWatchers). The extension gains
only a **NotificationDispatcher** and richer popup rendering — it stays dumb and secret-free.

### 4.1 How the active block relates to the existing session

`PlanRuntime` owns the queue; the **active block delegates to the current `FocusSession`**. Starting a
plan = start a session anchored to block 0's focus. Advancing = end that session's accounting for the
block and start the next. The Pomodoro work/break cycle (existing `background.js`) runs *inside* a
block as before — nested timers:

- **Macro (new):** block budget → escalating switch nudge. Advisory.
- **Micro (existing):** Pomodoro work/break → tier enforcement on/off. Unchanged.

Pomodoro becomes **opt-out per plan** (some blocks, like a 20-min lab check, don't want it).

---

## 5. Signal watchers (the auto-detect core)

A `watchers.ts` module. On block activation, the runtime instantiates an **evaluator** per
stop-condition and runs a single interval loop (default 30s, configurable
`BRICK_WATCH_INTERVAL_MS`). Each tick evaluates only the **active block's** conditions:

| Condition | Evaluator | How it detects "met" | Cost |
|---|---|---|---|
| `git` | run `git -C <repo> …` | snapshot `rev-parse <ref>` / scan `git log` for a merge or message match since block start; met when it changes as specified | one cheap subprocess/tick |
| `ledger` | reuse `fetchProjects()` | diff the project's `nextAction` vs. the value captured at block start; met when it changes (you advanced the project) | one CLI call/tick |
| `command` | run `cmd` | met when exit code == `expectExit` (default 0) — e.g. `npm test` | as heavy as the cmd; opt-in |
| `manual` | none | met when the user taps "done" (popup/overlay) | free |

Design rules:
- **Never false-complete.** Each evaluator captures a baseline at block start and only reports `met`
  on an unambiguous, forward change. On any error it returns "not met" (fails open — the block simply
  doesn't auto-advance; you can always advance by hand).
- **Idempotent + debounced.** Once `met`, it stays met; a flapping signal can't un-complete a block.
- **Polling over hooks (initially).** Polling needs no per-repo install and works across arbitrary
  project dirs; ~30s latency is fine for "I just pushed." Git hooks / a filesystem watcher can be a
  later low-latency upgrade for the repo you're actively in.

When the active block's `completionPolicy` is satisfied → emit `block.completed` → runtime advances
the queue (respecting `repeat`) → NotificationDispatcher fires. Because you chose **auto-signals**,
a met stop-condition **auto-advances** (with a short **undo window**, see §6) rather than merely
suggesting.

---

## 6. Escalating switch (budget overrun)

Budget expiry does **not** flip your focus. It escalates:

1. **T‑minus (e.g. −5 min):** quiet heads-up — badge tint + popup line: *"~5 min left on New Project."*
2. **T‑0 (budget end):** OS + in-page nudge: *"Time's up on New Project. Next: Lab analysis."* You
   keep working; nothing is blocked; the adjudicator is **still anchored to the current block.**
3. **Grace overrun (e.g. +M min):** the nudge re-fires, more insistent; the popup surfaces a one-tap
   **"Advance now"**.
4. **Past grace:** the adjudication anchor **softly** shifts toward the next block — pages tied to the
   old block start getting the existing *soft* "1 more minute" overlay (the `brick:catch` channel),
   never a hard block. This is pressure, not a wall — you can still choose to stay.

Escalation thresholds live in plan/config so they're tunable. The philosophy matches the codebase's
existing "conservative-allow / soft-nudge" stance: **guide, don't coerce.**

**Auto-advance undo:** when a stop-condition auto-completes a block, the switch notification includes
**"Undo"** for ~30s, in case a signal fired earlier than you meant (e.g. a stray push). After the
window, the advance is committed and logged.

Whether a met condition *auto-advances* or just *offers* to is a **user setting** — see §8.1.
Escalation (budget overrun) is independent of it: budgets always escalate; the setting only governs
what happens the moment a **stop-condition** is satisfied.

---

## 7. Where the plan lives — Ledger, sequenced honestly

You chose the plan's home to be a **Ledger object**. The wrinkle: brick can only *read* Ledger today
(`ledger status --json`), and the repo deliberately avoids un-verifiable edits to the mature Ledger
app. So the target and the path differ:

**Target (destination):** a first-class Ledger `WorkloadPlan` (a `plans` collection in Firestore),
with CLI verbs brick shells out to exactly like `status`:

```
ledger plan show   --json          # read today's plan + blocks
ledger plan advance --block <id>   # complete/skip active block
ledger plan step   --block <id> --step <id> --done
```

**Path (how we get there without blocking on Ledger work):** put the store behind an interface:

```ts
interface PlanStore {
  load(): Promise<WorkloadPlan | null>;
  save(p: WorkloadPlan): Promise<void>;
  advance(blockId: string, how: "done" | "skipped"): Promise<WorkloadPlan>;
}
```

Ship a `LocalPlanStore` first (`.data/plan.json`, mirroring the Ledger-native schema exactly), build
and validate the *entire* runtime + watchers + notifications against it, then drop in a
`LedgerPlanStore` (the CLI verbs above) when they exist in the Ledger repo — **no schema churn,
because the local JSON is already the Ledger shape.** This honours "Ledger is the home" as the
destination while respecting "don't do headless-unverifiable mature-app edits now." (It's the earlier
*hybrid* option repurposed as an implementation sequence, not a change of destination.)

---

## 8. Service API additions (`server.ts`)

All guarded by the existing `X-Brick-Client` header + origin allow-list.

| Route | Purpose |
|---|---|
| `GET /plan` | current plan, active block, elapsed vs budget, condition/step state, escalation level |
| `POST /plan/start` | begin a plan (from Ledger or a posted block list) |
| `POST /plan/block/advance` | complete/skip active block → move to next (handles `repeat`) |
| `POST /plan/block/step` | toggle a step's `done` |
| `POST /plan/block/complete` | manually mark a stop-condition met (the `manual` fallback) |
| `POST /plan/undo-advance` | within the undo window, revert the last auto-advance |
| `POST /plan/reorder` | fluid edits: reorder / insert / drop / extend budget |
| `POST /config/settings` | persist `advanceMode` / `undoWindowSec` (see §8.1) |

`focusFor()` (server.ts) changes minimally: during an active plan, the focus is the **active block's**
focus — a per-call `task` still can't hijack adjudication, preserving the current safety property.

### 8.1 Advance mode (user setting)

How brick reacts the instant a **stop-condition** is met is a toggle, not a hardcoded choice:

```ts
interface BrickSettings {
  advanceMode: "auto" | "manual";   // default "auto"
  undoWindowSec: number;            // default 30 — only used by "auto"
}
```

- **`auto` (undo-friendly):** condition met → the queue advances immediately, and the switch
  notification carries an **Undo** for `undoWindowSec`. Low friction; matches "done when I push."
- **`manual` ("advance now"):** condition met → the block is marked **ready** (conditions satisfied,
  *not* advanced); the popup's **advance now** button lights up and a "ready to advance" notification
  fires. Nothing moves until you tap. Full control.

**Storage & surface.** Stored alongside tiers in `.data/settings.json` (new `loadSettings` /
`saveSettings` in `config-store.ts`), merged into `GET /config`, written via a new
`POST /config/settings`. The options page (`options.html`) gains a small **advance mode** control (two
radios + an undo-seconds field, disabled when `manual`). This mirrors exactly how tier lists already
persist and reload — a new focus session / plan picks up the change.

**Per-block override (keeps it fluid).** A block may carry its own `advanceMode?`; the effective mode
is `block.advanceMode ?? settings.advanceMode`. So the global default can be `manual` while a
low-stakes repeating "lab check" block is set to `auto`, or vice-versa.

**Runtime branch** (`PlanRuntime.onConditionMet`):

```
effective = block.advanceMode ?? settings.advanceMode
if effective === "auto":  advance(block, "done"); armUndo(undoWindowSec); notify("switched", undo:true)
else:                     block.ready = true;      notify("ready-to-advance")   // wait for the tap
```

Adds one route — `POST /plan/undo-advance` (already listed) reverts within the window; the manual path
simply reuses `POST /plan/block/advance` on the tap.

The **watcher loop** and **escalation clock** run in the service process (it's already long-lived via
`npm run serve`). `GET /plan` returns a monotonic `stateVersion` so the extension can cheaply detect
change.

---

## 9. Notifications (all three surfaces)

No server push needed — reuse the extension's existing **`TICK_ALARM`** (currently 1/min for the
badge). Each tick (shortened to ~15–20s while a budget boundary or an armed watcher is near), the
worker calls `GET /plan`, diffs `stateVersion`, and the **NotificationDispatcher** fires whatever
changed:

- **Popup / badge:** badge already shows minutes-left; extend the title/popup to show *block name +
  queue position* ("2/3 · New Project · 12m left") and colour-shift as escalation rises.
- **In-page overlay:** reuse the `brick:phase` / `brick:catch` content-script channel with a new
  `brick:switch` message → a bottom-right card: *"Time's up on A — start B?"* with **Advance / Stay**.
- **OS notification:** `chrome.notifications` (add the `notifications` permission to
  `manifest.json`) for the T‑0 and auto-complete events, so you get it even with the browser in the
  background — important for the "I'm heads-down and lose track of time" case.

Dedup by `(event, blockId, escalationLevel)` so a nudge fires once per level, not every tick.

---

## 10. Trade-offs & things I'd revisit

- **Polling vs. hooks for git.** Polling: zero install, any repo, ~30s latency. Hooks/FS-watch:
  instant but per-repo setup. → Start polling; add an opt-in watcher for the active repo later.
- **Auto-advance vs. suggest.** Auto-advancing on a met condition is what "done when I push" *means*,
  but risks a premature flip on a stray signal. → Mitigated by specific predicates (merge to main, not
  "any commit") + the 30s undo window.
- **Nested timers (block budget × Pomodoro).** Real conceptual load. → Block budget is the primary
  construct; Pomodoro is opt-out; the popup shows one primary countdown (block) with Pomodoro
  secondary.
- **Single-active-block assumption.** Keeps the adjudicator/tiers/prepend *entirely unchanged* — the
  big win. Cost: no true parallel focuses (fine for this use case; you context-switch, you don't
  split).
- **Ledger write path is net-new.** The whole design runs on `LocalPlanStore` with zero Ledger
  changes; the Ledger object is a clean, later swap. If Ledger never grows the verbs, brick still
  fully works local-first.
- **Command conditions run arbitrary shells.** Powerful (`npm test` as a stop-condition) but a foot-gun
  → opt-in, off by default, and clearly a "you configured this" surface.

---

## 11. Suggested phasing

- **Phase A — queue, no signals.** `WorkloadPlan/Block/Step` types, `LocalPlanStore`, `PlanRuntime`,
  `/plan*` routes, budgets with **manual** advance, steps. Popup renders the queue + active block.
  *(Fully testable headless — mirrors how the current service is smoke-tested.)*
- **Phase B — signal watchers.** `git` + `ledger` evaluators, watcher loop, auto-advance + undo.
- **Phase C — escalating notifications.** T-minus/T-0/grace logic + `chrome.notifications` + the
  `brick:switch` overlay across all three surfaces.
- **Phase D — Ledger-native store.** `ledger plan …` verbs in the Ledger repo + `LedgerPlanStore`;
  migrate `.data/plan.json` → Ledger. (The only phase that touches the mature app.)

Phases A–C need **no** Ledger changes and are verifiable the same way the current codebase is
(`npm run smoke`-style checks + the extension). Phase D is the deliberate, isolated mature-app step.

---

## 12. Swap policy — what actually advances the queue

Earlier the doc treated budget as *purely advisory* and stop-conditions as the only thing that
advances the queue. That's too rigid: sometimes the clock **is** the reason you switch ("2h and I'm
moving on regardless"), and sometimes you want *whichever happens first*. So each block carries an
explicit **swap policy** that composes a time trigger (the budget) with the condition trigger:

```ts
interface WorkBlock {
  // …existing fields…
  budgetMinutes?: number;
  stopConditions?: StopCondition[];
  swapMode: "condition" | "time" | "first" | "both";   // default derived (see below)
}
```

| Mode | Swaps when | Your words |
|---|---|---|
| `condition` | a stop-condition is met (per `completionPolicy`). Budget is advisory — escalates but never forces. | "swap because I pushed to GitHub" |
| `time` | the budget elapses. Conditions still *tracked* (for the done-log) but don't drive the swap. | "swap because I hit my 2h block" |
| `first` | **whichever fires first** — the condition, or the budget as a ceiling. | "swap on first push; if I haven't pushed by 2h, swap anyway" |
| `both` | **only when both** are true — a minimum-time floor plus done. | "spend at least 2h *and* don't move until I've pushed" |

`first` is the humane default when a block has **both** a budget and a condition (condition-preferred,
time as a backstop). With only a condition → `condition`; with only a budget → `time`. `both` is
opt-in for "at least N minutes here."

**Interaction with the advance-mode setting (§8.1).** Swap mode decides *what triggers* a swap; the
advance-mode setting decides *how a condition-driven swap lands* (auto-with-undo vs. light-up
"advance now"). A **time**-driven swap follows the escalating nudge sequence (§6) rather than the
undo/tap path — the clock running out is expected, so it nudges rather than silently flipping.
`first`/`both` inherit whichever trigger actually fired.

**Runtime.** The watcher loop already evaluates conditions each tick; the budget clock already ticks.
Swap policy is just the combinator over those two booleans:

```
conditionMet = policy(block.stopConditions)     // any/all
timeUp       = elapsed >= budgetMinutes
swap = { condition: conditionMet,
         time:      timeUp,
         first:     conditionMet || timeUp,
         both:      conditionMet && timeUp }[block.swapMode]
```

No new subsystem — it reuses the watcher booleans and the budget clock; only the *decision* changes.

---

## 13. Workflow templates — reusable plans

A **workflow template** is a saved, parameterized plan skeleton you can re-run without rebuilding it —
"alternate project X and Y in 2h blocks until end of day," picked from a list. If a **Bunch** sets up
your *environment* for a project (apps, windows), a template sets up your *attention schedule* — and
the two compose (a template block can name a Bunch to fire on activation).

```ts
interface WorkflowTemplate {
  id: string;
  name: string;                       // "alternating deep work"
  slots?: Slot[];                     // named project placeholders to bind at launch
  blocks: TemplateBlock[];            // the ordered pattern (may reference slots)
  pattern?: { repeat: number | "until-end-of-day" };  // expand the pattern
}

interface Slot { key: string; label: string; defaultProjectId?: string }

type TemplateBlock = Omit<WorkBlock, "id" | "focus" | "status" | "startedAt" | "completedAt" | "actualMinutes"> & {
  focusRef: { slot: string } | { projectId: string } | { task: string };
  onActivate?: { bunch?: string };    // integration seam with Bunch
};
```

**"Alternating 2h blocks on X & Y"** as a template: slots `A`,`B`; pattern
`[ {slot:A, budgetMinutes:120, swapMode:"time"}, {slot:B, budgetMinutes:120, swapMode:"time"} ]`;
`repeat: "until-end-of-day"`. At launch you bind `A → <projX>`, `B → <projY>` and it **expands** into a
concrete `WorkloadPlan`: A, B, A, B… The simple case ("save this exact plan") is just a template with
zero slots and every block pre-bound to a `projectId` — same model, no parameters.

**Lifecycle**
- `POST /plan/from-template { templateId, bindings }` → expand pattern + bind slots → new plan.
- `POST /templates` / `GET /templates` / `DELETE /templates/:id` → CRUD (stored in
  `.data/templates.json`, behind a `TemplateStore` interface exactly like `PlanStore` — local now,
  Ledger-native later, since templates are a natural Ledger object too).
- **Save current as template:** from an edited/active plan, extract structure (budgets, swap modes,
  steps, conditions), lift concrete projects into slots (offer to keep pre-bound or parameterize), and
  store. This is the fastest path to a library — build one good day by hand, then reuse it.

**Where it surfaces.** The popup's plan picker (currently project / free-text / most-recent) gains a
**templates** row; picking one either launches immediately (pre-bound) or drops into a tiny
slot-binding step ("A = which project?"). Managed on the options page alongside tiers and advance mode.

---

## 14. Gatekeeper quality (Tier-2 accuracy) — built as Epic 0

Independent of the plan layer, and sequenced **first** because it improves the tool as it's used
today. The failure it targets: an under-specified focus ("assignment" instead of "logitloom
assignment") makes the adjudicator **confidently** block an on-topic page — it doesn't know the
connection, so it returns a high-confidence `block` and the existing conservative-allow (which only
rescues *low*-confidence blocks) never fires.

**Guiding principle:** a **false block costs more than a false allow.** Blocking real work breaks
trust in the tool; a moment of leaked distraction doesn't. So when genuinely unsure, brick should
**ask or lean allow — never hard-block.** This is the same "conservative-allow / soft-nudge" ethos the
codebase already follows, extended to the ambiguous case.

Six layers, cheapest first:

### 14.1 A third outcome: `ask`

Extend the adjudicator's forced-tool schema from `allow | block` to `allow | block | ask`
(`types.ts` `Decision`; `prompt.ts` few-shot; `adjudicate.ts`). The model emits `ask` when the focus
is **too vague to judge the page against** — explicitly distinct from "confidently off-topic." `ask`
routes to the clarify overlay instead of the block page. This is the single highest-leverage change
and it's small.

### 14.2 Clarify-and-learn overlay

Reuse the existing soft-overlay surface (`brick:catch`) rather than new UI. On `ask`, a bottom-right
card: *"Not sure if logitloom.com is part of 'assignment'. On-topic?"* → **yes, on-topic** /
**no, block** / a **remember for this focus** checkbox, plus a **make focus more specific** shortcut
that re-sets the focus to a tighter string. One tap turns a wall into a teaching moment.

**Ignored `ask` → fail open.** If you don't answer the card, the page **stays loaded** (never a
silent block) and brick doesn't re-nag it this session — straight from the false-block-costs-more
principle. An `ask` is a question, not a hold.

**Symmetric pre-teach.** The same store can be written *proactively*: a **"mark on-topic"** action in
the popup (the mirror of the honesty lever, §14.6) lets you whitelist a site for the current focus
before brick ever asks. Both write the same learned store — one leaning allow, one leaning block.

### 14.3 Learned-decision store (the memory)

`.data/decisions.json`, keyed by `(focusKey, unit)` → `allow | block`, tagged with provenance
(`clarify` vs. `correction`). `focusKey = projectId ?? normalize(task)`. Consulted in `/adjudicate`
**before** calling the model: a learned hit short-circuits (returns the remembered verdict, `reason:
"learned"`), so the same target is never re-adjudicated under the same focus — which also **cuts
latency and API cost** on repeats. This is what makes 14.2 not-annoying: you answer once.

```ts
interface LearnedDecision {
  focusKey: string;
  scope: "domain" | "page";   // granularity of `unit` (see §14.7)
  unit: string;               // the domain, or a per-page key (e.g. a YouTube video id)
  decision: "allow" | "block";
  via: "clarify" | "correction";
  at: string;
}
```

**Precedence — define it explicitly** (this is a real correctness gap otherwise). When tier lists, the
learned store, and the model disagree, resolve top-down:

```
Tier-1 (always-block)  >  learned block (your correction)  >  learned allow  >  Tier-3 (always-allow)  >  model verdict
```

Tier-1 safety wins over a learned allow; a learned *block* (an explicit correction) outranks a Tier-3
always-allow, so you can veto even a normally-trusted site for a given focus. Everything unresolved
falls through to the model.

**Scope** is per entry (§14.7): most domains learn at `domain` granularity; high-variance domains
(YouTube) learn at `page` granularity so one on-topic video doesn't whitelist the whole site.

**Clear & inspect.** `POST /decisions/clear` (already listed) wipes the store; the options page shows a
small **gatekeeper readout** — counts of asks / learned-allows / corrections — so you can see whether
it's actually helping, and clear it if it drifts stale. (It's local, like `sessions.jsonl`; the clear
button is the privacy valve.)

### 14.4 Source-aware leniency

`FocusTask.source` already records origin. A bare `explicit` free-typed task has **no project context
to ground against** and is inherently error-prone; a Ledger `next-action` is well-grounded. So modulate
strictness by source: for `explicit`, prefer `ask`/lean-allow over `block`; for grounded project
focuses, keep normal strictness. A targeted heuristic, not a blunt global loosening.

### 14.5 Specificity nudge (optional, upstream)

At focus-set time, if a free-typed task is short/vague, a gentle one-liner: *"'assignment' is broad —
add a keyword so BRICK can tell what's on-topic?"* Non-blocking; prevents the problem at the source.

### 14.6 The honesty lever (user-initiated correction)

The mirror of 14.2. A popup action / in-page pill — **"mark this page off-task"** — lets you tell
brick *"we should not have been allowed to do this under the current focus."* It writes a `block`
entry to the learned store (`via: "correction"`), soft-blocks the page now, and won't allow it again
under this focus. Opt-in and self-control-dependent by nature, but a valuable way to keep yourself
honest when something slips through.

**Bonus — corrections become training data.** Both clarify answers and honesty-lever corrections are
labeled `(focus, url, decision)` examples. Append them to the existing `examples/cases.json` harness
so `npm run eval` measures accuracy against *your real corrections* over time, and the few-shot prompt
can be tuned against them. The gatekeeper gets sharper the more you keep it honest.

### 14.7 Per-page scoping for high-variance domains (YouTube)

A whole-domain verdict is wrong for YouTube: one video on p-values is on-topic for a data-science
assignment; the next auto-play might not be. Two changes make per-video judgement work:

- **The page title is the signal.** A bare URL / video id is opaque; the *title* ("p-values
  explained") is what lets the model judge topic. brick already accepts a `title` on `/adjudicate` —
  ensure the content script sends the **current** video title.
- **SPA-aware re-adjudication.** YouTube is a single-page app: navigating video→video updates the URL
  (`?v=<id>`) without a full load, so the content-guard's normal navigation hook never fires. Patch
  it to watch for `history.pushState`/`replaceState` + `popstate` (or poll `location.href`) and
  **re-adjudicate on each video change**, keyed on the video id.

Learned decisions for these domains use `scope: "page"` (unit = video id), so "yes, on-topic" for one
video doesn't whitelist YouTube wholesale. Which domains are per-page is a small configurable list
(defaults: YouTube), edited on the options page alongside tiers.

### 14.8 The rabbit-hole nudge (time, not relevance)

Per-video adjudication catches the *unrelated* drift, but not the *related-but-endless* one — you can
watch "related" videos for an hour and never do the work. That's a **quantity** problem, not a
relevance one, so it needs a different tool: a cumulative-time check-in.

Track **foreground time per flagged domain within a work session** (only while its tab is active
during a work phase). Past a threshold (configurable, default ~45–60 min), fire a check-in — *"You've
been on YouTube for an hour this session. Still productive?"* — with **keep going** / **wrap up**
(block the domain for this focus). Nudge once per threshold crossing (dedup), re-nudge each further
interval. The flagged-domain list + threshold live on the options page. This is deliberately a
*nudge*, not a block — consistent with guide-don't-coerce; it just makes the time visible.

---

## 15. Session-state feedback (border flash + sound) — built as Epic S

Independent quality-of-life win, shippable early alongside Epic 0. The toolbar badge bubble is a
*passive* at-a-glance indicator ("where am I now"); a **transition** deserves an *active*, momentary
signal you can't miss. Precedent already exists — the "1 more minute" red vignette in the content
script — so this generalizes that idea to every state change.

**Behaviour.** On a phase change, draw a **colored screen border** that persists ~10s then fades:
**red for work, green for break** (reusing `background.js` `WORK_COLOR` / `BREAK_COLOR`). Pair it with
an optional **sound**: a low "focus" tone entering work, a light twinkle entering break. Both are
**toggleable on the options page** (where tier sites are configured), with the border duration
configurable.

**How.**
- **Border:** the content script renders a fixed, full-viewport overlay — `pointer-events:none`, high
  z-index, `box-shadow: inset 0 0 0 6px <color>` — that fades in then out over the persist window. It
  uses the shared **transient-treatment primitive** (Epic U) that also backs the clarify card (§14.2)
  and the grace overlay (§16), and hangs off the **existing `brick:phase` broadcast** (`background.js`
  already messages every tab on a phase flip), so no new signal is needed. Honour
  `prefers-reduced-motion` (gentle fade, **no strobe**).
- **Sound:** the reliable MV3 path is a `chrome.offscreen` document driven by the background worker —
  audio triggered by a *timer* (not a user gesture) is subject to autoplay limits, and the offscreen
  document sidesteps that from the background context. Content-script Web Audio is the fallback for the
  focused tab. Bundle two short clips in `extension/sounds/` and add them to
  `web_accessible_resources`. Play the cue **once** (from the single offscreen doc), **never per-tab**
  — the phase broadcast reaches every tab, but only the worker makes sound. Prime the audio context
  with a **"test sound"** button on the options page: that click is a user gesture that unlocks later
  timer-fired playback (and lets you hear the cue while configuring).
- **Settings:** this is **purely client-side presentation** — no service round-trip. Store the toggles
  (sound on/off, border on/off, duration) in `chrome.storage.local` with options-page controls, which
  keeps the epic self-contained and shippable before any service-settings work.

**Reuse.** Epic C's block-swap notifications drive the *same* border/sound surface — a plan swap can
flash a distinct accent and play its own cue. Build the mechanism here; extend the palette there.

**Accessibility.** Everything toggleable; reduced-motion aware; steady fade, never a flash. Sound
defaults off until the user opts in.

---

## 16. Focus-time integrity & the grace overlay — built as Epic F

Refines the existing "just one more minute" soft overlay (the Tier-2 grace during a work phase). Two
changes that work as a pair: one removes an unfair penalty, the other adds honest friction.

**16.1 Pause the work clock during grace.** Today, minutes spent on the grace overlay (off-task,
mid-work) are silently eaten from the work block — click "one more minute" twice on a 10-min block and
you start real work with only 8 left. Instead, **pause the work-phase countdown while the grace
overlay is active** and resume when you return to task, so the block always delivers its **full
budgeted minutes of actual focus**.

- **Mechanism:** on entering grace, record `graceStart`; on exit (dismiss / navigate back on-task /
  grace expiry + return), push `phaseEndsAt` forward by the paused duration and re-arm the
  `chrome.alarms` phase alarm. The existing reconcile logic already advances `phaseEndsAt`, so this is
  the same move in reverse.
- **Safeguard:** pausing indefinitely would mean work never *ends* (self-defeating). Cap total grace
  per block (configurable); past the cap, the escalation in 16.2 has effectively maxed out and the
  page hard-blocks. So "you keep your minutes" never becomes "you never work."
- **Budget analog:** the same principle extends to the workload layer — a **block budget** (§3) should
  likewise pause while you're off-task during that block, so "2h on Project X" means two hours of X,
  not two hours of wall-clock. (Wire it when Epic A lands; the grace mechanism is shared.)

**16.2 Escalating opacity per grace click.** Each "one more minute" *within the same work block*
deepens the red overlay: first is a casual tint, the next more opaque, each further one heavier —
making continued avoidance progressively harder to sit with. It **resets to the lightest tint at the
next work block**, so a fresh start is fresh; only *repeated* dodging within one block escalates.

- **Mechanism:** track `graceCount` in the work-phase state; overlay opacity = `f(graceCount)`, reset
  on the work→(break→)work transition. Uses the Epic U transient-treatment primitive (opacity is just
  a parameter).
- **Guardrails:** cap max opacity (never a full black-out; the **"back to work"** button stays visible
  and clickable at every level), and honour `prefers-reduced-motion` (deepen the tint, don't animate
  harshly).

Together: **16.1 says "I won't steal your work minutes," 16.2 says "but I'll make doom-scrolling
increasingly uncomfortable."** The penalty moves from your work budget (unfair) to the felt cost of
avoidance (honest).

---

## 17. Model provider — OpenRouter + configurable adjudicator model — built as Epic R

Motivation: one API key for many models, switch the adjudicator model from the options page, get
provider failover, and tune cost/latency without code changes. Replaces the hardcoded Anthropic SDK
path in `adjudicate.ts` (which today does forced tool use via `tool_choice: { type:"tool" }`).

### 17.1 Provider seam

Extract the single model call behind a thin interface so the rest of `adjudicate.ts` (canary check,
conservative-allow, shield) is provider-agnostic:

```ts
interface VerdictProvider {
  recordVerdict(a: { system: string; user: string; tool: VerdictTool; model: string }):
    Promise<{ verdict: RawVerdict; text: string; modelUsed: string }>;
}
```

- **`OpenRouterProvider` (default)** — the `openai` SDK pointed at `https://openrouter.ai/api/v1` with
  `OPENROUTER_API_KEY`. Forced tool via OpenAI shape `tool_choice: { type:"function", function:{ name:
  "record_verdict" }}`. **Parsing differs:** the verdict comes back as a JSON *string* in
  `choices[0].message.tool_calls[0].function.arguments` → `JSON.parse` defensively (malformed → fail
  open, mirroring the existing `NaN confidence → 0` guard).
- **`AnthropicProvider`** — the current native path, **kept as a config option** (one less hop for
  Claude models, and it already works). Selected by `BRICK_PROVIDER` (`openrouter` default) + key
  presence.

`text` carries any assistant non-tool text so the **canary/shield check still runs** — note that under
forced tool calls the OpenAI `message.content` is often `null`, so the port must read
`content ?? ""` (plus any reasoning field) rather than assuming a text block exists. Leak → suppress
verdict, unchanged.

### 17.2 Configurable model

The model id moves from the `BRICK_MODEL` env into **settings** (`.data/settings.json` + `/config`),
editable on the options page — a free-text OpenRouter id (`anthropic/claude-haiku-4.5`,
`openai/gpt-5-mini`, …) with a few presets. Sent per-request; `BRICK_MODEL` stays as the default seed.
Because the model is now a knob, use the existing **`npm run eval`** harness to compare models on your
real cases before committing — it becomes your model chooser.

### 17.3 Downsides of OpenRouter (grounded) — and why they're acceptable here

- **Fee.** ~5.5% on credit *purchases* with a **$0.80 floor** (so a small $5 top-up is effectively
  ~16%; it normalizes toward 5.5% at ~$15+ loads); token inference passes through at provider rates,
  no per-token markup. Negligible at brick's low call volume.
- **Extra hop.** One more network hop and dependency; the adjudicator targets <500ms so latency
  matters a little, and an OpenRouter outage means no adjudication — but brick **fails open** (a
  down/erroring adjudicator degrades to *allow*, never a hard block), so an outage is graceful, in line
  with the false-block-costs-more principle.
- **Privacy.** Prompts/completions are **not logged by default**, but requests transit a third party;
  enabling the model-training toggle, or routing to a provider that logs, changes that. brick already
  sends only origin+path (no query strings) + focus + title — low-sensitivity — but **keep the
  training toggle off** and prefer non-logging providers.
- **Per-model tool reliability.** Forced `tool_choice` is supported, but weaker/free models are
  flakier at honoring a forced function call, returning valid JSON args, and giving a sane numeric
  `confidence` (which conservative-allow depends on). So "configurable model" means picking models
  that do structured/forced tools well — validate each with `eval`.
- **New parse failure mode.** JSON-string args (vs. Anthropic's structured object) add a malformed-
  output path — guard it and fail open.

**Net:** for a low-volume, low-sensitivity, fail-open adjudicator, the downsides are minor and the
single-key / model-switching / failover flexibility is a large ergonomics win. Recommended, with the
Anthropic-direct provider retained as a fallback.

---

## 18. In-app help agent (usage Q&A) — built as Epic H

**Today the model in the browser is a headless adjudicator** — you don't converse with it; it takes a
URL + focus and returns a verdict. The only conversational focus agent lives in Ledger. So there's no
way to ask brick itself *"how do I add a Tier-1 site?"* or *"what does `swap = first` mean?"* This adds
a small **grounded help assistant** — the brick analog of Claude Code's `claude-code-guide` — that
answers *how to use the app* from the app's own docs.

### 18.1 Grounded, not free-form

Like `claude-code-guide`, it answers from a **curated help corpus**, never open-ended generation: a
distilled how-to/FAQ drawn from `README.md`, `EXTENSION.md`, and this design (tiers, swap modes,
advance mode, provider/model, focus-time, gatekeeper, sessions/plans, templates). If an answer isn't
in the corpus it **says so and points to the doc** — it must not invent config that doesn't exist. The
corpus is small, so no vector DB: light keyword retrieval over a `help/` doc set, inject the relevant
chunks as context.

### 18.2 Surface & provider

A **"ask about BRICK"** affordance (a `?` in the popup / a panel on the options page) opens a small
chat box. It calls the **same provider/model seam from Epic R** — a normal chat completion (no forced
tool) with a help system prompt + retrieved corpus. New service route:
`POST /help { question, history? } → { answer, sources }`. Distinct from `/adjudicate` (different
prompt, conversational, cites which doc section it used).

### 18.3 Optional — situated answers (read-only state tools)

A step past a static manual: give the help agent **read-only** access to brick's own state so it can
answer *"what am I focused on right now?"*, *"which sites are blocked?"*, *"why was X blocked?"* — via
a few tools (`get_config`, `get_plan`, `get_learned_decisions`) with `tool_choice:"auto"`. **Read-only,
never mutates.** This is what turns it from a manual into an assistant. Ship it as a fast-follow;
docs-Q&A is the v1.

### 18.4 Shared corpus with Ledger

You want this in Ledger too. Make the help corpus the **shared source of truth** (the `help/` doc set)
that both the brick extension surface *and* **Ledger's focus agent** load — so "how do I use brick?"
answered in Ledger matches the extension, and Ledger adds its own usage docs for ledger-specific
questions. The Ledger side is a separate-repo change (like Epic D); brick ships the corpus + its own
surface and exposes the `/help` route for Ledger to reuse.

### 18.5 Privacy & honesty

Help questions go to the configured provider (OpenRouter) like adjudication — same low-sensitivity
posture; keep the training toggle off. Situated tools read **local state only**. And keep v1 scope
tight: this is a real new surface (a chat UI + route), not a tweak — docs-Q&A first, situated tools
second.

---

## Appendix A — stop-condition predicate schema (detail)

A stop-condition is a **predicate over a signal source**, evaluated by a matching evaluator on the
watcher tick. Each evaluator follows the same contract:

```ts
interface Evaluator {
  arm(block: WorkBlock, cond: StopCondition): Promise<void>;  // capture a baseline at block start
  poll(): Promise<boolean>;                                   // true == met (monotonic, fail-open)
}
```

Rules every evaluator obeys: capture a **baseline** when the block activates; only report `met` on an
**unambiguous forward change** from that baseline; on any error return `false` (never falsely
complete); once `met`, stay met (a flapping signal can't un-complete a block).

### `git`

```ts
{ type: "git", repoPath: string, predicate:
    | { kind: "head-advanced"; ref?: string }     // default ref = "origin/main"
    | { kind: "merge-commit"; intoRef: string }
    | { kind: "message-match"; regex: string } }
```

- **arm:** record `git -C <repoPath> rev-parse <ref>` (the baseline SHA) and current time.
- **poll:**
  - `head-advanced` → SHA differs from baseline.
  - `merge-commit` → `git log --merges --since=<armTime> <intoRef>` is non-empty.
  - `message-match` → any commit subject since `armTime` matches `regex`.
- **latency:** ~poll interval (default 30s). **risk:** broad predicates over-trigger — prefer
  `merge-commit`/`message-match` over bare `head-advanced` for "done when I ship."

### `ledger`

```ts
{ type: "ledger", projectId: string, on: "next-action-change", from?: string }
```

- **arm:** capture the project's current `nextAction` (via the existing `fetchProjects()`), or use
  `from` if provided.
- **poll:** `nextAction !== baseline` → met. Advancing the project in Ledger *is* the completion
  signal, which keeps the keystone property intact (the block's "done" is a Ledger fact).
- **cost:** one `status --json` call per tick — **no new integration surface.**

### `command`

```ts
{ type: "command", cmd: string, cwd?: string, expectExit?: number }   // expectExit default 0
```

- **poll:** run `cmd` in `cwd`; met when exit code `=== expectExit`. Enables "done when tests pass."
- **safety:** runs an arbitrary shell → **off by default**, gated behind an explicit
  `BRICK_ALLOW_COMMAND_CONDITIONS` flag, and surfaced in the UI as a user-configured action.

### `manual`

```ts
{ type: "manual" }
```

- No poller. `met` flips when the user taps "done" (popup / in-page overlay → `POST
  /plan/block/complete`). **Always available**, even when auto-signals are configured — the escape
  hatch.

### Combining conditions

A block's `completionPolicy` (`"any"` default | `"all"`) decides how multiple conditions combine, and
`steps` act as an additional gate if present. Completion = `stepsGate && policy(conditions)`. **Budget
is never part of this** — it only drives the escalating switch nudge (§6). On completion, a met
auto-signal advances the queue with a 30s **undo window**.

---

## Appendix B — popup UI (queue + active block)

The popup keeps its terminal aesthetic (`popup.html`), extended from single-focus to plan-aware. Top
to bottom:

- **Header** `■ BRICK MODE` + a plan strip: `plan · today` / `block 2 / 3`.
- **Escalation banner** (amber, conditional): appears at T-minus and on overrun —
  *"budget ends in 5 min · next: grant outline"*.
- **Active block card:** the block-budget countdown (primary timer), the focus line, the live
  **stop-condition** with a `· watching` indicator, and the **steps** checklist (tap to toggle →
  `POST /plan/block/step`).
- **Queue list:** each block with state glyph — ✓ done (with actual time), ▶ active, ○ pending
  (budget + `↻` if it repeats).
- **Controls:** `advance now →` (complete/skip active → next) and `■ end plan`. In **manual**
  advance mode, when a stop-condition is met the `advance now` button **glows ready** (and the
  stop-condition line reads `· ready`) instead of the queue moving on its own; in **auto** mode a
  brief `undo` affordance replaces it for `undoWindowSec` after a switch.

The toolbar **badge** stays the at-a-glance signal: minutes-left in the active block, colour-shifting
as escalation rises; title shows `2/3 · Lab analysis · 5m left`. The Pomodoro micro-timer, when
enabled for a block, renders as a secondary line under the block budget.

