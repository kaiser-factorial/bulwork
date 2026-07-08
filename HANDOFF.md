# BRICK MODE — handoff

**What this is:** the focus-enforcement pillar of the Ledger project-OS. Spec + roadmap in
`../ledger/docs/BRICK_MODE_PLAN.md`; chronological build log + divergences in `SESSION_LOG.md`.

---

## ▶ Next up — Workload + gatekeeper layer (design + tickets ready, 2026-07-08)

**Start here for the next build phase.** Two new docs drive everything below:

- **`WORKLOAD_DESIGN.md`** — full system design. Workload/day-plan queue, swap policy, templates,
  advance-mode setting, notifications, Ledger-native store (§1–13); **gatekeeper quality** (§14),
  **session-state feedback** (§15), **focus-time integrity** (§16), **OpenRouter provider +
  configurable model** (§17), **in-app help agent** (§18). Appendices: stop-condition predicate
  schema, popup UI.
- **`WORKLOAD_TICKETS.md`** — phased tickets grouped into epics **U, R, 0, H, S, F, A, T, B, C, D**,
  each with acceptance criteria and a **per-phase verification gate** (checkboxes to run before
  sign-off).

**Build order:** `U → (R → {0, H}, S, F) → A → (T, B) → C → D`. Begin with **BRICK-U1** (tiny
shared-overlay prelude); the early wave (Epics R/0/H/S/F) makes the tool better *today*, before any
plan architecture. **Epic R** (OpenRouter provider + options-page model picker) comes first in the
service lane because it and Epic 0 both edit `adjudicate.ts`; **Epic H** (in-app help agent — ask brick
how to use itself) also builds on R's provider. Epic D is the only one that touches the mature Ledger
app — last.

### Parallelization map (optimize the Code session around this)

The big win: **Epic 0's service side and all extension work never share a file**, so they run as two
concurrent lanes.

```
WAVE 0 (prelude, tiny — unblocks every extension overlay)
  └─ BRICK-U1  transient-treatment helper           [extension/content-guard.js (+overlay.js)]

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

- **Phase 1 — DONE.** Adjudicator (`brick`) + AI-chat prepend (`brick-prepend`). Verified: build,
  typecheck, live Ledger wiring, dry-run. (Eval now runnable — key is in.)
- **Phase 2 — DONE (headless).** Local service (`src/server.ts`) + MV3 browser extension
  (`extension/`) + tiers + Pomodoro sessions + JSONL session log + the prepend focus pill.
  Verified by `npm run smoke` (7/7) and manual curl. Now running live in Chrome with the key.
- **Phase-2 fast-follow — wired, inert.** Memory-Hub grounding (`src/grounding.ts`), gated on
  `BRICK_MEM_BIN`.
- **Design/planning — DONE (2026-07-08).** Full design + phased tickets for the next build wave
  (Epics U, R, 0, H, S, F, A, T, B, C, D) written in `WORKLOAD_DESIGN.md` + `WORKLOAD_TICKETS.md`.
  **No code written yet for these** — the next Code session starts at `BRICK-U1`, then `R1 → 0.1`.

## Resume / verify

```bash
cd brick && npm install
npm run smoke          # builds + asserts the service end-to-end (no key needed)
npm run serve          # then load extension/ unpacked in Chrome (see EXTENSION.md)
npm run eval           # needs ANTHROPIC_API_KEY — validates adjudication accuracy
```

## Blocked on you (status)

1. ~~**`ANTHROPIC_API_KEY`**~~ — **RESOLVED (2026-07-08).** Key is in; adjudication runs live.
   Next: Epic R switches the adjudicator to **OpenRouter** (one key, many models, model picker on the
   options page) — see `WORKLOAD_DESIGN.md` §17 / `WORKLOAD_TICKETS.md` Epic R.
2. ~~**A browser**~~ — **RESOLVED.** Running in Chrome. (Per-site content-script tuning on live
   claude.ai / Gemini / ChatGPT is still worth doing, but it's no longer a blocker.)
3. **Firestore creds + Ledger-app decision** — still open. This is **Epic D** (Ledger-native store)
   and Phase 3 ("Focus UI in the Ledger app + session-as-Ledger-object") — editing the mature Ledger
   React app and writing to its Firestore. Held deliberately, done last. **Grounded plans are ready:**
   `../ledger/docs/BRICK_PHASE3_LEDGER_APP.md` (app + `FocusSession`; key gotcha `BRICK_USER_ID`) and
   `../ledger-cli/docs/FOCUS_COMMAND_PLAN.md` (`ledger focus` primitive).

Note: a subagent security review hardened the service since first build — the local service now
requires an `X-Brick-Client` header and locks CORS to the extension/localhost origins (CSRF-to-
localhost fix). See SESSION_LOG "Agent-assisted hardening".

## File map

```
src/
  cli.ts / prepend-cli.ts / eval.ts   CLIs + eval harness
  ledger.ts        focus-task resolution (--task/--project/--last; no "active" state)
  adjudicate.ts    Claude Haiku 4.5, forced tool use, conservative-allow
  prompt.ts        system + few-shot (+ optional grounding block)
  prepend.ts       soft-nudge AI-chat header
  tiers.ts         tier1/tier3 defaults + classify()
  config-store.ts  persisted, editable tier lists (.data/tiers.json)
  session.ts       Pomodoro/focus session state + JSONL log (+ Firestore stub)
  grounding.ts     Memory-Hub grounding (env-gated placeholder)
  server.ts        local HTTP service (:7373) the extension talks to
extension/         MV3 extension (manifest, background, content scripts, popup, options, block page)
scripts/smoke.mjs  service smoke test
```

**Planned new modules (per `WORKLOAD_TICKETS.md` — not yet created):**
```
src/providers/*.ts     openrouter.ts + anthropic.ts behind a VerdictProvider seam   (Epic R)
src/decisions-store.ts learned allow/block per (focusKey, scope, unit)              (Epic 0)
src/help.ts            grounded /help Q&A over the corpus                           (Epic H)
help/*.md              curated usage/FAQ corpus (shared with Ledger's focus agent)  (Epic H)
src/plan-store.ts      PlanStore + LocalPlanStore (Ledger-native shape)             (Epic A/D)
src/plan-runtime.ts    block queue, budgets, swap policy, steps                     (Epic A/B)
src/template-store.ts  WorkflowTemplate CRUD + expansion                            (Epic T)
src/watchers.ts        git / ledger / command stop-condition evaluators            (Epic B)
extension/overlay.js   shared transient-treatment primitive                        (Epic U)
extension/offscreen.*  offscreen audio for session-state cues                       (Epic S)
```
