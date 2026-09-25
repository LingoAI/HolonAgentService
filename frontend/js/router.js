// Sidebar navigation — primary group mirrors the product design's order;
// secondary group keeps every other screen reachable. `anchor` items route to
// the dashboard and scroll to the named section instead of switching views.
const I = {
  holon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3" fill="currentColor"/><circle cx="12" cy="12" r="8.5"/></svg>',
  data: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3"/></svg>',
  market: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 7l2-4h12l2 4M4 7h16M4 7v13h16V7M9 11h6"/></svg>',
  assets: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 2l8 5v10l-8 5-8-5V7z"/><path d="M12 2v20M4 7l16 10M20 7L4 17" opacity=".35"/></svg>',
  stake: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="8.5"/><path d="M12 7v10M9.5 9.5h3.8a1.8 1.8 0 1 1 0 3.6H10a1.8 1.8 0 1 0 0 3.6h4.5"/></svg>',
  earn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 17l5-6 4 4 7-8"/><path d="M15 7h5v5"/></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.5 4.5l2.1 2.1M17.4 17.4l2.1 2.1M4.5 19.5l2.1-2.1M17.4 6.6l2.1-2.1"/></svg>',
  chat: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 4h16v12H6l-2 2V4z"/></svg>',
  onto: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2.4"/><circle cx="5" cy="18" r="2.4"/><circle cx="19" cy="18" r="2.4"/><path d="M12 7v4M11 12l-5 4M13 12l5 4" stroke="currentColor" stroke-width="1.6" fill="none"/></svg>',
  memory: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3a6 6 0 0 0-6 6c0 4 6 9 6 9s6-5 6-9a6 6 0 0 0-6-6z"/></svg>',
  road: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 18l5-12 6 12 5-9"/></svg>',
  verify: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 2.8l7 2.6v6c0 4.4-3 8.1-7 9.8-4-1.7-7-5.4-7-9.8v-6z"/><path d="M8.6 12.1l2.4 2.4 4.4-4.6"/></svg>',
  cats: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3.6" y="3.6" width="7" height="7" rx="2"/><rect x="13.4" y="3.6" width="7" height="7" rx="2"/><rect x="3.6" y="13.4" width="7" height="7" rx="2"/><rect x="13.4" y="13.4" width="7" height="7" rx="2"/></svg>',
  compare: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3.6" y="8.4" width="6.4" height="12" rx="1.8"/><rect x="14" y="3.6" width="6.4" height="16.8" rx="1.8"/></svg>',
  jobs: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4.6" y="4.4" width="14.8" height="16" rx="2.4"/><path d="M9 3.4h6v2.6H9z"/><path d="M8.6 11.4l1.9 1.9 3.6-3.8M8.6 16.6h6.8"/></svg>',
};

export const NAV = [
  { id: "holon", label: "Holon", icon: I.holon },
  { id: "sources", label: "My Data", icon: I.data },
  { id: "marketplace", label: "Agent Marketplace", icon: I.market },
  { id: "metalife", label: "My Assets", icon: I.assets },
  { id: "holon", label: "Stake LINGO", icon: I.stake, anchor: "staking", key: "stake" },
  { id: "holon", label: "Earnings", icon: I.earn, anchor: "earnings", key: "earnings" },
  { id: "sovereignty", label: "Settings", icon: I.settings },
  { divider: true },
  { id: "chat", label: "Holon Chat", icon: I.chat },
  { id: "ontology", label: "Ontology", icon: I.onto },
  { id: "memory", label: "Memory", icon: I.memory },
  { id: "roadmap", label: "Roadmap", icon: I.road },
  { id: "verify", label: "Verify", icon: I.verify },
];

// Marketplace mode: the six screens the agent-marketplace journey needs and
// nothing else. Filtered out of NAV (not a second router) so ids, icons and
// sections cannot drift; `route` carries the marketplace sub-path, `id` still
// names the section the route lands in.
const entry = (id) => NAV.find(n => !n.divider && n.id === id && !n.anchor);
export const MARKET_NAV = [
  { ...entry("marketplace"), label: "Tasks" },
  { ...entry("marketplace"), label: "Providers", icon: I.cats, key: "providers", route: "marketplace/providers" },
  { ...entry("marketplace"), label: "My Work", icon: I.holon, key: "work", route: "marketplace/work" },
  { ...entry("marketplace"), label: "Orders", icon: I.jobs, key: "orders", route: "marketplace/orders" },
  { ...entry("verify"), label: "Evidence" },
];

// index.html ships a <section class="view"> per screen. Any NAV entry added
// later (Verify) gets its own section created here, so the markup and the nav
// can never drift apart.
function ensureSections() {
  const main = document.getElementById("main");
  if (!main) return;
  NAV.forEach(n => {
    if (n.divider || main.querySelector(`.view[data-view="${n.id}"]`)) return;
    const sec = document.createElement("section");
    sec.className = "view";
    sec.dataset.view = n.id;
    main.appendChild(sec);
  });
}

// `opts.nav` picks the rail (NAV, or MARKET_NAV in marketplace mode); `opts.back`
// adds the escape hatch out of marketplace mode, wired to `opts.onBack`.
const mobileLabels = { marketplace: "Explore", cats: "Categories", compare: "Compare", jobs: "Jobs", myholon: "Holon", verify: "Evidence", holon: "Home", sources: "Knowledge", sovereignty: "Settings", chat: "Chat", ontology: "Graph", memory: "Memory", metalife: "Assets", roadmap: "Roadmap", stake: "Stake", earn: "Earnings" };
export function buildRail(onNav, opts = {}) {
  ensureSections();
  const rail = document.getElementById("rail");
  rail.innerHTML = (opts.nav || NAV).map(n => n.divider
    ? `<div class="side-div" role="separator"></div>`
    : `<button class="item" aria-label="${n.label}" title="${n.label}" data-nav="${n.route || n.id}" data-key="${n.key || n.id}"
         ${n.anchor ? `data-anchor="${n.anchor}"` : ""}>
         <span class="ic" aria-hidden="true">${n.icon}</span><span class="lbl">${n.label}</span><span class="mobile-lbl" aria-hidden="true">${document.documentElement.dataset.application === 'xlayer' && n.id === 'marketplace' && !n.key ? 'Tasks' : mobileLabels[n.key || n.id] || n.label}</span></button>`).join("");
  rail.querySelectorAll("[data-nav]").forEach(b => b.onclick = () => {
    go(b.dataset.nav, onNav, b.dataset.anchor);
    // Anchor items highlight themselves, not the plain dashboard entry.
    rail.querySelectorAll(".item").forEach(i => i.classList.toggle("active", i === b));
  });
  buildModeLink(opts);
  syncRail(current || location.hash.slice(1));
}

// Marketplace mode on a local instance is a choice, so it is reversible from the
// sidebar. The public read-only build has no app behind it to go back to, so it
// gets no link at all.
function buildModeLink(opts) {
  const bottom = document.querySelector(".side-bottom");
  if (!bottom) return;
  const old = bottom.querySelector(".mode-back");
  if (old) old.remove();
  if (!opts.back) return;
  const b = document.createElement("button");
  b.className = "mode-back";
  b.innerHTML = `<span aria-hidden="true">←</span> Back to Holon App`;
  b.onclick = opts.onBack;
  bottom.appendChild(b);
}

// The marketplace rail carries several entries under one section (Compare,
// My Jobs), so the exact route wins over the plain view entry.
function syncRail(path) {
  const view = viewOf(path);
  const items = [...document.querySelectorAll(".rail .item")];
  const parent = path === "marketplace/new-provider" ? "marketplace/providers"
    : path.startsWith("marketplace/order/") ? "marketplace/orders" : path;
  // Anchor items (Stake/Earnings → dashboard sections) highlight only via their
  // own click, never from plain view routing.
  const on = items.find(i => !i.dataset.anchor && i.dataset.nav === parent)
          || items.find(i => !i.dataset.anchor && i.dataset.nav === view);
  items.forEach(i => {
    i.classList.toggle("active", i === on);
    i.setAttribute("aria-current", i === on ? "page" : "false");
  });
}

// A route is `view` or `view/sub/parts` — the marketplace nests its journey
// (cat / agent / compare / jobs / verify) under one section, so the sub-path
// must re-render the view without re-toggling the section.
export function viewOf(route) { return String(route || "").replace(/^#/, "").split("/")[0]; }

let current = null;      // full route, e.g. "marketplace/jobs"
let currentView = null;  // just the section, e.g. "marketplace"
export function go(route, onNav, anchor) {
  const path = String(route || "").replace(/^#/, "");
  const view = viewOf(path);
  // Idempotent route switch (rail click + hashchange both land here) — but an
  // anchor jump within the same route must still scroll.
  if (path !== current) {
    current = path;
    if (view !== currentView) {
      currentView = view;
      document.querySelectorAll(".view").forEach(v => v.classList.toggle("active", v.dataset.view === view));
    }
    syncRail(path);   // sub-routes keep the same view, so this sits outside
    if (location.hash.slice(1) !== path) location.hash = path;
    onNav && onNav(view);
  }
  if (anchor) requestAnimationFrame(() => {
    const t = document.querySelector(`.view[data-view="${view}"] #${anchor}`);
    if (t) t.closest(".card, div").scrollIntoView({ behavior: "smooth", block: "center" });
  });
}
