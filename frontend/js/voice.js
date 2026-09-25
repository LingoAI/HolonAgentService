// Tap mic to record; tap again to stop → POST to /api/voice → callback with English text.
import { api } from "/js/api.js";
export function wireMic(btn, onText) {
  let rec = null, chunks = [], on = false;
  btn.onclick = async () => {
    if (!on) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        rec = new MediaRecorder(stream); chunks = [];
        rec.ondataavailable = e => chunks.push(e.data);
        rec.onstop = async () => {
          stream.getTracks().forEach(t => t.stop());
          btn.textContent = "⏳";
          const blob = new Blob(chunks, { type: "audio/webm" });
          const r = await api.voice(blob);
          btn.textContent = "🎤"; btn.classList.remove("on");
          if (r.text) onText(r.text);
        };
        rec.start(); on = true; btn.textContent = "⏹"; btn.classList.add("on");
      } catch (e) { alert("Mic access denied or unavailable."); }
    } else { on = false; rec && rec.stop(); }
  };
}

// Ambient mode: continuously record short N-second chunks, transcribe each via
// /api/voice, and emit any text via onText — until toggled off. Reuses the same
// single-shot /api/voice flow, just on a loop. Returns a controller so the
// caller can start/stop and reflect a "listening…" state.
export function wireAmbient(btn, onText, { chunkMs = 4500 } = {}) {
  let stream = null, active = false, rec = null, looping = false;

  async function loopOnce() {
    if (!active) return;
    const chunks = [];
    rec = new MediaRecorder(stream);
    rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = async () => {
      if (chunks.length) {
        try {
          const r = await api.voice(new Blob(chunks, { type: "audio/webm" }));
          if (active && r && r.text && r.text.trim()) onText(r.text.trim());
        } catch (e) { /* skip this chunk on transport error */ }
      }
      if (active) loopOnce();            // immediately start the next segment
      else { looping = false; }
    };
    rec.start();
    setTimeout(() => { if (rec && rec.state === "recording") rec.stop(); }, chunkMs);
  }

  async function start() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) { alert("Mic access denied or unavailable."); return; }
    active = true; looping = true;
    btn.classList.add("on"); btn.textContent = "🛑";
    btn.title = "stop listening";
    loopOnce();
  }

  function stop() {
    active = false;
    btn.classList.remove("on"); btn.textContent = "👂";
    btn.title = "ambient listen";
    try { rec && rec.state === "recording" && rec.stop(); } catch (e) {}
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  }

  btn.textContent = "👂"; btn.title = "ambient listen";
  btn.onclick = () => { active ? stop() : start(); };
  return { stop };
}
