import { expect, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeBundle } from "../scripts/preview-bundle";
import { previewStore } from "../scripts/preview-store";

const script = "scripts/officer-previews.ts";

test("an officer can publish, replace and withdraw only its own static mockup", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "sg-preview-")));
  const sockets = join(root, "sockets");
  const storage = join(root, "data");
  const staging = join(root, "mockups");
  const demo = join(staging, "demo");
  const index = join(demo, "index.html");
  const live = join(storage, "public", "p");
  const baseUrl = "https://previews.example.com/";

  await mkdir(demo, { recursive: true });

  for (const captain of ["atlas", "vega"]) {
    await mkdir(join(sockets, captain), { recursive: true });
  }

  const broker = Bun.spawn(
    [
      process.execPath,
      script,
      "broker",
      storage,
      sockets,
      baseUrl,
      "atlas",
      "vega",
    ],
    {
      stdout: "ignore",
      stderr: "inherit",
    },
  );

  const call = (captain: string, message: unknown) =>
    fetch("http://preview.local/", {
      method: "POST",
      unix: join(sockets, captain, "publish.sock"),
      body: JSON.stringify(message),
    });

  async function mcp(tool: string, name: string) {
    const input = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: tool, arguments: { name } },
    });

    const child = Bun.spawn(
      [
        process.execPath,
        script,
        "mcp",
        join(sockets, "atlas", "publish.sock"),
        staging,
      ],
      {
        stdin: new Blob([`${input}\n`]),
        stdout: "pipe",
        stderr: "inherit",
      },
    );

    const reply = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);

    return reply;
  }

  try {
    let ready: Response | undefined;

    for (let attempt = 0; attempt < 100 && !ready; attempt += 1) {
      ready = await call("atlas", { action: "unpublish", name: "ready" }).catch(
        () => undefined,
      );

      if (!ready) {
        await Bun.sleep(20);
      }
    }

    expect(ready?.status).toBe(200);
    await writeFile(index, "<h1>First version</h1>");
    await writeFile(join(demo, "robots.txt"), "User-agent: *");
    await writeFile(join(demo, "site.webmanifest"), "{}");

    await writeFile(join(demo, "bundle.js.map"), "private source");

    const first = await mcp("publish", "demo");
    expect(first).toContain(`${baseUrl}p/atlas/demo/`);
    expect(first).toContain("expiresAt");

    await expect(
      readFile(join(live, "atlas", "demo", "bundle.js.map")),
    ).rejects.toThrow();
    expect(
      await readFile(join(live, "atlas", "demo", "index.html"), "utf8"),
    ).toContain("First version");

    await writeFile(index, "<h1>Revised</h1>");
    expect(await mcp("publish", "demo")).toContain(`${baseUrl}p/atlas/demo/`);
    expect(
      await readFile(join(live, "atlas", "demo", "index.html"), "utf8"),
    ).toContain("Revised");

    const other = await call("vega", { action: "unpublish", name: "demo" });
    expect(other.status).toBe(200);
    expect(
      await readFile(join(live, "atlas", "demo", "index.html"), "utf8"),
    ).toContain("Revised");

    await symlink(index, join(demo, "linked.html"));
    expect(await mcp("publish", "demo")).toContain(
      "regular files and directories only",
    );
    expect(await mcp("publish", "../demo")).toContain(
      "lower-case preview name",
    );
    expect(await mcp("unpublish", "demo")).toContain("unpublished");
    await expect(
      readFile(join(live, "atlas", "demo", "index.html")),
    ).rejects.toThrow();
  } finally {
    broker.kill();
    await broker.exited;
    await rm(root, { recursive: true, force: true });
  }
});

test("the publisher validates contributed paths and retires expired links", async () => {
  const data = Buffer.from("<h1>Demo</h1>").toString("base64");

  for (const path of [
    "../index.html",
    "/index.html",
    ".env/index.html",
    "secret.env",
    "dir\\index.html",
  ]) {
    expect(() => decodeBundle([{ path, base64: data }])).toThrow();
  }

  expect(() => decodeBundle([{ path: "index.html", base64: "??" }])).toThrow();

  const root = await mkdtemp(join(tmpdir(), "sg-store-"));

  try {
    const store = previewStore(root, "http://127.0.0.1:8090/");

    const receipt = store.publish(
      "atlas",
      "demo",
      decodeBundle([{ path: "index.html", base64: data }]),
    );

    const content = join(root, "public", "p", "atlas", "demo", "index.html");
    expect(await readFile(content, "utf8")).toContain("Demo");
    store.collect(Date.parse(receipt.expiresAt) + 1);
    await expect(readFile(content)).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
