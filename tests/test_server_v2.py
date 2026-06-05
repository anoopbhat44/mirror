import http.client
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(__file__)
SERVER_DIR = os.path.join(HERE, "..", "server")


def _free_port():
    sys.path.insert(0, SERVER_DIR)
    import state
    return state.find_free_port(8300)


def write_session(projects, project, sid, lines):
    pdir = os.path.join(projects, project)
    os.makedirs(pdir, exist_ok=True)
    with open(os.path.join(pdir, sid + ".jsonl"), "w") as fh:
        fh.write("\n".join(lines) + "\n")
    return os.path.join(pdir, sid + ".jsonl")


def u(text):
    return '{"type":"user","message":{"role":"user","content":' + json.dumps(text) + '},"timestamp":"2026-06-05T10:00:00Z"}'


def a(mid, text):
    return '{"type":"assistant","message":{"id":"' + mid + '","role":"assistant","content":[{"type":"text","text":' + json.dumps(text) + '}]}}'


class TestServerV2(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="mirror-v2-")
        cls.projects = os.path.join(cls.tmp, "projects")
        os.makedirs(cls.projects)
        cls.alpha = write_session(cls.projects, "-Users-kumar-alpha", "sess-alpha", [
            u("Deploy a microVM with smolvm please"),
            a("m1", "Run smolvm machine run with alpine."),
        ])
        write_session(cls.projects, "-Users-kumar-beta", "sess-beta", [
            u("Explain SQLite FTS5"),
            a("m2", "FTS5 is full text search for SQLite."),
        ])
        # The active session is, by definition, the one most recently written to.
        # alpha is created first, so bump its mtime to be newest; the live view
        # follows the newest transcript, and the pointer below agrees.
        os.utime(cls.alpha, (time.time() + 10, time.time() + 10))
        # active pointer -> alpha
        with open(os.path.join(cls.tmp, "active.json"), "w") as fh:
            json.dump({"transcript_path": cls.alpha, "session_id": "sess-alpha", "port": 0}, fh)

        cls.port = _free_port()
        env = dict(os.environ, MIRROR_STATE_DIR=cls.tmp, MIRROR_PROJECTS_DIR=cls.projects)
        cls.proc = subprocess.Popen(
            [sys.executable, os.path.join(SERVER_DIR, "mirror_server.py"), "--port", str(cls.port)],
            env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        for _ in range(40):
            if cls._get("/healthz"):
                break
            time.sleep(0.1)

    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate()
        cls.proc.wait(timeout=5)

    @classmethod
    def _get(cls, path):
        try:
            conn = http.client.HTTPConnection("127.0.0.1", cls.port, timeout=2)
            conn.request("GET", path)
            resp = conn.getresponse()
            body = resp.read()
            conn.close()
            return resp.status, body
        except Exception:
            return None

    def get_json(self, path):
        result = self._get(path)
        self.assertIsNotNone(result, "no response on %s" % path)
        status, body = result
        self.assertEqual(status, 200, "non-200 on %s" % path)
        return json.loads(body)

    def test_config(self):
        data = self.get_json("/api/config")
        self.assertIn(data["theme"], ("dark", "light"))

    def test_sessions_list(self):
        data = self.get_json("/api/sessions")
        ids = {s["id"] for s in data["sessions"]}
        self.assertEqual(ids, {"sess-alpha", "sess-beta"})
        self.assertEqual(data["active"], "sess-alpha")

    def test_conversation_default_is_active(self):
        data = self.get_json("/api/conversation")
        self.assertTrue(any("smolvm" in (it.get("text") or "") for it in data["items"]))

    def test_conversation_by_session(self):
        data = self.get_json("/api/conversation?session=sess-beta")
        joined = json.dumps(data["items"])
        self.assertIn("FTS5", joined)

    def test_search_cross_session(self):
        data = self.get_json("/api/search?q=FTS5")
        self.assertTrue(data["results"])
        self.assertTrue(all("FTS5" in r["snippet"].replace("<b>", "").replace("</b>", "")
                            or r["session_id"] == "sess-beta" for r in data["results"]))
        self.assertTrue(any(r["session_id"] == "sess-beta" for r in data["results"]))

    def test_search_empty_query(self):
        data = self.get_json("/api/search?q=")
        self.assertEqual(data["results"], [])


if __name__ == "__main__":
    unittest.main()
