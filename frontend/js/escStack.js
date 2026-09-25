// holon/frontend/js/escStack.js — LIFO registry of dismissable overlays.
const stack = [];
addEventListener("keydown", e => {
  if (e.key === "Escape" && stack.length) { e.preventDefault(); stack.pop().close(); }
});
export function openDismissable(el, onClose) {
  const entry = {
    close() {
      const i = stack.indexOf(entry); if (i >= 0) stack.splice(i, 1);
      document.removeEventListener("mousedown", outside, true);
      el.remove(); onClose && onClose();
    },
  };
  function outside(e) { if (!el.contains(e.target)) entry.close(); }
  setTimeout(() => document.addEventListener("mousedown", outside, true), 0);
  stack.push(entry);
  return entry;
}
