# holon/backend/tests/test_solid.py — live SOLID Pod client (mocked HTTP)
import base64
import json

import pytest

from backend.engine.ontology import Ontology
from backend.sovereignty import bridge, solid


CFG = {"base": "http://pod.test", "pod": "http://pod.test/holon/",
       "webid": "http://pod.test/holon/profile/card#me",
       "client_id": "id", "client_secret": "secret",
       "token_url": "http://pod.test/.oidc/token", "source": "test"}


@pytest.fixture(autouse=True)
def fresh_token_cache():
    solid._TOKENS.clear()
    yield


def test_unconfigured_status_is_explicit(monkeypatch):
    monkeypatch.setattr(solid, "config", lambda role="owner": {"pod": None, "source": "env", "role": role})
    st = solid.status()
    assert st["available"] is False and "no Pod configured" in st["reason"]


def test_dpop_proof_is_wellformed_es256():
    key = solid.DPoPKey()
    tok = key.proof("GET", "http://pod.test/holon/data/ontology.ttl?x=1", "tok123")
    h, p, sig = tok.split(".")
    pad = lambda s: s + "=" * (-len(s) % 4)  # noqa: E731
    header = json.loads(base64.urlsafe_b64decode(pad(h)))
    payload = json.loads(base64.urlsafe_b64decode(pad(p)))
    assert header["typ"] == "dpop+jwt" and header["alg"] == "ES256"
    assert header["jwk"]["kty"] == "EC" and header["jwk"]["crv"] == "P-256"
    assert payload["htm"] == "GET"
    assert payload["htu"] == "http://pod.test/holon/data/ontology.ttl"  # query stripped
    assert "ath" in payload
    assert len(base64.urlsafe_b64decode(pad(sig))) == 64  # raw r||s, not DER


def test_publish_writes_turtle_and_acl(monkeypatch):
    calls = []

    class Resp:
        def __init__(self, status, text=""):
            self.status_code = status
            self.text = text
        def json(self):
            return {"access_token": "tok", "expires_in": 300}
        def raise_for_status(self):
            pass

    def fake_post(url, **kw):
        calls.append(("POST", url, kw))
        return Resp(200)

    def fake_request(method, url, headers=None, timeout=None, **kw):
        calls.append((method, url, {"headers": headers, **kw}))
        return Resp(201)

    monkeypatch.setattr(solid.requests, "post", fake_post)
    monkeypatch.setattr(solid.requests, "request", fake_request)
    monkeypatch.setattr(solid, "config", lambda role="owner": dict(CFG) if role == "owner" else {"role": "bridge"})

    onto = Ontology.__new__(Ontology)  # publish only calls pod.to_turtle(onto)
    monkeypatch.setattr("backend.sovereignty.pod.to_turtle", lambda o: "@prefix x: <urn:x> .")
    res = solid.publish(onto, readers=["http://pod.test/buyer/profile/card#me"])

    assert res["write"]["ok"] and res["authorization"]["ok"]
    assert res["consent"]["ok"] and res["consent"]["authorization"]["ok"]
    put_urls = [u for m, u, _ in calls if m == "PUT"]
    # ontology + its ACL, then the consent document + its ACL (Ricky's split:
    # ACL = access mechanism, consent doc = the consent itself)
    assert put_urls == ["http://pod.test/holon/data/ontology.ttl",
                       "http://pod.test/holon/data/ontology.ttl.acl",
                       "http://pod.test/holon/data/ontology-consent.ttl",
                       "http://pod.test/holon/data/ontology-consent.ttl.acl"]
    # every LDP call is DPoP-bound
    for m, u, kw in calls:
        if m == "PUT":
            assert kw["headers"]["authorization"].startswith("DPoP ")
            assert "DPoP" in kw["headers"]


def test_acl_document_grants_read_only_to_readers():
    doc = solid._acl_document("http://p/x.ttl", "http://p/me#i", ["http://p/buyer#b"])
    owner, reader = doc.split("<#reader0>")
    assert "acl:Control" in owner and "http://p/me#i" in owner
    assert "acl:Read." in reader and "acl:Write" not in reader
    assert "http://p/buyer#b" in reader


def test_bridge_attestation_uses_live_pod_webid(monkeypatch, tmp_path):
    monkeypatch.setattr(solid, "config", lambda role="owner": dict(CFG) if role == "owner" else {"role": "bridge"})
    o = Ontology(tmp_path / "g.json")
    o.upsert_relation("You", "speaks", "Swahili", source="s",
                      node_types={"You": "Person", "Swahili": "Topic"})
    att = bridge.consent_attestation(o, scope="test")
    assert att["pod_uri"] == CFG["webid"]
    assert bridge.verify_attestation(o, att)["valid"] is True


def test_bridge_falls_back_to_placeholder_without_pod(monkeypatch, tmp_path):
    monkeypatch.setattr(solid, "config", lambda role="owner": {"pod": None, "role": role})
    o = Ontology(tmp_path / "g.json")
    o.upsert_relation("You", "speaks", "Swahili", source="s",
                      node_types={"You": "Person", "Swahili": "Topic"})
    att = bridge.consent_attestation(o, scope="test")
    assert att["pod_uri"] == bridge.PLACEHOLDER_POD


def test_effective_access_asks_server_not_acl(monkeypatch):
    class Resp:
        def __init__(self, status, content=b"", headers=None, text=""):
            self.status_code = status
            self.content = content
            self.headers = headers or {}
            self.text = text
    seq = {"n": 0}

    def fake_request(method, url, cfg=None, **kw):
        seq["n"] += 1
        if url.endswith(".acl"):
            return Resp(200, text='acl:agent <http://p/buyer#b>;\nacl:agent <http://pod.test/holon/profile/card#me>;')
        return Resp(200, b"@prefix x: <urn:x> .", {"WAC-Allow": 'user="read write"'})
    monkeypatch.setattr(solid, "request", fake_request)
    monkeypatch.setattr(solid.requests, "get", lambda url, **kw: Resp(401))
    monkeypatch.setattr(solid, "config", lambda role="owner": dict(CFG) if role == "owner" else {"role": "bridge"})
    out = solid.effective_access()
    assert out["ok"] and out["reader_read"] and out["public_denied"]
    assert out["reader_identity"] == "owner-fallback"     # no bridge creds mocked
    assert out["wac_allow"] == 'user="read write"'
    assert out["acl_readers"] == ["http://p/buyer#b"]  # owner filtered out


def test_effective_access_fails_when_public_can_read(monkeypatch):
    class Resp:
        def __init__(self, status, content=b"", headers=None, text=""):
            self.status_code, self.content, self.headers, self.text = status, content, headers or {}, text
    monkeypatch.setattr(solid, "request", lambda m, u, cfg=None, **kw: Resp(200, b"x"))
    monkeypatch.setattr(solid.requests, "get", lambda url, **kw: Resp(200, b"x"))
    monkeypatch.setattr(solid, "config", lambda role="owner": dict(CFG) if role == "owner" else {"role": "bridge"})
    assert solid.effective_access()["ok"] is False


def test_pod_attestation_refused_without_pod(monkeypatch, tmp_path):
    monkeypatch.setattr(solid, "config", lambda role="owner": {"pod": None, "role": role})
    o = Ontology(tmp_path / "g.json")
    out = bridge.pod_consent_attestation(o, scope="test")
    assert out["ok"] is False and "refused" in out["error"]


def test_pod_attestation_gates_on_effective_access(monkeypatch, tmp_path):
    monkeypatch.setattr(solid, "config", lambda role="owner": dict(CFG) if role == "owner" else {"role": "bridge"})
    o = Ontology(tmp_path / "g.json")
    o.upsert_relation("You", "speaks", "Swahili", source="s",
                      node_types={"You": "Person", "Swahili": "Topic"})
    monkeypatch.setattr(solid, "read_consent", lambda **kw: {"ok": False, "status": 404})
    monkeypatch.setattr(solid, "effective_access", lambda **kw: {"ok": False, "public_denied": False})
    out = bridge.pod_consent_attestation(o, scope="test")
    assert out["ok"] is False and out["pod_check"]["public_denied"] is False

    GOOD_CHECK = {"ok": True, "public_denied": True, "reader_read": True,
                  "reader_identity": "bridge", "reader_webid": "http://p/bridge#me",
                  "resource": "http://pod.test/holon/data/ontology.ttl",
                  "acl_readers": ["http://p/buyer#b", "http://p/bridge#me"]}
    GOOD_CONSENT = {"ok": True, "url": "http://pod.test/holon/data/ontology-consent.ttl",
                    "sha256": "c" * 64, "resource": "http://pod.test/holon/data/ontology.ttl",
                    "consent_id": "consent-001", "status": "active",
                    "scope": "test", "purpose": "demo", "issued": "2026-08-20T00:00:00Z",
                    "expires": "2099-01-01T00:00:00Z",
                    "grantees": ["http://p/buyer#b", "http://p/bridge#me"]}
    monkeypatch.setattr(solid, "effective_access", lambda **kw: dict(GOOD_CHECK))

    # no consent document -> refused, even though access checks pass
    out = bridge.pod_consent_attestation(o, scope="test")
    assert out["ok"] is False and "consent document" in out["error"]

    monkeypatch.setattr(solid, "read_consent", lambda **kw: dict(GOOD_CONSENT))
    out = bridge.pod_consent_attestation(o, scope="test")
    assert out["ok"] is True and out["pod_verified"] is True
    assert out["consent_sha256"] == "c" * 64          # signed into the core
    assert out["bridge_webid"] == "http://p/bridge#me"
    assert out["authorization_method"] == "solid-effective-access+consent-rdf"
    assert bridge.verify_attestation(o, out)["valid"] is True
    # tampering with the consent hash breaks the signature
    tampered = {**out, "consent_sha256": "d" * 64}
    assert bridge.verify_attestation(o, tampered)["valid"] is False

    # expired consent -> refused
    monkeypatch.setattr(solid, "read_consent",
                        lambda **kw: {**GOOD_CONSENT, "expires": "2020-01-01T00:00:00Z"})
    out = bridge.pod_consent_attestation(o, scope="test")
    assert out["ok"] is False and any("expired" in p for p in out["problems"])

    # scope mismatch -> refused
    monkeypatch.setattr(solid, "read_consent", lambda **kw: {**GOOD_CONSENT, "scope": "other"})
    out = bridge.pod_consent_attestation(o, scope="test")
    assert out["ok"] is False and any("scope" in p for p in out["problems"])

    # ACL reader not named in the consent -> refused
    monkeypatch.setattr(solid, "read_consent", lambda **kw: {**GOOD_CONSENT, "grantees": []})
    out = bridge.pod_consent_attestation(o, scope="test")
    assert out["ok"] is False and any("not named" in p for p in out["problems"])
    assert any("not a consent grantee" in p for p in out["problems"])   # bridge itself uncovered

    # revoked/suspended consent status -> refused
    monkeypatch.setattr(solid, "read_consent", lambda **kw: {**GOOD_CONSENT, "status": "revoked"})
    out = bridge.pod_consent_attestation(o, scope="test")
    assert out["ok"] is False and any("status" in p for p in out["problems"])


def test_consent_document_roundtrip(monkeypatch):
    doc = solid.consent_document(
        "http://p/me#i", ["http://p/buyer#b", "http://p/other#o"],
        "http://p/data/ontology.ttl", "contribution", "marketplace access",
        "2026-08-20T00:00:00Z", "2026-11-18T00:00:00Z")

    class Resp:
        status_code = 200
        content = doc.encode()
        text = doc
    monkeypatch.setattr(solid, "request", lambda m, u, cfg=None, **kw: Resp())
    monkeypatch.setattr(solid, "config", lambda role="owner": dict(CFG) if role == "owner" else {"role": "bridge"})
    got = solid.read_consent()
    assert got["ok"] and got["data_subject"] == "http://p/me#i"
    assert got["grantees"] == ["http://p/buyer#b", "http://p/other#o"]
    assert got["resource"] == "http://p/data/ontology.ttl"
    assert got["scope"] == "contribution" and got["purpose"] == "marketplace access"
    assert got["issued"] == "2026-08-20T00:00:00Z" and got["expires"] == "2026-11-18T00:00:00Z"
    import hashlib as h
    assert got["sha256"] == h.sha256(doc.encode()).hexdigest()


def test_revoke_rewrites_owner_only_acls(monkeypatch):
    puts = []

    class Resp:
        status_code = 205
        text = ""
    def fake_request(method, url, cfg=None, **kw):
        if method == "PUT":
            puts.append((url, kw["data"].decode()))
        return Resp()
    monkeypatch.setattr(solid, "request", fake_request)
    monkeypatch.setattr(solid, "config", lambda role="owner": dict(CFG) if role == "owner" else {"role": "bridge"})
    out = solid.revoke()
    assert out["ok"] and len(out["revoked"]) == 2
    urls = [u for u, _ in puts]
    assert urls == ["http://pod.test/holon/data/ontology.ttl.acl",
                    "http://pod.test/holon/data/ontology-consent.ttl.acl"]
    for _, doc in puts:
        assert "acl:Control" in doc          # owner keeps control
        assert "<#reader" not in doc         # nobody else keeps anything
