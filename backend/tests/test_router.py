# holon/backend/tests/test_router.py
from backend.engine.router import complexity, route
from backend.engine.ontology import Ontology
from backend import config


def _seeded(tmp_path):
    o = Ontology(tmp_path / "g.json")
    o.upsert_relation("You", "takes", "Metformin", source="seed",
                      node_types={"You": "Person", "Metformin": "Medication"})
    o.upsert_relation("Metformin", "prescribed_by", "Dr. Smith", source="seed",
                      node_types={"Metformin": "Medication", "Dr. Smith": "Person"})
    return o


def test_complexity_score_in_range_and_signals():
    r = complexity("Why do I take Metformin and how does it connect across my conditions?")
    assert 0.0 <= r["score"] <= 1.0
    assert isinstance(r["signals"], list) and r["signals"]
    assert "multi_hop" in r


def test_simple_short_query_low_score():
    r = complexity("hi")
    assert r["score"] < 0.5
    assert r["multi_hop"] is False


def test_multi_hop_detected_with_ontology(tmp_path):
    o = _seeded(tmp_path)
    r = complexity("How does Metformin relate to Dr. Smith?", onto=o)
    assert r["multi_hop"] is True


def test_route_manual_selection_always_honored(tmp_path):
    o = _seeded(tmp_path)
    for sel in ("local", "cloud"):
        d = route("Why does this complex thing happen across everything?", sel, o)
        assert d["tier"] == sel
        assert d["auto"] is False
        assert d["reason"] == "manual"


def test_route_auto_simple_query_local():
    d = route("hi", "auto")
    assert d["tier"] == "local"
    assert d["auto"] is True
    assert "Local" in d["reason"]


def test_route_auto_complex_multientity_query_cloud(tmp_path):
    o = _seeded(tmp_path)
    d = route("Why do I take Metformin and how does it connect across Dr. Smith?",
              "auto", o)
    assert d["tier"] == "cloud"
    assert d["auto"] is True
    assert "Cloud" in d["reason"]


def test_route_custom_tier_manual(monkeypatch):
    custom_tier = {
        "model": "custom-model",
        "infer": True,
        "local": False,
        "llm_url": "https://custom.local",
        "collection": "mem0",
        "label": "Custom",
        "tagline": "Custom endpoint",
    }
    monkeypatch.setitem(config.TIERS, "custom", custom_tier)
    d = route("any query here", "custom")
    assert d["tier"] == "custom"
    assert d["auto"] is False
    assert d["reason"] == "manual"
