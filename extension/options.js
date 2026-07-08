// BRICK MODE settings — service status, adjudicator model, and editable tier lists.
const $ = (id) => document.getElementById(id);
const lines = (id) =>
  $(id)
    .value.split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

// OpenRouter prices are per-token USD strings; show a readable per-1M-tokens figure.
function priceHint(m) {
  const p = Number(m.prompt);
  if (!Number.isFinite(p)) return "";
  if (p === 0) return " · free";
  return ` · $${(p * 1e6).toFixed(2)}/M in`;
}

function loadModels() {
  chrome.runtime.sendMessage({ type: "getModels" }, (res) => {
    const list = $("modelList");
    const hint = $("modelHint");
    if (!res || res.error || !Array.isArray(res.models) || res.models.length === 0) {
      // No catalog (e.g. no OpenRouter key) → the field still works as free-text.
      if (res && res.error) hint.textContent = `Model suggestions unavailable (${res.error}). You can still paste any model id.`;
      return;
    }
    list.innerHTML = "";
    for (const m of res.models) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.label = `${m.name}${priceHint(m)}`;
      list.appendChild(opt);
    }
    hint.textContent = `${res.models.length} tool-call-capable models. Click the field for the full list or type to filter; you can also paste any model id.`;
  });
}

function load() {
  chrome.runtime.sendMessage({ type: "getConfig" }, (cfg) => {
    const status = $("status");
    if (!cfg || cfg.error) {
      status.innerHTML =
        '<span class="bad">✗ service unreachable on 127.0.0.1:7373 — run <code>npm run serve</code></span>';
      return;
    }
    const key = cfg.hasApiKey
      ? '<span class="ok">key set</span>'
      : `<span class="warn">no ${cfg.provider || "provider"} API key — Tier-2 adjudication is stubbed (allow)</span>`;
    status.innerHTML = `<span class="ok">✓ connected</span> · ${cfg.provider || "?"} · model ${cfg.model} · ${key}`;
    $("model").value = cfg.model || "";
    $("tier1").value = ((cfg.tiers && cfg.tiers.tier1) || []).join("\n");
    $("tier3").value = ((cfg.tiers && cfg.tiers.tier3) || []).join("\n");
    const s = cfg.settings || {};
    $("pageScope").value = (s.pageScopeDomains || ["youtube.com"]).join("\n");
    $("rabbitDomains").value = (s.rabbitHoleDomains || ["youtube.com"]).join("\n");
    $("rabbitMins").value = String(s.rabbitHoleMinutes || 45);
    renderGatekeeper(cfg.decisions);
  });
}

function renderGatekeeper(d) {
  d = d || { total: 0, allow: 0, block: 0, clarify: 0, correction: 0 };
  $("gatekeeper").textContent = d.total
    ? `${d.total} learned · ${d.allow} allow / ${d.block} block · ${d.clarify} from clarify / ${d.correction} corrections`
    : "none learned yet";
}

function flash(id, text, ms = 2000) {
  $(id).textContent = text;
  setTimeout(() => ($(id).textContent = ""), ms);
}

$("saveModel").addEventListener("click", () => {
  chrome.runtime.sendMessage(
    { type: "saveSettings", settings: { model: $("model").value.trim() } },
    (res) => {
      if (!res || res.error) return flash("modelSaved", "save failed: " + ((res && res.error) || "unknown"), 3000);
      $("model").value = res.model || "";
      flash("modelSaved", `saved ✓ (now: ${res.model})`);
    },
  );
});

$("clearModel").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "saveSettings", settings: { model: "" } }, (res) => {
    if (!res || res.error) return flash("modelSaved", "reset failed: " + ((res && res.error) || "unknown"), 3000);
    $("model").value = res.model || "";
    flash("modelSaved", `using default ✓ (${res.model})`);
  });
});

// "Ask about BRICK" (Epic H3) — grounded usage Q&A over the service's /help route.
const helpHistory = []; // short in-page history: [{role, content}]

function helpAppend(role, text, sources) {
  const log = $("helpLog");
  log.style.display = "block";
  const div = document.createElement("div");
  div.style.margin = "0 0 10px";
  const who = document.createElement("div");
  who.className = "muted";
  who.textContent = role === "user" ? "you" : "brick";
  const body = document.createElement("div");
  body.style.whiteSpace = "pre-wrap";
  if (role === "assistant") body.style.color = "#d9e8dd";
  body.textContent = text;
  div.appendChild(who);
  div.appendChild(body);
  if (sources && sources.length) {
    const src = document.createElement("div");
    src.className = "muted";
    src.textContent = "sources: " + sources.join(" · ");
    div.appendChild(src);
  }
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

function askHelp() {
  const q = $("helpQ").value.trim();
  if (!q) return;
  $("helpQ").value = "";
  helpAppend("user", q);
  helpAppend("assistant", "…thinking");
  const placeholder = $("helpLog").lastChild;
  chrome.runtime.sendMessage({ type: "help", question: q, history: helpHistory.slice(-6) }, (res) => {
    placeholder.remove();
    if (!res || res.error) {
      helpAppend("assistant", "help unavailable: " + ((res && res.error) || "service unreachable"));
      return;
    }
    helpAppend("assistant", res.answer, res.sources);
    helpHistory.push({ role: "user", content: q }, { role: "assistant", content: res.answer });
  });
}

$("helpAsk").addEventListener("click", askHelp);
$("helpQ").addEventListener("keydown", (e) => {
  if (e.key === "Enter") askHelp();
});

// Session feedback (Epics S3 + F) — purely client-side; persisted to chrome.storage.local.
const FEEDBACK_DEFAULTS = { sound: false, border: true, borderSec: 10, maxGraceMin: 5 };

function loadFeedback() {
  chrome.storage.local.get("brickFeedback", ({ brickFeedback }) => {
    const fb = { ...FEEDBACK_DEFAULTS, ...(brickFeedback || {}) };
    $("fbBorder").checked = !!fb.border;
    $("fbSound").checked = !!fb.sound;
    $("fbBorderSec").value = String(fb.borderSec);
    $("fbMaxGrace").value = String(fb.maxGraceMin);
  });
}

$("saveFeedback").addEventListener("click", () => {
  const brickFeedback = {
    border: $("fbBorder").checked,
    sound: $("fbSound").checked,
    borderSec: Math.max(1, Math.min(60, Number($("fbBorderSec").value) || 10)),
    maxGraceMin: Math.max(1, Math.min(60, Number($("fbMaxGrace").value) || 5)),
  };
  chrome.storage.local.set({ brickFeedback }, () => {
    $("fbBorderSec").value = String(brickFeedback.borderSec);
    $("fbMaxGrace").value = String(brickFeedback.maxGraceMin);
    flash("fbSaved", "saved ✓");
  });
});

// The click is a user gesture that primes the audio path for later timer-fired playback — and lets
// you preview the cue. Plays even while the sound toggle is off.
$("testSound").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "testSound", cue: "work" }, (res) => {
    if (!res || res.error) return flash("fbSaved", "sound failed: " + ((res && res.error) || "unknown"), 3000);
    flash("fbSaved", "♪ played the focus tone");
    setTimeout(() => chrome.runtime.sendMessage({ type: "testSound", cue: "break" }, () => {
      flash("fbSaved", "♪ …and the break twinkle");
    }), 1200);
  });
});

$("saveTuning").addEventListener("click", () => {
  const settings = {
    pageScopeDomains: lines("pageScope"),
    rabbitHoleDomains: lines("rabbitDomains"),
    rabbitHoleMinutes: Number($("rabbitMins").value) || 45,
  };
  chrome.runtime.sendMessage({ type: "saveSettings", settings }, (res) => {
    if (!res || res.error) return flash("tuningSaved", "save failed: " + ((res && res.error) || "unknown"), 3000);
    flash("tuningSaved", "saved ✓");
  });
});

$("clearDecisions").addEventListener("click", () => {
  if (!confirm("Clear all learned allow/block decisions (clarify answers + corrections)?")) return;
  chrome.runtime.sendMessage({ type: "clearDecisions" }, (res) => {
    if (!res || res.error) return flash("gkSaved", "clear failed: " + ((res && res.error) || "unknown"), 3000);
    renderGatekeeper(res.counts);
    flash("gkSaved", "cleared ✓");
  });
});

$("save").addEventListener("click", () => {
  chrome.runtime.sendMessage(
    { type: "saveTiers", tier1: lines("tier1"), tier3: lines("tier3") },
    (res) => {
      if (!res || res.error) {
        $("saved").textContent = "save failed: " + ((res && res.error) || "unknown");
        return;
      }
      $("tier1").value = ((res.tiers && res.tiers.tier1) || []).join("\n");
      $("tier3").value = ((res.tiers && res.tiers.tier3) || []).join("\n");
      flash("saved", "saved ✓");
    },
  );
});

$("reset").addEventListener("click", () => {
  if (!confirm("Reset tier lists to built-in defaults? This removes any custom changes.")) return;
  chrome.runtime.sendMessage({ type: "resetTiers" }, (res) => {
    if (!res || res.error) {
      $("saved").textContent = "reset failed: " + ((res && res.error) || "unknown");
      return;
    }
    $("tier1").value = ((res.tiers && res.tiers.tier1) || []).join("\n");
    $("tier3").value = ((res.tiers && res.tiers.tier3) || []).join("\n");
    flash("saved", "reset to defaults ✓", 2500);
  });
});

load();
loadModels();
loadFeedback();
