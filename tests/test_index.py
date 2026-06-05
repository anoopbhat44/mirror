import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "server"))

import index  # noqa: E402


def write_session(projects_dir, project, session_id, lines):
    pdir = os.path.join(projects_dir, project)
    os.makedirs(pdir, exist_ok=True)
    path = os.path.join(pdir, session_id + ".jsonl")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")
    return path


def u(text):
    return ('{"type":"user","message":{"role":"user","content":' + _json(text) + '},"timestamp":"2026-06-05T10:00:00Z"}')


def a(mid, text):
    return ('{"type":"assistant","message":{"id":"' + mid + '","role":"assistant","content":[{"type":"text","text":' + _json(text) + '}]}}')


def _json(s):
    import json
    return json.dumps(s)


class TestIndex(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="mirror-idx-")
        self.projects = os.path.join(self.root, "projects")
        os.makedirs(self.projects)
        self.db = os.path.join(self.root, "index.db")
        write_session(self.projects, "-Users-kumar-alpha", "sess-alpha", [
            u("How do I deploy a microVM with smolvm"),
            a("m1", "Use smolvm machine run with the alpine image."),
        ])
        write_session(self.projects, "-Users-kumar-beta", "sess-beta", [
            u("Explain SQLite FTS5 indexing"),
            a("m2", "FTS5 is a full text search extension for SQLite."),
        ])
        self.idx = index.Index(self.db, self.projects)

    def test_ingest_lists_sessions(self):
        self.idx.ingest()
        sessions = self.idx.list_sessions()
        ids = {s["id"] for s in sessions}
        self.assertEqual(ids, {"sess-alpha", "sess-beta"})

    def test_session_has_title_and_project(self):
        self.idx.ingest()
        by_id = {s["id"]: s for s in self.idx.list_sessions()}
        self.assertIn("deploy a microVM", by_id["sess-alpha"]["title"])
        self.assertIn("alpha", by_id["sess-alpha"]["project"])

    def test_sessions_sorted_recent_first(self):
        self.idx.ingest()
        sessions = self.idx.list_sessions()
        mtimes = [s["mtime"] for s in sessions]
        self.assertEqual(mtimes, sorted(mtimes, reverse=True))

    def test_search_finds_term_across_sessions(self):
        self.idx.ingest()
        results = self.idx.search("FTS5")
        self.assertTrue(any(r["session_id"] == "sess-beta" for r in results))
        self.assertFalse(any(r["session_id"] == "sess-alpha" for r in results))

    def test_search_returns_snippet(self):
        self.idx.ingest()
        results = self.idx.search("microVM")
        self.assertTrue(results)
        self.assertIn("microVM", results[0]["snippet"].replace("</b>", "").replace("<b>", ""))

    def test_incremental_ingest_picks_up_new_lines(self):
        self.idx.ingest()
        path = os.path.join(self.projects, "-Users-kumar-alpha", "sess-alpha.jsonl")
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(a("m3", "Also try the kubernetes operator pattern.") + "\n")
        self.idx.ingest()
        results = self.idx.search("kubernetes")
        self.assertTrue(any(r["session_id"] == "sess-alpha" for r in results))

    def test_idempotent_ingest_no_duplicates(self):
        self.idx.ingest()
        self.idx.ingest()
        self.idx.ingest()
        results = self.idx.search("microVM")
        # one matching message, not three
        alpha = [r for r in results if r["session_id"] == "sess-alpha"]
        self.assertEqual(len(alpha), 1)

    def test_rebuild_from_scratch(self):
        self.idx.ingest()
        self.idx.close()
        # delete db, rebuild -> still works
        os.remove(self.db)
        idx2 = index.Index(self.db, self.projects)
        idx2.ingest()
        self.assertEqual(len(idx2.list_sessions()), 2)
        idx2.close()


if __name__ == "__main__":
    unittest.main()
