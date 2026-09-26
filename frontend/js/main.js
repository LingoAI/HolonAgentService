import { api, esc } from "/js/api.js";
import { buildRail, go, viewOf, NAV, MARKET_NAV } from "/js/router.js";
import { renderChat } from "/js/views/chat.js";
import { registerPalette, styledPrompt, toast, trapModal } from "/js/ui.js";

export const state = { status: null };
const VIEWS = { chat: renderChat };
const PERSONAL_VIEWS = { holon: ["dashboard", "renderDashboard"], ontology: ["ontology", "renderOntology"],
                         memory: ["memory", "renderMemory"], sources: ["sources", "renderSources"],
                         sovereignty: ["sovereignty", "renderSovereignty"], roadmap: ["roadmap", "renderRoadmap"],
                         metalife: ["metalife", "renderMetalife"] };
let xlayerViewPromise;
function xlayerView() {
  if (!xlayerViewPromise) xlayerViewPromise = Promise.all([
    fetch('/api/xlayer/config').then(async response => {
      const conf = await response.json();
      if (!response.ok || !conf.ok) throw new Error(conf.error || 'X Layer configuration unavailable');
      return conf;
    }),
    import('/js/views/xlayer.js'),
  ]).catch(error => { xlayerViewPromise = null; throw error; });
  return xlayerViewPromise;
}
async function renderView(view, el) {
  if (['marketplace', 'verify'].includes(view)) {
    try {
      const [conf, { renderXLayer }] = await xlayerView();
      return renderXLayer(el, conf);
    } catch (error) {
      el.innerHTML = `<div class="scroll"><p class="muted">${esc(error.message)}</p></div>`;
      return;
    }
  }
  if (VIEWS[view]) return VIEWS[view](el);
  const spec = PERSONAL_VIEWS[view];
  if (!spec || !el) return;
  try {
    const mod = await import(`/js/views/${spec[0]}.js`);
    return mod[spec[1]](el);
  } catch (e) {
    el.innerHTML = `<div class="scroll"><p class="muted">This view is not part of the marketplace build.</p></div>`;
  }
}
const HOME = "holon";

// ---- marketplace mode ------------------------------------------------------
// The public deployment is read-only and is read as an agent marketplace, not as
// somebody's personal data app: it drops the personal screens and lands on the
// marketplace. `?mode=marketplace` pins the same shell on a local instance,
// `?mode=full` clears it, and the choice persists in localStorage.
function modePref() {
  try {
    const m = (location.search.match(/[?&]mode=(marketplace|full)\b/) || [])[1];
    if (m) localStorage.setItem("holon_mode", m);
    return localStorage.getItem("holon_mode") === "marketplace";
  } catch (e) { return false; }
}
let marketMode = modePref();   // provisional — /api/status readonly can force it on
let readonly = false;
// Views read this attribute to hide developer controls, so it is set here at
// module scope: before the rail is built and long before the first view renders.
document.documentElement.dataset.mode = marketMode ? "marketplace" : "full";

// The palette must not offer screens the marketplace rail hides.
const MARKET_PALETTE = new Set(["Go to Marketplace", "Go to My Jobs", "Go to Verify",
                                "Go to Dashboard", "Toggle theme"]);

function applyMode() {
  document.documentElement.dataset.mode = marketMode ? "marketplace" : "full";
  const xlayerMode = true;
  document.documentElement.dataset.application = 'xlayer';
  if (xlayerMode) {
    const brand = document.querySelector('.brand .txt');
    if (brand) brand.innerHTML = 'LingoAI <b>Holon</b><span class="sub">evidence services</span>';
    const mark = document.querySelector('.brand .mark');
    if (mark) mark.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m5 7 7-4 7 4v10l-7 4-7-4zM5 7l7 4 7-4M12 11v10"/></svg>';
    document.getElementById('themeBtn').innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 4v16"/><path d="M12 4a8 8 0 0 1 0 16" fill="currentColor"/></svg>';
    const standards = document.querySelector('.stdbar');
    if (standards) standards.innerHTML = [['OKX AI','Agent marketplace','https://www.okx.ai/agents/13847'],['A2MCP / A2A','Official services','/mcp.html'],['X Layer','USDT settlement','#marketplace'],['IPFS','Verifiable delivery','#marketplace'],['LingoAI Holon','Evidence and analysis','/mcp.html']].map(([name,label,url])=>`<a class="std" href="${url}"><b>${name}</b><span class="sep">·</span><span>${label}</span></a>`).join('');
  }
  const navigation = xlayerMode ? MARKET_NAV : (marketMode ? MARKET_NAV : NAV);
  buildRail(onNav, { nav: navigation,
                     back: marketMode && !readonly && !xlayerMode, onBack: leaveMarketMode });
  // the Pod card is the personal app's setup hint; the marketplace has no Pod to configure
  const pod = document.getElementById("podCard");
  if (pod) pod.hidden = marketMode;
  paintTopbar();
  const ask = document.getElementById("askInput");
  if (ask) {
    ask.placeholder = marketMode ? "Ask about the marketplace…" : "Ask your Holon…";
    ask.setAttribute("aria-label", marketMode ? "Open marketplace assistant with a question" : "Ask your Holon");
  }
}

function leaveMarketMode() {
  try { localStorage.setItem("holon_mode", "full"); } catch (e) {}
  marketMode = false;
  applyMode();
  go(HOME, onNav);
}

async function refreshStatus() {
  const s = await api.status(); state.status = s;
  const dot = document.getElementById("engineDot");
  const local = s.local === true;
  dot.className = "dot " + (local ? (s.ollama_up ? "ok" : "err") : "");
  const label = local ? (s.ollama_up ? "Local model reachable" : "Local model unavailable")
    : s.provider_configured === false ? "Cloud provider is not configured"
    : "Cloud processing selected · provider availability is checked when you send";
  dot.parentElement.title = label;
  dot.parentElement.setAttribute("aria-label", label);
}

// The LINGO balance is a Stage D simulation. It belongs on the personal
// screens only — the marketplace and Verify are evidence surfaces and must
// never carry a simulated number, sub-routes included.
const NO_LINGO_VIEWS = new Set(["marketplace", "verify"]);
let lingoReady = false;
function syncChrome(view) {
  const chip = document.getElementById("lingoChip");
  if (chip) chip.hidden = !lingoReady || NO_LINGO_VIEWS.has(view);
}

function onNav(view) {
  syncChrome(view);
  renderView(view, document.querySelector(`.view[data-view="${view}"]`));
}

// ---- topbar: greeting, ask box, LINGO + wallet chips, pod card -------------
let greetName = "";
function greet(name) { if (name) greetName = name; paintTopbar(); }

// The greeting is the personal app's line. Marketplace mode names what the
// visitor is actually looking at instead; the Ask box stays either way.
function paintTopbar() {
  const t = document.getElementById("greetTitle"), s = document.getElementById("greetSub");
  if (marketMode) {
    t.textContent = 'X Layer Agent Marketplace';
    s.textContent = 'Identity, service payments and task escrow';
    return;
  }
  const h = new Date().getHours();
  const part = h < 5 ? "Good night" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  t.textContent = `${part}${greetName ? ", " + greetName : ""} 👋`;
  s.textContent = "Your data. Your ontology. Your AI.";
}

function fillIdentity() {
  greet("");
  const card = document.getElementById('walletCard');
  if (card) card.hidden = true;
  const chip = document.getElementById('lingoChip');
  if (chip) chip.hidden = true;
}

// LINGO balance: the Stage D simulated ledger, labeled "sim" inline — a hover
// title is not a disclosure. syncChrome decides which views may show it.
async function fillLingo() {
  try {
    const led = await api.metaLedger();
    const chip = document.getElementById("lingoChip");
    chip.innerHTML = `◈ ${esc(Number(led.earnings || 0).toFixed(2))} LINGO <span class="sim">· sim</span>`;
    lingoReady = true;
    syncChrome(viewOf(location.hash.slice(1)) || HOME);
  } catch (e) { /* sim ledger optional */ }
}

// First-run onboarding: an almost-empty graph + no prior dismissal means this
// is a fresh install. Any choice (including Escape) marks it seen for good.
async function maybeOnboard() {
  if (localStorage.getItem("holon_onboarded")) return;
  let stats;
  try { stats = await api.stats(); } catch (e) { return; }
  if (!stats || stats.nodes > 1) return;
  localStorage.setItem("holon_onboarded", "1");
  const choice = await trapModal(
    `<p class="ui-modal-msg"><strong>Welcome to Holon</strong> — your private digital twin. It learns from what you give it.</p>
     <div class="ui-modal-actions">
       <button class="btn text" data-act="scratch" type="button">Start from scratch</button>
       <button class="btn text" data-act="import" type="button">Import my files</button>
       <button class="btn" data-act="seed" type="button">Load example life</button>
     </div>`,
    (overlay, close) => {
      overlay.querySelector('[data-act="scratch"]').onclick = () => close("scratch");
      overlay.querySelector('[data-act="import"]').onclick = () => close("import");
      overlay.querySelector('[data-act="seed"]').onclick = () => close("seed");
      overlay.addEventListener("keydown", e => { if (e.key === "Escape") { e.preventDefault(); close("scratch"); } });
      overlay.querySelector('[data-act="seed"]').focus();
    });
  if (choice === "seed") { await api.seed(); location.reload(); }
  else if (choice === "import") { location.hash = "sources"; }
}

async function boot() {
  // Status decides both the rail and the landing view, and nothing renders
  // before it resolves anyway — so it runs first. A failed fetch must still
  // leave a usable shell.
  await refreshStatus().catch(() => {});
  readonly = !!(state.status && state.status.readonly);
  if (readonly || state.status?.application === 'xlayer') marketMode = true;
  applyMode();
  setInterval(() => refreshStatus().catch(() => {}), 30000);
  const toggleTheme = () => {
    const html = document.documentElement;
    const next = html.dataset.theme === "dark" ? "light" : "dark";
    html.dataset.theme = next;
    try { localStorage.setItem("holon-theme", next); } catch (e) {}
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = next === "dark" ? "#141318" : "#ffffff";
    if (state.status?.application !== 'xlayer') onNav(viewOf(location.hash.slice(1)) || HOME);  // canvas views re-read theme colors
  };
  document.getElementById("themeBtn").onclick = toggleTheme;
  document.querySelector('.skip-link')?.addEventListener('click', event => {
    event.preventDefault();
    document.getElementById('main').focus();
  });
  // Ask box → chat with the question pre-sent.
  const ask = document.getElementById("askInput");
  ask.addEventListener("keydown", e => {
    if (e.key !== "Enter" || e.isComposing) return;
    const q = ask.value.trim(); if (!q) return;
    ask.value = "";
    sessionStorage.setItem("holon_pending_ask", q);
    if ((viewOf(location.hash.slice(1)) || HOME) === "chat") onNav("chat");
    else location.hash = "chat";
  });
  // ⌘K / Ctrl+K command palette: navigate to any screen + toggle theme.
  registerPalette(() => ([
    { label: "Go to Dashboard", hint: "navigate", run: () => { location.hash = "holon"; } },
    { label: "Go to Chat", hint: "navigate", run: () => { location.hash = "chat"; } },
    { label: "Go to Ontology", hint: "navigate", run: () => { location.hash = "ontology"; } },
    { label: "Go to Memory", hint: "navigate", run: () => { location.hash = "memory"; } },
    { label: "Go to My Data", hint: "navigate", run: () => { location.hash = "sources"; } },
    { label: "Go to Settings", hint: "navigate", run: () => { location.hash = "sovereignty"; } },
    { label: "Go to Roadmap", hint: "navigate", run: () => { location.hash = "roadmap"; } },
    { label: "Go to My Assets", hint: "navigate", run: () => { location.hash = "metalife"; } },
    { label: "Go to Marketplace", hint: "navigate", run: () => { location.hash = "marketplace"; } },
    { label: "Go to Verify", hint: "navigate", run: () => { location.hash = "verify"; } },
    { label: "Go to My Jobs", hint: "navigate", run: () => { location.hash = "marketplace/jobs"; } },
    { label: "Toggle theme", hint: "appearance", run: toggleTheme },
    // Personal data → ontology: deterministic structured entry into the graph.
    { label: "Add event to your life", hint: "ontology", run: async () => {
        const title = await styledPrompt("Event title");
        if (!title || !title.trim()) return;
        const where = await styledPrompt("Where? (optional)");
        const whoStr = await styledPrompt("Who was there? (comma-separated, optional)");
        const who = (whoStr || "").split(",").map(s => s.trim()).filter(Boolean);
        await api.addEvent({ title, where: where || null, who });
        toast(`Added “${title}” to your ontology`, { icon: "📅" });
        const v = viewOf(location.hash.slice(1)) || HOME;
        if (v === "ontology" || v === HOME) onNav(v);
    } },
    { label: "Add contact", hint: "ontology", run: async () => {
        const name = await styledPrompt("Contact name");
        if (!name || !name.trim()) return;
        const org = await styledPrompt("Organisation (optional)");
        const relationship = await styledPrompt("Relationship, e.g. colleague (optional)");
        await api.addContact({ name, org: org || null, relationship: relationship || null });
        toast(`Added ${name} to your contacts`, { icon: "👤" });
        const v = viewOf(location.hash.slice(1)) || HOME;
        if (v === "ontology" || v === HOME) onNav(v);
    } },
    // Audit trail: surface the most recent recorded turn.
    { label: "Recent activity", hint: "audit", run: async () => {
        const rows = await api.trajectory(1);
        if (!rows || !rows.length) { toast("No activity logged yet"); return; }
        const t = rows[rows.length - 1];
        toast(`Last turn · ${t.tier} · ${t.latency_ms}ms · ${t.facts_added} fact(s)`, { icon: "🧭" });
    } },
  ].filter(c => !marketMode || MARKET_PALETTE.has(c.label))));
  fillIdentity();
  // Marketplace mode lands on the marketplace, not on somebody's dashboard.
  const landing = () => location.hash.slice(1) || (marketMode ? "marketplace" : HOME);
  // Route on browser back/forward and external hash edits, not just initial boot.
  addEventListener("hashchange", () => go(landing(), onNav));
  go(landing(), onNav);
  // Onboarding offers seeding and imports — neither belongs on a public,
  // read-only marketplace.
  if (!marketMode) maybeOnboard();
}
boot();
