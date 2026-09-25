"""The personal ontology: a typed, bi-temporal-ish, provenanced knowledge graph.

This is the hero of Holon. Generic OpenIE fails on first-person diary text
(per lingo_holon.tex), so extraction is constrained to a personal schema.
Storage is NetworkX persisted to JSON; every edge carries provenance + a
recorded time and an optional valid time.
"""
import json
from datetime import datetime, timezone
from pathlib import Path
import networkx as nx
from .llm import parse_extraction as _parse, chat_once as _chat_once

NODE_TYPES = ["Person", "HealthMetric", "Condition", "Medication", "Event",
              "Place", "Org", "Goal", "Preference", "Topic", "Document"]
EDGE_PREDICATES = ["takes", "prescribed_by", "has_condition", "treats",
                   "measured", "located_at", "works_on", "member_of", "prefers",
                   "did", "attended", "mentions", "related_to", "source_of"]
ROOT = "You"

EXTRACTION_SYSTEM = (
    "You extract a PERSONAL ontology from first-person text. Output STRICT JSON: "
    '{"entities":[{"name":...,"type":...}],"relations":[{"subject":...,'
    '"predicate":...,"object":...,"valid_time":null}]}. '
    "Subject of personal facts is usually \"You\". "
    f"Allowed entity types: {', '.join(NODE_TYPES)}. "
    f"Allowed predicates: {', '.join(EDGE_PREDICATES)}. "
    "Only extract concrete facts actually stated. No commentary, JSON only.")

from ..security import untrusted_block as _untrusted, EXTRACTION_POLICY as _POLICY
EXTRACTION_SYSTEM = EXTRACTION_SYSTEM + " " + _POLICY

# Type → colour (Material-ish), consumed by the frontend legend + Cytoscape style.
TYPE_COLORS = {
    "Person": "#7c6af7", "HealthMetric": "#f76a8c", "Condition": "#f7a86a",
    "Medication": "#6ab0f7", "Event": "#6af7a8", "Place": "#f7d76a",
    "Org": "#a86af7", "Goal": "#6af7d7", "Preference": "#f76af7",
    "Topic": "#9aa0a6", "Document": "#5f6368",
}


def _now():
    return datetime.now(timezone.utc).isoformat()


def _key(name):
    return name.strip()


class Ontology:
    def __init__(self, path):
        self.path = Path(path)
        self.g = nx.DiGraph()
        self.load()
        if ROOT not in self.g:
            self.upsert_entity(ROOT, "Person", source="root")

    # ---- persistence -------------------------------------------------------
    def load(self):
        if self.path.exists():
            data = json.loads(self.path.read_text())
            self.g = nx.node_link_graph(data, directed=True, edges="links")

    def save(self):
        from ..atomic_io import atomic_write_json
        data = nx.node_link_data(self.g, edges="links")
        atomic_write_json(self.path, data, indent=0)

    # ---- mutation ----------------------------------------------------------
    def _resolve(self, name):
        """Case-insensitive dedupe: return an existing node id matching `name`."""
        nl = name.strip().lower()
        for n in self.g:
            if n.lower() == nl:
                return n
        return None

    def upsert_entity(self, name, ntype, source=None):
        name = _key(name)
        if not name:
            return None
        existing = self._resolve(name)
        nid = existing or name
        if existing:
            if ntype in NODE_TYPES and self.g.nodes[nid].get("type") in (None, "Topic"):
                self.g.nodes[nid]["type"] = ntype
            if source:
                self.g.nodes[nid].setdefault("provenance", [])
                if source not in self.g.nodes[nid]["provenance"]:
                    self.g.nodes[nid]["provenance"].append(source)
        else:
            self.g.add_node(nid, label=name,
                            type=ntype if ntype in NODE_TYPES else "Topic",
                            t_first_seen=_now(),
                            provenance=[source] if source else [])
        return nid

    def upsert_relation(self, subj, predicate, obj, source=None,
                        node_types=None, valid_time=None, confidence=1.0):
        if predicate not in EDGE_PREDICATES:
            predicate = "related_to"
        node_types = node_types or {}
        s = self.upsert_entity(subj, node_types.get(subj, "Topic"), source)
        t = self.upsert_entity(obj, node_types.get(obj, "Topic"), source)
        if not s or not t:
            return False
        if self.g.has_edge(s, t):
            e = self.g.edges[s, t]
            e["provenance"] = list({*e.get("provenance", []), *( [source] if source else [])})
            e["confidence"] = max(e.get("confidence", 0), confidence)
        else:
            self.g.add_edge(s, t, predicate=predicate, t_recorded=_now(),
                            t_valid=valid_time, confidence=confidence,
                            provenance=[source] if source else [])
        return True

    def find_duplicates(self, threshold=0.86):
        """Near-duplicate node pairs (case/spacing/punctuation variants the
        case-insensitive `_resolve` missed), scored by difflib ratio on
        casefolded labels. Same-type pairs only, unless one side is an untyped
        Topic. ROOT is never a candidate — merging away 'You' would orphan
        the whole graph."""
        from difflib import SequenceMatcher
        nodes = [n for n in self.g if n != ROOT]
        out = []
        for i, a in enumerate(nodes):
            for b in nodes[i + 1:]:
                ta = self.g.nodes[a].get("type", "Topic")
                tb = self.g.nodes[b].get("type", "Topic")
                if ta != tb and "Topic" not in (ta, tb):
                    continue
                score = SequenceMatcher(None, a.casefold(), b.casefold()).ratio()
                if score >= threshold:
                    out.append({"keep": a, "merge": b, "score": round(score, 3)})
        return sorted(out, key=lambda d: -d["score"])

    def merge_nodes(self, keep, merge):
        """Rewire every edge from `merge` onto `keep`, union provenance, adopt
        the more specific type, then drop `merge`. ROOT can never be merged away."""
        keep = self._resolve(keep) or keep
        merge = self._resolve(merge) or merge
        if keep == merge or merge == ROOT or keep not in self.g or merge not in self.g:
            return False
        ka, ma = self.g.nodes[keep], self.g.nodes[merge]
        ka["provenance"] = list({*ka.get("provenance", []), *ma.get("provenance", [])})
        if ka.get("type") in (None, "Topic") and ma.get("type") not in (None, "Topic"):
            ka["type"] = ma["type"]
        for s, _, e in list(self.g.in_edges(merge, data=True)):
            if s != keep and not self.g.has_edge(s, keep):
                self.g.add_edge(s, keep, **e)
        for _, t, e in list(self.g.out_edges(merge, data=True)):
            if t != keep and not self.g.has_edge(keep, t):
                self.g.add_edge(keep, t, **e)
        self.g.remove_node(merge)
        self.save()
        return True

    def forget_node(self, nid):
        """Remove a node and every incident edge — the user's right to forget.
        ROOT is protected: deleting 'You' would orphan the entire graph
        (learned the hard way; see data-dir incident)."""
        nid = self._resolve(nid) or nid
        if nid == ROOT or nid not in self.g:
            return {"removed": False, "edges": 0}
        edges = self.g.degree(nid)
        self.g.remove_node(nid)
        self.save()
        return {"removed": True, "edges": edges}

    def reset(self):
        self.g = nx.DiGraph()
        self.upsert_entity(ROOT, "Person", source="root")
        self.save()

    # ---- read --------------------------------------------------------------
    def stats(self):
        return {"nodes": self.g.number_of_nodes(), "edges": self.g.number_of_edges()}

    def to_cytoscape(self, filter_type=None, q=None):
        nodes, edges = [], []
        keep = set()
        for nid, a in self.g.nodes(data=True):
            # Always keep the root "You" node so filtered/searched views stay
            # anchored and connected (every edge runs through You).
            if filter_type and a.get("type") != filter_type and nid != ROOT:
                continue
            if q and q.lower() not in nid.lower() and nid != ROOT:
                continue
            keep.add(nid)
            nodes.append({"data": {
                "id": nid, "label": a.get("label", nid),
                "type": a.get("type", "Topic"),
                "color": TYPE_COLORS.get(a.get("type", "Topic"), "#9aa0a6"),
                "root": nid == ROOT}})
        for s, t, a in self.g.edges(data=True):
            if s in keep and t in keep:
                edges.append({"data": {"source": s, "target": t,
                                       "label": a.get("predicate", "related_to"),
                                       "confidence": a.get("confidence", 1.0)}})
        return {"nodes": nodes, "edges": edges}

    def _seed_nodes_for(self, query):
        ql = query.lower()
        hits = [n for n in self.g if n != ROOT and (n.lower() in ql or
                any(w in n.lower() for w in ql.split() if len(w) > 3))]
        return hits or [n for n in self.g if n != ROOT]

    def subgraph_for(self, query, hops=2, max_nodes=40):
        """Return a compact text serialization of the relevant subgraph so the
        chat prompt can answer multi-hop questions across facts."""
        seeds = self._seed_nodes_for(query)
        und = self.g.to_undirected()
        keep = set(seeds) | {ROOT}
        frontier = set(seeds)
        for _ in range(hops):
            nxt = set()
            for n in frontier:
                nxt |= set(und.neighbors(n))
            keep |= nxt
            frontier = nxt
            if len(keep) >= max_nodes:
                break
        lines = []
        for s, t, a in self.g.edges(data=True):
            if s in keep and t in keep:
                lines.append(f"- {self.g.nodes[s].get('label', s)} "
                             f"{a.get('predicate', 'related_to')} "
                             f"{self.g.nodes[t].get('label', t)}")
        return "\n".join(sorted(set(lines))[:max_nodes])

    def reasoning_paths(self, query, max_paths=5):
        """Human-readable multi-hop chains used to answer `query`, e.g.
        "You → takes → Metformin → prescribed_by → Dr. Smith". Walks outward
        from the seed nodes up to ~3 hops over the directed graph. Returns []
        when there are no seeds or no edges."""
        if self.g.number_of_edges() == 0:
            return []
        seeds = self._seed_nodes_for(query)
        if not seeds:
            return []

        def label(n):
            return self.g.nodes[n].get("label", n)

        out, seen = [], set()

        def walk(node, parts, hop):
            if hop >= 3:
                return
            for _, t, e in self.g.out_edges(node, data=True):
                if t in parts:  # don't revisit nodes in this chain
                    continue
                chain = parts + [e.get("predicate", "related_to"), label(t)]
                text = " → ".join(chain)
                if len(chain) >= 5 and text not in seen:  # at least 2 hops
                    seen.add(text)
                    out.append(text)
                walk(t, chain, hop + 1)

        # Prefer chains that pass through a seed: start from the root + seeds.
        starts = [ROOT] if ROOT in self.g else []
        starts += [s for s in seeds if s not in starts]
        for s in starts:
            if s not in self.g:
                continue
            walk(s, [label(s)], 0)
            if len(out) >= max_paths * 3:  # gather a few, dedup, then cap below
                break

        # Keep chains that actually mention a seed when seeds were specific.
        prioritized = [p for p in out if any(seed.lower() in p.lower() for seed in seeds)]
        chosen = prioritized or out
        return chosen[:max_paths]

    def node_detail(self, nid):
        nid = self._resolve(nid) or nid
        if nid not in self.g:
            return {"label": nid, "type": "Topic", "facts": [], "provenance": [], "timeline": []}
        a = self.g.nodes[nid]
        facts, prov, timeline = [], set(a.get("provenance", [])), []
        for _, t, e in self.g.out_edges(nid, data=True):
            facts.append({"predicate": e.get("predicate"), "other": t,
                          "direction": "out", "provenance": e.get("provenance", [])})
            prov |= set(e.get("provenance", []))
            timeline.append({"when": e.get("t_recorded"), "what": f"{nid} {e.get('predicate')} {t}"})
        for s, _, e in self.g.in_edges(nid, data=True):
            facts.append({"predicate": e.get("predicate"), "other": s,
                          "direction": "in", "provenance": e.get("provenance", [])})
            prov |= set(e.get("provenance", []))
        return {"label": a.get("label", nid), "type": a.get("type", "Topic"),
                "facts": facts, "provenance": sorted(prov),
                "timeline": sorted(timeline, key=lambda x: x["when"] or "")}

    def extract_and_add(self, text, source, tier="cloud", llm_call=None):
        """Extract typed triples from `text` and upsert them. `llm_call` is an
        injectable function(messages, tier, system, fmt) -> raw string; defaults
        to the real Ollama call. Returns the list of added facts."""
        call = llm_call or (lambda messages, tier=tier, system="", fmt="json":
                            _chat_once(messages, tier, system=system, fmt=fmt))
        try:
            raw = call([{"role": "user", "content": _untrusted(source, text)}], tier,
                       EXTRACTION_SYSTEM, "json")
        except Exception:
            return []
        data = _parse(raw)
        types = {e["name"]: e["type"] for e in data["entities"]}
        types.setdefault(ROOT, "Person")
        added = []
        for r in data["relations"]:
            if self.upsert_relation(r["subject"], r["predicate"], r["object"],
                                    source=source, node_types=types,
                                    valid_time=r.get("valid_time"), confidence=0.8):
                added.append({"subject": r["subject"], "predicate": r["predicate"],
                              "object": r["object"]})
        if added:
            self.save()
        return added
