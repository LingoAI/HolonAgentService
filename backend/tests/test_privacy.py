# holon/backend/tests/test_privacy.py
"""PrivacyGateway: what leaves for a cloud model is redacted against the user's
own ontology and policy, and everything that comes back is restored — in the
streamed reply, in extracted facts, and never in what is stored."""
import importlib
import json
import os

import pytest
from fastapi.testclient import TestClient

from backend import config
from backend.engine import llm, memory, privacy
from backend.marketplace import preferences

ENTRIES = [("Alice Smith", "Person"), ("Alice", "Person"), ("Venus Clinic", "Org"),
           ("Metformin", "Medication"), ("You", "Person"), ("Colombo", "Place")]


@pytest.fixture(autouse=True)
def _fixed_nonce(monkeypatch):
    """Placeholders carry a random per-request nonce; pin it so the fake
    models below can echo the exact tokens the gateway minted."""
    monkeypatch.setattr(privacy, "_nonce", lambda: "ab12")


def test_labels_patterns_and_stable_placeholders():
    gw = privacy.Gateway(ENTRIES)
    text = ("Alice Smith takes metformin, mail alice@example.org or call +94 77 123 4567; "
            "wallet 0xBbA079aC6EA8B309d09620B5894994b63943Ccc0, id 199012345678, in Colombo. "
            "ALICE SMITH again.")
    out = gw.redact(text)
    assert "Alice" not in out and "alice@" not in out and "0xBbA0" not in out
    assert "4567" not in out and "199012345678" not in out and "Colombo" not in out
    # longest label wins and the same person maps to the same placeholder, any casing
    assert out.count("[PERSON_1_ab12]") == 2 and "[PERSON_2_ab12]" not in out
    assert "[MEDICATION_1_ab12]" in out and "[EMAIL_1_ab12]" in out and "[PHONE_1_ab12]" in out
    assert "[WALLET_1_ab12]" in out and "[ID_1_ab12]" in out and "[PLACE_1_ab12]" in out
    assert gw.stats()["total"] == 7 and gw.stats()["redacted"]["PERSON"] == 1
    # the root node and unknown types are never redacted
    assert gw.redact("You know Bob") == "You know Bob"


def test_restore_puts_originals_back_in_any_casing():
    gw = privacy.Gateway(ENTRIES)
    gw.redact("Alice Smith and Metformin")
    assert gw.restore("[PERSON_1_ab12] should keep taking [medication_1_ab12].") == \
        "Alice Smith should keep taking Metformin."
    assert gw.restore("[PERSON_9_ab12] unknown stays") == "[PERSON_9_ab12] unknown stays"


def test_stream_restore_handles_a_placeholder_split_across_tokens():
    gw = privacy.Gateway(ENTRIES)
    gw.redact("Alice Smith Metformin")
    tokens = ["Tell ", "[PER", "SON_1_ab", "12] to take [MEDIC", "ATION_1_ab12] daily [", "not a tag"]
    out = "".join(gw.stream_restore(iter(tokens)))
    assert out == "Tell Alice Smith to take Metformin daily [not a tag"
    # a bare '[' far from any placeholder is released, not held forever
    assert "".join(gw.stream_restore(iter(["x [ and then a lot of text follows here"]))) == \
        "x [ and then a lot of text follows here"


def test_wrap_once_redacts_input_and_restores_output():
    gw = privacy.Gateway(ENTRIES)
    seen = {}

    def fake(messages, tier, system="", fmt=None):
        seen.update(messages=messages, system=system, fmt=fmt)
        return json.dumps({"entities": [{"name": "[PERSON_1_ab12]", "type": "Person"}],
                           "relations": [{"subject": "You", "predicate": "related_to", "object": "[PERSON_1_ab12]"}]})
    out = gw.wrap_once(fake)([{"role": "user", "content": "Alice Smith is my sister"}], "cloud",
                             system="About Alice Smith", fmt="json")
    assert "Alice" not in seen["messages"][0]["content"] and "Alice" not in seen["system"]
    assert seen["fmt"] == "json"
    assert json.loads(out)["relations"][0]["object"] == "Alice Smith"


def test_disabled_gateway_and_policy_from_ontology():
    from backend.engine.ontology import Ontology
    import tempfile, pathlib
    onto = Ontology(pathlib.Path(tempfile.mkdtemp()) / "g.json")
    onto.upsert_entity("Alice Smith", "Person")
    onto.upsert_entity("Venus Clinic", "Org")
    onto.upsert_entity("Running", "Topic")
    off = privacy.Gateway.from_ontology(onto, {"cloud_redaction": False})
    assert off.enabled is False and off.redact("Alice Smith") == "Alice Smith"
    only_people = privacy.Gateway.from_ontology(onto, {"redact_types": ["Person"], "redact_patterns": []})
    out = only_people.redact("Alice Smith at Venus Clinic, alice@example.org")
    assert "[PERSON_1_ab12]" in out and "Venus Clinic" in out and "alice@example.org" in out
    default = privacy.Gateway.from_ontology(onto, None)
    assert "[ORG_1_ab12]" in default.redact("Venus Clinic") and default.redact("Running") == "Running"


def test_preferences_privacy_section_validates_and_merges(monkeypatch, tmp_path):
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    assert preferences.get()["privacy"]["cloud_redaction"] is True
    ok = preferences.update({"privacy": {"redact_types": ["Person"]}})
    assert ok["ok"] and ok["preferences"]["privacy"]["redact_types"] == ["Person"]
    assert ok["preferences"]["privacy"]["cloud_redaction"] is True        # partial update merged
    bad = preferences.update({"privacy": {"cloud_redaction": "yes", "redact_patterns": ["ssn"], "cloud_documents": 1}})
    assert bad["ok"] is False and len(bad["errors"]) == 3
    assert preferences.get()["privacy"]["cloud_documents"] is False          # documents stay local by default
    assert preferences.get()["privacy"]["redact_types"] == ["Person"]


# ---- Model Studio (OpenAI-compatible) provider -------------------------------

def test_model_studio_tier_only_with_a_key():
    assert config._model_studio_tier({}) is None
    t = config._model_studio_tier({"MODEL_STUDIO_API_KEY": "sk-x", "MODEL_STUDIO_MODEL": "qwen-max"})
    assert t["api"] == "openai" and t["model"] == "qwen-max" and t["local"] is False
    assert t["llm_url"].endswith("/compatible-mode/v1")


class _Resp:
    def __init__(self, lines=None, body=None, status=200):
        self._lines, self._body, self.status_code, self.text = lines or [], body, status, ""
    def iter_lines(self):
        return iter(self._lines)
    def json(self):
        return self._body
    def raise_for_status(self):
        pass
    def __enter__(self):
        return self
    def __exit__(self, *a):
        return False


def test_openai_stream_and_once_parse_the_wire_format(monkeypatch):
    monkeypatch.setenv("MODEL_STUDIO_API_KEY", "sk-test")
    monkeypatch.setitem(config.TIERS, "cloud", config._model_studio_tier(os.environ))
    posted = {}

    def fake_post(url, json=None, headers=None, stream=False, timeout=None):
        posted.update(url=url, payload=json, headers=headers)
        if stream:
            return _Resp(lines=[b'data: {"choices":[{"delta":{"content":"Hel"}}]}', b"",
                               b'data: {"choices":[{"delta":{"content":"lo"}}]}', b"data: [DONE]"])
        return _Resp(body={"choices": [{"message": {"content": '{"entities":[]}'}}]})
    monkeypatch.setattr(llm.requests, "post", fake_post)
    assert "".join(llm.chat_stream([{"role": "user", "content": "hi"}], "cloud", system="s")) == "Hello"
    assert posted["url"].endswith("/chat/completions")
    assert posted["headers"]["Authorization"] == "Bearer sk-test"
    assert posted["payload"]["messages"][0] == {"role": "system", "content": "s"}
    assert llm.chat_once([{"role": "user", "content": "x"}], "cloud", fmt="json") == '{"entities":[]}'
    assert posted["payload"]["response_format"] == {"type": "json_object"}
    assert llm.cloud_configured("cloud") is True
    monkeypatch.setenv("MODEL_STUDIO_API_KEY", "")
    assert llm.cloud_configured("cloud") is False


def test_mem0_uses_the_openai_provider_for_model_studio(monkeypatch):
    monkeypatch.setenv("MODEL_STUDIO_API_KEY", "sk-test")
    cfg = memory.build_config("qwen-plus", "mem0", "https://x/compatible-mode/v1", api="openai")
    assert cfg["llm"]["provider"] == "openai"
    assert cfg["llm"]["config"]["openai_base_url"] == "https://x/compatible-mode/v1"
    assert cfg["llm"]["config"]["api_key"] == "sk-test"
    assert memory.build_config("m", "mem0", "http://o")["llm"]["provider"] == "ollama"


# ---- the chat routes with the gateway in front -------------------------------

def _client(tmp_path, monkeypatch):
    from backend.engine import rag
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    rag._get_chroma.cache_clear()
    memory._build.cache_clear()
    import backend.main as main
    importlib.reload(main)
    return TestClient(main.app), main


def _events(resp):
    out = []
    for block in resp.text.split("\n\n"):
        if block.startswith("event: "):
            ev, _, data = block.partition("\ndata: ")
            out.append((ev[7:], json.loads(data) if data else None))
    return out


def test_personal_chat_on_a_cloud_tier_redacts_out_and_restores_in(tmp_path, monkeypatch):
    c, main = _client(tmp_path, monkeypatch)
    main.config.set_tier("cloud")
    preferences.update({"privacy": {"cloud_documents": True}})
    main.ONTO.upsert_entity("Alice Smith", "Person")
    main.ONTO.upsert_entity("Metformin", "Medication")
    seen = {}

    def fake_stream(messages, tier, system=""):
        seen.update(messages=messages, system=system)
        yield from ["[PERSON", "_1_ab12] should keep ", "taking [MEDICATION_1_ab12]."]
    monkeypatch.setattr(main.llm, "chat_stream", fake_stream)
    monkeypatch.setattr(main.llm, "chat_once", lambda messages, tier=None, system="", fmt=None: json.dumps({
        "entities": [{"name": "[PERSON_1_ab12]", "type": "Person"}],
        "relations": [{"subject": "You", "predicate": "related_to", "object": "[PERSON_1_ab12]"}]}))
    added = {}
    monkeypatch.setattr(main.memory, "mem_add", lambda text, tier=None, infer=None: added.update(text=text, infer=infer))
    monkeypatch.setattr(main.context, "build_system", lambda q, tier=None, graph_text="", **kw: f"Facts: Alice Smith takes Metformin. {graph_text}")

    with c.stream("POST", "/api/chat", json={"message": "Should Alice Smith keep taking Metformin?"}) as resp:
        resp.read()
    events = _events(resp)
    route = next(d for ev, d in events if ev == "route")
    assert route["privacy"]["enabled"] is True and route["privacy"]["redacted"]["PERSON"] == 1
    assert route["privacy"]["redacted"]["MEDICATION"] == 1
    # nothing personal left for the cloud…
    assert "Alice" not in seen["system"] and "Metformin" not in seen["system"]
    assert all("Alice" not in m["content"] for m in seen["messages"])
    # …the reply came back restored, streamed in pieces
    assert "".join(d for ev, d in events if ev == "token") == "Alice Smith should keep taking Metformin."
    # memory kept the raw turn locally without a cloud distillation
    assert added["infer"] is False and "Alice Smith" in added["text"]
    # extraction ran through the gateway: the graph gained the real name, no placeholder node
    assert main.ONTO.g.has_edge("You", "Alice Smith") and "[PERSON_1_ab12]" not in main.ONTO.g
    hist = json.loads((tmp_path / "history.json").read_text())
    assert hist[-1]["content"] == "Alice Smith should keep taking Metformin."


def test_local_tier_sends_everything_unredacted(tmp_path, monkeypatch):
    c, main = _client(tmp_path, monkeypatch)
    main.config.set_tier("local")
    main.ONTO.upsert_entity("Alice Smith", "Person")
    seen = {}
    monkeypatch.setattr(main.llm, "chat_stream", lambda messages, tier, system="": (seen.update(messages=messages) or iter(["ok"])))
    monkeypatch.setattr(main.memory, "mem_add", lambda *a, **k: None)
    monkeypatch.setattr(main.ONTO, "extract_and_add", lambda *a, **k: [])
    monkeypatch.setattr(main.context, "build_system", lambda *a, **k: "sys")
    with c.stream("POST", "/api/chat", json={"message": "about Alice Smith"}) as resp:
        resp.read()
    route = next(d for ev, d in _events(resp) if ev == "route")
    assert route["privacy"]["enabled"] is False
    assert seen["messages"][-1]["content"] == "about Alice Smith"


def test_model_studio_answers_for_real(monkeypatch):
    """One tiny real call, only when a key is exported: proves the wire format
    against Alibaba Cloud Model Studio, not a mock."""
    tier = config._model_studio_tier(os.environ)
    if tier is None:
        pytest.skip("Model Studio API key is not configured")
    monkeypatch.setitem(config.TIERS, "cloud", tier)
    out = llm.chat_once([{"role": "user", "content": "Reply with exactly the single word OK"}], "cloud")
    assert "OK" in out.upper()
    assert "".join(llm.chat_stream([{"role": "user", "content": "Reply with exactly: PING"}], "cloud")).strip()


def test_placeholders_are_request_scoped_and_cannot_be_forged(monkeypatch):
    nonces = iter(["aaaa", "bbbb"])
    monkeypatch.setattr(privacy, "_nonce", lambda: next(nonces))
    first, second = privacy.Gateway(ENTRIES), privacy.Gateway(ENTRIES)
    out = first.redact("Alice Smith called")
    assert out == "[PERSON_1_aaaa] called"
    # another request's gateway does not know this token: it stays literal
    second.redact("Alice Smith")                       # mints [PERSON_1_bbbb]
    assert second.restore(out) == "[PERSON_1_aaaa] called"
    # a token typed by the user — legacy shape, or a guessed nonce, even the
    # right one — is defused on the way in and never restores to a real name
    typed = "my friend [PERSON_1] said hi, so did [person_1_aaaa] and [PERSON_7_zzzz]"
    sent = first.redact(typed)
    assert "[PERSON_1_aaaa]" not in sent.replace("[​", "[X")   # only defused copies remain
    back = first.restore(sent)
    assert "Alice" not in back
    assert "[​PERSON_1]" in back and "[​person_1_aaaa]" in back
    # a token the model invents with the right shape but no mapping stays literal
    assert first.restore("[PERSON_3_aaaa] and [ORG_1_aaaa]") == "[PERSON_3_aaaa] and [ORG_1_aaaa]"


def test_dates_and_ip_addresses_are_not_phone_numbers_or_ids():
    gw = privacy.Gateway(ENTRIES)
    text = ("deployed 2026-08-18 14:05, backup 18/08/2026 and 18.08.26, box 10.20.1.205, "
            "call +94 77 123 4567, id 199012345678, block 118938901")
    out = gw.redact(text)
    for keep in ("2026-08-18 14:05", "18/08/2026", "18.08.26", "10.20.1.205"):
        assert keep in out, keep
    assert "+94 77" not in out and "199012345678" not in out
    assert gw.stats()["redacted"] == {"PHONE": 1, "ID": 2}    # the bare 9-digit block is an id: over-redaction, never a leak


def test_document_ingest_goes_through_the_gateway(tmp_path, monkeypatch):
    c, main = _client(tmp_path, monkeypatch)
    main.config.set_tier("cloud")
    main.ONTO.upsert_entity("Alice Smith", "Person")
    seen = {}

    def fake_once(messages, tier=None, system="", fmt=None):
        seen["content"] = messages[-1]["content"]
        return json.dumps({"entities": [{"name": "[PERSON_1_ab12]", "type": "Person"},
                                        {"name": "Venus Clinic", "type": "Org"}],
                           "relations": [{"subject": "[PERSON_1_ab12]", "predicate": "visited", "object": "Venus Clinic"}]})
    monkeypatch.setattr(main.llm, "chat_once", fake_once)
    monkeypatch.setattr(main.rag, "ingest_text", lambda *a, **k: 1)
    # default policy: on a cloud tier a document is indexed locally, never sent
    r = c.post("/api/ingest", json={"title": "visit", "text": "Alice Smith visited Venus Clinic, mail alice@example.org"}).json()
    assert r["chunks"] == 1 and r["facts_added"] == 0 and r["documents_local_only"] is True
    assert "stayed on this machine" in r["privacy_note"] and "content" not in seen
    # the user allows documents to go to the cloud: extraction runs through the gateway
    assert preferences.update({"privacy": {"cloud_documents": True}})["ok"]
    r = c.post("/api/ingest", json={"title": "visit", "text": "Alice Smith visited Venus Clinic, mail alice@example.org"}).json()
    assert r["facts_added"] >= 1 and r["privacy"]["enabled"] is True
    assert r["privacy"]["redacted"] == {"PERSON": 1, "EMAIL": 1}
    assert "privacy_note" in r and "not yet in your graph" in r["privacy_note"]
    # the extractor saw placeholders, the graph got the real name back
    assert "Alice" not in seen["content"] and "alice@" not in seen["content"]
    assert main.ONTO.g.has_edge("Alice Smith", "Venus Clinic") and "[PERSON_1_ab12]" not in main.ONTO.g

    # folder ingest: same boundary (policy still allows documents)
    (tmp_path / "docs").mkdir()
    (tmp_path / "docs" / "note.txt").write_text("Alice Smith again, phone +94 77 123 4567")
    seen.clear()
    r = c.post("/api/ingest/folder", json={"path": str(tmp_path / "docs")}).json()
    assert r["files"] == 1 and r["privacy"]["redacted"] == {"PERSON": 1, "PHONE": 1}
    assert "Alice" not in seen["content"] and "4567" not in seen["content"]

    # documents switched back off: folder import indexes only, nothing leaves
    assert preferences.update({"privacy": {"cloud_documents": False}})["ok"]
    seen.clear()
    r = c.post("/api/ingest/folder", json={"path": str(tmp_path / "docs")}).json()
    assert r["files"] == 1 and r["facts"] == 0 and r["documents_local_only"] is True and not seen
    # local tier: nothing to protect, extraction always runs, no note
    main.config.set_tier("local")
    r = c.post("/api/ingest", json={"title": "n", "text": "Alice Smith"}).json()
    assert r["privacy"]["enabled"] is False and "privacy_note" not in r


def test_placeholder_lookalikes_in_history_system_and_documents_are_inert():
    gw = privacy.Gateway(ENTRIES)
    # history turns and the system prompt are redacted with the same defusing pass
    msgs = gw.redact_messages([{"role": "assistant", "content": "Earlier I said [PERSON_1_ab12] and [PERSON_1]"},
                               {"role": "user", "content": "Alice Smith replied"}])
    assert "[PERSON_1_ab12]" in msgs[1]["content"]                       # the real one, minted for Alice
    assert "[PERSON_1_ab12]" not in msgs[0]["content"] and "[​PERSON_1_ab12]" in msgs[0]["content"]
    system = gw.redact("Facts: [MEDICATION_1_ab12] is safe. [PERSON_1]")
    assert "[​MEDICATION_1_ab12]" in system and "[​PERSON_1]" in system
    # a document that quotes a placeholder cannot restore to a name either
    doc = gw.redact("Report: [PERSON_1_ab12] attended; contact Alice Smith")
    assert gw.restore(doc).count("Alice Smith") == 1
    # malformed shapes stay literal in output
    assert gw.restore("[PERSON_x_ab12] [PERSON_1_ab1] [PERSON_1_ab12") == "[PERSON_x_ab12] [PERSON_1_ab1] [PERSON_1_ab12"


def test_trajectory_keeps_the_question_only_on_a_private_instance(tmp_path, monkeypatch):
    c, main = _client(tmp_path, monkeypatch)
    main.config.set_tier("local")
    monkeypatch.setattr(main.llm, "chat_stream", lambda messages, tier, system="": iter(["ok"]))
    monkeypatch.setattr(main.memory, "mem_add", lambda *a, **k: None)
    monkeypatch.setattr(main.ONTO, "extract_and_add", lambda *a, **k: [])
    monkeypatch.setattr(main.context, "build_system", lambda *a, **k: "sys")
    with c.stream("POST", "/api/chat", json={"message": "about Alice Smith"}) as resp:
        resp.read()
    rec = json.loads((tmp_path / "trajectory.jsonl").read_text().splitlines()[-1])
    assert rec["query"] == "about Alice Smith" and rec["query_len"] == 17 and len(rec["query_sha256"]) == 16
    # a public instance would record only length and digest
    monkeypatch.setenv("HOLON_READONLY", "1")
    assert main._public_instance() is True
