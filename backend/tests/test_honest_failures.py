"""Provider failure, identity, and health checks shared by the current app."""
import types

import pytest
from fastapi.testclient import TestClient

from backend import config, identity, main
from backend.engine import llm
from backend.marketplace import preferences


def _client(monkeypatch, tmp_path):
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    return TestClient(main.app)


def test_a_provider_failure_is_an_error_not_an_answer(monkeypatch):
    def refused(*a, **k):
        raise RuntimeError("HTTP 401: invalid api key")
    monkeypatch.setattr(llm.requests, "post", refused)
    monkeypatch.setattr(llm, "endpoint_for", lambda tier: ("http://x", {}, "m"))
    monkeypatch.setattr(llm, "api_kind", lambda tier: "ollama")
    with pytest.raises(llm.LLMError) as exc:
        list(llm.chat_stream([{"role": "user", "content": "hi"}], "cloud", attempts=1))
    assert exc.value.kind == "auth" and exc.value.partial is False
    assert "key" in str(exc.value).lower()


def test_malformed_identity_is_nobody_and_never_the_shared_file(monkeypatch, tmp_path):
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    req = types.SimpleNamespace(cookies={}, headers={})
    monkeypatch.setattr(identity.website_auth, "current_user", lambda r: "web:subject/one")
    assert identity.current_user(req) is None            # a `/` subject is not a session
    with pytest.raises(ValueError):
        preferences._file("web:subject/one")
    # two distinct valid ids that sanitise alike get distinct files
    a, b = preferences._file("web:a:b"), preferences._file("web:a_b")
    assert a != b and a.parent.name == "wallet_prefs"
    assert preferences._file(None).name == "holon_preferences.json"


def test_health_names_the_deployed_revision(monkeypatch, tmp_path):
    c = _client(monkeypatch, tmp_path)
    monkeypatch.setenv("HOLON_REVISION", "abc1234")
    assert c.get("/health").json() == {"ok": True, "revision": "abc1234"}
