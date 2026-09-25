# holon/backend/tests/test_metalife_routes.py
import importlib
from fastapi.testclient import TestClient


def _client(tmp_path, monkeypatch):
    from backend import config
    from backend.engine import rag, memory
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    rag._get_chroma.cache_clear()
    memory._build.cache_clear()
    import backend.main as main
    importlib.reload(main)
    main.ONTO.upsert_relation("You", "takes", "Metformin", source="seed",
                              node_types={"You": "Person", "Metformin": "Medication"})
    main.ONTO.upsert_relation("You", "measured", "A1c", source="seed",
                              node_types={"You": "Person", "A1c": "HealthMetric"})
    return TestClient(main.app), main


def test_assets_route(tmp_path, monkeypatch):
    c, _ = _client(tmp_path, monkeypatch)
    r = c.get("/api/metalife/assets")
    assert r.status_code == 200
    b = r.json()
    assert b["simulated"] is True
    types = {a["type"] for a in b["assets"]}
    assert "Medication" in types and "HealthMetric" in types


def test_compute_route(tmp_path, monkeypatch):
    c, _ = _client(tmp_path, monkeypatch)
    r = c.post("/api/metalife/compute", json={"type": "Medication", "op": "count"})
    assert r.status_code == 200
    b = r.json()
    assert b["simulated"] is True and b["raw_exposed"] is False
    assert b["result"] == 1


def test_sell_route_increases_earnings(tmp_path, monkeypatch):
    c, _ = _client(tmp_path, monkeypatch)
    r = c.post("/api/metalife/sell", json={"type": "Medication"})
    assert r.status_code == 200
    b = r.json()
    assert b["simulated"] is True and b["earnings"] > 0
    led = c.get("/api/metalife/ledger").json()
    assert led["earnings"] == b["earnings"]


def test_network_route_seeds_peers(tmp_path, monkeypatch):
    c, _ = _client(tmp_path, monkeypatch)
    r = c.get("/api/metalife/network")
    assert r.status_code == 200
    b = r.json()
    assert b["simulated"] is True
    ids = {n["data"]["id"] for n in b["nodes"]}
    assert "You" in ids and len(ids) > 1
    assert "ledger" in b


def test_h2h_route_acknowledges_peer(tmp_path, monkeypatch):
    c, _ = _client(tmp_path, monkeypatch)
    # Discover a real peer id from the network, then handshake it.
    net = c.get("/api/metalife/network").json()
    peer = next(n["data"] for n in net["nodes"] if not n["data"].get("root"))
    r = c.post("/api/metalife/h2h", json={"peer": peer["id"], "kind": "handshake"})
    assert r.status_code == 200
    b = r.json()
    assert b["simulated"] is True
    assert b["peer"] == peer["id"]
    assert b["name"] in b["ack"] and "handshake" in b["ack"]
    # The handshake is recorded in the persisted ledger.
    led = c.get("/api/metalife/ledger").json()
    assert any(e.get("kind") == "h2h" and e.get("peer") == peer["id"]
               for e in led["events"])


def test_offer_route_lists_asset_then_sell_uses_listed_price(tmp_path, monkeypatch):
    c, _ = _client(tmp_path, monkeypatch)
    r = c.post("/api/metalife/offer", json={"type": "Medication", "price": 42.0})
    assert r.status_code == 200
    b = r.json()
    assert b["simulated"] is True
    assert b["offer"]["type"] == "Medication" and b["offer"]["price"] == 42.0
    # A subsequent sale credits the ledger by the listed price, not a derived one.
    sale = c.post("/api/metalife/sell", json={"type": "Medication"}).json()
    assert sale["price"] == 42.0
