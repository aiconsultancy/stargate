import { expect, test } from "bun:test";
import type { SubmissionDraft } from "@earendil-works/pi-durable";
import type { Attachment } from "../src/attachments/attachments";
import { piInputContent } from "../src/backends/pi/pi-attachments";
import { PiDurableBackend } from "../src/backends/pi/pi-durable";

const textFile = (mime = "text/plain"): Attachment => ({
  name: "notes.txt",
  mime,
  data: new TextEncoder().encode("File contents: café"),
});

test("Pi maps image bytes to native base64 blocks and UTF-8 files to text", () => {
  for (const mime of ["image/png", "image/jpeg", "image/gif", "image/webp"]) {
    const data = Uint8Array.of(0, 128, 255);
    expect(
      piInputContent("Inspect", [{ name: "photo", mime, data }], true),
    ).toEqual([
      { type: "text", text: "Inspect" },
      { type: "text", text: "Attachment: photo" },
      { type: "image", data: "AID/", mimeType: mime },
    ]);
  }

  for (const mime of [
    "text/plain",
    "text/markdown",
    "text/csv",
    "application/json",
  ]) {
    expect(piInputContent("Read", [textFile(mime)], false)).toEqual([
      { type: "text", text: "Read" },
      { type: "text", text: "Attachment: notes.txt\nFile contents: café" },
    ]);
  }

  expect(piInputContent("Unchanged", [], false)).toBe("Unchanged");
});

test("Pi rejects unsupported files, binary text, non-vision images, and bounds", () => {
  for (const mime of [
    "application/pdf",
    "application/octet-stream",
    "image/svg+xml",
  ]) {
    expect(() => piInputContent("Read", [textFile(mime)], true)).toThrow();
  }

  for (const data of [Uint8Array.of(255), Uint8Array.of(0)]) {
    expect(() =>
      piInputContent("Read", [{ ...textFile(), data }], true),
    ).toThrow();
  }

  expect(() =>
    piInputContent("Read", [textFile("image/png")], false),
  ).toThrow();
  expect(() =>
    piInputContent(
      "Read",
      Array.from({ length: 11 }, () => textFile()),
      true,
    ),
  ).toThrow();
  expect(() =>
    piInputContent("Read", [{ ...textFile(), name: "../bad" }], true),
  ).toThrow();
});

function fixture(acceptsImages = true) {
  const submissions: SubmissionDraft[] = [];
  let lookups = 0;

  const harness = {
    async conversation() {
      lookups++;

      return {
        async submit(draft: SubmissionDraft) {
          submissions.push(draft);

          return {
            async wait() {
              return { type: "input", status: "done", entry: 1, answer: 2 };
            },
          };
        },
        async commit() {
          return {
            id: 2,
            model: [
              { role: "assistant", content: [{ type: "text", text: "Done" }] },
            ],
          };
        },
      };
    },
  };

  const backend: PiDurableBackend = Reflect.construct(PiDurableBackend, [
    harness,
    { model: "openai/test" },
    new Set(),
    {},
    acceptsImages,
  ]);

  return { backend, submissions, lookups: () => lookups };
}

test("Pi submits attachments with admission ID and preserves crew request IDs", async () => {
  const { backend, submissions } = fixture();
  const signal = new AbortController().signal;
  let admitted = "";
  expect(backend.supportsAttachments).toBe(true);
  expect(
    await backend.prompt(
      "1",
      "Read",
      signal,
      undefined,
      (id) => {
        admitted = id;
      },
      [textFile()],
    ),
  ).toBe("Done");
  expect(admitted).not.toBe("");
  expect(submissions[0]).toEqual({
    type: "input",
    requestId: admitted,
    content: piInputContent("Read", [textFile()], true),
    whenBusy: "followUp",
  });
  await backend.prompt("1", "Crew", signal, undefined, "final", "crew-request");
  expect(submissions[1]).toEqual({
    type: "input",
    requestId: "crew-request",
    content: "Crew",
    whenBusy: "followUp",
  });
});

test("Pi refuses files and aborted input before admission or harness access", async () => {
  const { backend, submissions, lookups } = fixture();
  let admissions = 0;

  const admitted = () => {
    admissions++;
  };

  await expect(
    backend.prompt(
      "1",
      "Read",
      new AbortController().signal,
      undefined,
      admitted,
      [textFile("application/pdf")],
    ),
  ).rejects.toThrow();
  await expect(
    backend.prompt("1", "Read", AbortSignal.abort(), undefined, admitted, [
      textFile(),
    ]),
  ).rejects.toThrow();
  expect(admissions).toBe(0);
  expect(submissions).toEqual([]);
  expect(lookups()).toBe(0);
});

test("Pi admits real image blocks only for image-capable models", async () => {
  const file: Attachment = {
    name: "photo.png",
    mime: "image/png",
    data: Uint8Array.of(137, 80, 78, 71),
  };

  const signal = new AbortController().signal;
  const vision = fixture();
  await vision.backend.prompt("1", "", signal, undefined, undefined, [file]);
  expect(vision.submissions[0]?.type).toBe("input");
  expect(vision.submissions[0]?.content).toEqual([
    { type: "text", text: "Attachment: photo.png" },
    { type: "image", data: "iVBORw==", mimeType: "image/png" },
  ]);
  const textOnly = fixture(false);
  let admitted = false;
  await expect(
    textOnly.backend.prompt(
      "1",
      "",
      signal,
      undefined,
      () => {
        admitted = true;
      },
      [file],
    ),
  ).rejects.toThrow("Pi model does not support images");
  expect(admitted).toBe(false);
  expect(textOnly.lookups()).toBe(0);
});
