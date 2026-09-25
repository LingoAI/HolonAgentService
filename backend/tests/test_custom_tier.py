"""BYO endpoint: a custom Ollama-compatible tier appears only when configured."""
from backend import config


def test_custom_tier_from_env_full():
    t = config._custom_tier({"HOLON_CUSTOM_URL": "http://box:11434",
                             "HOLON_CUSTOM_MODEL": "llama3.3:70b"})
    assert t["llm_url"] == "http://box:11434"
    assert t["model"] == "llama3.3:70b"
    assert t["local"] is False and t["infer"] is True


def test_custom_tier_absent_when_unconfigured():
    assert config._custom_tier({}) is None
    assert config._custom_tier({"HOLON_CUSTOM_URL": "http://x"}) is None


def test_selections_always_include_auto():
    assert "auto" in config.SELECTIONS
    assert set(config.TIERS) <= set(config.SELECTIONS)
