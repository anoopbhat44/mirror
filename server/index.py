"""Derived, rebuildable search/index over the transcript JSONL files.

This is a CACHE, never the source of truth (ROADMAP principle 7). The transcripts
under ~/.claude/projects are authoritative; this SQLite database can be deleted and
rebuilt from them at any time. `sqlite3` ships with Python, so this adds no
dependency. Full-text search uses FTS5 when available and falls back to LIKE.

Ingest is incremental: per session we remember the byte offset we last read and
only parse new lines on the next pass, so long transcripts are not re-parsed every
turn.
"""

import glob
import json
import os
import sqlite3

SCHEMA_VERSION = 1


def _fts5_available(conn):
    try:
        conn.execute("CREATE VIRTUAL TABLE _fts_probe USING fts5(x)")
        conn.execute("DROP TABLE _fts_probe")
        return True
    except sqlite3.Error:
        return False


def _deslug_project(name):
    # ~/.claude/projects dirs are the cwd with '/' replaced by '-'.
    # Show the trailing path component, which is the project folder name.
    cleaned = name.lstrip("-")
    parts = cleaned.split("-")
    return parts[-1] if parts and parts[-1] else cleaned


def _line_text(obj):
    """Pull human-readable text out of one transcript line, or '' to skip."""
    if not isinstance(obj, dict):
        return None, None
    if obj.get("isSidechain") or obj.get("isMeta"):
        return None, None
    ltype = obj.get("type")
    if ltype not in ("user", "assistant"):
        return None, None
    message = obj.get("message")
    if not isinstance(message, dict):
        return None, None
    content = message.get("content")
    if isinstance(content, str):
        stripped = content.lstrip()
        if stripped.startswith("<command-") or stripped.startswith("<local-command"):
            return None, None
        return ltype, content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                t = block.get("text")
                if t and t.strip():
                    parts.append(t)
        if parts:
            return ltype, "\n".join(parts)
    return None, None


def _first_title(path):
    """Cheap title: first real user text line in the file (truncated)."""
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            for _ in range(40):
                line = fh.readline()
                if not line:
                    break
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except ValueError:
                    continue
                role, text = _line_text(obj)
                if role == "user" and text:
                    title = " ".join(text.split())
                    return title[:80]
    except OSError:
        return ""
    return ""


class Index:
    def __init__(self, db_path, projects_dir):
        self.db_path = db_path
        self.projects_dir = projects_dir
        self.conn = sqlite3.connect(db_path)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA busy_timeout = 3000")
        self.fts = _fts5_available(self.conn)
        self._ensure_schema()

    def _ensure_schema(self):
        cur = self.conn.execute("PRAGMA user_version")
        version = cur.fetchone()[0]
        if version != SCHEMA_VERSION:
            self._drop_all()
            self.conn.execute("PRAGMA user_version = %d" % SCHEMA_VERSION)
        self.conn.execute(
            """CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY, path TEXT, project TEXT, title TEXT,
                mtime REAL, size INTEGER, msg_count INTEGER, byte_offset INTEGER
            )"""
        )
        self.conn.execute(
            """CREATE TABLE IF NOT EXISTS messages (
                session_id TEXT, idx INTEGER, role TEXT, text TEXT, ts TEXT
            )"""
        )
        self.conn.execute(
            "CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id)"
        )
        if self.fts:
            self.conn.execute(
                "CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5("
                "text, session_id UNINDEXED, idx UNINDEXED, role UNINDEXED)"
            )
        self.conn.commit()

    def _drop_all(self):
        for tbl in ("messages_fts", "messages", "sessions"):
            try:
                self.conn.execute("DROP TABLE IF EXISTS %s" % tbl)
            except sqlite3.Error:
                pass
        self.conn.commit()

    def ingest(self):
        for path in sorted(glob.glob(os.path.join(self.projects_dir, "*", "*.jsonl"))):
            self._ingest_file(path)
        self.conn.commit()

    def _ingest_file(self, path):
        session_id = os.path.splitext(os.path.basename(path))[0]
        project = _deslug_project(os.path.basename(os.path.dirname(path)))
        try:
            st = os.stat(path)
        except OSError:
            return

        row = self.conn.execute(
            "SELECT byte_offset, size, msg_count, title FROM sessions WHERE id = ?", (session_id,)
        ).fetchone()
        offset = 0
        msg_count = 0
        if row is not None:
            offset, prev_size, msg_count = row["byte_offset"], row["size"], row["msg_count"]
            if st.st_size < offset:  # file was truncated/replaced; re-ingest fully
                offset = 0
                msg_count = 0
                self.conn.execute("DELETE FROM messages WHERE session_id = ?", (session_id,))
                if self.fts:
                    self.conn.execute("DELETE FROM messages_fts WHERE session_id = ?", (session_id,))
        if offset == st.st_size and row is not None:
            return  # nothing new

        new_rows = []
        last_ts = None
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            fh.seek(offset)
            for line in fh:
                stripped = line.strip()
                if not stripped:
                    continue
                try:
                    obj = json.loads(stripped)
                except ValueError:
                    continue
                role, text = _line_text(obj)
                if role and text:
                    last_ts = obj.get("timestamp") or last_ts
                    new_rows.append((session_id, msg_count, role, text, last_ts))
                    msg_count += 1

        for r in new_rows:
            self.conn.execute(
                "INSERT INTO messages(session_id, idx, role, text, ts) VALUES (?,?,?,?,?)", r
            )
            if self.fts:
                self.conn.execute(
                    "INSERT INTO messages_fts(text, session_id, idx, role) VALUES (?,?,?,?)",
                    (r[3], r[0], r[1], r[2]),
                )

        title = row["title"] if (row is not None and row["title"]) else _first_title(path)
        self.conn.execute(
            """INSERT INTO sessions(id, path, project, title, mtime, size, msg_count, byte_offset)
               VALUES (?,?,?,?,?,?,?,?)
               ON CONFLICT(id) DO UPDATE SET
                 path=excluded.path, project=excluded.project, title=excluded.title,
                 mtime=excluded.mtime, size=excluded.size, msg_count=excluded.msg_count,
                 byte_offset=excluded.byte_offset""",
            (session_id, path, project, title, st.st_mtime, st.st_size, msg_count, st.st_size),
        )

    def get_session(self, session_id):
        row = self.conn.execute(
            "SELECT id, path, project, title, mtime, msg_count FROM sessions WHERE id = ?",
            (session_id,),
        ).fetchone()
        return dict(row) if row else None

    def list_sessions(self):
        rows = self.conn.execute(
            "SELECT id, path, project, title, mtime, msg_count FROM sessions ORDER BY mtime DESC"
        ).fetchall()
        return [dict(r) for r in rows]

    def search(self, query, limit=60):
        query = (query or "").strip()
        if not query:
            return []
        if self.fts:
            return self._search_fts(query, limit)
        return self._search_like(query, limit)

    def _search_fts(self, query, limit):
        # Match each whitespace token as a prefix; quote to neutralize FTS syntax.
        tokens = ['"%s"*' % t.replace('"', '') for t in query.split() if t]
        if not tokens:
            return []
        match = " ".join(tokens)
        try:
            rows = self.conn.execute(
                """SELECT f.session_id AS session_id, f.idx AS idx, f.role AS role,
                          snippet(messages_fts, 0, '<b>', '</b>', '…', 12) AS snippet,
                          s.project AS project, s.title AS title, s.mtime AS mtime
                   FROM messages_fts f JOIN sessions s ON s.id = f.session_id
                   WHERE messages_fts MATCH ?
                   ORDER BY s.mtime DESC LIMIT ?""",
                (match, limit),
            ).fetchall()
        except sqlite3.Error:
            return self._search_like(query, limit)
        return [dict(r) for r in rows]

    def _search_like(self, query, limit):
        like = "%" + query.replace("%", "").replace("_", "") + "%"
        rows = self.conn.execute(
            """SELECT m.session_id AS session_id, m.idx AS idx, m.role AS role,
                      m.text AS text, s.project AS project, s.title AS title, s.mtime AS mtime
               FROM messages m JOIN sessions s ON s.id = m.session_id
               WHERE m.text LIKE ? ORDER BY s.mtime DESC LIMIT ?""",
            (like, limit),
        ).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            text = d.pop("text", "")
            low = text.lower()
            pos = low.find(query.lower())
            start = max(0, pos - 40)
            snippet = ("…" if start > 0 else "") + text[start:pos + len(query) + 60]
            d["snippet"] = " ".join(snippet.split())
            out.append(d)
        return out

    def close(self):
        self.conn.close()
