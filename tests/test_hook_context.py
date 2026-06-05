import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "server"))

from hook_session_start import mirror_context  # noqa: E402


class TestMirrorContext(unittest.TestCase):
    def setUp(self):
        self.ctx = mirror_context("http://localhost:7842")

    def test_mentions_the_link(self):
        self.assertIn("http://localhost:7842", self.ctx)

    def test_steers_diagrams_to_mermaid(self):
        low = self.ctx.lower()
        self.assertIn("mermaid", low)
        # It must talk about diagrams, so the nudge is about diagram output.
        self.assertIn("diagram", low)

    def test_no_em_dash(self):
        self.assertNotIn("—", self.ctx)


if __name__ == "__main__":
    unittest.main()
