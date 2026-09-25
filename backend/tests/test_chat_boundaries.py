"""Provider-boundary regressions: synthetic sources, no network or signatures."""
import hashlib
import json
import socket

import pytest
from fastapi.testclient import TestClient

from backend import config, main
from backend.engine import context, llm
from backend.engine.ontology import Ontology
from backend.marketplace import preferences


@pytest.fixture
def isolated(monkeypatch, tmp_path):
    def denied(*args, **kwargs):
        raise AssertionError("network must not be used by boundary tests")

    monkeypatch.setattr(socket, "getaddrinfo", denied)
    monkeypatch.setattr(socket.socket, "connect", denied)
    monkeypatch.setenv("HOLON_READONLY", "0")
    monkeypatch.setenv("HOLON_TOKEN", "")
    monkeypatch.setenv("OLLAMA_API_KEY", "synthetic-boundary-key")
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    monkeypatch.setattr(main, "HISTORY", tmp_path / "history.json")
    monkeypatch.setattr(main, "ONTO", Ontology(tmp_path / "graph.json"))
    monkeypatch.setattr(main.memory, "mem_add", lambda *a, **k: None)
    monkeypatch.setattr(main.ONTO, "extract_and_add", lambda *a, **k: [])
    monkeypatch.setattr(context, "mem_search", lambda *a, **k: [])
    monkeypatch.setattr(context, "retrieve", lambda *a, **k: [])
    monkeypatch.setattr(context, "recent_document_chunks", lambda *a, **k: [])
    return TestClient(main.app)


def events(response):
    return [(block.splitlines()[0][7:], json.loads(block.split("\ndata: ", 1)[1]))
            for block in response.text.split("\n\n") if block.startswith("event: ")]


@pytest.mark.parametrize("query", ["summarize the uploaded document", "what is the project code?"])
@pytest.mark.parametrize("tier,opt_in,expect_docs", [
    ("cloud", False, False), ("cloud", True, True), ("local", False, True)])
def test_document_permission_gates_document_text_only(isolated, monkeypatch, tier, opt_in, expect_docs, query):
    """On a cloud tier with documents off, document excerpts never leave; the
    ontology, memories and the transcript still do (the gateway redacts them).
    Opting in, or the local tier, sends the excerpts."""
    config.set_tier(tier)
    preferences.update({"privacy": {"cloud_documents": opt_in}})
    doc_marker, mem_marker, graph_marker = "DOC_CANARY_QZXV", "MEM_CANARY_QZXV", "GRAPH_CANARY_QZXV"
    docs, outgoing = [], []

    def ingest(title, text, tag):
        docs.append({"text": text, "meta": {"title": title}})
        return 1

    monkeypatch.setattr(main.rag, "ingest_text", ingest)
    monkeypatch.setattr(context, "retrieve", lambda *a, **k: docs)
    monkeypatch.setattr(context, "recent_document_chunks", lambda *a, **k: docs)
    monkeypatch.setattr(context, "mem_search", lambda *a, **k: [{"memory": mem_marker}])
    main.ONTO.upsert_relation("You", "works_on", graph_marker, source="turn:1")
    main._save_history([{"role": "assistant", "content": "an earlier answer"},
                        {"role": "user", "content": "keep this earlier turn", "stored_meta": 1}])

    def stream(messages, tier, system=""):
        outgoing.append({"messages": messages, "system": system})
        yield "synthetic answer"

    monkeypatch.setattr(main.llm, "chat_stream", stream)
    result = isolated.post("/api/ingest", json={"title": "synthetic", "text": doc_marker}).json()
    assert bool(result.get("documents_local_only")) is (not expect_docs)
    response = isolated.post("/api/chat", json={"message": query})
    emitted = events(response)
    assert emitted[-1][0] == "done"
    sent = json.dumps(outgoing)
    assert (doc_marker in sent) is expect_docs
    assert mem_marker in sent and graph_marker in sent          # never withheld: gateway-redacted context
    assert "keep this earlier turn" in sent and "an earlier answer" in sent
    assert all(set(m) == {"role", "content"} for m in outgoing[0]["messages"])   # storage metadata never leaves
    route = next(data for event, data in emitted if event == "route")
    assert route["documents_local_only"] is (not expect_docs)
    if not expect_docs:
        assert "withheld" in route["context_note"] and "withheld" in outgoing[0]["system"]


def test_opt_out_does_not_fetch_document_text(monkeypatch):
    def forbidden(*a, **k):
        raise AssertionError("withheld documents must not even be retrieved")
    for name in ("retrieve", "recent_document_chunks"):
        monkeypatch.setattr(context, name, forbidden)
    monkeypatch.setattr(context, "mem_search", lambda *a, **k: [{"memory": "a memory"}])
    system = context.build_system("summarize", graph_text="PRIVATE_GRAPH", allow_documents=False)
    assert "PRIVATE_GRAPH" in system and "a memory" in system and "withheld" in system




@pytest.mark.parametrize("partial", [False, True])
def test_provider_failure_is_terminal_and_never_a_normal_saved_reply(isolated, monkeypatch, partial):
    config.set_tier("cloud")
    monkeypatch.setattr(main.llm, "cloud_configured", lambda *a: True)
    extraction = []
    monkeypatch.setattr(main.ONTO, "extract_and_add", lambda *a, **k: extraction.append(a) or [])

    def fail(messages, tier, system=""):
        if partial:
            yield "useful partial text"
        raise llm.LLMError("synthetic failure", kind="timeout", partial=partial)
    monkeypatch.setattr(main.llm, "chat_stream", fail)
    emitted = events(isolated.post("/api/chat", json={"message": "synthetic question"}))
    assert emitted[-1] == ("error", "synthetic failure")
    assert "done" not in [event for event, _ in emitted]
    assert any(event == "token" for event, _ in emitted) is partial
    stored = json.loads(main.HISTORY.read_text())
    assert [message["role"] for message in stored] == ["user"]
    assert not extraction


def test_empty_provider_stream_is_an_error(isolated, monkeypatch):
    config.set_tier("cloud")
    monkeypatch.setattr(main.llm, "chat_stream", lambda *a, **k: iter([]))
    emitted = events(isolated.post("/api/chat", json={"message": "hello"}))
    assert emitted[-1][0] == "error" and "no response" in emitted[-1][1]
    assert all(message["role"] == "user" for message in main._load_history())




def test_status_distinguishes_model_studio_configuration_from_ollama_key(isolated, monkeypatch):
    monkeypatch.setitem(config.TIERS, "cloud", {**config.TIERS["cloud"], "api": "openai"})
    config.set_tier("cloud")
    monkeypatch.setenv("MODEL_STUDIO_API_KEY", "synthetic-model-studio-key")
    monkeypatch.setattr(config, "load_api_key", lambda: "")
    monkeypatch.setattr(main.llm, "ollama_running", lambda: False)
    result = isolated.get("/api/status").json()
    assert result["provider"] == "openai-compatible"
    assert result["provider_configured"] is True and result["has_key"] is False
    assert "synthetic-model-studio-key" not in json.dumps(result)
