# Service and troubleshooting

## Running the local service

From the `brick/` directory: `npm install` once, then `npm run serve`. The service listens on
http://127.0.0.1:7373 and prints its provider, model, and key status on boot. The extension talks
only to this service; keep it running while you work. `npm run smoke` builds and self-tests the
service end-to-end without needing any API key.

## Loading the extension

Chrome/Edge/Brave: open chrome://extensions, toggle **Developer mode**, **Load unpacked**, select
the `brick/extension/` folder. Pin the toolbar icon. After pulling code changes, press the reload
(↻) icon on the extension card and refresh any open tabs you're testing on.

## "Service not reachable" in the popup or options

Start (or restart) the service: `cd brick && npm run serve`. The extension fails open while the
service is down — nothing gets blocked, and enforcement resumes automatically once it's back.

## Tier-1 sites aren't blocking

Blocking is only active during the **work** phase of a running session. Check the toolbar badge: red
= work (blocking on), green = break (restrictions lifted), no badge = no session. Tier-1 rules are
set on session start and on each work re-engage.

## Where does BRICK store its data?

Everything lives locally under `brick/.data/`: `tiers.json` (your tier lists), `settings.json`
(model choice, focus-tuning lists), `decisions.json` (learned allow/block decisions),
`sessions.jsonl` (the session log), and `corrections.cases.json` (exported eval cases). All plain,
human-readable JSON — your audit trail and your privacy valve (delete a file to reset that store).

## What does BRICK send to the model?

For a Tier-2 check: your focus task, the page's origin and path (query strings and fragments are
stripped), and the page title. Nothing else — no page content, no keystrokes, no browsing history.
Help questions from the "Ask about BRICK" panel go to the same configured provider along with
excerpts of BRICK's own documentation.

## Debugging the extension

Service-worker console: chrome://extensions → BRICK MODE → **service worker**. Content-script logs:
open DevTools on the page you're testing (the guard fails open silently). Most "nothing happens"
reports are one of: no active session, currently in break phase, or the service not running.
