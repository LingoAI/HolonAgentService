from backend import config

def test_tiers_have_local_and_cloud():
    assert "local" in config.TIERS and "cloud" in config.TIERS
    for t in config.TIERS.values():
        assert {"model", "infer", "local", "llm_url", "collection"} <= set(t)

def test_default_tier_is_cloud():
    assert config.DEFAULT_TIER == "cloud"

def test_tier_state_roundtrip(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    config.set_tier("local")
    assert config.get_tier() == "local"
    config.set_tier("cloud")
    assert config.get_tier() == "cloud"


def test_selections_include_auto():
    assert config.SELECTIONS == ["local", "cloud", "auto"]


def test_set_tier_accepts_auto(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    config.set_tier("auto")
    assert config.get_tier() == "auto"


def test_set_tier_rejects_unknown(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    import pytest
    with pytest.raises(ValueError):
        config.set_tier("frontier")


def test_tier_config_auto_falls_back_to_cloud():
    # "auto" is a selection, not a concrete tier; tier_config must not KeyError.
    assert config.tier_config("auto") == config.TIERS["cloud"]
