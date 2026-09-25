"""Trajectory / audit trail — an append-only, secret-scrubbed JSONL record of every
chat turn. The backbone of a twin you can trust to stay with you forever: you can
always inspect what it decided (which tier, why), what it cost (tokens, latency),
and what it changed (facts extracted) — or whether it errored.

Append-only by design: the log is evidence, so turns are never rewritten. The path
resolves from config.DATA_DIR at call time so tests can isolate it to a tmp dir.
"""
import json
from datetime import datetime, timezone
from . import config
from .security import scrub_secrets


def _path():
    return config.DATA_DIR / "trajectory.jsonl"


def log_turn(record):
    """Append one secret-scrubbed turn record as a JSONL line. A UTC `ts` is
    stamped automatically when absent. Never raises into the caller — an audit
    log must not be able to break a chat turn."""
    try:
        rec = dict(record)
        rec.setdefault("ts", datetime.now(timezone.utc).isoformat())
        rec = scrub_secrets(rec)
        with _path().open("a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    except Exception:
        pass


def read_trajectory(limit=50):
    """Return the last `limit` turn records, oldest→newest. Corrupt lines are
    skipped so a single bad write can never break the audit view."""
    p = _path()
    if not p.exists():
        return []
    rows = []
    for line in p.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except Exception:
            continue
    return rows[-limit:] if limit else rows
