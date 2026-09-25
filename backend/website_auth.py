"""Trusting the LingoAI website's session — the release-version login.

When each website user gets their own Holon, the backend must accept the
website's session and derive an immutable user id from it, never from a header
the browser can forge. This module does exactly that and nothing else; what a
user id unlocks is decided by the routes (see identity.current_user).

Two mechanisms, chosen by ``WEBSITE_AUTH_MODE``:

  jwt         the website issues signed JWTs (OIDC-style). Verified here with
              the issuer's JWKS (``WEBSITE_JWT_JWKS_URL``), a single PEM public
              key (``WEBSITE_JWT_PUBLIC_KEY``) or a shared secret
              (``WEBSITE_JWT_SECRET``, HS256). ``iss``/``aud``/``exp``/``nbf``
              are enforced; the stable id is the ``WEBSITE_JWT_USER_CLAIM``
              claim (default ``sub``).
  introspect  the website keeps opaque sessions: the token is POSTed to
              ``WEBSITE_INTROSPECT_URL`` with a server-to-server bearer
              (``WEBSITE_INTROSPECT_TOKEN``); an ``active`` answer carrying the
              user claim is trusted.

The token arrives as ``Authorization: Bearer …`` or in the cookie named by
``WEBSITE_SESSION_COOKIE``. Verification is done with ``cryptography`` only —
the same library the Solid layer signs with — with an algorithm allowlist and
key-type checks, so an ``alg`` swap cannot turn a public key into a secret.
Unset mode = the feature is off and every request is anonymous.
"""
import base64
import hashlib
import hmac
import json
import os
import threading
import time

import requests
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, padding, rsa, utils as asym_utils

ALLOWED_ALGS = ("RS256", "ES256", "HS256")
LEEWAY_S = 60
JWKS_TTL_S = 600
INTROSPECT_TTL_S = 60
PREFIX = "web:"

_lock = threading.Lock()
_jwks_cache = {"url": None, "at": 0.0, "keys": []}
_introspect_cache = {}      # sha256(token) -> (expires_at, user_id)


def settings(env=None):
    env = os.environ if env is None else env
    g = lambda k: (env.get(k) or "").strip()  # noqa: E731
    mode = g("WEBSITE_AUTH_MODE").lower()
    return {
        "mode": mode if mode in ("jwt", "introspect") else "",
        "issuer": g("WEBSITE_JWT_ISSUER"), "audience": g("WEBSITE_JWT_AUDIENCE"),
        "jwks_url": g("WEBSITE_JWT_JWKS_URL"), "public_key": g("WEBSITE_JWT_PUBLIC_KEY"),
        "secret": g("WEBSITE_JWT_SECRET"), "user_claim": g("WEBSITE_JWT_USER_CLAIM") or "sub",
        "cookie": g("WEBSITE_SESSION_COOKIE"),
        "introspect_url": g("WEBSITE_INTROSPECT_URL"), "introspect_token": g("WEBSITE_INTROSPECT_TOKEN"),
    }


def configured(env=None):
    """(mode, problem): the mode when usable, or what is missing for it."""
    s = settings(env)
    if not s["mode"]:
        return "", "off"
    if s["mode"] == "jwt":
        if not s["issuer"]:
            return "", "jwt mode needs WEBSITE_JWT_ISSUER"
        if not (s["jwks_url"] or s["public_key"] or s["secret"]):
            return "", "jwt mode needs WEBSITE_JWT_JWKS_URL, WEBSITE_JWT_PUBLIC_KEY or WEBSITE_JWT_SECRET"
        return "jwt", ""
    if not s["introspect_url"]:
        return "", "introspect mode needs WEBSITE_INTROSPECT_URL"
    return "introspect", ""


# ---- tokens -----------------------------------------------------------------

def _b64d(segment):
    s = str(segment)
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _fetch_jwks(url):
    r = requests.get(url, timeout=10)
    r.raise_for_status()
    doc = r.json()
    return list(doc.get("keys") or []) if isinstance(doc, dict) else []


def _jwks(url):
    with _lock:
        fresh = _jwks_cache["url"] == url and time.time() - _jwks_cache["at"] < JWKS_TTL_S
        if not fresh:
            _jwks_cache.update(url=url, at=time.time(), keys=_fetch_jwks(url))
        return list(_jwks_cache["keys"])


def _jwk_to_key(jwk):
    kty = jwk.get("kty")
    if kty == "RSA":
        n = int.from_bytes(_b64d(jwk["n"]), "big")
        e = int.from_bytes(_b64d(jwk["e"]), "big")
        return rsa.RSAPublicNumbers(e, n).public_key()
    if kty == "EC" and jwk.get("crv") == "P-256":
        x = int.from_bytes(_b64d(jwk["x"]), "big")
        y = int.from_bytes(_b64d(jwk["y"]), "big")
        return ec.EllipticCurvePublicNumbers(x, y, ec.SECP256R1()).public_key()
    return None


def _public_key_for(header, s):
    """The verification key for a JWT header, from the PEM or the JWKS (by
    ``kid``; a single-key JWKS needs no kid). None when nothing matches."""
    if s["public_key"]:
        return serialization.load_pem_public_key(s["public_key"].encode())
    if not s["jwks_url"]:
        return None
    keys = _jwks(s["jwks_url"])
    kid = header.get("kid")
    if kid:
        keys = [k for k in keys if k.get("kid") == kid]
    elif len(keys) != 1:
        return None
    if not keys:
        # a rotated key: refresh once, then give up
        with _lock:
            _jwks_cache["at"] = 0.0
        keys = [k for k in _jwks(s["jwks_url"]) if k.get("kid") == kid]
    return _jwk_to_key(keys[0]) if keys else None


def verify_jwt(token, s=None, now=None):
    """(user_id, None) for a valid token, else (None, reason). Signature,
    algorithm/key match, exp/nbf with leeway, issuer and audience are all
    checked; the user claim must be a non-empty string."""
    s = s or settings()
    now = time.time() if now is None else now
    try:
        h_b, p_b, sig_b = str(token).split(".")
        header, payload, sig = json.loads(_b64d(h_b)), json.loads(_b64d(p_b)), _b64d(sig_b)
    except (ValueError, TypeError, json.JSONDecodeError):
        return None, "malformed token"
    alg = header.get("alg")
    if alg not in ALLOWED_ALGS:
        return None, f"algorithm not allowed: {alg}"
    signing_input = f"{h_b}.{p_b}".encode()
    try:
        if alg == "HS256":
            if not s["secret"]:
                return None, "HS256 token but no WEBSITE_JWT_SECRET"
            good = hmac.new(s["secret"].encode(), signing_input, hashlib.sha256).digest()
            if not hmac.compare_digest(sig, good):
                raise InvalidSignature()
        else:
            key = _public_key_for(header, s)
            if key is None:
                return None, "no verification key for this token"
            if alg == "RS256":
                if not isinstance(key, rsa.RSAPublicKey):
                    return None, "RS256 token but the key is not RSA"
                key.verify(sig, signing_input, padding.PKCS1v15(), hashes.SHA256())
            else:  # ES256: JOSE r||s (64 bytes) -> DER for cryptography
                if not isinstance(key, ec.EllipticCurvePublicKey) or len(sig) != 64:
                    return None, "ES256 token but the key or signature shape is wrong"
                der = asym_utils.encode_dss_signature(int.from_bytes(sig[:32], "big"),
                                                      int.from_bytes(sig[32:], "big"))
                key.verify(der, signing_input, ec.ECDSA(hashes.SHA256()))
    except InvalidSignature:
        return None, "signature does not verify"
    except Exception as exc:  # noqa: BLE001 — bad key material, JWKS fetch failure
        return None, f"verification failed: {str(exc)[:80]}"
    exp = payload.get("exp")
    if not isinstance(exp, (int, float)):
        return None, "token has no expiry"
    if exp + LEEWAY_S < now:
        return None, "token expired"
    nbf = payload.get("nbf")
    if isinstance(nbf, (int, float)) and nbf - LEEWAY_S > now:
        return None, "token not yet valid"
    if s["issuer"] and payload.get("iss") != s["issuer"]:
        return None, "wrong issuer"
    if s["audience"]:
        aud = payload.get("aud")
        if not (aud == s["audience"] or (isinstance(aud, list) and s["audience"] in aud)):
            return None, "wrong audience"
    user = payload.get(s["user_claim"])
    if not isinstance(user, str) or not user.strip():
        return None, f"token has no {s['user_claim']} claim"
    return PREFIX + user.strip(), None


def introspect(token, s=None, now=None):
    """Ask the website whether an opaque session token is active; cached one
    minute by token hash so a page of requests is one round trip."""
    s = s or settings()
    now = time.time() if now is None else now
    key = hashlib.sha256(str(token).encode()).hexdigest()
    with _lock:
        hit = _introspect_cache.get(key)
        if hit and hit[0] > now:
            return hit[1], None
    try:
        headers = {"Content-Type": "application/json"}
        if s["introspect_token"]:
            headers["Authorization"] = f"Bearer {s['introspect_token']}"
        r = requests.post(s["introspect_url"], json={"token": token}, headers=headers, timeout=10)
        r.raise_for_status()
        doc = r.json()
    except Exception as exc:  # noqa: BLE001 — the website is down: anonymous, not crashed
        return None, f"introspection failed: {str(exc)[:80]}"
    user = doc.get(s["user_claim"]) or doc.get("user_id") if isinstance(doc, dict) else None
    if not (isinstance(doc, dict) and doc.get("active") and isinstance(user, str) and user.strip()):
        return None, "session not active"
    uid = PREFIX + user.strip()
    with _lock:
        _introspect_cache[key] = (now + INTROSPECT_TTL_S, uid)
    return uid, None


def token_from(request, s=None):
    s = s or settings()
    auth = request.headers.get("authorization", "")
    if auth.startswith("Bearer "):
        return auth[7:].strip()
    if s["cookie"]:
        return str(request.cookies.get(s["cookie"], "")).strip()
    return ""


def current_user(request):
    """``web:<id>`` for a valid website session, else None. Never raises; a
    misconfigured mode or a bad token is an anonymous visitor."""
    mode, _ = configured()
    if not mode:
        return None
    token = token_from(request)
    if not token:
        return None
    user, _ = verify_jwt(token) if mode == "jwt" else introspect(token)
    return user
