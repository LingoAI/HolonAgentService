# holon/backend/tests/test_atomic_io.py
import json, os, threading, pytest
from backend.atomic_io import atomic_write_json

def test_round_trip(tmp_path):
    p = tmp_path / "g.json"
    atomic_write_json(p, {"a": 1, "b": [1, 2]})
    assert json.loads(p.read_text()) == {"a": 1, "b": [1, 2]}

def test_overwrite_longer_then_shorter(tmp_path):
    p = tmp_path / "g.json"
    atomic_write_json(p, {"x": "y" * 500})
    atomic_write_json(p, {"x": "z"})           # shorter — must fully replace, not leave tail
    assert json.loads(p.read_text()) == {"x": "z"}

def test_creates_parent_dirs(tmp_path):
    p = tmp_path / "deep" / "nest" / "g.json"
    atomic_write_json(p, {"ok": True})
    assert p.exists()

def test_no_leftover_tmp(tmp_path):
    p = tmp_path / "g.json"
    atomic_write_json(p, {"a": 1})
    assert [f.name for f in tmp_path.iterdir()] == ["g.json"]

def test_concurrent_writes_no_corruption(tmp_path):
    p = tmp_path / "g.json"

    def writer(i):
        for _ in range(50):
            atomic_write_json(p, {"n": i})

    threads = [threading.Thread(target=writer, args=(i,)) for i in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    data = json.loads(p.read_text())
    assert "n" in data
    assert all(".tmp." not in f.name for f in tmp_path.iterdir())

def test_crash_during_replace_keeps_old_file(tmp_path, monkeypatch):
    p = tmp_path / "g.json"
    atomic_write_json(p, {"v": "old"})
    monkeypatch.setattr(os, "replace", lambda *a, **k: (_ for _ in ()).throw(OSError("boom")))
    with pytest.raises(OSError):
        atomic_write_json(p, {"v": "new"})
    assert json.loads(p.read_text()) == {"v": "old"}   # old data intact
    leftovers = [f.name for f in tmp_path.iterdir() if f.name != "g.json"]
    assert leftovers == [] or all(n.startswith("g.json.tmp") for n in leftovers)
