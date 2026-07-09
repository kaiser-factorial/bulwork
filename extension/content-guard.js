// Tier-2 focus enforcement on every http(s) page.
//   - Navigation check at document_start, then a DEEPER re-check once the page describes itself.
//   - On "off-task", show a SOFT overlay (modal → optional 1-min grace with a red reminder → re-prompt)
//     instead of a hard redirect, so you're nudged without losing what you were mid-typing.
//   - Also listens for background "brick:catch" messages (when work re-engages on an already-open tab).
// Tier-1 (always-blocked) still hard-redirects to the block page. Fails open everywhere.
(() => {
  if (!location.protocol.startsWith("http")) return;

  const pageSignal = () => {
    const desc = document.querySelector('meta[name="description"]')?.content || "";
    const h1 = document.querySelector("h1")?.textContent?.trim() || "";
    return [document.title, desc, h1].filter(Boolean).join(" — ").slice(0, 400);
  };

  // ---------- per-page scoping for high-variance domains (Epic 0.7) ----------
  // A page-scoped domain (default: YouTube) is judged per *page* (video), not per whole site: we send
  // a per-page `unit` (the ?v= id) on each check, learn with scope:"page", and re-adjudicate on SPA
  // navigation (video→video) since those don't reload the document.
  const host = location.hostname.replace(/^www\./, "").toLowerCase();
  let pageScopeDomains = ["youtube.com", "youtu.be"]; // default; refined from /config settings
  const isPageScoped = () => pageScopeDomains.some((d) => host === d || host.endsWith("." + d));
  const videoUnit = () => {
    try {
      return new URL(location.href).searchParams.get("v") || null;
    } catch {
      return null;
    }
  };
  const pageUnit = () => (isPageScoped() ? videoUnit() : null);

  // ---------- soft overlay (rendered via the shared BrickOverlay primitive, Epic U1) ----------
  const WORK_COLOR = "#c0392b"; // red grace wash (matches background.js WORK_COLOR)
  const BREAK_COLOR = "#2e8b57"; // green break border (matches background.js BREAK_COLOR)

  let tick = null;
  let graceHandle = null;
  let graceActive = false; // a grace stint is running → the work clock is paused (Epic F1)
  let clarifiedHref = null; // page already answered/dismissed a clarify card → don't re-nag this load

  const stopTick = () => {
    if (tick) clearInterval(tick);
    tick = null;
  };

  // End the current grace stint (if any): tell the background to resume the work clock, crediting
  // the paused duration to phaseEndsAt (Epic F1). Safe to call when no grace is active.
  const endGrace = () => {
    if (!graceActive) return;
    graceActive = false;
    chrome.runtime.sendMessage({ type: "graceEnd" }).catch(() => {});
  };

  const removeOverlay = () => {
    stopTick();
    endGrace();
    graceHandle = null;
    window.BrickOverlay?.clear();
  };

  const showModal = (reason) => {
    stopTick();
    endGrace(); // the re-prompt marks the end of a grace stint — the clock resumes while you decide
    if (!window.BrickOverlay) return; // helper not injected → fail open (no overlay)
    window.BrickOverlay.show({
      card: {
        backdrop: true,
        tag: "■ BRICK MODE",
        title: "Back to BRICK MODE 🧱",
        body: reason || "This page is off-task for your focus right now.",
        buttons: [
          { label: "Just 1 more minute", kind: "stay", onClick: startGrace },
          { label: "Back to work →", kind: "go", onClick: goBack },
        ],
      },
    });
  };

  const graceChip = (left) => {
    const s = String(left % 60).padStart(2, "0");
    return `🧱 off task — ${Math.floor(left / 60)}:${s} · tap for back to work →`;
  };

  // Escalating opacity (Epic F2): each "one more minute" within the same work block deepens the
  // tint — lightest first, +0.12 per repeat, capped well short of a black-out. Resets next block
  // (the background resets graceCount when a fresh work phase starts).
  const graceFill = (count) => Math.min(0.22 + 0.12 * (Math.max(1, count) - 1), 0.6);

  const startGrace = async () => {
    stopTick();
    if (!window.BrickOverlay) return;
    // F1: ask the background to pause the work clock. Past the per-block grace cap, grace is no
    // longer granted — the escalation has maxed out and the page hard-blocks.
    let res = { ok: true, graceCount: 1 };
    try {
      res = (await chrome.runtime.sendMessage({ type: "graceStart" })) || res;
    } catch {
      /* background unreachable — grant the visual grace, no pause */
    }
    if (res.capped) {
      hardBlock({ reason: "Grace budget for this work block is used up — back to work." });
      return;
    }
    graceActive = res.ok !== false;
    let left = 60;
    // Grace vignette: red wash + inset border/glow + slow breathing, with a live countdown chip.
    // The chip doubles as the always-reachable "back to work" control (clickable at every level).
    graceHandle = window.BrickOverlay.show({
      color: WORK_COLOR,
      fill: graceFill(res.graceCount || 1),
      border: 4,
      glow: true,
      breathe: true,
      chip: graceChip(left),
      onChipClick: goBack,
    });
    tick = setInterval(() => {
      left -= 1;
      if (left <= 0) {
        stopTick();
        recheck();
      } else {
        graceHandle?.setChip(graceChip(left));
      }
    }, 1000);
  };

  const recheck = async () => {
    endGrace(); // the countdown finished — the stint is over regardless of what the verdict says
    try {
      const res = await chrome.runtime.sendMessage({
        type: "guard",
        url: location.href,
        title: pageSignal(),
        unit: pageUnit(),
      });
      if (res && res.decision === "ask") showClarify(res.reason);
      else if (res && res.allow === false) showModal(res.reason);
      else removeOverlay(); // on-task now, or break started (guard allows outside work) → clear
    } catch {
      removeOverlay();
    }
  };

  const goBack = () => {
    removeOverlay();
    if (history.length > 1) history.back();
    else location.replace("about:blank");
  };

  // ---------- clarify-and-learn card (Epic 0.3): shown on an `ask` verdict ----------
  // A non-blocking corner card — the page stays loaded and usable (an `ask` is a question, not a
  // hold). Answering writes to the learned store when "remember" is checked; ignoring it fails open
  // (we simply don't re-nag this page load).
  const learn = (decision) => {
    const msg = { type: "learn", url: location.href, decision, via: "clarify" };
    // Page-scoped domains learn per video, not per whole site (0.7). Request page scope whenever
    // the DOMAIN is page-scoped, even if this client's own unit extraction came back empty (e.g. a
    // youtu.be path-based link) — review fix: the server derives the unit from the URL itself as
    // the single source of truth, so this no longer silently degrades to domain-scope learning.
    if (isPageScoped()) {
      msg.scope = "page";
      const unit = pageUnit();
      if (unit) msg.unit = unit; // pass it along as a hint; the server re-derives if absent
    }
    return chrome.runtime.sendMessage(msg).catch(() => {});
  };

  const makeSpecific = async () => {
    const next = window.prompt(
      "Refine your focus so BRICK can tell what's on-topic:",
      "",
    );
    if (!next || !next.trim()) return;
    try {
      await chrome.runtime.sendMessage({ type: "refocus", task: next.trim() });
    } catch {
      /* ignore — refocus is best-effort */
    }
    removeOverlay();
    clarifiedHref = null; // re-evaluate this page under the tightened focus
    recheck();
  };

  const showClarify = (reason) => {
    if (!window.BrickOverlay) return; // helper missing → fail open (page stays loaded)
    if (clarifiedHref === location.href) return; // already answered/dismissed here → no re-nag
    clarifiedHref = location.href;
    stopTick();
    const host = location.hostname.replace(/^www\./, "");
    window.BrickOverlay.show({
      card: {
        corner: true,
        tag: "■ BRICK MODE",
        title: "Is this on-topic?",
        body: reason || `Not sure if ${host} fits your current focus.`,
        checkbox: { label: "remember for this focus", checked: true },
        buttons: [
          {
            label: "Yes, on-topic",
            kind: "yes",
            onClick: (ctx) => {
              if (ctx.checked) learn("allow");
              removeOverlay();
            },
          },
          {
            label: "No, block",
            kind: "go",
            onClick: (ctx) => {
              if (ctx.checked) learn("block");
              goBack();
            },
          },
        ],
        links: [{ label: "make focus more specific", onClick: makeSpecific }],
      },
    });
  };

  // Re-adjudicate the current page (used by the SPA hook on a video change, Epic 0.7).
  const reAdjudicate = async () => {
    try {
      const res = await chrome.runtime.sendMessage({
        type: "guard",
        url: location.href,
        title: pageSignal(),
        unit: pageUnit(),
      });
      if (res && res.decision === "ask") showClarify(res.reason);
      else if (res && res.allow === false) hardBlock(res);
      else removeOverlay(); // this video is on-task → clear any overlay from the previous one
    } catch {
      removeOverlay();
    }
  };

  // Rabbit-hole time nudge (Epic 0.8): a check-in card after long foreground time on a flagged domain.
  const showRabbitHole = (domain, minutes) => {
    if (!window.BrickOverlay) return;
    window.BrickOverlay.show({
      card: {
        corner: true,
        tag: "■ BRICK MODE",
        title: `${minutes} min on ${domain} this session`,
        body: "Still productive here, or time to wrap up?",
        buttons: [
          { label: "Keep going", kind: "stay", onClick: () => removeOverlay() },
          {
            label: "Wrap up",
            kind: "go",
            onClick: () => {
              // Block this domain for the focus (via correction) — background soft-blocks the tab.
              chrome.runtime
                .sendMessage({ type: "markPage", decision: "block", url: location.href })
                .catch(() => {});
              removeOverlay();
            },
          },
        ],
      },
    });
  };

  // Phase-change border (Epic S1): an unmissable, momentary signal on every state change — a colored
  // screen border (red = work, green = break) that fades after a configurable window (default 10s).
  // Rendered through the U1 helper (pointer-events:none — never intercepts clicks; reduced-motion is
  // a steady fade, no strobe). Purely client-side: settings live in chrome.storage.local.
  const showPhaseBorder = async (phase) => {
    if (!window.BrickOverlay) return;
    let fb = { border: true, borderSec: 10 };
    try {
      const { brickFeedback } = await chrome.storage.local.get("brickFeedback");
      fb = { ...fb, ...(brickFeedback || {}) };
    } catch {
      /* defaults */
    }
    if (!fb.border) return;
    window.BrickOverlay.show({
      color: phase === "work" ? WORK_COLOR : BREAK_COLOR,
      border: 6,
      duration: Math.max(1, Number(fb.borderSec) || 10) * 1000,
    });
  };

  // Plan switch/escalation card (Epic C4): a bottom-right, non-blocking card at swap time —
  // "Time's up on A — start B?" with Advance / Stay (or Undo after an auto-switch). Reuses the
  // shared overlay; buttons hit the background's plan routes.
  const showSwitchCard = (msg) => {
    if (!window.BrickOverlay) return;
    const BTN = {
      advance: {
        label: "Advance →",
        kind: "yes",
        onClick: () => {
          chrome.runtime.sendMessage({ type: "planAdvance" }).catch(() => {});
          removeOverlay();
        },
      },
      undo: {
        label: "↩ Undo",
        kind: "go",
        onClick: () => {
          chrome.runtime.sendMessage({ type: "planUndo" }).catch(() => {});
          removeOverlay();
        },
      },
      stay: { label: "Stay", kind: "stay", onClick: () => removeOverlay() },
    };
    window.BrickOverlay.show({
      card: {
        corner: true,
        tag: "■ BRICK MODE",
        title: msg.title || "Plan update",
        body: msg.body || "",
        buttons: (msg.actions || ["stay"]).map((a) => BTN[a]).filter(Boolean),
      },
    });
  };

  // Background tells us a work phase re-engaged on this already-open tab.
  // brick:phase keeps the overlay synced with the Pomodoro: when the phase flips away from "work"
  // (break / session ended) any active grace-minute countdown is cleared, so the overlay doesn't
  // keep nagging during a break or after the session is over. On a work/break flip the S1 border
  // renders after that cleanup (an enforcement overlay arriving later — brick:catch — replaces it;
  // enforcement always wins over decoration).
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "brick:catch") showModal(msg.reason);
    else if (msg?.type === "brick:phase") {
      if (msg.phase !== "work") removeOverlay();
      if (msg.phase === "work" || msg.phase === "break") showPhaseBorder(msg.phase);
    } else if (msg?.type === "brick:rabbithole") showRabbitHole(msg.domain, msg.minutes);
    else if (msg?.type === "brick:switch") showSwitchCard(msg);
  });

  // Install an SPA-navigation hook on page-scoped domains so video→video changes re-adjudicate
  // without a full reload (Epic 0.7). Patches pushState/replaceState + listens for popstate.
  const installSpaHook = () => {
    if (!isPageScoped() || window.__brickSpaHooked) return;
    window.__brickSpaHooked = true;
    let lastUnit = videoUnit();
    const onNav = () => {
      const u = videoUnit();
      if (u !== lastUnit) {
        lastUnit = u;
        clarifiedHref = null; // a new video is a fresh page for the clarify guard
        setTimeout(reAdjudicate, 700); // let the SPA update the title first
      }
    };
    for (const m of ["pushState", "replaceState"]) {
      const orig = history[m];
      history[m] = function () {
        const r = orig.apply(this, arguments);
        try {
          onNav();
        } catch {
          /* ignore */
        }
        return r;
      };
    }
    window.addEventListener("popstate", onNav);
  };
  installSpaHook(); // for the default (YouTube); re-checked once /config settings load below
  chrome.runtime
    .sendMessage({ type: "getConfig" })
    .then((cfg) => {
      const d = cfg?.settings?.pageScopeDomains;
      if (Array.isArray(d) && d.length) pageScopeDomains = d;
      installSpaHook();
    })
    .catch(() => {});

  // ---------- navigation check ----------
  // Navigating to an off-task page DURING work is a HARD block — no grace. The soft "1 more minute"
  // overlay (showModal) is only triggered by the background brick:catch message, which is sent solely
  // on the break→work transition (you were already on the page when the mode flipped under you).
  const hardBlock = (res) => {
    const p = new URLSearchParams({
      url: location.href,
      reason: res.reason ?? "off-task",
      tier: res.tier ?? "tier2",
      decision: "block",
    });
    try {
      window.stop();
    } catch {
      /* ignore */
    }
    location.replace(chrome.runtime.getURL("block.html") + "?" + p.toString());
  };

  (async () => {
    let phase1;
    try {
      phase1 = await chrome.runtime.sendMessage({ type: "guard", url: location.href, unit: pageUnit() });
    } catch {
      return; // background unreachable — fail open
    }
    if (phase1 && phase1.allow === false) {
      hardBlock(phase1);
      return;
    }
    // Deepen real Tier-2 verdicts (allow or ask) with the page's title; a stub/Tier-1/3 is final.
    // A providerError allow is a fail-open, not a judged verdict (review fix) — treat it like a
    // stub too, so an outage doesn't spend a second doomed provider call on every navigation.
    if (!phase1 || phase1.tier !== "tier2" || phase1.stub || phase1.providerError) return;

    const deeper = async () => {
      const title = pageSignal();
      if (!title) return;
      try {
        const res = await chrome.runtime.sendMessage({
          type: "guard",
          url: location.href,
          title,
          unit: pageUnit(),
        });
        if (res && res.decision === "ask") showClarify(res.reason);
        else if (res && res.allow === false) hardBlock(res);
      } catch {
        /* fail open */
      }
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", deeper, { once: true });
    } else {
      deeper();
    }
  })();
})();
