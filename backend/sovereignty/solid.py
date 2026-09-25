"""Live SOLID Pod client — real Solid-OIDC authorization, not a stand-in.

`pod.py` serializes the ontology; this module talks to an actual Solid server
(Community Solid Server in `solid/`) over authenticated HTTP:

  client credentials  ->  DPoP-bound access token  ->  LDP write/read
                                                   ->  WAC .acl so only the
                                                       granted agent can read

Everything degrades to ``{"available": false, "reason": ...}`` when no Pod is
configured, so the app runs unchanged without one.

Config (env, else ``solid/.credentials.json`` found by walking up the tree):
  SOLID_BASE, SOLID_POD, SOLID_WEBID, SOLID_CLIENT_ID, SOLID_CLIENT_SECRET
"""
import base64
import hashlib
import json
import os
import time
import uuid
from pathlib import Path

import requests
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, utils as asym_utils

TIMEOUT = 15


def _b64u(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


# ---- configuration ---------------------------------------------------------

_ROLE_FILES = {"owner": ".credentials.json", "bridge": ".bridge-credentials.json"}
_ROLE_ENV = {"owner": "SOLID", "bridge": "SOLID_BRIDGE"}


def credentials_file(role="owner"):
    """`solid/.credentials.json` (owner) / `.bridge-credentials.json` (bridge),
    written by solid/scripts-bootstrap.mjs. Walk up so this works in the
    monorepo and the holon-at-root layout."""
    override = os.environ.get(f"{_ROLE_ENV[role]}_CREDENTIALS")
    if override:
        p = Path(override)
        return p if p.exists() else None
    for parent in Path(__file__).resolve().parents:
        cand = parent / "solid" / _ROLE_FILES[role]
        if cand.exists():
            return cand
    return None


def config(role="owner"):
    """Merged config for one identity; env wins over the credentials file.
    Two identities, deliberately separate: the OWNER (the user's WebID — writes
    the Pod, sets ACLs and consent) and the BRIDGE (its own WebID — is only
    ever *granted* Read, never holds the user's key)."""
    data = {}
    path = credentials_file(role)
    if path:
        try:
            data = json.loads(path.read_text())
        except (OSError, json.JSONDecodeError):
            data = {}
    env = _ROLE_ENV[role]
    base = os.environ.get(f"{env}_BASE") or data.get("base")
    cfg = {
        "role": role,
        "base": base,
        "pod": os.environ.get(f"{env}_POD") or data.get("pod"),
        "webid": os.environ.get(f"{env}_WEBID") or data.get("webId"),
        "client_id": os.environ.get(f"{env}_CLIENT_ID") or data.get("clientId"),
        "client_secret": os.environ.get(f"{env}_CLIENT_SECRET") or data.get("clientSecret"),
        "token_url": (os.environ.get(f"{env}_TOKEN_URL") or data.get("tokenUrl")
                      or (f"{base.rstrip('/')}/.oidc/token" if base else None)),
        "source": str(path) if path else "env",
    }
    return cfg


def configured(cfg=None):
    cfg = cfg or config()
    need = ("webid", "client_id", "client_secret", "token_url") if cfg.get("role") == "bridge"         else ("pod", "client_id", "client_secret", "token_url")
    return all(cfg.get(k) for k in need)


# ---- DPoP ------------------------------------------------------------------

class DPoPKey:
    """Ephemeral P-256 key used to bind tokens to this process (RFC 9449)."""

    def __init__(self):
        self._key = ec.generate_private_key(ec.SECP256R1())
        nums = self._key.public_key().public_numbers()
        self.jwk = {"kty": "EC", "crv": "P-256",
                    "x": _b64u(nums.x.to_bytes(32, "big")),
                    "y": _b64u(nums.y.to_bytes(32, "big"))}

    def _es256(self, signing_input: bytes) -> bytes:
        der = self._key.sign(signing_input, ec.ECDSA(hashes.SHA256()))
        r, s = asym_utils.decode_dss_signature(der)      # JWS wants raw r||s
        return r.to_bytes(32, "big") + s.to_bytes(32, "big")

    def proof(self, method: str, url: str, access_token: str | None = None) -> str:
        header = {"alg": "ES256", "typ": "dpop+jwt", "jwk": self.jwk}
        # htu excludes query and fragment
        htu = url.split("?")[0].split("#")[0]
        payload = {"htu": htu, "htm": method.upper(),
                   "jti": str(uuid.uuid4()), "iat": int(time.time())}
        if access_token:
            payload["ath"] = _b64u(hashlib.sha256(access_token.encode()).digest())
        segments = [_b64u(json.dumps(header, separators=(",", ":")).encode()),
                    _b64u(json.dumps(payload, separators=(",", ":")).encode())]
        signing_input = ".".join(segments).encode()
        segments.append(_b64u(self._es256(signing_input)))
        return ".".join(segments)

    def public_pem(self) -> str:
        return self._key.public_key().public_bytes(
            serialization.Encoding.PEM,
            serialization.PublicFormat.SubjectPublicKeyInfo).decode()


_KEYS = {}
_TOKENS = {}


def _key(cfg=None):
    ident = (cfg or {}).get("client_id") or "owner"
    if ident not in _KEYS:
        _KEYS[ident] = DPoPKey()
    return _KEYS[ident]


def access_token(cfg=None, force=False):
    """Client-credentials grant, DPoP-bound. Cached per identity until shortly
    before expiry."""
    cfg = cfg or config()
    cache = _TOKENS.setdefault(cfg.get("client_id") or "owner",
                               {"value": None, "expires_at": 0})
    now = time.time()
    if not force and cache["value"] and cache["expires_at"] > now + 30:
        return cache["value"]
    auth = requests.auth.HTTPBasicAuth(
        requests.utils.quote(cfg["client_id"], safe=""),
        requests.utils.quote(cfg["client_secret"], safe=""))
    res = requests.post(
        cfg["token_url"], auth=auth, timeout=TIMEOUT,
        headers={"DPoP": _key(cfg).proof("POST", cfg["token_url"]),
                 "content-type": "application/x-www-form-urlencoded"},
        data={"grant_type": "client_credentials", "scope": "webid"})
    res.raise_for_status()
    body = res.json()
    cache["value"] = body["access_token"]
    cache["expires_at"] = now + int(body.get("expires_in", 300))
    return cache["value"]


def request(method, url, cfg=None, **kwargs):
    """Authenticated LDP request against the Pod (Authorization: DPoP …)."""
    cfg = cfg or config()
    token = access_token(cfg)
    headers = dict(kwargs.pop("headers", {}) or {})
    headers["authorization"] = f"DPoP {token}"
    headers["DPoP"] = _key(cfg).proof(method, url, token)
    res = requests.request(method, url, headers=headers, timeout=TIMEOUT, **kwargs)
    if res.status_code == 401:                      # token expired mid-flight
        token = access_token(cfg, force=True)
        headers["authorization"] = f"DPoP {token}"
        headers["DPoP"] = _key(cfg).proof(method, url, token)
        res = requests.request(method, url, headers=headers, timeout=TIMEOUT, **kwargs)
    return res


# ---- Pod operations --------------------------------------------------------

ONTOLOGY_PATH = "data/ontology.ttl"
ACL_SUFFIX = ".acl"


def resource_url(path=ONTOLOGY_PATH, cfg=None):
    cfg = cfg or config()
    return cfg["pod"].rstrip("/") + "/" + path.lstrip("/")


def put_turtle(turtle, path=ONTOLOGY_PATH, cfg=None):
    """Write Turtle into the Pod (creates intermediate containers)."""
    cfg = cfg or config()
    url = resource_url(path, cfg)
    res = request("PUT", url, cfg=cfg, data=turtle.encode("utf-8"),
                  headers={"content-type": "text/turtle"})
    return {"ok": res.status_code in (200, 201, 204, 205), "status": res.status_code,
            "url": url, "detail": res.text[:200] if res.status_code >= 400 else None}


def get_turtle(path=ONTOLOGY_PATH, cfg=None, authenticated=True):
    cfg = cfg or config()
    url = resource_url(path, cfg)
    if authenticated:
        res = request("GET", url, cfg=cfg, headers={"accept": "text/turtle"})
    else:                                            # what the public sees
        res = requests.get(url, headers={"accept": "text/turtle"}, timeout=TIMEOUT)
    return {"ok": res.status_code == 200, "status": res.status_code, "url": url,
            "turtle": res.text if res.status_code == 200 else None}


CONSENT_PATH = "data/ontology-consent.ttl"


def consent_document(owner_webid, grantees, resource, scope, purpose,
                     issued, expires, consent_id="consent-001"):
    """The consent itself, as RDF in the Pod — separate from the ACL. The ACL
    only opens access; THIS document says what was consented to: scope,
    purpose, validity window, who granted and who receives. DPV terms where
    they fit (dpv:Consent, dpv:hasPurpose), a small holon vocabulary for the
    rest — a consent receipt, not a claimed DPV conformance."""
    lines = ["@prefix dpv: <https://w3id.org/dpv#>.",
             "@prefix dct: <http://purl.org/dc/terms/>.",
             "@prefix xsd: <http://www.w3.org/2001/XMLSchema#>.",
             "@prefix holonc: <https://lingoai.example/ns/consent#>.", "",
             "<#consent>",
             "    a dpv:Consent;",
             f'    holonc:consentId "{consent_id}";',
             '    holonc:version "1";',
             '    holonc:status "active";',
             f"    holonc:dataSubject <{owner_webid}>;"]
    for g in grantees:
        lines.append(f"    holonc:grantee <{g}>;")
    lines += [f"    holonc:resource <{resource}>;",
              f'    holonc:scope "{scope}";',
              f'    dpv:hasPurpose "{purpose}";',
              f'    dct:issued "{issued}"^^xsd:dateTime;',
              f'    holonc:expires "{expires}"^^xsd:dateTime.']
    return "\n".join(lines) + "\n"


def read_consent(path=CONSENT_PATH, cfg=None):
    """Fetch and parse the Pod's consent document (our own deterministic
    emitter, so a small parser is honest). Returns the fields the Bridge
    must verify plus the document's sha256."""
    import re
    cfg = cfg or config()
    url = resource_url(path, cfg)
    res = request("GET", url, cfg=cfg, headers={"accept": "text/turtle"})
    if res.status_code != 200:
        return {"ok": False, "status": res.status_code, "url": url}
    text = res.text
    def one(pattern):
        m = re.search(pattern, text)
        return m.group(1) if m else None
    return {
        "ok": True, "url": url,
        "sha256": hashlib.sha256(res.content).hexdigest(),
        "data_subject": one(r"holonc:dataSubject\s+<([^>]+)>"),
        "grantees": re.findall(r"holonc:grantee\s+<([^>]+)>", text),
        "resource": one(r"holonc:resource\s+<([^>]+)>"),
        "consent_id": one(r'holonc:consentId\s+"([^"]*)"'),
        "status": one(r'holonc:status\s+"([^"]*)"'),
        "scope": one(r'holonc:scope\s+"([^"]*)"'),
        "purpose": one(r'dpv:hasPurpose\s+"([^"]*)"'),
        "issued": one(r'dct:issued\s+"([^"]+)"'),
        "expires": one(r'holonc:expires\s+"([^"]+)"'),
    }


def _acl_document(resource_url_, owner_webid, readers):
    """WAC document: owner keeps Control, each reader gets Read only."""
    lines = ["@prefix acl: <http://www.w3.org/ns/auth/acl#>.",
             "@prefix foaf: <http://xmlns.com/foaf/0.1/>.", "",
             "<#owner>",
             "    a acl:Authorization;",
             f"    acl:agent <{owner_webid}>;",
             f"    acl:accessTo <{resource_url_}>;",
             "    acl:mode acl:Read, acl:Write, acl:Control."]
    for i, reader in enumerate(readers):
        lines += ["", f"<#reader{i}>",
                  "    a acl:Authorization;",
                  f"    acl:agent <{reader}>;",
                  f"    acl:accessTo <{resource_url_}>;",
                  "    acl:mode acl:Read."]
    return "\n".join(lines) + "\n"


def grant_read(readers, path=ONTOLOGY_PATH, cfg=None):
    """Pod-side authorization: replace the resource ACL so exactly these WebIDs
    may read it. This is the consent step the Bridge later attests to."""
    cfg = cfg or config()
    url = resource_url(path, cfg)
    acl_url = url + ACL_SUFFIX
    doc = _acl_document(url, cfg["webid"], readers)
    res = request("PUT", acl_url, cfg=cfg, data=doc.encode("utf-8"),
                  headers={"content-type": "text/turtle"})
    return {"ok": res.status_code in (200, 201, 204, 205), "status": res.status_code,
            "acl": acl_url, "readers": list(readers),
            "detail": res.text[:200] if res.status_code >= 400 else None}


def effective_access(path=ONTOLOGY_PATH, cfg=None):
    """Behavioural check of the Pod's EFFECTIVE authorization — asks the
    server instead of parsing ACL files. CSS composes permissions from the
    resource ACL, parent containers and auxiliary resources, so only the
    server's own answer is authoritative; probing requests keeps the Bridge
    correct under WAC and ACP alike.

    The read probe authenticates as the BRIDGE's OWN WebID (separate client
    credentials — the Bridge is a distinctly identifiable service agent that
    was *granted* Read, never the owner's key). Falls back to the owner
    identity, labelled, when no bridge credentials exist. The credential-less
    probe must be refused."""
    cfg = cfg or config()
    url = resource_url(path, cfg)
    out = {"resource": url, "checked_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    bridge_cfg = config("bridge")
    if configured(bridge_cfg):
        reader_cfg, out["reader_identity"] = bridge_cfg, "bridge"
    else:                                          # single-identity fallback
        reader_cfg, out["reader_identity"] = cfg, "owner-fallback"
    out["reader_webid"] = reader_cfg.get("webid")
    read = request("GET", url, cfg=reader_cfg, headers={"accept": "text/turtle"})
    out["read_status"] = read.status_code
    out["reader_read"] = read.status_code == 200
    if out["reader_read"]:
        out["ontology_sha256"] = hashlib.sha256(read.content).hexdigest()
    wac = read.headers.get("WAC-Allow")
    if wac:
        out["wac_allow"] = wac                     # server-computed modes
    public = requests.get(url, headers={"accept": "text/turtle"}, timeout=TIMEOUT)
    out["public_status"] = public.status_code
    out["public_denied"] = public.status_code in (401, 403)
    # Descriptive only (never used to decide): who the current ACL names.
    acl = request("GET", url + ACL_SUFFIX, cfg=cfg, headers={"accept": "text/turtle"})
    if acl.status_code == 200:
        import re
        out["acl_readers"] = sorted(set(re.findall(r"acl:agent\s+<([^>]+)>", acl.text))
                                    - {cfg.get("webid")})
    out["ok"] = out["reader_read"] and out["public_denied"]
    return out


def status():
    """Is a Pod configured, reachable, and does authorization actually work?"""
    cfg = config()
    bridge_cfg = config("bridge")
    out = {"available": False, "pod": cfg.get("pod"), "webid": cfg.get("webid"),
           "source": cfg.get("source"),
           "bridge": {"configured": configured(bridge_cfg),
                      "webid": bridge_cfg.get("webid")}}
    if not configured(cfg):
        out["reason"] = ("no Pod configured — run solid/scripts-bootstrap.mjs "
                         "against a Community Solid Server, or set SOLID_* env vars")
        return out
    try:
        token = access_token(cfg)
        out["authenticated"] = bool(token)
        probe = request("HEAD", cfg["pod"], cfg=cfg)
        out["pod_status"] = probe.status_code
        out["available"] = probe.status_code < 400
        out["resource"] = resource_url(ONTOLOGY_PATH, cfg)
    except requests.RequestException as exc:
        out["reason"] = f"pod unreachable: {exc}"
    except (KeyError, ValueError) as exc:
        out["reason"] = f"auth failed: {exc}"
    return out


def publish(onto, path=ONTOLOGY_PATH, readers=None, cfg=None,
            scope="pod-publish", purpose="holon marketplace data access",
            valid_days=90):
    """The full sovereign-data step, per the LingoAI flow: serialize the
    ontology into the Pod, set the ACL that opens access (mechanism), AND
    write the consent document that says what was consented to (scope,
    purpose, validity) — two separate resources, verified separately."""
    from . import pod as pod_export
    cfg = cfg or config()
    turtle = pod_export.to_turtle(onto)
    wrote = put_turtle(turtle, path=path, cfg=cfg)
    result = {"real": True, "pod": cfg["pod"], "write": wrote, "bytes": len(turtle)}
    if not wrote["ok"]:
        return result
    # The Bridge's own WebID is always among the grantees: it is the service
    # agent that must read the resource to attest — granted Read, nothing more.
    bridge_cfg = config("bridge")
    grantees = list(readers or [])
    if configured(bridge_cfg) and bridge_cfg.get("webid") and bridge_cfg["webid"] not in grantees:
        grantees.append(bridge_cfg["webid"])
    if grantees:
        result["authorization"] = grant_read(grantees, path=path, cfg=cfg)
    issued = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    expires = time.strftime("%Y-%m-%dT%H:%M:%SZ",
                            time.gmtime(time.time() + valid_days * 86400))
    doc = consent_document(cfg["webid"], grantees, resource_url(path, cfg),
                           scope, purpose, issued, expires)
    consent_wrote = put_turtle(doc, path=CONSENT_PATH, cfg=cfg)
    result["consent"] = {**consent_wrote, "scope": scope, "purpose": purpose,
                         "issued": issued, "expires": expires, "grantees": grantees}
    if consent_wrote["ok"] and grantees:
        result["consent"]["authorization"] = grant_read(grantees, path=CONSENT_PATH, cfg=cfg)
    return result


def revoke(path=ONTOLOGY_PATH, cfg=None):
    """Revocation, the user's side of sovereignty: replace the ACLs so ONLY the
    owner keeps access — the Bridge's next read is refused by the server and
    attestation becomes impossible. (The consent document stays as the record
    of what had been granted; the mechanism is what gets shut off.)"""
    cfg = cfg or config()
    out = {"revoked": []}
    for target in (path, CONSENT_PATH):
        url = resource_url(target, cfg)
        doc = _acl_document(url, cfg["webid"], [])
        res = request("PUT", url + ACL_SUFFIX, cfg=cfg, data=doc.encode("utf-8"),
                      headers={"content-type": "text/turtle"})
        out["revoked"].append({"resource": url, "ok": res.status_code in (200, 201, 204, 205),
                               "status": res.status_code})
    out["ok"] = all(r["ok"] for r in out["revoked"])
    return out
