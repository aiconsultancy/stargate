import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenCodeClient } from "@opencode/client";
import { OpenCodeCrewStatus } from "../src/backends/opencode/crew-status";
import type {
  CheckoutDiff,
  CheckoutDiffFile,
  CheckoutDiffInput,
} from "../src/coordination/crew/reporting/fleet-status";
import {
  type CrewDiffSource,
  crewDiffApi,
  diffPathAllowed,
} from "../src/observability/dashboard/api/v1/crew-diff";
import { startApiV1Server } from "../src/observability/dashboard/api/v1/server";
import { apiToken } from "../src/observability/dashboard/api/v1/token";
import type {
  ApiV1Source,
  V1Diff,
  V1DiffFilePage,
} from "../src/observability/dashboard/api/v1/types";

const fingerprint = "0123456789abcdef0123456789abcdef";
const moved = "fedcba9876543210fedcba9876543210";
const commit = "a".repeat(40);

const file = (
  path: string,
  rest: Partial<CheckoutDiffFile> = {},
): CheckoutDiffFile => ({
  path,
  previousPath: null,
  status: "modified",
  additions: 1,
  deletions: 1,
  patch: "@@ -1 +1 @@\n-a\n+b\n",
  ...rest,
});

const listOf = (
  files: CheckoutDiffFile[],
  rest: Partial<Extract<CheckoutDiff, { kind: "list" }>> = {},
): CheckoutDiff => ({
  kind: "list",
  fingerprint,
  unstable: false,
  branch: "feature",
  base: { ref: "origin/main", commit },
  head: commit,
  total: files.length,
  additions: files.length,
  deletions: files.length,
  files,
  next: null,
  ...rest,
});

/** A source that records each request and answers from `answer`. */
function recording(
  answer: (
    input: CheckoutDiffInput,
    signal: AbortSignal,
  ) => Promise<CheckoutDiff | undefined>,
) {
  const calls: { ship: string; input: CheckoutDiffInput }[] = [];

  const source: CrewDiffSource = (ship, input, signal) => {
    calls.push({ ship, input });

    return answer(input, signal);
  };

  return { calls, source };
}

const signal = new AbortController().signal;
const route = { ship: "altair", member: "worker", file: false };
const fileRoute = { ...route, file: true };
const query = (text: string) => new URLSearchParams(text);

test("paths follow the status file rule", () => {
  for (const path of ["a", "a/b.c", ".env", "dir/.git", "é/ü", " x "]) {
    expect(diffPathAllowed(path)).toBe(true);
  }

  for (const path of [
    "",
    "/abs",
    "a//b",
    "a/",
    "./a",
    "a/../b",
    "..",
    "a\\b",
    "a\0b",
    "a\nb",
    "a\u007fb",
    "x".repeat(4097),
  ]) {
    expect(diffPathAllowed(path)).toBe(false);
  }
});

test("malformed queries and cursors answer 400 before any computation", async () => {
  const { calls, source } = recording(async () => listOf([]));
  const api = crewDiffApi(source);

  for (const text of [
    "mode=all",
    "mode=branch&mode=branch",
    "unknown=1",
    "project=Bad",
    "project=",
    "page=",
    "page=%%%",
    "path=a",
    "at=" + fingerprint,
    "side=new",
  ]) {
    expect(await api.read(route, query(text), signal)).toBe(400);
  }

  for (const text of [
    "",
    "path=",
    "path=/etc/passwd",
    "path=a/../b",
    "path=a%5Cb",
    "path=a%00",
    "path=a&path=b",
    "path=a&at=xyz",
    "path=a&side=both",
    "path=a&mode=none",
  ]) {
    expect(await api.read(fileRoute, query(text), signal)).toBe(400);
  }

  expect(calls).toEqual([]);
});

test("a list maps to the v1 shape; null project is omitted and returned as null", async () => {
  const { calls, source } = recording(async () =>
    listOf(
      [
        file("a", { patchNext: 7, size: 4 }),
        file("b", { untracked: true, status: "added", deletions: 0 }),
      ],
      { total: 3, next: 2 },
    ),
  );

  const api = crewDiffApi(source);
  const body = (await api.read(route, query(""), signal)) as V1Diff;

  expect(calls).toEqual([
    {
      ship: "altair",
      input: {
        member: "worker",
        project: null,
        mode: "branch",
        request: { kind: "list", start: 0 },
      },
    },
  ]);
  expect(body).toMatchObject({
    ship: "altair",
    member: "worker",
    project: null,
    mode: "branch",
    fingerprint,
    unstable: false,
    total: 3,
  });
  expect(body.files[0]).toEqual({
    path: "a",
    previousPath: null,
    status: "modified",
    additions: 1,
    deletions: 1,
    size: 4,
    patch: "@@ -1 +1 @@\n-a\n+b\n",
    patchNextPage: expect.any(String),
  });
  expect(body.files[1]).toMatchObject({ untracked: true });
  expect(body.files[1]).not.toHaveProperty("patchNextPage");
  expect(typeof body.nextPage).toBe("string");

  // The next page is pinned to the fingerprint and starts where this ended.
  await api.read(route, query(`page=${body.nextPage}`), signal);
  expect(calls[1]?.input).toEqual({
    member: "worker",
    project: null,
    mode: "branch",
    at: fingerprint,
    request: { kind: "list", start: 2 },
  });

  // The patch continues on the file route at its byte offset.
  await api.read(
    fileRoute,
    query(`path=a&page=${body.files[0]?.patchNextPage}`),
    signal,
  );
  expect(calls[2]?.input).toEqual({
    member: "worker",
    project: null,
    mode: "branch",
    at: fingerprint,
    request: { kind: "patch", path: "a", offset: 7 },
  });

  // A cursor works only where it was issued.
  for (const [where, text] of [
    [route, `page=${body.nextPage}&mode=working`],
    [route, `page=${body.nextPage}&project=other`],
    [{ ...route, member: "other" }, `page=${body.nextPage}`],
    [fileRoute, `path=a&page=${body.nextPage}`],
    [fileRoute, `path=b&page=${body.files[0]?.patchNextPage}`],
    [fileRoute, `path=a&at=${moved}&page=${body.files[0]?.patchNextPage}`],
    [fileRoute, `path=a&side=new&page=${body.files[0]?.patchNextPage}`],
    [route, `page=${body.files[0]?.patchNextPage}`],
  ] as const) {
    expect(await api.read(where, query(text), signal)).toBe(400);
  }

  expect(calls.length).toBe(3);

  await api.read(route, query("project=indra&mode=committed"), signal);
  expect(calls[3]?.input).toMatchObject({
    project: "indra",
    mode: "committed",
  });
  expect(
    ((await api.read(route, query("project=indra"), signal)) as V1Diff).project,
  ).toBe("indra");
});

test("the file route serves patches and content pages with side-bound cursors", async () => {
  const { calls, source } = recording(async (input) => {
    if (input.request.kind === "patch") {
      return { kind: "patch", fingerprint, file: file(input.request.path) };
    }

    return {
      kind: "content",
      fingerprint,
      file: file("bin", {
        binary: true,
        additions: null,
        deletions: null,
        patch: null,
      }),
      side:
        input.request.kind === "content"
          ? (input.request.side ?? "new")
          : "new",
      offset: input.request.kind === "content" ? input.request.offset : 0,
      size: 10,
      data: "AAAA",
      next:
        input.request.kind === "content" && input.request.offset === 0
          ? 3
          : null,
    };
  });

  const api = crewDiffApi(source);

  expect(await api.read(fileRoute, query("path=a"), signal)).toEqual({
    fingerprint,
    file: {
      path: "a",
      previousPath: null,
      status: "modified",
      additions: 1,
      deletions: 1,
      patch: "@@ -1 +1 @@\n-a\n+b\n",
    },
  });
  expect(calls[0]?.input.request).toEqual({
    kind: "patch",
    path: "a",
    offset: 0,
  });
  expect(calls[0]?.input).not.toHaveProperty("at");

  const first = (await api.read(
    fileRoute,
    query(`path=bin&side=old&at=${fingerprint}`),
    signal,
  )) as V1DiffFilePage;

  expect(calls[1]?.input).toMatchObject({
    at: fingerprint,
    request: { kind: "content", path: "bin", side: "old", offset: 0 },
  });
  expect(first.content).toEqual({
    side: "old",
    encoding: "base64",
    offset: 0,
    size: 10,
    data: "AAAA",
    nextPage: expect.any(String),
  });
  expect(first.file.patch).toBeNull();

  const page = first.content?.nextPage ?? "";
  expect(
    await api.read(fileRoute, query(`path=bin&side=new&page=${page}`), signal),
  ).toBe(400);

  const second = (await api.read(
    fileRoute,
    query(`path=bin&side=old&at=${fingerprint}&page=${page}`),
    signal,
  )) as V1DiffFilePage;

  expect(calls.at(-1)?.input.request).toEqual({
    kind: "content",
    path: "bin",
    side: "old",
    offset: 3,
  });
  expect(second.content).not.toHaveProperty("nextPage");

  // Without `side`, the cursor's side applies.
  await api.read(fileRoute, query(`path=bin&page=${page}`), signal);
  expect(calls.at(-1)?.input.request).toEqual({
    kind: "content",
    path: "bin",
    side: "old",
    offset: 3,
  });
});

test("missing, absent, stale and unserved answers map to empty statuses", async () => {
  const answers: (CheckoutDiff | undefined)[] = [
    { kind: "missing" },
    { kind: "absent", fingerprint },
    { kind: "stale", fingerprint: moved },
    undefined,
  ];

  const api = crewDiffApi(async () => answers.shift());

  expect(await api.read(route, query(""), signal)).toBe(404);
  expect(await api.read(fileRoute, query("path=a"), signal)).toBe(404);
  expect(
    await api.read(fileRoute, query(`path=b&at=${fingerprint}`), signal),
  ).toBe(409);
  expect(await api.read(route, query(""), signal)).toBe(404);

  // An absent path at a fingerprint stays absent there.
  expect(
    await api.read(fileRoute, query(`path=a&at=${fingerprint}`), signal),
  ).toBe(404);
});

test("pinned answers are cached for 30 seconds; a stale answer purges the target", async () => {
  let clock = 0;
  let answer: CheckoutDiff = { kind: "patch", fingerprint, file: file("a") };
  const { calls, source } = recording(async () => answer);
  const api = crewDiffApi(source, { now: () => clock });
  const pinned = query(`path=a&at=${fingerprint}`);

  await api.read(fileRoute, pinned, signal);
  await api.read(fileRoute, pinned, signal);
  expect(calls.length).toBe(1);

  // A request without `at` is always fresh, and refreshes the cache.
  await api.read(fileRoute, query("path=a"), signal);
  expect(calls.length).toBe(2);
  await api.read(fileRoute, pinned, signal);
  expect(calls.length).toBe(2);

  clock += 30_001;
  await api.read(fileRoute, pinned, signal);
  expect(calls.length).toBe(3);

  answer = { kind: "stale", fingerprint: moved };
  expect(
    await api.read(fileRoute, query(`path=b&at=${fingerprint}`), signal),
  ).toBe(409);
  expect(calls.length).toBe(4);
  answer = { kind: "patch", fingerprint, file: file("a") };
  await api.read(fileRoute, pinned, signal);
  expect(calls.length).toBe(5);

  // Fresh first pages and unstable lists are never served from memory.
  answer = listOf([], { unstable: true, next: 1 });
  const list = (await api.read(route, query(""), signal)) as V1Diff;
  await api.read(route, query(`page=${list.nextPage}`), signal);
  await api.read(route, query(`page=${list.nextPage}`), signal);
  expect(calls.length).toBe(8);
});

test("identical requests share one computation; two at once at most", async () => {
  const gates: PromiseWithResolvers<CheckoutDiff>[] = [];
  const aborted: boolean[] = [];

  const { calls, source } = recording((_input, computing) => {
    const gate = Promise.withResolvers<CheckoutDiff>();
    const index = gates.push(gate) - 1;
    computing.addEventListener("abort", () => {
      aborted[index] = true;
      gate.reject(computing.reason);
    });

    return gate.promise;
  });

  const api = crewDiffApi(source);
  const a1 = api.read(fileRoute, query("path=a"), signal);
  const a2 = api.read(fileRoute, query("path=a"), signal);
  const leaving = new AbortController();
  const b = api.read(fileRoute, query("path=b"), leaving.signal);

  expect(calls.length).toBe(2);
  expect(await api.read(fileRoute, query("path=c"), signal)).toBe(503);

  gates[0]?.resolve({ kind: "patch", fingerprint, file: file("a") });
  expect(await a1).toEqual(await a2);

  // The last waiter to leave stops the computation.
  leaving.abort();
  await expect(b).rejects.toThrow();
  expect(aborted[1]).toBe(true);

  // Both slots are free again.
  const c = api.read(fileRoute, query("path=c"), signal);
  expect(calls.length).toBe(3);
  gates[2]?.resolve({ kind: "patch", fingerprint, file: file("c") });
  await c;
});

test("an abandoned computation is never joined, but holds its slot until it ends", async () => {
  const exits: PromiseWithResolvers<void>[] = [];
  const answers: PromiseWithResolvers<CheckoutDiff>[] = [];

  // Like Git, each computation takes a while to exit after its abort.
  const { calls, source } = recording(async (_input, computing) => {
    const exit = Promise.withResolvers<void>();
    const answer = Promise.withResolvers<CheckoutDiff>();
    exits.push(exit);
    answers.push(answer);
    computing.addEventListener("abort", () => {
      void exit.promise.then(() => answer.reject(computing.reason));
    });

    return answer.promise;
  });

  const api = crewDiffApi(source);
  const leaving = new AbortController();
  const first = api.read(fileRoute, query("path=a"), leaving.signal);
  leaving.abort();
  await expect(first).rejects.toThrow();

  // The same request at once starts afresh and answers.
  const second = api.read(fileRoute, query("path=a"), signal);
  expect(calls.length).toBe(2);
  // The first computation has not exited, so both slots are taken.
  expect(await api.read(fileRoute, query("path=b"), signal)).toBe(503);

  // Its exit does not forget the new computation: a third request joins it.
  exits[0]?.resolve();
  await Bun.sleep(0);
  const third = api.read(fileRoute, query("path=a"), signal);
  expect(calls.length).toBe(2);
  answers[1]?.resolve({ kind: "patch", fingerprint, file: file("a") });
  expect(await second).toMatchObject({ fingerprint, file: { path: "a" } });
  expect(await third).toEqual(await second);
});

test("a computation past its budget answers 503 and stops; a failure throws", async () => {
  let stopped = false;

  const slow = crewDiffApi(
    (_ship, _input, computing) =>
      new Promise((_resolve, reject) => {
        computing.addEventListener("abort", () => {
          stopped = true;
          reject(computing.reason);
        });
      }),
    { budgetMs: 20 },
  );

  expect(await slow.read(route, query(""), signal)).toBe(503);
  expect(stopped).toBe(true);

  const failing = crewDiffApi(async () => {
    throw new Error("git failed");
  });

  await expect(failing.read(route, query(""), signal)).rejects.toThrow(
    "git failed",
  );
});

const source: ApiV1Source = {
  fleet: async () => {
    throw new Error("unused");
  },
  ship: async () => undefined,
  crew: async () => undefined,
  gatewayFeatures: () => [],
};

test("the operator listener serves both routes; without the API they are 404", async () => {
  const dataDirectory = await mkdtemp(
    join(tmpdir(), "stargate-crew-diff-api-"),
  );

  const shutdown = new AbortController();

  const reservation = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(null),
  });

  const listen = `127.0.0.1:${reservation.port}`;
  await reservation.stop(true);

  const { calls, source: diffs } = recording(async (input) => {
    if (input.member === "gone") {
      return { kind: "missing" };
    }

    if (input.member === "broken") {
      throw new Error("git failed");
    }

    return input.request.kind === "list"
      ? listOf([file("a")])
      : { kind: "patch", fingerprint, file: file(input.request.path) };
  });

  const start = (withDiffs: boolean) =>
    startApiV1Server({
      config: { listen },
      dataDirectory,
      source,
      diff: () => [],
      gateway: {
        version: "1.2.3",
        opencodeVersion: async () => null,
        startedAt: 1,
      },
      ...(withDiffs && { crewDiff: crewDiffApi(diffs) }),
      signal: shutdown.signal,
    });

  try {
    const server = await start(true);
    const token = await apiToken(dataDirectory);

    const get = (path: string, method = "GET") =>
      fetch(new URL(path, server.url), {
        method,
        headers: { Authorization: `Bearer ${token}` },
      });

    const base = "/api/v1/ships/altair/crew/worker/diff";
    const listed = await get(base);
    expect(listed.status).toBe(200);
    expect(listed.headers.get("Cache-Control")).toBe("no-store");
    expect(await listed.json()).toMatchObject({
      ship: "altair",
      member: "worker",
      project: null,
      files: [{ path: "a" }],
    });

    const filed = await get(`${base}/file?path=d%C3%A9j%C3%A0%2Fx`);
    expect(await filed.json()).toMatchObject({ file: { path: "déjà/x" } });

    const head = await get(base, "HEAD");
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");

    for (const [path, status] of [
      [`${base}?mode=x`, 400],
      [`${base}/file`, 400],
      ["/api/v1/ships/altair/crew/gone/diff", 404],
      ["/api/v1/ships/altair/crew/broken/diff", 500],
      ["/api/v1/ships/altair/crew/%2F/diff", 404],
      [`${base}/other`, 404],
    ] as const) {
      const response = await get(path);
      expect(response.status).toBe(status);
      expect(await response.text()).toBe("");
    }

    const unauthorised = await fetch(new URL(base, server.url));
    expect(unauthorised.status).toBe(401);
    const count = calls.length;
    await server.stop();

    const plain = await start(false);

    const absent = await fetch(new URL(base, plain.url), {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(absent.status).toBe(404);
    expect(calls.length).toBe(count);
    await plain.stop();
  } finally {
    shutdown.abort();
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test("the captain client skips an older plugin for a minute and withholds failures", async () => {
  const answers: unknown[] = [
    { type: "rpc.method_not_found" },
    { kind: "missing" },
    new Error("/home/captain/secret: permission denied"),
    { kind: "list" },
  ];

  const requests: { input: unknown; directory: string }[] = [];

  const client = {
    rpc: () => ({
      checkoutDiff: async (
        input: unknown,
        options: { location: { directory: string } },
      ) => {
        requests.push({ input, directory: options.location.directory });
        const answer = answers.shift();

        if (answer instanceof Error || (answer as { type?: string }).type) {
          throw answer;
        }

        return answer;
      },
    }),
  } as unknown as OpenCodeClient;

  const status = new OpenCodeCrewStatus(client, () => "/captain");

  const input: CheckoutDiffInput = {
    member: "worker",
    project: null,
    mode: "branch",
    request: { kind: "list", start: 0 },
  };

  expect(await status.checkoutDiff(input, signal)).toBeUndefined();
  // Within the minute, the plugin is not asked again.
  expect(await status.checkoutDiff(input, signal)).toBeUndefined();
  expect(requests).toEqual([{ input, directory: "/captain" }]);

  const later = new OpenCodeCrewStatus(client, () => "/captain");
  expect(await later.checkoutDiff(input, signal)).toEqual({ kind: "missing" });
  await expect(later.checkoutDiff(input, signal)).rejects.toThrow(
    "Crew diff unavailable; raw details withheld.",
  );
  // An answer that is not a diff is a failure, too.
  await expect(later.checkoutDiff(input, signal)).rejects.toThrow(
    "Crew diff unavailable; raw details withheld.",
  );
});
