"""SQLite persistence for the X Layer DemoUSD MVP.

Only this FastAPI process writes the business database.  Every connection
enables foreign keys, WAL and a bounded busy timeout; money is stored as
base-10 integer text and never converted through a float.
"""
from __future__ import annotations

import hashlib
import json
import secrets
import sqlite3
import time
import uuid
from contextlib import contextmanager
from pathlib import Path

SCHEMA_VERSION = 1


def now_s() -> int:
    return int(time.time())


def uid(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex}"


def json_text(value) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


class MVPStore:
    def __init__(self, path: Path | str):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.initialize()

    def connect(self) -> sqlite3.Connection:
        db = sqlite3.connect(self.path, timeout=5, isolation_level=None)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("PRAGMA busy_timeout=5000")
        return db

    @contextmanager
    def transaction(self, *, immediate: bool = False):
        db = self.connect()
        try:
            db.execute("BEGIN IMMEDIATE" if immediate else "BEGIN")
            yield db
            db.commit()
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    def initialize(self):
        with self.connect() as db:
            db.executescript(
                """
                CREATE TABLE IF NOT EXISTS wallet_nonces (
                  nonce TEXT PRIMARY KEY,
                  address TEXT NOT NULL,
                  requester_key TEXT NOT NULL,
                  domain TEXT NOT NULL,
                  uri TEXT NOT NULL,
                  message TEXT NOT NULL,
                  expires_at INTEGER NOT NULL,
                  consumed_at INTEGER,
                  created_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS wallet_nonces_rate
                  ON wallet_nonces(requester_key, created_at);
                CREATE TABLE IF NOT EXISTS sessions (
                  token_hash TEXT PRIMARY KEY,
                  address TEXT NOT NULL,
                  expires_at INTEGER NOT NULL,
                  revoked_at INTEGER,
                  created_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS sessions_address ON sessions(address);
                CREATE TABLE IF NOT EXISTS providers (
                  chain_id INTEGER NOT NULL,
                  registry TEXT NOT NULL,
                  agent_id TEXT NOT NULL,
                  owner TEXT NOT NULL,
                  name TEXT NOT NULL,
                  introduction TEXT NOT NULL,
                  template_id TEXT NOT NULL,
                  metadata_uri TEXT NOT NULL,
                  registration_tx_hash TEXT,
                  active INTEGER NOT NULL DEFAULT 1,
                  owner_verified_at INTEGER NOT NULL,
                  created_at INTEGER NOT NULL,
                  updated_at INTEGER NOT NULL,
                  PRIMARY KEY(chain_id, registry, agent_id)
                );
                CREATE INDEX IF NOT EXISTS providers_owner ON providers(owner);
                CREATE TABLE IF NOT EXISTS tasks (
                  uid TEXT PRIMARY KEY,
                  chain_id INTEGER NOT NULL,
                  escrow TEXT NOT NULL,
                  buyer TEXT NOT NULL,
                  title TEXT NOT NULL,
                  community_intro TEXT NOT NULL,
                  facts_json TEXT NOT NULL,
                  sources_json TEXT NOT NULL,
                  audience TEXT NOT NULL,
                  acceptance_json TEXT NOT NULL,
                  template_id TEXT NOT NULL,
                  amount_raw TEXT NOT NULL CHECK(amount_raw GLOB '[0-9]*' AND length(amount_raw)>0),
                  evaluator TEXT NOT NULL,
                  expired_at INTEGER NOT NULL,
                  task_hash TEXT NOT NULL,
                  manifest_cid TEXT NOT NULL,
                  manifest_sha256 TEXT NOT NULL,
                  status TEXT NOT NULL CHECK(status IN ('open','selected','closed')),
                  selected_application_id TEXT REFERENCES applications(id) ON DELETE RESTRICT,
                  created_at INTEGER NOT NULL,
                  closed_at INTEGER
                );
                CREATE INDEX IF NOT EXISTS tasks_buyer ON tasks(buyer, created_at);
                CREATE TABLE IF NOT EXISTS applications (
                  id TEXT PRIMARY KEY,
                  task_uid TEXT NOT NULL REFERENCES tasks(uid) ON DELETE RESTRICT,
                  provider TEXT NOT NULL,
                  agent_id TEXT NOT NULL,
                  amount_raw TEXT NOT NULL CHECK(amount_raw GLOB '[0-9]*' AND length(amount_raw)>0),
                  evaluator TEXT NOT NULL,
                  expired_at INTEGER NOT NULL,
                  application_nonce TEXT NOT NULL,
                  valid_until INTEGER NOT NULL,
                  signature TEXT NOT NULL,
                  typed_data_json TEXT NOT NULL,
                  status TEXT NOT NULL CHECK(status IN ('active','withdrawn','selected','invalid')),
                  created_at INTEGER NOT NULL,
                  withdrawn_at INTEGER,
                  UNIQUE(task_uid, provider, application_nonce)
                );
                CREATE INDEX IF NOT EXISTS applications_task ON applications(task_uid, status);
                CREATE TABLE IF NOT EXISTS orders (
                  id TEXT PRIMARY KEY,
                  task_uid TEXT NOT NULL UNIQUE REFERENCES tasks(uid) ON DELETE RESTRICT,
                  application_id TEXT NOT NULL UNIQUE REFERENCES applications(id) ON DELETE RESTRICT,
                  chain_id INTEGER NOT NULL,
                  escrow TEXT NOT NULL,
                  job_id TEXT,
                  buyer TEXT NOT NULL,
                  provider TEXT NOT NULL,
                  evaluator TEXT NOT NULL,
                  agent_id TEXT NOT NULL,
                  amount_raw TEXT NOT NULL CHECK(amount_raw GLOB '[0-9]*' AND length(amount_raw)>0),
                  expired_at INTEGER NOT NULL,
                  create_tx_hash TEXT,
                  status TEXT NOT NULL,
                  chain_status TEXT,
                  created_at INTEGER NOT NULL,
                  updated_at INTEGER NOT NULL,
                  UNIQUE(chain_id, escrow, job_id)
                );
                CREATE INDEX IF NOT EXISTS orders_roles ON orders(buyer, provider, evaluator);
                CREATE TABLE IF NOT EXISTS deliveries (
                  id TEXT PRIMARY KEY,
                  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id) ON DELETE RESTRICT,
                  provider TEXT NOT NULL,
                  document_path TEXT NOT NULL,
                  manifest_path TEXT,
                  file_cid TEXT,
                  manifest_cid TEXT,
                  file_size INTEGER NOT NULL,
                  file_sha256 TEXT NOT NULL,
                  manifest_sha256 TEXT,
                  manifest_keccak TEXT,
                  uri TEXT,
                  stage TEXT NOT NULL,
                  error TEXT,
                  car_path TEXT,
                  tx_hash TEXT,
                  created_at INTEGER NOT NULL,
                  updated_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS tx_intents (
                  id TEXT PRIMARY KEY,
                  idempotency_key TEXT NOT NULL UNIQUE,
                  actor TEXT NOT NULL,
                  action TEXT NOT NULL,
                  object_type TEXT NOT NULL,
                  object_id TEXT NOT NULL,
                  account TEXT NOT NULL,
                  chain_id INTEGER NOT NULL,
                  to_address TEXT,
                  tx_data TEXT,
                  tx_hash TEXT,
                  state TEXT NOT NULL,
                  receipt_json TEXT,
                  error TEXT,
                  created_at INTEGER NOT NULL,
                  updated_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS tx_intents_object ON tx_intents(object_type, object_id);
                CREATE TABLE IF NOT EXISTS chain_events (
                  chain_id INTEGER NOT NULL,
                  tx_hash TEXT NOT NULL,
                  log_index INTEGER NOT NULL,
                  escrow TEXT NOT NULL,
                  block_number INTEGER NOT NULL,
                  block_hash TEXT NOT NULL,
                  event_name TEXT NOT NULL,
                  job_id TEXT,
                  payload_json TEXT NOT NULL,
                  removed INTEGER NOT NULL DEFAULT 0,
                  created_at INTEGER NOT NULL,
                  PRIMARY KEY(chain_id, tx_hash, log_index)
                );
                CREATE INDEX IF NOT EXISTS chain_events_job ON chain_events(chain_id, escrow, job_id);
                CREATE TABLE IF NOT EXISTS cursors (
                  chain_id INTEGER NOT NULL,
                  contract TEXT NOT NULL,
                  event_group TEXT NOT NULL,
                  next_block INTEGER NOT NULL,
                  anchor_number INTEGER,
                  anchor_hash TEXT,
                  updated_at INTEGER NOT NULL,
                  PRIMARY KEY(chain_id, contract, event_group)
                );
                """
            )
            db.execute(f"PRAGMA user_version={SCHEMA_VERSION}")

    @staticmethod
    def row(row):
        return dict(row) if row is not None else None

    def issue_nonce(self, *, nonce, address, requester_key, domain, uri, message, expires_at, limit=5):
        at = now_s()
        with self.transaction(immediate=True) as db:
            count = db.execute(
                "SELECT count(*) FROM wallet_nonces WHERE requester_key=? AND created_at>=?",
                (requester_key, at - 60),
            ).fetchone()[0]
            if count >= limit:
                raise ValueError("too many sign-in challenges; retry in one minute")
            db.execute(
                "INSERT INTO wallet_nonces VALUES(?,?,?,?,?,?,?,?,?)",
                (nonce, address, requester_key, domain, uri, message, expires_at, None, at),
            )

    def consume_nonce(self, nonce):
        at = now_s()
        with self.transaction(immediate=True) as db:
            row = db.execute("SELECT * FROM wallet_nonces WHERE nonce=?", (nonce,)).fetchone()
            if not row or row["consumed_at"] is not None or row["expires_at"] < at:
                return None
            changed = db.execute(
                "UPDATE wallet_nonces SET consumed_at=? WHERE nonce=? AND consumed_at IS NULL",
                (at, nonce),
            ).rowcount
            return self.row(row) if changed == 1 else None

    def create_session(self, address, ttl):
        token = secrets.token_urlsafe(32)
        digest = hashlib.sha256(token.encode()).hexdigest()
        at = now_s()
        with self.transaction() as db:
            db.execute("INSERT INTO sessions VALUES(?,?,?,?,?)", (digest, address, at + ttl, None, at))
        return token

    def session_address(self, token):
        if not token:
            return None
        digest = hashlib.sha256(str(token).encode()).hexdigest()
        with self.connect() as db:
            row = db.execute(
                "SELECT address FROM sessions WHERE token_hash=? AND revoked_at IS NULL AND expires_at>=?",
                (digest, now_s()),
            ).fetchone()
        return row["address"] if row else None

    def revoke_session(self, token):
        if not token:
            return
        digest = hashlib.sha256(str(token).encode()).hexdigest()
        with self.transaction() as db:
            db.execute("UPDATE sessions SET revoked_at=? WHERE token_hash=?", (now_s(), digest))

    def upsert_provider(self, record):
        at = now_s()
        values = (
            record["chain_id"], record["registry"], str(record["agent_id"]), record["owner"],
            record["name"], record["introduction"], record["template_id"], record["metadata_uri"],
            record.get("registration_tx_hash"), at, at, at,
        )
        with self.transaction() as db:
            db.execute(
                """INSERT INTO providers(chain_id,registry,agent_id,owner,name,introduction,template_id,
                   metadata_uri,registration_tx_hash,owner_verified_at,created_at,updated_at)
                   VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
                   ON CONFLICT(chain_id,registry,agent_id) DO UPDATE SET
                   owner=excluded.owner,name=excluded.name,introduction=excluded.introduction,
                   template_id=excluded.template_id,metadata_uri=excluded.metadata_uri,
                   registration_tx_hash=COALESCE(excluded.registration_tx_hash,providers.registration_tx_hash),
                   active=1,owner_verified_at=excluded.owner_verified_at,updated_at=excluded.updated_at""",
                values,
            )

    def list_providers(self, chain_id, registry):
        with self.connect() as db:
            rows = db.execute(
                "SELECT * FROM providers WHERE chain_id=? AND registry=? AND active=1 ORDER BY created_at DESC",
                (chain_id, registry),
            ).fetchall()
        return [self.row(r) for r in rows]

    def provider(self, chain_id, registry, agent_id):
        with self.connect() as db:
            return self.row(db.execute(
                "SELECT * FROM providers WHERE chain_id=? AND registry=? AND agent_id=?",
                (chain_id, registry, str(agent_id)),
            ).fetchone())

    def create_task(self, task):
        columns = (
            "uid","chain_id","escrow","buyer","title","community_intro","facts_json","sources_json",
            "audience","acceptance_json","template_id","amount_raw","evaluator","expired_at","task_hash",
            "manifest_cid","manifest_sha256","status","selected_application_id","created_at","closed_at",
        )
        values = tuple(task.get(c) for c in columns)
        with self.transaction() as db:
            db.execute(f"INSERT INTO tasks({','.join(columns)}) VALUES({','.join('?' for _ in columns)})", values)
        return task

    def task(self, task_uid):
        with self.connect() as db:
            return self.row(db.execute("SELECT * FROM tasks WHERE uid=?", (task_uid,)).fetchone())

    def list_tasks(self, *, address=None):
        with self.connect() as db:
            if address:
                rows = db.execute(
                    """SELECT DISTINCT t.* FROM tasks t
                       LEFT JOIN applications a ON a.task_uid=t.uid
                       WHERE t.buyer=? OR t.evaluator=? OR a.provider=? ORDER BY t.created_at DESC""",
                    (address, address, address),
                ).fetchall()
            else:
                rows = db.execute("SELECT * FROM tasks ORDER BY created_at DESC").fetchall()
        return [self.row(r) for r in rows]

    def close_task(self, task_uid, buyer):
        with self.transaction(immediate=True) as db:
            changed = db.execute(
                "UPDATE tasks SET status='closed',closed_at=? WHERE uid=? AND buyer=? AND status='open'",
                (now_s(), task_uid, buyer),
            ).rowcount
        return changed == 1

    def create_application(self, app):
        columns = ("id","task_uid","provider","agent_id","amount_raw","evaluator","expired_at",
                   "application_nonce","valid_until","signature","typed_data_json","status","created_at","withdrawn_at")
        with self.transaction(immediate=True) as db:
            db.execute(f"INSERT INTO applications({','.join(columns)}) VALUES({','.join('?' for _ in columns)})",
                       tuple(app.get(c) for c in columns))
        return app

    def application(self, application_id):
        with self.connect() as db:
            return self.row(db.execute("SELECT * FROM applications WHERE id=?", (application_id,)).fetchone())

    def list_applications(self, task_uid):
        with self.connect() as db:
            rows = db.execute("SELECT * FROM applications WHERE task_uid=? ORDER BY created_at,id", (task_uid,)).fetchall()
        return [self.row(r) for r in rows]

    def withdraw_application(self, application_id, provider):
        with self.transaction(immediate=True) as db:
            changed = db.execute(
                "UPDATE applications SET status='withdrawn',withdrawn_at=? WHERE id=? AND provider=? AND status='active'",
                (now_s(), application_id, provider),
            ).rowcount
        return changed == 1

    def select_application(self, *, task_uid, application_id, buyer, order):
        at = now_s()
        with self.transaction(immediate=True) as db:
            task = db.execute("SELECT * FROM tasks WHERE uid=?", (task_uid,)).fetchone()
            app = db.execute("SELECT * FROM applications WHERE id=? AND task_uid=?", (application_id, task_uid)).fetchone()
            if not task or task["buyer"] != buyer or task["status"] != "open":
                raise ValueError("task is not open or is not owned by this wallet")
            if not app or app["status"] != "active" or app["valid_until"] < at:
                raise ValueError("application is no longer valid")
            db.execute("UPDATE applications SET status='selected' WHERE id=?", (application_id,))
            db.execute("UPDATE applications SET status='invalid' WHERE task_uid=? AND id<>? AND status='active'", (task_uid, application_id))
            db.execute("UPDATE tasks SET status='selected',selected_application_id=? WHERE uid=?", (application_id, task_uid))
            columns = ("id","task_uid","application_id","chain_id","escrow","job_id","buyer","provider",
                       "evaluator","agent_id","amount_raw","expired_at","create_tx_hash","status","chain_status",
                       "created_at","updated_at")
            db.execute(f"INSERT INTO orders({','.join(columns)}) VALUES({','.join('?' for _ in columns)})",
                       tuple(order.get(c) for c in columns))
        return order

    def order(self, order_id):
        with self.connect() as db:
            return self.row(db.execute("SELECT * FROM orders WHERE id=?", (order_id,)).fetchone())

    def list_orders(self, address=None):
        with self.connect() as db:
            if address:
                rows = db.execute(
                    "SELECT * FROM orders WHERE buyer=? OR provider=? OR evaluator=? ORDER BY created_at DESC",
                    (address, address, address),
                ).fetchall()
            else:
                rows = db.execute("SELECT * FROM orders ORDER BY created_at DESC").fetchall()
        return [self.row(r) for r in rows]

    def update_order(self, order_id, **fields):
        allowed = {"job_id","create_tx_hash","status","chain_status"}
        values = {k: v for k, v in fields.items() if k in allowed}
        if not values:
            return
        values["updated_at"] = now_s()
        with self.transaction() as db:
            db.execute(f"UPDATE orders SET {','.join(f'{k}=?' for k in values)} WHERE id=?", (*values.values(), order_id))

    def delivery(self, order_id):
        with self.connect() as db:
            return self.row(db.execute("SELECT * FROM deliveries WHERE order_id=?", (order_id,)).fetchone())

    def save_delivery(self, delivery):
        columns = ("id","order_id","provider","document_path","manifest_path","file_cid","manifest_cid",
                   "file_size","file_sha256","manifest_sha256","manifest_keccak","uri","stage","error",
                   "car_path","tx_hash","created_at","updated_at")
        with self.transaction(immediate=True) as db:
            db.execute(f"INSERT INTO deliveries({','.join(columns)}) VALUES({','.join('?' for _ in columns)})",
                       tuple(delivery.get(c) for c in columns))
        return delivery

    def update_delivery(self, order_id, **fields):
        allowed = {"manifest_path","file_cid","manifest_cid","manifest_sha256","manifest_keccak","uri",
                   "stage","error","car_path","tx_hash"}
        values = {k: v for k, v in fields.items() if k in allowed}
        values["updated_at"] = now_s()
        with self.transaction() as db:
            db.execute(f"UPDATE deliveries SET {','.join(f'{k}=?' for k in values)} WHERE order_id=?",
                       (*values.values(), order_id))

    def create_intent(self, intent):
        columns = ("id","idempotency_key","actor","action","object_type","object_id","account","chain_id",
                   "to_address","tx_data","tx_hash","state","receipt_json","error","created_at","updated_at")
        with self.transaction(immediate=True) as db:
            existing = db.execute("SELECT * FROM tx_intents WHERE idempotency_key=?", (intent["idempotency_key"],)).fetchone()
            if existing:
                if any(existing[key] != intent[key] for key in ("actor", "action", "object_type", "object_id", "account", "chain_id")):
                    raise ValueError("idempotency key is already bound to another transaction intent")
                return self.row(existing)
            db.execute(f"INSERT INTO tx_intents({','.join(columns)}) VALUES({','.join('?' for _ in columns)})",
                       tuple(intent.get(c) for c in columns))
        return intent

    def intent(self, intent_id):
        with self.connect() as db:
            return self.row(db.execute("SELECT * FROM tx_intents WHERE id=?", (intent_id,)).fetchone())

    def update_intent(self, intent_id, *, actor, **fields):
        allowed = {"to_address","tx_data","tx_hash","state","receipt_json","error"}
        values = {k: v for k, v in fields.items() if k in allowed}
        values["updated_at"] = now_s()
        with self.transaction(immediate=True) as db:
            changed = db.execute(
                f"UPDATE tx_intents SET {','.join(f'{k}=?' for k in values)} WHERE id=? AND actor=?",
                (*values.values(), intent_id, actor),
            ).rowcount
        return changed == 1

    def list_intents(self, actor):
        with self.connect() as db:
            rows = db.execute("SELECT * FROM tx_intents WHERE actor=? ORDER BY created_at DESC", (actor,)).fetchall()
        return [self.row(r) for r in rows]

    def apply_chain_snapshot(self, *, chain_id, escrow, events, jobs, block_number, anchor_number=None, anchor_hash=None):
        """Replace the confirmed event read-model for one escrow atomically.

        Node has already rescanned from a verified anchor.  Marking the old
        rows removed before upserting the current canonical snapshot makes a
        disappeared reorg log reversible instead of double-counted.
        """
        at = now_s()
        escrow = escrow.lower()
        status_map = {"Created": "created", "Funded": "funded", "Submitted": "submitted",
                      "Completed": "completed", "Rejected": "rejected", "Expired": "expired"}
        with self.transaction(immediate=True) as db:
            db.execute("UPDATE chain_events SET removed=1 WHERE chain_id=? AND escrow=?", (chain_id, escrow))
            for event in events:
                if event.get("logIndex") is None or not event.get("blockHash"):
                    continue
                db.execute(
                    """INSERT INTO chain_events(chain_id,tx_hash,log_index,escrow,block_number,block_hash,
                       event_name,job_id,payload_json,removed,created_at) VALUES(?,?,?,?,?,?,?,?,?,0,?)
                       ON CONFLICT(chain_id,tx_hash,log_index) DO UPDATE SET escrow=excluded.escrow,
                       block_number=excluded.block_number,block_hash=excluded.block_hash,event_name=excluded.event_name,
                       job_id=excluded.job_id,payload_json=excluded.payload_json,removed=0""",
                    (chain_id, event["hash"].lower(), int(event["logIndex"]), escrow, int(event["blockNumber"]),
                     event["blockHash"].lower(), event["step"], str(event.get("jobId") or "") or None,
                     json_text(event), at),
                )
            for job in jobs:
                row = db.execute("SELECT id,status FROM orders WHERE chain_id=? AND escrow=? AND job_id=?",
                                 (chain_id, escrow, str(job["id"]))).fetchone()
                if not row:
                    continue
                chain_status = job["status"]
                app_status = status_map.get(chain_status, row["status"])
                if row["status"] == "delivery_ready" and chain_status == "Funded":
                    app_status = row["status"]
                db.execute("UPDATE orders SET chain_status=?,status=?,updated_at=? WHERE id=?",
                           (chain_status, app_status, at, row["id"]))
            db.execute(
                """INSERT INTO cursors(chain_id,contract,event_group,next_block,anchor_number,anchor_hash,updated_at)
                   VALUES(?,?,?,?,?,?,?) ON CONFLICT(chain_id,contract,event_group) DO UPDATE SET
                   next_block=excluded.next_block,anchor_number=excluded.anchor_number,
                   anchor_hash=excluded.anchor_hash,updated_at=excluded.updated_at""",
                (chain_id, escrow, "escrow", int(block_number) + 1, anchor_number, anchor_hash, at),
            )

    def chain_event_count(self, chain_id, escrow):
        with self.connect() as db:
            return db.execute("SELECT count(*) FROM chain_events WHERE chain_id=? AND escrow=? AND removed=0",
                              (chain_id, escrow.lower())).fetchone()[0]
