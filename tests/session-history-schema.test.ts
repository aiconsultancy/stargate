import { describe, expect, test } from "bun:test";
import { OpenCode } from "@opencode/client";
import { Effect, Exit, Predicate, Schema } from "effect";
import { OpenCodeHistory } from "../src/backends/opencode/opencode-history";
import { CrewReporting } from "../src/crew/reporting/report-rpc";
import {
  HISTORY_PAGE,
  HISTORY_PARTS,
  HISTORY_TEXT,
  historyChildrenInputSchema,
  historyPartSchema,
  historySessionSchema,
  historySessionsSchema,
} from "../src/shared/session-history";

type HistoryMethod = Extract<
  keyof typeof CrewReporting.methods,
  `history${string}`
>;

const historyMethods: readonly string[] = [
  "historyRoots",
  "historyDescribe",
  "historyChildren",
  "historyEntries",
] satisfies HistoryMethod[];

const isHistoryMethod = (name: string | undefined): name is HistoryMethod =>
  name !== undefined && historyMethods.includes(name);

// Installed OpenCode 2.3 core Rpc.call decodes Effect input and encodes Effect
// Output with default parse options. Standard Schema adapters are not used.
const codecs: Record<
  HistoryMethod,
  {
    input: Schema.Codec<unknown, unknown>;
    output: Schema.Codec<unknown, unknown>;
  }
> = CrewReporting.methods;

/**
 * The installed OpenCode client against an in-process RPC endpoint. `raw`
 * skips server output validation, so only the client can reject a response.
 */
function native(handler: (input: unknown) => unknown, raw = false) {
  const received: unknown[] = [];

  const fetch = async (url: URL | RequestInfo, init?: RequestInit) => {
    const request = new Request(url, init);
    const name = new URL(request.url).pathname.split("/").at(-1);

    if (!isHistoryMethod(name)) return new Response(null, { status: 404 });
    const method = codecs[name];
    const body: unknown = await request.json();

    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const input = yield* Schema.decodeUnknownEffect(method.input)(
          Predicate.hasProperty(body, "input") ? body.input : undefined,
        );

        received.push(input);
        const output = handler(input);

        return raw
          ? output
          : yield* Schema.encodeUnknownEffect(method.output)(output);
      }),
    );

    return exit._tag === "Success"
      ? Response.json({ output: exit.value })
      : Response.json(
          { _tag: "RpcError", type: "rpc.invalid_input", message: "Invalid" },
          { status: 400 },
        );
  };

  const client = OpenCode.make({
    baseUrl: "http://opencode.invalid",
    fetch: Object.assign(fetch, { preconnect: globalThis.fetch.preconnect }),
  });

  const rpc = client.rpc(CrewReporting);
  const options = { location: { directory: "/captain" } };

  const run = async (name: HistoryMethod, input: unknown) => {
    try {
      // Invalid inputs must reach the endpoint; bypass the typed signature.
      const result: Promise<unknown> = Reflect.apply(rpc[name], rpc, [
        input,
        options,
      ]);

      return { ok: true, value: await result };
    } catch {
      return { ok: false };
    }
  };

  return { client, received, run };
}

const emoji = (count: number) => "😀".repeat(count);
const session = { id: "s", harness: "pi-durable", kind: "conversation" };
const text = (value: string) => ({ type: "text", text: value });

const page = (...parts: unknown[]) => ({
  entries: [{ id: "e", role: "assistant", parts }],
});

describe("history RPC input decoding", () => {
  test("children and entries apply defaults and keep optional keys absent", async () => {
    const f = native((input) =>
      Predicate.hasProperty(input, "parentID")
        ? { sessions: [] }
        : { entries: [] },
    );

    expect(await f.run("historyChildren", { parentID: "a" })).toEqual({
      ok: true,
      value: { sessions: [] },
    });
    expect(
      await f.run("historyChildren", {
        parentID: emoji(512),
        cursor: emoji(4096),
        limit: HISTORY_PAGE,
      }),
    ).toMatchObject({ ok: true });
    expect(await f.run("historyEntries", { sessionID: "a" })).toMatchObject({
      ok: true,
    });
    expect(
      await f.run("historyEntries", {
        sessionID: "a",
        limit: 1,
        order: "asc",
        detail: "full",
      }),
    ).toMatchObject({ ok: true });
    expect(f.received).toStrictEqual([
      { parentID: "a", limit: 50 },
      { parentID: emoji(512), cursor: emoji(4096), limit: 50 },
      { sessionID: "a", limit: 30, order: "desc", detail: "summary" },
      { sessionID: "a", limit: 1, order: "asc", detail: "full" },
    ]);
  });

  test("invalid, out-of-bound and unknown inputs reject before handlers", async () => {
    const f = native(() => {
      throw new Error("Handler must not run");
    });

    const cases: [HistoryMethod, unknown][] = [
      ["historyRoots", { extra: true }],
      ["historyRoots", null],
      ["historyRoots", []],
      ["historyRoots", "roots"],
      ["historyRoots", 1],
      ["historyDescribe", { ids: [] }],
      ["historyDescribe", { ids: Array(HISTORY_PAGE + 1).fill("a") }],
      ["historyDescribe", { ids: [""] }],
      ["historyDescribe", { ids: [emoji(513)] }],
      ["historyDescribe", { ids: ["a"], extra: true }],
      ["historyChildren", { parentID: "" }],
      ["historyChildren", { parentID: "a", cursor: "" }],
      ["historyChildren", { parentID: "a", cursor: emoji(4097) }],
      ["historyChildren", { parentID: "a", extra: true }],
      ["historyChildren", []],
      ...[0, HISTORY_PAGE + 1, 1.5, "2", null].map(
        (limit): [HistoryMethod, unknown] => [
          "historyChildren",
          { parentID: "a", limit },
        ],
      ),
      ["historyEntries", { sessionID: "a", order: "up" }],
      ["historyEntries", { sessionID: "a", detail: "raw" }],
      ["historyEntries", { sessionID: "a", limit: 2 ** 53 }],
      ["historyEntries", { sessionID: "a", extra: true }],
    ];

    for (const [name, input] of cases)
      expect(await f.run(name, input), JSON.stringify(input)).toEqual({
        ok: false,
      });
    expect(f.received).toEqual([]);
  });

  test("empty roots input is an exact object", async () => {
    const f = native(() => ({ sessions: [session] }));
    expect(await f.run("historyRoots", {})).toEqual({
      ok: true,
      value: { sessions: [session] },
    });
    expect(f.received).toEqual([{}]);
  });
});

describe("history RPC output validation", () => {
  const accepted: unknown[] = [
    { sessions: [] },
    {
      sessions: [
        {
          id: emoji(512),
          harness: "opencode",
          kind: "crew",
          member: emoji(64),
          parentID: "p",
          title: emoji(300),
          agent: emoji(200),
          model: emoji(200),
          createdAt: 0,
          updatedAt: Number.MAX_SAFE_INTEGER,
        },
      ],
    },
    { sessions: Array(HISTORY_PAGE).fill(session) },
  ];

  const rejected: unknown[] = [
    { sessions: [], extra: true },
    { sessions: [{ ...session, extra: true }] },
    { sessions: [{ ...session, member: emoji(65) }] },
    { sessions: [{ ...session, member: null }] },
    { sessions: [{ ...session, harness: "claude" }] },
    { sessions: [{ ...session, createdAt: -1 }] },
    { sessions: [{ ...session, createdAt: 1.5 }] },
    { sessions: [{ ...session, updatedAt: 2 ** 53 }] },
    { sessions: Array(HISTORY_PAGE + 1).fill(session) },
  ];

  test("session lists keep strict nested sessions and bounds", async () => {
    for (const output of accepted) {
      const f = native(() => output);
      expect(await f.run("historyRoots", {})).toEqual({
        ok: true,
        value: output,
      });
    }

    for (const output of rejected) {
      const f = native(() => output);
      expect(
        await f.run("historyDescribe", { ids: ["a"] }),
        JSON.stringify(output).slice(0, 200),
      ).toEqual({ ok: false });
    }
  });

  test("entry pages keep strict union branches, bounds and truncation flags", async () => {
    const valid = [
      page(
        text(emoji(HISTORY_TEXT)),
        { type: "text", text: "cut", truncated: true },
        { type: "reasoning" },
        { type: "reasoning", text: "r", truncated: true },
        {
          type: "tool",
          name: "shell",
          status: "error",
          input: "i",
          output: "o",
          truncated: true,
          sessionID: "child",
        },
        { type: "notice", label: emoji(300) },
      ),
      {
        entries: [
          {
            id: "e",
            role: "tool",
            createdAt: 1,
            model: "m",
            parts: Array(HISTORY_PARTS).fill(text("x")),
            omittedParts: 1,
          },
        ],
        cursor: "next",
      },
      { entries: Array(HISTORY_PAGE).fill(page().entries[0]) },
    ];

    for (const output of valid) {
      const f = native(() => output);
      expect(await f.run("historyEntries", { sessionID: "a" })).toEqual({
        ok: true,
        value: output,
      });
    }

    const invalid = [
      page(text(emoji(HISTORY_TEXT + 1))),
      page({ ...text("x"), extra: true }),
      page({ type: "notice", label: "n", text: "x" }),
      page({ type: "tool", name: "t", sessionID: "" }),
      page({ type: "tool", name: "t", status: "streaming" }),
      page({ type: "text", text: "x", truncated: false }),
      page({ type: "image" }),
      page(...Array(HISTORY_PARTS + 1).fill(text("x"))),
      { entries: [{ ...page().entries[0], omittedParts: 0 }] },
      { entries: [{ ...page().entries[0], role: "agent" }] },
      { entries: [{ ...page().entries[0], extra: true }] },
      { entries: Array(HISTORY_PAGE + 1).fill(page().entries[0]) },
      { entries: [], cursor: "" },
    ];

    for (const output of invalid) {
      const f = native(() => output);
      expect(
        await f.run("historyEntries", { sessionID: "a" }),
        JSON.stringify(output).slice(0, 200),
      ).toEqual({ ok: false });
    }
  });
});

describe("OpenCode history through the native RPC client", () => {
  const failure =
    "Session history unavailable or cancelled; raw details withheld.";

  const history = (output: unknown) =>
    new OpenCodeHistory(native(() => output, true).client, "/captain");

  const signal = new AbortController().signal;

  test("valid Pi pages pass and unknown nested keys fail closed", async () => {
    expect<unknown>(
      await history({ sessions: [session] }).roots(signal),
    ).toEqual([session]);
    const entries = page(text("visible"));
    expect<unknown>(
      await history(entries).entries(
        { sessionID: "pi:s", limit: 1, order: "desc", detail: "summary" },
        signal,
      ),
    ).toEqual(entries);
    await expect(
      history({ sessions: [{ ...session, extra: 1 }] }).roots(signal),
    ).rejects.toThrow(failure);
    await expect(
      history({ sessions: [], cursor: "c", extra: 1 }).children(
        { parentID: "pi:s", limit: 1 },
        signal,
      ),
    ).rejects.toThrow(failure);
    await expect(
      history(page({ ...text("x"), extra: 1 })).entries(
        { sessionID: "pi:s", limit: 1, order: "desc", detail: "summary" },
        signal,
      ),
    ).rejects.toThrow(failure);
  });
});

describe("exported history decoders", () => {
  // Zod 4 strict objects enumerate keys with for...in: inherited enumerable
  // Keys are unknown, while inherited declared fields still decode.
  const inherit = (prototype: object, own: object): unknown =>
    Object.assign(Object.create(prototype), own);

  const decode = (schema: Schema.Codec<unknown, unknown>, value: unknown) => {
    const exit = Schema.decodeUnknownExit(schema)(value);

    return Exit.isSuccess(exit)
      ? { ok: true, value: exit.value }
      : { ok: false };
  };

  const roots = CrewReporting.methods.historyRoots.input;

  test("inherited unknown keys reject at every strict object", () => {
    for (const [schema, value] of [
      [historySessionSchema, inherit({ extra: 1 }, session)],
      [historySessionsSchema, { sessions: [inherit({ extra: 1 }, session)] }],
      [historyPartSchema, inherit({ extra: 1 }, text("x"))],
      [historyChildrenInputSchema, inherit({ extra: 1 }, { parentID: "a" })],
      [roots, Object.create({ extra: 1 })],
    ] satisfies [Schema.Codec<unknown, unknown>, unknown][])
      expect(decode(schema, value)).toEqual({ ok: false });
  });

  test("inherited declared fields and empty prototypes decode as own values", () => {
    expect(
      decode(
        historySessionSchema,
        inherit(
          { id: session.id },
          { harness: session.harness, kind: session.kind },
        ),
      ),
    ).toStrictEqual({ ok: true, value: session });
    expect(
      decode(
        historyChildrenInputSchema,
        inherit({ limit: 2 }, { parentID: "a" }),
      ),
    ).toStrictEqual({ ok: true, value: { parentID: "a", limit: 2 } });

    for (const value of [
      Object.create(null),
      Object.defineProperty({}, "hidden", { value: 1 }),
      { [Symbol("own")]: 1 },
    ])
      expect(decode(roots, value)).toMatchObject({ ok: true });
  });
});
