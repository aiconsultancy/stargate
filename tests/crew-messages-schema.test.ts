import { expect, test } from "bun:test";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import { OpenCode } from "@opencode/client";
import { Result, Schema } from "effect";
import {
  type ActivitySnapshot,
  activitySnapshotSchema,
} from "../src/chat/activity/activity";
import { OpenCodeBackend } from "../src/backends/opencode/opencode";
import { backendSchema } from "../src/config";
import {
  historyInputBranches,
  historyInputSchema,
} from "../src/coordination/crew/history/history";
import {
  CrewIrc,
  outboxPageSchema,
} from "../src/coordination/crew/messaging/irc-rpc";
import { messageOpenCodeInput } from "../src/coordination/crew/messaging/message-tool-input";
import {
  dmInputSchema,
  mailInputBranches,
  mailInputSchema,
} from "../src/coordination/crew/messaging/messaging";
import { piCrewExtension } from "../src/coordination/crew/pi/pi-extension";
import { CrewReporting } from "../src/coordination/crew/reporting/report-rpc";
import { journalInputSchema } from "../src/coordination/crew/reporting/journal";
import { crewTaskTextLimit } from "../src/shared/crew-status";
import { waitingInputSchema } from "../src/coordination/crew/controls/waiting";
import { crewLink } from "../src/transports/irc/crew-link";
import { settingsIssues } from "../src/config/settings-schema";

test("mail and DM keep trim, code-point bounds, defaults and meaningful paths", async () => {
  const send = { op: "send", to: "captain", text: " 😀 " } as const;
  expect(Schema.decodeUnknownSync(mailInputSchema)(send)).toEqual({
    ...send,
    text: "😀",
  });
  expect(Schema.decodeUnknownSync(dmInputSchema)(send)).toEqual({
    ...send,
    text: "😀",
    delivery: "steer",
  });
  expect(Schema.decodeUnknownSync(mailInputSchema)({ op: "inbox" })).toEqual({
    op: "inbox",
    limit: 20,
  });
  const text = "😀".repeat(crewTaskTextLimit);
  expect(
    Schema.decodeUnknownSync(mailInputSchema)({ ...send, text: ` ${text} ` }),
  ).toHaveProperty("text", text);

  for (const raw of [
    { ...send, text: `${text}x` },
    { ...send, text: "  " },
    { ...send, replyTo: "a".repeat(64) },
    { ...send, delivery: "steer" },
    { op: "inbox", after: Number.MAX_SAFE_INTEGER + 1 },
    { op: "inbox", limit: null },
  ]) {
    expect(
      Result.isFailure(Schema.decodeUnknownResult(mailInputSchema)(raw)),
    ).toBe(true);
  }

  const missing = await messageOpenCodeInput(mailInputBranches)[
    "~standard"
  ].validate({ op: "send", text: "note" });

  expect(missing).toHaveProperty("issues");

  if (!missing.issues) {
    throw new Error("Missing recipient accepted");
  }

  expect(missing.issues).toContainEqual(
    expect.objectContaining({ path: ["to"] }),
  );
});

test("journal entries accept the crew text limit in code points", () => {
  const decode = Schema.decodeUnknownSync(journalInputSchema);
  const text = "😀".repeat(crewTaskTextLimit);
  expect(decode({ op: "append", text: ` ${text} ` })).toEqual({
    op: "append",
    text,
  });
  expect(() => decode({ op: "append", text: `${text}x` })).toThrow();
});

test("OpenCode DM decodes defaults; mail/history flatten fields without top-level defaults", async () => {
  const dm = messageOpenCodeInput(dmInputSchema)["~standard"];
  expect(dm.jsonSchema.input({ target: "draft-2020-12" })).toHaveProperty(
    "required",
    ["op", "to", "text", "delivery"],
  );

  const input = {
    project: "stargate",
    text: " note ",
    to: "captain",
    op: "send",
  };

  expect(await dm.validate(input)).toEqual({
    value: {
      op: "send",
      to: "captain",
      text: "note",
      delivery: "steer",
      project: "stargate",
    },
  });
  expect(JSON.stringify(await dm.validate(input))).toBe(
    '{"value":{"op":"send","to":"captain","text":"note","delivery":"steer","project":"stargate"}}',
  );
  const mail = messageOpenCodeInput(mailInputBranches)["~standard"];
  expect(await mail.validate({ op: "inbox", project: "stargate" })).toEqual({
    value: { op: "inbox", project: "stargate" },
  });
  expect(await mail.validate(input)).toEqual({
    value: { op: "send", to: "captain", text: "note", project: "stargate" },
  });
  expect(await mail.validate({ op: "inbox", after: undefined })).toEqual({
    value: { op: "inbox", after: undefined },
  });
  expect(
    await mail.validate({ op: "inbox", text: "other branch" }),
  ).toHaveProperty("issues");
  const history = messageOpenCodeInput(historyInputBranches)["~standard"];
  expect(
    await history.validate({ op: "messages", sessionID: "session" }),
  ).toEqual({ value: { op: "messages", sessionID: "session" } });
  const query = " literal ";
  expect(
    Schema.decodeUnknownSync(historyInputSchema)({ op: "search", query }),
  ).toEqual({ op: "search", query, limit: 20 });
  expect(await history.validate({ op: "search", query })).toEqual({
    value: { op: "search", query },
  });

  for (const schema of [mail, dm, history]) {
    expect(schema.jsonSchema.input({ target: "draft-2020-12" })).toHaveProperty(
      "type",
      "object",
    );
    expect(schema.jsonSchema.input({ target: "draft-07" })).toHaveProperty(
      "additionalProperties",
      false,
    );
  }
});

test("OpenCode mail/history retain discriminator paths without losing project diagnostics", async () => {
  for (const branches of [mailInputBranches, historyInputBranches]) {
    const schema = messageOpenCodeInput(branches)["~standard"];

    for (const input of [
      {},
      { op: undefined },
      { op: null },
      { op: 5 },
      { op: "unknown" },
    ]) {
      const parsed = await schema.validate(input);

      if (!parsed.issues) {
        throw new Error("Invalid operation accepted");
      }

      expect(parsed.issues).toContainEqual(
        expect.objectContaining({ path: ["op"] }),
      );
    }

    const parsed = await schema.validate({ op: "unknown", project: "/bad" });

    if (!parsed.issues) {
      throw new Error("Invalid project and operation accepted");
    }

    expect(parsed.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: ["op"] }),
        expect.objectContaining({ path: ["project"] }),
      ]),
    );
  }
});

test("Pi mail/DM advertise explicit operations and preserve required-default coercion", () => {
  const extension = piCrewExtension(
    { authorize() {}, async run() {} },
    async () => ({}),
  );

  for (const name of ["stargate_mail", "stargate_dm"]) {
    const tool = extension.tools?.find((tool) => tool.name === name);

    if (!tool) {
      throw new Error(`Missing tool ${name}`);
    }

    expect(tool.replay).toBe("unsafe");

    const parse = (
      args: Parameters<typeof validateToolArguments>[1]["arguments"],
    ): unknown =>
      validateToolArguments(tool, {
        type: "toolCall",
        id: "fixture",
        name,
        arguments: args,
      });

    if (name === "stargate_mail") {
      expect(tool.parameters).toHaveProperty("oneOf");
      expect(() => parse({ op: "inbox" })).toThrow();
      expect(parse({ op: "inbox", limit: "2", after: true })).toEqual({
        op: "inbox",
        limit: 2,
        after: 1,
      });
      expect(parse({ op: "send", to: "captain", text: " note " })).toEqual({
        op: "send",
        to: "captain",
        text: " note ",
      });
    } else {
      expect(tool.parameters).toHaveProperty("type", "object");
      expect(() =>
        parse({ op: "send", to: "captain", text: "note" }),
      ).toThrow();
      expect(
        parse({ op: "send", to: "captain", text: " note ", delivery: "steer" }),
      ).toEqual({
        op: "send",
        to: "captain",
        text: " note ",
        delivery: "steer",
      });
    }

    expect(() => parse({ op: "append", text: "not journal" })).toThrow();
  }
});

const item = {
  sequence: 1,
  id: "a".repeat(32),
  from: { role: "captain", id: "captain" },
  to: { role: "crew", id: "worker" },
  text: " note ",
  created: 0,
} satisfies (typeof outboxPageSchema.Type.items)[number];

const outbox = { items: [item], latest: 1 };

const snapshot = {
  id: "capture",
  revision: 0,
  status: "collecting",
  reporter: "Twiki",
  summary: "",
  entries: [{ id: 0, member: "captain", kind: "note", text: "note" }],
  truncated: false,
} satisfies ActivitySnapshot;

test("native RPC codecs retain strict input/output encoding and structured mutable arrays", async () => {
  for (const [schema, value, invalid] of [
    [
      outboxPageSchema,
      outbox,
      { ...outbox, items: [{ ...item, from: { ...item.from, extra: true } }] },
    ],
    [
      activitySnapshotSchema,
      snapshot,
      { ...snapshot, entries: [{ ...snapshot.entries[0], extra: true }] },
    ],
  ] as const) {
    expect(Schema.decodeUnknownSync(schema)(value)).toEqual(value);
    expect(Schema.encodeUnknownSync(schema)(value)).toEqual(value);

    for (const result of [
      Schema.decodeUnknownResult(schema)(invalid),
      Schema.encodeUnknownResult(schema)(invalid),
    ]) {
      if (Result.isSuccess(result)) {
        throw new Error("Nested extras accepted");
      }

      expect(
        settingsIssues(result.failure.issue).issues.some(
          (issue) => (issue.path?.length ?? 0) > 0,
        ),
      ).toBe(true);
    }
  }

  for (const method of [
    ...Object.values(CrewIrc.methods),
    CrewReporting.methods.start,
    CrewReporting.methods.read,
    CrewReporting.methods.finish,
    CrewReporting.methods.cancel,
  ]) {
    expect(Schema.isSchema(method.input)).toBe(true);
    expect(Schema.isSchema(method.output)).toBe(true);
  }

  expect(
    await CrewIrc.methods.bind.input["~standard"].validate({
      sessionID: "ses_fixture",
      crewID: "worker",
      extra: true,
    }),
  ).toHaveProperty("issues");
  expect(
    await CrewReporting.methods.read.input["~standard"].validate({
      sessionID: "captain",
      id: "capture",
      passive: undefined,
    }),
  ).toEqual({
    value: { sessionID: "captain", id: "capture", passive: undefined },
  });

  const entries = Schema.decodeUnknownSync(activitySnapshotSchema)(
    snapshot,
  ).entries;

  entries.push({ id: 1, member: "captain", kind: "note", text: "next" });
  expect(entries).toHaveLength(2);
});

test("installed Promise RPC preserves structured values; actual consumers reject malformed outputs", async () => {
  let invalid = false;
  const requests: string[] = [];

  const inputs = new Map<string, Schema.Codec<unknown, unknown>>([
    ["bind", CrewIrc.methods.bind.input],
    ["outbox", CrewIrc.methods.outbox.input],
    ["start", CrewReporting.methods.start.input],
    ["read", CrewReporting.methods.read.input],
    ["finish", CrewReporting.methods.finish.input],
    ["cancel", CrewReporting.methods.cancel.input],
  ]);

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      requests.push(path);
      expect(request.headers.get("authorization")).toBe("Bearer fixture-only");
      expect(new URL(request.url).searchParams.get("location[directory]")).toBe(
        "/captain",
      );
      const body = await request.json();
      expect(body).toHaveProperty("input");
      const codec = inputs.get(path.split("/").at(-1) ?? "");

      if (!codec) {
        throw new Error("Unexpected local fixture method");
      }

      // Installed registration decodes recognized native codecs with defaults.
      // Return controlled errors; never leak a decoder exception through Bun.
      const decoded = Schema.decodeUnknownResult(codec)(body.input);

      if (Result.isFailure(decoded)) {
        return new Response("Invalid RPC input", { status: 400 });
      }

      const output = path.endsWith("/bind")
        ? { bound: true }
        : path.endsWith("/outbox")
          ? outbox
          : path.endsWith("/cancel")
            ? true
            : snapshot;

      return Response.json({
        output:
          invalid && path.endsWith("/outbox")
            ? {
                ...outbox,
                items: [{ ...item, from: { ...item.from, extra: true } }],
              }
            : invalid && path.endsWith("/read")
              ? {
                  ...snapshot,
                  entries: [{ ...snapshot.entries[0], extra: true }],
                }
              : output,
      });
    },
  });

  try {
    const client = OpenCode.make({
      baseUrl: server.url.href,
      headers: { authorization: "Bearer fixture-only" },
    });

    const options = {
      location: { directory: "/captain" },
      signal: new AbortController().signal,
    };

    const irc = client.rpc(CrewIrc);
    expect(
      await irc.bind({ sessionID: "ses_fixture", crewID: "worker" }, options),
    ).toEqual({ bound: true });
    expect(await irc.outbox({ after: 0, limit: 1 }, options)).toEqual(outbox);
    const reporting = client.rpc(CrewReporting);
    expect(
      await reporting.start(
        { sessionID: "captain", requestID: "request" },
        options,
      ),
    ).toEqual(snapshot);
    expect(
      await reporting.read({ sessionID: "captain", id: "capture" }, options),
    ).toEqual(snapshot);
    expect(
      await reporting.finish({ sessionID: "captain", id: "capture" }, options),
    ).toEqual(snapshot);
    expect(
      await reporting.cancel({ sessionID: "captain", id: "capture" }, options),
    ).toBe(true);
    await expect(
      irc.bind(
        Object.assign(
          { sessionID: "ses_fixture", crewID: "worker" },
          { extra: true },
        ),
        options,
      ),
    ).rejects.toBeDefined();
    await expect(
      reporting.read(
        Object.assign({ sessionID: "captain", id: "capture" }, { extra: true }),
        options,
      ),
    ).rejects.toBeDefined();
    invalid = true;

    const config = Schema.decodeUnknownSync(backendSchema)({
      type: "opencode",
      url: server.url.href,
      directory: "/captain",
      headersEnv: { authorization: "STARGATE_MESSAGES_TEST_AUTH" },
    });

    if (config.type !== "opencode") {
      throw new Error("Invalid fixture configuration");
    }

    const env = { STARGATE_MESSAGES_TEST_AUTH: "Bearer fixture-only" };
    const link = crewLink(config, env);

    if (!link) {
      throw new Error("Missing IRC link");
    }

    await expect(link.outbox({ limit: 1 }, options.signal)).rejects.toThrow(
      "Crew stargate_dm outbox unavailable",
    );
    const previous = process.env["STARGATE_MESSAGES_TEST_AUTH"];
    process.env["STARGATE_MESSAGES_TEST_AUTH"] = "Bearer fixture-only";

    try {
      const backend = new OpenCodeBackend(config);
      await expect(
        backend.resumeActivity("captain", "capture").read(options.signal),
      ).rejects.toBeDefined();
    } finally {
      if (previous === undefined) {
        delete process.env["STARGATE_MESSAGES_TEST_AUTH"];
      } else {
        process.env["STARGATE_MESSAGES_TEST_AUTH"] = previous;
      }
    }

    expect(requests).toHaveLength(10);
  } finally {
    await server.stop(true);
  }
});

test("waiting separates immediate zero, off and the integer ceiling", () => {
  for (const seconds of [0, 3600, "off"] as const) {
    expect(Schema.decodeUnknownSync(waitingInputSchema)({ seconds })).toEqual({
      seconds,
    });
  }

  for (const seconds of [-1, 3601, 1.5, null, false, "0"]) {
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(waitingInputSchema)({ seconds }),
      ),
    ).toBe(true);
  }

  expect(
    Result.isFailure(
      Schema.decodeUnknownResult(waitingInputSchema)({
        seconds: 0,
        extra: true,
      }),
    ),
  ).toBe(true);
});
