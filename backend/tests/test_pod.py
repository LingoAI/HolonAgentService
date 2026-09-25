# holon/backend/tests/test_pod.py
from backend.engine.ontology import Ontology
from backend.sovereignty import pod


def _seeded(tmp_path, name="g.json"):
    o = Ontology(tmp_path / name)
    o.upsert_relation("You", "takes", "Metformin", source="seed",
                      node_types={"You": "Person", "Metformin": "Medication"})
    o.upsert_relation("You", "works_on", "LingoAI", source="seed",
                      node_types={"You": "Person", "LingoAI": "Org"})
    return o


def test_webid_document(tmp_path):
    o = _seeded(tmp_path)
    w = pod.webid_document(o)
    assert "webid" in w["@id"] or w["@id"].startswith("http")
    assert w["name"] == "You"
    assert w["keyId"]


def test_export_bundle_has_all_parts(tmp_path):
    o = _seeded(tmp_path)
    b = pod.export_bundle(o)
    assert {"webid", "turtle", "jsonld", "exported", "stats"} <= set(b)
    assert isinstance(b["turtle"], str) and b["turtle"].strip()
    assert "@prefix" in b["turtle"] or "prefix" in b["turtle"].lower()
    assert "Metformin" in b["turtle"]          # at least one seeded triple
    assert " ." in b["turtle"]                  # a triple terminator
    assert isinstance(b["jsonld"], dict) and "@graph" in b["jsonld"]


def test_slug_roundtrip_unicode_and_symbols():
    for name in ("Alice Smith", "සිංහල", "hello😀", "a/b?c#d"):
        assert pod._unslug(pod._slug(name)) == name


def test_slug_ascii_unchanged():
    assert pod._slug("Alice Smith") == "Alice%20Smith"


def test_export_import_roundtrip(tmp_path):
    src = _seeded(tmp_path, "src.json")
    b = pod.export_bundle(src)
    fresh = Ontology(tmp_path / "fresh.json")
    n = pod.import_bundle(fresh, b)
    assert n >= 1
    assert fresh.stats()["nodes"] == src.stats()["nodes"]
    assert fresh.stats()["edges"] == src.stats()["edges"]
    assert fresh.g.has_edge("You", "Metformin")
    assert fresh.g.has_edge("You", "LingoAI")
