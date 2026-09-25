"""Persistent, X Layer-only SIWE authentication for the marketplace MVP."""
from __future__ import annotations

import os
import re
import secrets
import time
from datetime import datetime, timezone
from urllib.parse import urlsplit

COOKIE = "xlayer_mvp_session"
SESSION_TTL_S = 7 * 24 * 3600
NONCE_TTL_S = 5 * 60
ADDRESS = re.compile(r"^0x[0-9a-fA-F]{40}$")


def normalize_address(value):
    text = str(value or "")
    return text.lower() if ADDRESS.fullmatch(text) else None


def _rfc3339(value):
    return datetime.fromtimestamp(int(value), timezone.utc).isoformat().replace("+00:00", "Z")


def trusted_origin(network_name=None):
    value = (os.getenv("MVP_PUBLIC_ORIGIN") or os.getenv("HOLON_PUBLIC_URL") or "").strip().rstrip("/")
    if not value and network_name == "local":
        value = "http://localhost:8765"
    if not value:
        raise ValueError("MVP_PUBLIC_ORIGIN is required for wallet sign-in")
    parsed = urlsplit(value)
    if parsed.scheme not in ("http", "https") or not parsed.netloc or parsed.path not in ("", "/") or parsed.query or parsed.fragment:
        raise ValueError("MVP_PUBLIC_ORIGIN must be a bare HTTP(S) origin")
    if network_name != "local" and parsed.scheme != "https" and os.getenv("MVP_ALLOW_INSECURE_ORIGIN") != "1":
        raise ValueError("X Layer Testnet wallet sign-in requires an HTTPS public origin")
    return value


def ensure_request_origin(request, expected_origin):
    expected = urlsplit(expected_origin)
    host = request.headers.get("x-forwarded-host") or request.headers.get("host") or ""
    scheme = request.headers.get("x-forwarded-proto") or request.url.scheme
    actual = f"{scheme}://{host}".rstrip("/")
    if actual.lower() != f"{expected.scheme}://{expected.netloc}".lower():
        raise ValueError("request origin does not match the configured SIWE origin")


def issue(store, *, address, requester_key, origin, chain_id):
    address = normalize_address(address)
    if not address:
        raise ValueError("address must be a 0x EOA address")
    if chain_id not in (196, 1952, 31337):
        raise ValueError("wallet sign-in is limited to configured X Layer networks or local development")
    now = int(time.time())
    nonce = secrets.token_hex(16)
    domain = urlsplit(origin).netloc
    message = (
        f"{domain} wants you to sign in with your Ethereum account:\n"
        f"{address}\n\n"
        "Sign in to the public fixed-bounty task marketplace. This signature costs nothing "
        "and sends no transaction. Only EOA wallets are supported.\n\n"
        f"URI: {origin}\n"
        "Version: 1\n"
        f"Chain ID: {chain_id}\n"
        f"Nonce: {nonce}\n"
        f"Issued At: {_rfc3339(now)}\n"
        f"Expiration Time: {_rfc3339(now + NONCE_TTL_S)}"
    )
    store.issue_nonce(nonce=nonce, address=address, requester_key=requester_key, domain=domain,
                      uri=origin, message=message, expires_at=now + NONCE_TTL_S)
    return {"nonce": nonce, "message": message, "expiresAt": now + NONCE_TTL_S}


async def verify(store, *, nonce, signature, recover):
    row = store.consume_nonce(str(nonce or ""))
    if not row:
        raise ValueError("nonce is unknown, expired, or already consumed")
    result = await recover(row["message"], str(signature or ""))
    recovered = normalize_address(result)
    if not recovered or recovered != row["address"]:
        raise ValueError("signature was made by a different address")
    return recovered, store.create_session(recovered, SESSION_TTL_S)


def current_user(store, request):
    return store.session_address(request.cookies.get(COOKIE, ""))


def logout(store, request):
    store.revoke_session(request.cookies.get(COOKIE, ""))
