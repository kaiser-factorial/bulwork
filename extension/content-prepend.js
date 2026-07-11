// Soft-nudge focus header on AI chat sites (claude.ai / gemini / chatgpt).
// MVP: injects an OPTIONAL "prepend focus" control rather than intercepting the send — reliable
// and true to the soft-nudge decision. Auto-on-send interception is a future per-site enhancement
// (see SESSION_LOG DIVERGENCE 4).
(async () => {
  let state;
  try {
    state = await chrome.runtime.sendMessage({ type: "getState" });
  } catch {
    return;
  }
  if (!state || !state.session || state.phase !== "work") return;

  const focusTask = (state.session.focus && state.session.focus.task) || "your focus task";

  const findComposer = () => {
    const visible = (el) => el.offsetParent !== null;
    const ce = [...document.querySelectorAll('[contenteditable="true"]')].filter(visible);
    if (ce.length) return ce[ce.length - 1];
    const ta = [...document.querySelectorAll("textarea")].filter(visible);
    if (ta.length) return ta[ta.length - 1];
    return null;
  };

  const insertHeader = (el, header) => {
    const text = header + "\n\n";
    if (el.tagName === "TEXTAREA") {
      el.value = text + el.value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.focus();
    } else {
      el.focus();
      const sel = window.getSelection();
      const range = document.createRange();
      range.setStart(el, 0);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
      // execCommand is deprecated but still the most framework-compatible insert in Chrome.
      document.execCommand("insertText", false, text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
  };

  const style = document.createElement("style");
  style.textContent = `
    #brick-focus-pill { position: fixed; z-index: 2147483647; bottom: 16px; right: 16px;
      background: #0a0f0a; color: #6ee7a8; border: 1px solid #173b29; border-radius: 999px;
      padding: 8px 12px; display: flex; align-items: center; gap: 8px; max-width: 360px;
      font: 12px ui-monospace, Menlo, monospace; box-shadow: 0 4px 18px rgba(0,0,0,.4); }
    #brick-focus-pill .brick-dot { color: #ff6b6b; }
    #brick-focus-pill .brick-task { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    #brick-focus-pill .brick-btn { background: transparent; color: #6ee7a8; border: 1px solid #6ee7a8;
      border-radius: 999px; padding: 2px 8px; cursor: pointer; font: inherit; white-space: nowrap; }
    #brick-focus-pill .brick-btn:hover { background: #6ee7a8; color: #0a0f0a; }`;
  document.documentElement.appendChild(style);

  const pill = document.createElement("div");
  pill.id = "brick-focus-pill";
  pill.innerHTML =
    '<span class="brick-dot">■</span><span class="brick-task"></span>' +
    '<button class="brick-btn" type="button">↳ prepend focus</button>';
  pill.querySelector(".brick-task").textContent = focusTask;
  document.documentElement.appendChild(pill);

  pill.querySelector(".brick-btn").addEventListener("click", async () => {
    const el = findComposer();
    if (!el) {
      pill.querySelector(".brick-task").textContent = "(no input found)";
      return;
    }
    let header = `[BULWORK MODE — focus session active]\nMy focus task: ${focusTask}`;
    try {
      const r = await chrome.runtime.sendMessage({ type: "prepend", opts: {} });
      if (r && r.header) header = r.header;
    } catch {
      /* fall back to the inline header */
    }
    insertHeader(el, header);
  });
})();
