import { afterEach, expect, test } from "bun:test";
import { LogLevel, WebClient } from "@slack/web-api";
import {
  type Attachment,
  maxAttachmentBytes,
  maxAttachmentTotalBytes,
} from "../src/attachments";
import { SlackFiles, type SlackFilesFetch } from "../src/slack-files";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const pdf = new TextEncoder().encode("%PDF-1.7\nBinary document\0");
const signal = () => new AbortController().signal;

function fixture() {
  const records: { path: string; params: URLSearchParams }[] = [];
  const transfers: { url: string; init: RequestInit | undefined }[] = [];
  const uploads: { auth: string | null; data: Uint8Array }[] = [];
  const info = new Map<string, Record<string, unknown>>();
  const file = (
    id = "F1",
    data = png,
    mime = "image/png",
    name = "image.png",
  ) => ({
    id,
    name,
    mimetype: mime,
    size: data.byteLength,
    mode: "hosted",
    is_external: false,
    channels: ["C1"],
    groups: [],
    ims: [],
    url_private_download: `https://files.slack.com/files-pri/${id}/download`,
  });
  info.set("F1", file());
  let api = (path: string, params: URLSearchParams): unknown => {
    if (path === "/api/files.info")
      return { ok: true, file: info.get(params.get("file") ?? "") };
    if (path === "/api/files.getUploadURLExternal")
      return {
        ok: true,
        file_id: "F99",
        upload_url: "https://files.slack.com/upload/v1/F99",
      };
    if (path === "/api/files.completeUploadExternal")
      return { ok: true, files: [{ id: "F99" }] };
    throw new Error("Unexpected fixture API path");
  };
  let download = async (_url: URL, _init?: RequestInit) =>
    new Response(png, { headers: { "content-type": "image/png" } });
  let upload: SlackFilesFetch | undefined;
  let apiFetch: SlackFilesFetch | undefined;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path.startsWith("/api/")) {
        const params = new URLSearchParams(await request.text());
        records.push({ path, params });
        return Response.json(api(path, params));
      }
      if (path === "/upload/v1/F99") {
        uploads.push({
          auth: request.headers.get("authorization"),
          data: new Uint8Array(await request.arrayBuffer()),
        });
        return new Response("OK", { status: 200 });
      }
      throw new Error("Unexpected fixture transfer path");
    },
  });
  cleanup.push(() => server.stop(true));
  const request: SlackFilesFetch = async (url, init) => {
    const source = new URL(url);
    if (source.origin === "https://files.slack.com") {
      transfers.push({ url: source.href, init });
      if (!source.pathname.startsWith("/upload/"))
        return download(source, init);
      if (upload) return upload(source, init);
    } else if (source.origin !== "https://slack.com")
      throw new Error("Fixture blocked outbound host");
    else if (apiFetch) return apiFetch(source, init);
    return fetch(new URL(source.pathname, server.url), init);
  };
  const files = new SlackFiles(
    (stop) =>
      new WebClient("xoxb-fixture", {
        fetch: (url, init) =>
          request(url, {
            ...init,
            signal: init?.signal ? AbortSignal.any([stop, init.signal]) : stop,
          }),
        retryConfig: { retries: 0 },
        rejectRateLimitedCalls: true,
        timeout: 1000,
        logger: {
          debug() {},
          info() {},
          warn() {},
          error() {},
          setLevel() {},
          setName() {},
          getLevel() {
            return LogLevel.ERROR;
          },
        },
      }),
    "xoxb-fixture",
    request,
  );
  return {
    files,
    info,
    file,
    records,
    transfers,
    uploads,
    api(next: typeof api) {
      api = next;
    },
    download(next: typeof download) {
      download = next;
    },
    upload(next: SlackFilesFetch) {
      upload = next;
    },
    apiFetch(next: SlackFilesFetch) {
      apiFetch = next;
    },
  };
}

test("Slack file download resolves IDs, checks channel membership and returns PNG/PDF bytes", async () => {
  const f = fixture();
  f.info.set("F2", {
    ...f.file("F2", pdf, "application/pdf", "report.pdf"),
    channels: [],
    shares: { private: { D1: [{ ts: "1.000" }] } },
  });
  f.download(async (url, init) => {
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer xoxb-fixture",
    );
    return new Response(url.pathname.includes("F2") ? pdf : png, {
      headers: {
        "content-type": url.pathname.includes("F2")
          ? "application/pdf"
          : "image/png",
      },
    });
  });
  expect(await f.files.download(["F1"], "C1", signal())).toEqual([
    { name: "image.png", mime: "image/png", data: png, source: { id: "F1" } },
  ]);
  expect(await f.files.download(["F2"], "D1", signal())).toEqual([
    {
      name: "report.pdf",
      mime: "application/pdf",
      data: pdf,
      source: { id: "F2" },
    },
  ]);
  expect(f.records.map(({ params }) => params.get("file"))).toEqual([
    "F1",
    "F2",
  ]);
});

test("Slack clip facts: only a finished, untruncated transcript is returned", async () => {
  const audio = new TextEncoder().encode("fixture m4a bytes");
  const cases: [Record<string, unknown>, NonNullable<Attachment["source"]>][] =
    [
      [{}, { id: "F1" }],
      [
        { duration_ms: 68638, transcription: { status: "none" } },
        { id: "F1", durationMs: 68638 },
      ],
      [
        {
          transcription: {
            status: "complete",
            preview: { content: "Deploy it.", has_more: false },
          },
        },
        { id: "F1", transcript: "Deploy it." },
      ],
      [
        {
          transcription: {
            status: "complete",
            preview: { content: "Deploy it." },
          },
        },
        { id: "F1", transcript: "Deploy it." },
      ],
      // A preview that continues elsewhere, an unfinished or empty transcript and
      // an unknown shape never stand in for the speech.
      [
        {
          transcription: {
            status: "complete",
            preview: { content: "Deploy", has_more: true },
          },
        },
        { id: "F1" },
      ],
      [
        {
          transcription: { status: "processing", preview: { content: "Dep" } },
        },
        { id: "F1" },
      ],
      [
        { transcription: { status: "complete", preview: { content: "  " } } },
        { id: "F1" },
      ],
      [{ transcription: "complete", duration_ms: "long" }, { id: "F1" }],
    ];
  for (const [change, source] of cases) {
    const f = fixture();
    f.info.set("F1", {
      ...f.file("F1", audio, "audio/mp4", "Audio clip.m4a"),
      ...change,
    });
    f.download(
      async () =>
        new Response(audio, { headers: { "content-type": "audio/mp4" } }),
    );
    expect(await f.files.download(["F1"], "C1", signal())).toEqual([
      { name: "Audio clip.m4a", mime: "audio/mp4", data: audio, source },
    ]);
  }
});

test("Slack file metadata refuses missing scope, foreign IDs/channels and external files before download", async () => {
  for (const change of [
    { id: "F2" },
    { channels: ["C2"] },
    { channels: undefined },
    { mode: "external" },
    { is_external: true },
    { size: 0 },
    { size: maxAttachmentBytes + 1 },
    { name: "../private" },
    { mimetype: "text/html" },
  ]) {
    const f = fixture();
    f.info.set("F1", { ...f.file(), ...change });
    await expect(f.files.download(["F1"], "C1", signal())).rejects.toThrow(
      "Slack file",
    );
    expect(f.transfers).toEqual([]);
  }
  const f = fixture();
  f.api(() => ({
    ok: false,
    error: "missing_scope",
    private: "TOKEN_PRIVATE_PATH",
  }));
  await expect(f.files.download(["F1"], "C1", signal())).rejects.toThrow(
    "Slack file",
  );
  expect(f.transfers).toEqual([]);
});

test("Slack file download rejects untrusted origins without forwarding bearer tokens", async () => {
  for (const url of [
    "http://files.slack.com/private",
    "https://files.slack.com.evil.test/private",
    "https://evil.test/private",
    "https://user:pass@files.slack.com/private",
    "https://files.slack.com:444/private",
  ]) {
    const f = fixture();
    f.info.set("F1", { ...f.file(), url_private_download: url });
    await expect(f.files.download(["F1"], "C1", signal())).rejects.toThrow(
      "Slack file",
    );
    expect(f.transfers).toEqual([]);
  }
});

test("Slack file transfer rejects redirects, HTML and inconsistent MIME/size metadata", async () => {
  for (const response of [
    () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://evil.test/token" },
      }),
    () =>
      new Response("<html>Sign in</html>", {
        headers: { "content-type": "text/html" },
      }),
    () =>
      new Response("<html>Sign in</html>", {
        headers: { "content-type": "application/octet-stream" },
      }),
    () => new Response(png, { headers: { "content-type": "application/pdf" } }),
    () =>
      new Response(new Uint8Array([1]), {
        headers: { "content-type": "image/png" },
      }),
    () =>
      new Response(png, {
        headers: {
          "content-type": "image/png",
          "content-length": String(maxAttachmentBytes + 1),
        },
      }),
  ]) {
    const f = fixture();
    f.download(async () => response());
    await expect(f.files.download(["F1"], "C1", signal())).rejects.toThrow(
      "Slack file",
    );
    expect(f.transfers).toHaveLength(1);
    expect(f.transfers[0]?.init?.redirect).toBe("error");
  }
});

test("Slack file streaming cancels oversized bodies even when content-length lies", async () => {
  const f = fixture();
  let cancelled = false;
  f.download(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(9));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "content-type": "image/png", "content-length": "8" } },
      ),
  );
  await expect(f.files.download(["F1"], "C1", signal())).rejects.toThrow(
    "Slack file",
  );
  expect(cancelled).toBe(true);
});

test("Slack file rejects HTML hidden behind matching binary metadata and a generic MIME", async () => {
  const f = fixture();
  const html = new TextEncoder().encode("<!doctype html><html>Sign in</html>");
  f.info.set("F1", f.file("F1", html));
  f.download(
    async () =>
      new Response(html, {
        headers: { "content-type": "application/octet-stream" },
      }),
  );
  await expect(f.files.download(["F1"], "C1", signal())).rejects.toThrow(
    "Slack file",
  );
});

test("Slack file batch applies count and aggregate budgets before allocating more bodies", async () => {
  const f = fixture();
  await expect(
    f.files.download(Array(11).fill("F1"), "C1", signal()),
  ).rejects.toThrow("Slack file");
  expect(f.records).toEqual([]);
  const size = 9 * 1024 * 1024;
  for (const id of ["F1", "F2", "F3"])
    f.info.set(
      id,
      f.file(id, new Uint8Array(size), "application/zip", "bundle.zip"),
    );
  f.download(
    async () =>
      new Response(new Uint8Array(size), {
        headers: { "content-type": "application/octet-stream" },
      }),
  );
  await expect(
    f.files.download(["F1", "F2", "F3"], "C1", signal()),
  ).rejects.toThrow("Slack file");
  expect(f.transfers).toHaveLength(2);
  expect(size * 3).toBeGreaterThan(maxAttachmentTotalBytes);
});

test("Slack file download abort cancels a blocked stream and never returns partial bytes", async () => {
  const f = fixture();
  const reading = Promise.withResolvers<void>();
  let cancelled = false;
  f.download(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull() {
            reading.resolve();
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "content-type": "image/png" } },
      ),
  );
  const stop = new AbortController();
  const work = f.files.download(["F1"], "C1", stop.signal);
  await reading.promise;
  stop.abort(new Error("PRIVATE_ABORT_REASON"));
  await expect(work).rejects.toThrow("Slack file");
  expect(cancelled).toBe(true);
});

test("Slack upload reserves once, posts raw bytes without auth and completes in the exact thread", async () => {
  const f = fixture();
  const reserved = await f.files.reserveUpload(
    "report.pdf",
    pdf.byteLength,
    signal(),
  );
  expect(reserved).toEqual({
    fileID: "F99",
    url: "https://files.slack.com/upload/v1/F99",
  });
  await f.files.putUpload(reserved.url, pdf, signal());
  await f.files.completeUpload(
    "C1",
    "1.000",
    reserved.fileID,
    "report.pdf",
    signal(),
  );
  expect(f.uploads).toEqual([{ auth: null, data: pdf }]);
  expect(f.transfers[0]?.init).toMatchObject({
    method: "POST",
    redirect: "error",
  });
  const reserve = f.records.find(({ path }) =>
    path.endsWith("getUploadURLExternal"),
  )?.params;
  expect(reserve?.get("filename")).toBe("report.pdf");
  expect(reserve?.get("length")).toBe(String(pdf.byteLength));
  const completion = f.records.find(({ path }) =>
    path.endsWith("completeUploadExternal"),
  )?.params;
  expect(completion?.get("channel_id")).toBe("C1");
  expect(completion?.get("thread_ts")).toBe("1.000");
  expect(JSON.parse(completion?.get("files") ?? "null")).toEqual([
    { id: "F99", title: "report.pdf" },
  ]);
});

test("Slack upload rejects invalid reservations and unsafe transfer destinations", async () => {
  const f = fixture();
  for (const response of [
    { ok: false, error: "missing_scope" },
    { ok: true, file_id: "F99", upload_url: "https://evil.test/upload" },
    {
      ok: true,
      file_id: "foreign",
      upload_url: "https://files.slack.com/upload",
    },
  ]) {
    f.api(() => response);
    await expect(
      f.files.reserveUpload("file.zip", 8, signal()),
    ).rejects.toThrow("Slack file");
  }
  await expect(f.files.reserveUpload("../secret", 8, signal())).rejects.toThrow(
    "Slack file",
  );
  await expect(
    f.files.reserveUpload("file.zip", maxAttachmentBytes + 1, signal()),
  ).rejects.toThrow("Slack file");
  await expect(
    f.files.putUpload("https://evil.test/upload", png, signal()),
  ).rejects.toThrow("Slack file");
  expect(f.uploads).toEqual([]);
});

test("Slack signed upload rejects redirects/non-200 responses and never sends bearer auth", async () => {
  const f = fixture();
  for (const status of [302, 500]) {
    f.upload(async (_url, init) => {
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      return new Response(null, {
        status,
        headers: { location: "https://evil.test/upload" },
      });
    });
    await expect(
      f.files.putUpload("https://files.slack.com/upload/v1/F99", png, signal()),
    ).rejects.toThrow("Slack file");
  }
  expect(f.records).toEqual([]);
});

test("Slack metadata and signed-upload operations honour abort through injected fetch", async () => {
  for (const operation of ["metadata", "upload"] as const) {
    const f = fixture();
    const started = Promise.withResolvers<void>();
    let aborted = false;
    const pending: SlackFilesFetch = async (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) throw new Error("Missing request signal");
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new Error("PRIVATE_RAW_ERROR"));
          },
          { once: true },
        );
        started.resolve();
      });
    if (operation === "metadata") f.apiFetch(pending);
    else f.upload(pending);
    const stop = new AbortController();
    const work =
      operation === "metadata"
        ? f.files.download(["F1"], "C1", stop.signal)
        : f.files.putUpload(
            "https://files.slack.com/upload/v1/F99",
            png,
            stop.signal,
          );
    await started.promise;
    stop.abort();
    await expect(work).rejects.toThrow("Slack file");
    expect(aborted).toBe(true);
  }
});

test("Slack upload completion accepts display-title separators without changing text", async () => {
  for (const title of [
    "Before/after login",
    "Before\\after login",
    "x".repeat(255),
  ]) {
    const f = fixture();
    await f.files.completeUpload("C1", "1.000", "F99", title, signal());
    expect(f.records).toHaveLength(1);
    expect(JSON.parse(f.records[0]?.params.get("files") ?? "null")).toEqual([
      { id: "F99", title },
    ]);
  }
});

test("Slack upload completion rejects invalid display titles before the API call", async () => {
  const f = fixture();
  for (const title of [
    "",
    "x".repeat(256),
    "Before\tafter",
    "Before\nafter",
    "Before\0after",
    "Before\x7fafter",
  ]) {
    await expect(
      f.files.completeUpload("C1", "1.000", "F99", title, signal()),
    ).rejects.toThrow("Slack file");
  }
  expect(f.records).toEqual([]);
});

test("Slack upload completion validates identity and never retries an ambiguous result", async () => {
  for (const response of [
    { ok: false, error: "missing_scope" },
    { ok: true, files: [{ id: "F98" }] },
    { ok: true },
  ]) {
    const f = fixture();
    f.api(() => response);
    await expect(
      f.files.completeUpload("C1", "1.000", "F99", "report.pdf", signal()),
    ).rejects.toThrow("Slack file");
    expect(f.records).toHaveLength(1);
  }
});

test("Slack share confirmation distinguishes exact thread, root shares and proven absence", async () => {
  const f = fixture();
  f.info.set("F99", {
    id: "F99",
    shares: {
      public: { C1: [{ ts: "2.000", thread_ts: "1.000" }, { ts: "3.000" }] },
      private: { D1: [{ ts: "4.000", thread_ts: "5.000" }] },
    },
  });
  expect(await f.files.sharedIn("F99", "C1", "1.000", signal())).toBe(true);
  expect(await f.files.sharedIn("F99", "C1", "2.000", signal())).toBe(false);
  expect(await f.files.sharedIn("F99", "C1", "3.000", signal())).toBe(true);
  expect(await f.files.sharedIn("F99", "D1", "5.000", signal())).toBe(true);
  expect(await f.files.sharedIn("F99", "C2", "1.000", signal())).toBe(false);
  f.info.set("F99", { id: "F99", shares: {} });
  expect(await f.files.sharedIn("F99", "C1", "1.000", signal())).toBe(false);
});

test("Slack share confirmation throws on missing, malformed, foreign or API-error evidence", async () => {
  const f = fixture();
  for (const response of [
    { ok: false, error: "missing_scope" },
    { ok: true, file: { id: "F99" } },
    { ok: true, file: { id: "F98", shares: {} } },
    { ok: true, file: { id: "F99", shares: { unknown: {} } } },
    { ok: true, file: { id: "F99", shares: { public: { C1: [{}] } } } },
  ]) {
    f.api(() => response);
    await expect(
      f.files.sharedIn("F99", "C1", "1.000", signal()),
    ).rejects.toThrow("Slack file");
  }
});
