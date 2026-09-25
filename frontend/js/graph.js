// Dynamic Cytoscape graph: fCoSE physics layout, degree-based sizing, hover
// neighborhood highlight, animated filtering, and live fact growth during chat.
// No build / no CDN — fcose is vendored and registered onto the global cytoscape.
if (window.cytoscape && window.cytoscapeFcose && !cytoscape.__fcose) {
  cytoscape.use(window.cytoscapeFcose);
  cytoscape.__fcose = true;
}
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;

export const LAYOUT = {
  name: window.cytoscapeFcose ? "fcose" : "cose",
  quality: "proof", randomize: true, animate: !REDUCED, animationDuration: 900,
  animationEasing: "ease-out", fit: true, padding: 60,
  nodeDimensionsIncludeLabels: true, packComponents: true, tile: true,
  nodeRepulsion: () => 14000, idealEdgeLength: () => 110, edgeElasticity: () => 0.45,
  gravity: 0.25, gravityRange: 3.8, numIter: 2500, initialEnergyOnIncremental: 0.3,
};

function getCss(v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }
function cssEsc(s) { return String(s).replace(/["\\]/g, "\\$&"); }
const elKey = el => el.isNode() ? el.id() : `${el.data("source")}->${el.data("target")}`;
const dataKey = e => e.data.id || `${e.data.source}->${e.data.target}`;

export function stampDegree(cy) {
  cy.batch(() => cy.nodes().forEach(n => n.data("deg", n.degree(false))));
}

function styleArray() {
  const surface = getCss("--surface"), onSurf = getCss("--on-surface");
  const onSurfVar = getCss("--on-surface-variant"), outline = getCss("--outline");
  const primary = getCss("--primary");
  return [
    { selector: "node", style: {
        "background-color": "data(color)", "background-opacity": 0.92,
        "label": "data(label)",
        "width": "mapData(deg, 0, 12, 24, 64)", "height": "mapData(deg, 0, 12, 24, 64)",
        "font-size": "mapData(deg, 0, 12, 9, 13)", "font-weight": 600, "color": onSurf,
        "text-valign": "bottom", "text-halign": "center", "text-margin-y": 5,
        "text-wrap": "ellipsis", "text-max-width": 110,
        "text-background-color": surface, "text-background-opacity": 0.78,
        "text-background-shape": "roundrectangle", "text-background-padding": 3,
        "border-width": 2, "border-color": "data(color)", "border-opacity": 0.35,
        "background-blacken": -0.08,
        "transition-property": "width height opacity border-width border-color background-blacken",
        "transition-duration": "220ms", "transition-timing-function": "ease-out",
        "shadow-blur": 8, "shadow-color": "#000", "shadow-opacity": 0.12, "shadow-offset-y": 2 } },
    { selector: "node[?root]", style: {
        "width": 72, "height": 72, "font-size": 15, "font-weight": 800,
        "background-color": primary, "border-width": 4, "border-color": primary, "border-opacity": 1,
        "shadow-blur": 28, "shadow-color": primary, "shadow-opacity": 0.55, "shadow-offset-y": 0,
        "z-index": 100 } },
    { selector: "edge", style: {
        "width": "mapData(confidence, 0, 1, 1, 3)", "line-color": outline, "line-opacity": 0.55,
        "curve-style": "unbundled-bezier", "control-point-distances": [22], "control-point-weights": [0.5],
        "target-arrow-color": outline, "target-arrow-shape": "triangle", "arrow-scale": 0.85,
        "label": "data(label)", "font-size": 8, "color": onSurfVar, "text-opacity": 0,
        "text-rotation": "autorotate", "text-background-color": surface,
        "text-background-opacity": 0.9, "text-background-padding": 2,
        "transition-property": "line-opacity width line-color text-opacity",
        "transition-duration": "200ms" } },
    { selector: ".dim", style: { "opacity": 0.12, "text-opacity": 0 } },
    { selector: ".faded", style: { "opacity": 0.12, "text-opacity": 0 } },
    { selector: ".hl", style: { "line-opacity": 0.95, "text-opacity": 1,
        "line-color": primary, "target-arrow-color": primary } },
    { selector: "node.hl", style: { "border-opacity": 0.9, "border-width": 3 } },
    { selector: "node.hl-core", style: { "border-color": primary, "border-width": 4, "border-opacity": 1,
        "shadow-blur": 22, "shadow-color": primary, "shadow-opacity": 0.5 } },
    { selector: "node.grabbed", style: { "border-width": 4, "border-color": primary,
        "shadow-blur": 24, "shadow-opacity": 0.4, "background-blacken": -0.15 } },
    { selector: "node.fresh", style: { "border-color": primary, "border-width": 5, "border-opacity": 1,
        "shadow-blur": 30, "shadow-color": primary, "shadow-opacity": 0.7 } },
    { selector: "edge.fresh", style: { "line-color": primary, "target-arrow-color": primary,
        "line-opacity": 1, "width": 3 } },
  ];
}

export function makeGraph(container, elements, onTap) {
  const cy = cytoscape({ container, elements, style: styleArray(), wheelSensitivity: 0.2 });
  stampDegree(cy);
  cy.layout(LAYOUT).run();

  cy.on("mouseover", "node", e => {
    if (cy.scratch("_locked")) return;
    const hood = e.target.closedNeighborhood();
    cy.elements().not(hood).addClass("dim");
    hood.addClass("hl"); e.target.addClass("hl-core");
  });
  cy.on("mouseout", "node", () => {
    if (cy.scratch("_locked")) return;
    cy.elements().removeClass("dim hl hl-core");
  });
  cy.on("mouseover", "edge", e => { if (!cy.scratch("_locked")) e.target.addClass("hl"); });
  cy.on("mouseout", "edge", e => { if (!cy.scratch("_locked")) e.target.removeClass("hl"); });
  cy.on("grab", "node", e => e.target.addClass("grabbed"));
  cy.on("free", "node", e => e.target.removeClass("grabbed"));

  cy.on("tap", "node", e => onTap && onTap(e.target.id()));
  cy.on("dbltap", "node", e => {
    const n = e.target, hood = n.closedNeighborhood();
    cy.scratch("_locked", true);
    cy.elements().removeClass("dim hl hl-core");
    cy.elements().not(hood).addClass("dim");
    hood.addClass("hl"); n.addClass("hl-core");
    cy.animate({ fit: { eles: hood, padding: 80 }, duration: 600, easing: "ease-out" });
  });
  cy.on("dbltap", e => {
    if (e.target === cy) { cy.scratch("_locked", false); cy.elements().removeClass("dim hl hl-core faded"); fit(cy); }
  });
  return cy;
}

export function fit(cy) {
  cy.animate({ fit: { padding: 60 }, duration: 500, easing: "ease-in-out-cubic" });
}
export function replay(cy) {
  cy.layout({ ...LAYOUT, randomize: true, animationDuration: 1100 }).run();
}
export function refreshTheme(cy) { cy.style().fromJson(styleArray()).update(); }

export function updateGraph(cy, elements) {
  const next = new Set(elements.map(dataKey));
  cy.elements().forEach(el => {
    if (!next.has(elKey(el))) el.animate({ style: { opacity: 0 }, duration: 250 }, { complete: () => el.remove() });
  });
  const have = new Set(cy.elements().map(elKey));
  const fresh = elements.filter(e => !have.has(dataKey(e)));
  if (fresh.length) {
    const added = cy.add(fresh);
    added.style("opacity", 0);
    stampDegree(cy);
    cy.layout({ ...LAYOUT, randomize: false, fit: false, animationDuration: 600 }).run();
    added.animate({ style: { opacity: 1 }, duration: 500, easing: "ease-out" });
  } else {
    stampDegree(cy);
    cy.layout({ ...LAYOUT, randomize: false, fit: true, animationDuration: 500 }).run();
  }
}

export function applyFact(cy, fact) {
  if (!cy) return;
  const ensureNode = name => {
    let n = cy.getElementById(name);
    if (n.empty()) {
      const isRoot = name === "You";
      const color = isRoot ? getCss("--primary") : (fact.colors && fact.colors[name]) || "#9aa0a6";
      n = cy.add({ group: "nodes", data: { id: name, label: name, type: fact.type || "Topic", color, root: isRoot } });
      n.style("opacity", 0);
      n.animate({ style: { opacity: 1 }, duration: 450, easing: "ease-out" });
    }
    return n;
  };
  const s = ensureNode(fact.subject), t = ensureNode(fact.object);
  let e = cy.edges(`[source = "${cssEsc(fact.subject)}"][target = "${cssEsc(fact.object)}"]`);
  if (e.empty()) {
    e = cy.add({ group: "edges", data: { source: fact.subject, target: fact.object, label: fact.predicate, confidence: 0.8 } });
    e.style("opacity", 0);
    e.animate({ style: { opacity: 1 }, duration: 450 });
  }
  stampDegree(cy);
  const trio = s.union(t).union(e);
  trio.addClass("fresh");
  cy.layout({ ...LAYOUT, randomize: false, fit: false, animationDuration: 700 }).run();
  setTimeout(() => trio.removeClass("fresh"), 1600);
}
