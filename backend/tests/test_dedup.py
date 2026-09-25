"""Near-duplicate detection + node merge. ROOT ('You') is untouchable."""
from backend.engine.ontology import Ontology, ROOT


def _onto(tmp_path):
    return Ontology(tmp_path / "graph.json")


def test_find_duplicates_scores_similar_labels(tmp_path):
    o = _onto(tmp_path)
    o.upsert_entity("Dr. Smith", "Person", source="a")
    o.upsert_entity("dr smith", "Person", source="b")
    o.upsert_entity("LingoAI", "Org", source="a")
    dups = o.find_duplicates()
    assert len(dups) == 1
    assert {dups[0]["keep"], dups[0]["merge"]} == {"Dr. Smith", "dr smith"}
    assert dups[0]["score"] > 0.85


def test_find_duplicates_never_offers_root(tmp_path):
    o = _onto(tmp_path)
    o.upsert_entity("You", "Person", source="a")   # suspiciously close to ROOT
    assert all(ROOT not in (d["keep"], d["merge"]) for d in o.find_duplicates())


def test_merge_rewires_edges_and_provenance(tmp_path):
    o = _onto(tmp_path)
    o.upsert_relation("You", "takes", "Metformin", source="s1",
                      node_types={"Metformin": "Medication"})
    o.upsert_relation("metformin 500", "treats", "Diabetes", source="s2",
                      node_types={"metformin 500": "Medication", "Diabetes": "Condition"})
    assert o.merge_nodes("Metformin", "metformin 500")
    assert "metformin 500" not in o.g
    assert o.g.has_edge("Metformin", "Diabetes")
    assert "s2" in o.g.nodes["Metformin"]["provenance"]


def test_merge_refuses_root_and_unknown(tmp_path):
    o = _onto(tmp_path)
    o.upsert_entity("A", "Topic", source="s")
    assert not o.merge_nodes("A", ROOT)          # ROOT can never be merged away
    assert not o.merge_nodes("A", "A")
    assert not o.merge_nodes("A", "ghost")
