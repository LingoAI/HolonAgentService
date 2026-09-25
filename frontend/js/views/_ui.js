// holon/frontend/js/views/_ui.js — tiny shared view helpers.
export const loadingHTML = `<div class="empty-state"><div class="spin"></div><div>Loading…</div></div>`;
export function emptyState(msg, icon = "○") {
  return `<div class="empty-state"><div class="es-ic">${icon}</div><div>${msg}</div></div>`;
}
