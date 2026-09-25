"""Crash-safe JSON persistence: write to a sibling temp file, fsync, then
os.replace() into place. os.replace is atomic on the same filesystem, so a crash
or serialization error mid-write leaves the previous good file intact."""
import json
import os
import tempfile
from pathlib import Path


def atomic_write_json(path, data, *, indent=0, ensure_ascii=False):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=path.name + ".tmp.", suffix="")
    tmp = Path(tmp)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=indent, ensure_ascii=ensure_ascii)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    finally:
        if tmp.exists():
            try:
                tmp.unlink()
            except OSError:
                pass
