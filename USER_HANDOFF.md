# BRICK MODE — User Handoff

> *Historical note: this project was renamed brick → bulwork in July 2026. This document predates the rename and is left as originally written.*

*For you, Corina — what we accomplished and exactly what to do next. Plain-language; the dev-oriented
version is `HANDOFF.md`, the blow-by-blow build log is `SESSION_LOG.md`.* (2026-06-27)

---

## The idea, in one breath

The Ledger is becoming a project **operating system** for the way you work: it remembers your
projects (Memory), you'll be able to drop into one instantly (Bunch-style contexts), and **BRICK MODE
keeps you there** — AI-adjudicated focus enforcement anchored to a project's **Next Action**. This
session built BRICK.

The keystone: BRICK never asks "what are you working on?" — it reads the focus task straight from a
Ledger project's Next Action.

---

## What we accomplished

**1. Planning (locked).** Brainstormed the whole thing and locked **16 decisions** in
`../ledger/docs/BRICK_MODE_PLAN.md` — e.g. friction-not-fortress, soft-nudge AI-chat header,
browser-extension-first, defer app-blocking, adjudicate-then-validate. Folded in **BRICK MODE** and
the **Memory Hub**; parked WearabLLM + the group-chat "joint session" with their seams noted.

**2. Phase 1 — the adjudicator + prepend (built & verified).** A tool that, given a URL + your focus
task, asks Claude Haiku 4.5 "is this on-task?" and returns allow/block + reason + confidence. Plus the
soft-nudge focus header for AI chats.

**3. Phase 2 — the real enforcement stack (built, verified headless).**
- A **local service** (the brain) that does tiers + adjudication + sessions.
- A **Chrome extension** (the muscle): blocks always-off sites instantly, adjudicates the gray-area
  ones against your focus, runs a Pomodoro work/break timer, and drops a "↳ prepend focus" pill on
  claude.ai / Gemini / ChatGPT.
- Editable block/allow lists, and a local session log.

**4. Hardening (via review agents).** An independent security pass caught a real bug — *any website
you visited could read your Ledger project list off the local service*. Fixed and verified, along
with ~10 other correctness issues.

**5. Blueprints for the next phases** (so they're not a cold start): a file-cited plan for the Ledger
**Focus panel** and for a **`ledger focus`** command.

---

## What works *right now* (try these)

```bash
cd brick
npm install          # once
npm run smoke        # builds + self-tests the service — should say "all checks passed"
```

The core idea, on a real URL (no key needed for tier-1/3 or to see the wiring):
```bash
npm run dev -- https://github.com/kaiser-factorial/ledger --task "Fix the OAuth bug"   # → ALLOW
npm run dev -- https://reddit.com/r/all --task "Fix the OAuth bug"                      # → BLOCK (tier-1)
npm run dev -- https://news.ycombinator.com --last --dry-run                            # see the wiring, no API call
```

The AI-chat focus header:
```bash
npm run prepend -- --last
```

> Heads up: without an `ANTHROPIC_API_KEY`, the *gray-area* (Tier-2) decisions return a clearly-marked
> "allow (stub)" instead of a real judgment. Tier-1/Tier-3 work without a key.

---

## What needs *you* (the only reasons I stopped)

| # | What | Why it needs you |
|---|---|---|
| 1 | **Add `ANTHROPIC_API_KEY`** to `brick/.env`, then `npm run eval` | This is the **go/no-go** — it tells you whether the AI adjudication is actually accurate enough to build on. Everything downstream rides on this. |
| 2 | **Load the extension in Chrome** & test it | I can't drive a browser headlessly — the content-script behavior on live claude.ai/Gemini/ChatGPT needs a human to eyeball. Steps in `EXTENSION.md`. |
| 3 | **Decide on Phase 3** (Focus panel inside the Ledger app) | It means editing your *working* Ledger app + writing to Firestore — I didn't want to touch that blind. Plan is ready. |

---

## Recommended next steps, in order

1. **Validate the core (15 min).** Put your key in `brick/.env`, run `npm run eval`, eyeball the
   accuracy table. Add ~20 URLs from your own browsing to `brick/examples/cases.json` and re-run —
   that's the real test of "is context-aware adjudication good enough?"
2. **Try it for real.** `npm run serve`, load `brick/extension/` unpacked (see `EXTENSION.md`), start
   a focus session, and see how it feels for an hour. Tune the tier lists in the extension's settings.
3. **If it feels good → Phase 3.** Build the Focus panel in the Ledger app so sessions become
   first-class Ledger objects (history/analytics). Blueprint:
   `../ledger/docs/BRICK_PHASE3_LEDGER_APP.md`. Likely first sub-step: add the `ledger focus <id>`
   command (`../ledger-cli/docs/FOCUS_COMMAND_PLAN.md`) so focus selection is explicit.
4. **Later / when it matters:** real bypass-resistance (Phase 4 daemon), screenshot compliance
   (opt-in, local model), Firestore session sync, Memory-Hub grounding (`BRICK_MEM_BIN`).

---

## A few open questions worth your thoughts (no rush)

- **Tier defaults:** I left YouTube/Twitter/X as *adjudicated* (gray-area), not hard-blocked, since
  they're genuinely dual-use. Agree, or hard-block some?
- **Pomodoro:** it cycles work→break forever until you stop it (no fixed end). Want a fixed
  session length / cycle count instead?
- **Friction vs fortress:** the browser extension is easy to bypass by design (Phase 2 = prove the
  value; Phase 4 = make it hard to dodge). Still happy with that order?
- **Secrets hygiene:** the audit came back clean, but consolidating the two Firestore identities is
  still deferred — worth doing before the daemon wires them together.

---

## Where everything lives

```
brick/                      ← the BRICK MODE package (this session's main build)
  README.md                 what it is + all commands
  EXTENSION.md              how to load + run the browser extension
  HANDOFF.md                dev-resume notes + file map
  SESSION_LOG.md            chronological build log + 4 logged divergences
  src/                      the service + CLIs (TypeScript)
  extension/                the Chrome (MV3) extension
ledger/docs/
  BRICK_MODE_PLAN.md        the master plan: 16 decisions, 6 phases, the diagram
  BRICK_PHASE3_LEDGER_APP.md   blueprint for the Focus panel (next phase)
ledger-cli/docs/
  FOCUS_COMMAND_PLAN.md     blueprint for `ledger focus <id>`
```

**Verified state:** build + typecheck clean, `npm run smoke` 8/8, security-reviewed. **Not** yet:
adjudication accuracy (needs your key) or live browser behavior (needs you to load it).
