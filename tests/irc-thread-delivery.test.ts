import { expect, test } from "bun:test";
import pino from "pino";
import { IrcClient } from "../src/transports/irc/client";
import { IrcDelivery } from "../src/transports/irc/delivery";
import { Filehost } from "../src/transports/irc/filehost";
import { openStore } from "../src/app/open-store";

class Wire extends IrcClient {
  tags = true;
  limits: { maxBytes: number; maxLines: number } | undefined;
  lines: { text: string; tags: Record<string, string> }[] = [];
  batches: { text: string; tags: Record<string, string> }[] = [];
  reactions: Record<string, string>[] = [];
  failAfter = Infinity;
  constructor() {
    super({
      host: "127.0.0.1",
      port: 6667,
      tls: false,
      account: "bot",
      password: "fixture",
      nick: "bot",
      channels: ["#ship"],
      log: pino({ level: "silent" }),
    });
  }
  override async waitReady() {}
  override hasCap(name: string) {
    return name === "message-tags" && this.tags;
  }
  override get multiline() {
    return this.limits;
  }
  override budget() {
    return 100;
  }
  override async privmsg(
    _target: string,
    text: string,
    tags: Record<string, string> = {},
  ) {
    if (this.lines.length + this.batches.length >= this.failAfter)
      throw new Error("refused");
    this.lines.push({ text, tags });
  }
  override async sendBatch(
    _target: string,
    lines: readonly { text: string; concat: boolean }[],
    tags: Record<string, string> = {},
  ) {
    if (this.lines.length + this.batches.length >= this.failAfter)
      throw new Error("refused");
    this.batches.push({
      text: lines.map((line) => line.text).join("\n"),
      tags,
    });
  }
  override async tagmsg(_target: string, tags: Record<string, string>) {
    this.reactions.push(tags);
  }
}

test("IRC delivery retains the root on every retry unit, including unbatched plans", async () => {
  const wire = new Wire();
  wire.limits = { maxBytes: 4096, maxLines: 2 };
  const store = openStore(":memory:");

  try {
    const progress = {
      plan: (unit: { job: number; part: number }, plan: string) =>
        store.deliveryPlan(unit.job, unit.part, plan),
      replan: (unit: { job: number; part: number }, plan: string) =>
        store.replaceDeliveryPlan(unit.job, unit.part, plan),
      done: (unit: { job: number; part: number }, done: number) =>
        store.deliveredUnits(unit.job, unit.part, done),
    };

    const delivery = new IrcDelivery(
      wire,
      100,
      undefined,
      progress,
      undefined,
      () => "root",
    );

    wire.failAfter = 1;
    await expect(
      delivery.post(
        "#ship",
        "request",
        "one\ntwo\nthree\nfour\nfive",
        undefined,
        { job: 1, part: 0 },
      ),
    ).rejects.toThrow("refused");
    expect(wire.batches[0]?.tags).toEqual({ "+draft/reply": "root" });
    wire.limits = undefined;
    wire.failAfter = 2;
    await expect(
      delivery.post(
        "#ship",
        "request",
        "one\ntwo\nthree\nfour\nfive",
        undefined,
        { job: 1, part: 0 },
      ),
    ).rejects.toThrow("refused");
    wire.failAfter = Infinity;
    await delivery.post(
      "#ship",
      "request",
      "one\ntwo\nthree\nfour\nfive",
      undefined,
      { job: 1, part: 0 },
    );
    expect(wire.lines.map((line) => line.text)).toEqual([
      "three",
      "four",
      "five",
    ]);
    expect(
      wire.lines.every((line) => line.tags["+draft/reply"] === "root"),
    ).toBe(true);
    expect(store.deliveryPlan(1, 0, "ignored").done).toBe(4);
    await delivery.react?.("#ship", "request", "eyes");
    expect(wire.reactions).toEqual([
      { "+draft/reply": "request", "+draft/react": "👀" },
    ]);
  } finally {
    store.close();
  }
});

test("IRC file links use the persisted root, while main-room and capless lines stay plain", async () => {
  const wire = new Wire();
  const filehost = () => new URL("http://127.0.0.1:8000/uploads");
  const files = new Filehost(filehost, { account: "bot", password: "fixture" });

  const delivery = new IrcDelivery(
    wire,
    100,
    { files, filehost, download: true, upload: true },
    undefined,
    undefined,
    (request) => (request === "thread" ? "root" : undefined),
  );

  const link = delivery.files?.link;

  if (!link) throw new Error("missing link transport");
  await link(
    "#ship",
    "thread",
    "http://127.0.0.1:8000/file",
    "Report",
    AbortSignal.timeout(1000),
  );
  expect(wire.lines[0]?.tags).toEqual({ "+draft/reply": "root" });
  await delivery.post("#ship", "room", "one\ntwo");
  expect(wire.lines.slice(1).map((line) => line.tags)).toEqual([{}, {}]);
  wire.tags = false;
  await delivery.post("#ship", "thread", "fallback");
  expect(wire.lines.at(-1)?.tags).toEqual({});
});
