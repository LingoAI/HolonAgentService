"""LingoAI Bridge — first cut of the SOLID <-> chain integration jump
(v0.3 problem 1 / ricky's design):

    Solid Pod authorization -> Bridge verification -> trusted attestation
    -> the configured chain records or uses the attestation.

What is real here today:
  * The ontology exports as RDF/Turtle — SOLID's native data model — so a
    Personal Ontology can live in a Pod (LingoPod / Community Solid Server)
    and interoperate with any Linked-Data consumer.
  * Consent attestations: the Bridge reads the local consent state (the
    Pod-side truth), verifies it, and produces a deterministic, HMAC-signed
    attestation whose hash is what goes on chain (contracts trust the
    attestation, never the frontend — spec §13).

What is NOT claimed: no remote Pod server round-trip yet — the app's own
sovereignty store stands in for the Pod until LingoPod endpoints are wired
(the attestation format is the stable contract either side of that swap).
"""
import hashlib
import hmac
import json
import os
from datetime import datetime, timezone

BRIDGE_VERSION = "lingoai-bridge-v0"


PLACEHOLDER_POD = "https://pod.lingoai.example/me"


def _now():
    return datetime.now(timezone.utc).isoformat()


def _turtle_escape(s):
    return str(s).replace("\\", "\\\\").replace('"', '\\"').replace("\n", " ")


def _slug(name):
    keep = [c if c.isalnum() else "_" for c in str(name)]
    slug = "".join(keep).strip("_")
    return slug or "node"


def ontology_turtle(onto, pod_uri=None):
    """Serialize the typed, provenanced graph as RDF/Turtle.

    Nodes become ``holon:<slug>`` resources typed via ``rdf:type``;
    edges become predicates in the holon vocabulary; provenance rides
    along as ``holon:provenance`` annotations. Pure stdlib.
    """
    pod_uri = pod_uri or default_pod_uri()
    lines = [
        f"@prefix holon: <{pod_uri}/ontology#> .",
        "@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .",
        "@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .",
        "",
    ]
    for nid, attrs in onto.g.nodes(data=True):
        subject = f"holon:{_slug(nid)}"
        ntype = attrs.get("type", "Topic")
        lines.append(f'{subject} rdf:type holon:{ntype} ;')
        lines.append(f'    rdfs:label "{_turtle_escape(nid)}" .')
    lines.append("")
    for u, v, attrs in onto.g.edges(data=True):
        pred = _slug(attrs.get("predicate", "related_to"))
        lines.append(f"holon:{_slug(u)} holon:{pred} holon:{_slug(v)} .")
        for src in attrs.get("provenance", []) or []:
            lines.append(
                f'holon:{_slug(u)} holon:provenance "{_turtle_escape(src)}" .'
            )
    return "\n".join(lines) + "\n"


def _signing_key():
    """HMAC key for attestations. HOLON_TOKEN doubles as the bridge secret
    when set; otherwise a stable app-local key file (mode 600)."""
    tok = os.environ.get("HOLON_TOKEN")
    if tok:
        return tok.encode()
    from .. import config
    key_file = config.DATA_DIR / "bridge_key"
    if not key_file.exists():
        key_file.write_bytes(os.urandom(32))
        key_file.chmod(0o600)
    return key_file.read_bytes()


def default_pod_uri():
    """The live Pod's WebID when one is configured (Community Solid Server in
    `solid/`), else the placeholder. Keeps attestations pointing at the real
    Pod as soon as it exists, without changing any call site."""
    try:
        from . import solid
        cfg = solid.config()
        if solid.configured(cfg) and cfg.get("webid"):
            return cfg["webid"]
    except Exception:  # noqa: BLE001 — the Pod is optional, never fatal
        pass
    return PLACEHOLDER_POD


def consent_attestation(onto, scope, pod_uri=None, extra=None):
    """Verify local consent state and produce the signed attestation the
    chain side records. Deterministic for a given (graph, scope, extra) so it
    can be re-derived and checked. ``pod_uri`` defaults to the live Pod's
    WebID; ``extra`` lets the pod-gated path sign the consent document's
    hash into the core (tampering with it breaks the signature)."""
    pod_uri = pod_uri or default_pod_uri()
    turtle = ontology_turtle(onto, pod_uri=pod_uri)
    ontology_hash = hashlib.sha256(turtle.encode()).hexdigest()
    body = {
        "version": BRIDGE_VERSION,
        "pod_uri": pod_uri,
        "scope": scope,
        "ontology_sha256": ontology_hash,
        "node_count": onto.g.number_of_nodes(),
        **(extra or {}),
        "issued_at": _now(),
    }
    payload = json.dumps({k: body[k] for k in sorted(body) if k != "issued_at"},
                         separators=(",", ":"))
    signature = hmac.new(_signing_key(), payload.encode(), hashlib.sha256).hexdigest()
    attestation_hash = hashlib.sha256((payload + signature).encode()).hexdigest()
    return {
        **body,
        "signature": signature,
        "attestation_hash": attestation_hash,
        # what the contracts store: method string + 32-byte hash
        "verification_method": f"{BRIDGE_VERSION}:{attestation_hash[:16]}",
    }


def pod_consent_attestation(onto, scope):
    """Pod-gated attestation, per the LingoAI flow: ACL/ACP is the access
    MECHANISM, the consent DOCUMENT is the consent. Before signing, the
    Bridge verifies BOTH against the Pod:

      1. effective authorization — asks the server itself (owner read 200,
         public read denied), never parses ACL semantics;
      2. the consent document — exists, covers this resource and scope, is
         inside its validity window, and every ACL reader is named in it.

    The consent document's sha256 is signed into the attestation core, so the
    on-chain method commits to the exact consent text. Refuses to attest when
    anything above fails — the Bridge never signs consent the Pod does not
    actually hold and enforce."""
    from . import solid
    if not solid.configured():
        return {"ok": False, "error": "no SOLID Pod configured — attestation refused",
                "hint": "run solid/scripts-bootstrap.mjs or set SOLID_* env vars"}
    try:
        check = solid.effective_access()
        consent = solid.read_consent()
    except Exception as exc:  # noqa: BLE001 — network/Pod failure = no attestation
        return {"ok": False, "error": f"pod check failed: {str(exc)[:150]}"}
    if not check.get("ok"):
        return {"ok": False, "error": "pod authorization check failed — attestation refused",
                "pod_check": check}
    if not consent.get("ok"):
        return {"ok": False, "error": "no consent document in the Pod — attestation refused "
                "(publish writes one: scope, purpose, validity)", "pod_check": check}
    problems = []
    if consent.get("resource") != check.get("resource"):
        problems.append(f"consent covers {consent.get('resource')}, not {check.get('resource')}")
    if consent.get("scope") != scope:
        problems.append(f"consent scope '{consent.get('scope')}' != requested '{scope}'")
    if (consent.get("status") or "active") != "active":
        problems.append(f"consent status is '{consent.get('status')}', not active")
    expires = consent.get("expires")
    if not expires or expires <= _now():
        problems.append(f"consent expired at {expires}")
    # The reading agent itself (the Bridge's own WebID) must be a named grantee.
    reader = check.get("reader_webid")
    if check.get("reader_identity") == "bridge" and reader             and reader not in (consent.get("grantees") or []):
        problems.append(f"bridge WebID {reader} is not a consent grantee")
    uncovered = set(check.get("acl_readers") or []) - set(consent.get("grantees") or [])
    if uncovered:
        problems.append(f"ACL readers not named in consent: {sorted(uncovered)}")
    if problems:
        return {"ok": False, "error": "consent verification failed — attestation refused",
                "problems": problems, "pod_check": check, "consent": consent}
    att = consent_attestation(onto, scope, extra={
        "resource_uri": check.get("resource"),
        "bridge_webid": reader,
        "purpose": consent.get("purpose"),
        "consent_sha256": consent["sha256"],
        "consent_url": consent["url"],
        "consent_expires": expires,
        "authorization_method": "solid-effective-access+consent-rdf",
    })
    return {"ok": True, **att, "pod_verified": True, "pod_check": check,
            "consent": {k: consent.get(k) for k in
                        ("url", "sha256", "consent_id", "status", "scope", "purpose",
                         "issued", "expires", "grantees")}}


def verify_attestation(onto, attestation, pod_uri=None):
    """Re-derive and compare — proves the attestation matches the current
    graph + scope and was signed by this bridge. Uses the attestation's own
    ``pod_uri`` so an attestation issued against the live Pod still verifies."""
    pod_uri = pod_uri or attestation.get("pod_uri") or default_pod_uri()
    extra = {k: attestation[k] for k in
             ("resource_uri", "bridge_webid", "purpose", "consent_sha256",
              "consent_url", "consent_expires", "authorization_method")
             if k in attestation}
    fresh = consent_attestation(onto, attestation.get("scope"), pod_uri=pod_uri,
                                extra=extra or None)
    return {
        "valid": hmac.compare_digest(fresh["signature"], attestation.get("signature", "")),
        "ontology_unchanged": fresh["ontology_sha256"] == attestation.get("ontology_sha256"),
    }
