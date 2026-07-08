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

  // ---------- soft overlay (rendered via the shared BrickOverlay primitive, Epic U1) ----------
  const WORK_COLOR = "#c0392b"; // red grace wash (matches background.js WORK_COLOR)

  let tick = null;
  let graceHandle = null;
  let clarifiedHref = null; // page already answered/dismissed a clarify card → don't re-nag this load

  const stopTick = () => {
    if (tick) clearInterval(tick);
    tick = null;
  };

  const removeOverlay = () => {
    stopTick();
    graceHandle = null;
    window.BrickOverlay?.clear();
  };

  const showModal = (reason) => {
    stopTick();
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
    return `🧱 off task — back to work in ${Math.floor(left / 60)}:${s}`;
  };

  const startGrace = () => {
    stopTick();
    if (!window.BrickOverlay) return;
    let left = 60;
    // Grace vignette: red wash + inset border/glow + slow breathing, with a live countdown chip.
    graceHandle = window.BrickOverlay.show({
      color: WORK_COLOR,
      fill: 0.22,
      border: 4,
      glow: true,
      breathe: true,
      chip: graceChip(left),
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
    try {
      const res = await chrome.runtime.sendMessage({
        type: "guard",
        url: location.href,
        title: pageSignal(),
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
  const learn = (decision) =>
    chrome.runtime
      .sendMessage({ type: "learn", url: location.href, decision, via: "clarify" })
      .catch(() => {});

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

  // Background tells us a work phase re-engaged on this already-open tab.
  // brick:phase keeps the overlay synced with the Pomodoro: when the phase flips away from "work"
  // (break / session ended) any active grace-minute countdown is cleared, so the overlay doesn't
  // keep nagging during a break or after the session is over.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "brick:catch") showModal(msg.reason);
    else if (msg?.type === "brick:phase" && msg.phase !== "work") removeOverlay();
  });

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
      phase1 = await chrome.runtime.sendMessage({ type: "guard", url: location.href });
    } catch {
      return; // background unreachable — fail open
    }
    if (phase1 && phase1.allow === false) {
      hardBlock(phase1);
      return;
    }
    // Deepen real Tier-2 verdicts (allow or ask) with the page's title; a stub/Tier-1/3 is final.
    if (!phase1 || phase1.tier !== "tier2" || phase1.stub) return;

    const deeper = async () => {
      const title = pageSignal();
      if (!title) return;
      try {
        const res = await chrome.runtime.sendMessage({ type: "guard", url: location.href, title });
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
