# holon/backend/tests/test_bridge.py
from backend.engine.ontology import Ontology
from backend.sovereignty import bridge


def _seeded(tmp_path):
    o = Ontology(tmp_path / "g.json")
    o.upsert_relation("You", "takes", "Metformin", source="seed",
                      node_types={"You": "Person", "Metformin": "Medication"})
    o.upsert_relation("You", "works_on", "LingoAI", source="chat",
                      node_types={"You": "Person", "LingoAI": "Org"})
    return o


def test_turtle_export_has_prefixes_types_edges_provenance(tmp_path):
    o = _seeded(tmp_path)
    ttl = bridge.ontology_turtle(o)
    assert "@prefix holon:" in ttl and "@prefix rdf:" in ttl
    assert "holon:You rdf:type holon:Person ;" in ttl
    assert 'rdfs:label "You"' in ttl
    assert "holon:You holon:takes holon:Metformin ." in ttl
    assert 'holon:provenance "seed"' in ttl


def test_turtle_escapes_hostile_labels(tmp_path):
    o = Ontology(tmp_path / "g.json")
    o.upsert_relation('Evil"Node', "likes", "A\nB", source='s"rc',
                      node_types={'Evil"Node': "Topic", "A\nB": "Topic"})
    ttl = bridge.ontology_turtle(o)
    assert '\\"' in ttl            # quotes escaped in labels
    assert 'rdfs:label "A B"' in ttl  # newline flattened


def test_attestation_signed_and_deterministic(tmp_path, monkeypatch):
    monkeypatch.setenv("HOLON_TOKEN", "test-secret")
    o = _seeded(tmp_path)
    a1 = bridge.consent_attestation(o, scope="contribution")
    a2 = bridge.consent_attestation(o, scope="contribution")
    assert a1["signature"] == a2["signature"]          # deterministic payload
    assert a1["attestation_hash"] == a2["attestation_hash"]
    assert a1["verification_method"].startswith("lingoai-bridge-v0:")
    assert a1["node_count"] == 3


def test_attestation_changes_with_graph_and_scope(tmp_path, monkeypatch):
    monkeypatch.setenv("HOLON_TOKEN", "test-secret")
    o = _seeded(tmp_path)
    a1 = bridge.consent_attestation(o, scope="contribution")
    a_scope = bridge.consent_attestation(o, scope="marketplace")
    assert a_scope["signature"] != a1["signature"]
    o.upsert_relation("You", "speaks", "Swahili", source="seed",
                      node_types={"Swahili": "Topic"})
    a_grown = bridge.consent_attestation(o, scope="contribution")
    assert a_grown["ontology_sha256"] != a1["ontology_sha256"]


def test_verify_attestation_round_trip(tmp_path, monkeypatch):
    monkeypatch.setenv("HOLON_TOKEN", "test-secret")
    o = _seeded(tmp_path)
    att = bridge.consent_attestation(o, scope="contribution")
    v = bridge.verify_attestation(o, att)
    assert v["valid"] is True and v["ontology_unchanged"] is True
    att["signature"] = "00" * 32
    assert bridge.verify_attestation(o, att)["valid"] is False
