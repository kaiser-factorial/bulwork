// BRICK MODE — shared transient-treatment overlay primitive (Epic U1).
//
// One reusable full-viewport screen treatment that the grace overlay (F1/F2), the phase-change
// border (S1), and the clarify card (0.3) all render through — so they don't each re-implement
// full-screen rendering or collide in content-guard.js.
//
// Loaded as a content script BEFORE content-guard.js (same isolated world), it exposes
// `window.BrickOverlay`. The layer is fixed, high-z-index, and pointer-events:none by default
// (never blocks page clicks) — only an inner card or a chip is interactive. Calling show() again
// replaces the current treatment (never stacks). Honours prefers-reduced-motion (fade, never a
// flash/strobe).
(() => {
  if (window.BrickOverlay) return; // idempotent across re-injection

  const ROOT_ID = "brick-overlay-root";
  const reducedMotion = () => {
    try {
      return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch {
      return false;
    }
  };
  const escapeHtml = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
    );

  const CSS = `
  #${ROOT_ID}{all:initial}
  #${ROOT_ID} .bo{position:fixed;inset:0;z-index:2147483647;pointer-events:none;opacity:0;
    transition:opacity var(--bo-fade,200ms) ease;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
  #${ROOT_ID} .bo.bo-in{opacity:1}
  #${ROOT_ID} .bo-reduced{transition:none}
  /* full-viewport tint / border / glow layer (fill=0 → border-only, e.g. the S1 phase border) */
  #${ROOT_ID} .bo-vignette{position:fixed;inset:0;pointer-events:none}
  #${ROOT_ID} .bo-breathe{animation:bo-wash 2.4s ease-in-out infinite}
  @keyframes bo-wash{0%,100%{filter:brightness(1)}50%{filter:brightness(1.4)}}
  /* bottom-center pill (grace countdown, rabbit-hole nudge) */
  #${ROOT_ID} .bo-chip{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);pointer-events:auto;
    background:#14110a;color:#fbd962;border:1px solid #c0392b;border-radius:999px;padding:7px 14px;font-size:12px;
    box-shadow:0 6px 20px rgba(0,0,0,.4)}
  #${ROOT_ID} .bo-chip.bo-chip-btn{cursor:pointer}
  #${ROOT_ID} .bo-chip.bo-chip-btn:hover{border-color:#fbd962}
  /* modal card + backdrop (the "back to BRICK MODE" prompt, the clarify card) */
  #${ROOT_ID} .bo-back{position:fixed;inset:0;background:rgba(8,6,2,.55);
    -webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px);pointer-events:auto}
  #${ROOT_ID} .bo-modal{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);
    width:min(420px,92vw);box-sizing:border-box;background:#14110a;color:#fbd962;border:2px solid #c0392b;
    border-radius:12px;padding:26px;text-align:center;box-shadow:0 24px 70px rgba(0,0,0,.55);pointer-events:auto}
  #${ROOT_ID} .bo-tag{letter-spacing:.3em;color:#c0392b;font-weight:700;font-size:11px}
  #${ROOT_ID} .bo-h{font-size:1.35rem;margin:12px 0 6px;color:#fbd962}
  #${ROOT_ID} .bo-reason{color:#cda94e;font-size:.85rem;margin:0 0 20px;line-height:1.4}
  #${ROOT_ID} .bo-actions{display:flex;gap:10px;justify-content:center;flex-wrap:wrap}
  #${ROOT_ID} .bo-actions button{font:inherit;padding:9px 14px;border-radius:7px;cursor:pointer;border:1px solid;
    transition:background .2s ease,color .2s ease,border-color .2s ease}
  #${ROOT_ID} .bo-stay{background:transparent;color:#777;border-color:#3a3a3a}
  #${ROOT_ID} .bo-stay:hover{background:#3a3a3a;color:#ccc;border-color:#5a5a5a}
  #${ROOT_ID} .bo-go{background:#c0392b;color:#fff;border-color:#c0392b}
  #${ROOT_ID} .bo-go:hover{filter:brightness(1.12)}
  #${ROOT_ID} .bo-yes{background:#2e8b57;color:#fff;border-color:#2e8b57}
  #${ROOT_ID} .bo-yes:hover{filter:brightness(1.12)}
  /* corner card (non-blocking) — the clarify prompt; page stays interactive behind it */
  #${ROOT_ID} .bo-corner{position:fixed;right:18px;bottom:18px;width:min(340px,92vw);box-sizing:border-box;
    background:#14110a;color:#fbd962;border:2px solid #c0392b;border-radius:12px;padding:18px;text-align:left;
    box-shadow:0 18px 50px rgba(0,0,0,.5);pointer-events:auto}
  #${ROOT_ID} .bo-corner .bo-h{font-size:1.05rem}
  #${ROOT_ID} .bo-corner .bo-reason{text-align:left}
  #${ROOT_ID} .bo-corner .bo-actions{justify-content:flex-start}
  #${ROOT_ID} .bo-check{display:flex;align-items:center;gap:7px;color:#cda94e;font-size:.8rem;margin:2px 0 12px;cursor:pointer}
  #${ROOT_ID} .bo-check input{accent-color:#c0392b;width:auto}
  #${ROOT_ID} .bo-links{margin-top:10px}
  #${ROOT_ID} .bo-link{background:none;border:0;padding:0;color:#8fb4ff;text-decoration:underline;cursor:pointer;font:inherit;font-size:.78rem}
  #${ROOT_ID} .bo-link:hover{color:#b9d1ff}`;

  let clearTimer = null;

  const clearTimers = () => {
    if (clearTimer) clearTimeout(clearTimer);
    clearTimer = null;
  };

  const clear = () => {
    clearTimers();
    document.getElementById(ROOT_ID)?.remove();
  };

  const ensureContainer = () => {
    let root = document.getElementById(ROOT_ID);
    if (!root) {
      root = document.createElement("div");
      root.id = ROOT_ID;
      root.innerHTML = `<style>${CSS}</style><div class="bo"></div>`;
      (document.body || document.documentElement).appendChild(root);
    }
    return root.querySelector(".bo");
  };

  // Compose an inset box-shadow: a solid border ring (border px) + an optional soft inner glow,
  // both in `color`. Mirrors the original grace-vignette treatment.
  const insetShadow = (color, border, glow) => {
    const parts = [];
    if (border > 0) parts.push(`inset 0 0 0 ${border}px ${color}`);
    if (glow) parts.push(`inset 0 0 160px ${rgba(color, 0.5)}`);
    return parts.join(", ");
  };

  // Accept #rrggbb and produce rgba() at the given alpha for the tint / glow.
  const rgba = (color, alpha) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(color).trim());
    if (!m) return color;
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  };

  /**
   * Render a transient treatment (replaces any current one).
   * @param {object} opts
   *   color   {string} hex accent (#rrggbb)                 default #c0392b (work red)
   *   fill    {number} 0..1 background tint alpha            default 0     (0 → border-only)
   *   border  {number} inset ring width px                  default 0
   *   glow    {boolean} soft inner glow                      default false
   *   breathe {boolean} slow brightness pulse (reduced-motion disables it)
   *   chip    {string}  bottom-center pill text (interactive)
   *   onChipClick {function} makes the chip a button (e.g. the grace "back to work" escape hatch)
   *   card    {object}  { tag, title, body, buttons:[{label,kind:'go'|'stay',onClick}], backdrop }
   *   duration{number}  ms until auto fade-out+clear         default null (sticky)
   *   fadeMs  {number}  fade duration                        default 200
   *   onExpire{function} called after a duration-driven clear
   * @returns {{ setChip(text):void, clear():void }}
   */
  const show = (opts = {}) => {
    const {
      color = "#c0392b",
      fill = 0,
      border = 0,
      glow = false,
      breathe = false,
      chip = null,
      onChipClick = null,
      card = null,
      duration = null,
      fadeMs = 200,
      onExpire = null,
    } = opts;
    const reduced = reducedMotion();

    clearTimers();
    const bo = ensureContainer();
    bo.style.setProperty("--bo-fade", `${reduced ? 0 : fadeMs}ms`);
    bo.classList.toggle("bo-reduced", reduced);

    const layers = [];
    if (fill > 0 || border > 0 || glow) {
      const cls = `bo-vignette${breathe && !reduced ? " bo-breathe" : ""}`;
      const style = `background:${fill > 0 ? rgba(color, fill) : "transparent"};box-shadow:${insetShadow(color, border, glow)}`;
      layers.push(`<div class="${cls}" style="${style}"></div>`);
    }
    if (chip != null) {
      layers.push(
        `<div class="bo-chip${onChipClick ? " bo-chip-btn" : ""}" ${onChipClick ? 'role="button" tabindex="0"' : ""}>${escapeHtml(chip)}</div>`,
      );
    }
    if (card) {
      const corner = !!card.corner; // corner = non-blocking toast (no backdrop; page stays usable)
      if (card.backdrop && !corner) layers.push('<div class="bo-back"></div>');
      const kindClass = (k) => (k === "go" || k === "yes" ? k : "stay");
      const buttons = (card.buttons || [])
        .map(
          (b, i) =>
            `<button class="bo-btn bo-${kindClass(b.kind)}" data-i="${i}">${escapeHtml(b.label)}</button>`,
        )
        .join("");
      const checkbox = card.checkbox
        ? `<label class="bo-check"><input type="checkbox" class="bo-checkbox"${card.checkbox.checked ? " checked" : ""} /> ${escapeHtml(card.checkbox.label)}</label>`
        : "";
      const links = (card.links || [])
        .map((l, i) => `<button class="bo-link" data-li="${i}">${escapeHtml(l.label)}</button>`)
        .join("");
      layers.push(
        `<div class="${corner ? "bo-corner" : "bo-modal"}" role="dialog" aria-modal="${corner ? "false" : "true"}">` +
          `<div class="bo-tag">${escapeHtml(card.tag || "■ BRICK MODE")}</div>` +
          (card.title ? `<div class="bo-h">${escapeHtml(card.title)}</div>` : "") +
          (card.body ? `<p class="bo-reason">${escapeHtml(card.body)}</p>` : "") +
          checkbox +
          (buttons ? `<div class="bo-actions">${buttons}</div>` : "") +
          (links ? `<div class="bo-links">${links}</div>` : "") +
          "</div>",
      );
    }
    bo.innerHTML = layers.join("");

    if (onChipClick) {
      bo.querySelector(".bo-chip")?.addEventListener("click", onChipClick);
    }
    if (card) {
      // Button/link handlers receive a context with the checkbox state (for "remember").
      const ctx = () => ({ checked: !!bo.querySelector(".bo-checkbox")?.checked });
      bo.querySelectorAll(".bo-btn").forEach((el) => {
        const b = (card.buttons || [])[Number(el.dataset.i)];
        if (b && typeof b.onClick === "function") el.addEventListener("click", () => b.onClick(ctx()));
      });
      bo.querySelectorAll(".bo-link").forEach((el) => {
        const l = (card.links || [])[Number(el.dataset.li)];
        if (l && typeof l.onClick === "function") el.addEventListener("click", () => l.onClick(ctx()));
      });
    }

    // Fade in on the next frame so the opacity transition actually runs.
    requestAnimationFrame(() => bo.classList.add("bo-in"));

    if (typeof duration === "number" && duration > 0) {
      clearTimer = setTimeout(() => {
        const el = document.getElementById(ROOT_ID)?.querySelector(".bo");
        if (el) el.classList.remove("bo-in");
        clearTimer = setTimeout(() => {
          clear();
          if (typeof onExpire === "function") onExpire();
        }, reduced ? 0 : fadeMs);
      }, duration);
    }

    return {
      setChip: (text) => {
        const el = document.getElementById(ROOT_ID)?.querySelector(".bo-chip");
        if (el) el.textContent = text;
      },
      clear,
    };
  };

  window.BrickOverlay = { show, clear, reducedMotion };
})();
