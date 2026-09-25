const J = (m, b) => ({ method: m, headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
// HTML-escape server/user-derived strings before innerHTML interpolation.
export const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g,
  c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const api = {
  status: () => fetch("/api/status").then(r => r.json()),
  stats:  () => fetch("/api/stats").then(r => r.json()),
  graph:  (type = "", q = "") => fetch(`/api/graph?type=${encodeURIComponent(type)}&q=${encodeURIComponent(q)}`).then(r => r.json()),
  node:   (id) => fetch(`/api/node/${encodeURIComponent(id)}`).then(r => r.json()),
  duplicates: () => fetch("/api/graph/duplicates").then(r => r.json()),
  merge:  (keep, merge) => fetch("/api/graph/merge", J("POST", { keep, merge })).then(r => r.json()),
  forget: (node) => fetch("/api/forget", J("POST", { node })).then(r => r.json()),
  memory: (q = "") => fetch(`/api/memory?q=${encodeURIComponent(q)}`).then(r => r.json()),
  sources:() => fetch("/api/sources").then(r => r.json()),
  deleteSource: (title) => fetch("/api/source/delete", J("POST", { title })).then(r => r.json()),
  history:() => fetch("/api/history").then(r => r.json()),
  ingest: (body) => fetch("/api/ingest", J("POST", body)).then(r => r.json()),
  ingestFolder: (path, tag = "import") => fetch("/api/ingest/folder", J("POST", { path, tag })).then(r => r.json()),
  ingestFile: (file, tag = "file") => { const fd = new FormData(); fd.append("file", file); fd.append("tag", tag);
                 return fetch("/api/ingest", { method: "POST", body: fd }).then(r => r.json()); },
  voice:  (blob) => { const fd = new FormData(); fd.append("file", blob, "mic.webm");
                 return fetch("/api/voice", { method: "POST", body: fd }).then(r => r.json()); },
  setTier:(tier) => fetch("/api/tier", J("POST", { tier })).then(r => r.json()),
  reset:  () => fetch("/api/reset", { method: "POST" }).then(r => r.json()),
  seed:   () => fetch("/api/seed", { method: "POST" }).then(r => r.json()),
  // --- data sovereignty ---
  webid:        () => fetch("/api/webid").then(r => r.json()),
  podExport:    () => fetch("/api/pod/export").then(r => r.json()),
  accessList:   () => fetch("/api/access").then(r => r.json()),
  accessGrant:  (grantee, scopes) => fetch("/api/access", J("POST", { grantee, scopes })).then(r => r.json()),
  accessRevoke: (id) => fetch("/api/access/revoke", J("POST", { id })).then(r => r.json()),
  share:        (token) => fetch(`/api/share/${encodeURIComponent(token)}`).then(r => r.json()),
  // --- personal data → ontology + audit trail ---
  addEvent:    (body) => fetch("/api/personal/event", J("POST", body)).then(r => r.json()),
  addContact:  (body) => fetch("/api/personal/contact", J("POST", body)).then(r => r.json()),
  events:      () => fetch("/api/personal/events").then(r => r.json()),
  contacts:    () => fetch("/api/personal/contacts").then(r => r.json()),
  trajectory:  (limit = 20) => fetch(`/api/trajectory?limit=${limit}`).then(r => r.json()),
  // --- Stage D · data capital (simulation) ---
  metaAssets:  () => fetch("/api/metalife/assets").then(r => r.json()),
  metaCompute: (type, op) => fetch("/api/metalife/compute", J("POST", { type, op })).then(r => r.json()),
  metaOffer:   (type, price) => fetch("/api/metalife/offer", J("POST", { type, price })).then(r => r.json()),
  metaSell:    (type) => fetch("/api/metalife/sell", J("POST", { type })).then(r => r.json()),
  metaH2H:     (peer, kind = "handshake") => fetch("/api/metalife/h2h", J("POST", { peer, kind })).then(r => r.json()),
  metaNetwork: () => fetch("/api/metalife/network").then(r => r.json()),
  metaLedger:  () => fetch("/api/metalife/ledger").then(r => r.json()),
  solidStatus: () => fetch("/api/pod/solid/status").then(r => r.json()),
  solidPublish: (readers, scope) => fetch("/api/pod/solid/publish", J("POST", { readers, scope })).then(r => r.json()),
  solidRead: (isPublic) => fetch(`/api/pod/solid/read?public=${isPublic ? 1 : 0}`).then(r => r.json()),
  // Personal Holon preferences.
  holonPreferences: () => fetch("/api/holon/preferences").then(r => r.json()),
  holonPreferencesSet: (body) => fetch("/api/holon/preferences", J("POST", body)).then(r => r.json()),
};
