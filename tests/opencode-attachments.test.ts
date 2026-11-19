import { expect, test } from "bun:test";
import { Schema } from "effect";
import { z } from "zod";
import { OpenCodeBackend } from "../src/backends/opencode";
import { backendSchema } from "../src/config";

test("attachment eval: OpenCode receives image and document bytes through native inline files", async () => {
  const payload = z.object({
    id: z.string(),
    text: z.string(),
    files: z.array(
      z.object({
        name: z.string(),
        uri: z.string(),
        source: z.object({ type: z.literal("inline") }),
      }),
    ),
  });
  const received: z.infer<typeof payload>[] = [];
  let input = "";
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/prompt")) {
        const body = payload.parse(await request.json());
        received.push(body);
        input = body.id;
        return Response.json({ data: { id: input } });
      }
      if (url.pathname.endsWith("/wait"))
        return new Response(null, { status: 204 });
      if (url.pathname.endsWith("/message"))
        return Response.json({
          data: [
            {
              id: "answer",
              type: "assistant",
              time: { created: 2, completed: 3 },
              content: [{ type: "text", text: "Read the attached files" }],
            },
            { id: input, type: "user", time: { created: 1 }, text: "" },
          ],
          cursor: {},
        });
      return new Response(null, { status: 404 });
    },
  });
  try {
    const config = Schema.decodeUnknownSync(backendSchema)({
      type: "opencode",
      url: server.url.href,
      directory: "/workspace",
    });
    if (config.type !== "opencode") throw new Error("Invalid fixture");
    const backend = new OpenCodeBackend(config);
    const files = [
      {
        name: "screen.png",
        mime: "image/png",
        data: new Uint8Array([137, 80, 78, 71]),
      },
      {
        name: "proof.pdf",
        mime: "application/pdf",
        data: new TextEncoder().encode("%PDF-1.7\nfixture"),
      },
    ];
    const signal = new AbortController().signal;
    expect(
      await backend.prompt(
        "session-current",
        "",
        signal,
        undefined,
        undefined,
        files,
      ),
    ).toBe("Read the attached files");
    expect(received).toHaveLength(1);
    expect(received[0]?.files).toEqual(
      files.map((file) => ({
        name: file.name,
        uri: `data:${file.mime};base64,${Buffer.from(file.data).toString("base64")}`,
        source: { type: "inline" },
      })),
    );
    await expect(
      backend.prompt("session-current", "", signal, undefined, undefined, [
        { name: "bad.png", mime: "image/png", data: new Uint8Array() },
      ]),
    ).rejects.toThrow();
    expect(received).toHaveLength(1);
  } finally {
    await server.stop(true);
  }
});
