"""Mirror local server: serves the client and the parsed conversation, live.

Stdlib only. Binds to 127.0.0.1 exclusively (the transcript can contain secrets,
file contents, and tool output, so it never leaves the machine).

Routes:
  GET /                 -> client/index.html
  GET /app.js /style.css /vendor/* -> static client assets (no path traversal)
  GET /healthz          -> "mirror-ok" (used by the hook to detect our server)
  GET /api/config       -> {"theme": ...}
  GET /api/sessions     -> {"sessions": [...], "active": "<id>"}
  GET /api/conversation[?session=<id>] -> {"items": [...], "version": "..."}
  GET /api/search?q=... -> {"results": [...], "fts": bool}
  GET /events           -> Server-Sent Events; emits on active-transcript change
"""

import argparse
import glob
import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import state  # noqa: E402
import config  # noqa: E402
import index  # noqa: E402
from parser import parse_transcript  # noqa: E402

CLIENT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "client")
PROJECTS_DIR = os.environ.get("MIRROR_PROJECTS_DIR") or os.path.expanduser("~/.claude/projects")
INDEX_PATH = os.path.join(state.STATE_DIR, "index.db")
LIVE_WINDOW = 120  # a session whose transcript changed within this many seconds is "live"

STATIC_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
}

# Only these client files may be served. Keeps path traversal impossible.
ALLOWED_STATIC = {
    "/": "index.html",
    "/index.html": "index.html",
    "/app.js": "app.js",
    "/style.css": "style.css",
    "/vendor/marked.min.js": "vendor/marked.min.js",
    "/vendor/highlight.min.js": "vendor/highlight.min.js",
    "/vendor/mermaid.min.js": "vendor/mermaid.min.js",
    "/vendor/highlight-github-dark.min.css": "vendor/highlight-github-dark.min.css",
}


def _transcript_version(path):
    try:
        st = os.stat(path)
        return "%d-%d" % (int(st.st_mtime * 1000), st.st_size)
    except OSError:
        return "none"


def _newest_transcript():
    """The most recently modified transcript under PROJECTS_DIR, or None."""
    newest = None
    newest_mtime = -1.0
    for path in glob.glob(os.path.join(PROJECTS_DIR, "*", "*.jsonl")):
        try:
            mtime = os.stat(path).st_mtime
        except OSError:
            continue
        if mtime > newest_mtime:
            newest_mtime = mtime
            newest = path
    return newest


def _resolve_active():
    """Return ``(transcript_path, session_id)`` for the live/default view.

    Prefer the most recently modified transcript so the view follows the session
    you are actually in, even when ``active.json`` is stale (a hook missed, or a
    session was resumed without SessionStart). The session id is the transcript
    filename stem, matching how the index keys sessions. Fall back to the
    ``active.json`` pointer only when no transcripts are discoverable.
    """
    newest = _newest_transcript()
    if newest:
        return newest, os.path.splitext(os.path.basename(newest))[0]
    active = state.read_active()
    if active:
        return active.get("transcript_path"), active.get("session_id")
    return None, None


def _active_transcript():
    return _resolve_active()[0]


def _active_session_id():
    return _resolve_active()[1]


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass  # keep the server log quiet; errors still surface via exceptions

    def _send(self, code, body, content_type, extra_headers=None):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        if extra_headers:
            for key, value in extra_headers.items():
                self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)
        if path == "/healthz":
            return self._send(200, state.HEALTH_TOKEN, "text/plain; charset=utf-8")
        if path == "/api/config":
            return self._serve_config()
        if path == "/api/sessions":
            return self._serve_sessions()
        if path == "/api/conversation":
            return self._serve_conversation(query.get("session", [None])[0])
        if path == "/api/search":
            return self._serve_search(query.get("q", [""])[0])
        if path == "/events":
            return self._serve_events()
        if path in ALLOWED_STATIC:
            return self._serve_static(ALLOWED_STATIC[path])
        return self._send(404, "not found", "text/plain; charset=utf-8")

    def _json(self, payload):
        self._send(
            200,
            json.dumps(payload),
            "application/json; charset=utf-8",
            {"Cache-Control": "no-store"},
        )

    def _serve_static(self, rel):
        full = os.path.join(CLIENT_DIR, rel)
        if not os.path.isfile(full):
            return self._send(404, "missing: %s" % rel, "text/plain; charset=utf-8")
        ext = os.path.splitext(full)[1]
        ctype = STATIC_TYPES.get(ext, "application/octet-stream")
        with open(full, "rb") as fh:
            body = fh.read()
        self._send(200, body, ctype)

    def _open_index(self):
        state.ensure_state_dir()
        idx = index.Index(INDEX_PATH, PROJECTS_DIR)
        idx.ingest()
        return idx

    def _serve_config(self):
        cfg = config.load()
        self._json({"theme": cfg.get("theme", "dark")})

    def _resolve_transcript(self, session_id):
        """Return the transcript path for a session id, or the active one if None."""
        if not session_id:
            return _active_transcript()
        idx = self._open_index()
        try:
            row = idx.get_session(session_id)
        finally:
            idx.close()
        return row["path"] if row else None

    def _serve_conversation(self, session_id):
        transcript = self._resolve_transcript(session_id)
        if not transcript or not os.path.isfile(transcript):
            return self._json({"items": [], "version": "none", "waiting": True,
                               "session": session_id})
        payload = parse_transcript(transcript)
        payload["version"] = _transcript_version(transcript)
        payload["session"] = session_id or _active_session_id()
        self._json(payload)

    def _serve_sessions(self):
        idx = self._open_index()
        try:
            sessions = idx.list_sessions()
        finally:
            idx.close()
        now = time.time()
        active = _active_session_id()
        for s in sessions:
            s["live"] = (now - (s.get("mtime") or 0)) < LIVE_WINDOW
        self._json({"sessions": sessions, "active": active})

    def _serve_search(self, query):
        idx = self._open_index()
        try:
            results = idx.search(query)
            fts = idx.fts
        finally:
            idx.close()
        self._json({"results": results, "fts": fts, "query": query})

    def _serve_events(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        last_version = None
        last_beat = time.time()
        try:
            while True:
                transcript = _active_transcript()
                version = _transcript_version(transcript) if transcript else "none"
                now = time.time()
                if version != last_version:
                    last_version = version
                    self.wfile.write(("data: %s\n\n" % version).encode("utf-8"))
                    self.wfile.flush()
                    last_beat = now
                elif now - last_beat > 15:
                    self.wfile.write(b": keep-alive\n\n")
                    self.wfile.flush()
                    last_beat = now
                time.sleep(0.5)
        except (BrokenPipeError, ConnectionResetError, OSError):
            return


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=state.DEFAULT_PORT)
    args = ap.parse_args()

    state.ensure_state_dir()
    with open(state.PID_PATH, "w", encoding="utf-8") as fh:
        fh.write(str(os.getpid()))

    httpd = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    httpd.daemon_threads = True
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
