from backend.engine import rag

def test_is_summarize_query():
    assert rag.is_summarize_query("please summarize the document")
    assert not rag.is_summarize_query("what meds am I on")

def test_chunk_text():
    chunks = rag.chunk_text("x" * 1200)
    assert len(chunks) >= 2 and all(len(c) <= 500 for c in chunks)

def test_ingest_and_retrieve_roundtrip(tmp_path, monkeypatch):
    monkeypatch.setattr(rag.config, "DATA_DIR", tmp_path)
    rag._get_chroma.cache_clear()
    n = rag.ingest_text("Aurora", "Project Aurora launches March 2027 with a solar drone fleet.", "work")
    assert n >= 1
    hits = rag.retrieve("when does Aurora launch")
    assert hits and "Aurora" in hits[0]["text"]
