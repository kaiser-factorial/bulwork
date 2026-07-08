// BRICK MODE popup — focus picker (no session) / live timer (active session).
const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

let tick = null;

function fmt(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

async function render() {
  const st = await send({ type: "getState" });
  const active = st && st.session;

  $("picker").classList.toggle("hidden", !!active);
  $("active").classList.toggle("hidden", !active);
  if (tick) {
    clearInterval(tick);
    tick = null;
  }

  if (active) {
    $("phase").textContent = st.phase === "break" ? "break — restrictions lifted" : "work";
    $("afocus").textContent = st.session.focus.task;
    $("stats").textContent = `${st.session.adjudications} checks · ${st.session.blocks} blocked`;
    const update = () => {
      $("timer").textContent = fmt((st.phaseEndsAt ?? Date.now()) - Date.now());
    };
    update();
    tick = setInterval(update, 1000);
  } else {
    await loadProjects();
  }
}

async function loadProjects() {
  const sel = $("project");
  sel.innerHTML = '<option value="__last__">— most recently touched —</option>';
  try {
    const { projects } = await send({ type: "getProjects" });
    for (const p of projects ?? []) {
      const o = document.createElement("option");
      o.value = p.id;
      o.textContent = p.nextAction ? `${p.name} — ${p.nextAction}` : p.name;
      sel.appendChild(o);
    }
  } catch {
    $("warn").textContent = "brick service not reachable on :7373 — run `npm run serve`.";
  }
}

$("start").addEventListener("click", async () => {
  const task = $("task").value.trim();
  const project = $("project").value;
  const opts = {
    workMinutes: Number($("work").value) || 25,
    breakMinutes: Number($("break").value) || 5,
  };
  if (task) opts.task = task;
  else if (project === "__last__") opts.last = true;
  else opts.projectId = project;

  const res = await send({ type: "startSession", opts });
  if (res && res.error) {
    $("warn").textContent = res.error;
    return;
  }
  render();
});

$("stop").addEventListener("click", async () => {
  await send({ type: "stopSession" });
  render();
});

// Honesty lever (Epic 0.5): correct the verdict for the current tab under the active focus.
async function mark(decision) {
  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch {
    /* no tabs permission / no window */
  }
  if (!tab || !tab.url) {
    $("markStatus").textContent = "no active tab to mark";
    return;
  }
  const res = await send({ type: "markPage", tabId: tab.id, url: tab.url, decision });
  if (res && res.error) {
    $("markStatus").textContent = "failed: " + res.error;
    return;
  }
  $("markStatus").textContent = decision === "block" ? "marked off-task ✓" : "marked on-topic ✓";
  setTimeout(() => window.close(), 800);
}

$("offtask").addEventListener("click", () => mark("block"));
$("ontopic").addEventListener("click", () => mark("allow"));

render();
