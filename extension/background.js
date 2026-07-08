// BRICK MODE — background service worker.
// Owns session state, talks to the local brick service, manages Tier-1 blocking rules
// and the Pomodoro phase alarms. Content scripts and the popup message this worker.

const SERVICE = "http://127.0.0.1:7373";
const DNR_BASE = 1000; // dynamic-rule id offset for brick Tier-1 rules
const DNR_MAX = 200; // reserved id range [DNR_BASE, DNR_BASE+DNR_MAX)
const PHASE_ALARM = "brick-phase";
const TICK_ALARM = "brick-tick"; // fires every minute to refresh the toolbar badge
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
async function updateBadge(st) {
  const s = st ?? (await getState());
  if (!s.session) {
    await chrome.action.setBadgeText({ text: "" });
    await chrome.action.setTitle({ title: "BRICK MODE — no active session" });
    return;
  }
  const minsLeft = Math.max(0, Math.ceil(((s.phaseEndsAt ?? Date.now()) - Date.now()) / 60000));
  const isWork = s.phase === "work";
  await chrome.action.setBadgeText({ text: String(minsLeft) });
  await chrome.action.setBadgeBackgroundColor({ color: isWork ? WORK_COLOR : BREAK_COLOR });
  await chrome.action.setTitle({
    title: `BRICK — ${isWork ? "work" : "break"} · ${minsLeft} min left · ${s.session.focus.task}`,
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
// catch up correctly when reconciling after the worker/browser was asleep).
function nextPhaseState(st) {
  const toBreak = st.phase === "work";
  const minutes = toBreak ? st.session.breakMinutes ?? 5 : st.session.workMinutes ?? 25;
  const base = st.phaseEndsAt ?? Date.now();
  return { ...st, phase: toBreak ? "break" : "work", phaseEndsAt: base + minutes * 60000 };
}

async function startSession(opts) {
  const { session } = await api("/session/start", { method: "POST", body: JSON.stringify(opts) });
  const phaseEndsAt = Date.now() + (session.workMinutes ?? 25) * 60000;
  const state = { session, phase: "work", phaseEndsAt };
  await setState(state);
  await setTier1Rules(true);
  await chrome.alarms.create(PHASE_ALARM, { when: phaseEndsAt });
  await chrome.alarms.create(TICK_ALARM, { periodInMinutes: 1 });
  await updateBadge(state);
  await broadcastPhase("work");
  await enforceOpenTabs(); // block off-task tabs already open when the session starts
  return state;
}

async function stopSession() {
  await chrome.alarms.clear(PHASE_ALARM);
  await chrome.alarms.clear(TICK_ALARM);
  await setTier1Rules(false);
  try {
    await api("/session/stop", { method: "POST", body: "{}" });
  } catch {
    /* service may be down; clear local state regardless */
  }
  await setState({ session: null, phase: null, phaseEndsAt: null });
  await updateBadge();
  await broadcastPhase(null);
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
  await chrome.alarms.create(TICK_ALARM, { periodInMinutes: 1 });
  await updateBadge(st);
  if (changed) await broadcastPhase(st.phase);
  if (st.phase === "work") await enforceOpenTabs();
}

// Tier-2 adjudication for a navigation (called by content-guard; title is the Phase-2 deeper signal).
async function guard(url, title) {
  const st = await getState();
  if (!st.session || st.phase !== "work") {
    return { allow: true, tier: "tier3", reason: "no active work session" };
  }
  try {
    const r = await api("/adjudicate", { method: "POST", body: JSON.stringify({ url, title }) });
    return {
      allow: r.decision !== "block",
      decision: r.decision,
      reason: r.reason,
      tier: r.tier,
      stub: r.stub,
    };
  } catch {
    // Fail open — never block real work because the service is unreachable.
    return { allow: true, tier: "error", reason: "brick service unreachable (fail-open)" };
  }
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
  for (const tab of tabs) await enforceTab(tab, true); // passive sweep → soft (grace)
}

// Broadcast a phase change to every tab so any in-page UI (the grace-minute overlay) can react.
// The overlay's own 60s timer is independent of the Pomodoro; without this it would keep nagging
// after work→break, or hang around after the user ended the session.
async function broadcastPhase(phase) {
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

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === PHASE_ALARM) onPhaseAlarm();
  else if (a.name === TICK_ALARM) updateBadge();
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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
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
          sendResponse(await api("/config"));
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
        case "learn": // clarify-card answer (Epic 0.3)
          sendResponse(
            await api("/decisions/learn", {
              method: "POST",
              body: JSON.stringify({ url: msg.url, decision: msg.decision, via: msg.via || "clarify" }),
            }),
          );
          break;
        case "refocus": // "make focus more specific" shortcut (Epic 0.3)
          sendResponse(
            await api("/session/refocus", { method: "POST", body: JSON.stringify({ task: msg.task }) }),
          );
          break;
        case "markPage": // honesty lever (Epic 0.5)
          sendResponse(await markPage(msg.tabId, msg.url, msg.decision));
          break;
        case "clearDecisions":
          sendResponse(await api("/decisions/clear", { method: "POST", body: "{}" }));
          break;
        case "startSession":
          sendResponse(await startSession(msg.opts ?? {}));
          break;
        case "stopSession":
          await stopSession();
          sendResponse({ ok: true });
          break;
        case "guard":
          sendResponse(await guard(msg.url, msg.title));
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
