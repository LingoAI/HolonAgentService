# holon/backend/tests/test_website_auth.py
"""Trusting the website's session: JWTs verified against a JWKS / PEM / shared
secret with strict algorithm-key matching and claim checks, opaque sessions
via introspection, and one identity for every per-user route."""
import base64
import hashlib
import hmac
import json
import time

import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, padding, rsa, utils as asym_utils

from backend import identity, website_auth as wa

ISS, AUD = "https://lingoai.io", "holon"


def b64u(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def _jwt(header, payload, sign):
    h, p = b64u(json.dumps(header).encode()), b64u(json.dumps(payload).encode())
    return f"{h}.{p}.{b64u(sign(f'{h}.{p}'.encode()))}"


def rs256(priv, payload, kid="k1", alg="RS256"):
    return _jwt({"alg": alg, "typ": "JWT", "kid": kid}, payload,
                lambda m: priv.sign(m, padding.PKCS1v15(), hashes.SHA256()))


def es256(priv, payload, kid="e1"):
    def sign(m):
        r, s = asym_utils.decode_dss_signature(priv.sign(m, ec.ECDSA(hashes.SHA256())))
        return r.to_bytes(32, "big") + s.to_bytes(32, "big")
    return _jwt({"alg": "ES256", "kid": kid}, payload, sign)


def hs256(secret, payload):
    return _jwt({"alg": "HS256"}, payload, lambda m: hmac.new(secret.encode(), m, hashlib.sha256).digest())


def claims(**over):
    now = int(time.time())
    return {"iss": ISS, "aud": AUD, "sub": "u-123", "iat": now, "exp": now + 600, **over}


@pytest.fixture
def keys(monkeypatch):
    rsa_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    ec_key = ec.generate_private_key(ec.SECP256R1())
    n = rsa_key.public_key().public_numbers()
    e = ec_key.public_key().public_numbers()
    jwks = {"keys": [
        {"kty": "RSA", "kid": "k1", "n": b64u(n.n.to_bytes(256, "big")), "e": b64u(n.e.to_bytes(3, "big"))},
        {"kty": "EC", "crv": "P-256", "kid": "e1", "x": b64u(e.x.to_bytes(32, "big")), "y": b64u(e.y.to_bytes(32, "big"))},
    ]}
    fetched = {"n": 0}

    def fetch(url):
        fetched["n"] += 1
        return jwks["keys"]
    monkeypatch.setattr(wa, "_fetch_jwks", fetch)
    wa._jwks_cache.update(url=None, at=0.0, keys=[])
    wa._introspect_cache.clear()
    monkeypatch.setenv("WEBSITE_AUTH_MODE", "jwt")
    monkeypatch.setenv("WEBSITE_JWT_ISSUER", ISS)
    monkeypatch.setenv("WEBSITE_JWT_AUDIENCE", AUD)
    monkeypatch.setenv("WEBSITE_JWT_JWKS_URL", "https://lingoai.io/.well-known/jwks.json")
    for k in ("WEBSITE_JWT_PUBLIC_KEY", "WEBSITE_JWT_SECRET", "WEBSITE_SESSION_COOKIE"):
        monkeypatch.delenv(k, raising=False)
    return rsa_key, ec_key, fetched


def test_valid_tokens_yield_a_web_user_id(keys):
    rsa_key, ec_key, fetched = keys
    assert wa.verify_jwt(rs256(rsa_key, claims())) == ("web:u-123", None)
    assert wa.verify_jwt(es256(ec_key, claims(sub="abc"))) == ("web:abc", None)
    assert wa.verify_jwt(rs256(rsa_key, claims(aud=["other", AUD]))) == ("web:u-123", None)
    assert fetched["n"] == 1                                   # JWKS cached across tokens


def test_every_claim_and_key_check_is_enforced(keys):
    rsa_key, ec_key, _ = keys
    bad = {
        "wrong issuer": rs256(rsa_key, claims(iss="https://evil.example")),
        "wrong audience": rs256(rsa_key, claims(aud="someone-else")),
        "expired": rs256(rsa_key, claims(exp=int(time.time()) - 600)),
        "no expiry": rs256(rsa_key, {k: v for k, v in claims().items() if k != "exp"}),
        "not yet valid": rs256(rsa_key, claims(nbf=int(time.time()) + 900)),
        "no sub": rs256(rsa_key, claims(sub="")),
        "unknown kid": rs256(rsa_key, claims(), kid="rotated-away"),
        "alg none": _jwt({"alg": "none"}, claims(), lambda m: b""),
        "RS256 header on an EC key": rs256(rsa_key, claims(), kid="e1"),
        "tampered": rs256(rsa_key, claims())[:-6] + "AAAAAA",
        "garbage": "not.a.jwt.at.all",
    }
    for label, tok in bad.items():
        user, reason = wa.verify_jwt(tok)
        assert user is None, label
        assert reason, label
    # a signed token from a key the website does not publish
    stranger = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    assert wa.verify_jwt(rs256(stranger, claims()))[0] is None


def test_shared_secret_and_pem_key_modes(monkeypatch, keys):
    rsa_key, _, _ = keys
    monkeypatch.setenv("WEBSITE_JWT_SECRET", "s3cret")
    assert wa.verify_jwt(hs256("s3cret", claims())) == ("web:u-123", None)
    assert wa.verify_jwt(hs256("wrong", claims()))[0] is None
    pem = rsa_key.public_key().public_bytes(serialization.Encoding.PEM,
                                           serialization.PublicFormat.SubjectPublicKeyInfo).decode()
    monkeypatch.setenv("WEBSITE_JWT_PUBLIC_KEY", pem)
    monkeypatch.delenv("WEBSITE_JWT_JWKS_URL")
    assert wa.verify_jwt(rs256(rsa_key, claims(), kid="anything")) == ("web:u-123", None)
    # an HS256 token cannot be verified with the public key material
    monkeypatch.delenv("WEBSITE_JWT_SECRET")
    assert "no WEBSITE_JWT_SECRET" in wa.verify_jwt(hs256("s3cret", claims()))[1]


def test_configuration_is_reported_not_guessed(monkeypatch):
    for k in ("WEBSITE_AUTH_MODE", "WEBSITE_JWT_ISSUER", "WEBSITE_JWT_JWKS_URL", "WEBSITE_INTROSPECT_URL"):
        monkeypatch.delenv(k, raising=False)
    assert wa.configured() == ("", "off")
    monkeypatch.setenv("WEBSITE_AUTH_MODE", "jwt")
    assert "WEBSITE_JWT_ISSUER" in wa.configured()[1]
    monkeypatch.setenv("WEBSITE_JWT_ISSUER", ISS)
    assert "WEBSITE_JWT_JWKS_URL" in wa.configured()[1]
    monkeypatch.setenv("WEBSITE_JWT_JWKS_URL", "https://x/jwks")
    assert wa.configured() == ("jwt", "")
    monkeypatch.setenv("WEBSITE_AUTH_MODE", "introspect")
    assert "WEBSITE_INTROSPECT_URL" in wa.configured()[1]


def test_introspection_mode_trusts_active_sessions_and_caches(monkeypatch):
    monkeypatch.setenv("WEBSITE_AUTH_MODE", "introspect")
    monkeypatch.setenv("WEBSITE_INTROSPECT_URL", "https://lingoai.io/api/session/introspect")
    monkeypatch.setenv("WEBSITE_INTROSPECT_TOKEN", "server-secret")
    wa._introspect_cache.clear()
    calls = []

    class R:
        def __init__(self, doc): self._d = doc
        def raise_for_status(self): pass
        def json(self): return self._d
    monkeypatch.setattr(wa.requests, "post", lambda url, json=None, headers=None, timeout=None:
                        calls.append((url, json, headers)) or R({"active": json["token"] == "live", "sub": "u-9"}))
    assert wa.introspect("live") == ("web:u-9", None)
    assert calls[0][2]["Authorization"] == "Bearer server-secret" and calls[0][1] == {"token": "live"}
    assert wa.introspect("live") == ("web:u-9", None) and len(calls) == 1      # cached
    assert wa.introspect("dead")[0] is None and len(calls) == 2


def test_identity_helpers():
    assert identity.valid("0x" + "a1" * 20) and identity.valid("web:u@x.io") and not identity.valid("bob")
    # sanitised for the filesystem, then a digest of the exact id so two ids that
    # sanitise alike never share a file; wallet hex is already safe and unchanged
    name = identity.safe_name("web:u@x.io/../etc")
    assert name.startswith("web_u_x.io_.._etc-") and len(name) == len("web_u_x.io_.._etc-") + 8
    assert identity.safe_name("web:a:b") != identity.safe_name("web:a_b")
    assert identity.safe_name("0x" + "a1" * 20) == "0x" + "a1" * 20
    assert identity.normalize("0xABC") == "0xabc" and identity.normalize("web:ABC") == "web:ABC"
