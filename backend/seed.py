"""Seed a believable example life so the graph opens full. All facts tagged
provenance 'seed' so they're honest and wipeable via /api/reset."""
from .engine.ontology import Ontology
from .engine import rag, memory

NT = {"You": "Person", "Metformin": "Medication", "Dr. Smith": "Person",
      "Type 2 Diabetes": "Condition", "LDL 142": "HealthMetric",
      "Morning Run": "Event", "LingoAI": "Org",
      "Personal Ontology": "Goal", "Colombo": "Place",
      "Dark Roast Coffee": "Preference", "Apple Silicon": "Topic"}

REL = [
    ("You", "has_condition", "Type 2 Diabetes"),
    ("You", "takes", "Metformin"),
    ("Metformin", "prescribed_by", "Dr. Smith"),
    ("Metformin", "treats", "Type 2 Diabetes"),
    ("You", "measured", "LDL 142"),
    ("Dr. Smith", "measured", "LDL 142"),
    ("You", "did", "Morning Run"),
    ("You", "works_on", "Personal Ontology"),
    ("You", "member_of", "LingoAI"),
    ("Personal Ontology", "related_to", "Apple Silicon"),
    ("You", "located_at", "Colombo"),
    ("You", "prefers", "Dark Roast Coffee"),
]


def seed_graph(onto: Ontology):
    for s, p, o in REL:
        onto.upsert_relation(s, p, o, source="seed", node_types=NT)
    onto.save()


def seed_all(onto: Ontology):
    seed_graph(onto)
    rag.ingest_text("Project Aurora brief",
                    "Project Aurora launches March 2027 with a solar drone fleet "
                    "for sovereign personal-data infrastructure.", "work")
    for m in ("My name is Samitha and I live in Colombo, Sri Lanka.",
              "I'm building a sovereign personal ontology assistant.",
              "I have type 2 diabetes and take Metformin prescribed by Dr. Smith."):
        memory.mem_add(m, tier="local")
