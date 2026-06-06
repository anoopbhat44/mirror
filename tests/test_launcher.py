import os
import sys
import time
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "server"))

import launcher  # noqa: E402
import state  # noqa: E402
import config  # noqa: E402

CONFIGURED = 7842


class TestEnsureRunningSingleServer(unittest.TestCase):
    """A second (or Nth) Claude Code session must reuse the one server on the
    configured port, never spawn a duplicate on the next port. The reuse decision
    is anchored on the configured port, not just the active.json pointer."""

    def setUp(self):
        self.live = set()          # ports where a mirror answers /healthz
        self.busy = set()          # ports that cannot be bound (not free)
        self.spawns = []           # ports launcher tried to spawn a server on
        self.active = None         # what state.read_active() returns
        self.free_port = 7843      # what state.find_free_port() returns

        self._saved = []

        def patch(obj, name, fn):
            self._saved.append((obj, name, getattr(obj, name)))
            setattr(obj, name, fn)

        patch(config, "load", lambda: {"port": CONFIGURED})
        patch(state, "read_active", lambda: self.active)
        patch(state, "write_active", lambda *a, **k: None)
        patch(state, "is_mirror_running", lambda p, timeout=0.5: p in self.live)
        patch(state, "_port_is_free", lambda p: p not in self.busy)
        patch(state, "find_free_port", lambda start=CONFIGURED, attempts=50: self.free_port)
        patch(launcher, "_spawn_server", self._spawn)
        patch(time, "sleep", lambda s: None)

    def tearDown(self):
        for obj, name, val in reversed(self._saved):
            setattr(obj, name, val)

    def _spawn(self, port):
        # Simulate the spawned server binding the port and answering /healthz.
        self.spawns.append(port)
        self.live.add(port)
        self.busy.add(port)

    # --- reuse cases: NO new server may be spawned ---

    def test_reuses_mirror_on_configured_when_pointer_missing(self):
        # active.json is gone, but a healthy mirror is on 7842. Must reuse it.
        self.active = None
        self.live = {CONFIGURED}
        self.busy = {CONFIGURED}
        port = launcher.ensure_running("t.jsonl", "s1")
        self.assertEqual(port, CONFIGURED)
        self.assertEqual(self.spawns, [])

    def test_reuses_mirror_on_active_port(self):
        # Server happens to live on a non-default port recorded in the pointer.
        self.active = {"port": 7850, "transcript_path": "x", "session_id": "y"}
        self.live = {7850}
        self.busy = {7850}
        port = launcher.ensure_running("t.jsonl", "s2")
        self.assertEqual(port, 7850)
        self.assertEqual(self.spawns, [])

    def test_stale_pointer_to_dead_port_reuses_configured(self):
        # Pointer names a dead port; a live mirror is on 7842. The old code would
        # spawn a duplicate on 7843. The fix must reuse 7842.
        self.active = {"port": 7843, "transcript_path": "x", "session_id": "y"}
        self.live = {CONFIGURED}
        self.busy = {CONFIGURED}
        port = launcher.ensure_running("t.jsonl", "s3")
        self.assertEqual(port, CONFIGURED)
        self.assertEqual(self.spawns, [])

    # --- spawn cases: exactly one server, on the right port ---

    def test_no_mirror_and_configured_free_spawns_on_configured(self):
        self.active = None
        self.live = set()
        self.busy = set()
        port = launcher.ensure_running("t.jsonl", "s4")
        self.assertEqual(port, CONFIGURED)
        self.assertEqual(self.spawns, [CONFIGURED])

    def test_configured_busy_by_non_mirror_falls_back_to_free_port(self):
        # 7842 is taken by something that is NOT our mirror -> use a free port.
        self.active = None
        self.live = set()
        self.busy = {CONFIGURED}
        self.free_port = 7843
        port = launcher.ensure_running("t.jsonl", "s5")
        self.assertEqual(port, 7843)
        self.assertEqual(self.spawns, [7843])


if __name__ == "__main__":
    unittest.main()
