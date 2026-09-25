"""Portable Pod export/import for the personal ontology.

A real, local implementation of the Solid Pod idea: the whole twin serializes to
standards-aligned RDF (Turtle + JSON-LD) plus a WebID profile document, and that
bundle round-trips back into a fresh ontology. Serialization is hand-rolled
(stdlib only) and deterministic — same graph in, byte-identical strings out.
"""
import secrets
import urllib.parse
from datetime import datetime, timezone

from ..engine.ontology import ROOT, NODE_TYPES, EDGE_PREDICATES

WEBID = "http://localhost:8765/webid#me"
BASE = "http://localhost:8765/onto/"          # base IRI for ontology entities
HOLON_NS = "https://lingoai.example/holon#"    # types + predicates vocabulary

# A stable-per-process key id so the WebID profile always advertises a key.
_KEY_ID = "holon-key-" + secrets.token_hex(8)


def _now():
    return datetime.now(timezone.utc).isoformat()


# ---- IRI helpers -----------------------------------------------------------
def _slug(name):
    """Reversible-enough slug: percent-ish encode anything not URL-safe."""
    return urllib.parse.quote(name, safe="-_.")


def _unslug(slug):
    return urllib.parse.unquote(slug)


def _entity_iri(name):
    return BASE + _slug(name)


def _ttl_escape(s):
    return s.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")


# ---- WebID -----------------------------------------------------------------
def webid_document(onto):
    """A FOAF/Solid-flavoured WebID profile document for the owner."""
    return {
        "@context": {"foaf": "http://xmlns.com/foaf/0.1/",
                     "solid": "http://www.w3.org/ns/solid/terms#"},
        "@id": WEBID,
        "@type": "foaf:Person",
        "name": "You",
        "keyId": _KEY_ID,
        "storage": BASE,
        "stats": onto.stats(),
    }


# ---- Turtle ----------------------------------------------------------------
def to_turtle(onto):
    """Deterministic Turtle serialization of the whole ontology."""
    lines = [
        "@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .",
        "@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .",
        "@prefix foaf: <http://xmlns.com/foaf/0.1/> .",
        f"@prefix holon: <{HOLON_NS}> .",
        f"@prefix : <{BASE}> .",
        "",
    ]
    # Entities (sorted for determinism): type + label.
    for nid in sorted(onto.g.nodes):
        a = onto.g.nodes[nid]
        ntype = a.get("type", "Topic")
        label = a.get("label", nid)
        subj = f"<{_entity_iri(nid)}>"
        lines.append(f'{subj} rdf:type holon:{ntype} ;')
        lines.append(f'    rdfs:label "{_ttl_escape(label)}" .')
    # Relations (sorted): predicate-typed triples.
    for s, t in sorted(onto.g.edges):
        e = onto.g.edges[s, t]
        pred = e.get("predicate", "related_to")
        lines.append(f'<{_entity_iri(s)}> holon:{pred} <{_entity_iri(t)}> .')
    return "\n".join(lines) + "\n"


# ---- JSON-LD ---------------------------------------------------------------
def _context():
    ctx = {"holon": HOLON_NS,
           "label": "http://www.w3.org/2000/01/rdf-schema#label",
           "@base": BASE}
    for p in EDGE_PREDICATES:
        ctx[p] = {"@id": "holon:" + p, "@type": "@id"}
    return ctx


def to_jsonld(onto):
    """JSON-LD document: @context maps predicates, @graph holds typed entities
    with their outgoing relations inlined as @id references."""
    out_edges = {}
    for s, t in onto.g.edges:
        pred = onto.g.edges[s, t].get("predicate", "related_to")
        out_edges.setdefault(s, []).append((pred, t))
    graph = []
    for nid in sorted(onto.g.nodes):
        a = onto.g.nodes[nid]
        node = {
            "@id": _entity_iri(nid),
            "@type": "holon:" + a.get("type", "Topic"),
            "label": a.get("label", nid),
        }
        for pred, t in sorted(out_edges.get(nid, [])):
            node.setdefault(pred, []).append(_entity_iri(t))
        graph.append(node)
    return {"@context": _context(), "@graph": graph}


# ---- Bundle ----------------------------------------------------------------
def export_bundle(onto):
    return {
        "webid": webid_document(onto),
        "turtle": to_turtle(onto),
        "jsonld": to_jsonld(onto),
        "exported": _now(),
        "stats": onto.stats(),
    }


def _iri_to_name(iri):
    if iri.startswith(BASE):
        return _unslug(iri[len(BASE):])
    if iri.startswith("holon:"):
        return iri[len("holon:"):]
    return iri


def _type_from_iri(tiri):
    t = tiri.split("#")[-1].split("/")[-1].split(":")[-1] if tiri else "Topic"
    return t if t in NODE_TYPES else "Topic"


def import_bundle(onto, bundle):
    """Merge an exported bundle's JSON-LD back into ``onto``. Re-upserts every
    entity (with its type) and every relation. Returns the count of facts
    (entities + relations) imported."""
    jsonld = (bundle or {}).get("jsonld") or {}
    graph = jsonld.get("@graph", [])
    count = 0
    types = {}
    # First pass: entities + their types.
    for node in graph:
        name = _iri_to_name(node.get("@id", ""))
        if not name:
            continue
        ntype = _type_from_iri(node.get("@type", ""))
        types[name] = ntype
        onto.upsert_entity(name, ntype, source="pod:import")
        count += 1
    # Second pass: relations.
    for node in graph:
        subj = _iri_to_name(node.get("@id", ""))
        if not subj:
            continue
        for pred in EDGE_PREDICATES:
            objs = node.get(pred)
            if not objs:
                continue
            if isinstance(objs, str):
                objs = [objs]
            for o in objs:
                obj = _iri_to_name(o)
                if onto.upsert_relation(subj, pred, obj, source="pod:import",
                                        node_types=types):
                    count += 1
    onto.save()
    return count
