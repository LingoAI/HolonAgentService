# holon/backend/tests/test_cypher_export.py
"""Cypher export: serialise the ontology as Neo4j-loadable MERGE statements so the
twin's graph can be opened in Neo4j Desktop / Aura / Bloom. Pure text generation —
no driver, no server, fully sovereign."""
import importlib
from fastapi.testclient import TestClient
from backend import config
from backend.cypher import export_cypher
from backend.engine.ontology import Ontology


def _onto(tmp_path):
    o = Ontology(tmp_path / "g.json")
    o.upsert_relation("You", "takes", "Metformin", source="seed",
                      node_types={"You": "Person", "Metformin": "Medication"})
    return o


def test_nodes_become_typed_merges(tmp_path):
    cy = export_cypher(_onto(tmp_path))
    assert 'MERGE (:Person {name: "You"' in cy
    assert 'MERGE (:Medication {name: "Metformin"' in cy


def test_relations_become_uppercase_rel_merges(tmp_path):
    cy = export_cypher(_onto(tmp_path))
    assert 'MATCH (a {name: "You"}), (b {name: "Metformin"})' in cy
    assert "MERGE (a)-[:TAKES" in cy


def test_quotes_and_backslashes_are_escaped(tmp_path):
    o = Ontology(tmp_path / "g.json")
    o.upsert_relation("You", "prefers", 'The "Dark" Roast\\Blend',
                      node_types={"You": "Person"})
    cy = export_cypher(o)
    assert '\\"Dark\\"' in cy and "Roast\\\\Blend" in cy


def test_provenance_kept_as_property(tmp_path):
    cy = export_cypher(_onto(tmp_path))
    assert 'source: "seed"' in cy


def test_route_serves_plain_text_cypher(tmp_path, monkeypatch):
    from backend.engine import rag, memory
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    rag._get_chroma.cache_clear()
    memory._build.cache_clear()
    import backend.main as main
    importlib.reload(main)
    c = TestClient(main.app)
    r = c.get("/api/pod/export.cypher")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/plain")
    assert "MERGE" in r.text
