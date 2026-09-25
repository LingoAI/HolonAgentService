// Shared UI primitives — dependency-free. Material-3, tokenized, reduced-motion safe.
import { esc } from "/js/api.js";

// --- toast -----------------------------------------------------------------
// toast(msg, {action, onAction, actionHint, icon}) -> { dismiss() }
// Single bottom-right element; slides in, auto-dismisses, exits to the left.
export function toast(msg, opts = {}) {
  const { action, onAction, actionHint, icon } = opts;
  let t = document.getElementById("toast");
  if (t) { t.remove(); }            // replace any in-flight toast
  t = document.createElement("div");
  t.id = "toast";
  t.className = "toast";
  t.setAttribute("role", "status");
  t.innerHTML =
    (icon ? `<span class="toast-ic">${esc(icon)}</span>` : "") +
    `<span class="toast-msg">${esc(msg)}</span>` +
    (action ? `<button class="toast-action" type="button">${esc(action)}` +
      (actionHint ? `<span class="toast-hint">${esc(actionHint)}</span>` : "") +
      `</button>` : "");
  document.body.appendChild(t);

  let done = false;
  let timer = null;
  function dismiss() {
    if (done) return;
    done = true;
    if (timer) clearTimeout(timer);
    t.classList.remove("show");
    t.classList.add("exiting");
    t.addEventListener("transitionend", () => t.remove(), { once: true });
    setTimeout(() => t.remove(), 600);   // fallback if transitionend never fires
  }
  if (action && onAction) {
    t.querySelector(".toast-action").addEventListener("click", () => {
      try { onAction(); } finally { dismiss(); }
    });
  }
  requestAnimationFrame(() => requestAnimationFrame(() => t.classList.add("show")));
  timer = setTimeout(dismiss, action ? 8000 : 5000);
  return { dismiss };
}

// --- focus-trapped modal scaffold ------------------------------------------
// Exported so callers needing a custom action set (e.g. a 3-choice onboarding
// dialog) can reuse the same overlay/focus-trap/esc idioms as styledConfirm.
export function trapModal(boxHTML, wire) {
  return new Promise(resolve => {
    const prevFocus = document.activeElement;
    const overlay = document.createElement("div");
    overlay.className = "ui-modal";
    overlay.innerHTML = `<div class="ui-modal-box" role="dialog" aria-modal="true">${boxHTML}</div>`;
    document.body.appendChild(overlay);

    let settled = false;
    function close(value) {
      if (settled) return;
      settled = true;
      overlay.classList.remove("show");
      overlay.addEventListener("transitionend", () => overlay.remove(), { once: true });
      setTimeout(() => overlay.remove(), 400);
      document.removeEventListener("keydown", onKey, true);
      try { if (prevFocus && prevFocus.focus) prevFocus.focus(); } catch (e) {}
      resolve(value);
    }
    const focusables = () => Array.from(overlay.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'))
      .filter(n => !n.disabled && n.offsetParent !== null);
    function onKey(e) {
      if (e.key === "Tab") {
        const f = focusables();
        if (!f.length) { e.preventDefault(); return; }
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    }
    document.addEventListener("keydown", onKey, true);
    overlay.addEventListener("mousedown", e => { if (e.target === overlay) close(undefined); });

    wire(overlay, close);
    requestAnimationFrame(() => requestAnimationFrame(() => overlay.classList.add("show")));
  });
}

// styledConfirm(message, {danger}) -> Promise<bool>
export function styledConfirm(message, { danger } = {}) {
  return trapModal(
    `<p class="ui-modal-msg">${esc(message)}</p>
     <div class="ui-modal-actions">
       <button class="btn text" data-act="cancel" type="button">Cancel</button>
       <button class="btn${danger ? " danger" : ""}" data-act="ok" type="button">OK</button>
     </div>`,
    (overlay, close) => {
      overlay.querySelector('[data-act="cancel"]').onclick = () => close(false);
      overlay.querySelector('[data-act="ok"]').onclick = () => close(true);
      overlay.addEventListener("keydown", e => {
        if (e.key === "Escape") { e.preventDefault(); close(false); }
        else if (e.key === "Enter") { e.preventDefault(); close(true); }
      });
      overlay.querySelector('[data-act="ok"]').focus();
    }).then(v => v === true);
}

// styledPrompt(message, {value, placeholder}) -> Promise<string|null>
export function styledPrompt(message, { value = "", placeholder = "" } = {}) {
  return trapModal(
    `<p class="ui-modal-msg">${esc(message)}</p>
     <input class="field ui-modal-input" data-act="input" type="text"
       value="${esc(value)}" placeholder="${esc(placeholder)}">
     <div class="ui-modal-actions">
       <button class="btn text" data-act="cancel" type="button">Cancel</button>
       <button class="btn" data-act="ok" type="button">OK</button>
     </div>`,
    (overlay, close) => {
      const input = overlay.querySelector('[data-act="input"]');
      overlay.querySelector('[data-act="cancel"]').onclick = () => close(null);
      overlay.querySelector('[data-act="ok"]').onclick = () => close(input.value);
      overlay.addEventListener("keydown", e => {
        if (e.key === "Escape") { e.preventDefault(); close(null); }
      });
      input.addEventListener("keydown", e => {
        if (e.key === "Enter") { e.preventDefault(); close(input.value); }
      });
      input.focus(); input.select();
    }).then(v => (v === undefined ? null : v));
}

// --- command palette (Ctrl/Cmd+K) ------------------------------------------
// items = [{label, hint, run}]. Prefix matches beat substring matches.
function fuzzyScore(label, q) {
  if (!q) return { score: 1, ranges: [] };
  const L = label.toLowerCase(), Q = q.toLowerCase();
  const idx = L.indexOf(Q);
  if (idx === 0) return { score: 1000 - label.length, ranges: [[0, Q.length]] };
  if (idx > 0) return { score: 500 - idx, ranges: [[idx, idx + Q.length]] };
  return null;   // no contiguous match
}
function markLabel(label, ranges) {
  if (!ranges || !ranges.length) return esc(label);
  const [s, e] = ranges[0];
  return esc(label.slice(0, s)) + "<mark>" + esc(label.slice(s, e)) + "</mark>" + esc(label.slice(e));
}

export function openPalette(items) {
  const prevFocus = document.activeElement;
  const overlay = document.createElement("div");
  overlay.className = "cmdk";
  overlay.innerHTML =
    `<div class="cmdk-box" role="dialog" aria-modal="true">
       <input class="cmdk-input" type="text" placeholder="Type a command…" aria-label="Command palette">
       <div class="cmdk-list" role="listbox"></div>
     </div>`;
  document.body.appendChild(overlay);
  const input = overlay.querySelector(".cmdk-input");
  const list = overlay.querySelector(".cmdk-list");

  let filtered = [];
  let sel = 0;
  let debounce = null;

  function close() {
    overlay.classList.remove("show");
    overlay.addEventListener("transitionend", () => overlay.remove(), { once: true });
    setTimeout(() => overlay.remove(), 400);
    try { if (prevFocus && prevFocus.focus) prevFocus.focus(); } catch (e) {}
  }
  function render() {
    const q = input.value.trim();
    filtered = items
      .map(it => { const m = fuzzyScore(it.label, q); return m ? { it, ...m } : null; })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);
    sel = 0;
    if (!filtered.length) { list.innerHTML = `<div class="cmdk-empty">No matches</div>`; return; }
    list.innerHTML = filtered.map((f, i) =>
      `<div class="cmdk-item${i === 0 ? " sel" : ""}" role="option" data-i="${i}">
         <span class="cmdk-label">${markLabel(f.it.label, f.ranges)}</span>
         ${f.it.hint ? `<span class="cmdk-hint">${esc(f.it.hint)}</span>` : ""}
       </div>`).join("");
    list.querySelectorAll(".cmdk-item").forEach(node => {
      node.addEventListener("mouseenter", () => setSel(+node.dataset.i));
      node.addEventListener("click", () => choose(+node.dataset.i));
    });
  }
  function setSel(i) {
    sel = i;
    list.querySelectorAll(".cmdk-item").forEach((n, idx) => n.classList.toggle("sel", idx === sel));
    const node = list.querySelector(".cmdk-item.sel");
    if (node) node.scrollIntoView({ block: "nearest" });
  }
  function choose(i) {
    const f = filtered[i];
    if (!f) return;
    close();
    try { f.it.run(); } catch (e) {}
  }
  input.addEventListener("input", () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(render, 90);
  });
  overlay.addEventListener("keydown", e => {
    if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); if (filtered.length) setSel((sel + 1) % filtered.length); }
    else if (e.key === "ArrowUp") { e.preventDefault(); if (filtered.length) setSel((sel - 1 + filtered.length) % filtered.length); }
    else if (e.key === "Enter") { e.preventDefault(); choose(sel); }
  });
  overlay.addEventListener("mousedown", e => { if (e.target === overlay) close(); });

  render();
  requestAnimationFrame(() => requestAnimationFrame(() => { overlay.classList.add("show"); input.focus(); }));
}

// registerPalette(getItems) — binds the global Ctrl/Cmd+K to open the palette.
// Call once. getItems() is invoked fresh on each open so commands stay current.
let paletteBound = false;
export function registerPalette(getItems) {
  if (paletteBound) return;
  paletteBound = true;
  document.addEventListener("keydown", e => {
    if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
      e.preventDefault();
      if (document.querySelector(".cmdk")) return;   // already open
      openPalette(getItems() || []);
    }
  });
}
