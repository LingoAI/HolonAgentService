"""PrivacyGateway — the redaction step at the cloud boundary.

Holon already decides per request whether a turn runs on the local tier (nothing
leaves the machine) or a cloud tier. This is the missing half for the cloud
case: before any text is sent to a cloud model — the system prompt built from
the ontology, memories and documents; the conversation; the extraction input —
personal data is replaced by placeholders, and the placeholders are put back
in everything that comes out (the streamed reply, the extracted facts).

What counts as personal is the user's own policy (preferences → privacy):
  * entities of chosen types in the user's ontology (people, organisations,
    places, conditions, medications, health metrics) — the twin already knows
    exactly who and what is personal to this person, so it is the dictionary;
  * pattern classes: e-mail addresses, phone numbers, wallet addresses, long
    identifier numbers.

Placeholders are stable within one gateway (one request): the same name always
becomes the same [PERSON_n_xxxx], so the model can still reason about "PERSON_1
takes MEDICATION_2" and the answer restores correctly. The ``xxxx`` is a random
per-request nonce: a placeholder is only ever restored by the gateway that
minted it, so a token typed by the user, echoed from an earlier request or
invented by the model stays literal text. Incoming text that already looks like
a placeholder is defused before redaction for the same reason. The mapping
lives only in process memory for the duration of the request. A local tier
gets a disabled gateway: nothing to protect from.

Known limit (documented, not hidden): the dictionary is the ontology, so a name
that is not yet in the graph — a stranger in an uploaded document — is not
redacted. Pattern classes still apply to it.
"""
import re
import secrets

from .ontology import ROOT

TYPE_LABEL = {"Person": "PERSON", "Org": "ORG", "Place": "PLACE", "Condition": "CONDITION",
              "Medication": "MEDICATION", "HealthMetric": "HEALTHMETRIC"}
# Applied in this order: a bare digit run is an identifier, a separated or
# '+'-prefixed one is a phone number — so ids are classified before phones.
PATTERNS = {
    "email": re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"),
    "wallet": re.compile(r"\b0x[0-9a-fA-F]{40}\b"),
    # bare identifier numbers: national ids, account numbers
    "id": re.compile(r"(?<![\w.+])\d{9,}(?![\w.])"),
    # 9+ digits with the usual separators, e.g. +94 77 123 4567 or (020) 7946 0958
    "phone": re.compile(r"(?<![\w/.])\+?\d(?:[\d\s().-]{7,}\d)(?![\w/])"),
}
# Structured numbers that are not personal identifiers and must not be eaten
# by the id/phone patterns: ISO / European / dotted dates (with an optional
# time) and IPv4 addresses. They are masked out before the patterns run.
PROTECTED = re.compile(
    r"\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?\b"      # 2026-08-18, 2026-08-18 14:05
    r"|\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b"                       # 18/08/2026, 18.08.26
    r"|\b\d{1,3}(?:\.\d{1,3}){3}\b")                              # 10.20.1.205
PATTERN_LABEL = {"email": "EMAIL", "phone": "PHONE", "wallet": "WALLET", "id": "ID"}
KINDS = "PERSON|ORG|PLACE|CONDITION|MEDICATION|HEALTHMETRIC|EMAIL|PHONE|WALLET|ID"
PLACEHOLDER = re.compile(r"\[(" + KINDS + r")_(\d+)_([0-9a-fA-F]{4})\]", re.IGNORECASE)
# anything placeholder-shaped in *incoming* text, with or without a nonce
LOOKALIKE = re.compile(r"\[(?:" + KINDS + r")_\d+(?:_[0-9a-fA-F]{4})?\]", re.IGNORECASE)
MAX_PLACEHOLDER = 26      # "[HEALTHMETRIC_12_ab12]" is 22; anything held longer is not one

DEFAULT_TYPES = list(TYPE_LABEL)
DEFAULT_PATTERNS = list(PATTERNS)


def _nonce():
    return secrets.token_hex(2)


def _sub_outside_protected(pattern, repl, text):
    """``pattern.sub(repl, text)`` applied only between PROTECTED spans."""
    out, pos = [], 0
    for m in PROTECTED.finditer(text):
        out.append(pattern.sub(repl, text[pos:m.start()]))
        out.append(m.group(0))
        pos = m.end()
    out.append(pattern.sub(repl, text[pos:]))
    return "".join(out)


class Gateway:
    def __init__(self, entries=(), patterns=DEFAULT_PATTERNS, enabled=True):
        """``entries``: (label, ontology type) pairs to redact; ``patterns``: the
        pattern classes to apply. ``enabled=False`` makes every call a no-op."""
        self.enabled = enabled
        self.nonce = _nonce()
        self.forward = {}        # "[PERSON_1_ab12]" -> "Alice Smith"
        self._backward = {}      # ("PERSON", "alice smith") -> "[PERSON_1_ab12]"
        self.counts = {}
        seen = set()
        terms = []
        for label, ntype in entries:
            label = str(label or "").strip()
            kind = TYPE_LABEL.get(ntype)
            if not kind or len(label) < 2 or label == ROOT or label.lower() in seen:
                continue
            seen.add(label.lower())
            terms.append((label, kind))
        # longest first, so "Alice Smith" wins over a shorter "Alice"
        self._terms = sorted(terms, key=lambda t: -len(t[0]))
        self._patterns = [(PATTERN_LABEL[k], PATTERNS[k]) for k in patterns if k in PATTERNS]

    @classmethod
    def from_ontology(cls, onto, policy=None):
        """A gateway whose dictionary is the user's own graph, filtered by the
        policy's ``redact_types``; ``cloud_redaction: false`` disables it."""
        policy = policy or {}
        if not policy.get("cloud_redaction", True):
            return cls(enabled=False)
        # an explicit empty list means "none of these", only a missing key means defaults
        types = set(policy["redact_types"] if isinstance(policy.get("redact_types"), list) else DEFAULT_TYPES)
        patterns = (policy["redact_patterns"] if isinstance(policy.get("redact_patterns"), list)
                    else DEFAULT_PATTERNS)
        entries = [(data.get("label") or node, data.get("type"))
                   for node, data in onto.g.nodes(data=True) if data.get("type") in types]
        return cls(entries, patterns=patterns)

    def _placeholder(self, kind, original):
        key = (kind, original.lower())
        ph = self._backward.get(key)
        if ph is None:
            self.counts[kind] = self.counts.get(kind, 0) + 1
            ph = f"[{kind}_{self.counts[kind]}_{self.nonce}]"
            self._backward[key] = ph
            self.forward[ph] = original
        return ph

    @staticmethod
    def defuse(text):
        """Make placeholder-shaped text in *input* inert: a zero-width space
        after the bracket keeps it readable but no longer restorable."""
        return LOOKALIKE.sub(lambda m: "[​" + m.group(0)[1:], text)

    def redact(self, text):
        """Replace personal data in ``text`` with placeholders. Whole-word,
        case-insensitive for ontology labels; the original casing is what the
        restore puts back."""
        if not self.enabled or not text:
            return text
        out = self.defuse(str(text))
        # structured tokens first: a name inside an e-mail address must become
        # one [EMAIL_n], not a [PERSON_n] glued to a domain; dates and IPs are
        # kept out of the id/phone patterns' reach
        for kind, pattern in self._patterns:
            out = _sub_outside_protected(
                pattern, lambda m, k=kind: self._placeholder(k, m.group(0)), out)
        for label, kind in self._terms:
            pattern = re.compile(r"(?<!\w)" + re.escape(label) + r"(?!\w)", re.IGNORECASE)
            out = pattern.sub(lambda m, k=kind, l=label: self._placeholder(k, l), out)
        return out

    def redact_messages(self, messages):
        return [{**m, "content": self.redact(m.get("content", ""))} for m in messages]

    def restore(self, text):
        """Put the originals back for every placeholder this gateway minted
        (any casing). Placeholders with another nonce stay as they are."""
        if not self.enabled or not text or not self.forward:
            return text
        return PLACEHOLDER.sub(
            lambda m: self.forward.get(
                f"[{m.group(1).upper()}_{m.group(2)}_{m.group(3).lower()}]", m.group(0)), text)

    def stream_restore(self, tokens):
        """Restore across a token stream: a placeholder can arrive split over
        several tokens, so text after an unclosed '[' is held back (up to one
        placeholder's length) until it closes or proves not to be one."""
        buf = ""
        for tok in tokens:
            buf += tok
            buf = self.restore(buf)
            i = buf.rfind("[")
            if i != -1 and "]" not in buf[i:] and len(buf) - i <= MAX_PLACEHOLDER:
                out, buf = buf[:i], buf[i:]
            else:
                out, buf = buf, ""
            if out:
                yield out
        if buf:
            yield self.restore(buf)

    def wrap_once(self, fn):
        """Wrap a non-streaming LLM call ``fn(messages, tier, system, fmt)`` so
        its input is redacted and its output restored — used for extraction
        and history summarisation, whose results are stored."""
        def call(messages, tier=None, system="", fmt=None):
            raw = fn(self.redact_messages(messages), tier, system=self.redact(system), fmt=fmt)
            return self.restore(raw)
        return call

    def stats(self):
        """What left for the cloud, by category — counts only, never values."""
        return {"enabled": self.enabled, "redacted": dict(self.counts),
                "total": sum(self.counts.values())}
