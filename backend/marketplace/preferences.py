"""Personal Holon preferences for privacy, budget, network and authority.

Stored as JSON in DATA_DIR, with optional per-user preference files.
"""
from datetime import datetime, timezone
import json
import re

from .. import config
from ..atomic_io import atomic_write_json

# a signed-in user (wallet 0x… or website web:…) gets its own policy file;
# anything else is the twin's own
_USER = re.compile(r"^(0x[0-9a-f]{40}|web:[A-Za-z0-9._@:|-]{1,128})$")

RISKS = ("low", "moderate", "high")
AUTHORITIES = ("read-only", "escrow-only", "delegated")
PROTOCOLS = ("general", "data")
NETWORKS = ("xlayer-testnet", "xlayer-mainnet")

# What the PrivacyGateway redacts before anything leaves for a cloud model:
# entity types from the user's own ontology, plus pattern classes. On by default.
PRIVACY_TYPES = ("Person", "Org", "Place", "Condition", "Medication", "HealthMetric")
PRIVACY_PATTERNS = ("email", "phone", "wallet", "id")
PRIVACY_DEFAULTS = {
    "cloud_redaction": True,
    "redact_types": list(PRIVACY_TYPES),
    "redact_patterns": list(PRIVACY_PATTERNS),
    # Documents may name people the ontology does not know yet, and those names
    # cannot be redacted. So on a cloud tier document text stays local unless
    # the user says otherwise; chat turns are still redacted and sent.
    "cloud_documents": False,
}

DEFAULTS = {
    "budget_u": 1.0,
    "risk": "moderate",
    "protocols": ["general", "data"],
    "networks": ["xlayer-testnet", "xlayer-mainnet"],
    "authority": "read-only",
    "health_factor_floor": 1.5,
    "privacy": dict(PRIVACY_DEFAULTS),
}


def _file(user=None):
    """The twin's own file when no user is given; a per-user file for a valid
    user id. An id that is given but malformed is an error — it must never
    quietly land on the shared file."""
    if user is None or user == "":
        return config.DATA_DIR / "holon_preferences.json"
    if not _USER.match(str(user)):
        raise ValueError("invalid user id")
    from .. import identity          # runtime import: identity imports this package
    d = config.DATA_DIR / "wallet_prefs"
    d.mkdir(parents=True, exist_ok=True)
    return d / f"{identity.safe_name(user)}.json"


def get(user=None):
    """Current preferences, defaults filled in. Never raises."""
    prefs = dict(DEFAULTS)
    f = _file(user)
    if f.exists():
        try:
            stored = json.loads(f.read_text())
            if isinstance(stored, dict):
                prefs.update({k: v for k, v in stored.items()
                              if (k in DEFAULTS and k != "privacy") or k == "updated_at"})
                if isinstance(stored.get("privacy"), dict):
                    prefs["privacy"] = {**PRIVACY_DEFAULTS, **stored["privacy"]}
        except (OSError, json.JSONDecodeError):
            pass
    prefs["privacy"] = {**PRIVACY_DEFAULTS, **prefs.get("privacy", {})}
    return prefs


def validate(body):
    """Return (clean, errors). Only known fields; each checked."""
    clean, errors = {}, []
    if "budget_u" in body:
        try:
            b = float(body["budget_u"])
            if b <= 0 or b > 1_000_000:
                raise ValueError
            clean["budget_u"] = b
        except (TypeError, ValueError):
            errors.append("budget_u must be a positive number of U")
    if "risk" in body:
        if body["risk"] in RISKS:
            clean["risk"] = body["risk"]
        else:
            errors.append(f"risk must be one of {', '.join(RISKS)}")
    if "authority" in body:
        if body["authority"] in AUTHORITIES:
            clean["authority"] = body["authority"]
        else:
            errors.append(f"authority must be one of {', '.join(AUTHORITIES)}")
    for key, allowed in (("protocols", PROTOCOLS), ("networks", NETWORKS)):
        if key in body:
            vals = body[key]
            if not isinstance(vals, list) or any(v not in allowed for v in vals):
                errors.append(f"{key} must be a list drawn from {', '.join(allowed)}")
            else:
                clean[key] = list(dict.fromkeys(vals))
    if "health_factor_floor" in body:
        try:
            h = float(body["health_factor_floor"])
            if h < 1.0 or h > 10:
                raise ValueError
            clean["health_factor_floor"] = h
        except (TypeError, ValueError):
            errors.append("health_factor_floor must be between 1.0 and 10")
    if "privacy" in body:
        p = body["privacy"]
        if not isinstance(p, dict):
            errors.append("privacy must be an object")
        else:
            out = {}
            for flag in ("cloud_redaction", "cloud_documents"):
                if flag in p:
                    if isinstance(p[flag], bool):
                        out[flag] = p[flag]
                    else:
                        errors.append(f"privacy.{flag} must be true or false")
            for key, allowed in (("redact_types", PRIVACY_TYPES), ("redact_patterns", PRIVACY_PATTERNS)):
                if key in p:
                    vals = p[key]
                    if not isinstance(vals, list) or any(v not in allowed for v in vals):
                        errors.append(f"privacy.{key} must be a list drawn from {', '.join(allowed)}")
                    else:
                        out[key] = list(dict.fromkeys(vals))
            if out:
                clean["privacy"] = out
    return clean, errors


def update(body, user=None):
    clean, errors = validate(body or {})
    if errors:
        return {"ok": False, "errors": errors, "preferences": get(user)}
    prefs = get(user)
    if "privacy" in clean:
        clean["privacy"] = {**prefs["privacy"], **clean["privacy"]}   # partial updates merge
    prefs.update(clean)
    prefs["updated_at"] = datetime.now(timezone.utc).isoformat()
    atomic_write_json(_file(user), prefs)
    return {"ok": True, "preferences": prefs}


def reset(user=None):
    f = _file(user)
    if f.exists():
        f.unlink()
    return {"ok": True, "preferences": get(user)}


def from_request(raw):
    """A visitor's own policy, carried in the request instead of the shared
    file — used on the public instance so sessions never interfere. Same
    validation as update(); invalid fields fall back to defaults; never raises."""
    if not raw:
        return None
    try:
        body = json.loads(raw) if isinstance(raw, str) else dict(raw)
    except (TypeError, ValueError):
        return None
    clean, _ = validate(body if isinstance(body, dict) else {})
    prefs = dict(DEFAULTS)
    prefs.update(clean)
    prefs["source"] = "visitor"
    return prefs
