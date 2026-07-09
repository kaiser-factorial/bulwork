# brick

**BRICK MODE** — the focus-enforcement pillar of the Ledger project-OS. You declare one focus task
(ideally a Ledger project's **Next Action**), start a timed work session, and BRICK decides — per
page — whether what you're looking at serves that focus. Clear distractions are blocked, work is
never touched, and genuinely ambiguous pages get a **question** instead of a wall. Everywhere, the
governing principle is **a false block costs more than a false allow**: when unsure it asks or
allows, and every failure mode (service down, provider outage, malformed model output) degrades to
*allow*, never to a block.

Two parts: a **local service** (the brain, `:7373`) and an **MV3 browser extension** (the
enforcement surface — no secrets, no AI, asks the service for everything).

```
Focus (Ledger Next Action or free text) ──┐
                                          ├─► tiers → learned decisions → model (allow/block/ask)
URL + title (origin+path only, no query) ─┘         (OpenRouter or Anthropic, configurable model)
```

What's built today: tier lists (always-block / adjudicated / always-allow) · Pomodoro sessions with
red/green badge, phase border flash + optional sound cues · the **ask → clarify-and-learn** loop
(remembered per focus, with explicit precedence) · honesty lever (mark a page off-task/on-topic) ·
per-video judging on YouTube + a rabbit-hole time nudge · "one more minute" grace that **pauses the
work clock** (capped, escalating tint) · **day plans** (an ordered queue of blocks with budgets,
steps, repeats) and **workflow templates** (save/re-run parameterized plans) · a grounded in-app
**help agent** ("Ask about BRICK") · an AI-chat focus-prepend pill. See
`../ledger/docs/BRICK_MODE_PLAN.md` for the roadmap and `WORKLOAD_DESIGN.md` for the current
design.

## Setup

```bash
cd brick
npm install
cp .env.example .env      # add OPENROUTER_API_KEY (default provider) and/or ANTHROPIC_API_KEY
```

`.env` is auto-loaded. The adjudicator runs through **OpenRouter by default** (one key, many models,
model picker on the extension's options page); the native Anthropic path is kept as a fallback and
selected automatically when only `ANTHROPIC_API_KEY` is present. `LEDGER_BIN` defaults to the repo's
`ledger` binary; override if yours lives elsewhere.

## Usage

Run directly with `tsx` (no build needed):

```bash
# Choose a focus: a tracked project, free-typed text, or the most recently touched.
npm run dev -- https://github.com/kaiser-factorial/ledger --task "Fix the OAuth redirect bug"
npm run dev -- https://news.ycombinator.com --project <firestore-id>
npm run dev -- https://news.ycombinator.com --last

# With no focus flag, brick lists your projects so you can pick one:
npm run dev -- https://news.ycombinator.com

# JSON output
npm run dev -- https://news.ycombinator.com --last --json
```

> Ledger has no "active project" state — for a focus session you say what you're focusing on
> (`--task` / `--project` / `--last`).

Or build and use the `brick` binary:

```bash
npm run build
node dist/cli.js https://news.ycombinator.com
```

### No API key yet? Use `--dry-run`

Resolves the focus task from Ledger and prints the exact prompt that *would* be sent — proves the
Ledger wiring and prompt end-to-end without calling the API or needing a key:

```bash
npm run dev -- https://twitter.com/home --dry-run
```

### Evaluate on a batch of real URLs

```bash
npm run eval                 # runs examples/cases.json, prints a table + accuracy
npm run eval -- my-cases.json
npm run eval:corrections     # score against YOUR real clarify answers + corrections
npm run cases:export         # just export the learned decisions as cases (.data/corrections.cases.json)
```

`cases.json` is an array of `{ "task", "url", "title?", "expected?" }`. Add 20–30 URLs from your own
browsing to tune the prompt against reality. Cases with an `expected` decision are scored. Better
still: every clarify answer and honesty-lever correction you make in the browser is recorded, and
`eval:corrections` scores the adjudicator against them — the gatekeeper is measured against *your*
judgment over time.

### AI-chat prepend header

The other half of Phase 1. Since you can't set a system prompt on claude.ai / Gemini / ChatGPT, BRICK
injects a focus header into the *outgoing message*. No API key needed — it's pure string assembly
(`src/prepend.ts`); the browser extension (Phase 2) will call the same functions to wrap messages
before they're sent.

```bash
# Header from a chosen project's Next Action (default style = gentle "nudge")
npm run prepend -- --last

npm run prepend -- --task "Prepare the Q3 VAT return"

# See a message wrapped with the header
npm run prepend -- --task "Prepare the Q3 VAT return" --message "what's a good pasta recipe?"

# Stricter ask (decline off-topic) instead of the default check-in
npm run prepend -- --task "Prepare the Q3 VAT return" --strict
```

It's a **soft nudge** (locked decision), framed as *your own* self-imposed reminder rather than a
command to refuse you — a header that tells the assistant to "decline to answer the user" invites
push-back, because models are trained to help the user and resist instructions that work against
them. `--strict` opts into the original decline-and-redirect phrasing; the default `nudge` just makes
the assistant check in before going off-task. Either way the real enforcement is the URL adjudicator
+ tier lists, not this.

## Local service + browser extension

The adjudicator + prepend are exposed as a **local HTTP service** that a **Manifest-V3 browser
extension** drives.

```bash
npm run serve     # local service on http://127.0.0.1:7373 (the "brain")
npm run smoke     # build + self-test the whole service end-to-end — hermetic, key-free, ledger-free
```

Then load `extension/` unpacked in Chrome — full walkthrough in **[EXTENSION.md](./EXTENSION.md)**.
The extension holds no secrets and runs no AI: it asks the service for every decision. Tier-1 sites
block instantly (`declarativeNetRequest`), Tier-2 is adjudicated per-navigation (and per-**video** on
YouTube), Tier-3 is untouched; the Pomodoro gates work/break; AI-chat pages get the opt-in "↳ prepend
focus" pill; the options page holds the model picker, tier lists, focus tuning, feedback toggles,
templates, and the "Ask about BRICK" help panel. All state is local, human-readable JSON under
`.data/` (tiers, settings, learned decisions, plan, templates, `sessions.jsonl`).

**Day plans:** from the popup, queue blocks (`task | minutes` per line) or launch a saved template;
the active block *is* a normal focus session and `advance now` walks the queue. Blocks can carry
auto-detected **stop conditions** (git push/merge/message, Ledger next-action change, opt-in shell
command) — a met condition auto-advances with an ↩ undo or lights up "advance now" (your choice);
budgets escalate (heads-up → nudge → re-nudge) across the popup, an in-page card, and OS
notifications, and never silently flip the queue.

**Memory-Hub grounding (fast-follow):** set `BRICK_MEM_BIN` to enrich adjudication with the project's
own context via the Unified Memory Hub's `mem` CLI. Off by default; fails open.

## How it works

- **Focus task resolution** (`src/ledger.ts`): precedence is `--task` → `--project <id>` → `--last`
  (most recently touched). Ledger has **no "active project" state** ("active" there only means
  not-archived), so with none of these `brick` lists your projects and asks you to pick — it never
  silently guesses. A chosen project's task is its **Next Action**, falling back to its status note,
  then its name. This is BRICK's keystone — the focus task *is* the Ledger Next Action, not a string
  retyped each session.
- **Adjudication** (`src/adjudicate.ts` behind `src/providers/*`): the configured model — OpenRouter
  by default, Anthropic as the fallback path — with a few-shot prompt (`src/prompt.ts`) and **forced
  tool use** guaranteeing a structured `{ decision, reason, confidence }` verdict, where decision is
  `allow | block | ask` (`ask` = the focus is too vague to judge → the clarify card, never a wall).
- **Precedence before the model** (`src/decisions-store.ts`): **Tier-1 block > learned block >
  learned allow > Tier-3 allow > model** — remembered answers short-circuit instantly, free.
- **Conservative-allow**: a `block` whose confidence is below `BRICK_MIN_BLOCK_CONFIDENCE`
  (default 0.6) is downgraded to `allow`, so a shaky call never interrupts real work.

## Configuration

| Variable | Purpose | Default |
|---|---|---|
| `OPENROUTER_API_KEY` | Default provider auth (Tier-2 stubs to allow with no key at all) | — |
| `ANTHROPIC_API_KEY` | Fallback provider auth (used automatically if it's the only key) | — |
| `BRICK_PROVIDER` | Force `openrouter` or `anthropic` | auto by key presence |
| `BRICK_MODEL` | Seed model id (options-page choice overrides it) | provider default |
| `LEDGER_BIN` | Path to the `ledger` CLI | repo path |
| `BRICK_MIN_BLOCK_CONFIDENCE` | Below this, a block becomes an allow | `0.6` |
| `BRICK_PORT` | Local service port | `7373` |
| `BRICK_MEM_BIN` | Memory-Hub `mem` command for grounding (unset = off) | _unset_ |
| `BRICK_DATA_DIR` | Where all `.data/*` state lives | `brick/.data/` |
| `BRICK_HELP_DIR` | Help-agent corpus directory | `brick/help/` |

## Status & what's next

**Built:** Phases 1–2 (adjudicator, prepend, service, extension, tiers, Pomodoro) + the full
**workload early wave** (provider seam/model picker, gatekeeper quality: ask/clarify/learned/
honesty/per-video/rabbit-hole, session feedback, focus-time integrity, help agent) + the **complete
local-first plan layer**: **A** (day-plan queue), **T** (workflow templates), **B** (auto-detected
stop conditions — git/ledger/command watchers, swap policy, auto-advance + undo), **C** (escalating
switch notifications across popup/in-page/OS). Verified by the hermetic `npm run smoke` plus live
passes; see `HANDOFF.md` and `SESSION_LOG.md`.

**Next:** Epic **D** (plans/templates as first-class Ledger objects — the only epic that edits the
mature Ledger app; needs the ledger_root repos + Firestore creds). Further out: Phase 3 (Focus UI
inside the Ledger app) and Phase 4 (privileged daemon + bypass resistance).
