// holon/frontend/js/boot.js — applied before first paint to avoid a theme flash.

// Optional bearer auth: attach the stored token to every API call; on the
// first 401, ask for the token once and retry.
const _fetch = window.fetch.bind(window);
window.fetch = async (url, opts = {}) => {
  const u = String(url);
  const t = localStorage.getItem("holon_token");
  if (t && u.startsWith("/api/")) opts.headers = { ...(opts.headers || {}), Authorization: `Bearer ${t}` };
  const r = await _fetch(url, opts);
  if (r.status === 401 && u.startsWith("/api/")) {
    const entered = window.prompt("Holon access token:");
    if (entered) { localStorage.setItem("holon_token", entered.trim()); location.reload(); }
  }
  return r;
};

(function () {
  try {
    // Deep-linkable theme (?theme=dark|light) — handy for demos + screenshots.
    var m = location.search.match(/[?&]theme=(dark|light)\b/);
    if (m) localStorage.setItem("holon-theme", m[1]);
    var t = localStorage.getItem("holon-theme");
    if (!t) t = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    document.documentElement.dataset.theme = t;
  } catch (e) {}
})();
