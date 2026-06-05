import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "server"))

import mirror_server  # noqa: E402


def _touch(path, mtime):
    with open(path, "w", encoding="utf-8") as fh:
        fh.write('{"type":"user","message":{"role":"user","content":"hi"}}\n')
    os.utime(path, (mtime, mtime))


class TestActiveResolution(unittest.TestCase):
    """The live view must follow the newest transcript even when active.json is
    stale (a missed hook, or a session resumed without SessionStart)."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="mirror-active-")
        proj = os.path.join(self.tmp, "demo")
        os.makedirs(proj)
        self.old = os.path.join(proj, "old-session.jsonl")
        self.new = os.path.join(proj, "new-session.jsonl")
        _touch(self.old, 1000)
        _touch(self.new, 2000)  # newer

        self._saved_projects = mirror_server.PROJECTS_DIR
        self._saved_read_active = mirror_server.state.read_active
        mirror_server.PROJECTS_DIR = self.tmp
        # Pointer is stale: it names the OLDER session.
        mirror_server.state.read_active = lambda: {
            "transcript_path": self.old, "session_id": "old-session"}

    def tearDown(self):
        mirror_server.PROJECTS_DIR = self._saved_projects
        mirror_server.state.read_active = self._saved_read_active

    def test_follows_newest_transcript_not_stale_pointer(self):
        self.assertEqual(mirror_server._active_transcript(), self.new)

    def test_session_id_matches_newest_filename(self):
        self.assertEqual(mirror_server._active_session_id(), "new-session")

    def test_falls_back_to_pointer_when_no_transcripts(self):
        empty = tempfile.mkdtemp(prefix="mirror-empty-")
        mirror_server.PROJECTS_DIR = empty
        self.assertEqual(mirror_server._active_transcript(), self.old)
        self.assertEqual(mirror_server._active_session_id(), "old-session")


if __name__ == "__main__":
    unittest.main()
