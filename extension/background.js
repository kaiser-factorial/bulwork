// BRICK MODE — background service worker.
// Owns session state, talks to the local brick service, manages Tier-1 blocking rules
// and the Pomodoro phase alarms. Content scripts and the popup message this worker.

const SERVICE = "http://127.0.0.1:7373";
const DNR_BASE = 1000; // dynamic-rule id offset for brick Tier-1 rules
const DNR_MAX = 200; // reserved id range [DNR_BASE, DNR_BASE+DNR_MAX)
const PHASE_ALARM = "brick-phase";
const TICK_ALARM = "brick-tick"; // refreshes the badge, rabbit-hole accrual, and plan dispatch
// ONE tick period always (review fix): the old 1min-plain/0.5min-plan split meant reconcile() (which
// always re-armed at 1min) silently doubled the escalation-dispatcher's cadence after any restart
// mid-plan. A single constant removes the desync outright instead of patching each re-arm site.
const TICK_MINUTES = 0.5;
const WORK_COLOR = "#c0392b"; // red badge during work
const BREAK_COLOR = "#2e8b57"; // green badge during break

async function api(path, opts = {}) {
  const res = await fetch(SERVICE + path, {
    ...opts,
    // X-Brick-Client is the service's auth gate — a web page can't set it cross-origin.
    headers: { "Content-Type": "application/json", "X-Brick-Client": "extension", ...(opts.headers || {}) },
  });
  if (!res.ok) throw new Error(`service ${path} -> ${res.status}`);
  return res.json();
}

// Durable across browser restarts (chrome.storage.session is cleared on restart).
async function getState() {
  const { brick } = await chrome.storage.local.get("brick");
  return brick ?? { session: null, phase: null, phaseEndsAt: null };
}

async function setState(state) {
  await chrome.storage.local.set({ brick: state });
}

// The constant visual: a colored countdown badge on the toolbar icon.
// Red = work, green = break; the number is minutes left in the current phase.
// `plan` may be pre-fetched by the caller (the tick handler shares one /plan fetch across
// consumers — review fix: this used to be fetched again independently here).
async function updateBadge(st, plan) {
  const s = st ?? (await getState());
  if (!s.session) {
    await chrome.action.setBadgeText({ text: "" });
    await chrome.action.setTitle({ title: "BRICK MODE — no active session" });
    return;
  }
  // During a grace pause (F1) the countdown is frozen: remaining time is measured against the
  // moment grace began, not now — so the badge stops shrinking while the clock is paused.
  const ref = s.graceStartedAt ?? Date.now();
  const minsLeft = Math.max(0, Math.ceil(((s.phaseEndsAt ?? ref) - ref) / 60000));
  const isWork = s.phase === "work";

  // Plan-aware badge (Epic A5): during a plan WORK phase the at-a-glance number is the active
  // block's budget minutes left (advisory); during a plan's BREAK the phase countdown wins (review
  // fix — a plan no longer hides the break timer, which the badge always showed pre-plan).
  const p = plan !== undefined ? plan : await getPlanCached();
  if (isWork && p?.activeBlockId && p.active) {
    const idx = p.blocks.findIndex((b) => b.id === p.activeBlockId) + 1;
    const rem = p.active.remainingMinutes != null ? Math.max(0, Math.ceil(p.active.remainingMinutes)) : minsLeft;
    const focusTask = p.blocks[idx - 1]?.focus.task ?? s.session.focus.task;
    // C5: the badge colour tracks the escalation ladder — amber at T-minus, orange at T-0,
    // deep red in grace overrun.
    const ESC_COLOR = { "t-minus": "#d9a441", "t-0": "#e67e22", grace: "#7a1f14" };
    const color = ESC_COLOR[p.active.escalation] ?? WORK_COLOR;
    await chrome.action.setBadgeText({ text: s.graceStartedAt ? `${rem}⏸` : String(rem) });
    await chrome.action.setBadgeBackgroundColor({ color });
    await chrome.action.setTitle({
      title: `BRICK — ${idx}/${p.blocks.length} · ${focusTask} · ${rem}m left${s.graceStartedAt ? " (paused — grace)" : ""}`,
    });
    return;
  }
  if (!isWork && p?.activeBlockId) {
    // Plan break: show the queue position but the real phase countdown, not the (irrelevant)
    // work-block budget.
    const idx = p.blocks.findIndex((b) => b.id === p.activeBlockId) + 1;
    await chrome.action.setBadgeText({ text: String(minsLeft) });
    await chrome.action.setBadgeBackgroundColor({ color: BREAK_COLOR });
    await chrome.action.setTitle({ title: `BRICK — break · ${minsLeft} min left · next: ${idx}/${p.blocks.length}` });
    return;
  }

  await chrome.action.setBadgeText({ text: s.graceStartedAt ? `${minsLeft}⏸` : String(minsLeft) });
  await chrome.action.setBadgeBackgroundColor({ color: isWork ? WORK_COLOR : BREAK_COLOR });
  await chrome.action.setTitle({
    title: `BRICK — ${isWork ? "work" : "break"}${s.graceStartedAt ? " (paused — grace)" : ""} · ${minsLeft} min left · ${s.session.focus.task}`,
  });
}

// Tier-1 sites are blocked via static redirect rules (no per-request service call).
async function setTier1Rules(enable) {
  // Always clear the whole reserved id range first → an added id can never collide with an
  // existing one (which would make updateDynamicRules throw and roll back all changes).
  const removeRuleIds = Array.from({ length: DNR_MAX }, (_, i) => DNR_BASE + i);
  let addRules = [];
  if (enable) {
    try {
      const cfg = await api("/config");
      const blockUrl = chrome.runtime.getURL("block.html");
      addRules = (cfg.tiers?.tier1 ?? []).slice(0, DNR_MAX).map((domain, i) => ({
        id: DNR_BASE + i,
        priority: 1,
        action: {
          type: "redirect",
          redirect: { url: `${blockUrl}?tier=tier1&decision=block&reason=${encodeURIComponent("Tier-1 always-blocked site.")}&domain=${encodeURIComponent(domain)}` },
        },
        condition: { urlFilter: `||${domain}`, resourceTypes: ["main_frame"] },
      }));
    } catch (e) {
      console.warn("brick: could not load tiers; leaving Tier-1 rules cleared", e);
    }
  }
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
  } catch (e) {
    console.warn("brick: updateDynamicRules failed", e);
  }
}

// Pure: compute the next phase + its end time, advancing from the prior end (so missed phases
// catch up correctly when reconciling after the worker/browser was asleep). Each fresh work block
// starts with a clean grace ledger (Epic F: escalation + the grace budget reset per block).
function nextPhaseState(st) {
  const toBreak = st.phase === "work";
  const minutes = toBreak ? st.session.breakMinutes ?? 5 : st.session.workMinutes ?? 25;
  const base = st.phaseEndsAt ?? Date.now();
  return {
    ...st,
    phase: toBreak ? "break" : "work",
    phaseEndsAt: base + minutes * 60000,
    graceStartedAt: null,
    graceCount: toBreak ? st.graceCount : 0,
    graceUsedMs: toBreak ? st.graceUsedMs : 0,
  };
}

// ---------- focus-time integrity (Epic F1) ----------
// Minutes spent on the grace overlay shouldn't be eaten from the work block: while grace is active
// we clear the phase alarm (pause the clock), and on exit we push phaseEndsAt forward by the paused
// duration and re-arm. A per-block cap prevents "you keep your minutes" becoming "you never work".
async function graceStart() {
  const st = await getState();
  if (!st.session || st.phase !== "work") return { ok: true, graceCount: 0 }; // nothing to pause
  const fb = await getFeedback();
  const capMs = Math.max(1, Number(fb.maxGraceMin) || 5) * 60000;
  if ((st.graceUsedMs || 0) >= capMs) {
    // Budget spent — past the cap the escalation has maxed out and the page hard-blocks (F1+F2).
    return { ok: false, capped: true, graceCount: st.graceCount || 0 };
  }
  if (!st.graceStartedAt) {
    st.graceStartedAt = Date.now();
    st.graceCount = (st.graceCount || 0) + 1;
    await chrome.alarms.clear(PHASE_ALARM); // pause: the block can't end while you're in grace
    await setState(st);
    await updateBadge(st);
  }
  return { ok: true, graceCount: st.graceCount, capped: false };
}

async function graceEnd() {
  const st = await getState();
  if (!st.session || !st.graceStartedAt) return { ok: true };
  const paused = Date.now() - st.graceStartedAt;
  st.graceUsedMs = (st.graceUsedMs || 0) + paused;
  st.graceStartedAt = null;
  if (st.phase === "work" && st.phaseEndsAt) {
    st.phaseEndsAt += paused; // resume: the block still delivers its full budgeted work minutes
    await chrome.alarms.create(PHASE_ALARM, { when: st.phaseEndsAt });
  }
  await setState(st);
  await updateBadge(st);
  return { ok: true, pausedMs: paused };
}

async function startSession(opts) {
  const { session } = await api("/session/start", { method: "POST", body: JSON.stringify(opts) });
  const phaseEndsAt = Date.now() + (session.workMinutes ?? 25) * 60000;
  const state = { session, phase: "work", phaseEndsAt };
  await setState(state);
  await resetRabbitHole(); // fresh per-session foreground-time counters (Epic 0.8)
  await setTier1Rules(true);
  await chrome.alarms.create(PHASE_ALARM, { when: phaseEndsAt });
  await chrome.alarms.create(TICK_ALARM, { periodInMinutes: TICK_MINUTES });
  await updateBadge(state);
  await broadcastPhase("work");
  await enforceOpenTabs(); // block off-task tabs already open when the session starts
  return state;
}

// Tear down the local enforcement state (alarms, rules, badge) without touching the service.
async function teardownLocal() {
  await chrome.alarms.clear(PHASE_ALARM);
  await chrome.alarms.clear(TICK_ALARM);
  await setTier1Rules(false);
  await setState({ session: null, phase: null, phaseEndsAt: null });
  await updateBadge();
  await broadcastPhase(null);
}

async function stopSession() {
  // Review fix: tear down local enforcement FIRST (matches the pre-plan-layer ordering). The old
  // order awaited the service call first, so a wedged (not down — accepted but never answered)
  // service left Tier-1 rules and the badge running indefinitely after the user pressed stop.
  await teardownLocal();
  try {
    await api("/session/stop", { method: "POST", body: "{}" });
  } catch {
    /* service may be down/wedged; local enforcement is already clear regardless */
  }
}

// ---------- plan layer (Epic A5) ----------
// The service's PlanRuntime anchors its own FocusSession to the active block; the worker ADOPTS
// that session for local enforcement (alarms, DNR rules, badge) instead of starting a second one.
let planCache = { at: 0, plan: null };
async function getPlanCached(force = false) {
  if (!force && Date.now() - planCache.at < 20000) return planCache.plan;
  try {
    const { plan } = await api("/plan");
    planCache = { at: Date.now(), plan };
  } catch {
    planCache = { at: Date.now(), plan: null };
  }
  return planCache.plan;
}

// ---------- NotificationDispatcher (Epic C2/C3): three surfaces, once per event ----------
// On each tick during a plan: fetch /plan, derive events (escalation level changes, auto-switches,
// ready), dedup by a persisted (plan, block, event) key so a nudge fires ONCE per level — even
// across service-worker restarts — then fan out to OS notification + in-page card + badge/popup.
async function getDispatchState() {
  const { brickDispatch } = await chrome.storage.local.get("brickDispatch");
  return brickDispatch ?? { planId: null, lastActiveBlockId: null, notified: {} };
}

function osNotify(id, title, message) {
  try {
    chrome.notifications.create(id, {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title,
      message,
      priority: 1,
    });
  } catch {
    /* notifications unavailable — the other surfaces still fire */
  }
}

// In-page card on the ACTIVE tab (Epic C4) — content-guard renders it via the shared overlay.
async function pageNotify(payload) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id && tab.url?.startsWith("http")) {
      await chrome.tabs.sendMessage(tab.id, { type: "brick:switch", ...payload });
    }
  } catch {
    /* no content script on the active tab — OS + popup still cover it */
  }
}

function nextLabel(plan) {
  const idx = plan.blocks.findIndex((b) => b.id === plan.activeBlockId);
  const next = plan.blocks.slice(idx + 1).find((b) => b.status === "pending");
  return next ? next.focus.task : "(end of plan)";
}

// Record the plan/active-block a message handler just adopted itself, so the next tick's sync
// check (below) sees no drift and skips a redundant re-adopt (review fix companion — this is what
// makes the tick-based safety net cheap for the common extension-initiated case).
async function markPlanSynced(plan) {
  const st = await getDispatchState();
  st.planId = plan?.id ?? null;
  st.lastActiveBlockId = plan?.activeBlockId ?? null;
  await chrome.storage.local.set({ brickDispatch: st });
}

// `plan` may be pre-fetched by the tick handler (shared with updateBadge — review fix, one /plan
// fetch per tick instead of two-to-three).
async function dispatchNotifications(plan) {
  const p = plan !== undefined ? plan : await getPlanCached(true);
  const activeId = p?.activeBlockId ?? null;
  const planId = p?.id ?? null;

  const st = await getDispatchState();
  const planChanged = st.planId !== planId;
  const blockChanged = st.lastActiveBlockId !== activeId;

  if (planChanged || blockChanged) {
    // Keep local enforcement (session anchor, alarms, DNR rules, badge) in sync with the
    // service's plan state — review fix (root cause 1): this used to only run from the
    // extension's OWN plan message handlers, so a SERVER-initiated change (watcher auto-advance,
    // undo firing from a restart, the plan ending on its own) never got picked up locally. Running
    // this every tick, keyed off the same planId/activeBlockId this function already tracks for
    // notification dedup, covers every path with one mechanism. adoptServiceSession/teardownLocal
    // are idempotent enough that a redundant call right after a handler's own (via
    // markPlanSynced) is harmless — it simply won't happen, since markPlanSynced already caught
    // the drift up.
    if (activeId) await adoptServiceSession();
    else await teardownLocal();
  }

  if (!p || !activeId) {
    if (st.planId || st.lastActiveBlockId) {
      await chrome.storage.local.set({ brickDispatch: { planId: null, lastActiveBlockId: null, notified: {} } });
    }
    return;
  }

  if (planChanged) {
    st.planId = planId;
    st.notified = {};
  }
  const fire = (key) => {
    if (st.notified[key]) return false;
    st.notified[key] = true;
    return true;
  };
  const active = p.blocks.find((b) => b.id === activeId);
  const label = active?.focus.task ?? "current block";
  const next = nextLabel(p);

  // A mid-plan swap to a different block within the SAME plan → announce it. Review fix (V8): no
  // longer gated on `plan.undo` still being present — the undo window (default 30s) and the tick
  // period can race, and gating on it meant the switch was silently never announced when the
  // window happened to lapse first. The notification now always fires on a real swap; the undo
  // action is offered only when actually available.
  if (!planChanged && blockChanged && fire(`${planId}:${activeId}:switched`)) {
    const undoNote = p.undo ? " Undo is available for a few seconds." : "";
    osNotify(`brick-switch-${activeId}`, "BRICK — switched blocks", `Now: ${label}.${undoNote}`);
    await pageNotify({
      title: "Switched blocks",
      body: `Now: ${label}`,
      actions: p.undo ? ["undo", "stay"] : ["stay"],
    });
  }
  st.lastActiveBlockId = activeId;

  // Escalation ladder (§6): quiet heads-up → nudge → insistent re-nudge. Once per level.
  const level = p.active?.escalation;
  if (level === "t-minus" && fire(`${planId}:${activeId}:t-minus`)) {
    // Quiet: badge tint + popup banner only — no OS toast, no in-page card.
    await updateBadge(undefined, p);
  } else if (level === "t-0" && fire(`${planId}:${activeId}:t-0`)) {
    osNotify(`brick-t0-${activeId}`, "BRICK — time's up", `Time's up on: ${label}. Next: ${next}`);
    await pageNotify({ title: "Time's up", body: `${label} — next: ${next}`, actions: ["advance", "stay"] });
    await updateBadge(undefined, p);
  } else if (level === "grace" && fire(`${planId}:${activeId}:grace`)) {
    osNotify(`brick-grace-${activeId}`, "BRICK — still on the old block", `Over budget on: ${label}. Advance to: ${next}?`);
    await pageNotify({ title: "Over budget", body: `Still on ${label} — advance to ${next}?`, actions: ["advance", "stay"] });
    await updateBadge(undefined, p);
  }

  // Manual-mode "ready to advance" (a met condition is waiting for your tap).
  if (active?.ready && fire(`${planId}:${activeId}:ready`)) {
    osNotify(`brick-ready-${activeId}`, "BRICK — ready to advance", `${label} is ready. Tap "advance now" when you are.`);
  }

  await chrome.storage.local.set({ brickDispatch: st });
}

async function adoptServiceSession() {
  const { session } = await api("/session");
  if (!session) {
    await teardownLocal();
    return null;
  }
  const phaseEndsAt = Date.now() + (session.workMinutes ?? 25) * 60000;
  const state = { session, phase: "work", phaseEndsAt };
  await setState(state);
  await resetRabbitHole();
  await setTier1Rules(true);
  await chrome.alarms.create(PHASE_ALARM, { when: phaseEndsAt });
  await chrome.alarms.create(TICK_ALARM, { periodInMinutes: TICK_MINUTES });
  await updateBadge(state);
  await broadcastPhase("work");
  await enforceOpenTabs();
  return state;
}

async function onPhaseAlarm() {
  let st = await getState();
  if (!st.session) return;
  st = nextPhaseState(st);
  await setState(st);
  await setTier1Rules(st.phase === "work"); // rules on during work, off during break
  try {
    await api("/session/phase", { method: "POST", body: JSON.stringify({ phase: st.phase }) });
  } catch {
    /* best effort */
  }
  await chrome.alarms.create(PHASE_ALARM, { when: st.phaseEndsAt });
  await updateBadge(st);
  await broadcastPhase(st.phase);
  if (st.phase === "work") await enforceOpenTabs(); // re-engage: sweep tabs opened during the break
}

// On worker/browser startup, catch up any phases missed while down and re-arm the alarm + rules.
async function reconcile() {
  let st = await getState();
  if (!st.session) return;
  // Settle an in-flight grace pause first (F1): credit the paused time to phaseEndsAt so the normal
  // catch-up below doesn't advance through a frozen boundary as if the clock had been running.
  if (st.graceStartedAt) {
    const paused = Date.now() - st.graceStartedAt;
    st.graceUsedMs = (st.graceUsedMs || 0) + paused;
    if (st.phaseEndsAt) st.phaseEndsAt += paused;
    st.graceStartedAt = null;
    await setState(st);
  }
  let changed = false;
  while (st.phaseEndsAt && Date.now() >= st.phaseEndsAt) {
    st = nextPhaseState(st);
    changed = true;
  }
  if (changed) {
    await setState(st);
    try {
      await api("/session/phase", { method: "POST", body: JSON.stringify({ phase: st.phase }) });
    } catch {
      /* best effort */
    }
  }
  await setTier1Rules(st.phase === "work");
  if (st.phaseEndsAt) await chrome.alarms.create(PHASE_ALARM, { when: st.phaseEndsAt });
  await chrome.alarms.create(TICK_ALARM, { periodInMinutes: TICK_MINUTES });
  await updateBadge(st);
  if (changed) await broadcastPhase(st.phase);
  if (st.phase === "work") await enforceOpenTabs();
}

function hostOf(u) {
  try {
    return new URL(u).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

// Tier-2 adjudication for a navigation (called by content-guard; title is the Phase-2 deeper signal,
// unit is a per-page key like a YouTube video id for high-variance domains — Epic 0.7).
async function guard(url, title, unit) {
  const st = await getState();
  if (!st.session || st.phase !== "work") {
    return { allow: true, tier: "tier3", reason: "no active work session" };
  }
  try {
    const r = await api("/adjudicate", { method: "POST", body: JSON.stringify({ url, title, unit }) });
    return {
      allow: r.decision !== "block",
      decision: r.decision,
      reason: r.reason,
      tier: r.tier,
      stub: r.stub,
      // Review fix: a fail-open from a provider outage is NOT a judged verdict — content-guard
      // treats it like a stub (skip the phase-2 re-check; don't spend a second doomed call).
      providerError: r.providerError,
    };
  } catch {
    // Fail open — never block real work because the service is unreachable.
    return { allow: true, tier: "error", reason: "brick service unreachable (fail-open)" };
  }
}

// Cache /config briefly so the per-minute rabbit-hole tick doesn't hammer the service.
let cfgCache = null;
let cfgCacheAt = 0;
async function getConfigCached() {
  if (cfgCache && Date.now() - cfgCacheAt < 30000) return cfgCache;
  cfgCache = await api("/config");
  cfgCacheAt = Date.now();
  return cfgCache;
}

// Rabbit-hole time nudge (Epic 0.8): accrue foreground minutes per flagged domain *only while its
// tab is active during work*, and fire a check-in each time a threshold multiple is crossed.
async function accrueRabbitHole() {
  const store = (await chrome.storage.local.get("brickRabbit")).brickRabbit || {
    mins: {},
    nudged: {},
    lastAt: 0,
    lastDomain: null,
  };
  // Not actively accruing this tick — clear the "last tick" anchor so a future match starts
  // counting from zero elapsed instead of folding in the whole inactive gap (review fix: below,
  // elapsed time is measured since this anchor, so it must never span a period we weren't watching).
  const bail = async () => {
    if (store.lastAt) {
      store.lastAt = 0;
      store.lastDomain = null;
      await chrome.storage.local.set({ brickRabbit: store });
    }
  };

  const st = await getState();
  if (!st.session || st.phase !== "work") return bail();
  let cfg;
  try {
    cfg = await getConfigCached();
  } catch {
    return bail();
  }
  // Default flagged domain is YouTube (design §14.8); an explicit empty list disables the nudge.
  const domains = cfg.settings?.rabbitHoleDomains ?? ["youtube.com"];
  const threshold = cfg.settings?.rabbitHoleMinutes || 45;
  if (!domains.length) return bail();
  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch {
    return bail();
  }
  if (!tab || !tab.url || !tab.url.startsWith("http")) return bail();
  const host = hostOf(tab.url);
  const flagged = domains.find((d) => host === d || host.endsWith("." + d));
  if (!flagged) return bail();

  // Accrue by ACTUAL elapsed time since the last CONSECUTIVE matching tick, not a fixed "1 minute
  // per tick" (review fix: the tick period isn't 1 minute during plans, and this stays correct
  // even if the period ever changes again). Only counts when the anchor is from the SAME domain —
  // switching flagged domains, or a gap where accrual bailed, starts this tick's elapsed at zero.
  const now = Date.now();
  const elapsedMin =
    store.lastAt && store.lastDomain === flagged ? Math.max(0, (now - store.lastAt) / 60000) : 0;
  store.lastAt = now;
  store.lastDomain = flagged;
  store.mins[flagged] = (store.mins[flagged] || 0) + elapsedMin;
  const level = Math.floor(store.mins[flagged] / threshold);
  if (level >= 1 && (store.nudged[flagged] || 0) < level) {
    store.nudged[flagged] = level; // dedup: one nudge per threshold crossing
    try {
      await chrome.tabs.sendMessage(tab.id, {
        type: "brick:rabbithole",
        domain: flagged,
        minutes: Math.round(store.mins[flagged]),
      });
    } catch {
      /* no content script in that tab */
    }
  }
  await chrome.storage.local.set({ brickRabbit: store });
}

async function resetRabbitHole() {
  await chrome.storage.local.set({ brickRabbit: { mins: {}, nudged: {} } });
}

// Re-check a single already-open tab and redirect it to the block page if it's now off-task.
// (DNR + content-guard only fire on navigation, so a tab open from before the work phase, or one
// you switch back to, is never otherwise re-evaluated.) Uses tab.title for the deeper signal.
function redirectTab(tabId, url, res) {
  const params = new URLSearchParams({
    url,
    reason: res.reason ?? "off-task",
    tier: res.tier ?? "tier1",
    decision: "block",
  });
  chrome.tabs
    .update(tabId, { url: chrome.runtime.getURL("block.html") + "?" + params.toString() })
    .catch(() => {});
}

// If a tab is sitting on our block page, the real target is in its ?url= param — the honesty lever
// should learn/act on that, not on block.html.
function realUrl(u) {
  try {
    if (u && u.startsWith(chrome.runtime.getURL("block.html"))) {
      const q = new URL(u).searchParams.get("url");
      if (q) return q;
    }
  } catch {
    /* ignore */
  }
  return u;
}

// Honesty lever (Epic 0.5): the user corrects a verdict for the current tab under the active focus.
// "block" (off-task) → learn a block + soft-block the tab now; "allow" (on-topic) → learn an allow +
// return a blocked tab to the page. Both persist under the focus via the learned store.
async function markPage(tabId, rawUrl, decision) {
  const url = realUrl(rawUrl);
  if (!url || !url.startsWith("http")) return { error: "no page url to mark" };
  const res = await api("/decisions/learn", {
    method: "POST",
    body: JSON.stringify({ url, decision, via: "correction" }),
  });
  if (decision === "block" && tabId != null) {
    try {
      await chrome.tabs.sendMessage(tabId, { type: "brick:catch", reason: "You marked this off-task for this focus." });
    } catch {
      redirectTab(tabId, url, { reason: "Marked off-task", tier: "tier2" });
    }
  } else if (decision === "allow" && tabId != null && rawUrl && rawUrl.startsWith(chrome.runtime.getURL("block.html"))) {
    chrome.tabs.update(tabId, { url }).catch(() => {});
  }
  return res;
}

// soft=true → the work phase began while you were already on this tab (break→work / session start):
// Tier-2 gets the gentle "1 more minute" overlay. soft=false (or Tier-1) → hard block: you actively
// navigated/switched to an off-task page during work, so no grace.
async function enforceTab(tab, soft) {
  if (!tab || !tab.id || !tab.url || !tab.url.startsWith("http")) return;
  if (tab.url.startsWith(chrome.runtime.getURL(""))) return; // don't re-block our own block page
  const res = await guard(tab.url, tab.title);
  if (!res || res.allow !== false) return;
  if (soft && res.tier !== "tier1") {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "brick:catch", reason: res.reason });
    } catch {
      redirectTab(tab.id, tab.url, res); // no content script in that tab → hard fallback
    }
  } else {
    redirectTab(tab.id, tab.url, res);
  }
}

// Sweep every open tab — used when work re-engages or a session starts.
async function enforceOpenTabs() {
  const st = await getState();
  if (!st.session || st.phase !== "work") return;
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch {
    return;
  }
  // Review fix: independent per-tab adjudications ran strictly sequentially — 20 tabs with tier-2
  // pages meant 20 back-to-back model calls (tens of seconds) before session start / work
  // re-engage finished sweeping. They don't depend on each other, so run them concurrently.
  await Promise.all(tabs.map((tab) => enforceTab(tab, true))); // passive sweep → soft (grace)
}

// Session-state feedback settings (Epic S): purely client-side presentation, stored in
// chrome.storage.local (no service round-trip). Sound defaults OFF until opted in.
const FEEDBACK_DEFAULTS = { sound: false, border: true, borderSec: 10, maxGraceMin: 5 };
async function getFeedback() {
  const { brickFeedback } = await chrome.storage.local.get("brickFeedback");
  return { ...FEEDBACK_DEFAULTS, ...(brickFeedback || {}) };
}

// Play a phase cue via the single offscreen document (Epic S2) — timer-fired audio from the worker
// hits autoplay limits, and the offscreen doc (AUDIO_PLAYBACK) sidesteps that. Exactly one play per
// transition: only the offscreen doc makes sound, never the per-tab content scripts.
async function playCue(cue, force = false) {
  if (cue !== "work" && cue !== "break") return;
  if (!force && !(await getFeedback()).sound) return;
  try {
    const has = await chrome.offscreen.hasDocument();
    if (!has) {
      await chrome.offscreen.createDocument({
        url: "offscreen.html",
        reasons: ["AUDIO_PLAYBACK"],
        justification: "Play a short sound cue on Pomodoro work/break transitions.",
      });
    }
  } catch (e) {
    // createDocument races (already exists) land here — safe to proceed; real failures fail silent.
  }
  try {
    await chrome.runtime.sendMessage({ type: "brick:play", cue });
  } catch {
    /* offscreen not ready — cue is best-effort */
  }
}

// Broadcast a phase change to every tab so any in-page UI (the grace-minute overlay) can react.
// The overlay's own 60s timer is independent of the Pomodoro; without this it would keep nagging
// after work→break, or hang around after the user ended the session.
async function broadcastPhase(phase) {
  playCue(phase); // Epic S2 — one sound per transition, from the offscreen doc (no-op if disabled)
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch {
    return;
  }
  for (const tab of tabs) {
    if (!tab.id || !tab.url || !tab.url.startsWith("http")) continue;
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "brick:phase", phase });
    } catch {
      /* no content script in this tab — fine */
    }
  }
}

// One shared /plan fetch per tick (review fix): updateBadge and dispatchNotifications each used to
// fetch it independently (up to 2-3 requests/tick during a plan) for the identical snapshot.
async function onTick() {
  const plan = await getPlanCached(true);
  await updateBadge(undefined, plan);
  await accrueRabbitHole(); // Epic 0.8 — count active-during-work time on flagged domains
  await dispatchNotifications(plan); // Epic C2 — escalation/switch/ready events, once each; also
  // the root-cause-1 sync check (re-adopts/tears down local state to match the service's plan).
}

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === PHASE_ALARM) onPhaseAlarm();
  else if (a.name === TICK_ALARM) onTick();
});
chrome.runtime.onStartup.addListener(reconcile);
chrome.runtime.onInstalled.addListener(reconcile);

// Re-check a tab when you switch to it during work — catches an already-open off-task tab (e.g. one
// you left open during the break) the moment you return to it, without needing a navigation.
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const st = await getState();
  if (!st.session || st.phase !== "work") return;
  try {
    await enforceTab(await chrome.tabs.get(tabId), false); // switched to it during work → hard block
  } catch {
    /* tab may have closed */
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg?.type) {
        case "getState":
          sendResponse(await getState());
          break;
        case "getProjects":
          sendResponse(await api("/projects"));
          break;
        case "getConfig":
          // Review fix: content-guard sends this on EVERY page load (to read pageScopeDomains) —
          // route it through the same 30s cache accrueRabbitHole already uses instead of a fresh
          // service round-trip (+ a full decisionCounts scan) per navigation.
          sendResponse(await getConfigCached());
          break;
        case "saveTiers":
          sendResponse(
            await api("/config/tiers", {
              method: "POST",
              body: JSON.stringify({ tier1: msg.tier1, tier3: msg.tier3 }),
            }),
          );
          break;
        case "resetTiers":
          sendResponse(await api("/config/tiers/reset", { method: "POST", body: "{}" }));
          break;
        case "getModels":
          sendResponse(await api("/models"));
          break;
        case "saveSettings":
          sendResponse(
            await api("/config/settings", {
              method: "POST",
              body: JSON.stringify(msg.settings ?? {}),
            }),
          );
          break;
        case "learn": // clarify-card answer (Epic 0.3); scope/unit set for per-page domains (0.7)
          sendResponse(
            await api("/decisions/learn", {
              method: "POST",
              body: JSON.stringify({
                url: msg.url,
                decision: msg.decision,
                via: msg.via || "clarify",
                scope: msg.scope,
                unit: msg.unit,
              }),
            }),
          );
          break;
        case "refocus": // "make focus more specific" shortcut (Epic 0.3)
          sendResponse(
            await api("/session/refocus", { method: "POST", body: JSON.stringify({ task: msg.task }) }),
          );
          break;
        case "markPage": // honesty lever (Epic 0.5) / rabbit-hole wrap-up (0.8)
          sendResponse(
            await markPage(msg.tabId ?? sender.tab?.id, msg.url ?? sender.tab?.url, msg.decision),
          );
          break;
        case "clearDecisions":
          sendResponse(await api("/decisions/clear", { method: "POST", body: "{}" }));
          break;
        case "testSound": // options-page preview (Epic S3) — plays even while the toggle is off
          await playCue(msg.cue || "work", true);
          sendResponse({ ok: true });
          break;
        case "graceStart": // Epic F1 — pause the work clock while the grace overlay is up
          sendResponse(await graceStart());
          break;
        case "graceEnd": // Epic F1 — resume: extend phaseEndsAt by the paused duration
          sendResponse(await graceEnd());
          break;
        case "help": // "Ask about BRICK" panel (Epic H3) → grounded /help Q&A
          sendResponse(
            await api("/help", {
              method: "POST",
              body: JSON.stringify({ question: msg.question, history: msg.history || [] }),
            }),
          );
          break;
        case "getPlan":
          sendResponse({ plan: await getPlanCached(true) });
          break;
        case "planStart": {
          // Start the plan on the service, then adopt its session for local enforcement.
          const r = await api("/plan/start", { method: "POST", body: JSON.stringify(msg.opts ?? {}) });
          planCache = { at: 0, plan: null };
          await adoptServiceSession();
          await markPlanSynced(r.plan); // tells the next tick's sync check there's no drift to fix
          sendResponse(r);
          break;
        }
        case "planAdvance": {
          const r = await api("/plan/block/advance", {
            method: "POST",
            body: JSON.stringify({ blockId: msg.blockId, how: msg.how || "done" }),
          });
          planCache = { at: 0, plan: null };
          if (r.plan && r.plan.activeBlockId) await adoptServiceSession();
          else await teardownLocal(); // last block advanced → plan over
          await markPlanSynced(r.plan);
          sendResponse(r);
          break;
        }
        case "planStep": {
          const r = await api("/plan/block/step", {
            method: "POST",
            body: JSON.stringify({ blockId: msg.blockId, stepId: msg.stepId }),
          });
          planCache = { at: 0, plan: null }; // review fix: this was the one plan mutator that didn't
          sendResponse(r);
          break;
        }
        case "planEnd": {
          const r = await api("/plan/end", { method: "POST", body: "{}" });
          planCache = { at: 0, plan: null };
          await teardownLocal();
          await markPlanSynced(null);
          sendResponse(r);
          break;
        }
        case "planUndo": {
          // Revert the last auto-advance (Epic B3) and re-adopt the restored block's session.
          const r = await api("/plan/undo-advance", { method: "POST", body: "{}" });
          planCache = { at: 0, plan: null };
          await adoptServiceSession();
          await markPlanSynced(r.plan);
          sendResponse(r);
          break;
        }
        case "getTemplates":
          sendResponse(await api("/templates"));
          break;
        case "planFromTemplate": {
          const r = await api("/plan/from-template", { method: "POST", body: JSON.stringify(msg.opts ?? {}) });
          planCache = { at: 0, plan: null };
          await adoptServiceSession();
          await markPlanSynced(r.plan);
          sendResponse(r);
          break;
        }
        case "saveTemplate": // "save current plan as template" (T3)
          sendResponse(
            await api("/templates", {
              method: "POST",
              body: JSON.stringify({ fromCurrent: { name: msg.name, parameterize: msg.parameterize } }),
            }),
          );
          break;
        case "deleteTemplate":
          sendResponse(await api("/templates/" + encodeURIComponent(msg.id), { method: "DELETE" }));
          break;
        case "startSession":
          sendResponse(await startSession(msg.opts ?? {}));
          break;
        case "stopSession":
          await stopSession();
          sendResponse({ ok: true });
          break;
        case "guard":
          sendResponse(await guard(msg.url, msg.title, msg.unit));
          break;
        case "prepend":
          sendResponse(
            await api("/prepend", { method: "POST", body: JSON.stringify(msg.opts ?? {}) }),
          );
          break;
        default:
          sendResponse({ error: "unknown message" });
      }
    } catch (e) {
      sendResponse({ error: String(e?.message ?? e) });
    }
  })();
  return true; // keep the message channel open for the async response
});
