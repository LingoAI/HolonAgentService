# holon/backend/tests/test_rag_degraded.py
import backend.engine.rag as rag

def test_retrieve_safe_when_chroma_down(monkeypatch):
    monkeypatch.setattr(rag, "_get_chroma", lambda: (_ for _ in ()).throw(RuntimeError("down")))
    assert rag.retrieve("anything") == []
    assert rag.list_documents() == []
    assert rag.recent_document_chunks() == []
