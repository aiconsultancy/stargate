import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AttachmentTransport,
  agentFilesLocal,
  deliverAttachments,
} from "../src/attachment-delivery";
import { opencodeScratchDirectory } from "../src/attachments";
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

test("one-shot publication records intent and never repeats an uncertain send", async () => {
  const { calls, transport } = linkTransport();
  transport.publishOnce = true;
  const files: AttachmentDelivery[] = [
    {
      path: "/unused.png",
      caption: "proof",
      title: "proof",
      prepared: {
        path: "/unused.png",
        caption: "proof",
        name: "proof.png",
        mime: "image/png",
        size: 1,
        sha256: "0".repeat(64),
      },
      phase: "uploaded",
      fileID: "data:image/png;base64,proof",
    },
  ];
  transport.link = async () => {
    expect(files[0]?.phase).toBe("completing");
    calls.push("link");
    throw new Error("Uncertain delivery");
  };
  const run = fixture(files, transport);
  await expect(run.deliver()).rejects.toThrow("Uncertain delivery");
  await run.deliver();
  expect(calls).toEqual(["link"]);
  expect(files[0]?.phase).toBe("unavailable");
  expect(run.notices).toHaveLength(1);
});

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

test("reply files from OpenCode's TMPDIR scratch are published; dot segments below it are not", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "stargate-scratch-")),
  );
  const previous = process.env["TMPDIR"];
  // Galactica: TMPDIR=%h/.cache/tmp, so scratch is ~/.cache/tmp/opencode.
  const temporary = join(root, ".cache", "tmp");
  const scratch = join(temporary, "opencode");
  await mkdir(join(scratch, ".git"), { recursive: true });
  await mkdir(join(scratch, ".ssh"));
  await writeFile(join(scratch, "proof.txt"), "proof");
  await writeFile(join(scratch, ".git", "config"), "private");
  await writeFile(join(scratch, ".ssh", "config"), "private");
  await writeFile(join(scratch, "credentials.json"), "private");
  await writeFile(join(root, ".cache", "other.txt"), "cache");
  await mkdir(join(temporary, "opencode-other"));
  await writeFile(join(temporary, "opencode-other", "proof.txt"), "cache");
  await symlink(join(scratch, "proof.txt"), join(scratch, "link.txt"));
  process.env["TMPDIR"] = temporary;
  try {
    expect(opencodeScratchDirectory()).toBe(scratch);
    const uploaded: string[] = [];
    const transport: AttachmentTransport = {
      download: async () => [],
      upload: async (file) => {
        uploaded.push(new TextDecoder().decode(file.data));
        return "https://files.example/proof";
      },
      link: async () => {},
    };
    const f = fixture(
      [
        { path: join(scratch, "proof.txt"), caption: "" },
        { path: join(scratch, ".git", "config"), caption: "" },
        { path: join(scratch, ".ssh", "config"), caption: "" },
        { path: join(scratch, "credentials.json"), caption: "" },
        { path: join(scratch, "link.txt"), caption: "" },
        { path: join(root, ".cache", "other.txt"), caption: "" },
        { path: join(temporary, "opencode-other", "proof.txt"), caption: "" },
      ],
      transport,
    );
    await f.deliver();
    expect(f.files.map((file) => file.phase)).toEqual([
      "shared",
      "unavailable",
      "unavailable",
      "unavailable",
      "unavailable",
      "unavailable",
      "unavailable",
    ]);
    expect(uploaded).toEqual(["proof"]);
  } finally {
    if (previous === undefined) delete process.env["TMPDIR"];
    else process.env["TMPDIR"] = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["unchanged", "changed", "symlink", "TMPDIR"])(
  "scratch upload retry revalidates %s against current gateway scratch",
  async (change) => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "stargate-retry-")),
    );
    const previous = process.env["TMPDIR"];
    const temporary = join(root, ".cache", "tmp");
    const scratch = join(temporary, "opencode");
    await mkdir(scratch, { recursive: true });
    const path = join(scratch, "proof.txt");
    await writeFile(path, "proof");
    process.env["TMPDIR"] = temporary;
    try {
      const calls: string[] = [];
      let fail = true;
      const f = fixture([{ path, caption: "" }], {
        download: async () => [],
        reserveUpload: async () => {
          if (fail) throw new Error("Retry reservation");
          calls.push("reserve");
          return { fileID: "F1", url: "https://files.example/upload" };
        },
        putUpload: async (_url, data) => {
          expect(new TextDecoder().decode(data)).toBe("proof");
          calls.push("put");
        },
        completeUpload: async () => {
          calls.push("complete");
        },
        sharedIn: async () => false,
      });
      await expect(f.deliver()).rejects.toThrow("Retry reservation");
      expect(f.files[0]?.prepared?.path).toBe(path);
      fail = false;
      if (change === "changed") await writeFile(path, "other");
      if (change === "symlink") {
        await rm(path);
        await writeFile(join(scratch, "other.txt"), "proof");
        await symlink(join(scratch, "other.txt"), path);
      }
      if (change === "TMPDIR") process.env["TMPDIR"] = root;
      if (change === "unchanged") {
        await f.deliver();
        expect(f.files[0]?.phase).toBe("shared");
        expect(calls).toEqual(["reserve", "put", "complete"]);
      } else {
        await expect(f.deliver()).rejects.toThrow("became unavailable");
        expect(f.files[0]?.phase).toBe("unavailable");
        expect(calls).toEqual([]);
      }
    } finally {
      if (previous === undefined) delete process.env["TMPDIR"];
      else process.env["TMPDIR"] = previous;
      await rm(root, { recursive: true, force: true });
    }
  },
);
