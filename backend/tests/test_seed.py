# holon/backend/tests/test_seed.py
from backend.engine.ontology import Ontology
from backend import seed

def test_seed_graph_populates_health_and_work(tmp_path):
    o = Ontology(tmp_path / "g.json")
    seed.seed_graph(o)
    assert o.g.has_edge("You", "Metformin")
    assert o.g.has_edge("Metformin", "Dr. Smith")
    assert any(t == "LingoAI" for _, t in o.g.out_edges("You"))
    assert o.stats()["edges"] >= 8
