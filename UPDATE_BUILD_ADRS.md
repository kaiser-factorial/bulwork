# BRICK MODE — Update Build: Architecture & ADRs

**Status:** Proposed (living draft — grows as user-test notes come in)
**Date:** 2026-07-09
**Deciders:** Corina
**Source:** user-testing the merged plan layer (master @ `1e42335`)

> This is a working document. It captures the design for the post-plan-layer update build as
> Corina drops notes from live testing. Two full ADRs (the intent-scoped exception subsystem, and
> the richer block editor) plus a batch of smaller, lower-risk decisions. Sequencing at the bottom.

---

## Scope of this build (notes so far, grouped)

**Theme 1 — actions don't confirm themselves (feedback visibility)**
- Starting a day plan gives no clear "it worked" signal in the popup (badge updates; popup transition is ambiguous).
- The honesty-lever (mark off-task / on-topic) only flashes a "✓" then auto-closes (~0.8s) — no lasting indication; no "already logged" state.

**Theme 2 — the quick `task | minutes` textarea can't express block richness that already exists underneath**
- Sub-tasks per block → **already exist as `WorkBlock.steps`** (modeled, API-writable, rendered as a clickable checklist); the textarea just can't create them.
- Per-block Pomodoro → the plan-wide work/break cycle already runs *inside* a block; what's missing is *per-block* control.
- Repeat → in the model + rendered (`↻`), but the textarea has no syntax for it; and no end-of-plan summary.

**Theme 3 — always-blocked (Tier-1) is the one purely-binary surface, and it's too strict for legitimate scoped needs**
- Real case: an Instagram DM with a hackathon link during a work block — a narrow, time-bounded, legitimate task, hard-blocked with no recourse. Wants an intent-declared, bounded exception with agentic check-ins.

**Carryover from deep verification**
- `mintBlock` (plan-start / from-template) lacks the positive-budget guard that `editPlan` got.

---

## ADR-001: Intent-scoped exceptions for always-blocked (Tier-1) sites

**Status:** Proposed · **Risk:** High (touches the enforcement backbone + core thesis)

### Context

Tier-1 sites are always blocked during a work phase via static `declarativeNetRequest` redirect
rules — no adjudication, no negotiation. That bluntness *is* the feature: an un-negotiable wall is
hard to rationalize your way past, which is the whole "genuinely hard to bypass" promise.

But blunt is sometimes wrong. The triggering case: a friend sends an Instagram DM with a hackathon
link mid-work-block. Opening that DM, following the link, and briefly reading about a hackathon you
may attend is legitimate, narrow, and time-bounded — yet Tier-1 hard-blocks it with no recourse, so
the only options today are "end the session" or "miss it."

Three distinct failure modes must be guarded against if we allow *any* exception:
1. **Loiter** — you open IG for the DM but slide into the feed / explore / reels.
2. **Forget** — you open it and never get back to work in a reasonable time.
3. **Rabbithole** — after the legitimate hop you drift: "what else does this company do?", "what
   other events are on this site?" These are *valid questions* — the hard part is that on-intent
   research and diminishing-returns drift look similar and blur into each other.

**The core tension:** Tier-1's value is that it does not negotiate. Any exception mechanism risks
becoming a one-tap bypass that hollows Tier-1 out. So an exception must (a) reuse the *intent-aware*
core (the thesis), not a dumb allowlist, and (b) carry real friction + hard bounds + logging.

### Decision

Add a **scoped exception**: on a Tier-1 block page, the user can request a bounded, intent-declared
exception. The service mints a **temporary intent override** — a time-boxed sub-focus with a stated
micro-intent — suspends the Tier-1 rule for *only the requested domain* for the window, and routes
every navigation (on that domain and any outbound hop) through the adjudicator, judged against the
*stated micro-intent* rather than the block's focus. The exception ends on the earliest of: time
budget, a rabbithole/depth wrap-up, a manual "done," or a drift-block.

**Drawing the productive-research vs. rabbithole line — layered backstops, not a fixed rule.** Each
backstop catches a different failure above, and each reuses machinery BRICK already has:

| Backstop | Catches | Reuses |
|---|---|---|
| Per-navigation intent adjudication (temp focus = the micro-intent) | Loiter, drift (feed/explore, unrelated company pages) | Tier-2 adjudicator, learned store, clarify overlay |
| Hard time budget + escalation | Forget ("never came back") | Block-budget clock + escalation ladder (§6/Epic C) |
| Depth / foreground-time nudge | Rabbithole (productive-but-endless) | Rabbit-hole nudge (Epic 0.8) + a hops-from-anchor counter |
| *(v2, opt-in)* screenshot compliance | Anything the above miss | Original screenshot-monitoring concept |

Net behavior: on-intent + inside the window → silent allow; drift → re-adjudication catches it;
endless-but-related → the nudge checks in ("still on the hackathon, or wrapping up?"); forgotten →
the budget expires and Tier-1 snaps back.

**Friction that preserves bypass-resistance** (this is what keeps it from hollowing Tier-1):
- **Required intent statement** (free text) — you must articulate the purpose. It is simultaneously
  the speed-bump, the adjudication anchor, and a labeled training example (feeds local FT).
- **Short forced pause** before the grant (a few-second countdown; configurable) — deliberate
  friction in the spirit of Cold Turkey / config-lockdown.
- **Hard cap per work block** (default 1–2) and/or a cooldown — an exception is a rare tool.
- **Domain-scoped, never global** — only the requested Tier-1 domain is suspended, and only its
  in-scope paths survive intent adjudication (e.g. `instagram.com/direct/*` passes, `/explore`
  reads as off-intent and is caught). Path-scope the DNR suspension where feasible.
- **Fail-safe expiry** — the suspension is time-boxed *and* cleared on service restart / worker
  wake, so a crash can never leave Tier-1 quietly open.
- **Full logging** — every grant, its intent, its outcome, and any drift-blocks append to the audit
  log + eval corpus.

### Options Considered

#### Option A — Temporary intent override via the existing adjudicator *(recommended)*
Exception = a time-boxed sub-focus; suspend the domain's Tier-1 DNR rule for the window; adjudicate
every navigation against the micro-intent, reusing Tier-2 + learned store + rabbit-hole nudge +
budget/escalation.

| Dimension | Assessment |
|---|---|
| Complexity | Med–High (a temp-override state machine in the enforcement path) |
| Cost | Low (a few more adjudication calls during a rare, short window) |
| Bypass-resistance | Preserved (friction + caps + domain scope + fail-safe expiry) |
| On-thesis | High — intent-aware, and the intent log is prime FT data |

**Pros:** reuses ~90% of existing machinery; the backstops fall out of components that already
exist; logged and trainable; deepens the product's core differentiation.
**Cons:** leans on adjudicator accuracy for drift detection; dynamic DNR suspend/re-arm needs
careful lifecycle handling; more moving parts on the block/enforcement path.

#### Option B — Static timed allowlist (dumb "allow 5 min")
One tap temporarily whitelists the domain; no intent, no per-nav judgement.

**Pros:** trivial to build; fully predictable.
**Cons:** *exactly* the hollow-out-Tier-1 failure — a one-tap bypass; zero drift/rabbithole
protection; off-thesis. **Reject.**

#### Option C — No exceptions; tighten tiers instead *(status-quo+)*
Keep Tier-1 absolute; handle such needs by pre-planning (move a site to Tier-2 for certain blocks,
or use a break).

**Pros:** preserves the hard wall; zero new bypass surface.
**Cons:** doesn't serve the real workflow; pushes legitimate 2-minute tasks to breaks/session-end;
the exact rigidity that surfaced in testing. **Reject as the sole answer** — but keep its
conservatism as the *default posture*: exceptions are opt-in, capped, and a plan/block can forbid
them entirely.

#### Option D — Screenshot-first compliance
Grant liberally; police with periodic vision checks against the stated intent.

**Pros:** strong intent verification.
**Cons:** privacy-heavy, adds cost/latency, feels surveillant for daily use; overkill when
re-adjudication + budget already cover the named cases. **Defer to a v2 opt-in escalation.**

### Trade-off Analysis

The decision hinges on **bypass-resistance vs. legitimacy**. Option B maximizes convenience and
destroys the wall; Option C maximizes the wall and ignores real workflow. Option A threads them:
convenience is *earned* through friction (intent + pause + cap) and *bounded* by the backstops, so
the wall stays meaningful while a narrow legitimate need is served. The residual risk in A is
adjudicator accuracy on "drift," mitigated because A also has the time budget and depth nudge as
non-AI backstops — even a wrong allow can't run forever. Screenshots (D) are the accuracy upgrade
if drift-detection proves too loose, held back for privacy/cost until real usage says it's needed.

### Consequences

- **Easier:** legitimate scoped access without nuking the session; the intent+outcome log becomes
  rich, labeled training data (direct win for the local-FT roadmap); the product's intent-aware
  thesis now covers even the always-blocked case.
- **Harder:** the enforcement path gains a temporary-override lifecycle (suspend → adjudicate →
  expire/re-arm DNR), with careful crash/restart fail-safety; more adjudication calls; new UI on the
  block page.
- **Revisit:** default window/cap/cooldown after real usage; whether drift should soft-nudge or
  hard-block; whether screenshots (D) earn their keep.

### Action Items
1. [ ] `types.ts`: `ExceptionGrant { domain, intent, startedAt, budgetMinutes, hopsFromAnchor, status }`.
2. [ ] `session.ts` / `adjudicate.ts`: a temp sub-focus path so `focusFor()` yields the micro-intent while a grant is live (per-call task still can't hijack it).
3. [ ] `server.ts`: routes `POST /exception/request` (with forced-pause + cap check), `/exception/end`, and grant state in `GET /session`; log grants + outcomes.
4. [ ] `background.js`: block-page "request a scoped exception" flow; **path-scoped** DNR suspend + **re-arm on expiry / worker wake / restart** (fail-safe).
5. [ ] `block.html` / `block.js`: intent-statement UI + countdown + "the honest friction" copy.
6. [ ] Reuse Epic 0.8 rabbit-hole nudge + a hops-from-anchor counter for the depth backstop; reuse the escalation ladder for the time backstop.
7. [ ] `config-store.ts` settings: per-block/plan `allowExceptions`, cap, cooldown, default window.
8. [ ] Append grants/outcomes to `examples/cases.json` (eval + FT corpus).
9. [ ] *(v2, gated)* screenshot compliance check.

---

## ADR-002: Richer block editor — surface block richness that already exists

**Status:** Proposed · **Risk:** Low–Med (mostly UI; data model largely present)

### Context

Three testing notes — sub-tasks, per-block Pomodoro, repeat — share one root cause: the quick
`task | minutes` textarea is a deliberately minimal entry point, but the engine underneath already
supports far more. **Steps (sub-tasks) already exist** — modeled on `WorkBlock`, API-writable, and
rendered in the popup as a clickable `☐/☑` checklist under the active block. **Pomodoro already runs
inside a block** — the plan-wide work/break cycle nests inside the block budget. **Repeat** is
modeled and rendered (`↻`). None of it is reachable from the textarea.

### Decision

Introduce a per-block editor that surfaces what's already built: **steps/sub-tasks**, **per-block
Pomodoro** (on/off + optional custom work/break), and **repeat** — with stop-conditions/swap-mode as
a later expansion. Add the one genuinely missing data field: `WorkBlock.pomodoro?` so a block can
override the plan-wide cycle; `anchorSession` resolves `block.pomodoro ?? plan.pomodoro` (the
extension already reads the anchored session's work/break, so this is mostly a service-side change).

### Options Considered

- **Option A — Extend the textarea mini-language.** e.g. `LoveSmarter | 50 | pomodoro:off | repeat`
  with indented `- gather notes` / `- confirm hypotheses` lines for steps.
  *Pros:* tiny UI change; fast to type; power-user friendly. *Cons:* discoverability is poor; easy to
  get the syntax wrong; doesn't scale to stop-conditions.
- **Option B — Structured form UI.** "Add block" rows with fields (task, minutes, a steps list,
  a Pomodoro toggle, a repeat checkbox). *Pros:* discoverable, self-documenting, scales. *Cons:* more
  popup real estate + build effort.
- **Option C — Hybrid *(recommended)*.** Keep the textarea for fast quick-add, add an **"edit block"**
  expander per block that opens the structured fields for richness. *Pros:* preserves fast entry,
  makes depth discoverable, incremental to build. *Cons:* two entry paths to keep coherent.

**Recommendation:** C. Ship steps + per-block Pomodoro + repeat first (they're modeled/rendered
already); stop-conditions/swap-mode as a follow-on in the same expander.

### Consequences
- **Easier:** "gather notes / confirm hypotheses / run demos" under LoveSmarter and "test TTS / try
  lesson" under Build become first-class; per-block focus rhythm; opt-in repeat with a visible `↻`.
- **Harder:** the popup grows a small editor; keep textarea and form in sync.
- **Revisit:** whether the textarea mini-language is worth keeping once the form exists.

### Action Items
1. [ ] `types.ts`: `WorkBlock.pomodoro?: { enabled?: boolean; workMinutes?: number; breakMinutes?: number }`.
2. [ ] `plan-runtime.ts` `anchorSession`: resolve `block.pomodoro ?? plan.pomodoro`.
3. [x] `popup.js`/`popup.html`: **sub-tasks via textarea quick-add** — lines starting with `-`/`•`/`*` become block steps (*shipped 2026-07-09 for testing*). Still to do: a per-block "edit" expander for Pomodoro toggle+durations and repeat.
4. [ ] `server.ts` `/plan/start` + `/plan/block/step` already accept steps; extend the block parse to accept per-block pomodoro + repeat from the editor.
5. [ ] End-of-plan summary state (see B1) so a finished plan doesn't silently drop to the picker.
6. [x] Steps render **lit when open, dull + struck when checked off** (*shipped 2026-07-09*).
7. [ ] **Label the two nested clocks in the popup.** The block **budget** (e.g. 50m) and the
   **Pomodoro** phase countdown (25m default) show as separate numbers with no labels, reading as
   one confusing figure ("did it double the pomos?"). Show both distinctly, e.g. `pomodoro 24:12 ·
   budget 47m left`, and pair with per-block Pomodoro control (items 1–2).

---

## Batch decisions (smaller, lower-risk)

### B1 — Plan-start confirmation + end-of-plan summary
The popup *does* flip to the live view on a successful start, but the inputs vanish with no
affirmation, so it reads as ambiguous; and when the queue exhausts it silently returns to the picker.
**Decision:** add an explicit "▶ day plan started — block 1/N" confirmation on start and a "plan
complete — N blocks, Xm focused" summary on end. Pending Corina's observation of whether the popup
reliably shows the live timer+queue post-start (distinguishes a polish gap from a state-sync bug).
*Files:* `popup.js` (`render`/`renderPlan`), maybe a transient banner.

### B2 — Honesty-lever feedback state
Today: transient "marked ✓" + ~0.8s auto-close. **Decision:** reflect *persistent* learned-decision
state on the buttons — when the current site is already logged for the active focus, grey out /
relabel ("already off-task for this focus"). *Files:* `popup.js` (query learned store for
focus+site on open), `server.ts` (a lookup the popup can call), `background.js` message.

### B3 — Budget guard (carryover)
Mirror `editPlan`'s positive-number guard in `mintBlock` so a `0`/negative budget can't create an
instantly-over-budget block. *Files:* `plan-runtime.ts` (`mintBlock`) and/or `server.ts` boundary.
Low effort, do it alongside anything touching `plan-runtime.ts`.

---

## Sequencing & dependencies

1. **B3 budget guard** — trivial, land first (it's a one-liner in the path ADR-002 also edits).
2. **ADR-002 richer block editor** — unblocks the most notes (sub-tasks, per-block Pomodoro, repeat)
   and is low-risk; `block.pomodoro` + the popup editor.
3. **B1 + B2 feedback fixes** — independent, UI-only; fold in with ADR-002's popup work.
4. **ADR-001 scoped exceptions** — the big one; largely independent of the above (adjudicator +
   enforcement path + block page). Build after the batch so the plan-layer surface is settled first.
   Its own internal order: types → service (grant lifecycle + temp focus) → DNR suspend/re-arm
   (fail-safe) → block-page UI → backstop reuse (nudge/budget) → logging/eval → *(v2)* screenshots.

Everything here is verifiable the way the codebase already is (`npm run smoke` + the extension); only
ADR-001's live drift behavior needs real browsing to tune.

## Open questions / to revisit
- ADR-001: default exception window, per-block cap, cooldown — set after real usage.
- ADR-001: drift = soft nudge or hard block? Lean nudge-first (guide-don't-coerce), block on repeat.
- ADR-002: keep the textarea mini-language once the form exists, or retire it?
- B1: is the post-start popup gap a missing affirmation or a real state-sync bug? (needs Corina's look)
