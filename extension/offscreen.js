// BULWORK MODE — offscreen audio (Epic S2). Synthesizes the two session cues with WebAudio instead of
// bundled clips (no binary assets, tunable in code): a low "focus" tone entering work, a light
// twinkle entering break. Only this single offscreen document ever plays sound — the phase broadcast
// reaches every tab, but the worker routes audio here exactly once per transition.
(() => {
  let ctx = null;
  const audio = () => {
    if (!ctx) ctx = new AudioContext();
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    return ctx;
  };

  // One enveloped sine note. Gentle attack/decay — cues, not alarms.
  const note = (ac, freq, at, dur, peak) => {
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(peak, at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    osc.connect(gain).connect(ac.destination);
    osc.start(at);
    osc.stop(at + dur + 0.05);
  };

  const CUES = {
    // Entering work: a low, grounded two-note descent — "settle in".
    work: (ac, t) => {
      note(ac, 330, t, 0.45, 0.22);
      note(ac, 220, t + 0.18, 0.6, 0.25);
    },
    // Entering break: a light ascending twinkle — "come up for air".
    break: (ac, t) => {
      note(ac, 660, t, 0.22, 0.16);
      note(ac, 880, t + 0.12, 0.22, 0.16);
      note(ac, 1320, t + 0.24, 0.35, 0.14);
    },
  };

  const play = (cue) => {
    const fn = CUES[cue];
    if (!fn) return;
    try {
      const ac = audio();
      fn(ac, ac.currentTime + 0.02);
    } catch {
      /* audio unavailable — cue is best-effort */
    }
  };

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "brick:play") play(msg.cue);
  });
})();
