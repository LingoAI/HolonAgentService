"""Stage D · Data capital — a clearly-labeled SIMULATION.

This module models the *future* of the Holon roadmap: Compute-to-Data,
a Finance 3.0 data marketplace, and the H2H peer ("MetaLife") network. None of
it moves real value or exposes raw data — every response carries an explicit
``"simulated": true`` flag. The point of the simulation is to demonstrate the
*shape* of the system honestly:

  - Compute-to-Data: an external agent runs an aggregate over your Pod and only
    the aggregate result leaves the machine; raw rows never egress.
  - Finance 3.0: you list a *type* of data asset (type + count + price, never
    raw rows) and a simulated buyer purchases access, crediting a simulated
    earnings ledger.
  - MetaLife H2H: a small fixed set of simulated peer holons you can handshake
    with over the (simulated) H2H protocol.

A ledger persists to ``DATA_DIR/metalife.json`` via atomic_write_json. DATA_DIR
is read at call time (through ``config``) so tests can monkeypatch it.
"""
import json
from datetime import datetime, timezone

from .. import config
from ..atomic_io import atomic_write_json
from ..engine.ontology import NODE_TYPES, ROOT

# A relative "value weight" per node type — purely illustrative pricing inputs.
# Health/medical data is conventionally the most valuable; topics the least.
_TYPE_WEIGHT = {
    "HealthMetric": 12.0, "Condition": 11.0, "Medication": 10.0,
    "Person": 6.0, "Org": 5.5, "Event": 4.0, "Goal": 4.0,
    "Place": 3.0, "Preference": 3.0, "Document": 2.5, "Topic": 1.5,
}

# A fixed pool of simulated buyer names — deterministic-ish purchasing.
_BUYERS = ["Acme Research", "MediCoop DAO", "NorthStar Analytics",
           "OpenInsight Labs", "Helix Bio", "Civic Health Trust"]

# A small fixed set of simulated peer holons for the H2H network.
_PEERS = [
    {"id": "peer:mara", "name": "Mara", "interest": "HealthMetric"},
    {"id": "peer:kenji", "name": "Kenji", "interest": "Goal"},
    {"id": "peer:amara", "name": "Amara", "interest": "Topic"},
    {"id": "peer:luca", "name": "Luca", "interest": "Org"},
]


def _now():
    return datetime.now(timezone.utc).isoformat()


def _store():
    return config.DATA_DIR / "metalife.json"


def _empty_ledger():
    return {"earnings": 0.0, "events": [], "assets": [], "peers": []}


def ledger():
    """Return the current ledger (or a fresh empty one if none persisted)."""
    try:
        data = json.loads(_store().read_text())
    except Exception:
        return _empty_ledger()
    # Backfill any missing keys so callers can rely on the shape.
    base = _empty_ledger()
    base.update({k: data.get(k, base[k]) for k in base})
    return base


def _save(led):
    atomic_write_json(_store(), led)


def reset_ledger():
    """Clear the ledger back to empty + persist."""
    led = _empty_ledger()
    _save(led)
    return led


def _record(led, kind, **fields):
    led["events"].append({"kind": kind, "when": _now(), **fields})


# ---- data assets -----------------------------------------------------------
def _price_for(ntype, count):
    """A simple, deterministic price: a per-type weight times a sub-linear
    function of how many nodes of that type you hold. No raw data involved."""
    weight = _TYPE_WEIGHT.get(ntype, 1.0)
    # sub-linear in count so a bigger dataset is worth more but not unboundedly.
    return round(weight * (count ** 0.5) * 7.5, 2)


def _type_counts(onto):
    counts = {}
    for _, a in onto.g.nodes(data=True):
        t = a.get("type", "Topic")
        counts[t] = counts.get(t, 0) + 1
    return counts


def data_assets(onto):
    """Derive sellable data assets from the ontology: one per NODE_TYPE that has
    nodes. Exposes only type + count + price — never raw rows."""
    counts = _type_counts(onto)
    rows = []
    for t in NODE_TYPES:
        n = counts.get(t, 0)
        if n <= 0:
            continue
        rows.append({"type": t, "count": n, "price": _price_for(t, n)})
    return {"simulated": True, "assets": rows}


# ---- compute-to-data -------------------------------------------------------
def _nodes_of_type(onto, ntype):
    return [nid for nid, a in onto.g.nodes(data=True) if a.get("type") == ntype]


def compute_to_data(onto, query_type, op):
    """Simulate an external agent running an aggregate over your data WITHOUT
    seeing any raw rows. Only the aggregate result leaves the Pod."""
    op = (op or "count").lower()
    nodes = _nodes_of_type(onto, query_type)
    if op == "exists":
        result = len(nodes) > 0
    elif op == "avg_degree":
        if nodes:
            result = round(sum(onto.g.degree(n) for n in nodes) / len(nodes), 3)
        else:
            result = 0
    else:  # count (default)
        op = "count"
        result = len(nodes)
    res = {
        "simulated": True,
        "op": op,
        "type": query_type,
        "result": result,
        "raw_exposed": False,
        "egress": "only the result left your Pod",
    }
    led = ledger()
    _record(led, "compute", op=op, type=query_type, result=result,
            raw_exposed=False)
    _save(led)
    return res


# ---- finance 3.0 marketplace ----------------------------------------------
def marketplace_offer(onto, asset_type, price):
    """Record a simulated listing of a data-asset *type* on the marketplace."""
    try:
        price = round(float(price), 2)
    except (TypeError, ValueError):
        price = 0.0
    counts = _type_counts(onto)
    led = ledger()
    offer = {"type": asset_type, "count": counts.get(asset_type, 0),
             "price": price, "listed": _now()}
    # Replace any existing offer for this type.
    led["assets"] = [a for a in led["assets"] if a.get("type") != asset_type]
    led["assets"].append(offer)
    _record(led, "offer", type=asset_type, price=price)
    _save(led)
    return {"simulated": True, "offer": offer}


def _buyer_for(asset_type, seed):
    """Deterministic-ish buyer pick from a fixed pool."""
    idx = (sum(ord(c) for c in (asset_type or "")) + seed) % len(_BUYERS)
    return _BUYERS[idx]


def simulate_sale(asset_type):
    """Simulate a buyer purchasing access to a listed asset type. Credits the
    simulated earnings ledger by the listed (or a derived) price."""
    led = ledger()
    offer = next((a for a in led["assets"] if a.get("type") == asset_type), None)
    if offer is None:
        # Auto-list at a default price derived from the type weight so a sale
        # can always proceed in the demo.
        price = round(_TYPE_WEIGHT.get(asset_type, 1.0) * 7.5, 2)
        offer = {"type": asset_type, "count": 0, "price": price,
                 "listed": _now()}
        led["assets"].append(offer)
    price = float(offer.get("price", 0.0))
    # Seed the buyer on how many sales have happened so repeat sales rotate.
    n_sales = sum(1 for e in led["events"] if e.get("kind") == "sale")
    buyer = _buyer_for(asset_type, n_sales)
    led["earnings"] = round(float(led.get("earnings", 0.0)) + price, 2)
    _record(led, "sale", type=asset_type, price=price, buyer=buyer)
    _save(led)
    return {"simulated": True, "type": asset_type, "price": price,
            "buyer": buyer, "earnings": led["earnings"]}


# ---- MetaLife H2H network --------------------------------------------------
def seed_peers():
    """Persist the fixed peer set into the ledger if not already present."""
    led = ledger()
    if not led.get("peers"):
        led["peers"] = [dict(p) for p in _PEERS]
        _save(led)
    return led["peers"]


def peers():
    """Return the simulated peer holons (seeding them if empty)."""
    led = ledger()
    if not led.get("peers"):
        return seed_peers()
    return led["peers"]


def h2h_network():
    """A Cytoscape-shaped network: "You" (root) connected to each peer over H2H."""
    ps = peers()
    nodes = [{"data": {"id": ROOT, "label": ROOT, "root": True}}]
    edges = []
    for p in ps:
        nodes.append({"data": {"id": p["id"], "label": p["name"],
                               "interest": p.get("interest", ""), "root": False}})
        edges.append({"data": {"source": ROOT, "target": p["id"], "label": "H2H"}})
    return {"simulated": True, "nodes": nodes, "edges": edges}


def h2h_message(peer_id, kind):
    """Simulate sending/receiving an H2H protocol message to a peer."""
    kind = (kind or "handshake").lower()
    ps = peers()
    peer = next((p for p in ps if p["id"] == peer_id), None)
    name = peer["name"] if peer else peer_id
    led = ledger()
    _record(led, "h2h", peer=peer_id, name=name, message=kind)
    _save(led)
    return {"simulated": True, "kind": kind, "peer": peer_id, "name": name,
            "ack": f"{name} acknowledged the {kind} over the H2H protocol"}
