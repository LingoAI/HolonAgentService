"""Automatic snapshots of the twin's JSON state. The sovereignty promise made
real: your graph survives a bad write, a bad merge, or a bad day. Chroma
vector stores are NOT included — they are large and rebuildable from the
documents; the graph/history/state/trajectory/jobs/preferences are the
irreplaceable part."""
import tarfile
import time
from . import config

KEEP = 7
INTERVAL_S = 24 * 3600
_STATE_FILES = ("ontology/graph.json", "history.json", "state.json",
                "trajectory.jsonl", "access.json", "hire_jobs.json",
                "holon_preferences.json")


def backups_dir():
    d = config.DATA_DIR / "backups"
    d.mkdir(parents=True, exist_ok=True)
    return d


def list_backups():
    return sorted(backups_dir().glob("holon-*.tar.gz"))


def snapshot(force=False):
    """Write data/backups/holon-<utc>.tar.gz, prune to KEEP newest.
    Returns the new path, or None when the newest backup is < INTERVAL_S old."""
    existing = list_backups()
    if not force and existing and time.time() - existing[-1].stat().st_mtime < INTERVAL_S:
        return None
    ts = time.strftime("%Y%m%d-%H%M%S", time.gmtime())
    out = backups_dir() / f"holon-{ts}.tar.gz"
    with tarfile.open(out, "w:gz") as tar:
        for rel in _STATE_FILES:
            p = config.DATA_DIR / rel
            if p.exists():
                tar.add(p, arcname=rel)
    for old in list_backups()[:-KEEP]:
        old.unlink()
    return out
