import { ConnectorClient } from "../src/transports/teams/connector";
import {
  downloadImages,
  incomingImageRefs,
} from "../src/transports/teams/inbound-images";
import { expect, test } from "bun:test";
import { crc32, deflateSync } from "node:zlib";
import type { Attachment } from "../src/chat/attachments/attachments";
import type { OutgoingActivity } from "../src/transports/teams/connector";
import {
  inspectScreenshot,
  MAX_IMAGE_BYTES,
  screenshotActivity,
  teamsImageTransport,
} from "../src/transports/teams/images";
import { TEAMS_SAFE_MESSAGE_BYTES } from "../src/transports/teams/teams";

function chunk(type: string, content: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(content.length);
  header.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([header.subarray(4), content])));

  return Buffer.concat([header, content, crc]);
}

function png(width = 1, height = 1, padding = 0, alpha = false): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = alpha ? 6 : 2;

  const parts = [
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
  ];

  if (padding) {
    parts.push(
      chunk(
        "tEXt",
        Buffer.concat([Buffer.from("note\0"), Buffer.alloc(padding, 65)]),
      ),
    );
  }

  parts.push(
    chunk(
      "IDAT",
      deflateSync(
        Buffer.alloc(
          (Math.max(width, 1) * (alpha ? 4 : 3) + 1) * Math.max(height, 1),
        ),
      ),
    ),
    chunk("IEND", Buffer.alloc(0)),
  );

  return Buffer.concat(parts);
}

const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAH/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCfAA//2Q==",
  "base64",
);

const file = (data = png(), mime = "image/png"): Attachment => ({
  name: "screenshot.png",
  mime,
  data,
});

const signal = () => new AbortController().signal;

test("screenshot inspection accepts PNG/JPEG and reports bounded dimensions", () => {
  expect(inspectScreenshot(png(12, 8))).toMatchObject({
    contentType: "image/png",
    width: 12,
    height: 8,
  });
  expect(inspectScreenshot(JPEG)).toMatchObject({
    contentType: "image/jpeg",
    width: 1,
    height: 1,
  });
  expect(inspectScreenshot(png(1024, 1)).width).toBe(1024);
});

test("screenshots reject bad signatures, damaged chunks and incomplete framing", () => {
  const damaged = png();
  damaged[18] = (damaged[18] ?? 0) ^ 1;

  for (const bytes of [
    Buffer.from("GIF89a"),
    Buffer.from("<svg></svg>"),
    damaged,
    png().subarray(0, 25),
    JPEG.subarray(0, -2),
    Buffer.concat([JPEG, Buffer.from("extra")]),
    Buffer.concat([png(), Buffer.from("extra")]),
  ]) {
    expect(() => inspectScreenshot(bytes)).toThrow();
  }

  const badChunk = png();
  badChunk[12] = (badChunk[12] ?? 0) | 0x80;
  badChunk.writeUInt32BE(crc32(badChunk.subarray(12, 29)), 29);
  expect(() => inspectScreenshot(badChunk)).toThrow("invalid chunk");
});

test("screenshots reject animated PNG, duplicate headers and missing image data", () => {
  const bytes = png();
  expect(() =>
    inspectScreenshot(
      Buffer.concat([
        bytes.subarray(0, 33),
        chunk("acTL", Buffer.alloc(8)),
        bytes.subarray(33),
      ]),
    ),
  ).toThrow("animated");
  expect(() =>
    inspectScreenshot(
      Buffer.concat([
        bytes.subarray(0, 33),
        bytes.subarray(8, 33),
        bytes.subarray(33),
      ]),
    ),
  ).toThrow("more than one header");
  expect(() =>
    inspectScreenshot(
      Buffer.concat([bytes.subarray(0, 33), chunk("IEND", Buffer.alloc(0))]),
    ),
  ).toThrow("complete image");
});

test("oversized/zero dimensions and oversized input fail before image decoding", () => {
  for (const [width, height] of [
    [0, 1],
    [1, 0],
    [1025, 1],
    [1, 1025],
  ] as const) {
    expect(() => inspectScreenshot(png(width, height))).toThrow("dimensions");
  }

  const oversized = Buffer.from(JPEG);
  const frame = oversized.indexOf(Buffer.from([0xff, 0xc0]));
  oversized.writeUInt16BE(1025, frame + 5);
  expect(() => inspectScreenshot(oversized)).toThrow("dimensions");
  expect(() => inspectScreenshot(Buffer.alloc(MAX_IMAGE_BYTES + 1))).toThrow(
    "at most",
  );
});

test("activity bounds include base64, escaped caption, UTF-16 and reply metadata", () => {
  const image = inspectScreenshot(png(1, 1, 20_000));

  const activity = screenshotActivity(
    image,
    "A screenshot",
    "original-message",
  );

  expect(activity.attachments?.[0]?.contentUrl).toBe(
    `data:image/png;base64,${image.bytes.toString("base64")}`,
  );
  expect(activity.replyToId).toBe("original-message");
  const json = JSON.stringify(activity);
  expect(
    Math.max(Buffer.byteLength(json), json.length * 2),
  ).toBeLessThanOrEqual(TEAMS_SAFE_MESSAGE_BYTES);
  expect(() => screenshotActivity(image, "\\".repeat(7000))).toThrow(
    "message budget",
  );
  expect(() =>
    screenshotActivity(inspectScreenshot(png(1, 1, 31_000))),
  ).toThrow("message budget");
  expect(() => screenshotActivity(image, "x".repeat(7001))).toThrow("caption");
  expect(() =>
    screenshotActivity(image, "caption", "reply".repeat(3000)),
  ).toThrow("message budget");
});

test("image upload is pure encoding; publication retains the exact bound channel/thread", async () => {
  const sends: {
    channel: string;
    thread: string;
    activity: OutgoingActivity;
    signal: AbortSignal;
  }[] = [];

  const adapter = teamsImageTransport(
    async (channel, thread, activity, signal, allowed) => {
      expect(allowed?.() ?? true).toBe(true);
      sends.push({ channel, thread, activity, signal });
    },
  );

  expect(adapter.publishOnce).toBe(true);
  const receipt = await adapter.upload(file(), signal());
  expect(sends).toHaveLength(0);
  const sending = signal();
  await adapter.link(
    "original-conversation",
    "original-message",
    receipt,
    "Result screenshot",
    sending,
    () => true,
  );
  expect(sends).toHaveLength(1);
  expect(sends[0]).toMatchObject({
    channel: "original-conversation",
    thread: "original-message",
    signal: sending,
    activity: {
      type: "message",
      text: "Result screenshot",
      replyToId: "original-message",
      attachments: [
        {
          contentType: "image/png",
          contentUrl: receipt,
          name: "screenshot.png",
        },
      ],
    },
  });
  const jpegReceipt = await adapter.upload(file(JPEG, "image/jpeg"), signal());
  await adapter.link(
    "conversation",
    "message",
    jpegReceipt,
    "JPEG result",
    signal(),
  );
  expect(sends.at(-1)?.activity.attachments?.[0]?.name).toBe("screenshot.jpg");
});

test("image upload rejects mismatched or unsupported bytes and fits large screenshots", async () => {
  let sends = 0;

  const adapter = teamsImageTransport(async () => {
    sends++;
  });

  for (const attachment of [
    file(png(), "image/jpeg"),
    file(JPEG, "image/png"),
    file(Buffer.from("<svg></svg>"), "image/svg+xml"),
    file(png(4097, 1)),
  ]) {
    await expect(adapter.upload(attachment, signal())).rejects.toThrow();
  }

  for (const image of [png(1, 1, 31_000), png(1920, 1080)]) {
    const preview = await adapter.upload(file(image), signal());
    expect(preview.startsWith("data:image/jpeg;base64,")).toBe(true);

    const decoded = inspectScreenshot(
      Buffer.from(preview.slice(preview.indexOf(",") + 1), "base64"),
    );

    expect(decoded.width).toBeLessThanOrEqual(1024);
    expect(decoded.bytes.length).toBeLessThanOrEqual(22_000);
  }

  expect(sends).toBe(0);
  await expect(
    adapter.download(["attachment"], "conversation", signal()),
  ).rejects.toThrow("not supported");
});

test("link accepts only validated canonical local receipts and never fetches a URL", async () => {
  let sends = 0;

  const adapter = teamsImageTransport(async () => {
    sends++;
  });

  const malformed = [
    "https://example.com/screenshot.png",
    "file:///private/image.png",
    "data:image/svg+xml;base64,PHN2Zz4=",
    "data:image/png;base64,AA",
    "data:image/png;base64,AB==",
    `data:image/jpeg;base64,${png().toString("base64")}`,
    `data:image/png;base64,${png().toString("base64")}\n`,
  ];

  for (const receipt of malformed) {
    await expect(
      adapter.link("channel", "thread", receipt, "caption", signal()),
    ).rejects.toThrow();
  }

  expect(sends).toBe(0);
});

test("abort/access revocation prevent publication and provider failures expose no image payload", async () => {
  let sends = 0;

  const adapter = teamsImageTransport(async () => {
    sends++;
    throw new Error("sensitive-base64-provider-payload");
  });

  const receipt = await adapter.upload(file(), signal());
  const stopped = AbortSignal.abort();
  await expect(adapter.upload(file(), stopped)).rejects.toThrow();
  await expect(
    adapter.link("channel", "thread", receipt, "caption", stopped),
  ).rejects.toThrow();
  await expect(
    adapter.link(
      "channel",
      "thread",
      receipt,
      "caption",
      signal(),
      () => false,
    ),
  ).rejects.toThrow("access denied");
  expect(sends).toBe(0);
  await expect(
    adapter.link("channel", "thread", receipt, "caption", signal()),
  ).rejects.toThrow("unconfirmed");
  expect(sends).toBe(1);
});

test("10 MiB sources and supported image types produce bounded still previews", async () => {
  const adapter = teamsImageTransport(async () => {});

  const gif = Buffer.from(
    "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
    "base64",
  );

  const source = png(4096, 48);
  const webp = Buffer.from(await new Bun.Image(source).webp().bytes());
  const jpeg = Buffer.from(await new Bun.Image(source).jpeg().bytes());
  const padding = 10 * 1024 * 1024 - png(1, 1, 1).length + 1;
  const exact = png(1, 1, padding);
  expect(exact.length).toBe(10 * 1024 * 1024);

  for (const attachment of [
    file(webp, "image/webp"),
    file(png(1100, 4, 0, true)),
    file(gif, "image/gif"),
    file(jpeg, "image/jpeg"),
    file(exact),
  ]) {
    const receipt = await adapter.upload(attachment, signal());
    expect(receipt.startsWith("data:image/jpeg;base64,")).toBe(true);

    const image = inspectScreenshot(
      Buffer.from(receipt.slice(receipt.indexOf(",") + 1), "base64"),
    );

    expect(image.bytes.length).toBeLessThanOrEqual(22_000);
  }

  await expect(
    adapter.upload(file(Buffer.concat([exact, Buffer.alloc(1)])), signal()),
  ).rejects.toThrow("10 MiB");
  const animatedHeader = Buffer.alloc(30);
  animatedHeader.write("WEBPVP8X", 8);
  animatedHeader[20] = 2;
  await expect(
    adapter.upload(file(animatedHeader, "image/webp"), signal()),
  ).rejects.toThrow("Animated WebP");
  await expect(
    adapter.upload(file(webp, "image/gif"), signal()),
  ).rejects.toThrow("MIME");
});

test("a busy native decoder can retry its local upload", async () => {
  const adapter = teamsImageTransport(async () => {});
  const input = file(png(2048, 48));
  const first = adapter.upload(input, signal());
  const second = adapter.upload(input, signal());
  await expect(adapter.upload(input, signal())).rejects.toThrow(
    "Upload refused",
  );
  await Promise.all([first, second]);
  expect(await adapter.upload(input, signal())).toStartWith("data:image/jpeg;");
});

test("Teams downloads an admitted Connector image once with its own token and bounded content", async () => {
  const service = "https://smba.trafficmanager.net/emea/";
  const view = service + "v3/attachments/abc/views/original";
  let tokens = 0;
  let requests = 0;
  const bytes = new Uint8Array(png(8, 5));

  const request = async (input: RequestInfo | URL, options?: RequestInit) => {
    expect(String(input)).toBe(view);
    expect(new Headers(options?.headers).get("authorization")).toBe(
      "Bearer test-token",
    );
    expect(options?.redirect).toBe("error");
    requests++;

    return new Response(bytes, { headers: { "content-type": "image/png" } });
  };

  const client = new ConnectorClient({
    tokenProvider: {
      invalidate() {},
      async getToken() {
        tokens++;

        return "test-token";
      },
    },
    fetch: Object.assign(request, { preconnect: fetch.preconnect }),
  });

  const load = (url: string, stop: AbortSignal) =>
    client.fetchImage(service, url, stop);

  const files = await downloadImages(service, [view], signal(), load);
  expect(files[0]?.mime).toBe("image/png");
  expect(Array.from(files[0]?.data ?? [])).toEqual(Array.from(bytes));

  for (const bad of [
    view + "?secret=1",
    view.replace("emea", "amer"),
    view.replace("smba.trafficmanager.net", "example.org"),
    view.replace("abc", ".."),
  ]) {
    expect(
      incomingImageRefs(service, [
        { contentType: "image/png", contentUrl: bad },
      ]),
    ).toEqual(["teams:image-unavailable"]);
    await expect(client.fetchImage(service, bad, signal())).rejects.toThrow();
  }

  expect(tokens).toBe(1);
  expect(requests).toBe(1);
  await expect(
    downloadImages(
      service,
      [view],
      signal(),
      async () =>
        new Response("no", {
          headers: { "content-length": String(10 * 1024 * 1024 + 1) },
        }),
    ),
  ).rejects.toThrow();
  await expect(
    downloadImages(
      service,
      [view],
      signal(),
      async () =>
        new Response(bytes, { headers: { "content-type": "image/webp" } }),
    ),
  ).rejects.toThrow("mismatch");
  await expect(
    downloadImages(
      service,
      [view],
      signal(),
      async () => new Response("denied", { status: 403 }),
    ),
  ).rejects.toThrow();
});
