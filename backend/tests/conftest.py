"""Exercise personal twin routes only in an explicit local test profile."""

import pytest


@pytest.fixture(autouse=True)
def _personal_local_profile(monkeypatch):
    monkeypatch.setenv("HOLON_PERSONAL_MODE", "1")
    monkeypatch.setenv("HIRE_NETWORK", "local")
