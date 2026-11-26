"""Offline protocol fixtures for officer attachment preparation."""
import base64
import hashlib
import importlib.util
import json
import io
import os
import tempfile
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("officer_files", Path(__file__).resolve().parents[1] / "scripts/officer_files.py")
files = importlib.util.module_from_spec(spec)
spec.loader.exec_module(files)


class OfficerFiles(unittest.TestCase):
    def test_issue_download_and_publish(self):
        raw = b"requested content"
        media, upload = str(uuid.uuid4()), uuid.uuid4()
        ref = "UPL-" + base64.urlsafe_b64encode(upload.bytes).decode().rstrip("=")
        item = {"fileName": "notes.md", "mediaId": media, "kind": "file", "sizeBytes": len(raw),
                "contentType": "text/markdown", "sha256": hashlib.sha256(raw).hexdigest()}
        body = {**item, "base64": base64.b64encode(raw).decode()}
        def tool(name, args):
            if name == "list_attachments":
                return {"items": [item] if args["issue"] == "DEMO-1" else []}
            if name in ("get_attachment", "get_issue_image"):
                self.assertEqual(name, "get_issue_image" if item["kind"] == "image" else "get_attachment")
                self.assertEqual(args["mediaId"], media)
                return body
            self.assertEqual(name, "create_chat_upload")
            self.assertEqual(args, {"uploadId": str(upload), "fileName": "notes.md",
                                    "contentType": "text/markdown", "base64": body["base64"]})
            return {"reference": ref, "sha256": item["sha256"], "sizeBytes": len(raw)}
        with tempfile.TemporaryDirectory() as folder, patch.object(files.IssueReader, "connect"), patch.object(files.IssueReader, "tool", side_effect=tool):
            config = SimpleNamespace(exports=folder, staging=folder)
            args = {"source": "issue", "issue": "DEMO-1", "mediaId": media}
            prepared = files.prepare(args, config)
            path, = Path(folder).glob("*/notes.md")
            self.assertEqual(path.read_bytes(), raw)
            self.assertEqual(path.stat().st_mode & 0o777, 0o640)
            self.assertEqual(path.parent.stat().st_mode & 0o2777, 0o2750)
            self.assertIn(path.as_uri(), prepared["marker"])
            self.assertEqual(files.prepare({**args, "chatUploadId": str(upload)}, config)["reference"], ref)
            with self.assertRaises(files.Refused):
                files.prepare({**args, "issue": "DEMO-2"}, config)
            item.update(kind="image", fileName="example.png", contentType="image/png")
            body.update(fileName="example.png", contentType="image/png")
            self.assertEqual(files.prepare(args, config)["fileName"], "example.png")
            item["sha256"] = "0" * 64
            with self.assertRaises(files.Refused):
                files.prepare(args, config)

    def test_existing_upload_is_checked_before_creating_a_marker(self):
        raw = b"portable document"
        ref = "UPL-" + "A"*22
        item = {"reference": ref, "sizeBytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest(), "fileName": "notes.md"}
        body = {"upload": item, "base64": base64.b64encode(raw).decode()}
        with tempfile.TemporaryDirectory() as folder, patch.object(files.IssueReader, "connect"), patch.object(files.IssueReader, "tool", return_value=body) as tool:
            config = SimpleNamespace(exports=folder, staging=folder)
            args = {"source": "upload", "reference": ref}
            result = files.prepare(args, config)
            self.assertEqual(result["sizeBytes"], len(raw))
            tool.assert_called_once_with("get_chat_upload", {"reference": ref, "includeBytes": True})
            item["reference"] = "UPL-" + "B"*22
            with self.assertRaises(files.Refused):
                files.prepare(args, config)

    def test_escaped_mcp_media_wire_size_is_separate_from_source_limit(self):
        # Three bytes encode to four '+' characters. The .NET text result
        # Unicode-escapes these before the MCP envelope escapes the JSON again.
        size = 2 * 1024 * 1024
        encoded = base64.b64encode((b"\xfb\xef\xbe" * (size // 3 + 1))[:size]).decode()
        inner = json.dumps({"base64": encoded}).replace("+", r"\u002B")
        wire = json.dumps({"id": 2, "result": {"content": [{"type": "text", "text": inner}]}}).encode()
        self.assertGreater(len(wire), 14 * 1024 * 1024)
        class Response(io.BytesIO):
            status = 200
            def getheader(self, name, default=None):
                return default
        config = SimpleNamespace(socket=None, port=1, actor=None)
        with patch.object(files.http.client, "HTTPConnection") as conn:
            conn.return_value.getresponse.return_value = Response(wire)
            result = files.IssueReader(config).tool("get_issue_image", {"mediaId": str(uuid.uuid4())})
            self.assertEqual(result["base64"], encoded)

    def test_hardlinks_and_special_files(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder) / "input.txt"
            source.write_text("private")
            os.link(source, Path(folder) / "link.txt")
            os.mkfifo(Path(folder) / "pipe.txt")
            for name in ("link.txt", "pipe.txt"):
                with self.assertRaises((OSError, files.Refused)):
                    files.staged(folder, name)


if __name__ == "__main__":
    unittest.main()
