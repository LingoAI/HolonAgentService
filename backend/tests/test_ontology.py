# holon/backend/tests/test_ontology.py
import json
from backend.engine.ontology import Ontology, NODE_TYPES, EDGE_PREDICATES

def test_upsert_entity_and_relation_with_provenance(tmp_path):
    o = Ontology(tmp_path / "g.json")
    o.upsert_entity("Metformin", "Medication")
    o.upsert_relation("You", "takes", "Metformin", source="turn:1",
                      node_types={"You": "Person", "Metformin": "Medication"})
    assert "You" in o.g and "Metformin" in o.g
    e = o.g.edges["You", "Metformin"]
    assert e["predicate"] == "takes"
    assert "turn:1" in e["provenance"]
    assert "t_recorded" in e

def test_dedupe_is_case_insensitive(tmp_path):
    o = Ontology(tmp_path / "g.json")
    o.upsert_entity("Dr. Smith", "Person")
    o.upsert_entity("dr. smith", "Person")
    assert len([n for n in o.g if n.lower() == "dr. smith"]) == 1

def test_persistence_roundtrip(tmp_path):
    p = tmp_path / "g.json"
    o = Ontology(p)
    o.upsert_relation("You", "works_on", "LingoAI", source="seed",
                      node_types={"You": "Person", "LingoAI": "Org"})
    o.save()
    assert p.exists()
    o2 = Ontology(p)
    assert o2.g.has_edge("You", "LingoAI")
    assert o2.stats()["edges"] == 1

def test_schema_constants_present():
    assert "Medication" in NODE_TYPES and "Person" in NODE_TYPES
    assert "takes" in EDGE_PREDICATES and "prescribed_by" in EDGE_PREDICATES
