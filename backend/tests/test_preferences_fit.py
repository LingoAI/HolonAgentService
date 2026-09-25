# holon/backend/tests/test_preferences_fit.py
"""Personal privacy and selection preferences."""
import json

import pytest

from backend import config
from backend.marketplace import preferences


@pytest.fixture
def prefs_dir(monkeypatch, tmp_path):
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    return tmp_path


# ---- preferences store ---------------------------------------------------------

def test_defaults_when_nothing_stored(prefs_dir):
    p = preferences.get()
    assert p["budget_u"] == 1.0 and p["risk"] == "moderate"
    assert p["protocols"] == ["general", "data"] and p["authority"] == "read-only"


def test_update_persists_and_stamps(prefs_dir):
    out = preferences.update({"budget_u": 5, "risk": "high", "protocols": ["data"]})
    assert out["ok"] is True
    again = preferences.get()
    assert again["budget_u"] == 5.0 and again["risk"] == "high" and again["protocols"] == ["data"]
    assert again["updated_at"]
    assert json.loads((prefs_dir / "holon_preferences.json").read_text())["risk"] == "high"


@pytest.mark.parametrize("bad", [
    {"budget_u": -1}, {"budget_u": "lots"}, {"risk": "yolo"}, {"authority": "root"},
    {"protocols": ["uniswap"]}, {"protocols": "venus"}, {"networks": ["ethereum"]},
    {"health_factor_floor": 0.5},
])
def test_invalid_values_are_rejected_and_nothing_written(prefs_dir, bad):
    out = preferences.update(bad)
    assert out["ok"] is False and out["errors"]
    assert not (prefs_dir / "holon_preferences.json").exists()


def test_unknown_fields_are_ignored_and_reset_restores_defaults(prefs_dir):
    preferences.update({"budget_u": 3, "evil": "x"})
    assert "evil" not in preferences.get()
    preferences.reset()
    assert preferences.get()["budget_u"] == 1.0


def test_corrupt_file_falls_back_to_defaults(prefs_dir):
    (prefs_dir / "holon_preferences.json").write_text("{nope")
    assert preferences.get()["risk"] == "moderate"
