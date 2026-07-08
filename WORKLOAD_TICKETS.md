# BRICK MODE — Workload tickets

Build plan for the workload / day-plan layer (design: `WORKLOAD_DESIGN.md`). Sequenced into five
epics. **Each epic ends with a verification gate — a checklist you run yourself before calling the
phase done and starting the next.** Tickets inside an epic can be built in order; the gate is the only
hard sign-off boundary.

Conventions used below:
- **Files** = where the change lands (all paths relative to `brick/`).
- **AC** = acceptance criteria (what "the ticket works" means).
- **Verify** = the concrete check for that ticket.
- Automated checks reuse the existing harness: `npm run typecheck`, `npm run build`,
  `npm run serve`, `npm run smoke` (build + `scripts/smoke.mjs`).
- 🖐 = a manual step only you can do (needs a browser, a real git repo, or Ledger).

Dependency order: **U → (R → 0, R → H, S, F) → A → (T, B can start once A lands) → C → D.** Epic U
(shared overlay primitive) is a tiny extension-side prelude that the clarify card, session border, and
grace overlay all build on — land it first to kill the merge seam between the extension tickets. Epic R
(OpenRouter provider) precedes Epic 0 because both edit `adjudicate.ts` and the verdict tool — do the
provider seam first, then 0.1 adds the `ask` outcome onto it. Epic H (help agent) also depends on R
(reuses the provider for a chat call) but is otherwise parallel. Epics R, 0 (gatekeeper), H (help
agent), S (session-state feedback), and F (focus-time integrity) are the early wave, independent of the
plan layer; only the **extension-side** tickets depend on U. T and B are independent of each other; C
depends on B (and reuses S/U); D is last and is the only epic that touches the Ledger app.

**Parallelism note (solo build):** the service side (`R*`, `0.1, 0.2, 0.4, 0.6` — all `src/*` +
`cases.json`) has near-zero file overlap with S/F/U (all `extension/*`), so those tracks run
concurrently. Within the service lane, `adjudicate.ts` is shared by R and 0.1 → sequence `R1 → 0.1`.
The extension files (`content-guard.js`, `background.js`) are the other shared surface — Epic U's
primitive is what lets 0.3, S1, and F1/F2 layer on without stepping on each other. (R's one extension
touch — the options-page model picker — is on `options.html/js`, clear of the overlay files.)

---

## Epic U — Shared overlay primitive (prelude)

Goal: one reusable "transient screen treatment" in the content script that the clarify card (0.3), the
session border (S1), and the grace overlay (F1/F2) all use — so they don't each re-implement
full-screen rendering and don't collide in `content-guard.js`. Tiny; land it first. Design threads
through `WORKLOAD_DESIGN.md` §14.2 / §15 / §16.

### BRICK-U1 · Transient-treatment helper
- **Files:** `extension/content-guard.js` (extract the existing "1 more minute" vignette into a shared
  helper), optionally `extension/overlay.js` (new shared module)
- **Scope:** a single function that renders a fixed, `pointer-events:none`, high-z-index full-viewport
  layer with parameters: color, opacity/level, persist duration (or sticky), optional inner card
  (buttons). Fade in/out; honour `prefers-reduced-motion`; safe to call repeatedly (replaces, never
  stacks).
- **AC:** the existing grace vignette is reimplemented through the helper with no behaviour change;
  calling it with different colors/opacities produces border-only vs. filled treatments; never blocks
  page clicks unless an inner card is present.
- **Verify:** 🖐 the current "1 more minute" overlay still looks/behaves the same; a scratch call with
  green + border-only renders correctly.

### ✅ Phase U verification gate
- [ ] Existing grace overlay behaves exactly as before (regression).
- [ ] The helper renders border-only, filled-tint, and card variants from parameters alone.
- [ ] Repeated calls replace rather than stack; `prefers-reduced-motion` respected.

---

## Epic R — OpenRouter provider + configurable model

Goal: one key for many models, switch the adjudicator model from the options page, provider failover.
Mostly `src/*` (parallel with the extension epics); precedes Epic 0 in the service lane (shared
`adjudicate.ts`). Design: `WORKLOAD_DESIGN.md` §17.

### BRICK-R1 · Provider seam + OpenRouter impl
- **Files:** `src/adjudicate.ts` (refactor the model call behind `VerdictProvider`),
  `src/providers/*.ts` (new: `openrouter.ts`, `anthropic.ts`), `package.json` (add `openai`)
- **Scope:** `OpenRouterProvider` via the `openai` SDK at `https://openrouter.ai/api/v1`
  (`OPENROUTER_API_KEY`), forced `tool_choice:{type:"function",function:{name:"record_verdict"}}`,
  parse `tool_calls[0].function.arguments` (JSON string) defensively. Keep `AnthropicProvider` as a
  selectable path (`BRICK_PROVIDER`, default `openrouter`). Port the canary check to read
  `message.content ?? ""` (content is often null under forced tool calls).
- **AC:** adjudication returns a valid structured verdict via OpenRouter; the Anthropic path still
  works when selected; conservative-allow + canary/shield behave exactly as before.
- **Verify:** `npm run eval` through OpenRouter returns structured verdicts on real cases; flip
  `BRICK_PROVIDER=anthropic` → still works; `npm run smoke` green (key-free stub path unchanged).

### BRICK-R2 · Configurable model (options page)
- **Files:** `src/config-store.ts` (model in settings), `src/server.ts` (`/config`,
  `/config/settings`), `extension/options.html/js`
- **Scope:** move the model id from the `BRICK_MODEL` env into `.data/settings.json`; options-page
  control = free-text OpenRouter id + a few presets; sent per-request; env stays as the default seed.
- **AC:** changing the model in options makes the next adjudication use it; `GET /config` reflects it.
- **Verify:** 🖐 set a model in options → `curl /adjudicate` shows `model` = the chosen id; a bad id
  fails open (allow), not a crash.

### BRICK-R3 · Robustness / fail-open on provider output
- **Files:** `src/adjudicate.ts`, `src/providers/*`
- **Scope:** malformed JSON args, missing tool call, or provider/network error → **fail open** (allow),
  logged; keep the `NaN confidence → 0` + conservative-allow guards.
- **AC:** a simulated bad/empty provider response yields `allow` (never a hard block or throw).
- **Verify:** inject a malformed response in a unit test → `allow` with a clear reason; provider
  timeout → `allow`.

### BRICK-R4 · Eval across models *(optional)*
- **Files:** `src/eval.ts` / `scripts/`
- **Scope:** run the case set against N models, report accuracy + latency per model, so the config
  choice is data-driven.
- **AC/Verify:** `npm run eval` compares ≥2 models and prints a per-model table.

### ✅ Phase R verification gate
- [ ] `npm run typecheck` + `npm run build` clean; `npm run smoke` passes.
- [ ] 🖐 `npm run eval` adjudicates real cases through OpenRouter with structured verdicts.
- [ ] 🖐 Model switch from the options page takes effect on the next adjudication.
- [ ] 🖐 `BRICK_PROVIDER=anthropic` still adjudicates (fallback intact).
- [ ] Malformed/absent provider output and provider outages **fail open** to allow (never hard-block).
- [ ] Canary/shield suppression still fires on a leak under the new response shape.

---

## Epic 0 — Gatekeeper quality (Tier-2 accuracy)

Goal: stop confident false-blocks on under-specified focuses. Turn "I can't tell" into a question,
remember your answer, and let you correct mistakes. Independent of the plan layer — **build first.**
Design: `WORKLOAD_DESIGN.md` §14.

**Intra-epic order:** `0.1 → 0.2 → (0.3, 0.5, 0.7, 0.8)`, then `0.4` and `0.6` any time. The store
(0.2) is the backbone the overlay, lever, per-video, and nudge all write to. Extension-side tickets
(0.3, 0.5, 0.7, 0.8) also depend on Epic U.

### BRICK-0.1 · `ask` outcome in the adjudicator
- **Files:** `src/types.ts`, `src/prompt.ts`, `src/adjudicate.ts`, `src/server.ts`
- **Scope:** extend `Decision` to `allow | block | ask`; teach the few-shot prompt when to emit `ask`
  (focus too vague to judge, ≠ confidently off-topic); `/adjudicate` passes `ask` through with a flag
  the extension can act on.
- **AC:** the forced-tool schema accepts `ask`; a deliberately vague focus + plausibly-related URL
  yields `ask`, not `block`.
- **Verify:** `npm run eval` on a few hand-written vague-focus cases returns `ask`; `curl /adjudicate`
  shows the `ask` verdict shape.

### BRICK-0.2 · Learned-decision store + short-circuit
- **Files:** `src/decisions-store.ts` (new), `src/server.ts`
- **Scope:** `.data/decisions.json` keyed by `(focusKey, scope, unit)` → `allow|block` + `via`;
  `focusKey = projectId ?? normalize(task)`; `scope` is `domain` (default) or `page` (§14.7).
  `/adjudicate` checks it **before** the model and short-circuits a hit (`reason:"learned"`);
  `POST /decisions/learn` writes; `POST /decisions/clear` resets.
- **Precedence (must implement):** resolve disagreements top-down —
  `Tier-1 block > learned block > learned allow > Tier-3 allow > model`. A Tier-1 always-block beats a
  learned allow; a learned block (correction) beats a Tier-3 always-allow.
- **AC:** a learned entry returns instantly with no model call; precedence table holds (unit-test the
  five orderings); missing/invalid file → empty store (no throw), matching `config-store.ts`.
- **Verify:** learn an allow, then `/adjudicate` the same pair → `reason:"learned"`, ~0 latency, no API
  call (key unset → still the learned verdict, not the stub); a Tier-1 domain stays blocked even after
  a learned allow.

### BRICK-0.3 · Clarify-and-learn overlay
- **Files:** `extension/content-guard.js` (via the Epic U helper), `extension/background.js`
- **Depends on:** Epic U.
- **Scope:** on `ask`, show the clarify card — **yes, on-topic** / **no, block** / **remember for this
  focus** + a **make focus more specific** shortcut. Answers call `POST /decisions/learn`; "remember"
  persists, un-checked applies once.
- **AC:** "yes + remember" loads the page and never re-prompts for it this focus; "no" soft-blocks and
  is learned as block; the specificity shortcut re-sets the focus string. **Ignored card → fail open:**
  the page stays loaded and isn't re-nagged this session (never a silent block).
- **Verify:** 🖐 vague focus "assignment", visit logitloom → clarify card (not a hard block);
  yes+remember → revisit is silent; dismiss/ignore the card → page stays usable, no block.

### BRICK-0.4 · Source-aware leniency
- **Files:** `src/adjudicate.ts` (or `src/server.ts`)
- **Scope:** modulate strictness by `FocusTask.source` — `explicit` free-text prefers `ask`/lean-allow;
  grounded `next-action` keeps normal strictness.
- **AC:** identical URL + focus text yields a more lenient verdict when `source:"explicit"` than when
  it's a grounded project focus.
- **Verify:** unit-style comparison over a fixed case across the two sources.

### BRICK-0.5 · Honesty lever (user correction)
- **Files:** `extension/popup.html/js` (+ optional in-page pill), `extension/options.html/js`,
  `extension/background.js`, `src/server.ts`
- **Scope:** a **"mark this page off-task"** action → writes a `block` learned decision
  (`via:"correction"`), soft-blocks the current tab now, keeps it blocked under this focus. Plus the
  **symmetric "mark on-topic"** action (pre-teach an allow without waiting to be asked) — same store,
  opposite sign. Options page gains a **gatekeeper readout** (asks / learned-allows / corrections) +
  a **clear learned decisions** button (`POST /decisions/clear`).
- **AC:** off-task blocks immediately + persists under the focus; on-topic whitelists immediately;
  the readout counts update; clear empties the store.
- **Verify:** 🖐 on an allowed page hit off-task → soft-blocks and stays blocked; on a blocked page hit
  on-topic → loads and stays allowed; the options readout reflects both; clear resets.

### BRICK-0.6 · Corrections → eval cases *(optional but cheap)*
- **Files:** `examples/cases.json`, `scripts/smoke.mjs`
- **Scope:** append clarify answers + corrections as `(task, url, expected)` cases so `npm run eval`
  scores accuracy against your real corrections.
- **AC:** a correction shows up as a scored eval case; `npm run eval` reports accuracy including it.
- **Verify:** make one correction, run `npm run eval`, see the new case scored.

### BRICK-0.7 · Per-page scoping for high-variance domains (YouTube)
- **Files:** `extension/content-guard.js` (SPA hook), `extension/options.html/js`, `src/server.ts` /
  `src/adjudicate.ts`
- **Depends on:** 0.2 (scope field).
- **Scope:** for a configurable per-page domain list (default: YouTube), (a) send the **current video
  title** on `/adjudicate`, (b) intercept SPA navigation (`pushState`/`replaceState` + `popstate`, or
  poll `location.href`) and **re-adjudicate on each video change** keyed on the `?v=` id, (c) learn
  with `scope:"page"` (unit = video id) so one on-topic video doesn't whitelist the site.
- **AC:** navigating video→video on YouTube re-adjudicates without a full reload; an on-topic video is
  allowed while an unrelated next video is caught; a learned page-scope allow doesn't leak to other
  videos.
- **Verify:** 🖐 focus "data-science assignment" → a p-values video loads; let autoplay drift to
  something unrelated → it's caught on the video change (no manual reload).

### BRICK-0.8 · Rabbit-hole time nudge
- **Files:** `extension/background.js`, `extension/options.html/js`, (optional `src/server.ts` for
  logging)
- **Depends on:** Epic U (nudge card).
- **Scope:** accumulate **foreground time per flagged domain within a work session** (only while its
  tab is active during work); past a configurable threshold (default ~45–60 min) fire a check-in —
  **keep going** / **wrap up** (block the domain for this focus). Dedup per crossing; re-nudge each
  further interval. Flagged-domain list + threshold on the options page.
- **AC:** the nudge fires once at the threshold (not every tick), only counts active-during-work time,
  and "wrap up" blocks the domain for the focus.
- **Verify:** 🖐 set threshold to 2 min, keep a YouTube tab active during work → nudge at ~2 min; "keep
  going" → next nudge one interval later; background/other tabs don't accrue time.

### ✅ Phase 0 verification gate
- [ ] `npm run typecheck` + `npm run build` clean; `npm run smoke` passes (ask + learn + correction +
      precedence, key-free).
- [ ] 🖐 Free-typed vague focus "assignment", visit `logitloom` → you get the **clarify overlay**, not a
      hard block.
- [ ] 🖐 "yes, on-topic" + remember → page loads; revisit → **no** re-prompt (learned).
- [ ] 🖐 "no, block" → soft overlay; learned as block for this focus.
- [ ] 🖐 Ignored clarify card → page stays usable (fail-open), no silent block.
- [ ] 🖐 Honesty lever blocks an allowed page and persists; symmetric "mark on-topic" whitelists one.
- [ ] 🖐 Precedence holds: a Tier-1 site stays blocked even with a learned allow.
- [ ] 🖐 YouTube: on-topic video allowed, unrelated next video caught on SPA change; page-scope allow
      doesn't leak.
- [ ] 🖐 Rabbit-hole nudge fires at the (test) threshold, once, counting only active work time.
- [ ] 🖐 Source check: a bare explicit focus leans allow/ask; a grounded project focus still blocks a
      clearly off-topic site.
- [ ] Learned decisions persist in `.data/decisions.json` and short-circuit the model (≈0 latency, no
      API call on repeats); options readout + clear work.

---

## Epic H — In-app help agent (usage Q&A)

Goal: let users ask brick itself how to use/configure it — a grounded, docs-backed assistant (the
`claude-code-guide` analog), since the in-browser model is otherwise a headless adjudicator. Depends on
Epic R (reuses the provider for a chat call). Design: `WORKLOAD_DESIGN.md` §18.

### BRICK-H1 · Help corpus
- **Files:** `help/*.md` (new), distilled from `README.md`, `EXTENSION.md`, `WORKLOAD_DESIGN.md`
- **Scope:** a curated how-to/FAQ covering every config surface (tiers, swap modes, advance mode,
  provider/model, focus-time, gatekeeper, sessions/plans, templates), chunked for light keyword
  retrieval.
- **AC:** each supported how-to question maps to a corpus chunk; no config is described that doesn't
  exist in the app.
- **Verify:** spot-check ~10 Q→chunk mappings; every documented setting appears.

### BRICK-H2 · `/help` route + grounded chat call
- **Files:** `src/help.ts` (new), `src/server.ts`
- **Depends on:** R1 (provider seam).
- **Scope:** `POST /help { question, history? } → { answer, sources }`; retrieve relevant corpus
  chunks, call the configured provider with a help system prompt (answer **only** from the corpus;
  unknown → say so + point to the doc), return the answer + which doc sections it used. No forced tool.
- **AC:** known how-to questions get correct, sourced answers; an out-of-scope question returns "not in
  the docs" + a pointer, never invented config.
- **Verify:** `curl /help` with 5 real questions → grounded answers with sources; ask something
  unsupported → graceful "don't know".

### BRICK-H3 · Extension help surface
- **Files:** `extension/popup.html/js` and/or `extension/options.html/js` (an "ask about BRICK" panel)
- **Depends on:** H2.
- **Scope:** a small chat box; sends to `/help`, renders answer + sources; keeps short history.
- **AC:** ask → answer renders with its doc sources; works with a session active or not.
- **Verify:** 🖐 ask "how do I add a Tier-1 site?" and "what does swap=first mean?" → correct answers in
  the panel.

### BRICK-H4 · Situated read-only state tools *(fast-follow)*
- **Files:** `src/help.ts`, `src/server.ts`
- **Scope:** give the help agent `get_config` / `get_plan` / `get_learned_decisions` with
  `tool_choice:"auto"` (read-only, never mutates) so it can answer "what's blocked right now?", "what
  am I focused on?", "why was X blocked?".
- **AC:** situated questions are answered from live state; no tool ever writes.
- **Verify:** 🖐 during a session, ask "what am I focused on?" and "which sites are blocked?" → answered
  from live state.

### BRICK-H5 · Shared corpus into Ledger's focus agent *(Ledger repo — separate)*
- **Scope:** Ledger's focus agent loads the same `help/` corpus (+ ledger-specific usage docs) or calls
  brick's `/help`, so "how do I use brick?" answered in Ledger matches the extension.
- **AC/Verify:** 🖐 the same question answered in Ledger and in the extension gives consistent guidance.

### ✅ Phase H verification gate
- [ ] `npm run typecheck` + `npm run build` clean.
- [ ] 🖐 Five real how-to questions in the extension panel → correct, **sourced** answers.
- [ ] 🖐 An out-of-scope / unknown question → graceful "not in the docs" + pointer, **no** invented
      config.
- [ ] 🖐 (H4) A situated question is answered from live state; no tool call mutates anything.
- [ ] Help calls go through the configured provider (Epic R); training toggle stays off.

---

## Epic S — Session-state feedback (border flash + sound)

Goal: an unmissable, momentary signal on every state change — a colored screen border (red work /
green break) that fades after ~10s, plus an optional sound cue, both toggleable. Independent; ships in
the early wave with Epic 0. Design: `WORKLOAD_DESIGN.md` §15.

### BRICK-S1 · Phase-change border overlay
- **Files:** `extension/content-guard.js`, `extension/background.js`
- **Depends on:** Epic U (uses the transient-treatment helper, border-only variant).
- **Scope:** on the existing `brick:phase` broadcast, render the border treatment (via the U helper)
  that fades in then out over a configurable window (default 10s). Red = work, green = break (reuse
  `WORK_COLOR` / `BREAK_COLOR`). Honour `prefers-reduced-motion` — steady fade, no strobe.
- **AC:** a work↔break flip shows the correct color on the active tab and auto-clears after the window;
  the overlay never intercepts page clicks.
- **Verify:** 🖐 set work/break to 1 min, watch a flip — red border on work, green on break, gone after
  ~10s; clicking through the page still works.

### BRICK-S2 · Sound cues (offscreen audio)
- **Files:** `extension/background.js`, `extension/offscreen.html/js` (new),
  `extension/sounds/*` (assets), `extension/manifest.json` (`offscreen` permission +
  `web_accessible_resources`)
- **Scope:** on phase change, the worker plays via a `chrome.offscreen` document — low "focus" tone
  into work, light twinkle into break. Content-script Web Audio fallback for the focused tab.
- **AC:** the correct cue plays on each transition even when the border tab wasn't just interacted
  with (autoplay-limit sidestep confirmed); it plays **once**, not once-per-open-tab; no sound when
  the toggle is off.
- **Verify:** 🖐 with sound enabled and several tabs open, hear focus-tone on work / twinkle on break —
  exactly one play per flip.

### BRICK-S3 · Options-page toggles
- **Files:** `extension/options.html`, `extension/options.js`
- **Scope:** controls for sound on/off, border on/off, and border duration, persisted to
  `chrome.storage.local` (no service round-trip); content script + worker read them. Include a
  **"test sound"** button — its click is a user gesture that primes/unlocks the audio context for
  later timer-fired playback (and lets you preview the cue).
- **AC:** toggles persist across popup/options reopen and take effect on the next transition; sound
  defaults **off** until opted in; after pressing "test sound" once, timer-fired cues play reliably.
- **Verify:** 🖐 press "test sound" → hear it; turn sound on + border off, save, reopen options →
  settings stuck; next flip is silent-border-off / audible.

### ✅ Phase S verification gate
- [ ] 🖐 Work→break shows a **green** fading border (~10s); break→work shows **red**; both auto-clear.
- [ ] 🖐 The border never blocks clicks or scrolling on the underlying page.
- [ ] 🖐 With sound on: focus-tone entering work, twinkle entering break — reliably, on a timer (not a
      click).
- [ ] 🖐 Toggles (sound / border / duration) persist and take effect; sound defaults off.
- [ ] `prefers-reduced-motion` respected — a gentle fade, never a flash.

---

## Epic F — Focus-time integrity & the grace overlay

Goal: taking "one more minute" shouldn't cost you work minutes — but repeatedly dodging should get
harder. Refines the existing Tier-2 grace overlay. Independent early-wave; extension-side depends on
Epic U. Design: `WORKLOAD_DESIGN.md` §16.

### BRICK-F1 · Pause the work clock during grace
- **Files:** `extension/background.js` (phase alarm / `phaseEndsAt`), `extension/content-guard.js`
  (grace enter/exit signals)
- **Scope:** while the grace overlay is active during a work phase, **pause** the phase countdown; on
  return to task (dismiss / on-task navigation / grace expiry), push `phaseEndsAt` forward by the
  paused duration and re-arm the `chrome.alarms` phase alarm. Add a configurable **max grace per
  block** cap; past it, the page hard-blocks (works with F2's maxed escalation).
- **AC:** a 10-min work block with two "one more minute" detours still delivers a full 10 min of
  in-work time; the cap prevents indefinite pausing.
- **Verify:** 🖐 set work = 3 min; take a couple of grace minutes; confirm the work countdown pauses
  during grace and resumes, so you still get the full 3 min of actual work; exceed the cap → hard
  block.

### BRICK-F2 · Escalating grace opacity
- **Files:** `extension/content-guard.js` (via the Epic U helper), `extension/background.js` (grace
  count in phase state)
- **Depends on:** Epic U.
- **Scope:** track `graceCount` within the current work phase; overlay opacity = `f(graceCount)` —
  lightest on the first "one more minute", deeper each subsequent one; **reset to lightest on the next
  work block**. Cap max opacity (never a full black-out; **"back to work"** always visible/clickable);
  honour `prefers-reduced-motion`.
- **AC:** repeated grace clicks in one block visibly deepen the tint; a new work block resets it; the
  dismiss/return control is reachable at every level.
- **Verify:** 🖐 click "one more minute" 3× in one block → progressively more opaque; next block → back
  to the light version.

### ✅ Phase F verification gate
- [ ] 🖐 Work minutes are preserved: a block with grace detours still yields its full budgeted in-work
      time (clock pauses during grace, resumes after).
- [ ] 🖐 The max-grace cap prevents indefinite pausing (eventually hard-blocks).
- [ ] 🖐 Opacity escalates with each grace click within a block and resets next block.
- [ ] 🖐 "Back to work" stays clickable at the deepest level; `prefers-reduced-motion` respected.

---

## Epic A — Plan queue (no signals)

Goal: an ordered, editable queue of blocks with budgets, steps, and **manual** advance. No watchers,
no notifications yet. The active block reuses the existing single-focus session.

### BRICK-A1 · Types for plan / block / step
- **Files:** `src/types.ts`
- **Scope:** add `WorkloadPlan`, `WorkBlock`, `Step`, `StopCondition` (union, structural only this
  phase), `RepeatSpec`, and the `swapMode` field. No behaviour.
- **AC:** types compile; `FocusTask` reused as the block's focus (no duplication).
- **Verify:** `npm run typecheck` passes.

### BRICK-A2 · PlanStore interface + LocalPlanStore
- **Files:** `src/plan-store.ts` (new)
- **Scope:** `PlanStore` interface (`load`/`save`/`advance`); `LocalPlanStore` backed by
  `.data/plan.json`. Mirror the Ledger-native schema exactly (so Epic D is a swap, not a rewrite).
- **AC:** round-trips a plan to disk; missing/invalid file → `null` (not a throw), matching
  `config-store.ts` conventions.
- **Verify:** a tiny node script writes then loads a 3-block plan and prints it; `.data/plan.json`
  exists and is valid JSON.

### BRICK-A3 · PlanRuntime (queue + budgets + manual advance + steps)
- **Files:** `src/plan-runtime.ts` (new), `src/session.ts` (wrap, don't replace)
- **Scope:** hold the active plan; the active block delegates to the existing `FocusSession`; macro
  budget clock per block (advisory only this phase); `advance(blockId, "done"|"skipped")` moves to
  next (honours `repeat.requeue`); `toggleStep`.
- **AC:** advancing the last block ends the plan; a `repeat` block re-enqueues once (respecting
  `maxPerDay`); existing single-session behaviour is unchanged when no plan is active.
- **Verify:** unit-style script drives start → toggle steps → advance ×N → end; asserts queue
  position and `actualMinutes` recorded.

### BRICK-A4 · Service routes for plans
- **Files:** `src/server.ts`
- **Scope:** `GET /plan`; `POST /plan/start`, `/plan/block/advance`, `/plan/block/step`,
  `/plan/block/complete`, `/plan/reorder`. Reuse the `X-Brick-Client` + origin guard. `focusFor()`
  returns the **active block's** focus during a plan.
- **AC:** every route returns the updated plan + a monotonic `stateVersion`; a per-call `task` can't
  override the active block's focus (existing safety property holds).
- **Verify:** `curl` (with `-H "X-Brick-Client: cli"`) start → advance → get; `stateVersion`
  increments; 403 without the header.

### BRICK-A5 · Extension: queue popup + badge
- **Files:** `extension/background.js`, `extension/popup.html`, `extension/popup.js`
- **Scope:** background reads `/plan`; badge shows minutes-left + `2/3` queue position; popup renders
  active block (budget timer, focus, steps checklist) + queue list + `advance now` / `end plan`.
- **AC:** toggling a step or advancing from the popup calls the service and re-renders; badge title
  shows `2/3 · <block> · <n>m left`.
- **Verify:** 🖐 load unpacked at `chrome://extensions`, start a 3-block plan, advance through it,
  watch badge + popup update.

### BRICK-A6 · Smoke coverage for plans
- **Files:** `scripts/smoke.mjs`
- **Scope:** extend the existing smoke run with plan start/advance/step/end assertions (no API key
  needed — Tier logic untouched).
- **AC:** `npm run smoke` includes the new checks and passes.
- **Verify:** `npm run smoke` → all checks green.

### ✅ Phase A verification gate
- [ ] `npm run typecheck` and `npm run build` clean.
- [ ] `npm run smoke` passes, including the new plan checks.
- [ ] 🖐 In the browser: start a plan of 3 blocks with budgets 1/1/1 min; badge shows `1/3` then
      advances; popup timer counts down.
- [ ] 🖐 Toggle a step in the popup → it persists across a popup reopen.
- [ ] 🖐 `advance now` moves to the next block; advancing the last block ends the plan (badge clears).
- [ ] 🖐 A block marked `repeat` reappears at the tail exactly once.
- [ ] Existing single-focus session still works when no plan is active (regression check).

---

## Epic T — Workflow templates

Goal: save a parameterized plan skeleton and re-run it by binding slots to projects. Can start as soon
as Epic A lands.

### BRICK-T1 · Template types + store
- **Files:** `src/types.ts`, `src/template-store.ts` (new)
- **Scope:** `WorkflowTemplate`, `Slot`, `TemplateBlock` (with `focusRef` + optional
  `onActivate.bunch`); `TemplateStore` + `LocalTemplateStore` (`.data/templates.json`).
- **AC:** round-trips; same interface shape as `PlanStore`.
- **Verify:** script saves + lists two templates; file is valid JSON.

### BRICK-T2 · Template expansion + launch
- **Files:** `src/plan-runtime.ts`, `src/server.ts`
- **Scope:** `POST /plan/from-template { templateId, bindings }` — expand `pattern` and bind slots →
  concrete `WorkloadPlan`. Zero-slot templates launch as-is.
- **AC:** "alternating deep work" (slots A/B, 2h, `until-end-of-day`) expands to A,B,A,B… with
  bindings applied; a pre-bound template launches with no binding step.
- **Verify:** `curl` from-template with two project ids → returned plan alternates correctly and stops
  at the day boundary.

### BRICK-T3 · Template CRUD + "save current as template"
- **Files:** `src/server.ts`, `src/template-store.ts`
- **Scope:** `GET/POST /templates`, `DELETE /templates/:id`; a "save current plan as template" that
  lifts concrete projects into slots (offer keep-bound vs. parameterize).
- **AC:** saving an active plan produces a re-launchable template; deleting removes it.
- **Verify:** save current plan → appears in `GET /templates` → relaunch it.

### BRICK-T4 · Template UI (popup picker + options management)
- **Files:** `extension/popup.html/js`, `extension/options.html/js`
- **Scope:** popup plan-picker gains a **templates** row; picking a slotted template shows a
  slot-binding step; options page lists/edits/deletes templates.
- **AC:** launching from a template with 2 slots requires 2 bindings then starts; pre-bound launches
  immediately.
- **Verify:** 🖐 pick "alternating deep work", bind two projects, confirm the plan that starts is
  A,B,A,B.

### BRICK-T5 · Smoke coverage for templates
- **Files:** `scripts/smoke.mjs`
- **AC/Verify:** `npm run smoke` covers save → from-template → expansion assertion; passes.

### ✅ Phase T verification gate
- [ ] `npm run smoke` passes, including template checks.
- [ ] 🖐 Save "alternating deep work" (A/B, 2h, until-end-of-day) as a template.
- [ ] 🖐 Relaunch it binding project X → A and project Y → B; the started plan alternates X,Y,X,Y.
- [ ] 🖐 Save a *current* hand-built plan as a template, then relaunch it and confirm parity.
- [ ] 🖐 Delete a template from the options page; it's gone from the popup picker.

---

## Epic B — Signals, swap policy, advance mode

Goal: auto-detect stop conditions, combine time + condition into a swap decision, and honour the
auto-vs-manual advance setting. Depends on Epic A.

### BRICK-B1 · Watcher subsystem + evaluators
- **Files:** `src/watchers.ts` (new), `src/plan-runtime.ts`
- **Scope:** `Evaluator` contract (`arm`/`poll`); one interval loop (`BRICK_WATCH_INTERVAL_MS`, default
  30s) over the **active block's** conditions. Evaluators: `ledger` (diff `nextAction`), `git`
  (`head-advanced` / `merge-commit` / `message-match`), `command` (behind
  `BRICK_ALLOW_COMMAND_CONDITIONS`). Fail-open, monotonic, baseline at block start.
- **AC:** a met condition sets `met:true` and never reverts; any evaluator error → `false` (no false
  complete).
- **Verify:** with a scratch git repo, `head-advanced` flips only after a real commit/push; a broken
  `repoPath` never flips.

### BRICK-B2 · Swap policy combinator
- **Files:** `src/plan-runtime.ts`
- **Scope:** implement `condition | time | first | both` over `conditionMet` and `timeUp`; derive the
  default (`first` when both budget+condition exist, else the one present).
- **AC:** truth table matches §12: `first` swaps on the earlier of push/budget; `time` ignores the
  condition for swapping; `both` needs the min-time floor.
- **Verify:** script simulates (met at t1, budget at t2) for each mode and asserts the swap instant.

### BRICK-B3 · Advance-mode setting + condition-driven swap handling
- **Files:** `src/config-store.ts` (add `loadSettings`/`saveSettings`), `src/server.ts`
  (`POST /config/settings`, include settings in `GET /config`), `src/plan-runtime.ts`
- **Scope:** `BrickSettings { advanceMode, undoWindowSec }` in `.data/settings.json`; per-block
  `advanceMode?` override; `onConditionMet` branch: **auto** → advance + arm undo
  (`POST /plan/undo-advance`); **manual** → mark block `ready`, no move.
- **AC:** auto advances then reverts within the window; manual leaves the queue put and flags `ready`;
  a time-driven swap uses the nudge path, not undo/tap.
- **Verify:** `curl` toggles settings; drive a met condition under each mode and confirm behaviour.

### BRICK-B4 · Options page advance-mode control
- **Files:** `extension/options.html/js`
- **Scope:** two radios (auto+undo / manual) + undo-seconds field (disabled when manual), saved via
  `/config/settings`.
- **AC:** changing the radio persists and a new plan picks it up.
- **Verify:** 🖐 flip to manual, save, reload options → still manual.

### BRICK-B5 · Smoke coverage for watchers / swap / settings
- **Files:** `scripts/smoke.mjs`
- **Scope:** temp git repo fixture; assert swap modes + settings round-trip. Keep it key-free.
- **AC/Verify:** `npm run smoke` green.

### ✅ Phase B verification gate
- [ ] `npm run smoke` passes, including watcher/swap/settings checks.
- [ ] 🖐 Scratch repo, block with `swapMode:first` + budget 2 min + `git head-advanced`: push a commit
      → block auto-advances with an **undo** offered; undo returns you to the block.
- [ ] 🖐 Same block, set advance-mode **manual**: push → `advance now` lights up, queue does **not**
      move until you tap.
- [ ] 🖐 Block with `swapMode:time`, no push: it swaps at the budget via the nudge path.
- [ ] 🖐 `ledger` condition: change the project's Next Action in Ledger → block completes (needs
      `LEDGER_BIN`).
- [ ] Broken `repoPath` / evaluator error never advances a block (fail-open confirmed).

---

## Epic C — Escalating notifications (three surfaces)

Goal: budget escalation and swap events reach you via popup/badge, in-page overlay, and OS
notification. Depends on Epic B (swap events) and Epic A (badge).

### BRICK-C1 · Escalation clock + stateVersion
- **Files:** `src/plan-runtime.ts`, `src/server.ts`
- **Scope:** escalation levels (T-minus / T-0 / grace) from block budget; expose current level + a
  monotonic `stateVersion` on `GET /plan`.
- **AC:** levels advance at the configured thresholds; `stateVersion` bumps on any state change.
- **Verify:** poll `/plan` over a short block; level transitions at the right times.

### BRICK-C2 · NotificationDispatcher + tick diffing + dedup
- **Files:** `extension/background.js`
- **Scope:** on each `TICK_ALARM` (shortened near a boundary), fetch `/plan`, diff `stateVersion`,
  emit changed events; dedup by `(event, blockId, level)`.
- **AC:** each escalation level notifies once, not every tick.
- **Verify:** 🖐 service-worker console shows one dispatch per level.

### BRICK-C3 · OS notifications
- **Files:** `extension/manifest.json` (add `notifications`), `extension/background.js`
- **Scope:** `chrome.notifications` for T-0 and auto-complete/switch events.
- **AC:** OS notification fires with browser in the background.
- **Verify:** 🖐 background the browser during a work block → OS toast at T-0.

### BRICK-C4 · In-page switch overlay
- **Files:** `extension/content-guard.js` (or a small new content script), `background.js`
- **Scope:** `brick:switch` message → bottom-right card ("start Block B?" · Advance / Stay), reusing
  the existing `brick:phase`/`brick:catch` channel.
- **AC:** overlay appears on the active tab at swap time and its buttons hit the service.
- **Verify:** 🖐 overlay shows on a live page; Advance moves the queue.

### BRICK-C5 · Popup/badge escalation visuals
- **Files:** `extension/popup.html/js`, `background.js`
- **Scope:** badge colour-shift by level; popup escalation banner; `undo` affordance (auto) and
  `advance now` glow (manual, `· ready`).
- **AC:** matches Appendix B; visuals track the escalation level.
- **Verify:** 🖐 watch popup/badge through T-minus → T-0 → grace.

### ✅ Phase C verification gate
- [ ] 🖐 Short block (budget 1–2 min): T-minus heads-up, T-0 nudge, and grace re-nudge each fire
      **once** across popup, in-page overlay, and OS notification.
- [ ] 🖐 Auto mode: a swap shows an **undo** that works within `undoWindowSec`.
- [ ] 🖐 Manual mode: `advance now` glows and the in-page overlay's Advance moves the queue.
- [ ] 🖐 OS notification arrives with the browser backgrounded.
- [ ] No duplicate notifications across a multi-minute block (dedup confirmed in the worker console).

---

## Epic D — Ledger-native store

Goal: promote the plan (and templates) from local JSON to first-class Ledger objects. The only epic
that edits the mature Ledger app; do it last, in isolation.

### BRICK-D1 · Ledger schema + CLI verbs *(Ledger repo)*
- **Scope:** `plans` (and `templates`) schema; `ledger plan show --json`, `ledger plan advance`,
  `ledger plan step`, plus template read.
- **AC:** verbs read/write the Firestore objects; `--json` shape matches the brick schema 1:1.
- **Verify:** 🖐 `ledger plan show --json` returns a plan brick can parse.

### BRICK-D2 · LedgerPlanStore / LedgerTemplateStore + migration
- **Files:** `src/plan-store.ts`, `src/template-store.ts`, `src/ledger.ts`, `src/server.ts`
- **Scope:** CLI-backed store impls (shell out like `status --json`); a one-shot migration
  `.data/plan.json` + `.data/templates.json` → Ledger; a config switch to select the backend.
- **AC:** with the Ledger backend, all Epic A/T behaviour is identical; falling back to local still
  works.
- **Verify:** run the full A/T gates again with the Ledger backend selected.

### ✅ Phase D verification gate
- [ ] 🖐 A plan created in brick appears as a Ledger object (`ledger plan show --json`).
- [ ] 🖐 Advancing a block in brick is reflected in Ledger, and vice-versa.
- [ ] 🖐 Local → Ledger migration moves existing `.data` plans/templates without loss.
- [ ] Re-running the Phase A and Phase T gates against the Ledger backend passes unchanged.

---

## Cross-cutting checks (every phase)
- [ ] `npm run typecheck` + `npm run build` clean before a gate is called done.
- [ ] Fail-open preserved: with the service down, the extension never hard-blocks real work.
- [ ] No secrets in the extension; all AI/decisions still go through the service.
- [ ] `.data/*.json` files stay valid JSON and human-readable (they're your audit trail).
