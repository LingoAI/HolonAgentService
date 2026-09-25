# holon/backend/tests/test_headers_and_bind.py
from pathlib import Path
from fastapi.testclient import TestClient
from backend.main import app

def test_security_headers_present():
    c = TestClient(app)
    r = c.get("/api/status")
    assert r.headers["X-Content-Type-Options"] == "nosniff"
    assert "frame-ancestors 'none'" in r.headers["Content-Security-Policy"]

def test_run_sh_pins_loopback():
    run = Path(__file__).resolve().parents[2] / "run.sh"
    assert "npm run dev:local" in run.read_text()
    supervisor = run.parent / "scripts/dev-local.mjs"
    assert "'--host','127.0.0.1'" in supervisor.read_text()
    assert "'--hostname','127.0.0.1'" in supervisor.read_text()
