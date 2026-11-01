"""SQLite persistence for tournaments (both in-progress and finished).

Everything lives in one file, data/tournaments.db, created on first run.
Each row stores the full serialized engine state as JSON, so an
in-progress tournament survives closing the app and can be resumed later.
"""
from __future__ import annotations

import json
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

DB_PATH = Path(__file__).parent / "data" / "tournaments.db"


def _connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    with _connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS tournaments (
                id TEXT PRIMARY KEY,
                category TEXT NOT NULL,
                mode TEXT NOT NULL DEFAULT 'full',
                top_n INTEGER,
                created_at TEXT NOT NULL,
                finished_at TEXT,
                done INTEGER NOT NULL DEFAULT 0,
                engine_json TEXT NOT NULL,
                vote_log_json TEXT NOT NULL DEFAULT '[]',
                manual_timer INTEGER NOT NULL DEFAULT 0,
                phone_voting INTEGER NOT NULL DEFAULT 0,
                rematch_of TEXT
            )
            """
        )
        # Each phone voter's own ranking of a finished phone-voting game.
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS personal_rankings (
                tid TEXT NOT NULL,
                name TEXT NOT NULL,
                engine_json TEXT NOT NULL,
                prefilled INTEGER NOT NULL DEFAULT 0,
                done INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (tid, name)
            )
            """
        )
        # Lightweight migration for DBs created before these columns existed.
        existing_cols = {row["name"] for row in conn.execute("PRAGMA table_info(tournaments)")}
        if "mode" not in existing_cols:
            conn.execute("ALTER TABLE tournaments ADD COLUMN mode TEXT NOT NULL DEFAULT 'full'")
        if "top_n" not in existing_cols:
            conn.execute("ALTER TABLE tournaments ADD COLUMN top_n INTEGER")
        if "vote_log_json" not in existing_cols:
            conn.execute("ALTER TABLE tournaments ADD COLUMN vote_log_json TEXT NOT NULL DEFAULT '[]'")
        if "manual_timer" not in existing_cols:
            conn.execute("ALTER TABLE tournaments ADD COLUMN manual_timer INTEGER NOT NULL DEFAULT 0")
        if "phone_voting" not in existing_cols:
            conn.execute("ALTER TABLE tournaments ADD COLUMN phone_voting INTEGER NOT NULL DEFAULT 0")
        if "rematch_of" not in existing_cols:
            conn.execute("ALTER TABLE tournaments ADD COLUMN rematch_of TEXT")


def create(
    category: str,
    engine_dict: dict,
    mode: str = "full",
    top_n: Optional[int] = None,
    manual_timer: bool = False,
    phone_voting: bool = False,
    rematch_of: Optional[str] = None,
) -> str:
    tid = str(uuid.uuid4())
    with _connect() as conn:
        conn.execute(
            "INSERT INTO tournaments "
            "(id, category, mode, top_n, manual_timer, phone_voting, rematch_of, created_at, done, engine_json) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)",
            (tid, category, mode, top_n, int(manual_timer), int(phone_voting), rematch_of,
             datetime.now(timezone.utc).isoformat(),
             json.dumps(engine_dict)),
        )
    return tid


def update(tid: str, engine_dict: dict, done: bool, vote_log: Optional[list] = None) -> None:
    with _connect() as conn:
        if vote_log is not None:
            if done:
                conn.execute(
                    "UPDATE tournaments SET engine_json = ?, vote_log_json = ?, done = 1, finished_at = ? WHERE id = ?",
                    (json.dumps(engine_dict), json.dumps(vote_log), datetime.now(timezone.utc).isoformat(), tid),
                )
            else:
                conn.execute(
                    "UPDATE tournaments SET engine_json = ?, vote_log_json = ? WHERE id = ?",
                    (json.dumps(engine_dict), json.dumps(vote_log), tid),
                )
        elif done:
            conn.execute(
                "UPDATE tournaments SET engine_json = ?, done = 1, finished_at = ? WHERE id = ?",
                (json.dumps(engine_dict), datetime.now(timezone.utc).isoformat(), tid),
            )
        else:
            conn.execute(
                "UPDATE tournaments SET engine_json = ? WHERE id = ?",
                (json.dumps(engine_dict), tid),
            )


def get(tid: str) -> Optional[dict]:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM tournaments WHERE id = ?", (tid,)).fetchone()
        return dict(row) if row else None


def get_active() -> Optional[dict]:
    """The most recently created unfinished tournament, if any."""
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM tournaments WHERE done = 0 ORDER BY created_at DESC LIMIT 1"
        ).fetchone()
        return dict(row) if row else None


def list_history() -> list[dict]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT * FROM tournaments WHERE done = 1 ORDER BY finished_at DESC"
        ).fetchall()
        return [dict(r) for r in rows]


def delete(tid: str) -> None:
    with _connect() as conn:
        conn.execute("DELETE FROM tournaments WHERE id = ?", (tid,))
        conn.execute("DELETE FROM personal_rankings WHERE tid = ?", (tid,))


def get_personal(tid: str, name: str) -> Optional[dict]:
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM personal_rankings WHERE tid = ? AND name = ?", (tid, name)
        ).fetchone()
        return dict(row) if row else None


def save_personal(tid: str, name: str, engine_dict: dict, prefilled: int, done: bool) -> None:
    with _connect() as conn:
        conn.execute(
            "INSERT INTO personal_rankings (tid, name, engine_json, prefilled, done, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?) "
            "ON CONFLICT (tid, name) DO UPDATE SET engine_json = excluded.engine_json, "
            "prefilled = excluded.prefilled, done = excluded.done, updated_at = excluded.updated_at",
            (tid, name, json.dumps(engine_dict), prefilled, int(done), datetime.now(timezone.utc).isoformat()),
        )


def list_personal(tid: str) -> list[dict]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT * FROM personal_rankings WHERE tid = ? ORDER BY updated_at", (tid,)
        ).fetchall()
        return [dict(r) for r in rows]
