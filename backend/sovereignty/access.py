"""Revocable, scoped access-control for the personal ontology.

A local implementation of the Solid-style access model: the owner mints
opaque-token grants that expose ONLY a typed slice of their graph to a named
grantee, and can revoke any grant instantly. Grants persist crash-safely to
``DATA_DIR/access.json`` via atomic_write_json. Single-user / localhost, so a
grant carries its own token in the clear — it's the owner's own data.
"""
import json
import secrets
from datetime import datetime, timezone

from .. import config
from ..atomic_io import atomic_write_json
from ..engine.ontology import ROOT, TYPE_COLORS


def _store():
    return config.DATA_DIR / "access.json"


def _now():
    return datetime.now(timezone.utc).isoformat()


def list_grants():
    try:
        return json.loads(_store().read_text())
    except Exception:
        return []


def _save(grants):
    atomic_write_json(_store(), grants)


def grant(grantee, scopes):
    """Create + persist a grant. Returns the full grant incl. its token."""
    g = {
        "id": secrets.token_hex(16),
        "grantee": (grantee or "").strip() or "anonymous",
        "scopes": [s for s in (scopes or []) if isinstance(s, str)],
        "created": _now(),
        "revoked": False,
        "token": secrets.token_hex(16),
    }
    grants = list_grants()
    grants.append(g)
    _save(grants)
    return g


def revoke(grant_id):
    """Mark a grant revoked. Returns True if a grant was found + revoked."""
    grants = list_grants()
    found = False
    for g in grants:
        if g.get("id") == grant_id:
            g["revoked"] = True
            found = True
    if found:
        _save(grants)
    return found


def resolve(token):
    """Return the active (non-revoked) grant for ``token``, else None."""
    if not token:
        return None
    for g in list_grants():
        if g.get("token") == token and not g.get("revoked"):
            return g
    return None


def scoped_graph(onto, token):
    """A to_cytoscape-shaped slice of ``onto`` containing ONLY nodes whose type
    is in the grant's scopes (plus the ROOT anchor) and edges between kept nodes.

    A missing or revoked token returns a denied, empty payload.
    """
    g = resolve(token)
    if g is None:
        return {"error": "revoked", "nodes": [], "edges": []}
    scopes = set(g.get("scopes", []))
    keep = set()
    nodes = []
    for nid, a in onto.g.nodes(data=True):
        ntype = a.get("type", "Topic")
        if nid != ROOT and ntype not in scopes:
            continue
        keep.add(nid)
        nodes.append({"data": {
            "id": nid, "label": a.get("label", nid), "type": ntype,
            "color": TYPE_COLORS.get(ntype, "#9aa0a6"), "root": nid == ROOT}})
    edges = []
    for s, t, a in onto.g.edges(data=True):
        if s in keep and t in keep:
            edges.append({"data": {"source": s, "target": t,
                                   "label": a.get("predicate", "related_to"),
                                   "confidence": a.get("confidence", 1.0)}})
    return {"grantee": g.get("grantee"), "scopes": g.get("scopes", []),
            "nodes": nodes, "edges": edges}
