"""Check preview restart and failure policy without a persistent server."""

import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from serve import Preview, fingerprint


class PreviewTests(unittest.TestCase):
    def test_content_fingerprint_ignores_mtime(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "page.html"
            path.write_text("first")
            before = fingerprint([path])
            path.touch()
            self.assertEqual(before, fingerprint([path]))
            path.write_text("other")
            self.assertNotEqual(before, fingerprint([path]))

    @patch("serve.fingerprint", return_value=b"first")
    @patch("serve.subprocess.Popen")
    def test_restarts_only_after_successful_changed_output(self, popen, fingerprint):
        builder = Mock()
        builder.wait.return_value = 0
        server = Mock()
        server.poll.return_value = None
        popen.side_effect = [builder, server, builder, builder, builder, server]
        preview = Preview("imp", "zola")
        self.assertTrue(preview.rebuild())
        self.assertTrue(preview.rebuild())
        server.terminate.assert_not_called()
        builder.wait.return_value = 1
        self.assertFalse(preview.rebuild())
        server.terminate.assert_not_called()
        builder.wait.return_value = 0
        fingerprint.return_value = b"changed"
        self.assertTrue(preview.rebuild())
        server.terminate.assert_called_once()
        preview.stop()
        self.assertTrue(preview.stopped)

    def test_stop_reaps_builder_and_server(self):
        preview = Preview("imp", "zola")
        preview.builder = Mock()
        preview.server = Mock()
        for child in (preview.builder, preview.server):
            child.poll.return_value = None
        preview.stop()
        for child in (preview.builder, preview.server):
            child.terminate.assert_called_once()
            child.wait.assert_called_once_with(timeout=5)
