import { api, esc } from "/js/api.js";
import { streamChat } from "/js/stream.js";
import { toast as uiToast } from "/js/ui.js";

// Starter prompts surfaced in the empty state (Gemini-style suggestion chips).
const CHIPS = [
  ["What am I working on?", "💼"],
  ["What meds am I on and who prescribed them?", "💊"],
  ["Where do I live?", "📍"],
  ["Summarize my latest document", "📄"],
];
let built = false;
let context = null;
let contextKey = null;
let checking = null;
let sending = false;
const PUBLIC_CHIPS = [
  ["Compare the agents", "↗"],
  ["How do I verify a completed job?", "✓"],
  ["What can this marketplace assistant do?", "◐"],
];

let controller = null;
if (window.DOMPurify) {
  DOMPurify.addHook("afterSanitizeAttributes", n => {
    if (n.tagName === "A" && /^https?:/i.test(n.getAttribute("href") || "")) {
      n.setAttribute("target", "_blank");
      n.setAttribute("rel", "noopener noreferrer");
    }
  });
}
function maybeScroll() {
  const l = log();
  if (!l) return;
  const diff = (l.scrollHeight - l.clientHeight) - l.scrollTop;
  if (diff < 300) l.scrollTop = l.scrollHeight;   // only follow if user is near the bottom
}

const SEND_SVG = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3.4 20.4l17.45-7.48a1 1 0 0 0 0-1.84L3.4 3.6a.993.993 0 0 0-1.39.91L2 9.12c0 .5.37.93.87.99L17 12 2.87 13.88c-.5.07-.87.5-.87 1l.01 4.61c0 .71.73 1.2 1.39.91z"/></svg>';

export async function renderChat(el) {
  if (!built) {
    el.innerHTML = `
      <div class="chat-context" id="chatContext" role="status">Checking chat availability…</div>
      <div class="chat-log" id="chatLog" aria-label="Conversation"></div>
      <div class="composer" id="composer" aria-busy="false">
        <textarea id="chatInput" class="composer-input" rows="1" disabled
          placeholder="Checking chat availability…" aria-label="Message Holon" aria-describedby="chatContext"></textarea>
        <div class="composer-actions">
          <button class="icon-btn" id="micBtn" title="speak" aria-label="Voice input" hidden>🎤</button>
          <button class="icon-btn" id="ambientBtn" title="ambient listen" aria-label="Ambient listening" hidden>👂</button>
          <button class="btn send-btn" id="sendBtn" title="Send" aria-label="Send" disabled>${SEND_SVG}</button>
        </div>
      </div>`;
    el.querySelector("#sendBtn").onclick = () => sending ? controller?.abort() : send(el.querySelector("#chatInput").value);
    const input = el.querySelector("#chatInput");
    input.addEventListener("input", () => {
      input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 180) + "px";
    });
    input.addEventListener("keydown", e => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault(); if (!sending) send(e.target.value);
      }
    });
    // Voice is a personal-twin feature (local transcription); it stays hidden
    // on the public marketplace assistant and when the module is unavailable.
    try {
      const { wireMic, wireAmbient } = await import("/js/voice.js");
      wireMic(el.querySelector("#micBtn"), txt => send(txt));
      wireAmbient(el.querySelector("#ambientBtn"), txt => send(txt));
    } catch { /* voice is optional */ }
    built = true;
  }
  // Recheck whenever the user returns: an account change must clear the old view.
  await refreshContext();
  const pending = sessionStorage.getItem("holon_pending_ask");
  if (pending) {
    sessionStorage.removeItem("holon_pending_ask");
    const input = document.getElementById("chatInput");
    if (input) input.value = pending;
    if (context?.enabled) send(pending);
  }
}

function log() { return document.getElementById("chatLog"); }
async function resolveContext() {
  const st = await api.status();
  if (!st || typeof st.readonly !== "boolean") throw new Error("status unavailable");
  if (st.readonly) {
    return { key: "public-readonly", public: true, enabled: false, history: [],
      note: "Chat is unavailable on this read-only marketplace." };
  }
  const history = await api.history();
  if (!Array.isArray(history)) throw new Error("history unavailable");
  const configured = st.local ? st.ollama_up === true : st.provider_configured === true;
  return { key: "personal", public: false, enabled: configured, url: "/api/chat", history,
    note: configured ? "Personal Holon · ask about your saved knowledge. Cloud processing follows your privacy settings."
      : "The selected model is unavailable or has not been configured. Choose an available model, then check again." };
}
async function refreshContext() {
  if (checking) return checking;
  checking = (async () => {
    setSendMode(sending ? "sending" : "checking");
    try {
      const next = await resolveContext();
      if (contextKey !== next.key) {
        controller?.abort();
        log().replaceChildren();
        const input = document.getElementById("chatInput");
        if (contextKey !== null && input) input.value = "";
        next.history.forEach(m => addBubble(m.role, m.content));
        contextKey = next.key;
      }
      context = next;
      for (const id of ["micBtn", "ambientBtn"]) {
        const b = document.getElementById(id);
        if (b) b.hidden = !(next.enabled && !next.public);
      }
      const notice = document.getElementById("chatContext");
      notice.textContent = next.note;
      if (!next.enabled) {
        if (next.key === "public-readonly") {
          const link = document.createElement("a"); link.href = "#marketplace/jobs";
          link.textContent = "Browse tasks"; notice.append(" ", link);
        }
        const retry = document.createElement("button"); retry.className = "btn text";
        retry.textContent = "Check again"; retry.onclick = () => refreshContext(); notice.append(" ", retry);
      }
      if (!log().children.length) emptyHint();
      return next;
    } catch {
      controller?.abort();
      context = null; contextKey = null;
      log().replaceChildren(); // Never retain another account's transcript on a failed session check.
      const notice = document.getElementById("chatContext");
      notice.textContent = "We could not check your session or load your conversation. Your draft is kept here.";
      const retry = document.createElement("button"); retry.className = "btn text";
      retry.textContent = "Try again"; retry.onclick = () => refreshContext(); notice.append(" ", retry);
      return null;
    } finally { checking = null; setSendMode(sending ? "sending" : null); }
  })();
  return checking;
}
function emptyHint() {
  const l = log();
  if (!l || !context) return;
  const pub = context.public;
  l.innerHTML = `
    <div class="chat-empty">
      <div class="mark" aria-hidden="true">◐</div>
      <h2>${pub ? "Find your next useful agent" : "Make sense of what you know"}</h2>
      <p>${pub ? "Explore the agents, understand their limits, and follow the evidence behind a job."
        : "Ask a question about your saved knowledge, or share a fact you want to remember."}</p>
      ${context.enabled ? `<div class="suggestions" id="chatChips">
        ${(pub ? PUBLIC_CHIPS : CHIPS).map(([c, ic]) => `<button class="suggestion" data-q="${esc(c)}"><span class="si" aria-hidden="true">${ic}</span>${c}</button>`).join("")}
      </div>` : '<a class="btn text" href="#marketplace">Browse agents</a>'}
    </div>`;
  l.querySelectorAll("#chatChips .suggestion").forEach(b => { b.onclick = () => send(b.dataset.q); });
}
function renderMd(text) {
  try {
    const html = window.marked ? marked.parse(text, { breaks: true }) : text;
    return window.DOMPurify ? DOMPurify.sanitize(html) : esc(text);
  } catch (e) { return esc(text); }
}
function addBubble(role, text) {
  const l = log();
  if (!l) return null;
  const empty = l.querySelector(".chat-empty");
  if (empty) empty.remove();
  const me = role === "user";
  const row = document.createElement("div");
  row.className = "row " + (me ? "me" : "ai");
  if (!me) {
    const av = document.createElement("div");
    av.className = "avatar";
    av.textContent = "◐";
    row.appendChild(av);
  }
  const b = document.createElement("div");
  b.className = "bubble " + (me ? "" : "md");
  if (me) b.textContent = text; else b.innerHTML = renderMd(text);
  row.appendChild(b);
  l.appendChild(row);
  maybeScroll();
  return b;
}
function announce(msg) { const el = document.getElementById("sr-live"); if (el) el.textContent = msg; }
function toast(fact) {
  const l = log();
  if (!l) return;
  const t = document.createElement("div");
  t.className = "fact-line";
  t.textContent = `✦ added to your ontology: ${fact.subject} ${fact.predicate} ${fact.object}`;
  l.appendChild(t); maybeScroll();
  announce(`Added to ontology: ${fact.subject} ${fact.predicate} ${fact.object}`);
  // Pop an app-wide toast so ontology growth is felt outside the chat log too.
  uiToast(`✦ ${fact.subject} ${fact.predicate} ${fact.object}`, { icon: "✦" });
  window.dispatchEvent(new CustomEvent("holon:fact", { detail: fact }));  // grow the graph live
}

// A small pill above the assistant bubble showing which tier handled the turn.
function routePill(bubble, decision) {
  const tier = decision.tier === "cloud" ? "Cloud" : "Local";
  const icon = decision.auto ? "⚡" : (decision.tier === "cloud" ? "☁️" : "🔒");
  const pill = document.createElement("div");
  pill.className = "route-pill";
  const verb = decision.auto ? "routed to" : "using";
  // what the PrivacyGateway held back before the turn left for the cloud —
  // counts only; the values never leave and are never shown here either
  const p = decision.privacy;
  const guard = p && p.enabled
    ? (p.total ? ` · 🛡 ${p.total} personal detail${p.total === 1 ? "" : "s"} redacted before the cloud`
               : " · no matching details detected; redaction may be incomplete")
    : "";
  pill.textContent = `${icon} ${verb} ${tier} · ${decision.reason}${guard}`;
  bubble.parentNode.insertBefore(pill, bubble);
  if (decision.context_note) {
    const note = document.createElement("p"); note.className = "chat-context-note";
    note.textContent = decision.context_note; bubble.parentNode.insertBefore(note, bubble);
  }
  maybeScroll();
}

// A collapsible "How I know this" trace listing the multi-hop chains.
function pathsTrace(bubble, chains) {
  if (!chains || !chains.length) return;
  const det = document.createElement("details");
  det.className = "paths-trace";
  const items = chains.map(c => `<li style="margin:2px 0">${esc(c)}</li>`).join("");
  det.innerHTML = `<summary>🧭 How I know this</summary><ul>${items}</ul>`;
  bubble.parentNode.insertBefore(det, bubble.nextSibling);
  maybeScroll();
}

function setSendMode(mode) {
  const button = document.getElementById("sendBtn"), input = document.getElementById("chatInput");
  if (!button || !input) return;
  const busy = mode === "sending";
  button.innerHTML = busy ? '<span aria-hidden="true">■</span>' : SEND_SVG;
  button.setAttribute("aria-label", busy ? "Stop reply" : "Send");
  button.title = busy ? "Stop reply" : "Send";
  button.disabled = !busy && (mode === "checking" || !context?.enabled);
  input.disabled = mode === "checking" || !context?.enabled;
  input.placeholder = context?.enabled ? (context.public ? "Ask about agents or evidence…" : "Ask your Holon…") : "Chat is unavailable — see the message above";
  document.getElementById("composer").setAttribute("aria-busy", String(busy));
  if (busy) button.dataset.mode = "sending"; else delete button.dataset.mode;
}
function errorMessage(error) {
  const code = String(error);
  if (code === "HTTP 401") return "Your session has expired. Sign in again to continue.";
  if (code === "HTTP 403") return "This session cannot use chat here. Check your sign-in and try again.";
  if (code === "HTTP 503") return "The assistant is temporarily unavailable. Please try again later.";
  if (code === "HTTP 429") return "The message limit has been reached. Please try again later.";
  return code;
}
async function send(text, retryBubble = null) {
  text = (text || "").trim();
  if (!text || sending || !context?.enabled) return;
  sending = true;
  const session = context.key;
  controller = new AbortController();
  const activeController = controller;
  setSendMode("sending");
  const input = document.getElementById("chatInput");
  if (input && input.value.trim() === text) { input.value = ""; input.style.height = "auto"; }
  if (!retryBubble) addBubble("user", text);
  const bubble = retryBubble || addBubble("assistant", "");
  const row = bubble.parentNode;
  row.querySelectorAll(".chat-recovery, .route-pill, .chat-context-note, .paths-trace").forEach(n => n.remove());
  row.dataset.state = "streaming";
  bubble.innerHTML = '<div class="typing" aria-label="Waiting for reply"><span></span><span></span><span></span></div>';
  let acc = "", failure = null;
  try {
    const result = await streamChat(text, {
      url: context.url, signal: activeController.signal,
      onRoute: d => routePill(bubble, d),
      onToken: t => { acc += t; bubble.innerHTML = renderMd(acc); maybeScroll(); },
      onFact: toast, onPaths: chains => pathsTrace(bubble, chains),
      onError: e => { failure = errorMessage(e); },
    });
    if (contextKey !== session) return;
    if (result.status === "done" && acc.trim()) {
      row.dataset.state = "complete"; announce("Reply ready");
    } else {
      const stopped = result.status === "aborted";
      row.dataset.state = stopped ? "stopped" : "error";
      bubble.innerHTML = renderMd(acc);
      const recovery = document.createElement("div"); recovery.className = "chat-recovery"; recovery.setAttribute("role", "status");
      const message = stopped ? "Reply stopped. Any partial text is shown above; it may not be saved."
        : `${failure || "No complete reply was received. Please retry."}${acc ? " Partial answer shown above." : ""}`;
      recovery.textContent = message;
      const retry = document.createElement("button"); retry.className = "btn text";
      retry.textContent = "Retry message";
      retry.onclick = async () => {
        if (sending) return;
        const current = await refreshContext();
        if (current?.enabled && current.key === session) send(text, bubble);
      };
      recovery.append(" ", retry); row.append(recovery); announce(message);
    }
  } catch {
    row.dataset.state = "error"; bubble.textContent = acc || "The reply could not be displayed. Your message is back in the composer.";
    if (input && !input.value) input.value = text;
  } finally {
    if (controller === activeController) { sending = false; controller = null; setSendMode(null); }
  }
}
