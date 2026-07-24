"""
SQLite database for practice history.

Schema:
- practice_log: one row per practice session
  - id, exercise_id, practiced_at, tempo_bpm, key, duration_min, notes, completed
- collections: named groups of exercises (e.g. "Coltrane warmup")
  - id, name, created_at
- collection_items: many-to-many
  - collection_id, exercise_id, position
- favorites: exercise_id (string for etude support) -> created_at
- users: login accounts. role='admin' can save etudes server-side and
  edit data; role='user' is a regular member. Default new users are 'user'.
  - id, username UNIQUE, password_hash, password_salt, role, created_at
- sessions: opaque token -> user_id, expires_at
  - token (primary key, random 32-byte hex), user_id, expires_at, created_at
- etudes: server-side etude storage. One row per etude; musicxml cached
  so the Practice page can render without re-stitching. Owned by user_id.
  - id, user_id, name, exercise_ids_json, semitones_json, musicxml,
    source, note_count, created_at, updated_at
"""
import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

DB_PATH = Path(__file__).parent / "practice.db"
_LOCK = threading.Lock()


@contextmanager
def get_db():
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db():
    """Create tables if they don't exist."""
    with _LOCK, get_db() as conn:
        c = conn.cursor()
        c.execute("""
            CREATE TABLE IF NOT EXISTS practice_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                exercise_id INTEGER NOT NULL,
                practiced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                tempo_bpm INTEGER,
                key_signature TEXT,
                duration_min REAL,
                notes TEXT,
                completed INTEGER NOT NULL DEFAULT 0
            )
        """)
        c.execute("""
            CREATE INDEX IF NOT EXISTS idx_practice_exercise
            ON practice_log(exercise_id, practiced_at DESC)
        """)
        c.execute("""
            CREATE INDEX IF NOT EXISTS idx_practice_time
            ON practice_log(practiced_at DESC)
        """)
        # Migration: favorites.exercise_id was originally INTEGER PRIMARY KEY
        # but we now want to support string etude IDs (e.g. "etude_<uuid>")
        # alongside numeric exercise IDs. SQLite can't ALTER a column's
        # type, so if the old INTEGER schema is in place we copy the rows
        # to a new TEXT-typed table, drop the old one, and rename.
        # Old numeric favorites are preserved (cast to TEXT); the migration
        # is idempotent and runs only when needed.
        c.execute("PRAGMA table_info(favorites)")
        cols = c.fetchall()
        if cols and cols[0][2] == 'INTEGER':
            # Old INTEGER schema detected. Recreate as TEXT.
            c.execute("""
                CREATE TABLE IF NOT EXISTS __favorites_migrated (
                    exercise_id TEXT PRIMARY KEY,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                )
            """)
            try:
                c.execute("""
                    INSERT OR IGNORE INTO __favorites_migrated (exercise_id, created_at)
                    SELECT CAST(exercise_id AS TEXT), created_at FROM favorites
                """)
            except sqlite3.OperationalError:
                pass
            c.execute("DROP TABLE favorites")
            c.execute("ALTER TABLE __favorites_migrated RENAME TO favorites")
        c.execute("""
            CREATE TABLE IF NOT EXISTS favorites (
                exercise_id TEXT PRIMARY KEY,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
        """)
        c.execute("""
            CREATE TABLE IF NOT EXISTS collections (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                description TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
        """)
        c.execute("""
            CREATE TABLE IF NOT EXISTS collection_items (
                collection_id INTEGER NOT NULL,
                exercise_id INTEGER NOT NULL,
                position INTEGER NOT NULL,
                PRIMARY KEY (collection_id, exercise_id),
                FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE
            )
        """)
        # Admin / auth tables. Users with role='admin' can save etudes
        # server-side (and persist them across devices/browsers) and
        # edit the data. Sessions are random 32-byte hex tokens stored
        # in the Authorization: Bearer header (or via cookie if the
        # frontend prefers). Expires after SESSION_TTL_HOURS.
        c.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                password_salt TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'user',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
        """)
        c.execute("""
            CREATE TABLE IF NOT EXISTS sessions (
                token TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL,
                expires_at TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        """)
        c.execute("""
            CREATE INDEX IF NOT EXISTS idx_sessions_user
            ON sessions(user_id)
        """)
        # Server-side etude storage. One row per etude; musicxml is
        # the precomputed stitched MusicXML string. exerciseIds +
        # semitones are JSON arrays (parallel) so they round-trip
        # without a join table.
        c.execute("""
            CREATE TABLE IF NOT EXISTS etudes (
                id TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL,
                name TEXT NOT NULL,
                exercise_ids_json TEXT NOT NULL DEFAULT '[]',
                semitones_json TEXT NOT NULL DEFAULT '[]',
                musicxml TEXT NOT NULL,
                source TEXT,
                note_count INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        """)
        c.execute("""
            CREATE INDEX IF NOT EXISTS idx_etudes_user_created
            ON etudes(user_id, created_at DESC)
        """)
        # Curated MXL — admin-only, shared across all users. Lets the
        # admin upload .mxl files via the etudes page Curated tab; they
        # show up in the browse page as a "★ Curated" section. Anyone
        # can view + load them; only admins can add/delete.
        c.execute("""
            CREATE TABLE IF NOT EXISTS curated_mxl (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT,
                musicxml TEXT NOT NULL,
                original_filename TEXT,
                uploaded_by INTEGER,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE SET NULL
            )
        """)
        c.execute("""
            CREATE INDEX IF NOT EXISTS idx_curated_mxl_created
            ON curated_mxl(created_at DESC)
        """)
        # Seed default collections
        c.execute("SELECT COUNT(*) FROM collections")
        if c.fetchone()[0] == 0:
            seeds = [
                ("Coltrane-style", "Major thirds, quartals, sheets of sound", 1, 87, 145, 200, 280),
                ("Bud Powell bebop", "8th note bebop phrases, dominant vocabulary", 16, 79, 252, 296, 320),
                ("Barry Harris diminished", "Diminished 7th arpeggios, related dominants", 65, 67, 295, 300, 305, 310),
                ("30-min Warmup", "Quick chromatic + scalic + arpeggio warmup", 1, 2, 12, 24, 31, 50, 100),
                ("II-V-I Essentials", "Core II-V-I patterns from section 4", 246, 255, 278, 290, 300, 320),
                ("Whole Tone Studies", "All whole tone / augmented exercises", 145, 150, 160, 170, 180, 190),
            ]
            for name, desc, *ex_ids in seeds:
                c.execute(
                    "INSERT INTO collections (name, description) VALUES (?, ?)",
                    (name, desc),
                )
                cid = c.lastrowid
                for pos, eid in enumerate(ex_ids):
                    c.execute(
                        "INSERT INTO collection_items (collection_id, exercise_id, position) VALUES (?, ?, ?)",
                        (cid, eid, pos),
                    )


# ===== Favorites API =====

def add_favorite(exercise_id):
    with _LOCK, get_db() as conn:
        c = conn.cursor()
        c.execute(
            "INSERT OR IGNORE INTO favorites (exercise_id) VALUES (?)",
            (exercise_id,),
        )
        return c.rowcount > 0

def remove_favorite(exercise_id):
    with _LOCK, get_db() as conn:
        c = conn.cursor()
        c.execute("DELETE FROM favorites WHERE exercise_id = ?", (exercise_id,))
        return c.rowcount > 0

def is_favorite(exercise_id):
    with _LOCK, get_db() as conn:
        c = conn.cursor()
        c.execute("SELECT 1 FROM favorites WHERE exercise_id = ?", (exercise_id,))
        return c.fetchone() is not None

def get_favorites():
    with _LOCK, get_db() as conn:
        c = conn.cursor()
        c.execute("SELECT exercise_id, created_at FROM favorites ORDER BY created_at DESC")
        return [dict(r) for r in c.fetchall()]

# ===== Practice log API =====

def log_practice(exercise_id, tempo_bpm=None, key_signature=None,
                 duration_min=None, notes=None, completed=True, practiced_at=None):
    if practiced_at is None:
        practiced_at = datetime.utcnow().isoformat() + "Z"
    with _LOCK, get_db() as conn:
        c = conn.cursor()
        c.execute("""
            INSERT INTO practice_log
              (exercise_id, practiced_at, tempo_bpm, key_signature, duration_min, notes, completed)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (exercise_id, practiced_at, tempo_bpm, key_signature, duration_min, notes,
              1 if completed else 0))
        return c.lastrowid


def delete_practice_log(log_id):
    with _LOCK, get_db() as conn:
        c = conn.cursor()
        c.execute("DELETE FROM practice_log WHERE id = ?", (log_id,))
        return c.rowcount > 0

def get_exercise_history(exercise_id, limit=20):
    with _LOCK, get_db() as conn:
        c = conn.cursor()
        c.execute("""
            SELECT * FROM practice_log
            WHERE exercise_id = ?
            ORDER BY practiced_at DESC
            LIMIT ?
        """, (exercise_id, limit))
        return [dict(r) for r in c.fetchall()]


def get_recent_practice(days=30, limit=100):
    cutoff = (datetime.utcnow() - timedelta(days=days)).isoformat() + "Z"
    with _LOCK, get_db() as conn:
        c = conn.cursor()
        c.execute("""
            SELECT * FROM practice_log
            WHERE practiced_at >= ?
            ORDER BY practiced_at DESC
            LIMIT ?
        """, (cutoff, limit))
        return [dict(r) for r in c.fetchall()]


def get_practice_stats(days=30):
    """Get aggregated stats for the practice view."""
    cutoff = (datetime.utcnow() - timedelta(days=days)).isoformat() + "Z"
    with _LOCK, get_db() as conn:
        c = conn.cursor()
        # Total sessions, exercises, time
        c.execute("""
            SELECT
                COUNT(*) AS sessions,
                COUNT(DISTINCT exercise_id) AS unique_exercises,
                COALESCE(SUM(duration_min), 0) AS total_minutes,
                COALESCE(AVG(tempo_bpm), 0) AS avg_tempo,
                COALESCE(MAX(tempo_bpm), 0) AS max_tempo
            FROM practice_log
            WHERE practiced_at >= ?
        """, (cutoff,))
        overall = dict(c.fetchone())

        # Per-day counts for the last `days` days
        c.execute("""
            SELECT
                date(practiced_at) AS day,
                COUNT(*) AS sessions,
                COUNT(DISTINCT exercise_id) AS unique_exercises,
                COALESCE(SUM(duration_min), 0) AS minutes
            FROM practice_log
            WHERE practiced_at >= ?
            GROUP BY date(practiced_at)
            ORDER BY day
        """, (cutoff,))
        by_day = [dict(r) for r in c.fetchall()]

        # Most practiced exercises
        c.execute("""
            SELECT exercise_id, COUNT(*) AS sessions, MAX(tempo_bpm) AS best_tempo
            FROM practice_log
            WHERE practiced_at >= ?
            GROUP BY exercise_id
            ORDER BY sessions DESC
            LIMIT 10
        """, (cutoff,))
        top_exercises = [dict(r) for r in c.fetchall()]

        return {
            "overall": overall,
            "by_day": by_day,
            "top_exercises": top_exercises,
        }


def get_exercise_summary(exercise_id):
    """One-line summary of an exercise for card display."""
    with _LOCK, get_db() as conn:
        c = conn.cursor()
        c.execute("""
            SELECT
                COUNT(*) AS times_practiced,
                MAX(practiced_at) AS last_practiced,
                MAX(tempo_bpm) AS best_tempo
            FROM practice_log
            WHERE exercise_id = ?
        """, (exercise_id,))
        row = c.fetchone()
        return dict(row) if row else {}


# ===== Collections API =====

def list_collections():
    with _LOCK, get_db() as conn:
        c = conn.cursor()
        c.execute("""
            SELECT c.*, COUNT(ci.exercise_id) AS exercise_count
            FROM collections c
            LEFT JOIN collection_items ci ON ci.collection_id = c.id
            GROUP BY c.id
            ORDER BY c.created_at DESC
        """)
        return [dict(r) for r in c.fetchall()]


def get_collection(collection_id):
    with _LOCK, get_db() as conn:
        c = conn.cursor()
        c.execute("SELECT * FROM collections WHERE id = ?", (collection_id,))
        col = c.fetchone()
        if not col:
            return None
        col = dict(col)
        c.execute("""
            SELECT exercise_id, position FROM collection_items
            WHERE collection_id = ?
            ORDER BY position
        """, (collection_id,))
        col["exercises"] = [r["exercise_id"] for r in c.fetchall()]
        return col


def create_collection(name, description=None, exercise_ids=None):
    with _LOCK, get_db() as conn:
        c = conn.cursor()
        try:
            c.execute(
                "INSERT INTO collections (name, description) VALUES (?, ?)",
                (name, description),
            )
        except sqlite3.IntegrityError:
            return None  # duplicate
        cid = c.lastrowid
        if exercise_ids:
            for pos, eid in enumerate(exercise_ids):
                c.execute(
                    "INSERT INTO collection_items (collection_id, exercise_id, position) VALUES (?, ?, ?)",
                    (cid, eid, pos),
                )
        return cid


def delete_collection(collection_id):
    with _LOCK, get_db() as conn:
        c = conn.cursor()
        c.execute("DELETE FROM collections WHERE id = ?", (collection_id,))
        return c.rowcount > 0


# ===== Curated MXL API =====
# Admin-curated MusicXML library. Shared read across all users; only
# admins can write. The .mxl is stored inline (not on disk) so the
# usual file-lifecycle worries (backups, migrations, etc.) collapse
# to "one SQL row per file". A typical curated MXL is 5-30 KB; the
# table stays small even with hundreds of entries.
import uuid as _uuid

def _new_curated_id():
    return "cur_" + _uuid.uuid4().hex[:12]

def list_curated_mxl():
    """All curated MXL items, newest first. Public read."""
    with get_db() as con:
        rows = con.execute(
            "SELECT id, name, description, original_filename, "
            "uploaded_by, created_at, updated_at "
            "FROM curated_mxl ORDER BY created_at DESC"
        ).fetchall()
        return [
            dict(
                id=r[0], name=r[1], description=r[2],
                original_filename=r[3], uploaded_by=r[4],
                created_at=r[5], updated_at=r[6],
            )
            for r in rows
        ]

def get_curated_mxl(curated_id):
    """One curated MXL with the full XML body. Returns None if not found."""
    with get_db() as con:
        row = con.execute(
            "SELECT id, name, description, musicxml, original_filename, "
            "uploaded_by, created_at, updated_at "
            "FROM curated_mxl WHERE id = ?",
            (curated_id,),
        ).fetchone()
        if not row:
            return None
        return dict(
            id=row[0], name=row[1], description=row[2],
            musicxml=row[3], original_filename=row[4],
            uploaded_by=row[5], created_at=row[6], updated_at=row[7],
        )

def create_curated_mxl(name, musicxml, description=None,
                       original_filename=None, uploaded_by=None):
    """Insert a new curated MXL. Returns the new id."""
    new_id = _new_curated_id()
    with get_db() as con:
        con.execute(
            "INSERT INTO curated_mxl "
            "(id, name, description, musicxml, original_filename, uploaded_by) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (new_id, name, description, musicxml, original_filename, uploaded_by),
        )
    return new_id

def delete_curated_mxl(curated_id):
    """Delete by id. Returns True if a row was removed."""
    with get_db() as con:
        cur = con.execute(
            "DELETE FROM curated_mxl WHERE id = ?", (curated_id,)
        )
        return cur.rowcount > 0


# ===== Users / auth =====
# PBKDF2-HMAC-SHA256 password hashing. 200k iterations + 16-byte salt
# is OWASP's 2023+ recommendation. The salt + iteration count are
# stored alongside the hash so we can rotate the parameters later
# without losing old accounts.
_PBKDF2_ITERS = 200_000
_PBKDF2_SALT_BYTES = 16
_PBKDF2_HASH = "sha256"

def _hash_password(password, salt=None, iters=_PBKDF2_ITERS):
    """Return (salt_hex, hash_hex) for the given password. Salt is
    random bytes (16) by default; supply one to re-derive for
    verification.
    """
    if salt is None:
        salt = secrets.token_bytes(_PBKDF2_SALT_BYTES)
    h = hashlib.pbkdf2_hmac(_PBKDF2_HASH, password.encode("utf-8"),
                             salt, iters)
    return salt.hex(), h.hex()

def _verify_password(password, salt_hex, expected_hash_hex,
                     iters=_PBKDF2_ITERS):
    salt = bytes.fromhex(salt_hex)
    h = hashlib.pbkdf2_hmac(_PBKDF2_HASH, password.encode("utf-8"),
                             salt, iters)
    return hmac.compare_digest(h.hex(), expected_hash_hex)

def create_user(username, password, role="user"):
    """Create a new user. Raises ValueError if the username is taken."""
    username = (username or "").strip()
    if not username or not password:
        raise ValueError("username and password are required")
    if role not in ("user", "admin"):
        raise ValueError(f"role must be 'user' or 'admin' (got {role!r})")
    salt_hex, hash_hex = _hash_password(password)
    with _LOCK, get_db() as conn:
        c = conn.cursor()
        try:
            c.execute(
                "INSERT INTO users (username, password_hash, password_salt, role) "
                "VALUES (?, ?, ?, ?)",
                (username, hash_hex, salt_hex, role),
            )
        except sqlite3.IntegrityError:
            raise ValueError(f"username {username!r} already exists")
        return c.lastrowid

def get_user_by_username(username):
    with _LOCK, get_db() as conn:
        c = conn.cursor()
        c.execute("SELECT * FROM users WHERE username = ?", (username,))
        return c.fetchone()

def get_user_by_id(user_id):
    with _LOCK, get_db() as conn:
        c = conn.cursor()
        c.execute("SELECT * FROM users WHERE id = ?", (user_id,))
        return c.fetchone()

def authenticate(username, password):
    """Return user row on success, None on bad credentials."""
    user = get_user_by_username(username)
    if not user:
        return None
    if not _verify_password(password, user["password_salt"],
                            user["password_hash"]):
        return None
    return user

def set_user_password(user_id, new_password):
    salt_hex, hash_hex = _hash_password(new_password)
    with _LOCK, get_db() as conn:
        c = conn.cursor()
        c.execute(
            "UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?",
            (hash_hex, salt_hex, user_id),
        )
        return c.rowcount > 0

def set_user_role(user_id, role):
    if role not in ("user", "admin"):
        raise ValueError(f"role must be 'user' or 'admin' (got {role!r})")
    with _LOCK, get_db() as conn:
        c = conn.cursor()
        c.execute("UPDATE users SET role = ? WHERE id = ?", (role, user_id))
        return c.rowcount > 0

# Token lifetime. 30 days is generous — the user can re-login from
# any device. Shorter TTLs would force a monthly login cycle.
SESSION_TTL_HOURS = 24 * 30

def create_session(user_id):
    """Mint a new session token for the user. Returns the token."""
    token = secrets.token_hex(32)
    expires = (datetime.now(timezone.utc) + timedelta(hours=SESSION_TTL_HOURS)).isoformat()
    with _LOCK, get_db() as conn:
        c = conn.cursor()
        c.execute(
            "INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)",
            (token, user_id, expires),
        )
    return token

def get_user_by_token(token):
    """Look up the user for a valid (non-expired) session token. Returns
    None if the token is missing/expired/revoked.
    """
    if not token:
        return None
    with _LOCK, get_db() as conn:
        c = conn.cursor()
        c.execute("""
            SELECT u.* FROM sessions s
            JOIN users u ON u.id = s.user_id
            WHERE s.token = ? AND s.expires_at > ?
        """, (token, datetime.now(timezone.utc).isoformat()))
        return c.fetchone()

def delete_session(token):
    if not token:
        return False
    with _LOCK, get_db() as conn:
        c = conn.cursor()
        c.execute("DELETE FROM sessions WHERE token = ?", (token,))
        return c.rowcount > 0

def cleanup_expired_sessions():
    """Periodic GC. Not called automatically — run from a cron or
    admin tool. Cheap so calling it on every login is fine too.
    """
    with _LOCK, get_db() as conn:
        c = conn.cursor()
        c.execute("DELETE FROM sessions WHERE expires_at <= ?",
                  (datetime.now(timezone.utc).isoformat(),))
        return c.rowcount


# ===== Server-side etude storage =====
# Per-user. Each row is a complete etude (including the precomputed
# MusicXML) so the Practice page can render without re-stitching.
# The original local IndexedDB (etudes-store.js) still works for
# anonymous users — the server-side store is opt-in (admin only).

def save_etude(record):
    """Create or update a server-side etude. record must include
    {id, user_id, name, musicxml}; exerciseIds/semitones are optional
    arrays, stored as JSON.
    Returns the id.
    """
    if not record.get("id"):
        raise ValueError("record.id is required")
    if not record.get("user_id"):
        raise ValueError("record.user_id is required")
    if not record.get("musicxml"):
        raise ValueError("record.musicxml is required")
    if not record.get("name"):
        raise ValueError("record.name is required")
    ex_ids = record.get("exerciseIds") or []
    semis = record.get("semitones") or []
    # Default semitones to 0 per exercise if mismatched.
    if len(semis) != len(ex_ids):
        semis = [0] * len(ex_ids)
    note_count = record.get("noteCount") or 0
    source = record.get("source") or "composer"
    now = datetime.now(timezone.utc).isoformat()
    with _LOCK, get_db() as conn:
        c = conn.cursor()
        c.execute("""
            INSERT INTO etudes (id, user_id, name, exercise_ids_json, semitones_json,
                                musicxml, source, note_count, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                exercise_ids_json = excluded.exercise_ids_json,
                semitones_json = excluded.semitones_json,
                musicxml = excluded.musicxml,
                source = excluded.source,
                note_count = excluded.note_count,
                updated_at = excluded.updated_at
        """, (
            record["id"], record["user_id"], record["name"],
            json.dumps(ex_ids), json.dumps(semis),
            record["musicxml"], source, note_count,
            now, now,
        ))
    return record["id"]

def list_etudes_for_user(user_id):
    """All etudes owned by this user, newest first. Returns rows
    (sqlite3.Row) — the caller can convert with dict(r)."""
    with _LOCK, get_db() as conn:
        c = conn.cursor()
        c.execute("""
            SELECT * FROM etudes
            WHERE user_id = ?
            ORDER BY created_at DESC
        """, (user_id,))
        return c.fetchall()

def get_etude_for_user(etude_id, user_id):
    """Look up a specific etude, but only if it belongs to the user."""
    with _LOCK, get_db() as conn:
        c = conn.cursor()
        c.execute("""
            SELECT * FROM etudes
            WHERE id = ? AND user_id = ?
        """, (etude_id, user_id))
        return c.fetchone()

def delete_etude_for_user(etude_id, user_id):
    """Delete an etude, but only if it belongs to the user."""
    with _LOCK, get_db() as conn:
        c = conn.cursor()
        c.execute("DELETE FROM etudes WHERE id = ? AND user_id = ?",
                  (etude_id, user_id))
        return c.rowcount > 0

def rename_etude_for_user(etude_id, user_id, new_name):
    new_name = (new_name or "").strip()
    if not new_name:
        return False
    with _LOCK, get_db() as conn:
        c = conn.cursor()
        c.execute("""
            UPDATE etudes
            SET name = ?, updated_at = ?
            WHERE id = ? AND user_id = ?
        """, (new_name, datetime.now(timezone.utc).isoformat(),
              etude_id, user_id))
        return c.rowcount > 0

def row_to_etude_dict(row):
    """Convert an etudes-table row to the dict shape that
    etudes-store.js / practice.js expect. JSON arrays are parsed
    back to Python lists.
    """
    return {
        "id": row["id"],
        "name": row["name"],
        "exerciseIds": json.loads(row["exercise_ids_json"] or "[]"),
        "semitones": json.loads(row["semitones_json"] or "[]"),
        "musicxml": row["musicxml"],
        "source": row["source"],
        "noteCount": row["note_count"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


# Initialize on import
init_db()
