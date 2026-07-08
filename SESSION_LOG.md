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

### Next up
- Epics H (help agent) / F (grace-clock integrity), then A→(T,B)→C→D.

