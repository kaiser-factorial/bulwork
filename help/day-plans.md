# Day plans

## What is a day plan?

A day plan is an ordered queue of work blocks — "today: grant outline (50m) → lab check (15m) →
review PRs (25m)". Each block is a focus session bound to a task (or a Ledger project), with an
optional time budget and an optional step checklist. The currently-active block IS a normal focus
session, so blocking, adjudication, learned decisions, and the Pomodoro all work exactly as in a
single session — anchored to whichever block is live. The plan survives service restarts.

## Starting a day plan

In the popup (no session running), fill the **day plan** textarea — one block per line in the form
`task | minutes` (minutes optional) — and press **▶ start day plan**. The first block goes active
immediately. The work/break minutes fields above apply to the whole plan's Pomodoro cycle.

## Budgets are advisory

A block's minutes are an attention allocation, not a hard stop: when the budget runs out nothing is
blocked — the block is marked ready ("advance now" lights up in the popup) and the decision to move
on stays yours, unless the block's swap mode says otherwise.

## Stop conditions — "done when I push"

A block can carry auto-detected stop conditions: **git** (a ref advanced, a merge landed, or a
commit message matching a pattern — e.g. "done when I push"), **ledger** (the project's Next Action
changed — advancing the project in Ledger is the completion signal), **command** (a shell command
exits successfully — off by default, enabled only with the BRICK_ALLOW_COMMAND_CONDITIONS
environment flag), and **manual** (always available — the popup's advance is the escape hatch).
The service polls the active block's conditions about every 30 seconds. Detection never
false-completes: a broken repo or failing check simply never fires, and a met condition stays met.

## Swap modes — what actually advances the queue

Each block's swap mode combines its budget and conditions: **condition** (swap when the condition
is met; budget only nudges), **time** (swap intent at the budget; conditions tracked but don't
drive), **first** (whichever comes first — the default when a block has both), **both** (a
minimum-time floor: at least the budget AND the condition). Time-driven swaps always land as a
nudge — the queue never silently flips because a clock ran out.

## Advance mode — auto with undo, or manual

When a stop-condition is met, the **advance mode** setting (options page) decides what happens:
**auto** (default) advances the queue immediately and offers an **↩ undo switch** button in the
popup for a configurable window (default 30s) — undoing returns you to the block, marked ready, and
it won't auto-fire again; **manual** just lights up **advance now** and waits for your tap. A block
can override the global setting.

## Advancing, steps, and the queue

The popup shows the plan strip (block 2 / 3), the active block's budget countdown, its step
checklist (click a step to toggle it), and the full queue with status glyphs — ✓ done (with actual
minutes), ▶ active, ○ pending, ✗ skipped, ↻ repeating. **advance now →** completes the active block
and starts the next; advancing the last block ends the plan. **■ end plan** stops everything —
remaining blocks are marked skipped.

## Repeating blocks

A block created with repeat re-enqueues a fresh copy of itself at the queue tail each time it
completes — good for "check the lab job → back to the project → check again". A per-day cap
prevents infinite loops. Repeating blocks show ↻ in the queue.

## The badge during a plan

During a plan the toolbar badge shows the active block's remaining budget minutes, and hovering
shows the queue position — "2/3 · lab check · 9m left". The red/green work/break coloring and the
grace ⏸ indicator work as usual.

## Workflow templates — saving and re-running plans

A template is a saved plan skeleton you can re-run without rebuilding it. While a plan is running,
the popup's **☆ save plan as template** button stores it — choose **parameterize** to lift the
plan's projects into named slots (A, B, …) so you can re-bind them to different projects at launch,
or keep it bound as-is. Saved templates appear in the popup's **saved template** row: pick one, bind
any slots (choose a project per slot, or type a task), and **▶ start from template**. Templates are
managed (listed and deleted) on the options page under **Workflow templates**.

## Alternating and repeating patterns

A template can carry a pattern — repeat its block list N times, or **until end of day** (whole
patterns are added while their total budget still fits before midnight; until-end-of-day requires a
budget on every block). The classic use: two slots A and B with 2-hour blocks and until-end-of-day
gives you A,B,A,B… across the whole day, re-bindable to any pair of projects each morning.

## Escalating budget notifications

A block's budget escalates instead of walling you off: about 5 minutes before it ends you get a
quiet heads-up (amber badge tint + a banner in the popup); at time-up an OS notification and an
in-page corner card fire ("Time's up on A — next: B?" with **Advance / Stay**); a few minutes past
budget a more insistent re-nudge fires and the badge goes deep red. Each nudge fires exactly once
per level. When a stop-condition auto-advances the queue, you're notified with an **↩ Undo** right
on the page. OS notifications reach you even when the browser is in the background.

## Where is my plan stored?

Locally in the service's `.data/plan.json` — the same Ledger-native shape the plan will eventually
have as a first-class Ledger object. Delete the file (or end the plan) to reset.
