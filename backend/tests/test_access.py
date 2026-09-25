# holon/backend/tests/test_access.py
from backend.engine.ontology import Ontology
from backend.sovereignty import access


def _seeded(tmp_path):
    o = Ontology(tmp_path / "g.json")
    o.upsert_relation("You", "takes", "Metformin", source="seed",
                      node_types={"You": "Person", "Metformin": "Medication"})
    o.upsert_relation("You", "works_on", "LingoAI", source="seed",
                      node_types={"You": "Person", "LingoAI": "Org"})
    o.upsert_relation("You", "has_condition", "Diabetes", source="seed",
                      node_types={"You": "Person", "Diabetes": "Condition"})
    return o


def _access(tmp_path, monkeypatch):
    monkeypatch.setattr(access.config, "DATA_DIR", tmp_path)
    return access


def test_grant_creates_token_and_persists(tmp_path, monkeypatch):
    a = _access(tmp_path, monkeypatch)
    g = a.grant("Dr. Smith", ["Medication"])
    assert g["grantee"] == "Dr. Smith"
    assert g["scopes"] == ["Medication"]
    assert g["token"] and len(g["token"]) >= 16
    assert g["id"] and not g["revoked"]
    assert (tmp_path / "access.json").exists()
    assert any(x["id"] == g["id"] for x in a.list_grants())


def test_resolve_returns_active_grant(tmp_path, monkeypatch):
    a = _access(tmp_path, monkeypatch)
    g = a.grant("Dr. Smith", ["Medication"])
    got = a.resolve(g["token"])
    assert got is not None and got["id"] == g["id"]
    assert a.resolve("nonexistent-token") is None


def test_revoke_makes_resolve_return_none(tmp_path, monkeypatch):
    a = _access(tmp_path, monkeypatch)
    g = a.grant("Dr. Smith", ["Medication"])
    a.revoke(g["id"])
    assert a.resolve(g["token"]) is None
    assert any(x["id"] == g["id"] and x["revoked"] for x in a.list_grants())


def test_scoped_graph_only_in_scope_types_plus_root(tmp_path, monkeypatch):
    a = _access(tmp_path, monkeypatch)
    o = _seeded(tmp_path)
    g = a.grant("Dr. Smith", ["Medication"])
    slice_ = a.scoped_graph(o, g["token"])
    ids = {n["data"]["id"] for n in slice_["nodes"]}
    assert "You" in ids                      # root anchor present
    assert "Metformin" in ids                # in-scope
    assert "LingoAI" not in ids              # out-of-scope Org
    assert "Diabetes" not in ids            # out-of-scope Condition
    # only edges between kept nodes survive
    for e in slice_["edges"]:
        assert e["data"]["source"] in ids and e["data"]["target"] in ids


def test_revoked_token_yields_denied(tmp_path, monkeypatch):
    a = _access(tmp_path, monkeypatch)
    o = _seeded(tmp_path)
    g = a.grant("Dr. Smith", ["Medication"])
    a.revoke(g["id"])
    slice_ = a.scoped_graph(o, g["token"])
    assert slice_.get("error") == "revoked"
    assert not slice_.get("nodes")


def test_unknown_token_yields_denied(tmp_path, monkeypatch):
    a = _access(tmp_path, monkeypatch)
    o = _seeded(tmp_path)
    slice_ = a.scoped_graph(o, "bogus")
    assert slice_.get("error") == "revoked"
    assert not slice_.get("nodes")
