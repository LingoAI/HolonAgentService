# holon/backend/tests/test_reasoning_paths.py
from backend.engine.ontology import Ontology


def test_reasoning_paths_returns_chain(tmp_path):
    o = Ontology(tmp_path / "g.json")
    o.upsert_relation("You", "takes", "Metformin", source="seed",
                      node_types={"You": "Person", "Metformin": "Medication"})
    o.upsert_relation("Metformin", "prescribed_by", "Dr. Smith", source="seed",
                      node_types={"Metformin": "Medication", "Dr. Smith": "Person"})
    paths = o.reasoning_paths("What about Metformin?")
    assert isinstance(paths, list) and paths
    assert any("Metformin" in p for p in paths)
    assert any("→" in p for p in paths)


def test_reasoning_paths_empty_graph(tmp_path):
    o = Ontology(tmp_path / "g.json")  # only the root "You" node
    assert o.reasoning_paths("anything") == []


def test_reasoning_paths_capped(tmp_path):
    o = Ontology(tmp_path / "g.json")
    for i in range(10):
        o.upsert_relation("You", "did", f"Event{i}", source="seed",
                          node_types={"You": "Person", f"Event{i}": "Event"})
    paths = o.reasoning_paths("You", max_paths=3)
    assert len(paths) <= 3
