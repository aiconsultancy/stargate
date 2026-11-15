import { expect, test } from "bun:test";
import {
  type AttachmentTransport,
  agentFilesLocal,
  deliverAttachments,
} from "../src/attachment-delivery";
import { backendSchema } from "../src/config";
import type { AttachmentDelivery, Job } from "../src/store";

const job = { id: 1, channel: "C1", thread: "1.0" } as Job;

function fixture(files: AttachmentDelivery[], transport?: AttachmentTransport) {
  const notices: string[] = [];
  let allowed = true;
  return {
    files,
    notices,
    deny: () => {
      allowed = false;
    },
    deliver: (local = true) =>
      deliverAttachments(
        job,
        {
          store: {
            attachments: () => files,
            saveAttachments: (_id, saved) => {
              expect(saved).toBe(files);
            },
          },
          transport,
          local,
          notify: async (text) => {
            notices.push(text);
          },
          allowed: () => allowed,
        },
        AbortSignal.timeout(5000),
      ),
  };
}

function linkTransport() {
  const calls: string[] = [];
  const transport: AttachmentTransport = {
    download: async () => [],
    upload: async () => {
      calls.push("upload");
      return "https://files.example/a";
    },
    link: async () => {
      calls.push("link");
    },
  };
  return { calls, transport };
}

test("an upload with an unknown outcome is never repeated", async () => {
  const { calls, transport } = linkTransport();
  // A crash after "uploading" was stored and before the URL was recorded.
  const f = fixture(
    [{ path: "/tmp/a.txt", caption: "", phase: "uploading" }],
    transport,
  );
  await f.deliver();
  expect(calls).toEqual([]);
  expect(f.files[0]).toMatchObject({ phase: "unavailable", noticeSent: true });
  expect(f.notices).toHaveLength(1);
  // A delivery retry posts no second notice.
  await f.deliver();
  expect(f.notices).toHaveLength(1);
});

test("a recorded URL is linked without another upload", async () => {
  const { calls, transport } = linkTransport();
  const f = fixture(
    [
      {
        path: "/tmp/a.txt",
        caption: "",
        phase: "uploaded",
        fileID: "https://files.example/a",
        title: "a.txt",
        prepared: {
          path: "/tmp/a.txt",
          caption: "",
          name: "a.txt",
          mime: "text/plain",
          size: 1,
          sha256: "0".repeat(64),
        },
      },
    ],
    transport,
  );
  await f.deliver();
  expect(calls).toEqual(["link"]);
  expect(f.files[0]?.phase).toBe("shared");
  expect(f.notices).toEqual([]);
});

test("files on another host are unavailable with one notice", async () => {
  const { calls, transport } = linkTransport();
  const f = fixture(
    [
      { path: "/tmp/a.txt", caption: "" },
      { path: "/tmp/b.txt", caption: "" },
    ],
    transport,
  );
  await f.deliver(false);
  expect(calls).toEqual([]);
  expect(f.files.map((file) => file.phase)).toEqual([
    "unavailable",
    "unavailable",
  ]);
  expect(f.notices).toHaveLength(1);
});

test("removed access stops before any notice or transport call", async () => {
  const { calls, transport } = linkTransport();
  const f = fixture(
    [{ path: "/tmp/a.txt", caption: "", phase: "uploading" }],
    transport,
  );
  f.deny();
  await expect(f.deliver()).rejects.toThrow("access denied");
  expect(calls).toEqual([]);
  expect(f.notices).toEqual([]);
});

test("only an OpenCode server on another host has remote files", () => {
  const opencode = (url: string) =>
    backendSchema.parse({ type: "opencode", url, directory: "/work" });
  expect(agentFilesLocal(opencode("http://localhost:4096"))).toBe(true);
  expect(agentFilesLocal(opencode("http://127.0.0.1:4096"))).toBe(true);
  expect(agentFilesLocal(opencode("https://agents.example:4096"))).toBe(false);
});
