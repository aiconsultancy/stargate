# Nightly maintenance

Pogo can keep itself and its host dependencies up to date in a nightly
maintenance window. One `pogo maintenance run` per night:

1. updates Pogo to the newest verified GitHub release;
2. updates CLIProxyAPI and the agent CLIs (OpenCode, Codex, Claude Code, Pi);
3. moves child-agent profiles and live captain/crew sessions to a newer model
   of the same family when the proxy offers one;
4. writes a private JSON report and sends one summary to Slack.

Every change waits for an idle boundary. Nothing interrupts active captain,
crew, Pi, cron or gateway work. A change that is not done before the window
deadline waits for the next night. Each change has a health check and an
automatic rollback.

Maintenance is off by default. Every component is also off by default.

## Configuration

Add a top-level `maintenance` section to `pogo.json`. The schema is strict;
`pogo config check --schema-only` validates it. Example (the Galactica install):

```json
"maintenance": {
  "enabled": true,
  "window": {
    "start": "00:00",
    "end": "01:00",
    "timeZone": "Europe/London",
    "jitterMinutes": 15,
    "reserveMinutes": 10
  },
  "components": {
    "pogo": true,
    "cliproxyapi": true,
    "agentClis": true,
    "models": true
  },
  "report": { "bot": "galactica-captain", "channel": "C0EXAMPLE04" },
  "services": {
    "gateway": "galactica-pogo.service",
    "openCodeRestart": ["systemctl", "--user", "restart", "opencode2.service"]
  },
  "proxy": {
    "url": "http://127.0.0.1:8317",
    "clientKeyFile": "/home/operator/.config/cliproxyapi/client.key"
  },
  "pogo": {
    "root": "/home/operator/.local/share/pogo",
    "checkout": "/home/operator/.local/share/pogo/source.git"
  },
  "cliproxyapi": {
    "unit": "galactica-cliproxyapi.service",
    "link": "/home/operator/.local/share/cliproxyapi/cliproxyapi-current",
    "binary": "/home/operator/.local/share/cliproxyapi/{version}/cliproxyapi"
  },
  "agentClis": {
    "prefix": "/home/operator/.local",
    "npm": ["/opt/node/bin/npm"],
    "lockFile": "/home/operator/.local/state/agent-updates/update.lock"
  },
  "models": {
    "agentProfiles": "/home/operator/.config/opencode/agent-profiles",
    "teamFiles": ["/home/operator/.config/pogo/galactica-captain/team.json"]
  }
}
```

| Setting                                   | Default                                                             | Meaning                                                                                                         |
| ----------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `enabled`                                 | `false`                                                             | `run` refuses to start when false. `plan` always works.                                                         |
| `installID`                               | hash of host and config path                                        | Stable identity for jitter and reports.                                                                         |
| `window.start`, `window.end`              | `00:00`, `01:00`                                                    | Local wall-clock times; the end can be after midnight.                                                          |
| `window.timeZone`                         | `Europe/London`                                                     | IANA zone. Daylight saving time applies.                                                                        |
| `window.jitterMinutes`                    | `15`                                                                | Maximum per-install start delay.                                                                                |
| `window.reserveMinutes`                   | `10`                                                                | No new change starts in the last N minutes; they are kept for rollback.                                         |
| `components.*`                            | `false`                                                             | `pogo`, `cliproxyapi`, `agentClis`, `models`. Each needs its section.                                           |
| `report`                                  | none                                                                | Bot and channel for the Slack summary. The channel must be allowed for the bot.                                 |
| `services.gateway`                        | `pogo.service`                                                      | User unit of this gateway.                                                                                      |
| `services.openCodeRestart`                | `systemctl --user restart opencode2.service`                        | Command that restarts the shared OpenCode server.                                                               |
| `idle.pollSeconds`                        | `30`                                                                | Idle-gate poll interval.                                                                                        |
| `idle.cronHorizonMinutes`                 | `60`                                                                | A cron schedule due within this time blocks maintenance.                                                        |
| `proxy.url`, `proxy.clientKeyFile`        | loopback `:8317`, required                                          | CLIProxyAPI endpoint and its private client-key file (mode 0600).                                               |
| `pogo.root`                               | required                                                            | Install root. See [install layout](#install-layout).                                                            |
| `pogo.repository`, `pogo.branch`          | `aiconsultancy/pogo`, `main`                                        | Release source.                                                                                                 |
| `pogo.tokenEnv`                           | none                                                                | Environment variable with a read-only GitHub token. Without it, Pogo uses `gh auth token` if `gh` is available. |
| `pogo.author`                             | `github-actions[bot]`                                               | The only accepted release and asset author.                                                                     |
| `pogo.checkout`                           | none (required)                                                     | Local clone (bare is fine) for the tree comparison. Without it the update fails closed (`not-configured`).      |
| `pogo.requireTreeCheck`                   | `true`                                                              | `false` accepts releases without the tree comparison. Not recommended: see [Pogo releases](#pogo-releases).     |
| `pogo.coolOffHours`                       | `0`                                                                 | Release age before install. Pogo releases are this project's own CI output.                                     |
| `pogo.keep`                               | `3`                                                                 | Managed releases kept, always including `current` and `previous`.                                               |
| `pogo.installCommand`, `pogo.testCommand` | `bun install --frozen-lockfile`, `bun test`                         | Run in the new release directory before the switch.                                                             |
| `cliproxyapi.link`                        | required                                                            | Stable symlink that the proxy unit's `ExecStart` runs.                                                          |
| `cliproxyapi.binary`                      | required                                                            | Installed binary path with `{version}`.                                                                         |
| `cliproxyapi.asset`                       | `CLIProxyAPI_{version}_linux_amd64.tar.gz`                          | Release asset to download; its GitHub SHA-256 digest is pinned.                                                 |
| `cliproxyapi.executable`                  | `cli-proxy-api`                                                     | Executable inside the asset, installed as `binary`.                                                             |
| `cliproxyapi.coolOffHours`                | `24`                                                                | Minimum age of the release and of each of its assets.                                                           |
| `agentClis.prefix`                        | required                                                            | npm global prefix.                                                                                              |
| `agentClis.packages`                      | the four CLIs below                                                 | `{ name, command }` pairs.                                                                                      |
| `agentClis.allowScripts`                  | `@opencode/cli`, `@anthropic-ai/claude-code`, `protobufjs`, `koffi` | Only these may run install scripts (`--strict-allow-scripts`); empty: `--ignore-scripts`.                       |
| `agentClis.lockFile`                      | none                                                                | Shared `flock` lock of an existing updater.                                                                     |
| `agentClis.coolOffHours`                  | `24`                                                                | Minimum npm publication age, also for dependencies (`--before`).                                                |
| `models.families`                         | Claude Opus, Sonnet, Haiku; GPT Sol, Terra, Luna                    | Families that can move automatically.                                                                           |
| `models.providers`                        | `openai-proxy`, `claude-proxy`                                      | OpenCode providers that route through the proxy.                                                                |
| `models.agentProfiles`                    | none                                                                | Global child-agent profiles directory.                                                                          |
| `models.teamFiles`                        | `[]`                                                                | Team JSON files whose models follow upgrades.                                                                   |
| `models.probes`                           | `2`                                                                 | Maximum health probes per current model and night.                                                              |
| `droid`                                   | none                                                                | Monitoring agent; see [Maintenance droid](#maintenance-droid).                                                  |

Default agent CLIs: `@opencode/cli` (`opencode2`), `@openai/codex` (`codex`),
`@anthropic-ai/claude-code` (`claude`), `@earendil-works/pi-coding-agent` (`pi`).

Never put token values in `pogo.json`. Put a release token, if you use one, in
the private `<config>.env` companion and reference its name in `tokenEnv`.

## Window, jitter and daylight saving time

The window opens at `start` local time on each calendar day in `timeZone`.
Each install adds a stable jitter of 0 to `jitterMinutes` minutes. The jitter
comes from a SHA-256 of `installID`, so installs do not all start together and
one install always starts at the same local time.

Local times convert to instants with the "compatible" rule: a time that a
spring-forward gap skips moves forward by the gap; a time that a fall-back
night repeats uses the earlier instant. For the default Europe/London window
this means:

- 00:00 to 01:00 GMT in winter and 00:00 to 01:00 BST in summer;
- on the spring-forward night the window is 00:00 to 01:00 GMT (01:00 local
  does not exist, so the end is the transition instant);
- on the fall-back night the window ends at the first 01:00 (BST).

No change starts after `end - reserveMinutes`. A deferred or incomplete run
leaves the remaining work for the next night. `pogo maintenance window` prints
the window, the jitter and the next start.

## What one run does

1. **Recover.** The run writes its ID and systemd's `INVOCATION_ID` to
   `maintenance/last-run.json` before anything else. A journal left by an
   interrupted run is finished first (see
   [Journal and recovery](#journal-and-recovery)). If the journal holds
   `gateway` and the gateway unit is not running, the run starts it at once
   and waits for its readiness record: starting a stopped gateway interrupts
   nothing, and only a ready gateway advances its cron schedules. The undo
   itself waits for the idle gate, because it restarts services too, and the
   gate runs again immediately before each undo step that changes live
   state: the session switch-back, the config restore, the CLI reinstall
   and every restart of a running proxy, OpenCode or gateway. Work that
   arrives during a long undo stops it there. Busy: the rest of the journal
   stays, the run is `deferred` and writes an alert. If the undo fails, the
   run stops with `recovery-required` and changes nothing.
2. **Discover (read-only).** Current and candidate versions of each component;
   proxy model catalog; models in use. A captain or crew profile that exists
   but cannot be read fails closed (`idle-unknown`).
3. **Prepare (no live change).** Download, verify, unpack, install and test the
   Pogo release in its own directory. Download, verify and install the new
   CLIProxyAPI binary in its own version directory. Probe new models.
4. **Idle gate.** Poll until idle or until the deadline. If never idle, the run
   writes a `deferred` report and stops.
5. **Agent CLIs.** Journal the previous versions and their cutoffs, then one
   `npm install --global` with exact versions, `--before=<now - cool-off>` and
   `--strict-allow-scripts`. Each command must report its new version. A
   failure reinstalls the previous versions with their recorded cutoffs.
   Running servers keep the old binaries until the restart below.
6. **Time budget.** The forward path from here has a computed worst case
   (every step at its timeout; live sessions add only the fixed session-phase
   cap, not a cost per session). If the window end is closer than that, the run
   undoes step 5 and defers (`deadline`).
7. **Stop the gateway.** The idle gate runs immediately before the stop and
   again after it. Busy: undo and defer.
8. **CLIProxyAPI.** Idle gate, journal the current link target, point the
   stable link at the new binary, restart the unit, require `GET /v1/models`.
   On failure, restore the link and restart again. If even the old proxy does
   not answer, the run stops: no release or model change happens tonight. After
   a successful update, chosen models are probed again through the new proxy.
9. **One OpenCode restart.** Idle gate, then without delay: journal and
   switch `current` (Pogo), journal and write model configuration, restart
   OpenCode, require every captain/crew location to report its Pogo plugin.
   On failure the run undoes, one at a time, the release switch, the model
   configuration and the CLI update, restarting after each. The CLI update is
   committed here.
10. **Live sessions.** Each pinned captain session and OpenCode crew session
    is journalled _before_ its switch, then switched (provider and variant
    kept) and read back. The selected profile's new child agents must load
    with their new models. Any failure switches every journalled session back
    and restores the configuration. This phase has a fixed cap (5 minutes):
    when it ends, the remaining sessions keep their old, still valid model and
    are reported as `skipped` with reason `deadline`.
11. **Start the gateway** and wait for a new readiness record with the version
    of the release `current` points to. On failure the run records the release as known-bad,
    restores the previous release, restarts OpenCode and the gateway, and
    waits again. If the gateway still is not ready, the journal stays, the
    run exits 1 and writes an alert.
12. **Prune** old releases and write the report.

Every abnormal end (exception, `SIGTERM`, timeout) applies the same journal
undo as `pogo maintenance recover`.

## Journal and recovery

`<dataDirectory>/maintenance/journal.json` (schema
`pogo.maintenance.journal.v2`) records each live change _before_ it happens and
drops it once it is verified:

| Entry         | Data                                     | Undo                                                     |
| ------------- | ---------------------------------------- | -------------------------------------------------------- |
| `clis`        | package `name`, `before` version, cutoff | Reinstall each previous version with its recorded cutoff |
| `gateway`     | `restartPending`                         | Restart unless the current release is ready and running  |
| `cliproxyapi` | `previousVersion`                        | Point the link back, restart, `GET /v1/models`           |
| `release`     | `previous` release name, new `version`   | Restore `current`                                        |
| `files`       | none (manifest in `backups/<runID>/`)    | Restore files and remove new links (see below)           |
| `sessions`    | session ID and previous model            | Switch back and read back, at most 5 minutes             |
| `openCode`    | `restarted`, `restartPending`            | Restart OpenCode while `restartPending` is set           |

The journal is data, never instructions. Unit names, restart commands, npm
settings, paths, the proxy endpoint and the key file always come from the
configuration. The journal and the maintenance directory must be owned by the
current user and closed to others (0600 and 0700). A journal with unknown
keys, a package that is not configured, a version that is not strict
`X.Y.Z`, an unsafe release name, a session on an unconfigured provider, or a
run ID that is not a UUID is corrupt: nothing in it is undone.

An undo that leaves a loaded change behind sets `restartPending` (OpenCode)
or `gateway.restartPending` _before_ it removes the entry that caused it, so
a recovery that is itself interrupted still restarts on the next pass. A
gateway counts as recovered without a restart only if no restart is pending,
the unit is `active`, the ready process is alive and its version is the
release `current` points to. A proxy whose link already points at the
previous binary and that answers is not restarted again.

Configuration backups (`backups/<runID>/N.json`, 0600 in a 0700 directory)
hold the old content and the SHA-256 of what maintenance wrote. A file is
restored only while it still holds what maintenance wrote; a link is removed
only while it still points where maintenance pointed it. Anything else was
changed by someone else: the entry stays, the recovery fails and an alert is
written. Only configured team files, discovered captain/crew `opencode.json`
files, `routes.json`, `PROFILE` and `*-subagent.md` in managed profile folders,
and `agents/<name>-subagent.md` links into `agent-profiles/current` are ever
restored.

Each entry is removed only after its undo is verified, so a partial recovery
can be repeated. Only a missing journal means "nothing to recover". A
corrupt journal is kept; recovery starts the configured gateway, exits 1 and
the next run refuses to proceed until an operator inspects it (see
[When recovery cannot proceed](#when-recovery-cannot-proceed)).

Who recovers:

- the run itself, on any abnormal end (exception, `SIGTERM`, timeout);
- the timer service's `ExecStopPost` (`recover --after-run`), only for the
  journal of the run that this systemd invocation started: `last-run.json`
  must hold the current `INVOCATION_ID` and the journal's run ID, because
  only that run held the idle gate. Its undo runs with the gateway still
  stopped, and the gateway is started last. A file left by an earlier run
  (one that exited before it wrote its own, for example disabled, outside the
  window or with the lock busy) does not match. For any other journal,
  `--after-run` only starts a stopped gateway when the journal holds
  `gateway`;
- the next run, after its idle gate and with the gate again before each
  undo step that changes live state (see step 1);
- the maintenance droid's `recover`, through the same path (see
  [Maintenance droid](#maintenance-droid));
- an operator with `pogo maintenance recover`, unconditionally.

The run commits a verified release before it drops the `gateway` entry, so
a kill between the two leaves only `gateway`, which a ready gateway of the
current release satisfies.

`recover` takes the run lock; while a run holds it, `recover` changes nothing
and exits 1. The previous journal schema (v1) and the first version's
`gateway-stopped.json` marker are still read. Their commands and paths must
equal the configured ones, otherwise they are corrupt; only their data is
used.

Files that need an operator:

- `maintenance/ALERT.json` (`pogo.maintenance.alert.v1`): written when the
  outcome is `failed`, the journal remains, the gateway did not become ready,
  the run was aborted or the report could not be written. It names the run,
  reason and report. Delete it after review. The
  [maintenance droid](#maintenance-droid) reads it with the reports.
- `maintenance/state.json`: the npm cutoff that produced each installed CLI,
  pinned CLIProxyAPI digests, and releases that failed after a switch.

### When recovery cannot proceed

Recovery stops with `external-change` when a file or link changed after
maintenance wrote it, and with a corrupt journal when the journal is not
private, has unknown keys or names something outside the configuration.
It never guesses. To get out:

1. Read `maintenance/ALERT.json`, the last report and the `recover` output.
2. List what one entry still covers, without changing anything:

   ```sh
   pogo maintenance recover --config pogo.json --accept-current files
   ```

   For `files`, each path shows whether it still holds what maintenance
   wrote, is already restored, or was changed by someone else. The old
   content of every file is in `backups/<runID>/N.json` (`old`). Other
   entries show the release link, CLI versions, proxy link, sessions, unit
   or the owed OpenCode restart.
3. Decide for each listed path. To keep the current content, do nothing. To
   return to the state before maintenance, restore it by hand from the
   backup.
4. Drop that entry, then finish the others:

   ```sh
   pogo maintenance recover --config pogo.json --accept-current files --yes
   pogo maintenance recover --config pogo.json
   ```

For a corrupt journal, read `journal.json` (or `gateway-stopped.json`), undo
by hand what it names (the `current` release link, CLI versions, the proxy
link, session models), then move it aside with
`--accept-current journal --yes`. It is renamed to
`journal.accepted-<time>.json`, never deleted. `--accept-current` takes the
run lock and refuses while a run holds it.

## Pogo releases

Each merge to `main` publishes `vX.Y.Z` with `pogo-vX.Y.Z.tar.gz` (a
`git archive --prefix=pogo-vX.Y.Z/`) and `pogo-vX.Y.Z.tar.gz.sha256`. GitHub
artifact attestations are not available for the organization, so Pogo does
not use `gh attestation verify`. The tree comparison against a local clone
replaces it and is required by default. A release is used only if all of these
pass; any failure fails closed:

- the SHA-256 of the archive equals the published `.sha256` line for exactly
  that file name;
- the release author and both asset uploaders are `pogo.author`
  (`github-actions[bot]`); a missing uploader fails;
- every asset is past the cool-off by its own `created_at` and `updated_at`;
- the tag's commit is reachable from `pogo.branch` on GitHub (the compare API
  reports the branch `ahead` of or `identical` to the commit);
- the local tag in `pogo.checkout` resolves to the same commit, and the
  unpacked archive tree equals `git archive` of that commit (paths, types,
  executable bits, file contents and symlink targets; not compressed bytes).
  An existing local tag with another commit is refused, never overwritten.
  With `requireTreeCheck: false` this check is skipped and a compromised
  CI token could publish a matching archive and checksum: keep the default;
- the archive headers are checked before `tar` runs: one real top-level
  directory named `pogo-vX.Y.Z`, only regular files, directories and symlinks
  that stay inside it; no absolute paths, `..`, duplicates, entries below a
  symlink, hard links, devices or FIFOs. Only POSIX ustar headers (and old-GNU
  headers whose GNU area is empty, as Go's tar writer emits) are accepted.
  Per-file pax headers may carry only `path` and `linkpath`. The only global
  pax header allowed is `git archive`'s first header with exactly one
  `comment=<commit ID>` record; tar would apply any other global key to every
  later entry. GNU long names (`L`, `K`), sparse files (`S`, `GNU.sparse.*`)
  and every other type are refused. The decompressed archive is capped at
  1 GiB, which caps what `tar` can write. After extraction every path is
  checked again with `lstat`: the tree must hold exactly the validated
  entries, with the same types and link targets, and no hard links. Then
  every symlink is resolved through its whole chain (`realpath`) and must end
  inside the release directory: links that each look contained can still
  leave the tree together (`deep/back -> ..` plus
  `escape -> deep/back/../../outside`). A dangling link is refused too; the
  repository contains no symlinks;
- `bun install --frozen-lockfile` and `bun test` pass in the new directory.
  They run with a minimal environment (`PATH`, a private `HOME` and `TMPDIR`
  inside the staging directory, `LANG`): no inherited tokens, proxy keys or
  session bus, and no way to find the live OpenCode service.

A release that failed plugin loading or gateway readiness after a switch is
recorded in `state.json` and skipped (`known-bad`) until a newer release
exists.

All GitHub requests follow redirects manually and drop the token on any
cross-origin hop. Releases are newer only by semantic version, so this never
downgrades.

### Install layout

```text
<root>/releases/<version>/      unpacked, installed and tested release
<root>/releases/<name>/.pogo-release.json   marks a managed release
<root>/current -> releases/<version>        launchers and plugins load this
<root>/previous -> releases/<version>       rollback target
<root>/deployment-plugin/index.ts           optional install-specific wrapper
```

Launchers, the gateway unit and every captain/crew `opencode.json` plugin
`package` reference `current` (directly or through the wrapper). OpenCode
loads a plugin once per process, so a release switch restarts the shared
OpenCode server. `.staging-*` and `.failed-*` directories are this tool's own
temporary folders; pruning removes them.

The gateway writes `<dataDirectory>/ready.json` after every bot connected. The
record holds the process, time and release version from `.pogo-release.json`.

## CLIProxyAPI

The proxy unit must run a stable symlink, not a versioned path, so that a
switch and its rollback do not edit the unit. Candidates come from GitHub
releases of `router-for-me/CLIProxyAPI`: stable, not draft, not pre-release,
newer than the linked version, and past `coolOffHours` by the release's
publication time _and_ every asset's creation and update time, so a replaced
asset on an old release does not bypass the age rule. Pogo downloads
`cliproxyapi.asset` itself, requires GitHub's `sha256:` digest for it,
verifies the download, validates the archive headers (the same rules as Pogo
releases), extracts only `cliproxyapi.executable`, checks with `lstat` that
exactly that one regular file was written, and installs it as
`cliproxyapi.binary` for that version. The installed binary must be a regular
file with one link, before and after the install. An existing different
binary at that path is never replaced. The asset and binary
digests are recorded in `state.json` and the report. The health check is
`GET /v1/models` with the client key from `proxy.clientKeyFile`; the key is
never logged, printed or reported. mise no longer installs the proxy.

## Agent CLIs

Only installed packages are updated; maintenance never adds a CLI. For each
package, the candidate is the newest stable npm version that is not
deprecated, not above `dist-tags.latest`, and published at least
`coolOffHours` ago. The install uses exact versions and `--before`, so
dependencies obey the same cool-off. The previous version is read from
`<prefix>/lib/node_modules/<name>/package.json`. The health check runs
`<prefix>/bin/<command> --version`. With `lockFile`, the install runs under
`flock --nonblock` on the old updater's lock.

Install scripts run only for `allowScripts`: `--strict-allow-scripts` makes
an unlisted script a failed install (plain `--allow-scripts` only warns), and
an empty list adds `--ignore-scripts`. A rollback reinstalls the previous
version with the cutoff that produced it (recorded in `state.json` when
maintenance installed it), else with that version's own publication time;
never a fresh cutoff, which could pull newer dependencies. A package with
neither is not updated.

## Model upgrades

Known families and their version order:

| Family          | Pattern                           | Order example                                                |
| --------------- | --------------------------------- | ------------------------------------------------------------ |
| `claude-<name>` | `claude-<name>-<major>[-<minor>]` | `claude-opus-5-5` < `claude-opus-5-6` < `claude-opus-6`      |
| `gpt-<name>`    | `gpt-<major>[.<minor>]-<name>`    | `gpt-6-luna` < `gpt-6.1-luna`; `gpt-6.1-sol` < `gpt-6.2-sol` |

A missing minor version counts as zero, so `claude-opus-6` equals
`claude-opus-6-0` and neither replaces the other. Suffixed products
(`gpt-6.1-sol-fast`, dated snapshots) and unknown families never move. A model
moves only to a strictly newer member of its family, so there is no
downgrade. The newest candidate must:

1. be listed by the proxy's `GET /v1/models`;
2. pass a one-message probe through the proxy in the provider's protocol
   (`POST /v1/messages` for `claude-*`, `POST /v1/responses` for GPT; at most
   16 output tokens; at most `probes` per model and night; a failed newest
   candidate falls back only to a newer-than-current one);
3. already be in OpenCode's live model catalog, globally and at every captain
   and crew location, with each variant in use (`#high`, ...).

Pogo does not edit OpenCode provider declarations. A model that the proxy
offers but OpenCode does not list is reported as `catalog-missing`.

Changed places, keeping provider prefixes and variants:

- **Child-agent profiles** (`models.agentProfiles`, every managed profile
  folder). Agent names carry the model version, so a route moves to a new
  name: `opus-5-5-high-subagent` becomes `opus-5-6-high-subagent`. Every
  profile folder gets the new file (disabled where the profile does not route
  it); an old name that is no longer routed is disabled; `routes.json` and
  `PROFILE` are updated; `agents/<new>.md` links are only added. A route whose
  name does not start with its model token is reported and left unchanged.
- **Team files** (`models.teamFiles`): `captain.model` and OpenCode crew
  `model` fields. Pi workers keep `backend.model`: it is part of the crew
  identity.
- **Generated captain/crew `opencode.json`**: default `model`, agent models and
  the plugin's team models.
- **Live sessions**: pinned captain sessions (`backend.sessionID`) and
  OpenCode crew sessions, through `session.switchModel`, within the
  session-phase cap. Per-thread Slack sessions of unpinned bots are not
  switched; they keep their model, which stays valid.

`pogo.json` is never rewritten: a bot's `backend.model` is part of its
backend fingerprint, so a change would select a new bot key and orphan every
Slack thread mapping. Update `backend.model` by hand, with a planned
namespace change, if new unpinned sessions should start on the new model.

After the reload, only the new agents that the selected profile
(`agent-profiles/current`) routes must load with their new models; the
disabled copies in other profiles are not loaded and not checked.

JSON files are rewritten only when they use Pogo's canonical two-space layout;
a differently formatted file is reported as `config-format` and left alone.
A symlinked file (for example from a dotfiles repository) keeps its link; its
real target receives the change.

## Idle gate

All of these must be true, observed read-only:

- no gateway job is `queued`, `running` or `responding`;
- no cron schedule is due within `cronHorizonMinutes`, and no cron run is
  `pending`, `announcing`, `announced`, `queued` or `blocked`. A schedule
  that is already overdue counts only while the gateway runs it: its ready
  record names a live process and the unit is not `inactive` or `failed`
  (any other unit state, including an unknown one, counts as running). A
  stopped or crash-looping gateway never advances it, and would otherwise
  block its own recovery forever;
- for each crew found through the gateway's OpenCode bots: no task is
  `dispatching`, `running` or `cancelling`, no assignment is queued and no
  worker controller is held; no Pi task is outside `terminal`;
- no OpenCode session on the shared server is running (`session.active`), and
  no form or permission request is pending at any loaded location.

The OpenCode condition covers the whole server because a server restart
interrupts every session, including interactive ones. An unreadable source is
busy (`idle-unknown`): this includes a captain or crew profile that exists but
cannot be read or parsed, a dangling profile link, unparsable Pogo plugin
options and a configured OpenCode member without a profile. Symlinked profiles
are followed. The gate never changes, cancels or replays work.

The gate runs again immediately before each disruptive action: the gateway
stop, the proxy restart and the OpenCode restart (and once after the stop).

## Reports

Each `run` writes `<dataDirectory>/maintenance/reports/<startedAt>-<runID>.json`
(mode 0600). `plan` writes nothing. A report is always written: arrays and
long fields are truncated to fixed bounds and counted in `truncated`; a write
failure does not change the outcome and leaves an alert. Reports contain versions, reason codes,
step names and private local paths. They never contain raw errors, command
output, prompts or credentials. Changed files are also copied, before the
change, to `<dataDirectory>/maintenance/backups/<runID>/`.

`pogo maintenance schema` prints the JSON Schema. Version policy: the
`schema` value is `pogo.maintenance.report.v1`. Additive optional fields keep
`v1`; renamed, removed or re-typed fields, and new required fields, change it.
Readers must reject an unknown `schema` value.

| Field                     | Meaning                                                                                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `schema`                  | `pogo.maintenance.report.v1`                                                                                                                                 |
| `runID`, `installID`      | Run UUID; stable install identity                                                                                                                            |
| `mode`                    | `run` (`plan` reports are printed only)                                                                                                                      |
| `outcome`                 | `no-op`, `completed`, `partial`, `rolled-back`, `deferred`, `failed` (`planned` in plan mode)                                                                |
| `reason`                  | Reason code for a deferral or failure                                                                                                                        |
| `window`                  | Zone, local start/end, and the instants `opens`, `plannedStart`, `deadline`, `closes`; `jitterMinutes`                                                       |
| `startedAt`, `finishedAt` | ISO-8601 instants                                                                                                                                            |
| `components[]`            | `id` (`pogo`, `cliproxyapi`, `npm:<package>`, `models`), `before`, `after`, `candidate`, `status`, optional `reason`, `cutoff` (npm), `digest` (proxy asset) |
| `models[]`                | `scope`, `target` (route, `file#/json/pointer` or session ID), `from`, `to`, `status`, optional `reason`                                                     |
| `steps[]`                 | `name`, `status` (`ok`, `failed`, `skipped`), `at`, optional `reason`                                                                                        |
| `rollbacks[]`             | `component`, `from`, `to`, `status` (`ok`, `failed`), optional `reason`                                                                                      |
| `restarts[]`              | `service` (`gateway`, `opencode`, `cliproxyapi`), `status`, `at`                                                                                             |
| `truncated`               | Optional: dropped items per array (bounds: 100 components, 1000 models, 300 steps, 300 rollbacks, 50 restarts)                                               |

Component `status`: `unchanged`, `planned`, `updated`, `rolled-back`,
`failed`, `skipped` (for example `migration-required`), `deferred`.
Model `scope`: `catalog` (a candidate rejected before any change),
`agent-profile`, `team-file`, `opencode-config`, `captain-session`,
`crew-session`. Model `status`: `planned`, `applied`,
`rolled-back`, `failed`, `skipped`.

Reason codes: `outside-window`, `window-too-short`, `deadline`, `locked`,
`busy-gateway`, `busy-cron`, `busy-crew`, `busy-pi`, `busy-opencode`,
`pending-input`, `idle-unknown`, `network`, `not-found`, `cool-off`,
`credentials-unavailable`, `checksum-mismatch`, `author-mismatch`,
`tag-not-on-branch`, `tree-mismatch`, `archive-invalid`, `install-failed`,
`tests-failed`, `switch-failed`, `restart-failed`, `readiness-failed`,
`health-failed`, `plugins-failed`, `version-mismatch`, `migration-required`,
`probe-failed`, `catalog-missing`, `config-format`, `session-switch-failed`,
`command-failed`, `timeout`, `not-configured`, `aborted`,
`recovery-required`, `known-bad`, `external-change` (a file or link changed
after maintenance wrote it; recovery keeps it and alerts), `unknown`.

### Slack summary

When `report` is set and the outcome is not `no-op` (or a component needs
attention, for example `migration-required`), the run queues one
bounded summary (at most 2,800 characters) in
`<dataDirectory>/maintenance/outbox/`. The running gateway posts it through
the report bot's normal Slack client within 30 seconds, as a new top-level
message. A notice is claimed by rename before the post; a crash or an
uncertain post is never repeated (`.claimed`, `.failed`). A channel that the
bot does not allow is refused.

## Maintenance droid

`pogo-maintenance-droid` is a Pi Durable agent built into Pogo. It monitors
nightly maintenance, explains each run in plain English and escalates
problems. It has no Slack app of its own: it posts through `report.bot` to
`report.channel`, with the same outbox as the run summary. Slack users cannot
address it. It is off by default.

The deterministic engine stays authoritative. Pogo decides when to check,
collects the facts, computes the findings, enforces every precondition and
limit, and writes the findings, the droid's actions and the operator commands
into each post itself. The model only chooses among four tools and writes the
explanation.

### Droid configuration

```json
"droid": {
  "enabled": true,
  "backend": {
    "model": "openai/opencode-go/deepseek-v4.1-flash",
    "provider": {
      "baseURL": "http://127.0.0.1:8317/v1",
      "apiKeyEnv": "POGO_GALACTICA_CLIPROXYAPI_API_KEY"
    }
  },
  "healthCheck": "12:00",
  "maxRecoversPerDay": 2
}
```

| Setting                   | Default                                  | Meaning                                                                                           |
| ------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `droid.enabled`           | `false`                                  | `droid` refuses to run when false. Requires `report`.                                             |
| `droid.backend.model`     | `openai/opencode-go/deepseek-v4.1-flash` | Pi model, as for Pi backends. This model requires `provider`, and `provider` requires this model. |
| `droid.backend.provider`  | none                                     | CLIProxyAPI endpoint and the name of the environment variable with its key (in `<config>.env`).   |
| `droid.healthCheck`       | `12:00`                                  | Daily health check, local time in `window.timeZone`.                                              |
| `droid.afterRunMinutes`   | `15`                                     | The post-run check starts this long after `window.end`.                                           |
| `droid.maxRecoversPerDay` | `2`                                      | `recover` requests per local day; `0` disables the action.                                        |
| `droid.reports`           | `7`                                      | Latest reports the droid reads.                                                                   |
| `droid.failedNights`      | `2`                                      | Failed or deferred runs in a row that count as a problem.                                         |
| `droid.timer`             | `pogo-maintenance`                       | Name of the maintenance timer (`install-timer --name`) whose status is checked.                   |
| `droid.timeoutMinutes`    | `5`                                      | Upper bound of one model answer, tool calls included.                                             |

Without `provider`, an `anthropic/` or `openai/` model uses `ANTHROPIC_API_KEY`
or `OPENAI_API_KEY` from the environment.

### One check

The droid timer starts `pogo maintenance droid` at `window.end` plus
`afterRunMinutes` and at `healthCheck`. One check:

1. **Facts (read-only, by Pogo code).** The latest `reports` reports, reduced
   to outcome, reason codes, changed components, failed steps, rollbacks and
   model counts; `ALERT.json`; whether a journal exists and its entry names;
   known-bad releases from `state.json` that are newer than `current`;
   `last-run.json`; the maintenance timer's `ActiveState`,
   `LastTriggerUSec`, `NextElapseUSecRealtime`, `Result` and
   `ActiveEnterTimestamp` (`systemctl --user show`); the `ActiveState` of
   the gateway, proxy and OpenCode units; `ready.json`; and the proxy's
   `GET /v1/models`. Never file contents beyond schema-checked fields,
   command output, environment values or credentials. Every text field is
   scrubbed before it is bounded, so a cut never lands inside a secret that
   the scrubber would have recognised whole: the values of every
   environment variable the configuration names (every `…Env` setting, and
   `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) are removed, then credential-looking
   text (`token=…`, `Bearer …`, Slack, GitHub and API keys, private keys) and
   control characters. Text that was already cut where it was written (the
   report writer marks its cuts with `…`) can end inside a secret: a prefix
   of 12 or more characters of a configured secret at a cut (end of text or
   line, or `…`) is removed too. The check message, every tool result (a
   plan's report before its summary is bounded) and every part of the post
   pass the same scrubber before any cut.
2. **Findings (deterministic).** While a maintenance run is active, its own
   stops and journal are expected and not reported.

   | Code                 | Condition                                                                       |
   | -------------------- | ------------------------------------------------------------------------------- |
   | `timer-inactive`     | Maintenance is enabled and its timer is not active or not installed.            |
   | `timer-missed`       | The timer was active before last night's planned start and did not fire for it. |
   | `alert`              | `ALERT.json` exists.                                                            |
   | `journal`            | An interrupted run left a journal.                                              |
   | `journal-corrupt`    | The journal is corrupt or not private.                                          |
   | `gateway-down`       | The gateway unit is not active, or it has no live readiness record.             |
   | `opencode-down`      | The OpenCode unit (from `services.openCodeRestart`) is not active.              |
   | `proxy-unhealthy`    | The proxy unit is not active, or `GET /v1/models` fails.                        |
   | `runs-failing`       | The last `failedNights` runs ended `failed` or `deferred`.                      |
   | `known-bad`          | A failed Pogo release newer than `current` blocks updates.                      |
   | `reports-unreadable` | A recent report cannot be read or has an unknown schema.                        |

3. **Trigger.** A report newer than the last one the droid explained means a
   run finished: this check always posts. Otherwise it is a health check,
   which posts only when there is a finding. A healthy health check asks no
   model and posts nothing.
4. **Model.** The droid asks its model, with the findings and the newest
   report in the message. The model may call its tools, then writes the
   explanation.
5. **Post.** One top-level message of at most 2,800 characters: a header,
   the explanation (at most 1,800 characters, scrubbed like the facts),
   `Droid actions:` (every request, refused ones too),
   `Checks:` (the finding codes) and `Operator commands:` for the findings.
   Slack receives it as plain text, so it cannot mention or link anyone.
6. **Fallback.** If the model cannot be opened, fails, times out or answers
   nothing, the explanation is Pogo's deterministic summary: the newest
   report and every finding. Alerts are never lost to a model failure.

`pogo maintenance droid --print` shows the facts' findings and the
deterministic post. It asks no model, runs no action and writes nothing.

### What the model can do

| Tool                  | Effect                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------ |
| `maintenance_status`  | The facts above and the findings. Read-only.                                               |
| `maintenance_reports` | Report digests, newest first. Read-only.                                                   |
| `maintenance_plan`    | `pogo maintenance plan` in process; returns its summary. Once per check; not during a run. |
| `maintenance_recover` | The run's leftover recovery in process, under the run lock. Preconditions below.           |

The droid's Pi Durable store has only these four tools installed: no shell,
files, network, systemd or Slack. A call of any other tool name fails, and a
tool call from an earlier, interrupted check does nothing. The droid never
runs `run` or `--accept-current`.

`maintenance_recover` runs only when all of these hold; otherwise Pogo
refuses it and the refusal is final for the check:

- it was not requested before in this check;
- fewer than `maxRecoversPerDay` recovers started today. The count is per
  local day in `window.timeZone`, kept in `state.json`, and checked and
  incremented in one update when the recover is admitted, with the date at
  that moment: a check that starts before midnight and recovers after it
  charges the new day. It is never pruned for the current day, and an
  unreadable `state.json` refuses every recover and counts today as spent;
- no maintenance run is active (`<timer>.service`);
- a journal is left, or the gateway unit is `inactive` or `failed`.

The recover then follows the run's own leftover recovery, not the operator
`recover`. It takes the run lock first (a held lock: nothing happens, not
even an idle check). It starts a stopped gateway that the journal names
(that interrupts nothing). Then the host must pass the idle gate, and the
gate runs again immediately before each undo step that changes live state.
Busy at any of these checks: the undo stops, the rest of the journal stays
for the next idle boundary, and the post says `recover deferred`. A deferred
recover counts against the daily limit.

Without a journal, `recover` has nothing to do: it never starts a gateway
that someone stopped. The post then says so and lists the operator commands.
An action that is still running when the model times out is not cut off: the
check waits for it before it posts.

### Session and files

Everything is in `<dataDirectory>/maintenance/droid/` (0700):

- `pi.sqlite`: the droid's Pi Durable store, separate from Pi bots and
  workers. It holds one conversation per local day (`conversation.json`
  names the current one), which bounds the history that a check sends to the
  model. At the start of each check, live work left by an interrupted check
  is aborted.
- `state.json` (0600): the last report the droid explained and the recover
  count per local day (today and at most six older days).
- `audit.jsonl` (0600): one JSON line per check, action request and result,
  model fallback and post, with the check ID. Past 512 KiB it keeps the
  newest 1,000 lines.
- `lock.sqlite`: one check at a time; a second check exits without work.

### Install the droid timer

```sh
pogo maintenance droid --config pogo.json --print
pogo maintenance install-droid-timer --config pogo.json --print   # review
pogo maintenance install-droid-timer --config pogo.json
systemctl --user enable --now pogo-maintenance-droid.timer
```

`install-droid-timer` writes `pogo-maintenance-droid.timer` and `.service`
(`--name` changes the name) like `install-timer`: it refuses to overwrite,
runs `daemon-reload` and enables nothing. The timer has one `OnCalendar` line
per check time in `window.timeZone`, with `Persistent=false`. The service is a
oneshot with the config companion as `EnvironmentFile` (for the provider
key), `UMask=0077` and `TimeoutStartSec` = `timeoutMinutes` + 3 (plan) + the
undo budget + 5 minutes. Reinstall it after you change the check times.

### Droid limits

- The post goes through the gateway outbox. While the gateway is down, the
  post waits in the outbox and is sent when the gateway starts. The audit log
  and `systemctl --user status pogo-maintenance-droid` show it before that.
- The model can misjudge or miss a problem. The findings, actions and
  commands in each post come from Pogo, not from the model.
- `pi.sqlite` keeps old daily conversations. It grows by a few small
  conversations per day; to reset it, stop the droid timer and delete the
  droid directory.

## Commands

```sh
pogo maintenance plan --config pogo.json [--json]   # read-only; no probes
pogo maintenance run --config pogo.json             # used by the timer
pogo maintenance window --config pogo.json
pogo maintenance instructions --config pogo.json
pogo maintenance install-timer --config pogo.json [--name NAME] [--print]
pogo maintenance adopt --config pogo.json --release DIR [--version X.Y.Z]
pogo maintenance recover --config pogo.json [--after-run]
pogo maintenance recover --config pogo.json --accept-current ENTRY [--yes]
pogo maintenance droid --config pogo.json [--print]
pogo maintenance install-droid-timer --config pogo.json [--name NAME] [--print]
pogo maintenance schema
```

`run` refuses to start outside the window; `--outside-window` runs now with the
window's length, for an operator-attended first run. Only one run holds the
lock in `<dataDirectory>/maintenance/run.sqlite`. Exit status is 1 for a
`failed` outcome and whenever an alert is written (journal left, gateway not
ready, aborted, report not written). `recover` exits 1 when a run holds the
lock, the journal is corrupt or its undo is incomplete. `--after-run` (used by
the timer) only finishes the journal of the run that this systemd invocation
started. `--accept-current` is described in
[When recovery cannot proceed](#when-recovery-cannot-proceed).

`install-timer` writes `<name>.timer` and `<name>.service` to
`~/.config/systemd/user/`, refuses to overwrite existing files, and runs
`systemctl --user daemon-reload`. It does not enable or start anything. The
timer uses `OnCalendar=*-*-* HH:MM:00 <timeZone>` at the window start plus
this install's jitter, with `Persistent=false`, so a missed night is not run
outside the window. The service is a oneshot with
`ExecStopPost=... maintenance recover --after-run`, `TimeoutStartSec` =
nominal window + 60 minutes (a fall-back night can repeat an hour inside the
window) − jitter + the undo budget, and `TimeoutStopSec` = the undo budget.
The undo budget is the worst case of a full journal undo: session switch-back
cap (5 minutes), file restore (1), 5 minutes per configured agent CLI
package, proxy (2), OpenCode restart (4) and gateway restart (3), plus 5
minutes margin. Reinstall the timer after you change `agentClis.packages`. The run
itself starts no disruptive step unless its worst case fits before the window
end; the timeouts are a last resort,
the config companion as `EnvironmentFile`, and `PATH` from the installing
shell with Bun's directory first. When `pogo.root` is set, `ExecStart` runs
`<root>/current/src/main.ts`, so the timer follows release switches.

## Captain and crew instructions

`pogo crew init --maintenance-config pogo.json` renders this paragraph, with
the configured times, into the captain and crew agent definitions and Pi
member definitions (only when maintenance is enabled):

> Nightly maintenance: every night from 00:00 to 01:00 (Europe/London), Pogo
> can update itself, the model proxy, the agent CLIs and agent models. At an
> idle moment in this window, the Slack gateway, the OpenCode server and your
> session can restart, and your model can change to a newer model of the same
> family. Before the window, checkpoint work in progress: commit or push
> branch work, write a journal note and report task state. Do not start long
> tasks in the window. After a restart, read your journal and continue from
> the last checkpoint.

`pogo maintenance instructions` prints it for an existing profile.

## Migration of an existing install

Do these steps once, at an idle moment, with backups. Maintenance does not
perform them. The commands use the Galactica paths; adjust them for another
install.

1. **Get a release that contains `pogo maintenance`** and verify it by hand:

   ```sh
   VERSION=X.Y.Z   # first release with this feature
   ROOT=$HOME/.local/share/pogo
   CFG=$HOME/.config/pogo/galactica-captain/pogo.json
   cd /tmp/opencode && gh release download "v$VERSION" --repo aiconsultancy/pogo
   sha256sum -c "pogo-v$VERSION.tar.gz.sha256"
   gh release view "v$VERSION" --repo aiconsultancy/pogo --json author --jq .author.login
   tar -xzf "pogo-v$VERSION.tar.gz" -C "$ROOT/releases"
   mv "$ROOT/releases/pogo-v$VERSION" "$ROOT/releases/$VERSION"
   cd "$ROOT/releases/$VERSION" && mise exec -- bun install --frozen-lockfile && mise exec -- bun test
   POGO="mise exec -- bun $ROOT/releases/$VERSION/src/main.ts"
   ```

2. **Add the `maintenance` section** with `"enabled": false`, then
   `$POGO config check --config "$CFG" --schema-only`.

3. **Adopt the release** (creates `$ROOT/current`):

   ```sh
   $POGO maintenance adopt --config "$CFG" --release "$ROOT/releases/$VERSION" --version "$VERSION"
   ```

4. **Move the install-specific plugin wrapper outside the releases** and make it
   load `current`:

   ```sh
   OLD=$ROOT/releases/3a22aa9497d6ee7c2b8a5d67d5c7280ec64cad88-galactica
   mkdir -m 700 "$ROOT/deployment-plugin"
   sed 's#"../src/crew/plugin"#"../current/src/crew/plugin"#' \
     "$OLD/deployment-plugin/index.ts" > "$ROOT/deployment-plugin/index.ts"
   chmod 600 "$ROOT/deployment-plugin/index.ts"
   ```

5. **Point launchers and profiles at the stable paths.** Stop the gateway
   first (`systemctl --user stop galactica-pogo.service`): OpenCode reloads a
   changed profile at once. Back up each file, then replace the old release
   path. The plugin package moves to the wrapper;
   every other reference (for example the captain's skill source) moves to
   `current`:

   ```sh
   FILES=("$HOME/.local/share/pogo/galactica-captain/captain/.opencode/opencode.json"
          "$HOME"/workspace/galactica-captain-crew/{chief,starbuck,roslin,apollo,bosun}/.opencode/opencode.json
          "$HOME/.local/bin/pogo"
          "$HOME/workspace/pogo/.local/setup/launch-galactica.ts")
   for f in "${FILES[@]}"; do
     cp -p "$f" "$f.before-maintenance"
     sed -i "s#$OLD/deployment-plugin#$ROOT/deployment-plugin#g; s#$OLD#$ROOT/current#g" "$f"
   done
   grep -n "$OLD" "${FILES[@]}"   # expect no output
   ```

6. **Give CLIProxyAPI a stable link** to a copy of the running binary in
   Pogo's own version layout, and run it through a drop-in:

   ```sh
   CPA=$HOME/.local/share/cliproxyapi
   install -D -m 700 \
     "$HOME/.local/share/mise/installs/github-router-for-me-cli-proxy-api/8.0.54/cliproxyapi" \
     "$CPA/8.0.54/cliproxyapi"
   ln -s "$CPA/8.0.54/cliproxyapi" "$CPA/cliproxyapi-current"
   mkdir -p "$HOME/.config/systemd/user/galactica-cliproxyapi.service.d"
   printf '[Service]\nExecStart=\nExecStart=%s --config %s\n' \
     "$CPA/cliproxyapi-current" \
     "$HOME/.config/cliproxyapi/config.yaml" \
     > "$HOME/.config/systemd/user/galactica-cliproxyapi.service.d/pogo-link.conf"
   systemctl --user daemon-reload
   ```

7. **Tree comparison source (required by default):**
   `git clone --bare git@github.com:aiconsultancy/pogo.git "$ROOT/source.git"`
   (set `pogo.checkout` to it). The run fetches only the release tag into it,
   with the SSH credentials of the user service; check that a non-interactive
   `git -C "$ROOT/source.git" fetch origin` works.

8. **Restart once at an idle boundary** and verify: proxy, OpenCode (plugin
   path changed), then the gateway.

   ```sh
   systemctl --user restart galactica-cliproxyapi.service
   systemctl --user restart opencode2.service
   systemctl --user restart galactica-pogo.service
   cat "$HOME/.config/pogo/galactica-captain/.pogo/ready.json"   # new readyAt and version
   ```

9. **Add the instructions paragraph** to the existing captain, crew and Pi
   definitions (`$POGO maintenance instructions --config "$CFG"`), with
   backups, inside each `<!-- POGO:START -->` block.

10. **Enable:** set `"enabled": true`, check the plan, then install the timer:

    ```sh
    $POGO maintenance plan --config "$CFG"
    $POGO maintenance install-timer --config "$CFG" --print   # review
    mise exec -- bun "$ROOT/current/src/main.ts" maintenance install-timer --config "$CFG"
    systemctl --user enable --now pogo-maintenance.timer
    systemctl --user list-timers pogo-maintenance.timer
    ```

11. **Retire the cron updater.** The 03:15 UTC `update-agent-clis` job now
    competes with maintenance. Back up and remove only that line:

    ```sh
    crontab -l > "$HOME/crontab.before-maintenance"
    crontab -l | grep -v '/home/operator/.local/bin/update-agent-clis' | crontab -
    crontab -l   # confirm
    ```

    Keep the script for manual use; `agentClis.lockFile` makes a manual run and
    maintenance exclude each other.

If `gh` cannot read its credentials in the systemd user session (for example a
desktop keyring), create a fine-grained, read-only token for
`aiconsultancy/pogo` (Contents: read), store it in `<config>.env`, and set
`pogo.tokenEnv`.

## Limits

- Restarting the shared OpenCode server interrupts every session on it, so the
  gate needs the whole server idle. A busy operator session defers maintenance.
- While the gateway is stopped, Slack keeps retrying undelivered Socket Mode
  events only for a short time. The stop covers only the restarts.
- Pi workers' models (`backend.model`) are not upgraded: they are part of the
  crew identity.
- Model upgrades do not edit OpenCode provider declarations; a model that
  OpenCode does not list stays `catalog-missing` until the provider
  configuration includes it.
- Model probes and the OpenCode catalog are checked once per run; a model that
  appears only after tonight's OpenCode restart moves the next night.
- The readiness record proves that every bot connected, not that a model call
  works. Plugin activity proves that OpenCode loaded the plugin, not that
  every crew tool works.
- `pogo.json` `backend.model` is not upgraded (it would change the bot key);
  only pinned captain sessions, crew sessions and profiles move. Sessions
  not switched before the session-phase cap move on a later night.
- An undo that cannot be verified (for example the old proxy also fails) keeps
  its journal entry, writes `ALERT.json` and exits 1; `recover` retries it.
- A run killed with `SIGKILL` before it recorded a change cannot undo that
  change; every live change is journalled before it happens, so the window is
  the change itself.
