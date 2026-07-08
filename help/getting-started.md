# Getting started

## What is BRICK MODE?

BRICK MODE is a focus-enforcement tool: you declare one focus task, start a timed work session, and
BRICK decides — per page you visit — whether that page is consistent with your focus. Clear
distractions are blocked, work is never touched, and genuinely ambiguous pages get a question instead
of a wall. It has two parts: a local service ("the brain", `npm run serve`, http://127.0.0.1:7373)
and a browser extension ("the enforcement surface") that talks to it. The extension holds no secrets
and runs no AI — every decision comes from the local service. The guiding principle everywhere: a
false block costs more than a false allow, so when in doubt BRICK asks or allows — and if the service
is down, everything fails open (nothing is ever hard-blocked by an outage).

## Starting and stopping a focus session

Click the BRICK MODE toolbar icon to open the popup. Pick a focus three ways: choose a **Ledger
project** from the dropdown (its Next Action becomes the focus), pick "most recently touched", or
**free-type a task** in the text field. Set work and break minutes (defaults 25/5), then press
**start focus session**. The popup switches to a live timer. Press **■ end session** to stop — all
blocking lifts immediately. Tip for testing: set work = 1 and break = 1 minute to watch the cycle
flip quickly.

## The toolbar badge

During a session the toolbar icon shows a countdown badge: **red with minutes-left during work,
green during break**. Hovering shows the phase and your focus task. If the badge shows a pause
symbol (⏸), the work clock is paused because a grace overlay is active (see the sessions doc). No
badge means no active session.

## The Pomodoro cycle

A session alternates work and break phases automatically on your chosen durations. During **work**,
blocking is active (Tier-1 rules on, Tier-2 pages adjudicated). During **break**, restrictions are
lifted — blocked sites load normally. When work re-engages after a break, already-open tabs are
re-checked: an off-task tab you left open gets the soft "Back to BRICK MODE" overlay rather than a
hard redirect. The cycle continues until you end the session.

## The AI-chat focus pill

On claude.ai, Gemini, and ChatGPT a small pill appears bottom-right showing your focus task, with a
**"↳ prepend focus"** button. Clicking it inserts a soft-nudge focus header into the chat composer —
a reminder to the AI (and to you) of what the conversation should serve. It is opt-in per message,
never automatic.
