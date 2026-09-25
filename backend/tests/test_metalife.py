# holon/backend/tests/test_metalife.py
from backend.engine.ontology import Ontology
from backend.metalife import sim


def _seeded(tmp_path):
    o = Ontology(tmp_path / "g.json")
    o.upsert_relation("You", "takes", "Metformin", source="seed",
                      node_types={"You": "Person", "Metformin": "Medication"})
    o.upsert_relation("You", "measured", "A1c", source="seed",
                      node_types={"You": "Person", "A1c": "HealthMetric"})
    o.upsert_relation("You", "works_on", "LingoAI", source="seed",
                      node_types={"You": "Person", "LingoAI": "Org"})
    return o


def _isolate(tmp_path, monkeypatch):
    monkeypatch.setattr(sim.config, "DATA_DIR", tmp_path)
    sim.reset_ledger()
    return sim


def test_data_assets_reflect_seeded_types(tmp_path, monkeypatch):
    m = _isolate(tmp_path, monkeypatch)
    o = _seeded(tmp_path)
    assets = m.data_assets(o)
    assert assets["simulated"] is True
    rows = assets["assets"]
    types = {r["type"]: r for r in rows}
    # one row per node type that has nodes
    assert "Medication" in types and types["Medication"]["count"] >= 1
    assert "HealthMetric" in types
    # no raw rows leaked — only type/count/price
    for r in rows:
        assert set(r.keys()) == {"type", "count", "price"}
        assert r["price"] > 0


def test_compute_to_data_returns_aggregate_no_raw(tmp_path, monkeypatch):
    m = _isolate(tmp_path, monkeypatch)
    o = _seeded(tmp_path)
    res = m.compute_to_data(o, "Medication", "count")
    assert res["simulated"] is True
    assert res["raw_exposed"] is False
    assert res["op"] == "count" and res["type"] == "Medication"
    assert res["result"] == 1
    assert "egress" in res
    # event recorded
    led = m.ledger()
    assert any(e["kind"] == "compute" for e in led["events"])


def test_compute_to_data_exists_and_avg_degree(tmp_path, monkeypatch):
    m = _isolate(tmp_path, monkeypatch)
    o = _seeded(tmp_path)
    assert m.compute_to_data(o, "HealthMetric", "exists")["result"] is True
    assert m.compute_to_data(o, "Condition", "exists")["result"] is False
    avg = m.compute_to_data(o, "Medication", "avg_degree")
    assert isinstance(avg["result"], (int, float))
    assert avg["raw_exposed"] is False


def test_simulate_sale_increases_earnings(tmp_path, monkeypatch):
    m = _isolate(tmp_path, monkeypatch)
    o = _seeded(tmp_path)
    m.marketplace_offer(o, "Medication", 42.0)
    before = m.ledger()["earnings"]
    sale = m.simulate_sale("Medication")
    assert sale["simulated"] is True
    after = m.ledger()["earnings"]
    assert after > before
    assert sale["buyer"]  # deterministic-ish buyer name
    assert any(e["kind"] == "sale" for e in m.ledger()["events"])


def test_peers_and_h2h_network(tmp_path, monkeypatch):
    m = _isolate(tmp_path, monkeypatch)
    m.seed_peers()
    ps = m.peers()
    assert len(ps) >= 1
    assert all("id" in p and "name" in p and "interest" in p for p in ps)
    net = m.h2h_network()
    assert net["simulated"] is True
    ids = {n["data"]["id"] for n in net["nodes"]}
    assert "You" in ids
    roots = [n for n in net["nodes"] if n["data"].get("root")]
    assert roots and roots[0]["data"]["id"] == "You"
    # an edge from You to each peer labelled H2H
    for p in ps:
        assert any(e["data"]["source"] == "You" and e["data"]["target"] == p["id"]
                   and e["data"]["label"] == "H2H" for e in net["edges"])


def test_h2h_message_records_event(tmp_path, monkeypatch):
    m = _isolate(tmp_path, monkeypatch)
    m.seed_peers()
    pid = m.peers()[0]["id"]
    msg = m.h2h_message(pid, "handshake")
    assert msg["simulated"] is True
    assert msg["kind"] == "handshake"
    assert any(e["kind"] == "h2h" for e in m.ledger()["events"])


def test_reset_ledger_clears(tmp_path, monkeypatch):
    m = _isolate(tmp_path, monkeypatch)
    o = _seeded(tmp_path)
    m.simulate_sale("Medication")
    m.reset_ledger()
    led = m.ledger()
    assert led["earnings"] == 0
    assert led["events"] == []
