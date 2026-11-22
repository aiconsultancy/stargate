import { afterEach, expect, test } from "bun:test";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createProfileApi,
  type ProfileApi,
  switchAgentProfile,
} from "../src/ops/agent-profile-switch";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function fixture() {
  const configDirectory = await mkdtemp(join(tmpdir(), "stargate-profiles-"));
  directories.push(configDirectory);
  const root = join(configDirectory, "agent-profiles");
  const selector = join(root, "current");
  const name = "worker-subagent";
  const agents = join(configDirectory, "agents");
  await mkdir(agents);
  for (const [profile, variant] of [
    ["before", "low"],
    ["after", "high"],
  ]) {
    if (!profile || !variant) throw new Error("Invalid test profile");
    const folder = join(root, profile);
    await mkdir(folder, { recursive: true });
    const route = { name, model: `test/model#${variant}`, weight: 2 };
    await writeFile(
      join(folder, "routes.json"),
      JSON.stringify({
        version: 2,
        profile,
        tiers: Array.from({ length: 5 }, (_, i) => ({
          purpose: `Tier ${i}`,
          routes: [route],
        })),
      }),
    );
    await writeFile(join(folder, "availability.json"), '{"missing":[]}');
    await writeFile(
      join(folder, `${name}.md`),
      `---\nmode: subagent\nmodel: ${route.model}\n---\nTest child\n`,
    );
  }
  await symlink("before", selector);
  await symlink(
    `../agent-profiles/current/${name}.md`,
    join(agents, `${name}.md`),
  );
  await writeFile(join(agents, "custom.md"), "Unrelated real agent\n");
  const calls: { method: string; path: string; selected: string }[] = [];
  const warnings: string[] = [];
  const state = {
    busy: false,
    pending: false,
    modelEnabled: true,
    tools: true,
    variants: ["low", "high"],
    failReload: false,
    failRollback: false,
    staleReads: 0,
    failAgents: false,
    malformedAgents: false,
  };
  let now = 0;
  const api: ProfileApi = async (method, path) => {
    const selected = await readlink(selector);
    calls.push({ method, path, selected });
    const endpoint = path.split("?")[0];
    switch (endpoint) {
      case "/api/model":
        return {
          data: [
            {
              providerID: "test",
              id: "model",
              enabled: state.modelEnabled,
              capabilities: { tools: state.tools },
              variants: state.variants.map((id) => ({ id })),
            },
          ],
        };
      case "/api/session/active":
        return { data: state.busy ? { session: { type: "running" } } : {} };
      case "/api/debug/location":
        return [{ directory: "/loaded" }];
      case "/api/form":
      case "/api/permission/request":
        return { data: state.pending ? [{ id: "pending" }] : [] };
      case "/api/location/reload":
        if (state.failRollback || (state.failReload && selected === "after")) {
          throw new Error("Reload unavailable");
        }
        state.pending = false; // OpenCode reload, not helper request cancellation.
        return null;
      case "/api/agent": {
        if (state.failAgents) throw new Error("Agent API unavailable");
        if (state.malformedAgents) return { data: "invalid" };
        const stale = state.staleReads-- > 0;
        return {
          data: [
            {
              id: name,
              mode: "subagent",
              model: {
                providerID: "test",
                id: "model",
                variant: selected === "after" && !stale ? "high" : "low",
              },
            },
          ],
        };
      }
      default:
        throw new Error(`Unexpected API call: ${method} ${path}`);
    }
  };
  const options = {
    configDirectory,
    directory: "/requested",
    profile: "after",
    api,
    warn: (message: string) => {
      warnings.push(message);
    },
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
  };
  return {
    options,
    state,
    calls,
    warnings,
    root,
    selector,
    agents,
    elapsed: () => now,
  };
}

test("explicit hot flag warns and proceeds with active sessions and pending requests", async () => {
  const f = await fixture();
  f.state.busy = true;
  f.state.pending = true;
  await switchAgentProfile({ ...f.options, hot: true });
  expect(await readlink(f.selector)).toBe("after");
  expect(f.warnings.join("\n")).toContain("all loaded locations");
  expect(f.warnings.join("\n")).toContain("next step boundary");
  expect(f.warnings.join("\n")).toContain(
    "pending forms and permissions are cancelled",
  );
  expect(f.state.pending).toBe(false);
  expect(f.state.busy).toBe(true);
  expect(await readFile(join(f.agents, "custom.md"), "utf8")).toBe(
    "Unrelated real agent\n",
  );
  expect(f.calls.filter((call) => call.method !== "get")).toEqual([
    { method: "post", path: "/api/location/reload", selected: "after" },
  ]);
  expect(f.calls.some((call) => call.path.includes("%2Floaded"))).toBe(true);
  await expect(access(join(f.root, ".switch.lock"))).rejects.toThrow();
});

test("disabled placeholders preserve stable managed links and custom agents", async () => {
  const f = await fixture();
  const placeholder = "inactive-subagent.md";
  const content = "---\nmode: subagent\ndisabled: true\n---\nInactive child\n";
  for (const profile of ["before", "after"]) {
    await writeFile(join(f.root, profile, placeholder), content);
  }
  const target = `../agent-profiles/current/${placeholder}`;
  await symlink(target, join(f.agents, placeholder));
  await symlink(target, join(f.agents, "alias-subagent.md"));
  await switchAgentProfile(f.options);
  expect(await readlink(f.selector)).toBe("after");
  expect(await readlink(join(f.agents, placeholder))).toBe(target);
  expect(await readlink(join(f.agents, "alias-subagent.md"))).toBe(target);
  expect(await readFile(join(f.agents, placeholder), "utf8")).toBe(content);
  expect(await readlink(join(f.agents, "worker-subagent.md"))).toBe(
    "../agent-profiles/current/worker-subagent.md",
  );
  expect(await readFile(join(f.agents, "custom.md"), "utf8")).toBe(
    "Unrelated real agent\n",
  );
});

test("managed links require an existing validated target even when inactive", async () => {
  const f = await fixture();
  await symlink(
    "../agent-profiles/current/missing-subagent.md",
    join(f.agents, "inactive-subagent.md"),
  );
  await expect(switchAgentProfile(f.options)).rejects.toThrow(
    /managed agent link/,
  );
  expect(await readlink(f.selector)).toBe("before");
  expect(f.calls).toEqual([]);
});

test("extra agent definitions must be disabled subagent placeholders", async () => {
  for (const header of [
    "mode: subagent\nmodel: test/model#high",
    "mode: subagent\ndisabled: false",
    "mode: primary\ndisabled: true",
  ]) {
    const f = await fixture();
    await writeFile(
      join(f.root, "after", "inactive-subagent.md"),
      `---\n${header}\n---\n`,
    );
    await expect(switchAgentProfile(f.options)).rejects.toThrow();
    expect(await readlink(f.selector)).toBe("before");
    expect(f.calls).toEqual([]);
  }
});

test("profile selection rejects reserved current and path-like names", async () => {
  for (const profile of ["current", "../after", "/after"]) {
    const f = await fixture();
    await expect(switchAgentProfile({ ...f.options, profile })).rejects.toThrow(
      profile === "current"
        ? "Reserved profile name."
        : "Invalid profile name.",
    );
    expect(await readlink(f.selector)).toBe("before");
    expect(f.calls).toEqual([]);
  }
});

test("selector rejects reserved current and unmanaged path targets", async () => {
  for (const target of ["current", "../after", "/after"]) {
    const f = await fixture();
    await unlink(f.selector);
    await symlink(target, f.selector);
    await expect(switchAgentProfile(f.options)).rejects.toThrow(
      target === "current"
        ? "Reserved profile name."
        : "Selector has an unmanaged target.",
    );
    expect(await readlink(f.selector)).toBe(target);
    expect(f.calls).toEqual([]);
  }
});

test("default idle gate blocks busy sessions or pending requests before mutation", async () => {
  for (const busy of [true, false]) {
    const f = await fixture();
    f.state.busy = busy;
    f.state.pending = !busy;
    await expect(switchAgentProfile(f.options)).rejects.toThrow(
      /active sessions|pending/,
    );
    expect(await readlink(f.selector)).toBe("before");
    expect(f.calls.every((call) => call.method === "get")).toBe(true);
  }
});

test("disabled hot flag cannot bypass the default idle gate", async () => {
  const f = await fixture();
  f.state.busy = true;
  await expect(
    switchAgentProfile({ ...f.options, hot: false, requireIdle: false }),
  ).rejects.toThrow(/active sessions/);
  expect(await readlink(f.selector)).toBe("before");
  expect(f.calls.every((call) => call.method === "get")).toBe(true);
});

test("conflicting hot and require-idle flags fail before any API or selector change", async () => {
  const f = await fixture();
  await expect(
    switchAgentProfile({ ...f.options, hot: true, requireIdle: true }),
  ).rejects.toThrow("Choose --hot or --require-idle, not both.");
  expect(await readlink(f.selector)).toBe("before");
  expect(f.calls).toEqual([]);
  await expect(access(join(f.root, ".switch.lock"))).rejects.toThrow();
});

test("CLI documents idle default and rejects contradictory flags without service discovery", async () => {
  const script = fileURLToPath(
    new URL("../src/ops/agent-profile-switch.ts", import.meta.url),
  );
  const run = (args: string[]) =>
    Bun.spawn([process.execPath, script, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: {},
    });
  const help = run(["--help"]);
  const usage = await new Response(help.stdout).text();
  expect(usage).toContain(
    "Usage: bun run src/ops/agent-profile-switch.ts PROFILE",
  );
  expect(usage).toContain("--hot");
  expect(usage).toContain(
    "Requires idle sessions and no pending requests by default.",
  );
  expect(await help.exited).toBe(0);
  const refused = run(["after", "--hot", "--require-idle"]);
  expect(await new Response(refused.stderr).text()).toContain(
    "Choose --hot or --require-idle, not both.",
  );
  expect(await refused.exited).toBe(1);
});

test("strict idle gate permits idle switch", async () => {
  const f = await fixture();
  f.state.busy = false;
  f.state.pending = false;
  await switchAgentProfile({ ...f.options, requireIdle: true });
  expect(await readlink(f.selector)).toBe("after");
});

test("existing lock excludes switch and remains intact", async () => {
  const f = await fixture();
  await mkdir(join(f.root, ".switch.lock"));
  await expect(switchAgentProfile(f.options)).rejects.toThrow();
  expect(await readlink(f.selector)).toBe("before");
  await access(join(f.root, ".switch.lock"));
  expect(f.calls).toEqual([]);
});

test("model, variant and tools validation fail before selector mutation", async () => {
  for (const change of [
    { modelEnabled: false },
    { tools: false },
    { variants: ["low"] },
  ]) {
    const f = await fixture();
    Object.assign(f.state, change);
    await expect(
      switchAgentProfile({ ...f.options, hot: true }),
    ).rejects.toThrow(/model|tools|variant/i);
    expect(await readlink(f.selector)).toBe("before");
    expect(f.calls.every((call) => call.method === "get")).toBe(true);
  }
});

test("route discovery converges within bounded polling", async () => {
  const f = await fixture();
  f.state.staleReads = 3;
  await switchAgentProfile(f.options);
  expect(f.elapsed()).toBe(750);
  expect(await readlink(f.selector)).toBe("after");
});

test("verification timeout restores previous selector and reloads", async () => {
  const f = await fixture();
  f.state.staleReads = 1000;
  await expect(switchAgentProfile(f.options)).rejects.toThrow(/restored/);
  expect(f.elapsed()).toBe(10_000);
  expect(await readlink(f.selector)).toBe("before");
  expect(
    f.calls
      .filter((call) => call.method === "post")
      .map((call) => call.selected),
  ).toEqual(["after", "before"]);
});

test("reload failure restores selector and reloads previous profile", async () => {
  const f = await fixture();
  f.state.failReload = true;
  await expect(switchAgentProfile(f.options)).rejects.toThrow(/restored/);
  expect(await readlink(f.selector)).toBe("before");
  expect(
    f.calls
      .filter((call) => call.method === "post")
      .map((call) => call.selected),
  ).toEqual(["after", "before"]);
});

test("API failures and invalid responses fail immediately, not as route retries", async () => {
  for (const change of [{ failAgents: true }, { malformedAgents: true }]) {
    const f = await fixture();
    Object.assign(f.state, change);
    await expect(switchAgentProfile(f.options)).rejects.toThrow(/restored/);
    expect(f.elapsed()).toBe(0);
    expect(await readlink(f.selector)).toBe("before");
  }
});

test("rollback reload failure reports operator review without deleting state", async () => {
  const f = await fixture();
  f.state.failRollback = true;
  await expect(switchAgentProfile(f.options)).rejects.toThrow(
    /operator review/,
  );
  expect(await readlink(f.selector)).toBe("before");
  expect(await readFile(join(f.agents, "custom.md"), "utf8")).toBe(
    "Unrelated real agent\n",
  );
});

test("invalid installed definitions fail closed without API or selector mutation", async () => {
  for (const invalid of [
    "manifest",
    "availability",
    "frontmatter",
    "extra",
    "collision",
  ]) {
    const f = await fixture();
    const folder = join(f.root, "after");
    switch (invalid) {
      case "manifest":
        await writeFile(join(folder, "routes.json"), '{"version":2}');
        break;
      case "availability":
        await writeFile(
          join(folder, "availability.json"),
          '{"missing":["gap"]}',
        );
        break;
      case "frontmatter":
        await writeFile(
          join(folder, "worker-subagent.md"),
          "---\nmodel: test/model#high\nmode: subagent\ndisabled: true\n---\n",
        );
        break;
      case "extra":
        await writeFile(join(folder, "unexpected.md"), "Unvalidated agent\n");
        break;
      case "collision":
        await unlink(join(f.agents, "worker-subagent.md"));
        await writeFile(
          join(f.agents, "worker-subagent.md"),
          "Keep this real agent\n",
        );
        break;
    }
    await expect(switchAgentProfile(f.options)).rejects.toThrow();
    expect(await readlink(f.selector)).toBe("before");
    expect(f.calls).toEqual([]);
    if (invalid === "collision") {
      expect(await readFile(join(f.agents, "worker-subagent.md"), "utf8")).toBe(
        "Keep this real agent\n",
      );
    }
  }
});

test("location-specific model mismatch blocks before mutation", async () => {
  const f = await fixture();
  const api: ProfileApi = async (method, path, signal) =>
    path.startsWith("/api/model?")
      ? { data: [] }
      : f.options.api(method, path, signal);
  await expect(switchAgentProfile({ ...f.options, api })).rejects.toThrow(
    /unavailable/,
  );
  expect(await readlink(f.selector)).toBe("before");
  expect(f.calls.every((call) => call.method === "get")).toBe(true);
});

test("second strict readiness check catches work admitted during validation", async () => {
  const f = await fixture();
  f.state.busy = false;
  f.state.pending = false;
  let checks = 0;
  const api: ProfileApi = async (method, path, signal) => {
    if (path === "/api/session/active" && ++checks === 2) f.state.busy = true;
    return f.options.api(method, path, signal);
  };
  await expect(
    switchAgentProfile({ ...f.options, api, requireIdle: true }),
  ).rejects.toThrow(/active sessions/);
  expect(await readlink(f.selector)).toBe("before");
  expect(f.calls.every((call) => call.method === "get")).toBe(true);
});

test("cancellation during verification still restores and reloads previous selector", async () => {
  const f = await fixture();
  const controller = new AbortController();
  f.state.staleReads = 10;
  await expect(
    switchAgentProfile({
      ...f.options,
      signal: controller.signal,
      sleep: async () => {
        controller.abort();
      },
    }),
  ).rejects.toThrow(/restored/);
  expect(await readlink(f.selector)).toBe("before");
  expect(
    f.calls
      .filter((call) => call.method === "post")
      .map((call) => call.selected),
  ).toEqual(["after", "before"]);
});

test("transport discovers only once, authenticates, and never redirects or exposes responses", async () => {
  let discoveries = 0;
  let status = 200;
  let body = '{"data":[]}';
  const requests: { url: string; options: RequestInit }[] = [];
  const api = createProfileApi(
    undefined,
    async () => {
      discoveries++;
      return {
        url: "http://localhost:4096",
        auth: {
          type: "basic",
          username: "fixture",
          password: "synthetic-test-value",
        },
      };
    },
    async (url, options) => {
      requests.push({ url: url.href, options });
      return new Response(body, { status });
    },
  );
  const signal = new AbortController().signal;
  expect(await api("get", "/api/model", signal)).toEqual({ data: [] });
  body = "";
  expect(await api("post", "/api/location/reload", signal)).toBeNull();
  expect(discoveries).toBe(1);
  expect(requests[0]?.url).toBe("http://localhost:4096/api/model");
  expect(new Headers(requests[0]?.options.headers).has("authorization")).toBe(
    true,
  );
  expect(
    requests.every((request) => request.options.redirect === "error"),
  ).toBe(true);
  body = "synthetic-private-response";
  for (status of [200, 503]) {
    await expect(api("get", "/api/agent", signal)).rejects.toThrow(
      "OpenCode API failed: get /api/agent. Check the registered service; response details withheld.",
    );
  }
});

test("missing service fails closed without starting a process or making requests", async () => {
  let requested = false;
  const api = createProfileApi(
    undefined,
    async () => undefined,
    async () => {
      requested = true;
      return new Response("{}");
    },
  );
  await expect(
    api("get", "/api/model", new AbortController().signal),
  ).rejects.toThrow(/Check the registered service/);
  expect(requested).toBe(false);
});

test("version 1 manifests and model IDs containing slashes switch without fallback", async () => {
  const f = await fixture();
  await unlink(join(f.agents, "worker-subagent.md"));
  await unlink(join(f.root, "after", "worker-subagent.md"));
  const routes = Array.from({ length: 5 }, (_, i) => ({
    name: `worker-${i}`,
    model: "test/family/model#high",
  }));
  await writeFile(
    join(f.root, "after", "routes.json"),
    JSON.stringify({
      version: 1,
      profile: "after",
      routes,
    }),
  );
  for (const route of routes) {
    await writeFile(
      join(f.root, "after", `${route.name}.md`),
      `---\nmode: subagent\nmodel: ${route.model}\n---\n`,
    );
    await symlink(
      `../agent-profiles/current/${route.name}.md`,
      join(f.agents, `${route.name}.md`),
    );
  }
  const api: ProfileApi = async (method, path, signal) => {
    if (path.startsWith("/api/model"))
      return {
        data: [
          {
            providerID: "test",
            id: "family/model",
            enabled: true,
            capabilities: { tools: true },
            variants: [{ id: "high" }],
          },
        ],
      };
    if (path.startsWith("/api/agent"))
      return {
        data: routes.map((route) => ({
          id: route.name,
          mode: "subagent",
          model: {
            providerID: "test",
            id: "family/model",
            variant: "high",
          },
        })),
      };
    return f.options.api(method, path, signal);
  };
  await switchAgentProfile({ ...f.options, api });
  expect(await readlink(f.selector)).toBe("after");
});
