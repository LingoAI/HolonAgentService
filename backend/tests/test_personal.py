# holon/backend/tests/test_personal.py
"""Personal data → ontology: deterministic (no-LLM) structured entry of life data
that lands as typed nodes in the hero graph — calendar events → Event nodes,
contacts → Person nodes. Harvested from odysseus calendar/contacts routes, mapped
onto Holon's existing ontology schema."""
import importlib
from fastapi.testclient import TestClient
from backend import config, personal
from backend.engine.ontology import Ontology, ROOT


def _onto(tmp_path):
    return Ontology(tmp_path / "g.json")


# ---- add_event --------------------------------------------------------------

def test_add_event_creates_event_node_and_attended_edge(tmp_path):
    o = _onto(tmp_path)
    before = o.g.number_of_nodes()
    out = personal.add_event(o, "Standup")
    assert out["type"] == "Event" and out["title"] == "Standup"
    assert o.g.nodes["Standup"]["type"] == "Event"
    assert o.g.has_edge(ROOT, "Standup")
    assert o.g.edges[ROOT, "Standup"]["predicate"] == "attended"
    assert o.g.number_of_nodes() > before


def test_add_event_with_place_creates_located_at(tmp_path):
    o = _onto(tmp_path)
    personal.add_event(o, "Standup", where="Office")
    assert o.g.nodes["Office"]["type"] == "Place"
    assert o.g.edges["Standup", "Office"]["predicate"] == "located_at"


def test_add_event_with_attendees_creates_people(tmp_path):
    o = _onto(tmp_path)
    personal.add_event(o, "Standup", who=["Alice"])
    assert o.g.nodes["Alice"]["type"] == "Person"
    assert o.g.edges["Alice", "Standup"]["predicate"] == "attended"


def test_add_event_stores_when_as_valid_time(tmp_path):
    o = _onto(tmp_path)
    personal.add_event(o, "Standup", when="2026-06-10")
    assert o.g.edges[ROOT, "Standup"]["t_valid"] == "2026-06-10"


# ---- add_contact ------------------------------------------------------------

def test_add_contact_creates_person_and_related_to(tmp_path):
    o = _onto(tmp_path)
    out = personal.add_contact(o, "Dr. Smith")
    assert out["type"] == "Person" and out["name"] == "Dr. Smith"
    assert o.g.nodes["Dr. Smith"]["type"] == "Person"
    assert o.g.edges[ROOT, "Dr. Smith"]["predicate"] == "related_to"


def test_add_contact_with_org_creates_member_of(tmp_path):
    o = _onto(tmp_path)
    personal.add_contact(o, "Dr. Smith", org="Clinic")
    assert o.g.nodes["Clinic"]["type"] == "Org"
    assert o.g.edges["Dr. Smith", "Clinic"]["predicate"] == "member_of"


def test_add_contact_stores_relationship(tmp_path):
    o = _onto(tmp_path)
    personal.add_contact(o, "Bob", relationship="colleague")
    rows = personal.list_contacts(o)
    bob = [r for r in rows if r["name"] == "Bob"][0]
    assert bob["relationship"] == "colleague"


# ---- listings ---------------------------------------------------------------

def test_list_events_and_contacts(tmp_path):
    o = _onto(tmp_path)
    personal.add_event(o, "Standup")
    personal.add_contact(o, "Alice")
    assert "Standup" in [e["title"] for e in personal.list_events(o)]
    names = [c["name"] for c in personal.list_contacts(o)]
    assert "Alice" in names
    assert ROOT not in names  # the "You" root is never a contact


# ---- routes -----------------------------------------------------------------

def _client(tmp_path, monkeypatch):
    from backend.engine import rag, memory
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    rag._get_chroma.cache_clear()
    memory._build.cache_clear()
    import backend.main as main
    importlib.reload(main)
    return TestClient(main.app)


def test_event_route_adds_to_graph(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    r = c.post("/api/personal/event",
               json={"title": "Standup", "where": "Office", "who": ["Alice"]})
    assert r.status_code == 200 and r.json()["title"] == "Standup"
    g = c.get("/api/graph").json()
    assert any(n["data"].get("type") == "Event" for n in g["nodes"])
    assert "Standup" in [e["title"] for e in c.get("/api/personal/events").json()]


def test_contact_route_adds_person(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    r = c.post("/api/personal/contact", json={"name": "Dr. Smith", "org": "Clinic"})
    assert r.status_code == 200
    assert "Dr. Smith" in [p["name"] for p in c.get("/api/personal/contacts").json()]


def test_event_route_rejects_empty_title(tmp_path, monkeypatch):
    c = _client(tmp_path, monkeypatch)
    assert c.post("/api/personal/event", json={"title": ""}).status_code == 400
