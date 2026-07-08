# Sessions, grace, and feedback

## The phase border flash

On every work/break flip, a colored border flashes around the screen — **red entering work, green
entering break** — then fades after about 10 seconds (configurable). It never blocks clicks or
scrolling, and respects your OS reduced-motion setting (a steady fade, never a strobe). Toggle it
and set the duration in options → **Session feedback**.

## Sound cues

Optionally, each transition plays a short cue: a low "settle in" tone entering work, a light
ascending twinkle entering break. Sound is **off by default** — enable it in options → Session
feedback. The cue plays exactly once per transition (never once per tab). The **🔈 test sound**
button previews both cues; pressing it once also primes the browser's audio path so timer-fired cues
play reliably afterwards.

## "Just 1 more minute" — the grace overlay

When work re-engages on a page you were already using and it's off-task, you get the soft "Back to
BRICK MODE" prompt with **Just 1 more minute**. Taking it shows a red vignette with a 60-second
countdown chip; the page stays usable. When the countdown ends the page is re-checked — on-topic now
clears it, still off-task re-prompts. The chip itself is clickable ("tap for back to work") to end
grace early at any time.

## Grace pauses the work clock

Minutes spent on the grace overlay are **not** stolen from your work block: while grace is active
the phase countdown pauses (the badge freezes and shows ⏸), and when you return the block end is
pushed forward by exactly the paused time — a 10-minute block with two detours still delivers ten
full minutes of actual work.

## The grace cap and escalating tint

Pausing can't go on forever. Total grace per work block is capped (**max grace min/block** in
options → Session feedback, default 5 minutes) — past the cap, "one more minute" is refused and the
page hard-blocks. Within a block, each repeated grace click deepens the red tint (lightest first,
darker every repeat, never a full black-out — the return control stays visible and clickable). The
tint resets to lightest at the next work block: a fresh start is fresh; only repeated dodging in one
block escalates.

## Where are my sessions logged?

Session events (starts, phase flips, adjudications, stops) append to `.data/sessions.jsonl` next to
the service — a local, human-readable audit trail. Nothing is synced to any cloud.
