from backend.engine import memory

def test_mem0_config_uses_ollama_base_url():
    cfg = memory.build_config("gpt-oss:120b-cloud", "mem0_cloud", "https://ollama.com")
    assert cfg["llm"]["config"]["ollama_base_url"] == "https://ollama.com"
    assert cfg["embedder"]["config"]["ollama_base_url"].startswith("http://localhost")
    assert cfg["vector_store"]["config"]["collection_name"] == "mem0_cloud"

def test_safe_calls_return_empty_when_engine_none(monkeypatch):
    monkeypatch.setattr(memory, "_engine", lambda tier=None: (None, "boom"))
    assert memory.mem_search("x") == []
    rows, err = memory.mem_get_all()
    assert rows == [] and err == "boom"
