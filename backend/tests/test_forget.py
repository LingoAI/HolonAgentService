"""The right to forget: remove a node + incident edges; ROOT is protected."""
from backend.engine.ontology import Ontology, ROOT
from backend.engine import rag


def _onto(tmp_path):
    return Ontology(tmp_path / "graph.json")


def test_forget_removes_node_and_edges(tmp_path):
    o = _onto(tmp_path)
    o.upsert_relation("You", "takes", "Metformin", source="s",
                      node_types={"Metformin": "Medication"})
    res = o.forget_node("metformin")          # case-insensitive resolve
    assert res == {"removed": True, "edges": 1}
    assert "Metformin" not in o.g


def test_forget_refuses_root_and_unknown(tmp_path):
    o = _onto(tmp_path)
    assert o.forget_node(ROOT) == {"removed": False, "edges": 0}
    assert ROOT in o.g
    assert o.forget_node("ghost") == {"removed": False, "edges": 0}


def test_delete_document(tmp_path, monkeypatch):
    monkeypatch.setattr(rag.config, "DATA_DIR", tmp_path)
    rag._get_chroma.cache_clear()
    rag.ingest_text("tmpdoc", "A tiny document about nothing in particular.", "note")
    assert rag.delete_document("tmpdoc") > 0
    assert not any(d["title"] == "tmpdoc" for d in rag.list_documents())
