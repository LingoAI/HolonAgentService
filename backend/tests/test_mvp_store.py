import threading

from backend.marketplace.mvp_store import MVPStore, now_s


def test_schema_pragmas_and_nonce_are_persistent_and_single_use(tmp_path):
    path = tmp_path / "mvp.sqlite3"
    one = MVPStore(path)
    with one.connect() as db:
        assert db.execute("PRAGMA foreign_keys").fetchone()[0] == 1
        assert db.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
        assert db.execute("PRAGMA user_version").fetchone()[0] == 1
    one.issue_nonce(nonce="abc", address="0x" + "11" * 20, requester_key="ip:wallet",
                    domain="example.test", uri="https://example.test", message="exact", expires_at=now_s() + 60)
    two = MVPStore(path)
    rows = []
    threads = [threading.Thread(target=lambda: rows.append(two.consume_nonce("abc"))) for _ in range(2)]
    for item in threads:
        item.start()
    for item in threads:
        item.join()
    assert sum(row is not None for row in rows) == 1
    assert one.consume_nonce("abc") is None


def test_session_revocation_and_rate_limit_survive_new_store_instance(tmp_path):
    path = tmp_path / "mvp.sqlite3"
    first = MVPStore(path)
    token = first.create_session("0x" + "22" * 20, 60)
    assert MVPStore(path).session_address(token) == "0x" + "22" * 20
    first.revoke_session(token)
    assert MVPStore(path).session_address(token) is None
    for index in range(5):
        first.issue_nonce(nonce=f"n{index}", address="0x" + "22" * 20, requester_key="same",
                          domain="d", uri="https://d", message="m", expires_at=now_s() + 60)
    try:
        first.issue_nonce(nonce="overflow", address="0x" + "22" * 20, requester_key="same",
                          domain="d", uri="https://d", message="m", expires_at=now_s() + 60)
        assert False, "rate limit should reject the sixth challenge"
    except ValueError as exc:
        assert "too many" in str(exc)


def _task():
    return {"uid": "task_1", "chain_id": 1952, "escrow": "0x" + "33" * 20,
            "buyer": "0x" + "11" * 20, "title": "FAQ", "community_intro": "Intro",
            "facts_json": "[\"fact\"]", "sources_json": "[\"https://example.test\"]",
            "audience": "Users", "acceptance_json": "[\"FAQ\"]", "template_id": "community-introduction-faq-v1",
            "amount_raw": "1000000", "evaluator": "0x" + "44" * 20, "expired_at": now_s() + 7200,
            "task_hash": "0x" + "55" * 32, "manifest_cid": "b" + "a" * 58,
            "manifest_sha256": "aa", "status": "open", "selected_application_id": None,
            "created_at": now_s(), "closed_at": None}


def _application(index):
    return {"id": f"app_{index}", "task_uid": "task_1", "provider": "0x" + f"{index + 1:02x}" * 20,
            "agent_id": str(index), "amount_raw": "1000000", "evaluator": "0x" + "44" * 20,
            "expired_at": now_s() + 7200, "application_nonce": "0x" + f"{index + 1:02x}" * 32,
            "valid_until": now_s() + 3600, "signature": "0x" + "11" * 65,
            "typed_data_json": "{}", "status": "active", "created_at": now_s(), "withdrawn_at": None}


def test_selection_transaction_freezes_one_application_and_one_order(tmp_path):
    db = MVPStore(tmp_path / "mvp.sqlite3")
    task = _task()
    db.create_task(task)
    for index in (1, 2):
        db.create_application(_application(index))
    order = {"id": "order_1", "task_uid": "task_1", "application_id": "app_1", "chain_id": 1952,
             "escrow": task["escrow"], "job_id": None, "buyer": task["buyer"],
             "provider": _application(1)["provider"], "evaluator": task["evaluator"], "agent_id": "1",
             "amount_raw": task["amount_raw"], "expired_at": task["expired_at"], "create_tx_hash": None,
             "status": "selected", "chain_status": None, "created_at": now_s(), "updated_at": now_s()}
    db.select_application(task_uid="task_1", application_id="app_1", buyer=task["buyer"], order=order)
    assert db.task("task_1")["selected_application_id"] == "app_1"
    assert [row["status"] for row in db.list_applications("task_1")] == ["selected", "invalid"]
    try:
        db.select_application(task_uid="task_1", application_id="app_2", buyer=task["buyer"], order={**order, "id": "order_2", "application_id": "app_2"})
        assert False, "a second selection must fail"
    except ValueError:
        pass


def test_chain_snapshot_deduplicates_and_reverses_reorged_events(tmp_path):
    db = MVPStore(tmp_path / "mvp.sqlite3")
    escrow = "0x" + "33" * 20
    event = {"hash": "0x" + "aa" * 32, "logIndex": 2, "blockNumber": 100,
             "blockHash": "0x" + "bb" * 32, "step": "JobFunded", "jobId": "7"}
    db.apply_chain_snapshot(chain_id=1952, escrow=escrow, events=[event, event], jobs=[], block_number=101,
                            anchor_number=90, anchor_hash="0x" + "cc" * 32)
    assert db.chain_event_count(1952, escrow) == 1
    # The Node snapshot is canonical; disappearance after an anchor rescan
    # marks the old read-model row removed rather than counting it forever.
    db.apply_chain_snapshot(chain_id=1952, escrow=escrow, events=[], jobs=[], block_number=102,
                            anchor_number=91, anchor_hash="0x" + "dd" * 32)
    assert db.chain_event_count(1952, escrow) == 0


def test_idempotency_key_cannot_be_rebound_to_another_actor(tmp_path):
    db = MVPStore(tmp_path / "mvp.sqlite3")
    at = now_s()
    intent = {"id": "tx_1", "idempotency_key": "fixed:key", "actor": "0x" + "11" * 20,
              "action": "register", "object_type": "provider-registration", "object_id": "new",
              "account": "0x" + "11" * 20, "chain_id": 1952, "to_address": "0x" + "22" * 20,
              "tx_data": "0x12", "tx_hash": None, "state": "prepared", "receipt_json": None,
              "error": None, "created_at": at, "updated_at": at}
    assert db.create_intent(intent)["id"] == "tx_1"
    try:
        db.create_intent({**intent, "id": "tx_2", "actor": "0x" + "33" * 20, "account": "0x" + "33" * 20})
        assert False, "idempotency keys must be actor-bound"
    except ValueError as exc:
        assert "already bound" in str(exc)
