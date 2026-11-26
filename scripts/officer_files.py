"""Stdio MCP for preparing requested files in an officer's shared export directory."""
import argparse
import base64
import contextlib
import hashlib
import http.client
import json
import signal
import os
import re
import socket
import stat
import sys
import uuid
from pathlib import Path
from urllib.parse import quote

LIMIT = 10 * 1024 * 1024
NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9 _.-]{0,179}")
CHAT_TYPES = {
    'md': 'text/markdown', 'markdown': 'text/markdown', 'txt': 'text/plain', 'text': 'text/plain',
    'png': 'image/png', 'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg', 'gif': 'image/gif', 'webp': 'image/webp', 'pdf': 'application/pdf',
    'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'zip': 'application/zip',
}
TYPES = set(CHAT_TYPES) | {"csv", "pptx"}
SOURCES = {"upload": {"reference"}, "issue": {"issue", "mediaId"}, "staged": {"fileName"}, "text": {"fileName", "text"}}
TOOL = {
    "name": "prepare_file",
    "description": "Prepare an issue attachment, an existing Subspace chat upload reference, a named file in your configured staging directory, or a new text document for a requested reply. Default output is a local file publication marker. To create an IRC attachment card readable by all active Subspace members for 30 days, supply a fresh chatUploadId and reuse it on retry.",
    "inputSchema": {"type": "object", "properties": {
        "source": {"type": "string", "enum": list(SOURCES)}, "chatUploadId": {"type": "string", "format": "uuid"}, "issue": {"type": "string"},
        "reference": {"type": "string"}, "mediaId": {"type": "string"}, "fileName": {"type": "string"},
        "text": {"type": "string", "maxLength": 65536}},
        "required": ["source"], "additionalProperties": False}
}


class Refused(ValueError):
    """Only these messages may be returned to the model."""


def safe_name(value):
    if not isinstance(value, str) or not NAME.fullmatch(value) or value.endswith((" ", ".")):
        raise Refused("Use a plain file name without directories.")
    if value.lower().rsplit(".", 1)[-1] not in TYPES or "." not in value:
        raise Refused("Unsupported file type.")
    if re.match(r"^(credentials?|passwords?|secrets?|tokens?|id)[._ -]", value, re.I):
        raise Refused("This file name is reserved.")
    return value


class UnixConnection(http.client.HTTPConnection):
    def __init__(self, path):
        super().__init__("localhost", timeout=40)
        self.path = path

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.path)


class IssueReader:
    def __init__(self, config):
        self.config = config
        self.version = "2025-03-26"
        self.session = None

    def request(self, method, params, seq=None):
        conf = self.config
        conn = UnixConnection(conf.socket) if conf.socket else http.client.HTTPConnection("127.0.0.1", conf.port, timeout=40)
        envelope = {"jsonrpc": "2.0", "method": method, "params": params}
        if seq is not None:
            envelope["id"] = seq
        headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream",
                   "MCP-Protocol-Version": self.version, "User-Agent": "stargate-officer-files/1"}
        if self.session:
            headers["Mcp-Session-Id"] = self.session
        if conf.actor:
            headers["X-Subspace-Agent"] = conf.actor
        try:
            conn.request("POST", "/mcp", json.dumps(envelope), headers)
            response = conn.getresponse()
            if response.status not in (200, 202, 204):
                raise Refused("Subspace refused the file request.")
            self.session = response.getheader("Mcp-Session-Id") or self.session
            if seq is None:
                return
            # A result may contain JSON encoded inside a text block. One base64
            # character can occupy seven wire bytes (escaped Unicode plus the outer escape).
            media_read = params.get("name") in ("subspace_get_attachment", "subspace_get_issue_image", "subspace_get_chat_upload")
            limit = 7 * (4 * ((LIMIT + 2) // 3)) + 131072 if media_read else 2 * 1024 * 1024
            raw = response.read(limit + 1)
            if len(raw) > limit:
                raise Refused("Subspace response exceeds the file limit.")
            if response.getheader("Content-Type", "").startswith("text/event-stream"):
                raw = next(line[5:].strip() for line in raw.splitlines() if line.startswith(b"data:"))
            reply = json.loads(raw)
            if reply.get("id") != seq or "result" not in reply:
                raise Refused("Subspace did not confirm the file request.")
            return reply["result"]
        finally:
            conn.close()

    def tool(self, name, args):
        result = self.request("tools/call", {"name": "subspace_" + name, "arguments": args}, 2)
        if result.get("isError"):
            raise Refused("The requested attachment is unavailable.")
        return result["structuredContent"] if "structuredContent" in result else json.loads(result["content"][0]["text"])

    def connect(self):
        self.version = self.request("initialize", {"protocolVersion": self.version, "capabilities": {},
                                     "clientInfo": {"name": "officer-files", "version": "1"}}, 1)["protocolVersion"]
        self.request("notifications/initialized", {})

    def attachment(self, issue, media):
        if not isinstance(issue, str) or not re.fullmatch(r"[A-Z][A-Z0-9]{0,18}-[1-9][0-9]{0,9}", issue):
            raise Refused("Use an issue key.")
        media = str(uuid.UUID(media))
        cursor = None
        for _ in range(100):
            args = {"issue": issue, "limit": 100}
            if cursor:
                args["cursor"] = cursor
            page = self.tool("list_attachments", args)
            for item in page["items"]:
                if item["mediaId"] != media:
                    continue
                name = safe_name(item["fileName"])
                size = item["sizeBytes"]
                if not isinstance(size, int) or not 0 < size <= LIMIT:
                    raise Refused("Attachment exceeds the size limit.")
                read = {"file": "get_attachment", "image": "get_issue_image"}[item["kind"]]
                body = self.tool(read, {"mediaId": media})
                if body["fileName"] != name or body["contentType"] != item["contentType"] or body["sizeBytes"] != size:
                    raise Refused("The attachment changed. Read it again.")
                data = verified_bytes(item, body["base64"])
                return name, data
            cursor = page.get("nextCursor")
            if not cursor:
                break
        raise Refused("Attachment not found on that issue.")


def verified_bytes(item, encoded):
    size = item["sizeBytes"]
    if type(size) is not int or not 0 < size <= LIMIT or len(encoded) != 4 * ((size + 2) // 3):
        raise Refused("Attachment length differs from its record or exceeds 10 MiB.")
    data = base64.b64decode(encoded, validate=True)
    if len(data) != size or (item.get("sha256") and hashlib.sha256(data).hexdigest() != item["sha256"].lower()):
        raise Refused("The attachment changed. Read it again.")
    return data


def staged(root, name):
    rootfd = os.open(root, os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=rootfd)
    finally:
        os.close(rootfd)
    with os.fdopen(fd, "rb") as f:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.getuid()
                or info.st_mode & 0o022 or not 0 < info.st_size <= LIMIT):
            raise Refused("Stage an officer-owned regular file within the size limit.")
        data = f.read(info.st_size + 1)
        if len(data) != info.st_size or os.fstat(fd).st_ctime_ns != info.st_ctime_ns:
            raise Refused("Finish writing the file before sharing it.")
        return data


def prepare(args, config):
    args = dict(args)
    upload_id = str(uuid.UUID(args.pop("chatUploadId"))) if "chatUploadId" in args else None
    source = args.get("source")
    if source not in SOURCES or args.keys() != SOURCES[source] | {"source"}:
        raise Refused("Choose one source and supply its required fields.")
    subspace = IssueReader(config)
    if upload_id or source in ("issue", "upload"):
        subspace.connect()
    if source == "upload":
        reference = args["reference"]
        if upload_id or not isinstance(reference, str) or not re.fullmatch(r"UPL-[A-Za-z0-9_-]{22}", reference):
            raise Refused("Use an existing UPL reference without a new upload ID.")
        body = subspace.tool("get_chat_upload", {"reference": reference, "includeBytes": True})
        item = body["upload"]
        if item["reference"] != reference or not item.get("sha256"):
            raise Refused("Subspace returned a different upload.")
        return save_file(config.exports, safe_name(item["fileName"]), verified_bytes(item, body["base64"]))
    if source == "issue":
        name, data = subspace.attachment(args["issue"], args["mediaId"])
    else:
        name = safe_name(args["fileName"])
        if source == "staged":
            data = staged(config.staging, name)
        else:
            if name.rsplit(".", 1)[-1].lower() not in {"md", "markdown", "txt", "text", "csv"}:
                raise Refused("Use a text document extension for new text.")
            data = args["text"].encode("utf-8")
            if not 0 < len(data) <= 65536:
                raise Refused("Use 1 to 65536 UTF-8 bytes for new text.")
    if upload_id:
        suffix = name.rsplit(".", 1)[-1].lower()
        mime = CHAT_TYPES.get(suffix)
        if not mime:
            raise Refused("This file type cannot be published as a Subspace chat upload.")
        receipt = subspace.tool("create_chat_upload", {"uploadId": upload_id, "fileName": name, "contentType": mime,
                                                       "base64": base64.b64encode(data).decode("ascii")})
        expected = "UPL-" + base64.urlsafe_b64encode(uuid.UUID(upload_id).bytes).decode("ascii").rstrip("=")
        if (receipt.get("reference") != expected or receipt.get("sizeBytes") != len(data)
                or receipt.get("sha256", "").lower() != hashlib.sha256(data).hexdigest()):
            raise Refused("Upload unconfirmed. Check the same upload ID before retrying.")
        return {"fileName": name, "sizeBytes": len(data), "reference": expected}
    return save_file(config.exports, name, data)


def save_file(root_path, name, data):
    # Exclusive random directory keeps the original name and inherits the publishing group.
    folder = uuid.uuid4().hex
    root = os.open(root_path, os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.mkdir(folder, 0o700, dir_fd=root)
        try:
            directory = os.open(folder, os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root)
        except OSError:
            os.rmdir(folder, dir_fd=root)
            raise
        try:
            with os.fdopen(os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                                   0o600, dir_fd=directory), "wb") as f:
                f.write(data)
                f.flush()
                os.fchmod(f.fileno(), 0o640)
            os.fchmod(directory, 0o2750)
        except BaseException:
            with contextlib.suppress(FileNotFoundError):
                os.unlink(name, dir_fd=directory)
            os.rmdir(folder, dir_fd=root)
            raise
        finally:
            os.close(directory)
    finally:
        os.close(root)
    path = Path(root_path) / folder / name
    return {"fileName": name, "sizeBytes": len(data), "marker": f"![{name}](file://{quote(str(path))})"}


def deadline(_signum, _frame):
    raise Refused("File preparation timed out. Check the upload ID before retrying.")


def serve(config, stdin, stdout):
    signal.signal(signal.SIGALRM, deadline)
    for line in iter(lambda: stdin.readline(400001), b""):
        if len(line) > 400000:
            return
        request = {}
        try:
            request = json.loads(line)
            if "id" not in request:
                continue
            method = request["method"]
            if method == "initialize":
                version = request["params"].get("protocolVersion")
                result = {"protocolVersion": version if version in ("2025-03-26", "2025-06-18", "2025-11-25") else "2025-03-26",
                          "capabilities": {"tools": {}}, "serverInfo": {"name": "officer-files", "version": "1"}}
            elif method == "tools/list":
                result = {"tools": [TOOL]}
            elif method == "ping":
                result = {}
            elif method == "tools/call" and request["params"]["name"] == TOOL["name"]:
                try:
                    signal.alarm(80)
                    value = prepare(request["params"]["arguments"], config)
                    result = {"content": [{"type": "text", "text": json.dumps(value)}]}
                except (MemoryError, OSError, ValueError, LookupError, TypeError, AttributeError, StopIteration, http.client.HTTPException) as error:
                    detail = str(error) if isinstance(error, Refused) else "Could not prepare the requested file."
                    result = {"isError": True, "content": [{"type": "text", "text": detail}]}
                finally:
                    signal.alarm(0)
            else:
                raise ValueError()
            reply = {"result": result}
        except (ValueError, TypeError, KeyError, AttributeError):
            reply = {"error": {"code": -32600, "message": "Invalid request"}}
        print(json.dumps({"jsonrpc": "2.0", "id": request.get("id") if isinstance(request, dict) else None, **reply}), file=stdout, flush=True)


if __name__ == "__main__":
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("--exports", required=True, type=Path)
    cli.add_argument("--staging", required=True, type=Path)
    upstream = cli.add_mutually_exclusive_group(required=True)
    upstream.add_argument("--socket")
    upstream.add_argument("--port", type=int)
    cli.add_argument("--actor")
    options = cli.parse_args()
    if any(not p.is_absolute() or p.resolve() != p for p in (options.exports, options.staging)):
        cli.error("Configure canonical absolute directories.")
    serve(options, sys.stdin.buffer, sys.stdout)
