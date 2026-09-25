"""Personal data → ontology: deterministic (no-LLM) structured entry of life data
straight into the hero graph. Calendar events become Event nodes; contacts become
Person nodes — both wired to the "You" root with typed, provenanced edges, exactly
like extracted facts. Harvested from odysseus calendar/contacts routes, mapped onto
Holon's existing schema (no new node types, no new dependencies)."""
from .engine.ontology import ROOT


def _counts(onto):
    return onto.g.number_of_nodes(), onto.g.number_of_edges()


def add_event(onto, title, when=None, where=None, who=None):
    """Add a calendar event as an Event node: You attended <title> (valid_time=when),
    optionally located_at a Place, with each attendee a Person who attended it."""
    title = (title or "").strip()
    if not title:
        raise ValueError("event title is required")
    who = [w.strip() for w in (who or []) if w and w.strip()]
    n0, e0 = _counts(onto)
    onto.upsert_entity(title, "Event", source="personal:event")
    onto.upsert_relation(ROOT, "attended", title, source="personal:event",
                         node_types={ROOT: "Person", title: "Event"}, valid_time=when)
    if where and where.strip():
        onto.upsert_relation(title, "located_at", where.strip(), source="personal:event",
                             node_types={title: "Event", where.strip(): "Place"})
    for name in who:
        onto.upsert_relation(name, "attended", title, source="personal:event",
                             node_types={name: "Person", title: "Event"})
    onto.save()
    n1, e1 = _counts(onto)
    return {"title": title, "type": "Event", "when": when, "where": where,
            "who": who, "nodes_added": n1 - n0, "edges_added": e1 - e0}


def add_contact(onto, name, org=None, relationship=None):
    """Add a contact as a Person node: You related_to <name>, optionally member_of
    an Org. A relationship label (e.g. 'colleague') is stored on the person node."""
    name = (name or "").strip()
    if not name:
        raise ValueError("contact name is required")
    n0, e0 = _counts(onto)
    nid = onto.upsert_entity(name, "Person", source="personal:contact")
    if relationship and relationship.strip():
        onto.g.nodes[nid]["relationship"] = relationship.strip()
    onto.upsert_relation(ROOT, "related_to", name, source="personal:contact",
                         node_types={ROOT: "Person", name: "Person"})
    if org and org.strip():
        onto.upsert_relation(name, "member_of", org.strip(), source="personal:contact",
                             node_types={name: "Person", org.strip(): "Org"})
    onto.save()
    n1, e1 = _counts(onto)
    return {"name": name, "type": "Person", "org": org,
            "relationship": (relationship or None), "nodes_added": n1 - n0,
            "edges_added": e1 - e0}


def list_events(onto):
    rows = [{"title": a.get("label", nid), "id": nid}
            for nid, a in onto.g.nodes(data=True) if a.get("type") == "Event"]
    return sorted(rows, key=lambda r: r["title"].lower())


def list_contacts(onto):
    rows = [{"name": a.get("label", nid), "id": nid,
             "relationship": a.get("relationship")}
            for nid, a in onto.g.nodes(data=True)
            if a.get("type") == "Person" and nid != ROOT]
    return sorted(rows, key=lambda r: r["name"].lower())
