"""Snapshots of the twin's JSON state: create, prune, daily-skip."""
import tarfile
from backend import backup


def _prep(tmp_path, monkeypatch):
    from backend import config
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    (tmp_path / "ontology").mkdir()
    (tmp_path / "ontology" / "graph.json").write_text("{}")
    (tmp_path / "history.json").write_text("[]")


def test_snapshot_creates_tar_with_state(tmp_path, monkeypatch):
    _prep(tmp_path, monkeypatch)
    out = backup.snapshot()
    assert out and out.exists()
    names = tarfile.open(out).getnames()
    assert "ontology/graph.json" in names and "history.json" in names


def test_snapshot_skips_when_fresh_and_forces(tmp_path, monkeypatch):
    _prep(tmp_path, monkeypatch)
    assert backup.snapshot() is not None
    assert backup.snapshot() is None                 # < 24h old → skip
    assert backup.snapshot(force=True) is not None   # force overrides


def test_snapshot_includes_jobs_and_preferences(tmp_path, monkeypatch):
    _prep(tmp_path, monkeypatch)
    (tmp_path / "hire_jobs.json").write_text("{}")
    (tmp_path / "holon_preferences.json").write_text("{}")
    out = backup.snapshot()
    names = tarfile.open(out).getnames()
    assert "hire_jobs.json" in names and "holon_preferences.json" in names


def test_prune_keeps_last_seven(tmp_path, monkeypatch):
    _prep(tmp_path, monkeypatch)
    d = backup.backups_dir()
    for i in range(9):
        (d / f"holon-2026010{i}-000000.tar.gz").write_bytes(b"x")
    backup.snapshot(force=True)
    assert len(backup.list_backups()) == 7
