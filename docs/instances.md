# Repeatable captain/crew instances

Use this procedure to prepare another Pogo installation with a different
captain and crew. It does not copy an existing installation or its credentials.
The example selects Cain, Shaw and Fisk. Names and normalized agent IDs must
match. Do not retain hidden Mario, Luigi, Daisy, Toad or Bowser aliases.

Preparation is local. Creating Slack apps, installing services and starting
model work require separate operator approval. Do not run a second listener
with an existing installation's tokens.

## Inputs and isolation

Record these non-secret inputs before setup. Keep them unchanged on retries.

| Input                | Example                                         | Rule                                                           |
| -------------------- | ----------------------------------------------- | -------------------------------------------------------------- |
| Pogo release         | Full approved Git commit                        | Pin a clean checkout; retain it while its service uses it      |
| Target project       | `/srv/projects/example`                         | Existing Git repository; do not switch or clean it             |
| Project base         | Full approved project commit                    | Fetch first; do not use a moving branch for reproducible setup |
| Namespace and bot ID | `pegasus`                                       | Unique to this installation                                    |
| Captain directory    | `/srv/pogo/pegasus/captain`                     | Outside all crew configuration trees                           |
| Crew parent          | `/srv/pogo/pegasus/crew`                        | Separate worktree per configured ID                            |
| Config               | `/srv/pogo/pegasus/config/pogo.json`            | Separate config directory and `.pogo` queue database           |
| Provisioning journal | Config directory's `.local/provision/bots.json` | Preserve on retries, including uncertain outcomes              |
| Service name         | `pogo-pegasus`                                  | Never reuse another installation's unit                        |
| Slack workspace/app  | Explicit Team ID and new or unused App ID       | Only the captain needs a registration                          |
| Slack access         | Human IDs and channel/DM IDs                    | Nonempty allowlists; no implicit wildcards                     |
| OpenCode endpoint    | Operator-selected stable service URL            | Not the proxy URL; preserve authentication                     |
| Provider routes      | Verified `provider/model#variant`               | No unapproved native or paid fallback                          |
| Proxy                | Endpoint and private client-key file path       | Existing approved proxy may be shared                          |
| Token references     | Unique environment variable names               | Values stay in private credential storage                      |

Teams can share one OpenCode service and one proxy. They must not share crew
state, directories, gateway databases or Slack app credentials. Separate
directories are logical isolation, not OS sandboxes. Configuring the same
agent ID differently in two locations does not merge their sessions.

## 1. Pin prerequisites

Start in the approved Pogo checkout, not a dirty development tree:

```sh
git rev-parse HEAD
git status --short
mise install
make deps
make hooks-install
make check
opencode --version
opencode service status
opencode api get /api/info
```

`mise.toml` pins Bun and Mesij; `bun.lock` pins packages. Record the installed
OpenCode V2 version separately. The implementation was checked with OpenCode
2.2.5. Do not assume an arbitrary later version has the same plugin contract.

Follow [proxy bootstrap](cliproxyapi.md) only if this host lacks an approved
proxy. Verify required model IDs through authenticated discovery without
printing credentials. Authentication and model availability cannot be copied
from a template. [Global child-agent setup](agents/agent-profiles.md) is
optional, requires discovery/approval, and does not create crew root sessions.

## 2. Define the team once

Copy [`teams/pegasus.example.json`](../teams/pegasus.example.json) to a private
instance directory. Change its captain, crew, roles and explicit models before
initialization. Do not omit `--team`: omission selects the Bowser starter.
Do not infer authority from names. All trusted OpenCode profiles grant broad
host commands and edits, including `research`; specialisms guide assignments.
Review these grants before creating the profile. Pi tools remain explicit.

Set these non-secret inputs in the setup shell. Replace all placeholders:

```sh
umask 077
export INSTANCE=pegasus
export ROOT=/srv/pogo/pegasus
export PROJECT=/srv/projects/example
export BASE_COMMIT=REPLACE_WITH_FULL_PROJECT_COMMIT
export PROXY_URL=http://127.0.0.1:8317/v1
export PROXY_KEY_FILE=/srv/private/cliproxyapi-client.key
export SLACK_TEAM_ID=REPLACE_WITH_TEAM_ID
export SLACK_USER_ID=REPLACE_WITH_HUMAN_ID
export SLACK_CHANNEL_ID=REPLACE_WITH_CHANNEL_OR_DM_ID
export OPENCODE_URL=REPLACE_WITH_STABLE_OPENCODE_URL
```

`$ROOT/team.json` must exist before the next command. Do not put token values
in these variables. Quote paths. Use absolute paths. Confirm that the selected
base commit belongs to the intended project.

```sh
PROFILE_JSON="$(mise exec -- bun run src/main.ts crew init \
  --team "$ROOT/team.json" --id "$INSTANCE" \
  --directory "$ROOT/captain" --project "$PROJECT" \
  --worktrees "$ROOT/crew" --base "$BASE_COMMIT" \
  --proxy-url "$PROXY_URL" --proxy-key-file "$PROXY_KEY_FILE")" || exit 1
export PROFILE_JSON
```

Stop if initialization fails; export only successful output. It contains paths,
agent ID and permissions, not secrets. Repeating initialization with identical
inputs reuses matching files/worktrees; conflicts fail instead of overwriting
custom instructions. Initial branch names are `crew/<namespace>-<member ID>`.
Existing worktrees must remain on feature branches, not `main` or `master`.

Generated OpenCode configuration points at this Pogo checkout. Do not move it
or edit its source under a running installation. If `.agents/opco` exists,
initialization uses it and requires `.opencode` as its compatibility symlink.

## 3. Generate the registration plan from profile output

This avoids manually duplicating the captain agent or its permissions. Run from
the same checkout and shell. The snippet creates one plan, or accepts an exact
existing match. It refuses a changed plan. It does not contact Slack.

```sh
mise exec -- bun - <<'BUN'
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { botSchema } from "./src/config";

const env = z.object({
  INSTANCE: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  ROOT: z.string().startsWith("/"),
  PROFILE_JSON: z.string().min(1),
  SLACK_TEAM_ID: z.string().regex(/^T[A-Z0-9]+$/),
  SLACK_USER_ID: z.string().regex(/^[UW][A-Z0-9]+$/),
  SLACK_CHANNEL_ID: z.string().regex(/^[CGD][A-Z0-9]+$/),
  OPENCODE_URL: z.url(),
}).parse(process.env);
const profile = z.object({
  directory: z.string().startsWith("/"),
  agent: z.string().min(1),
  permissions: z.array(z.object({
    action: z.string(), resource: z.string(),
    effect: z.enum(["allow", "deny"]),
  })),
}).parse(JSON.parse(env.PROFILE_JSON));
const prefix = `POGO_${env.INSTANCE.toUpperCase().replaceAll("-", "_")}`;
const bot = botSchema.omit({ slack: true }).parse({
  id: env.INSTANCE,
  displayName: profile.agent,
  access: { users: [env.SLACK_USER_ID], channels: [env.SLACK_CHANNEL_ID] },
  backend: {
    type: "opencode", url: env.OPENCODE_URL,
    directory: profile.directory, agent: profile.agent,
    permissions: profile.permissions,
    headersEnv: { authorization: `${prefix}_OPENCODE_AUTHORIZATION` },
  },
});
const plan = { version: 1, teamId: env.SLACK_TEAM_ID, bots: [{
  ...bot, name: `Pogo ${profile.agent}`, app: { mode: "create" },
  slack: { appTokenEnv: `${prefix}_APP_TOKEN`, botTokenEnv: `${prefix}_BOT_TOKEN` },
}] };
const directory = join(env.ROOT, "config");
await mkdir(directory, { recursive: true, mode: 0o700 });
const path = join(directory, "bots.json");
const text = `${JSON.stringify(plan, null, 2)}\n`;
try {
  await writeFile(path, text, { flag: "wx", mode: 0o600 });
} catch (error) {
  if (error.code !== "EEXIST" || await readFile(path, "utf8") !== text)
    throw new Error("Plan exists with different inputs or cannot be written.");
}
console.log(path);
BUN
```

For an already created **unused** Slack app, select `app.mode: "reuse"` and
its exact `appId` before first application. Do not change a checkpointed plan
to reconcile an uncertain creation. Use `--record-app` instead.

Plan, review, then apply after approval:

```sh
mise exec -- bun run src/main.ts bot provision \
  --plan "$ROOT/config/bots.json" --config "$ROOT/config/pogo.json" --json
mise exec -- bun run src/main.ts bot provision \
  --plan "$ROOT/config/bots.json" --config "$ROOT/config/pogo.json" --apply --json
```

Follow [Slack setup](setup.md#api-creation-or-browser-creation) for browser
creation, installation and private token storage. Use the same plan, config
and journal on every retry. Known registrations are reused. An uncertain
Manifest API outcome stops automatic retries; never delete its journal.

## 4. Supply authentication in the correct process

| Reference                                          | Process that needs the value                               |
| -------------------------------------------------- | ---------------------------------------------------------- |
| `POGO_PEGASUS_APP_TOKEN`, `POGO_PEGASUS_BOT_TOKEN` | New gateway only                                           |
| `POGO_PEGASUS_OPENCODE_AUTHORIZATION`              | Gateway; actual authorization header value                 |
| `{file:…/client.key}` in generated providers       | OpenCode service reads the private file                    |
| Pi `backend.provider.apiKeyEnv`                    | OpenCode plugin host for crew; gateway for a direct Pi bot |
| Linear OAuth                                       | OpenCode's credential store on this host                   |

Store gateway values through a password manager or hidden-input terminal in
`$ROOT/config/pogo.json.env`, mode `0600`, or its process environment. Never
request them in chat, pass them as arguments or print them. Do not source this
file as shell code; Pogo and systemd load it as environment data.

Managed OpenCode authentication requires `Service.discover()` and
`Service.headers(endpoint)` from the installed `@opencode/client/service` in a
local launcher, or another operator-approved private header source. Do not
guess its authorization value, disable authentication, or copy another host's
credentials. `opencode api` uses this discovery automatically; Pogo's normal
service unit does not. Arrange that launcher or a stable authenticated endpoint
before service installation. A discovered port can change after a service
restart. Changing `backend.url` changes Pogo's backend namespace and therefore
selects new thread mappings; do not rewrite it silently on a live installation.

Pi reporters are optional. To use one, add a named Pi member before profile
initialization using the [Twiki configuration](agents/default-opencode.md#pi-durable-crew),
then set the plan's `crewActivity` to `summary` or `detailed` with that member's
ID as `reporter`. The default is `off`. Its proxy-key variable must exist in
the plugin host, not merely in `pogo.json.env`. Reporting uses a tools-free
context even if maintenance has coding tools. Do not add a second Slack bot.

## 5. Validate, then start only the new instance

```sh
mise exec -- bun run src/main.ts config check \
  --config "$ROOT/config/pogo.json" --schema-only
mise exec -- bun run src/main.ts config check --config "$ROOT/config/pogo.json"
```

Schema validation and token-prefix checks do not prove authentication or
inference. Verify native agent IDs, provider models and Pogo plugin tools in
each generated OpenCode location. A config save reloads OpenCode; do not
restart a shared healthy service to apply profiles. Read-only Linear discovery
is separate from write permission and OAuth sign-in.

After the operator approves a model smoke test and startup, run the new config
in the foreground. Check one mention, a same-thread follow-up, and one bounded
crew assignment. Confirm that the worker session's native OpenCode agent is
its assigned ID. The captain should ensure the configured roster through
`pogo_crew`; do not create duplicate root sessions manually. Verify a denied
request cannot trigger work and an existing installation still works.

Only after foreground checks pass, and with service approval:

```sh
mise exec -- bun run src/main.ts service install \
  --config "$ROOT/config/pogo.json" --name "pogo-$INSTANCE"
mise exec -- bun run src/main.ts service start \
  --config "$ROOT/config/pogo.json" --name "pogo-$INSTANCE"
mise exec -- bun run src/main.ts service status --name "pogo-$INSTANCE"
```

Stop the foreground listener before service startup. The normal unit uses the
current Bun binary and checkout, loads `<config>.env`, and does not discover
OpenCode credentials. It refuses an existing unit. Add any approved launcher
override before starting it. Enabling at login is a separate action. Never
reuse a live instance's unit or copy machine-specific service files.

## Retry, upgrade and rollback rules

- Identical `crew init` inputs and `bot provision --apply` are repeatable;
  service installation deliberately refuses an existing unit.
- Preserve team IDs, paths and namespace after first use. Model switches use
  the supported session API, not roster replacement. A renamed installation
  needs an explicit state migration; a new team needs fresh paths/namespace.
- Back up gateway and crew SQLite databases with SQLite's backup API at an
  idle boundary. Keep credentials and backups private. Do not copy only a live
  `.sqlite` file while ignoring its WAL. Retain session IDs and task ownership.
- Pin upgrades to verified releases. Save prior config, overlays, unit and
  release references before changing them. Do not repoint plugins to a dirty
  development checkout. Keep rollback schema compatibility explicit.
- An interrupted task can have external effects. Do not replay uncertain
  tasks, clear reservations or delete state as a recovery shortcut.
- Record the release commit, tool versions, non-secret input hashes, generated
  paths, Slack App ID and verification results. Exclude token values, raw API
  responses, OAuth state, prompts and session transcripts from shared notes.

Setup is complete only after authenticated Slack → captain → crew → Slack
verification succeeds and existing instances remain unchanged. A new instance
has not been created merely because these templates exist.

## Search readiness

Follow [session, documentation and code search](knowledge-search.md). Verify
`pogo_history` and stored permissions in each existing session. For an Indra
target, run `make wiki-setup` in the project and each crew checkout, then one
wrapper keyword search per checkout. Keep the CLI on the agent host's PATH.
Load Indra's existing `indra-qmd` guidance; do not create a global mixed-project
index. These checks need no embedding downloads or provider inference.
