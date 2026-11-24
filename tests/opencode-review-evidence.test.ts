import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Schema } from "effect";
import { OpenCodeBackend } from "../src/backends/opencode/opencode";
import { backendSchema } from "../src/config";
import {
  type FleetReviewBinding,
  reviewBindingSchema,
} from "../src/coordination/fleet/protocol";
import {
  reviewContextPrompt,
  reviewNativePrompt,
} from "../src/coordination/fleet/review-prompts";
import { zodStringRecord } from "./fixtures/zod-string-record";

const diff =
  "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n";

function binding(kind: "crew" | "captain" = "crew"): FleetReviewBinding {
  return Schema.decodeUnknownSync(reviewBindingSchema)({
    id: "proof_" + "1".repeat(32),
    nonce: "2".repeat(32),
    context: {
      id: "review",
      repository: "example/project",
      pullRequest: 7,
      headSHA: "a".repeat(40),
      baseSHA: "b".repeat(40),
      mergeBaseSHA: "c".repeat(40),
      contextDigest: createHash("sha256").update(diff).digest("hex"),
      authorShip: "author",
      coordinatorShip: "peer",
      coordinatorSessionID: "ses_peer",
      dispatchID: "dispatch",
    },
    contextText: diff,
    reviewerShip: "peer",
    reviewer: {
      agent: kind === "crew" ? "review-agent" : "captain-peer",
      kind,
      family: "codex",
      directory: kind === "crew" ? "/project/review" : "/project/root",
      models: [{ provider: "unit", model: "gpt" }],
      permissions: [{ action: "read", resource: "*", effect: "allow" }],
    },
    sessionID: kind === "crew" ? "ses_review" : "ses_peer",
    inputID: "msg_review",
    createdAt: "2026-11-16T00:00:00.000Z",
  });
}

type Changes = {
  busy?: boolean;
  queued?: boolean;
  wrongProfile?: boolean;
  wrongModel?: boolean;
  wrongSession?: boolean;
  wrongNonce?: boolean;
  wrongInput?: boolean;
  pending?: boolean;
  failed?: boolean;
  later?: boolean;
  mixed?: boolean;
  tool?: string;
  finish?: string;
  instruction?: "native" | "malformed";
  earlierTool?: string;
  shellCallback?: "owned" | "missing" | "foreign";
};

function fixture(b: FleetReviewBinding, changes: Changes = {}) {
  const calls: { path: string; method: string }[] = [];
  const admissions: Record<string, unknown>[] = [];
  const creates: Record<string, unknown>[] = [];

  const {
    id: _id,
    authorShip: _author,
    coordinatorShip: _coordinator,
    coordinatorSessionID: _owner,
    dispatchID: _dispatch,
    ...resultContext
  } = b.context;

  const resultText = JSON.stringify({
    ...resultContext,
    verdict: "approve",
    summary: "Native review of the exact supplied diff",
    findings: [],
  });

  const input = () =>
    b.reviewer.kind === "crew"
      ? reviewNativePrompt(b)
      : "s=irc;a=agent\n\nPeer assignment\n\n" +
        reviewContextPrompt(b.context, b.contextText);

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url),
        path = url.pathname;

      calls.push({ path, method: request.method });

      if (path === `/api/agent/${b.reviewer.agent}`)
        return Response.json({
          location: { directory: b.reviewer.directory },
          data: {
            id: changes.wrongProfile ? "other" : b.reviewer.agent,
            name: "Reviewer",
            mode: "primary",
            hidden: false,
            request: { settings: {}, headers: {}, body: {} },
            permissions: [],
            model: {
              providerID: "unit",
              id: changes.wrongModel ? "wrong" : "gpt",
            },
          },
        });

      if (path === "/api/session/active")
        return Response.json({
          data: changes.busy ? { ses_other: { type: "running" } } : {},
        });

      if (path === "/api/session" && request.method === "GET")
        return Response.json({
          data:
            changes.busy || changes.queued
              ? [
                  {
                    id: "ses_other",
                    agent: "another-agent",
                    location: { directory: b.reviewer.directory },
                  },
                ]
              : [],
          cursor: {},
        });

      if (path === "/api/session/ses_other/inbox")
        return Response.json({
          data: changes.queued ? [{ id: "queued-work" }] : [],
        });

      if (path === "/api/session" && request.method === "POST") {
        const data = Schema.decodeUnknownSync(zodStringRecord(Schema.Unknown))(
          await request.json(),
        );

        creates.push(data);

        return Response.json({ data: { ...data } });
      }

      if (path === `/api/session/${b.sessionID}/prompt`) {
        const data = Schema.decodeUnknownSync(zodStringRecord(Schema.Unknown))(
          await request.json(),
        );

        admissions.push(data);

        return Response.json({ data: { id: data["id"] } });
      }

      if (path === `/api/session/${b.sessionID}`)
        return Response.json({
          data: {
            id: changes.wrongSession ? "ses_other" : b.sessionID,
            agent: b.reviewer.agent,
            location: { directory: b.reviewer.directory },
            metadata:
              b.reviewer.kind === "captain"
                ? {}
                : {
                    stargateReview: {
                      id: b.id,
                      nonce: changes.wrongNonce ? "3".repeat(32) : b.nonce,
                      owner: "ses_peer",
                      contextDigest: b.context.contextDigest,
                    },
                  },
            time: { created: 0, updated: 10, idle: 10 },
          },
        });

      if (path === `/api/session/${b.sessionID}/message`) {
        const assistant = {
          id: "assistant-review",
          type: "assistant",
          agent: b.reviewer.agent,
          model: { providerID: "unit", id: "gpt" },
          time: {
            created: changes.instruction ? 4 : 2,
            ...(changes.pending
              ? {}
              : { completed: changes.instruction ? 5 : 3 }),
          },
          finish: changes.finish ?? "stop",
          ...(changes.failed
            ? { error: { message: "provider rejected inference" } }
            : {}),
          content: [
            { type: "text", text: resultText },
            { type: "reasoning", text: "not evidence" },
            ...(changes.tool
              ? [
                  {
                    type: "tool",
                    id: "call_review",
                    name: changes.tool,
                    input: {},
                    state: { status: "completed", output: "done" },
                  },
                ]
              : []),
          ],
        };

        return Response.json({
          data: [
            ...(changes.later
              ? [
                  {
                    ...assistant,
                    id: "later-assistant",
                    model: { providerID: "other", id: "other-model" },
                  },
                  {
                    id: "later-input",
                    type: "user",
                    time: { created: 4 },
                    text: "Another conversation",
                  },
                ]
              : []),
            assistant,
            ...(changes.instruction
              ? [
                  {
                    id: "native-instructions",
                    type: "synthetic",
                    time: { created: 3 },
                    metadata: {
                      instruction: {
                        paths: [`${b.reviewer.directory}/nested/AGENTS.md`],
                      },
                    },
                    description: "Loaded nested/AGENTS.md",
                    text:
                      changes.instruction === "native"
                        ? `Instructions from: ${b.reviewer.directory}/nested/AGENTS.md\n# Fixture instructions`
                        : "Unrelated steering",
                  },
                  {
                    ...assistant,
                    id: "before-native-instructions",
                    time: { created: 2, completed: 3 },
                    finish: "tool-calls",
                    content: [
                      {
                        type: "tool",
                        id: "call_read",
                        name: changes.earlierTool ?? "read",
                        input: {},
                        state: { status: "completed", output: "fixture" },
                      },
                    ],
                  },
                ]
              : []),
            ...(changes.shellCallback
              ? [
                  {
                    id: "native-shell-callback",
                    type: "synthetic",
                    time: { created: 3 },
                    description: "echo fixture",
                    metadata: {
                      source: "shell",
                      jobID: "sh_review",
                      shellID: "sh_review",
                      state: "completed",
                      truncated: false,
                      exit: 0,
                    },
                    text: '<shell id="sh_review" state="completed" command="echo fixture">\nFixture output\n</shell>',
                  },
                  ...(changes.shellCallback === "missing"
                    ? []
                    : [
                        {
                          ...assistant,
                          id: "native-shell-launch",
                          agent:
                            changes.shellCallback === "foreign"
                              ? "other-agent"
                              : b.reviewer.agent,
                          time: { created: 1.5, completed: 4 },
                          finish: "tool-calls",
                          content: [
                            {
                              type: "tool",
                              id: "call_shell",
                              name: "shell",
                              executed: false,
                              state: {
                                status: "completed",
                                input: { command: "echo fixture" },
                                content: [
                                  { type: "text", text: "Background command" },
                                ],
                                metadata: {
                                  status: "running",
                                  shellID: "sh_review",
                                  truncated: false,
                                },
                              },
                            },
                          ],
                        },
                      ]),
                ]
              : []),
            ...(changes.mixed
              ? [
                  {
                    ...assistant,
                    id: "earlier-assistant",
                    model: { providerID: "unit", id: "claude" },
                  },
                ]
              : []),
            {
              id: b.inputID,
              type: "user",
              time: { created: 1 },
              text: changes.wrongInput
                ? "Quoted review, not this assignment"
                : input(),
            },
          ],
          cursor: {},
        });
      }

      return new Response(null, { status: 404 });
    },
  });

  const config = Schema.decodeUnknownSync(backendSchema)({
    type: "opencode",
    url: server.url.href,
    directory: "/project/root",
    agent: "captain-peer",
    sessionID: "ses_peer",
  });

  if (config.type !== "opencode") throw new Error("Wrong fixture backend");
  const backend = new OpenCodeBackend(config);

  return {
    backend,
    calls,
    creates,
    admissions,
    resultText,
    async close() {
      await backend.close();
      await server.stop(true);
    },
  };
}

const signal = () => new AbortController().signal;

test("review admission uses exact configured PRIMARY agent/model and persisted native IDs/context without changing a checkout", async () => {
  const b = binding();
  const f = fixture(b);

  try {
    await f.backend.startReview(b, signal());
    expect(f.creates).toHaveLength(1);
    expect(f.creates[0]).toMatchObject({
      id: b.sessionID,
      agent: b.reviewer.agent,
      location: { directory: b.reviewer.directory },
      model: { providerID: "unit", id: "gpt" },
      permissions: [
        { action: "*", resource: "*", effect: "deny" },
        { action: "read", resource: "*", effect: "allow" },
      ],
    });
    expect(f.admissions).toHaveLength(1);
    expect(f.admissions[0]).toMatchObject({
      id: b.inputID,
      text: reviewNativePrompt(b),
      delivery: "queue",
      resume: true,
    });
    expect(reviewNativePrompt(b)).toContain(diff);
    expect(f.calls.every((c) => c.path.startsWith("/api/"))).toBe(true);
  } finally {
    await f.close();
  }
});

test("wrong profile/model or busy/queued permanent directory refuses native review admission before create/prompt", async () => {
  for (const changes of [
    { wrongProfile: true },
    { wrongModel: true },
    { busy: true },
    { queued: true },
  ]) {
    const b = binding();
    const f = fixture(b, changes);

    try {
      await expect(f.backend.startReview(b, signal())).rejects.toThrow();
      expect(f.creates).toEqual([]);
      expect(f.admissions).toEqual([]);
    } finally {
      await f.close();
    }
  }
});

test("native review evidence identifies exact settled assistant makers and ignores a later conversation", async () => {
  const b = binding();
  const f = fixture(b, { later: true });

  try {
    expect(await f.backend.readReview(b, signal())).toEqual({
      resultText: f.resultText,
      makers: [
        {
          messageID: "assistant-review",
          agent: b.reviewer.agent,
          provider: "unit",
          model: "gpt",
        },
      ],
    });
    expect(f.calls.filter((c) => c.method !== "GET")).toEqual([]);
  } finally {
    await f.close();
  }
});

test("quoted input, another native session, changed ownership nonce and failed inference cannot attest review", async () => {
  for (const changes of [
    { wrongInput: true },
    { wrongSession: true },
    { wrongNonce: true },
    { failed: true },
  ]) {
    const b = binding();
    const f = fixture(b, changes);

    try {
      await expect(f.backend.readReview(b, signal())).rejects.toThrow();
      expect(f.admissions).toEqual([]);
    } finally {
      await f.close();
    }
  }
});

test("unfinished native work yields no proof; actual mixed-model makers remain visible for policy rejection", async () => {
  const b = binding();
  const pending = fixture(b, { pending: true });

  try {
    expect(await pending.backend.readReview(b, signal())).toBeUndefined();
  } finally {
    await pending.close();
  }

  const mixed = fixture(b, { mixed: true });

  try {
    const evidence = await mixed.backend.readReview(b, signal());
    expect(evidence?.makers.map((m) => m.model)).toEqual(["claude", "gpt"]);
  } finally {
    await mixed.close();
  }
});

test("captain substitution reads the existing exact ingress and never creates/prompts another root", async () => {
  const b = binding("captain");
  const f = fixture(b, { later: true });

  try {
    const evidence = await f.backend.readReview(b, signal());
    expect(evidence?.makers[0]?.agent).toBe("captain-peer");
    expect(f.creates).toEqual([]);
    expect(f.admissions).toEqual([]);
  } finally {
    await f.close();
  }
});

test("native proof refuses mutating tools and unsuccessful final states for crew and captain substitution", async () => {
  for (const kind of ["crew", "captain"] as const) {
    for (const changes of [
      { tool: "edit" },
      { tool: "bash" },
      { tool: "stargate_crew" },
      { finish: "length" },
    ]) {
      const f = fixture(binding(kind), changes);

      try {
        await expect(
          f.backend.readReview(binding(kind), signal()),
        ).rejects.toThrow();
        expect(f.creates).toEqual([]);
        expect(f.admissions).toEqual([]);
      } finally {
        await f.close();
      }
    }

    const f = fixture(binding(kind), { tool: "read" });

    try {
      expect(await f.backend.readReview(binding(kind), signal())).toBeDefined();
    } finally {
      await f.close();
    }
  }
});

test("native review preserves all makers and readonly tool checks across instruction context", async () => {
  const b = binding();
  const f = fixture(b, { instruction: "native" });

  try {
    const result = await f.backend.readReview(b, signal());
    expect(result?.resultText).toBe(f.resultText);
    expect(result?.makers.map((m) => m.messageID)).toEqual([
      "before-native-instructions",
      "assistant-review",
    ]);
  } finally {
    await f.close();
  }
});

for (const changes of [
  { instruction: "malformed" as const },
  { instruction: "native" as const, earlierTool: "bash" },
])
  test(`native review rejects unknown steering or unsafe pre-context tool: ${JSON.stringify(changes)}`, async () => {
    const b = binding();
    const f = fixture(b, changes);

    try {
      await expect(f.backend.readReview(b, signal())).rejects.toThrow();
    } finally {
      await f.close();
    }
  });

for (const callback of ["owned", "foreign"] as const)
  test(`review shell callback keeps unsafe-tool refusal: ${callback}`, async () => {
    const b = binding();
    const f = fixture(b, { shellCallback: callback });

    try {
      await expect(f.backend.readReview(b, signal())).rejects.toThrow(
        "outside the read-only review boundary",
      );
      expect(f.calls.every((call) => call.method === "GET")).toBe(true);
    } finally {
      await f.close();
    }
  });

test("unowned review shell notice retains the original pending boundary behaviour", async () => {
  const b = binding();
  const f = fixture(b, { shellCallback: "missing" });

  try {
    expect(await f.backend.readReview(b, signal())).toBeUndefined();
    expect(f.calls.every((call) => call.method === "GET")).toBe(true);
  } finally {
    await f.close();
  }
});
