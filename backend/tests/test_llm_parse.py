# holon/backend/tests/test_llm_parse.py
from backend.engine.llm import parse_extraction

def test_strips_think_block():
    raw = '<think>let me reason</think>{"entities":[{"name":"Metformin","type":"Medication"}],"relations":[]}'
    out = parse_extraction(raw)
    assert out["entities"][0]["name"] == "Metformin"

def test_strips_code_fence():
    raw = '```json\n{"entities":[],"relations":[{"subject":"You","predicate":"takes","object":"Metformin"}]}\n```'
    out = parse_extraction(raw)
    assert out["relations"][0]["object"] == "Metformin"

def test_tolerates_trailing_comma():
    raw = '{"entities":[{"name":"You","type":"Person"},],"relations":[]}'
    out = parse_extraction(raw)
    assert out["entities"][0]["name"] == "You"

def test_garbage_returns_empty():
    assert parse_extraction("sorry, I cannot") == {"entities": [], "relations": []}
