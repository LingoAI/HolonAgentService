"""Who is asking: one answer for every per-user route.

Website sessions identify visitors for personal data routes. X Layer wallet
sessions use their own persistent authentication module.
"""
import hashlib
import re

from . import website_auth

USER_ID = re.compile(r"^(0x[0-9a-f]{40}|web:[A-Za-z0-9._@:|-]{1,128})$")


def current_user(request):
    """Return a valid website session, or None for an invalid subject."""
    user = website_auth.current_user(request)
    return user if valid(user) else None


def valid(user):
    return bool(user) and bool(USER_ID.match(str(user)))


def safe_name(user):
    """A filesystem-safe, collision-free name for a user id. Wallet ids are
    already safe hex. A website id is sanitised for the filesystem and then
    suffixed with a short digest of the exact id, so `web:a:b` and `web:a_b`
    (which sanitise identically) never share a file."""
    user = str(user)
    base = re.sub(r"[^A-Za-z0-9._-]", "_", user)
    if base == user:
        return base
    return f"{base}-{hashlib.sha256(user.encode()).hexdigest()[:8]}"


def normalize(user):
    """Wallet ids are case-insensitive hex; website ids are opaque and kept as issued."""
    if not user:
        return None
    u = str(user).strip()
    return u.lower() if u.lower().startswith("0x") else u
