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
FIXTURE = os.path.join(HERE, "fixtures", "sample.jsonl")


def _free_port():
    sys.path.insert(0, SERVER_DIR)
    import state

    return state.find_free_port(8200)


class TestServer(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="mirror-test-")
        # Isolate the projects dir (empty) so active-session resolution falls back
        # to the active.json pointer below, not the real ~/.claude/projects.
        cls.projects = tempfile.mkdtemp(prefix="mirror-test-proj-")
        cls.port = _free_port()
        env = dict(os.environ, MIRROR_STATE_DIR=cls.tmp, MIRROR_PROJECTS_DIR=cls.projects)

        # Point the active pointer at the fixture transcript.
        active = {
            "transcript_path": os.path.abspath(FIXTURE),
            "session_id": "test",
            "port": cls.port,
        }
        with open(os.path.join(cls.tmp, "active.json"), "w") as fh:
            json.dump(active, fh)

        cls.proc = subprocess.Popen(
            [sys.executable, os.path.join(SERVER_DIR, "mirror_server.py"), "--port", str(cls.port)],
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        for _ in range(40):
            if cls._ping("/healthz"):
                break
            time.sleep(0.1)

    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate()
        cls.proc.wait(timeout=5)

    @classmethod
    def _ping(cls, path):
        try:
            conn = http.client.HTTPConnection("127.0.0.1", cls.port, timeout=1)
            conn.request("GET", path)
            resp = conn.getresponse()
            body = resp.read()
            conn.close()
            return resp.status, body
        except Exception:
            return None

    def _get(self, path):
        result = self._ping(path)
        self.assertIsNotNone(result, "server did not respond on %s" % path)
        return result

    def test_healthz(self):
        status, body = self._get("/healthz")
        self.assertEqual(status, 200)
        self.assertEqual(body.decode().strip(), "mirror-ok")

    def test_index_served(self):
        status, body = self._get("/")
        self.assertEqual(status, 200)
        self.assertIn(b"Mirror", body)

    def test_static_app_js(self):
        status, body = self._get("/app.js")
        self.assertEqual(status, 200)
        self.assertIn(b"EventSource", body)

    def test_conversation_api(self):
        status, body = self._get("/api/conversation")
        self.assertEqual(status, 200)
        data = json.loads(body)
        self.assertEqual(len(data["items"]), 4)
        self.assertNotEqual(data["version"], "none")

    def test_static_mermaid_served(self):
        status, body = self._get("/vendor/mermaid.min.js")
        self.assertEqual(status, 200)
        self.assertIn(b"mermaid", body[:200] + body[-200:])

    def test_unknown_path_404(self):
        status, _ = self._get("/secret")
        self.assertEqual(status, 404)

    def test_no_path_traversal(self):
        status, _ = self._get("/../server/state.py")
        self.assertEqual(status, 404)


if __name__ == "__main__":
    unittest.main()
