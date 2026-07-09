# BRICK MODE — build session log

Running log of autonomous build work. Newest entries at the bottom. **DIVERGENCE** marks any
deviation from `../ledger/docs/BRICK_MODE_PLAN.md`. Date basis: 2026-06-26.

---

## Phase 1 — adjudicator + prepend (DONE, pre-goal)

- `src/adjudicate.ts` — Claude Haiku 4.5, forced tool use → `{decision, reason, confidence}`.
- `src/ledger.ts` — focus task from a chosen Ledger project's Next Action (`--task`/`--project`/`--last`).
- `src/prepend.ts` — soft-nudge AI-chat focus header.
- CLIs: `brick`, `brick-prepend`; `npm run eval` harness.
- Verified: build + typecheck clean; Ledger wiring live; dry-run + prepend render.
- **VALIDATED 2026-06-27:** user added `ANTHROPIC_API_KEY`. `npm run eval` = **12/12**, then expanded
  to **25/25 (100%)** with dual-use cases (~1.2s avg) — nailed every same-site/opposite-intent pair
  (YouTube tutorial vs lofi, SO oauth vs center-a-div, HN item vs front page, etc.) with calibrated
  confidence. Core adjudication confirmed strong.
- **FINDING — title gap:** the dual-use wins depend on the `title` field (8 cases). Production
  `content-guard.js` sends URL-only at `document_start` (title not yet populated), so opaque dual-use
  URLs lean conservative-allow in the browser. → **Addressed** by the two-phase guard below.

## User-feedback tuning (2026-06-27)

Corina flagged that "lofi study music" and a general "how to center a div" question should PASS —
her policy is more charitable than my test expectations encoded.

- **Leniency retune** (`prompt.ts`): the adjudicator now ALLOWS focus aids (instrumental/ambient/
  study music) and adjacent professional/technical/learning content even when off the exact task;
  BLOCKS only clear recreation/distraction (social feeds, forum/aggregator front pages, entertainment
  watched for fun, sports, shopping, personal-interest, leisure news). Few-shot updated; flipped the
  two cases' `expected` to allow. **Re-eval: 25/25** — lofi→allow, center-a-div→allow, while
  medieval-peasant video, Taylor Swift, HN front page, reddit/r/all still block. Distinctions held.
- **Constant visual — toolbar countdown badge** (`background.js` `updateBadge()`): a colored badge
  on the action icon — **red + minutes-left during work, green during break**, cleared when no
  session. Driven by a 1-min `brick-tick` alarm + updates on start/stop/phase-flip/reconcile; tooltip
  shows phase + focus task. (Requested by Corina as an always-visible session indicator. The popup
  keeps the per-second timer.) Syntax-checked; **needs browser verification** of badge rendering.
- **Custom icon — yellow brick wall** (`extension/icons/`): full-bleed running-bond yellow bricks
  (no white bg) per Corina's reference. Source `brick.svg` → `icon{16,32,48,128}.png` via
  `scripts/make_icons.py` (Pillow; cairosvg fallback). Wired into `manifest.json` (`icons` +
  `action.default_icon`). The red/green countdown badge sits on top of it.
- **Bug fix — phase-transition didn't re-check open tabs** (Corina: "swaps to work mode but I can
  keep tweeting"). DNR + content-guard only fire on *navigation*, so a tab open from the break was
  never re-evaluated when work re-engaged. Added `enforceOpenTabs()` (sweep all tabs, redirect
  off-task ones to the block page) called on **work re-engage / session start / reconcile**, plus
  `chrome.tabs.onActivated` to re-check a tab when you switch to it during work. **Re-added the
  `tabs` permission** (the security pass had dropped it as unused — now genuinely needed for
  cross-tab enforcement; reads tab url/title to adjudicate). Tier-1 local/free; only Tier-2 tabs
  cost a Claude call. Syntax-checked; **needs browser verification**.
- **Soft "caught" overlay, scoped to the passive case** (Corina's design + refinement —
  `content-guard.js`): a content-script **modal** ("Back to BRICK MODE 🧱" + reason + "Just 1 more
  minute" / "Back to work →"); "1 more minute" → red vignette + countdown chip (non-blocking) →
  re-prompts at 0:00 (friction, not a lock). **Grace is earned by circumstance, not choice:**
  - **Soft (grace)** ONLY when work begins while you're already on the page — the `enforceOpenTabs`
    passive sweep (break→work re-engage / session start / reconcile), which sends `brick:catch`.
  - **Hard block** (redirect to `block.html`, no grace) when you *navigate* to an off-task page during
    work (`content-guard` nav check) or *switch* to an off-task tab during work (`onActivated`), and
    for all Tier-1. `enforceTab(tab, soft)` gates this.
  Syntax-checked; **needs browser verification** (overlay rendering on real sites, snooze timing).
- **"Check deeper" — two-phase guard** (`content-guard.js` + `background.js` `guard(url,title)`):
  Phase 1 = fast URL-only check at `document_start`; Phase 2 = a DEEPER re-check with the page's
  `title` + meta description + `h1` once it loads (only for genuine Tier-2 allows; skips Tier-1/3 and
  stubs). Closes the title-gap so the browser approaches eval-quality judgment. Fails open.
  **Needs browser verification** — the Phase-2 redirect-after-load timing can't be tested headless.

---

## Phase 2 — browser-extension MVP (IN PROGRESS)

### DIVERGENCE 1 — extension needs a thin local service
The plan says "wrap the adjudicator in a browser extension." A browser extension **cannot** safely
hold the Anthropic key or shell out to `ledger-cli`. So the MVP is **extension ⇄ local service ⇄
(ledger-cli + Claude)**. The local service (`src/server.ts`, `127.0.0.1:7373`) reuses every Phase-1
module. This is not a contradiction — it's the embryonic **`brick-daemon` from Phase 4**, pulled
earlier because the extension requires it. Phase 4 then hardens this same service (privileged daemon,
bypass resistance) rather than introducing a new process.

### DIVERGENCE 2 — adjudicated blocking under Manifest V3
MV3 removed blocking `webRequest`. Tier-1 (static) blocking uses `declarativeNetRequest` dynamic
rules → redirect to a block page. Tier-2 (adjudicated) blocking can't be a static rule, so a
content script at `document_start` asks the background worker (which calls `/adjudicate`) and, on
block, replaces the page with an overlay. Logged because it shapes the extension architecture.

### DIVERGENCE 3 — tier defaults
Kept `youtube`/`twitter`/`x` in **Tier-2 (adjudicated)** rather than the doc's Tier-1, because
they're genuinely dual-use and adjudicating them is the whole point of BRICK. Hard Tier-1 is reserved
for rarely-work sites (instagram, tiktok, netflix, reddit, discord, …). Tier lists are user-editable.

### Placeholders in play
- `ANTHROPIC_API_KEY` absent → `/adjudicate` returns `{decision:"allow", confidence:0, stub:true}`
  for Tier-2, clearly flagged. Tier-1/Tier-3 still resolve without a key.
- Firestore session-log sync → `session.ts` writes local JSONL; `syncToFirestore()` is a stub
  (needs the same service-account creds as `ledger-cli`).
- Loading the unpacked extension into Chrome and runtime-testing content scripts → can't be done
  headless here; extension code is written + statically reviewed, not browser-verified.

### Built so far
- `src/tiers.ts` — tier config + `classify(url)`.
- `src/session.ts` — Pomodoro/focus session state + JSONL session log (+ Firestore stub).
- `src/server.ts` — local HTTP service (`/health`, `/config`, `/projects`, `/session*`,
  `/adjudicate`, `/prepend`). `npm run serve`.

### DIVERGENCE 4 — prepend is an opt-in control, not send-interception
The plan/doc imagined intercepting outgoing chat messages and prepending the header automatically.
Reliable send-interception is per-site and DOM-fragile (claude.ai ProseMirror vs ChatGPT textarea vs
Gemini), and impossible to verify headless. The MVP instead injects a focus **pill with a "↳ prepend
focus" button** (`extension/content-prepend.js`). This is reliable, matches the **soft-nudge** locked
decision (the prepend is optional anyway), and leaves auto-on-send as a future per-site enhancement.

### Extension built (`extension/`, MV3)
`manifest.json`, `background.js` (state + DNR Tier-1 rules + Pomodoro alarms + message router),
`content-guard.js` (Tier-2 adjudication on navigation → block page), `content-prepend.js` (focus
pill), `block.html/js`, `popup.html/js` (focus picker + live timer), `options.html/js` (status + tier
lists). All JS passes `node --check`; manifest is valid JSON.

### Editable tier lists (fulfils DIVERGENCE 3's "user-editable" promise)
`src/config-store.ts` persists tiers to `.data/tiers.json` (defaults from `tiers.ts` when absent);
`POST /config/tiers` saves; the options page is now editable textareas. Verified: add `example.com`
→ persisted → classified Tier-1 → blocked.

### Phase-2 fast-follow — Memory-Hub grounding (wired, inert)
`src/grounding.ts` + threading through `prompt.ts`/`adjudicate.ts`/`server.ts`. Optionally runs
`mem query "<focus task>"` to ground adjudication in the project's real context. **Gated on
`BRICK_MEM_BIN`** (off by default; needs the Hub + its Gemini key). Fails open. `/health` and
`/config` report `grounding: false`.

### Verification (headless)
- `npm run build` + `npm run typecheck`: clean.
- `npm run smoke`: 7/7 (health, tier1 block, tier3 allow, tier2 resolve, session start/prepend/stop).
- Manual curl: session lifecycle + JSONL log (`.data/sessions.jsonl`) confirmed; focus resolves from
  Ledger live.

### Docs
`EXTENSION.md` (load + run), `HANDOFF.md` (state/resume/blocked), this log; `README.md` updated.

---

## Next / not attempted (boundary — needs the user)

Stopped here because every remaining step genuinely needs you:
1. **Validate adjudication** — `ANTHROPIC_API_KEY` → `npm run eval` (Tier-2 is stub-allow until then).
2. **Browser-verify** the extension on live claude.ai / Gemini / ChatGPT (per-site tuning likely).
3. **Phase 3 (Focus UI in the Ledger app + session-as-Ledger-object)** — deliberately **not started**:
   it means editing the mature Ledger React app and writing to its Firestore (creds needed). Doing
   that blind risks breaking a working app. Recommended first step when you engage: add a real
   `ledger focus <id>` / current-focus field (also noted in BRICK_MODE_PLAN decision #11) so BRICK
   reads an explicit focus instead of a heuristic, then build the Focus panel against it.
4. **Phase 4 (daemon + bypass resistance)** — the local service is its precursor; hardening it into a
   privileged Network-Extension daemon is native macOS work that can't be built/verified headless.

---

## Agent-assisted hardening + planning (user opted into agents)

Ran 3 subagents: an adversarial security/correctness review of the brick stack, and two grounded
planning passes (Phase-3 Ledger app, `ledger focus` CLI command).

### Review fixes applied (verified: build + smoke 8/8 + curl auth/CORS checks)
- **[HIGH] CSRF-to-localhost / data exfiltration** — any visited web page could hit `:7373` and read
  the project list via `ACAO:*`. Fixed in `server.ts`: only reflect ACAO for `chrome-extension://` /
  localhost origins (never `*`), and require an `X-Brick-Client` header on every request (a
  cross-origin page can't set it without a preflight that's denied). Extension + smoke now send it.
  Verified: no-header → 403; `evil.example` origin → no ACAO; extension origin → ACAO reflected.
- **[HIGH] DNR rule-id collision** disabling Tier-1 blocking — `background.js` now clears the whole
  reserved id range before adding and wraps `updateDynamicRules` in try/catch.
- **[HIGH] Service-worker suspension** killing the Pomodoro — moved session state to
  `chrome.storage.local`, added `onStartup`/`onInstalled` `reconcile()` that catches up missed phases
  and re-arms the alarm.
- **[MED] `BRICK_DATA_DIR` path concat** → `path.join` (`session.ts`, `config-store.ts`).
- **[MED] `/config/tiers` unbounded write** → entry count/length caps in `normalize`.
- **[MED] full URL (w/ query) sent to the model** → `server.ts` `modelUrl()` strips query/fragment.
- **[LOW] unused `tabs` permission** dropped; **[LOW] confidence clamp** to `[0,1]` + decision
  validation in `adjudicate.ts`; **[LOW] `focusFor`** now prefers the active session's focus over a
  per-call `task` (no hijack).

### Reviewer findings deliberately NOT changed (documented)
- Tier-2 content-script blocking is best-effort (document_start race, SPA route changes, fail-open) —
  acceptable for the MVP nudge; real enforcement is the Phase-4 daemon.
- Continuous work/break cycling until manual stop is intentional (no fixed session end).
- `execCommand("insertText")` in the prepend pill may no-op on some SPA composers — graceful, per-site
  tuning is future work.

### Planning docs written (de-risk the phases not built)
- `../ledger/docs/BRICK_PHASE3_LEDGER_APP.md` — Focus panel + `FocusSession` Firestore object; the
  key gotcha is `BRICK_USER_ID` (Admin writes bypass rules, so a missing uid = invisible docs).
- `../ledger-cli/docs/FOCUS_COMMAND_PLAN.md` — `ledger focus <id>` as a `state/focus` pointer doc
  (recommended over an `isFocused` field); replaces BRICK's `--last` heuristic.

---

## Workload early wave — service lane + overlay prelude (2026-07-08)

First build session on the `WORKLOAD_TICKETS.md` plan. Landed the most-verifiable-offline slice of the
early wave (Epics R, 0, U). All on branch `worktree-workload-early-wave` (draft PR).

### BRICK-R1 — provider seam + OpenRouter (DONE)
- New `src/providers/`: `provider.ts` (neutral `VerdictProvider` contract), `anthropic.ts`,
  `openrouter.ts` (OpenAI SDK → `https://openrouter.ai/api/v1`, forced `tool_choice` function, JSON-
  string args parsed defensively, `content ?? ""` for the canary), `index.ts` (selection + key check).
- `adjudicate.ts` refactored behind the seam; **R3 folded in** — provider/network error or malformed
  output **fails open to allow** (never a hard block/throw). Canary/shield + conservative-allow intact.
- **Selection:** `BRICK_PROVIDER` wins; default `openrouter`, but **gracefully falls back to
  `anthropic` when only `ANTHROPIC_API_KEY` is present** — so the existing Anthropic-only install keeps
  adjudicating instead of silently failing open. Added `openai` dep.
- **Verified live (2026-07-08).** `npm run eval` scratch set: **OpenRouter** default (`anthropic/
  claude-haiku-4.5`) = structured verdicts + `ask`, 3/3; **`BRICK_PROVIDER=anthropic` fallback** = 3/3;
  **R3 fail-open** = a bogus model id degrades to `allow` (conf 0, clear reason), no crash/hard-block.
  Remaining Phase-R item: **R2** (switch the model from the options page) — separate ticket, next up.

### BRICK-0.1 / 0.4 — `ask` outcome + source-aware leniency (DONE)
- `Decision` is now `allow | block | ask`; forced-tool enum + few-shot updated (`ask` = focus too
  vague to judge, distinct from confident off-task). `background.js` already maps `allow = decision !==
  "block"`, so an `ask` verdict **fails open in the live extension** until the clarify card (0.3) ships.
- 0.4: `buildUserPrompt` biases a bare `explicit` free-typed focus toward ask/lean-allow.
- **Verified live:** vague "assignment" → `logitloom` = **ask**, "assignment" → `instagram` = **block**
  (correctly doesn't over-ask), grounded cases allow/block correctly.

### BRICK-0.2 — learned-decision store + precedence (DONE)
- New `src/decisions-store.ts` (`.data/decisions.json`, keyed by `(focusKey, scope, unit)`;
  `focusKey = projectId ?? normalize(task)`; invalid file → empty, no throw). Pure `resolvePrecedence`
  implements **Tier-1 block > learned block > learned allow > Tier-3 allow > model**.
- `server.ts`: checks the store **before** the model and short-circuits a hit (`via:"learned"`, ~0
  latency, no API call); routes `POST /decisions/learn`, `POST /decisions/clear`, `GET /decisions`;
  `GET /config` gains a gatekeeper readout (counts). Stub gate now keys off the **active provider**.

### BRICK-U1 — shared overlay primitive (DONE, browser-verify pending)
- New `extension/overlay.js` — one `window.BrickOverlay.show()` renders a fixed, `pointer-events:none`,
  high-z-index full-viewport treatment: params `color / fill / border / glow / breathe / chip / card /
  duration`. Fade in-out, `prefers-reduced-motion` aware, replace-not-stack. Loaded before
  `content-guard.js` in the manifest.
- `content-guard.js` grace modal + vignette **reimplemented through the helper** (no user-perceptible
  change; the breathing pulse is now a smooth `filter:brightness` cycle rather than restarting each
  tick). Border-only variant is what S1 will use.

### Verification
- `npm run typecheck` + `npm run build` clean; `node --check` on all extension JS clean.
- **`npm run smoke` rewritten: 27/27 green, now hermetic + key-free + ledger-free** — unit-tests the
  five precedence orderings + `findLearned`, runs the server against a throwaway `BRICK_DATA_DIR`, and
  drives focus with an explicit `task` (no ledger binary needed). Learn → short-circuit → precedence
  (Tier-1 beats learned allow; learned block beats Tier-3) → clear all asserted.

### Pending on you (verification the environment can't do)
- ✅ **OpenRouter live pass — DONE (2026-07-08)**, after Corina added `OPENROUTER_API_KEY` to `.env`
  (OpenRouter verdicts + Anthropic fallback + R3 fail-open all confirmed; see the R1 line above).
- 🖐 **Browser regression (U1):** confirm the grace overlay still looks/behaves the same on real sites
  (preview harness was shared for a quick eyeball).

### BRICK-R2 — configurable model + tool-capable dropdown (DONE, 2026-07-08)
- **Settings store:** `BrickSettings` + `loadSettings`/`saveSettings` in `config-store.ts`
  (`.data/settings.json`; blank model = "unset" → reverts to seed). Extensible for Epic B's
  `advanceMode`/`undoWindowSec`.
- **Server:** effective model = `settings.model || BRICK_MODEL || provider.default`; `GET /config`
  reflects it (+ `seedModel`, `settings`); `POST /config/settings` persists; `/adjudicate` sends the
  effective model per-request **and echoes the model actually used** in the response. Model is now a
  per-request `AdjudicationInput.model` (overrides env/default).
- **Tool-capable dropdown (Corina's ask):** new `GET /models` fetches OpenRouter's catalog
  **server-side** (key never leaves the service), filters to `supported_parameters ∋ "tools"` (263 of
  343), sorts by name, caches 1h. Options page uses a native `<input list=datalist>` **combobox** —
  click for the full list *or* type to filter, and it doubles as the free-text custom-id field (for
  Anthropic-path ids not in the catalog). `background.js` gains `getModels` + `saveSettings` routes.
- **Verified live:** `GET /models` = 263 tool models; set `openai/gpt-5-mini` → `/adjudicate` response
  `model: openai/gpt-5-mini-2025-08-07` (the chosen model was actually used, not the default); a bogus
  id → fail-open allow (conf 0), no crash. `npm run smoke` = **31/31** (added the settings round-trip;
  still hermetic/offline — tier-1 short-circuits, no network model call).
- **Remaining Phase-R:** none blocking — R4 (multi-model eval table) is optional. Provider/model epic
  is functionally complete.

### BRICK-0.3 / 0.5 — clarify overlay + honesty lever (DONE, 2026-07-08)
- **Overlay card extended** (`overlay.js`): `corner` (non-blocking bottom-right toast, no backdrop),
  `checkbox`, `links`, a green `yes` button kind, and button/link `onClick(ctx)` receives the
  checkbox state — all additive to the U1 primitive.
- **0.3 clarify flow** (`content-guard.js`): an `ask` verdict (from phase-1 or the deeper title
  check, and from grace `recheck`) shows the corner card — **Yes, on-topic** / **No, block** /
  **remember for this focus** checkbox / **make focus more specific** link. "remember" → `POST
  /decisions/learn` (`via:"clarify"`); unchecked applies once. Ignored → fail open (page stays; a
  per-load `clarifiedHref` guard prevents re-nagging). "No" soft-blocks via `goBack`. The specificity
  link `prompt()`s and calls new **`POST /session/refocus`** (`session.ts` `refocusSession`), then
  re-evaluates.
- **0.5 honesty lever**: popup active view gains **⚑ off-task** / **✓ on-topic** for the current tab
  → `markPage` in `background.js` learns `via:"correction"` and soft-blocks (off-task, `brick:catch`)
  or returns a blocked tab to the page (on-topic); resolves the real URL behind `block.html`. Options
  page gains a **gatekeeper readout** (`total · allow/block · clarify/correction`) + **clear learned
  decisions** button. `background.js` routes: `learn`, `refocus`, `markPage`, `clearDecisions`.
- **Verified:** typecheck + `node --check` (all 7 extension JS) clean; `npm run smoke` = **33/33**
  (added refocus + clarify/correction count checks). **Live route run** (active session): clarify
  yes+remember → learned allow short-circuits `via:learned`; correction → learned block; refocus
  changes the focusKey so the old learned allow stops applying (page returns to the model); readout
  counts + clear all correct.
- 🖐 **Browser-only left:** eyeball the clarify corner card, the popup off-task/on-topic buttons, and
  the options readout in Chrome (preview harness updated with the clarify card).

### BRICK-0.6 / 0.7 / 0.8 — the Epic-0 tail (DONE, 2026-07-08). **Epic 0 is complete.**
- **0.6 corrections → eval cases:** `LearnedDecision` gains `sampleUrl` (captured on `/decisions/learn`);
  pure `decisionsToCases()` in `decisions-store.ts` maps learned entries to `(task, url, expected)`;
  `scripts/export-cases.mjs` writes `.data/corrections.cases.json`; npm scripts **`cases:export`** and
  **`eval:corrections`** (export + score). Writes to `.data/`, not the curated `examples/cases.json`.
- **0.7 per-page scoping (YouTube):** `BrickSettings.pageScopeDomains` (default youtube.com/youtu.be in
  the client); content-guard derives the `?v=` **video id as the `unit`** on every guard call (phase-1,
  deeper, grace recheck, SPA), learns with `scope:"page"`, and installs an **SPA hook**
  (pushState/replaceState patch + popstate) that re-adjudicates ~0.7s after each video change (lets the
  title update; resets the clarify no-renag guard per video). `background.guard` forwards `unit`;
  `learn` forwards `scope`/`unit`.
- **0.8 rabbit-hole nudge:** `BrickSettings.rabbitHoleDomains` (default youtube.com) +
  `rabbitHoleMinutes` (default 45). Background accrues **one active-minute per TICK_ALARM** for the
  focused tab's flagged domain during work only (`chrome.storage.local` `brickRabbit`; reset per
  session; /config cached 30s). Each threshold crossing fires **one** `brick:rabbithole` (dedup by
  level) → corner card "keep going / wrap up"; wrap-up reuses `markPage` (learned block via correction
  + soft-block).
- Options page gains a **Focus tuning** section (per-page domains, rabbit-hole domains, threshold) via
  `/config/settings`. Fixed `/config/settings` to accept the new fields (was model-only — caught by the
  new smoke check).
- **Verified:** typecheck + `node --check` (7 files) clean; **smoke 37/37** (adds: page-block-doesn't-
  leak, decisionsToCases, focus-tuning round-trip, page-scope short-circuit). Live: page-scope allow
  short-circuits its video while a different video goes to the model and is **blocked** (autoplay-drift
  case proven end-to-end); export script produces correct eval cases from a scratch store.
- 🖐 Browser-only: YouTube SPA re-adjudication on real video changes; rabbit-hole nudge at a 2-min test
  threshold; options focus-tuning save.

### Epic S — session-state feedback (S1/S2/S3 DONE, 2026-07-08; browser-verify pending)
- **S1 border flash** (`content-guard.js`): on the existing `brick:phase` broadcast, a 6px inset
  border via the U1 helper — **red entering work, green entering break** — fades in/out over a
  configurable window (default 10s). `pointer-events:none` (never blocks clicks);
  `prefers-reduced-motion` = steady fade (U1 handles it). Enforcement overlays (`brick:catch`)
  arriving after a flip replace the border — enforcement wins over decoration.
- **S2 sound cues** (`background.js` + new `offscreen.html/js`; manifest gains `offscreen`):
  `broadcastPhase` → `playCue` → a singleton `chrome.offscreen` document (AUDIO_PLAYBACK reason —
  sidesteps timer-fired autoplay limits) plays **once per transition**, never per-tab.
  **DIVERGENCE (documented):** cues are **synthesized with WebAudio** instead of bundled clips — a
  low two-note "settle in" (330→220Hz) entering work, an ascending twinkle (660/880/1320Hz) entering
  break. No binary assets, no `web_accessible_resources`, tunable in code.
- **S3 options toggles** (`options.html/js`): border on/off (default ON), sound on/off (default
  **OFF** until opted in), border seconds (1–60) — persisted to `chrome.storage.local`, **no service
  round-trip**; content script + worker read them per-event, so changes take effect on the next
  transition. **🔈 test sound** button plays both cues (a user gesture that also primes the audio
  path) and works even while the toggle is off.
- **Verified:** `node --check` on all 8 extension JS files + manifest valid; typecheck + smoke 37/37
  unaffected (Epic S is purely client-side). Preview harness updated with the border+cue combo
  (identical synth code) for an out-of-extension eyeball/listen.
- 🖐 Browser gate: 1-min work/break flip → red/green border ~10s, clicks pass through; one cue per
  flip with several tabs open; toggles persist and take effect; reduced-motion steady fade.

### Epic F — focus-time integrity (F1/F2 DONE, 2026-07-08; browser-verify pending)
- **F1 pause the work clock** (`background.js` + `content-guard.js`): entering grace clears the
  phase alarm and records `graceStartedAt`; on exit (chip tap / modal re-prompt / on-task recheck /
  overlay removal) `phaseEndsAt += pausedMs` and the alarm re-arms — a block always delivers its
  full budgeted work minutes. Badge shows frozen minutes + `⏸` during a pause. **Per-block cap**
  (`brickFeedback.maxGraceMin`, default 5, options field): past it `graceStart` returns
  `capped:true` and the page **hard-blocks**. `reconcile()` settles an in-flight grace first
  (credits the pause) so worker restarts never advance through a frozen boundary; grace ledger
  (`graceCount`/`graceUsedMs`) resets on each fresh work block (`nextPhaseState`).
- **F2 escalating opacity** (`content-guard.js` via U1): vignette fill = `0.22 + 0.12·(count−1)`,
  capped at 0.6 (never a black-out); resets next work block. The countdown **chip is now clickable**
  ("tap for back to work →" — overlay.js gains `onChipClick`), so the return control is reachable
  at every level; reduced-motion handled by the U1 helper.
- **Verified headlessly:** a **14-check unit test drives the real `background.js` in a vm** (stubbed
  chrome, controllable clock): pause clears the alarm, 90s+60s detours extend `phaseEndsAt` by
  exactly 150s, count escalates 1→2→3, the 4th stint past the 5-min cap is refused `capped:true`,
  work→break keeps the ledger while break→work resets it, and reconcile settles an in-flight grace
  without advancing the phase. All extension JS `node --check` clean; smoke 37/37 unaffected.
- 🖐 Browser gate: 3-min work block + two grace detours → full 3 min of actual work (badge shows ⏸
  during grace); 3× "one more minute" in one block → progressively deeper tint, next block light;
  cap (set to 1 min) → hard block; chip tap returns at every level.

### Epic H — in-app help agent (H1–H4 DONE, 2026-07-08). **The early wave is complete.**
- **H1 corpus** (`help/*.md`, 6 docs / 30+ chunks by `##` section): getting-started, blocking-and-
  tiers, gatekeeper (ask/clarify/learned/precedence/honesty/per-page/rabbit-hole), sessions-and-
  feedback (pomodoro/border/sound/grace/cap), model-and-provider, service-and-troubleshooting.
  **Deliberately covers only what exists** (per the no-invented-config AC) — plan/template docs get
  added when Epics A/T land.
- **H2 `/help` route** (`src/help.ts` + `server.ts`): corpus loader + light keyword retrieval
  (heading-boosted term overlap, top-4) → grounded chat call on the **provider seam's new `chat()`
  method** (both providers; no forced tool). System prompt: answer ONLY from excerpts; unknown →
  honest don't-know + doc pointer. Returns `{answer, sources, model}`; short sanitized history
  supported. Key-free → clean 503.
- **H4 situated tools** (shipped with v1): `get_config` / `get_session` / `get_learned_decisions` —
  read-only, `tool_choice` auto, executed by an internal ≤4-round loop inside each provider.
- **H3 panel**: options page **"Ask about BRICK"** chat box (log + sources line + short history)
  via a background `help` route.
- **Smoke hermeticity fix:** the earlier `.env` copy meant spawned smoke servers inherited real
  keys (tier-2 checks were silently hitting the model). Smoke now blanks both keys → genuinely
  key-free again. **Smoke 46/46** (adds corpus-load + 7 question→doc retrieval mappings + key-free
  /help 503).
- **Verified live** (OpenRouter): 3 how-to questions → correct, sourced answers (right doc §
  sections); out-of-scope "sync to Google Calendar" → honest not-in-the-docs + local-log pointer;
  **H4**: "what am I focused on?" answered with the exact live focus task + phase, "which sites are
  blocked / what's learned?" answered from live tiers + learned store — and session/decisions state
  confirmed unmutated afterwards.
- 🖐 Browser: ask a few questions in the options panel (needs the service running).
- H5 (shared corpus into Ledger's focus agent) = Ledger-repo work, deferred with Epic D.

### Next up
- **Early wave done: U ✓ R ✓ 0 ✓ S ✓ F ✓ H ✓.** Next: the plan layer — Epic A (plan queue), then
  (T, B) → C → D per `WORKLOAD_TICKETS.md`.

---

## Plan layer — Epic A (plan queue, no signals) — DONE 2026-07-08
Branch `workload-plan-layer` (off master post-merge of PR #1).

- **A1 types** (`types.ts`): `WorkloadPlan`, `WorkBlock` (reuses `FocusTask` — the keystone),
  `Step`, `StopCondition` union + `GitPredicate` (structural only; evaluators = Epic B),
  `RepeatSpec`, `SwapMode` (field stored; behavior = Epic B).
- **A2 store** (`src/plan-store.ts`): `PlanStore {load/save/advance/clear}` +
  `LocalPlanStore` (`.data/plan.json`, invalid → null) + **pure `advancePlan`** — finish block,
  record `actualMinutes`, honour `repeat.requeue` (clones `id~N`, `maxPerDay` counts all copies,
  steps/conditions reset on the clone), activate next pending or clear `activeBlockId`.
- **A3 runtime** (`src/plan-runtime.ts`): the active block **delegates to the existing
  `FocusSession`** (advance = end + start anchored to the next block's focus — adjudicator/tiers/
  learned decisions untouched); advisory budget readout (elapsed/remaining/overBudget) on
  `planView()`; monotonic `stateVersion`; `toggleStep`, `completeBlock` (manual-condition
  fallback), `editPlan` (reorder pending tail / drop / extend budget / insert), `endPlan` (skips
  the rest), `restorePlan()` re-hydrates on boot, `usePlanStore()` = the Epic-D seam.
- **A4 routes** (`server.ts`): `GET /plan`; `POST /plan/start` (blocks by `task` or `projectId`),
  `/plan/block/advance`, `/plan/block/step`, `/plan/block/complete`, `/plan/reorder`, `/plan/end`.
  The focus-hijack safety property holds: during a plan the session focus (= active block) wins
  over any per-call `task`.
- **A5 extension**: background **adopts** the service's plan-anchored session for local enforcement
  (alarms/DNR/badge — never starts a second one); plan-aware badge (budget minutes left; title
  `2/3 · <focus> · Nm left`); popup gains a day-plan builder (`task | minutes` per line), plan
  strip, budget readout, clickable step checklist, queue with glyphs (✓▶○✗ ↻), `advance now` /
  `end plan`.
- **Corpus**: `help/day-plans.md` added (the promised when-A-lands doc).
- **Verified:** typecheck + node --check clean; **smoke 62/62** (16 new: start/anchor/budget,
  hijack-safety, step persist + stateVersion, advance ×N with actualMinutes, repeat requeue +
  maxPerDay cap, reorder keeps settled blocks, both end paths, single-session regression). Live:
  **plan survives a service restart** (`restorePlan`), `plan.json` valid.
- 🖐 Browser gate (Phase A): 3×1-min plan from the popup — badge `1/3`→`2/3`, step toggle persists
  across popup reopen, advance/end, repeat block reappears once.

## Plan layer — Epic T (workflow templates) — DONE 2026-07-08
- **T1 types + store**: `WorkflowTemplate`/`Slot`/`FocusRef`/`TemplateBlock` in `types.ts`
  (**documented divergence:** template `steps` are labels, not `Step[]` — templates never carry
  done-state); `src/template-store.ts` with `TemplateStore` seam + `LocalTemplateStore`
  (`.data/templates.json`, invalid→empty, cap 100).
- **T2 expansion**: pure `expandTemplate` — slot binding (explicit binding > slot
  `defaultProjectId` > clear throw), pattern `repeat: N` exact, `"until-end-of-day"` adds whole
  patterns while their budget fits before local midnight (≥1 always; requires budgets; 48-block
  cap). `POST /plan/from-template {templateId, bindings}` resolves each bound `focusRef` (explicit
  task or Ledger project) and launches via the Epic-A `startPlan`.
- **T3 CRUD + save-current**: `GET/POST /templates` (full body or `fromCurrent:{name,
  parameterize}`), `DELETE /templates/:id` (first parameterized route; CORS now allows DELETE).
  Pure `liftPlanToTemplate` lifts distinct projects into slots A/B/… when parameterizing, keeps
  explicit tasks pre-bound, drops requeued `~N` clones (the repeat spec regenerates them).
- **T4 UI**: popup picker gains a **saved template** row — per-slot binding (project select with
  free-text task fallback, `defaultProjectId` preselected) → start; plan pane gains **☆ save plan
  as template** (name prompt + parameterize confirm). Options page lists/deletes templates.
- **Corpus**: templates + patterns sections added to `help/day-plans.md`.
- **Verified:** typecheck + node --check clean; **smoke 77/77** (15 new: until-end-of-day at a
  fixed 09:00 → exactly 3 patterns, alternation with bindings, unbound-slot throw, default-slot
  fill, numeric repeat, lift-parameterize/keep-tasks/drop-clones, CRUD round-trip, from-template
  A,B,A,B launch + session anchor, save-current → zero-slot relaunch **parity**, unbound-launch
  clear error, DELETE).
- 🖐 Browser gate (Phase T): save "alternating deep work" (A/B), relaunch binding two projects →
  plan alternates; save a hand-built plan → relaunch parity; delete from options removes it from
  the popup picker.

## Plan layer — Epic B (watchers, swap policy, advance mode) — DONE 2026-07-08
- **B1 watchers** (`src/watchers.ts`): `Evaluator {arm/poll}` per stop-condition on the ACTIVE
  block. `git` (head-advanced vs a baseline SHA / merge-commit since arm / message-match since
  arm), `ledger` (nextAction diff via `fetchProjects` — advancing the project in Ledger IS the
  signal), `command` (**gated on `BRICK_ALLOW_COMMAND_CONDITIONS`**, 15s timeout), `manual`
  (no poller). All fail-open (error/broken-repo → never fires; no baseline → refuses to guess) and
  monotonic (met stays met). Interval loop in `plan-runtime` (`BRICK_WATCH_INTERVAL_MS` default
  30s, unref'd), met flags persisted into the plan on change.
- **B2 swap policy**: pure `decideSwap` (`condition|time|first|both` per §12) + `deriveSwapMode`
  (both present → `first`) + `conditionsSatisfied` (Appendix A: stepsGate && any/all policy;
  neither present → never).
- **B3 advance mode + undo**: `BrickSettings` += `advanceMode` (default auto) + `undoWindowSec`
  (default 30, clamped 5–600); per-block `advanceMode` override; blocks gain `ready`. Condition-
  driven fire → **auto**: snapshot → advance → undo window (`POST /plan/undo-advance` restores,
  re-anchors the session, marks the block ready and **suppresses re-fire** — no undo→advance loop);
  **manual**: `ready:true`, queue waits. **Time-driven fire → always the nudge path** (`ready`,
  never a silent flip — §12; Epic C escalates it). `/plan/start` accepts `stopConditions` (validated
  shapes) + per-block `advanceMode`. One swap decision per block instance (fired-set dedup).
- **B4 UI**: options gains **Plan advance mode** (auto/manual radios + undo-seconds, disabled when
  manual); popup: "advance now → · ready" amber glow + **↩ undo switch** during the window
  (Epic C polishes visuals).
- **B5 verification — smoke 106/106** (29 new, all key-free): §12 truth table (4×4), derive
  defaults, conditionsSatisfied gates; git evaluator on a real scratch repo (baseline → commit →
  met → monotonic; message-match; broken repo never fires), command gating (off by default, exit
  codes, expectExit), **fake `LEDGER_BIN`** fixture (baseline/change/revert-stays-met); live
  integration at 150ms ticks: auto-advance + undo + **no re-fire after undo**, manual ready + tap,
  time → ready-not-flip, ledger next-action change auto-advances, settings round-trip.
- 🖐 Browser gate (Phase B): real repo + `swapMode:first` block — push a commit → auto-advance with
  undo; manual mode → advance-now glows; real `LEDGER_BIN` next-action change completes a block
  (the one check the fake can't cover).
- NOTE: real Ledger repos live at `~/Projects/ledger_root/{ledger,ledger-cli,ledger-mcp}` — the
  handoff's `../ledger/...` sibling paths are stale; matters for Epic D.

## Plan layer — Epic C (escalating notifications) — DONE 2026-07-08
- **C1 escalation clock** (`plan-runtime.ts`): `escalationFor(elapsed, budget)` →
  `none | t-minus | t-0 | grace`, thresholds tunable via `BRICK_TMINUS_MIN` / `BRICK_GRACE_MIN`
  (default 5 min each); exposed as `planView.active.escalation`; the watcher tick bumps
  `stateVersion` on level transitions so clients can diff one number.
- **C2 NotificationDispatcher** (`background.js`): 30s ticks during a plan; each tick derives
  events — level transitions, auto-switch (activeBlockId changed with an undo window), manual
  `ready` — and **dedups by a persisted `(plan, block, event)` key in `chrome.storage.local`**, so
  each fires once even across service-worker restarts.
- **C3 OS notifications**: `notifications` permission; toasts for T-0, grace re-nudge, auto-switch
  (with "undo available"), and ready-to-advance. T-minus stays quiet (badge/popup only, per §6).
- **C4 in-page switch card** (`content-guard.js` via the U1 overlay): `brick:switch` → bottom-right
  non-blocking card ("Time's up on A — next: B?") with **Advance / Stay** (or **↩ Undo** after an
  auto-switch); buttons hit the background's plan routes. Sent to the active tab only.
- **C5 visuals**: badge colour tracks the ladder (amber T-minus → orange T-0 → deep red grace);
  popup escalation banner ("budget ends in Xm · next: …" / "time's up" / "over by Xm — advance?").
  The B4 ready-glow + undo button complete the Appendix-B picture.
- **Verified:** smoke **108/108** — the C1 check walks a 0.6s-budget block through
  `none→t-minus→t-0→grace` in order with version bumps (fractional thresholds via env). Extension
  JS + manifest all check clean (dispatcher/card/banner are browser-🖐).
- 🖐 Browser gate (Phase C): 1–2-min budget block → T-minus/T-0/grace each fire once across
  popup + in-page + OS (worker console shows one dispatch per level); auto mode's undo works from
  the page card; OS toast arrives with the browser backgrounded.

**The plan layer is now A ✓ T ✓ B ✓ C ✓ — only Epic D (Ledger-native store) remains, which needs
Corina's machine (ledger_root repos + Firestore creds).**

## Code review + fix pass (2026-07-08)

A thorough `/code-review high` over the entire day's diff (`fbacb4e...HEAD`, ~5.6k lines: the full
early wave + plan layer) — 8 finder angles → 36 candidates → 16 adversarially verified → **15
confirmed real bugs**. All fixed on this branch before merge. Two root causes explained most of the
top findings:

**Root cause 1 — service⇄extension sync only worked one direction.** Local enforcement (session
anchor, Tier-1 DNR rules, alarms, badge) only re-synced when the EXTENSION initiated a plan change
(its own message handlers called `adoptServiceSession`/`teardownLocal`). A SERVICE-initiated change
— the watcher loop auto-advancing a block, an undo firing after a restart, the plan ending on its
own — left the extension (and, separately, the service's own in-memory session after a restart)
stale, with `/adjudicate` fail-open forever. **Fix:** `dispatchNotifications()` (renamed to run every
tick regardless of who caused a change) now compares `planId`/`activeBlockId` against what it last
knew and re-adopts/tears down on ANY drift — server- or extension-initiated, covering restarts too.
`restorePlan()` now calls `anchorSession()` (it only re-armed watchers before). Extension handlers
call a new `markPlanSynced()` right after their own adopt/teardown so the next tick's check is a
no-op for the common case (no redundant re-adopt).

**Root cause 2 — swap-fire dedup was a volatile Set, not persisted state.** The old `firedBlocks`
Set (in-memory only) both (a) let a mere time-nudge permanently disarm a later condition fire under
`swapMode:"first"`, and (b) evaporated on restart, so an undone block's still-met condition would
auto-re-advance it minutes after the user said "not done." **Fix:** replaced with two independent,
**persisted** per-block fields — `conditionFiredAt` / `timeFiredAt` — so a time nudge never blocks a
later condition fire, and the undo-hold (stamped before the pre-advance snapshot is taken) survives
a service restart. Repeat-block clones reset both fields fresh.

**Other confirmed fixes, this branch:**
- **Provider/model mismatch (V5):** a cross-provider model id (Anthropic-form on OpenRouter or vice
  versa) 404s every call and, since adjudication fails open, silently disabled ALL Tier-2 blocking
  forever with only a stderr line. `resolveModelForProvider()` now guards it — falls back to the
  provider's own default with a loud warning instead of 404ing indefinitely.
- **Provider-error observability (V14):** a fail-open from a provider outage was wire-identical to a
  genuine model allow (same `stub:false`, no UI signal) — an outage looked like the tool working.
  Added `providerError` on the result (surfaced on `/health.lastProviderError`); content-guard now
  treats a `providerError` allow like a stub (skips the redundant phase-2 deepen call too).
- **enforceTab missing the per-page unit (V6) / youtu.be path ids (V16b):** page-scope learned
  decisions were invisible to the tab-activation/open-tab-sweep path, and youtu.be short links
  (id in the path, not `?v=`) never got a unit at all. Fixed at the root: `derivePageUnit()` in
  `decisions-store.ts` derives the unit **server-side** from the URL for both `/adjudicate` and
  `/decisions/learn` whenever the caller omits one — one mechanism instead of asking every caller
  to compute it correctly (content-guard's `learn()` now just says "this domain is page-scoped",
  letting the server resolve the exact unit).
- **Switch notification silently swallowed (V8):** was gated on the undo window still being open
  by the time the next tick ran — a 30s window racing a 30-60s tick meant it often lost. Now fires
  on any real block change within the same plan; the undo action is offered only when available.
  (This also fixed the `TICK_ALARM` cadence flip-flopping — one constant `TICK_MINUTES = 0.5` always,
  removing the 1min/0.5min split that `reconcile()` silently reintroduced mid-plan.)
- **`advancePlan` accepted any blockId (V9):** advancing a *pending* block while another was active
  stranded the active one forever (two "active" blocks). `advanceBlock` now rejects a non-active id.
- **Budget-edit NaN/1-minute coercion (V10):** a missing or non-numeric `budgetMinutes` on
  `/plan/reorder`'s budget edit silently became `1` or `NaN` (which read as instant "grace"
  escalation). Now rejected with a clear error.
- **Stop-condition plumbing gaps (V11):** `TemplateBlock` had no `stopConditions`/`advanceMode`/
  `completionPolicy`, so save-as-template → relaunch silently stripped every watcher; `editPlan`'s
  insert branch dropped the same fields even though its own input type declared them;
  `completionPolicy:"all"` was unreachable through `/plan/start`. Fixed via one shared `mintBlock()`
  constructor used by `startPlan` and `editPlan.insert`, template fields carried through
  `liftPlanToTemplate`/`expandTemplate` (with a proper deep-clone per repeated instance — the
  pattern-repeat loop was sharing one `stopConditions` array reference across all copies), and the
  `/plan/start`+`/plan/reorder` body parsers now accept `completionPolicy`.
- **Rabbit-hole 2× accrual (V7):** counted "1 minute per tick" but the tick period isn't always 1
  minute (0.5 during plans) — now accrues by actual elapsed wall-clock time since the last
  *consecutive* matching tick (resets on any gap or domain switch, so it never counts inactive time).
- **Badge lost the break countdown during a plan (V12):** the plan branch always showed budget
  minutes, even during a break. Now shows the real phase countdown on break, budget on work.
- **`stopSession` ordering (V13):** re-ordered to tear down local enforcement (alarms/DNR/badge)
  *before* the service call, matching the pre-plan-layer behavior — a wedged (not down) service can
  no longer hold Tier-1 blocking open indefinitely after the user presses stop.
- **`planStep` cache-invalidation gap (V16a):** the one plan-mutating message handler that didn't
  reset the shared `/plan` cache — fixed for consistency (low real-world impact; the popup already
  force-refreshes on its own).
- Cheap efficiency fixes alongside: one shared `/plan` fetch per tick (was 2-3), `enforceOpenTabs`
  parallelized (was serial per-tab model calls — up to 20+ sequential adjudications on session
  start), `getConfig` routed through the existing 30s cache instead of a fresh round-trip + full
  `decisionCounts` scan on every page navigation.

**Deliberately NOT fixed (documented, not a regression):** undo-revert-of-unrelated-writes (V15) —
the undo window is a whole-plan JSON snapshot, so a `toggleStep`/`editPlan` write landing inside the
same ~5-30s window is reverted along with the advance. A real fix means undo as a targeted inverse
operation (or an event log) rather than a snapshot — bigger than this pass; flagged for whoever
picks up Epic D or a later B/C hardening pass.

**Verification:** `npm run typecheck` + `node --check` (all 8 extension files) clean. **`npm run
smoke` = 133/133** — the pre-existing 108 plus 25 new checks: a real service restart (kill + respawn
against the same data dir) proving session re-anchoring and the hijack guard, the exact
time-then-condition sequence that used to eat the condition fire, an undo-then-restart sequence
proving the hold survives, non-active-block-advance rejection, bad-budget rejection, `all`-policy
enforcement via a real git condition, template/insert field round-trips, a pure unit test for
`resolveModelForProvider`, and the youtu.be/enforceTab unit-derivation fixes exercised live.

