# BULWORK MODE — handoff

**What this is:** the focus-enforcement pillar of the Ledger project-OS. Spec + roadmap in
`../ledger/docs/BRICK_MODE_PLAN.md`; chronological build log + divergences in `SESSION_LOG.md`.

---

## ▶ Next up — Epic D (Ledger-native store) — the last epic

**Where we are (2026-07-08):** the early wave (U/R/0/S/F/H) is **merged to master** (PR #1), and the
**complete local-first plan layer — Epics A, T, B, C — is on PR #2** (`workload-plan-layer`,
smoke 108/108). 🖐 Browser gates are pending on PR #2 (checklists in the PR comments).

**Epic D setup (start the next session with this):** the Ledger repos live at
`~/Projects/ledger_root/{ledger,ledger-cli,ledger-mcp}` — NOT the `../ledger` sibling paths written
below. Launch the session from a directory spanning bulwork + ledger_root (or `--add-dir`), set
`LEDGER_BIN` to the built CLI, and have Firestore creds ready. D1 adds `ledger plan
show/advance/step --json` verbs in the Ledger repo; D2 drops `LedgerPlanStore`/`LedgerTemplateStore`
behind the existing `PlanStore`/`TemplateStore` seams (`usePlanStore()` is the hook) + a one-shot
`.data` migration; then re-run the Phase A/T gates against the Ledger backend. H5 (shared help
corpus into Ledger's focus agent) rides along.

The two docs that drive everything:

- **`WORKLOAD_DESIGN.md`** — full system design. Workload/day-plan queue, swap policy, templates,
  advance-mode setting, notifications, Ledger-native store (§1–13); **gatekeeper quality** (§14),
  **session-state feedback** (§15), **focus-time integrity** (§16), **OpenRouter provider +
  configurable model** (§17), **in-app help agent** (§18). Appendices: stop-condition predicate
  schema, popup UI.
- **`WORKLOAD_TICKETS.md`** — phased tickets grouped into epics **U, R, 0, H, S, F, A, T, B, C, D**,
  each with acceptance criteria and a **per-phase verification gate** (checkboxes to run before
  sign-off).

**Build order:** `U → (R → {0, H}, S, F) → A → (T, B) → C → D`. Begin with **BULWORK-U1** (tiny
shared-overlay prelude); the early wave (Epics R/0/H/S/F) makes the tool better *today*, before any
plan architecture. **Epic R** (OpenRouter provider + options-page model picker) comes first in the
service lane because it and Epic 0 both edit `adjudicate.ts`; **Epic H** (in-app help agent — ask bulwork
how to use itself) also builds on R's provider. Epic D is the only one that touches the mature Ledger
app — last.

### Parallelization map (optimize the Code session around this)

The big win: **Epic 0's service side and all extension work never share a file**, so they run as two
concurrent lanes.

```
WAVE 0 (prelude, tiny — unblocks every extension overlay)
  └─ BULWORK-U1  transient-treatment helper           [extension/content-guard.js (+overlay.js)]

WAVE 1 — two lanes in parallel (no cross-lane file overlap):

  Lane SRV  (pure src/* + scripts + cases — parallel with everything)
    R1 provider seam ─▶ 0.1 ask outcome ─▶ 0.2 learned store (+precedence) ─▶ 0.4 source-leniency
    (R1 first: shares adjudicate.ts)   R2/R3 provider config+robustness   └─▶ 0.6 eval cases
    files: adjudicate.ts, providers/*(new), prompt.ts, types.ts, server.ts, config-store.ts,
           decisions-store.ts(new), examples/cases.json, scripts/smoke.mjs, package.json(+openai)
    note: R2's model picker touches extension/options.html/js — clear of the overlay files.

    Help agent (Epic H, after R1):  H1 corpus ─▶ H2 /help route ─▶ H3 extension panel ─▶ H4 state tools
    files: help/*(new), src/help.ts(new), server.ts, extension/popup|options.* ; H5 = Ledger repo

  Lane EXT  (extension/* — starts after U1)
    self-contained, start immediately:  S1, S2, S3   (border + sound + options; chrome.storage only)
                                         F1, F2       (pause-clock + escalating opacity)
    join point (needs Lane SRV 0.2 store):  0.3 clarify · 0.5 lever · 0.7 per-video · 0.8 rabbit-hole
```

**Rules for the map:**
- **Cross-lane = fully parallel.** SRV touches only `src/*`, `scripts/`, `examples/`; EXT touches only
  `extension/*`. Build the gatekeeper backbone and the extension UX at the same time.
- **Within Lane EXT, serialize the shared files.** `background.js` and `content-guard.js` are edited by
  many EXT tickets — land them one at a time (or as separate feature-scoped handler functions) to
  avoid self-conflict. U1 exists specifically to keep the overlay code out of each other's way.
- **Intra-Epic-0 order:** `0.1 → 0.2 → (0.3, 0.5, 0.7, 0.8)`; `0.4` and `0.6` any time after 0.2.
- **Key-free vs. key-needed:** the store/precedence/source-leniency logic is unit-testable **without**
  `ANTHROPIC_API_KEY`; exercising real `ask` verdicts needs the key via `npm run eval` (see "Blocked on
  you"). So Lane SRV can be built and largely verified offline, keying only the final accuracy pass.
- **After the early wave:** Epic A (plan queue) unblocks T and B (parallel), then C, then D — see the
  `WORKLOAD_TICKETS.md` dependency line.

## Status

- **Phase 1 — DONE.** Adjudicator (`bulwork`) + AI-chat prepend (`bulwork-prepend`). Verified: build,
  typecheck, live Ledger wiring, dry-run. (Eval now runnable — key is in.)
- **Phase 2 — DONE (headless).** Local service (`src/server.ts`) + MV3 browser extension
  (`extension/`) + tiers + Pomodoro sessions + JSONL session log + the prepend focus pill.
  Verified by `npm run smoke` (7/7) and manual curl. Now running live in Chrome with the key.
- **Phase-2 fast-follow — wired, inert.** Memory-Hub grounding (`src/grounding.ts`), gated on
  `BULWORK_MEM_BIN`.
- **Design/planning — DONE (2026-07-08).** Full design + phased tickets for the next build wave
  (Epics U, R, 0, H, S, F, A, T, B, C, D) written in `WORKLOAD_DESIGN.md` + `WORKLOAD_TICKETS.md`.
- **Workload early wave — COMPLETE (2026-07-08, branch `worktree-workload-early-wave`, PR #1).**
  **U ✓ R ✓ (R1–R3; R4 optional) 0 ✓ (0.1–0.8) S ✓ F ✓ H ✓ (H1–H4; H5 with Epic D).** Highlights:
  provider seam + OpenRouter with model picker (`GET /models`, tool-capable filter); `ask` outcome +
  clarify card + learned-decision store with precedence + honesty lever + YouTube per-page scoping +
  rabbit-hole nudge; phase border + synthesized sound cues; grace clock-pause with per-block cap +
  escalating tint; grounded `/help` agent with read-only state tools + options-page panel.
  `npm run smoke` = **46/46**, hermetic/key-free/ledger-free; OpenRouter + Anthropic + fail-open +
  learned/precedence + page-scope + refocus + help retrieval all verified live. 🖐 **A consolidated
  browser pass is the one open gate** (checklist on PR #1: grace regression, clarify card, popup
  levers, model picker, YouTube SPA, rabbit-hole at a test threshold, border/sound, grace pause/cap,
  help panel). **Merged to master.** See `SESSION_LOG.md` for per-epic detail.
- **Plan layer, Epics A + T + B + C — DONE (2026-07-08, branch `workload-plan-layer`, PR #2,
  smoke 108/108).** B: stop-condition watchers (git/ledger/command/manual — fail-open, monotonic),
  the §12 swap combinator, advance-mode auto-with-undo vs manual (`/plan/undo-advance`; time-driven
  swaps always nudge). C: escalation clock (t-minus/t-0/grace), NotificationDispatcher with
  persisted once-per-event dedup, OS toasts, in-page Advance/Stay/Undo card, badge colour ladder +
  popup banner. Earlier entry (A+T detail) follows:
  **A ✓** day-plan queue: `WorkloadPlan/WorkBlock/Step` types, `LocalPlanStore` (`.data/plan.json`,
  Ledger-native shape behind the `PlanStore` seam), `PlanRuntime` (active block **delegates to the
  existing FocusSession** — adjudicator/tiers/learned decisions/grace untouched; advisory budgets;
  monotonic `stateVersion`; survives restarts), `/plan*` routes, plan-aware badge
  (`2/3 · <focus> · Nm left`), popup builder/queue/steps UI. **T ✓** workflow templates:
  `LocalTemplateStore`, pure `expandTemplate` (slot binding, `repeat: N`, `until-end-of-day`),
  `liftPlanToTemplate` (save-current, parameterize projects→slots), `/templates` CRUD +
  `/plan/from-template`, popup slot-binding picker + save-as-template, options manager.
  `npm run smoke` = **77/77** hermetic. 🖐 Phase A/T browser gates on PR #2. **Next: B → C → D.**

## Resume / verify

```bash
cd bulwork && npm install
npm run smoke             # builds + self-tests the whole service — hermetic (no key, no ledger)
npm run serve             # then load extension/ unpacked in Chrome (see EXTENSION.md)
npm run eval              # needs a provider key — validates adjudication accuracy
npm run eval:corrections  # scores the adjudicator against YOUR recorded clarify answers/corrections
```

## Blocked on you (status)

1. ~~**API keys**~~ — **RESOLVED.** Both `OPENROUTER_API_KEY` (default provider, model picker on the
   options page) and `ANTHROPIC_API_KEY` (fallback path) are in `.env`; adjudication runs live.
2. ~~**A browser**~~ — **RESOLVED.** Running in Chrome. (Per-site content-script tuning on live
   claude.ai / Gemini / ChatGPT is still worth doing, but it's no longer a blocker.)
3. **Firestore creds + Ledger-app decision** — still open. This is **Epic D** (Ledger-native store)
   and Phase 3 ("Focus UI in the Ledger app + session-as-Ledger-object") — editing the mature Ledger
   React app and writing to its Firestore. Held deliberately, done last. **Grounded plans are ready:**
   `../ledger/docs/BRICK_PHASE3_LEDGER_APP.md` (app + `FocusSession`; key gotcha `BRICK_USER_ID`) and
   `../ledger-cli/docs/FOCUS_COMMAND_PLAN.md` (`ledger focus` primitive).

Note: a subagent security review hardened the service since first build — the local service now
requires an `X-Bulwork-Client` header and locks CORS to the extension/localhost origins (CSRF-to-
localhost fix). See SESSION_LOG "Agent-assisted hardening".

## File map

```
src/
  cli.ts / prepend-cli.ts / eval.ts   CLIs + eval harness
  ledger.ts          focus-task resolution (--task/--project/--last; no "active" state)
  adjudicate.ts      provider-agnostic adjudication: forced tool use, allow|block|ask,
                     conservative-allow, fail-open (R3)
  providers/         VerdictProvider seam: openrouter.ts (default) + anthropic.ts (fallback),
                     recordVerdict (forced tool) + chat (help agent, optional read-only tools)
  prompt.ts          system + few-shot (+ grounding block, ask guidance, source leniency)
  decisions-store.ts learned allow/block per (focusKey, scope, unit) + precedence + eval export
  prepend.ts         soft-nudge AI-chat header
  tiers.ts           tier1/tier3 defaults + classify()
  config-store.ts    tier lists + BulworkSettings (model, focus tuning) — .data/*.json
  session.ts         Pomodoro/focus session state + JSONL log (+ Firestore stub) + refocus
  plan-store.ts      PlanStore seam + LocalPlanStore + pure advancePlan (Epic A)
  plan-runtime.ts    queue runtime: block↔session anchoring, budgets, steps, stateVersion (Epic A)
  template-store.ts  TemplateStore + expandTemplate + liftPlanToTemplate (Epic T)
  help.ts            grounded /help Q&A: corpus retrieval + read-only state tools (Epic H)
  grounding.ts       Memory-Hub grounding (env-gated placeholder)
  server.ts          local HTTP service (:7373) — adjudicate/session/plan/templates/help/config
help/*.md            curated help corpus (the help agent answers ONLY from these)
extension/           MV3: manifest, background, overlay.js (U1 primitive), content-guard,
                     content-prepend, offscreen audio, popup (plans/templates), options, block page
scripts/             smoke.mjs (hermetic self-test) + export-cases.mjs (corrections → eval cases)
```

**Still-unbuilt (per `WORKLOAD_TICKETS.md`):**
```
Epic D only: `ledger plan …` CLI verbs (Ledger repo), LedgerPlanStore /
LedgerTemplateStore behind the existing store seams, .data → Ledger migration.
(src/watchers.ts, swap policy, advance mode, escalation + dispatcher all landed with B/C.)
```
