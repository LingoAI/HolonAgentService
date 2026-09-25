# holon/backend/tests/test_context.py
from backend.engine import context

def test_build_system_includes_all_three_sources(monkeypatch):
    monkeypatch.setattr(context, "mem_search", lambda q, tier=None, limit=6: [{"memory": "Name is Samitha"}])
    monkeypatch.setattr(context, "retrieve", lambda q, n=6: [{"text": "Aurora launches 2027", "meta": {"title": "Aurora"}}])
    monkeypatch.setattr(context, "recent_document_chunks", lambda: [])
    sys = context.build_system("what am I working on", graph_text="- You works_on LingoAI")
    assert "Samitha" in sys and "Aurora" in sys and "LingoAI" in sys
    assert "ground truth" in sys.lower()
