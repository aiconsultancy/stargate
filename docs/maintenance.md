# Nightly maintenance

Stargate can keep itself and its host dependencies up to date in a nightly
maintenance window. One `stargate maintenance run` per night:

1. updates Stargate to the newest verified GitHub release;
2. updates CLIProxyAPI and the agent CLIs (OpenCode, Codex, Claude Code, Pi);
3. moves child-agent profiles and live captain/crew sessions to a newer model
   of the same family when the proxy offers one;
4. writes a private JSON report and sends one summary to Slack.

Every change waits for an idle boundary. Nothing interrupts active captain,
crew, Pi, cron or gateway work. A change that is not done before the window
deadline waits for the next night. Each change has a health check and an
automatic rollback.

Maintenance is off by default. Every component is also off by default.

## Opt-in cleanup

`maintenance.cleanup` is independent of the update components. It defaults to
disabled, with a five-day age threshold and no roots or repositories. Example:

```json
"cleanup": {
  "enabled": true,
  "olderThanDays": 5,
  "scratchRoots": ["/tmp/opencode"],
  "repositories": ["/srv/project"],
  "protectedPaths": ["/srv/permanent-worker"]
}
```

Run `stargate maintenance cleanup --plan --config /srv/pogo/pogo.json` to inspect
the configured cleanup without writes, fetches, pruning or service changes.
Cleanup must be enabled to select candidates. Apply runs only through
`stargate maintenance run`, within its maintenance window and shared idle gate.
Cleanup itself does not stop or restart services. It runs after interrupted
update recovery and before preparing this run's updates. The idle gate is
checked again before each deletion. Unlike updates, deletion has no automatic
rollback: only the guarded, explicitly configured paths are eligible.

- Scratch: only directly listed child directories older than the threshold.
  The newest nested mtime determines age. Symlinks, special files, credentials,
  service state, unknown metadata or active use retain the directory. Git
  repositories also require a clean tree and remote evidence for every local
  branch and HEAD. Scratch checks use existing remote-tracking refs offline.
- Branches: fetch/prune `origin` in each configured repository, then require
  ancestry in `origin/main`. Never delete `main`, `master`, a checked-out branch
  or a branch absent from `origin/main`. Use only `git branch -d`; refusal is
  reported, not overridden with `-D`. Each item records its branch and tip SHA.
- Worktrees: only stale, clean, unlocked, unused worktrees with remote evidence
  for their commits. Removal never uses `--force`, then metadata is pruned.
  Primary checkouts, configured backend directories and permanent crew paths
  (including Pi workers) are always retained. Add any other permanent paths to
  `protectedPaths`.

Scratch roots themselves, `slack-share`, `avondale-fixtures`, inspection files
less than seven days old and relay JSON files written today are retained.
Use by a process is checked through Linux `/proc`: the executable
(`exe`) and the mapped files (`maps`, the path column only) of each
process, and the working directory, root directory and open files of each
of its threads (`task/<tid>`). No file contents, arguments or environment
are read. An unavailable or inaccessible use check fails closed
(`use-unknown`).
Runtime/configuration roots and known credential/state directories are
protected automatically. Scanning, commands, report items and execution time
are bounded. Unknown or over-limit results retain the item.
Filesystem/process checks cannot provide an atomic lock against unrelated
processes; do not configure shared writable scratch roots for automatic
deletion.

### Hosts with other users

A user cannot read the open files of another user's process, and a normal
host always has processes of root and of service accounts. The use check has
one rule for them:

- A path below a **private directory** (a directory above the path that
  this user owns and that has no permission bit for group or others, for
  example mode `0700`) is checked against this user's processes only.
  Another user cannot reach the path, so the processes of other users are
  not inspected.
- Root can reach every path. Root's processes are accepted as not using a
  private path. This is a deliberate trade-off: without it, cleanup removes
  nothing on a normal host. Do not configure a scratch root or a worktree
  location that root's services work in.
- A path with no private directory above it keeps the strict rule: one
  process that cannot be inspected gives `use-unknown`, and the item stays.
- This user's own processes are always inspected, with every thread. One
  entry of them that cannot be read gives `use-unknown`. A process of this
  user that the kernel protects from inspection (a non-dumpable process,
  for example `ssh-agent` or the `(sd-pam)` helper of a systemd user
  session) therefore keeps every item.

For cleanup to remove items on such a host, make the scratch root private:

```sh
chmod 700 /tmp/opencode
```

The mode of the candidate itself does not count; only a directory above it.

### Large scratch roots

One run reports at most 500 items, for all roots together. A scratch root
with more children than the run can still report is not refused. The report
has one `scan-limit` item for the root, which shows that the run inspected
only a part, and then:

- only child directories whose own modification time is older than
  `olderThanDays` are inspected (a directory that changed later is not
  stale), oldest first;
- when these are still more than the remaining report items (499 for the
  first root: one item is the root's own), each day takes the next window
  of that size. Children that stay (in use, not pushed) therefore do not
  keep the others from their turn. Each daily run removes what it can;
  some runs later, every old child was inspected.

A root with more than 20,000 children is refused whole (`scan-limit`).

The private maintenance report has an optional `cleanup` object with bounded
per-item `kind`, `path`, `status`, `reason`, `size`, `newestMtime`, and optional
`branch`/`tip`, plus `freedBytes` and `plannedBytes`. A private report checkpoint
is awaited before each deletion and after its result. An audit write failure
stops further deletion. A `planned` entry in an interrupted apply records intent,
not proof of removal; inspect that exact path before acting. Final Slack
summaries include totals; full paths and kept-item reasons stay in the private
report. No live cleanup or configuration change follows from installing Stargate.

## Configuration

Add a top-level `maintenance` section to `pogo.json`. The schema is strict;
`stargate config check --schema-only` validates it. Example (the Galactica install):

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

| Setting                                   | Default                                                             | Meaning                                                                                                             |
| ----------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `enabled`                                 | `false`                                                             | `run` refuses to start when false. `plan` and `update` always work.                                                 |
| `installID`                               | hash of host and config path                                        | Stable identity for jitter and reports.                                                                             |
| `window.start`, `window.end`              | `00:00`, `01:00`                                                    | Local wall-clock times; the end can be after midnight.                                                              |
| `window.timeZone`                         | `Europe/London`                                                     | IANA zone. Daylight saving time applies.                                                                            |
| `window.jitterMinutes`                    | `15`                                                                | Maximum per-install start delay.                                                                                    |
| `window.reserveMinutes`                   | `10`                                                                | No new change starts in the last N minutes; they are kept for rollback.                                             |
| `components.*`                            | `false`                                                             | `pogo`, `cliproxyapi`, `agentClis`, `models`. Each needs its section.                                               |
| `report`                                  | none                                                                | Bot and channel for the Slack summary. The channel must be allowed for the bot.                                     |
| `services.gateway`                        | `pogo.service`                                                      | User unit of this gateway.                                                                                          |
| `services.openCodeRestart`                | `systemctl --user restart opencode2.service`                        | Command that restarts the shared OpenCode server.                                                                   |
| `idle.pollSeconds`                        | `30`                                                                | Idle-gate poll interval.                                                                                            |
| `idle.cronHorizonMinutes`                 | `10`                                                                | A cron schedule due within this time blocks maintenance. See [Idle gate](#idle-gate).                               |
| `proxy.url`, `proxy.clientKeyFile`        | loopback `:8317`, required                                          | CLIProxyAPI endpoint and its private client-key file (mode 0600).                                                   |
| `pogo.root`                               | required                                                            | Install root. See [install layout](#install-layout).                                                                |
| `pogo.repository`, `pogo.branch`          | `aiconsultancy/stargate`, `main`                                    | Release source.                                                                                                     |
| `pogo.tokenEnv`                           | none                                                                | Environment variable with a read-only GitHub token. Without it, Stargate uses `gh auth token` if `gh` is available. |
| `pogo.author`                             | `github-actions[bot]`                                               | The only accepted release and asset author.                                                                         |
| `pogo.checkout`                           | none (required)                                                     | Local clone (bare is fine) for the tree comparison. Without it the update fails closed (`not-configured`).          |
| `pogo.requireTreeCheck`                   | `true`                                                              | `false` accepts releases without the tree comparison. Not recommended: see [Stargate releases](#stargate-releases). |
| `pogo.coolOffHours`                       | `0`                                                                 | Release age before install. Stargate releases are this project's own CI output.                                     |
| `pogo.keep`                               | `3`                                                                 | Managed releases kept, always including `current` and `previous`.                                                   |
| `pogo.installCommand`, `pogo.testCommand` | `bun install --frozen-lockfile`, `bun test`                         | Run in the new release directory before the switch.                                                                 |
| `cliproxyapi.link`                        | required                                                            | Stable symlink that the proxy unit's `ExecStart` runs.                                                              |
| `cliproxyapi.binary`                      | required                                                            | Installed binary path with `{version}`.                                                                             |
| `cliproxyapi.asset`                       | `CLIProxyAPI_{version}_linux_amd64.tar.gz`                          | Release asset to download; its GitHub SHA-256 digest is pinned.                                                     |
| `cliproxyapi.executable`                  | `cli-proxy-api`                                                     | Executable inside the asset, installed as `binary`.                                                                 |
| `cliproxyapi.coolOffHours`                | `24`                                                                | Minimum age of the release and of each of its assets.                                                               |
| `agentClis.prefix`                        | required                                                            | npm global prefix.                                                                                                  |
| `agentClis.packages`                      | the four CLIs below                                                 | `{ name, command }` pairs.                                                                                          |
| `agentClis.allowScripts`                  | `@opencode/cli`, `@anthropic-ai/claude-code`, `protobufjs`, `koffi` | Only these may run install scripts (`--strict-allow-scripts`); empty: `--ignore-scripts`.                           |
| `agentClis.lockFile`                      | none                                                                | Shared `flock` lock of an existing updater.                                                                         |
| `agentClis.coolOffHours`                  | `24`                                                                | Minimum npm publication age, also for dependencies (`--before`).                                                    |
| `models.families`                         | Claude Opus, Sonnet, Haiku; GPT Sol, Terra, Luna                    | Families that can move automatically.                                                                               |
| `models.providers`                        | `openai-proxy`, `claude-proxy`                                      | OpenCode providers that route through the proxy.                                                                    |
| `models.agentProfiles`                    | none                                                                | Global child-agent profiles directory.                                                                              |
| `models.teamFiles`                        | `[]`                                                                | Team JSON files whose models follow upgrades.                                                                       |
| `models.probes`                           | `2`                                                                 | Maximum health probes per current model and night.                                                                  |
| `droid`                                   | none                                                                | Monitoring agent; see [Maintenance droid](#maintenance-droid).                                                      |

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
leaves the remaining work for the next night. `stargate maintenance window` prints
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
   Stargate release in its own directory. Download, verify and install the new
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
   switch `current` (Stargate), journal and write model configuration, restart
   OpenCode, require every captain/crew location to report its Stargate plugin.
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
    of the release `current` points to. On failure the run records the
    release as known-bad, restores the previous release, restarts OpenCode
    and the gateway, and waits again. From the first start on, ingress is
    open (a schedule that came due while the gateway was stopped starts at
    once), so every undo step that restarts a running service rechecks idle
    first, as leftover recovery does. Busy: that step is not done, the
    journal stays and `recover`, the droid or the next run finishes it. A
    gateway that is `inactive` or `failed` is started without the check. If
    the gateway still is not ready, the journal stays, the run exits 1 and
    writes an alert.
12. **Prune** old releases and write the report.

### Gateway-only update

A Stargate release that does not change the crew plugin needs no OpenCode
restart. When a release is staged, maintenance records a digest of the crew
plugin in `<release>/.pogo-plugin-digest`: the plugin entry and every file
that it imports, `package.json`, the lockfile, the Bun and TypeScript
settings and `templates/`. Gateway source outside that set, tests and
documentation do not change the digest.

The run takes the gateway-only path when all of these are true:

- the staged release and the `current` release record the same digest;
- the run has no CLIProxyAPI, agent CLI or model change.

Then steps 5, 8, 9 and 10 do not run. The idle gate needs only the gateway
idle (no unfinished gateway job, no cron run active or due): crew tasks and
OpenCode sessions continue. The run stops the gateway, switches `current`,
starts the gateway and waits for readiness. A failed readiness check
restores the previous release and restarts the gateway only. The report has
the step `crew-plugin-unchanged` and one restart, of the gateway.

The import closure is read from the source with Bun's own resolver. A tree
has no digest when that cannot be complete: an import with a computed path,
`require` used as a value, `import.meta` in a plugin file, a symbolic link,
or an import that does not resolve inside the tree.

A missing or unreadable digest on either side takes the full path. This
includes the first update after this feature is installed and every adopted
release. A digest that came inside a release archive is never used.

After a gateway-only update OpenCode still runs the plugin from the earlier
release directory. `state.json` records that release (`openCodeRelease`)
and pruning keeps it until a later run restarts OpenCode.

Every abnormal end (exception, `SIGTERM`, timeout) applies the same journal
undo as `stargate maintenance recover`.

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
  stopped, and the gateway is started last. If the run had already started
  the gateway again, ingress is open: the undo then rechecks idle before
  each step that changes live state, and a busy check keeps the journal. A file left by an earlier run
  (one that exited before it wrote its own, for example disabled, outside the
  window or with the lock busy) does not match. For any other journal,
  `--after-run` only starts a stopped gateway when the journal holds
  `gateway`;
- the next run, after its idle gate and with the gate again before each
  undo step that changes live state (see step 1);
- the maintenance droid's `recover`, through the same path (see
  [Maintenance droid](#maintenance-droid));
- an operator with `stargate maintenance recover`, unconditionally.

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
  pinned CLIProxyAPI digests, releases that failed after a switch, and the
  release whose crew plugin OpenCode still runs after a
  [gateway-only update](#gateway-only-update).

### When recovery cannot proceed

Recovery stops with `external-change` when a file or link changed after
maintenance wrote it, and with a corrupt journal when the journal is not
private, has unknown keys or names something outside the configuration.
It never guesses. To get out:

1. Read `maintenance/ALERT.json`, the last report and the `recover` output.
2. List what one entry still covers, without changing anything:

   ```sh
   stargate maintenance recover --config pogo.json --accept-current files
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
   stargate maintenance recover --config pogo.json --accept-current files --yes
   stargate maintenance recover --config pogo.json
   ```

For a corrupt journal, read `journal.json` (or `gateway-stopped.json`), undo
by hand what it names (the `current` release link, CLI versions, the proxy
link, session models), then move it aside with
`--accept-current journal --yes`. It is renamed to
`journal.accepted-<time>.json`, never deleted. `--accept-current` takes the
run lock and refuses while a run holds it.

<a name="pogo-releases"></a>

## Stargate releases

A merge to `main` with a user-facing change publishes `vX.Y.Z` (see
[releases](releases.md); other changes reach hosts with the next release) with `pogo-vX.Y.Z.tar.gz` (a
`git archive --prefix=pogo-vX.Y.Z/`) and `pogo-vX.Y.Z.tar.gz.sha256`. GitHub
artifact attestations are not available for the organization, so Stargate does
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
  session bus, and no way to find the live OpenCode service. The staging
  directory is hidden (`.staging-*`), so tests must not depend on a visible
  `TMPDIR`. `make test-release-env` runs the suite in the same environment;
  CI runs it for every pull request.

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
<root>/releases/<name>/.pogo-plugin-digest  crew plugin digest, when known
<root>/current -> releases/<version>        launchers and plugins load this
<root>/previous -> releases/<version>       rollback target
<root>/deployment-plugin/index.ts           optional install-specific wrapper
```

Launchers, the gateway unit and every captain/crew `opencode.json` plugin
`package` reference `current` (directly or through the wrapper). OpenCode
loads a plugin once per process, so a release switch restarts the shared
OpenCode server, unless the crew plugin is unchanged (see
[gateway-only update](#gateway-only-update)). `.staging-*` and `.failed-*` directories are this tool's own
temporary folders; pruning removes them.

The gateway writes `<dataDirectory>/ready.json` after every bot connected. The
record holds the process, time and release version from `.pogo-release.json`.

## CLIProxyAPI

The proxy unit must run a stable symlink, not a versioned path, so that a
switch and its rollback do not edit the unit. Candidates come from GitHub
releases of `router-for-me/CLIProxyAPI`: stable, not draft, not pre-release,
newer than the linked version, and past `coolOffHours` by the release's
publication time _and_ every asset's creation and update time, so a replaced
asset on an old release does not bypass the age rule. Stargate downloads
`cliproxyapi.asset` itself, requires GitHub's `sha256:` digest for it,
verifies the download, validates the archive headers (the same rules as Stargate
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

Stargate does not edit OpenCode provider declarations. A model that the proxy
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

JSON files are rewritten only when they use Stargate's canonical two-space layout;
a differently formatted file is reported as `config-format` and left alone.
A symlinked file (for example from a dotfiles repository) keeps its link; its
real target receives the change.

## Idle gate

The gate has two scopes. The gateway scope is the first two conditions
below; it is enough for a restart of the gateway alone. Every other step
(CLIProxyAPI, agent CLIs, model files, sessions, OpenCode) needs all of
them.

All of these must be true, observed read-only:

- no gateway job is `queued`, `running` or `responding`;
- no cron schedule is due within `cronHorizonMinutes` (default 10), and no
  cron run is
  `pending`, `announcing`, `announced`, `queued` or `blocked`. A schedule
  that is already overdue counts only while the gateway runs it: its ready
  record names a live process and the unit is not `inactive` or `failed`
  (any other unit state, including an unknown one, counts as running). A
  stopped or crash-looping gateway never advances it, and would otherwise
  block its own recovery forever;
- for each crew found through the gateway's OpenCode bots: no task is
  `dispatching`, `running` or `cancelling`, no activity-report task is
  queued and no worker controller is held; no Pi task is outside
  `terminal`. A queued activity-report task (the engine marks it in
  `activity_report_tasks`) blocks because it can start outside a captain
  turn: the gateway's activity delivery admits it for up to ten minutes
  after a turn and when the gateway starts. An ordinary queued assignment
  does not block: it starts only when its captain runs `pogo_crew` status
  or wait, inside a captain turn, which the OpenCode check below sees, and
  it stays queued in SQLite across restarts. A cancelled task is terminal.
  Each report names every queued task in `notes`, and the Slack summary and
  the [droid](#maintenance-droid) list them with the action that resolves
  them; for an ordinary assignment, for example a forgotten one from an
  earlier captain session: ask the captain to run `pogo_crew status
  <taskID>`;
- no Stargate-owned OpenCode session is running (`session.active`) or has a
  pending form or permission request. Stargate-owned sessions are the pinned
  captain sessions (a gateway bot's pin and each crew plugin's own pin),
  every session in the gateway's thread mappings, the crew
  sessions (peers and crew IRC sessions) and their subagents at any depth.

The OpenCode condition covers Stargate's own sessions only. Other sessions on the
shared server, for example the operator's own work, never block maintenance;
an OpenCode restart interrupts them. A session whose parent cannot be read is
busy (`idle-unknown`). An unreadable source is
busy (`idle-unknown`): this includes a captain or crew profile that exists but
cannot be read or parsed, a dangling profile link, unparsable Stargate plugin
options and a configured OpenCode member without a profile. Symlinked profiles
are followed. The gate never changes, cancels or replays work.

The gate runs again immediately before each disruptive action: the gateway
stop, the proxy restart and the OpenCode restart (and once after the stop).
The same recheck runs before every restart in an undo once the gateway is
back (readiness rollback, `recover --after-run`, leftover recovery, the
droid). An undo step that only restarts the gateway uses the gateway scope,
and a leftover journal that holds only the release link and the gateway
waits for the gateway scope. So the cron horizon only has to cover the longest single step after a gate,
the OpenCode restart and plugin check (4 minutes); the default of 10
minutes adds margin. A schedule that comes due while the gateway is stopped
runs once, late, when the gateway is back. A horizon of an hour or more
never passes on a ship with an hourly cron: one is always due within the
hour. With an hourly cron, the gate passes once that hour's run has finished
and the next one is more than the horizon away.

## Reports

Each `run` writes `<dataDirectory>/maintenance/reports/<startedAt>-<runID>.json`
(mode 0600). `plan` writes nothing. A report is always written: arrays and
long fields are truncated to fixed bounds and counted in `truncated`; a write
failure does not change the outcome and leaves an alert. Reports contain versions, reason codes,
step names and private local paths. They never contain raw errors, command
output, prompts or credentials. Changed files are also copied, before the
change, to `<dataDirectory>/maintenance/backups/<runID>/`.

`stargate maintenance schema` prints the JSON Schema. Version policy: the
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
| `notes[]`                 | Optional: `kind` (`queued-crew-task`), `taskID`, `crew`, `originCaptain`, `originIsPin`, `report`, `action`. IDs and origins only, never task text           |
| `truncated`               | Optional: dropped items per array (bounds: 100 components, 1000 models, 300 steps, 300 rollbacks, 50 restarts, 50 notes)                                     |

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

`pogo-maintenance-droid` is a Pi Durable agent built into Stargate. It monitors
nightly maintenance, explains each run in plain English and escalates
problems. It has no Slack app of its own: it posts through `report.bot` to
`report.channel`, with the same outbox as the run summary. Slack users cannot
address it. It is off by default.

The deterministic engine stays authoritative. Stargate decides when to check,
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

The droid timer starts `stargate maintenance droid` at `window.end` plus
`afterRunMinutes` and at `healthCheck`. One check:

1. **Facts (read-only, by Stargate code).** The latest `reports` reports, reduced
   to outcome, reason codes, changed components, failed steps, rollbacks and
   model counts; `ALERT.json`; whether a journal exists and its entry names;
   known-bad releases from `state.json` that are newer than `current`;
   queued crew assignments (task ID, crew, origin captain, never the text);
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
   | `known-bad`          | A failed Stargate release newer than `current` blocks updates.                  |
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
   `Checks:` (the finding codes), one line per queued crew task (task ID,
   crew, whether it came from the pinned captain, and the action that
   resolves it) and `Operator commands:` for the findings.
   Slack receives it as plain text, so it cannot mention or link anyone.
6. **Fallback.** If the model cannot be opened, fails, times out or answers
   nothing, the explanation is Stargate's deterministic summary: the newest
   report and every finding. Alerts are never lost to a model failure.

`stargate maintenance droid --print` shows the facts' findings and the
deterministic post. It asks no model, runs no action and writes nothing.

### What the model can do

| Tool                  | Effect                                                                                         |
| --------------------- | ---------------------------------------------------------------------------------------------- |
| `maintenance_status`  | The facts above and the findings. Read-only.                                                   |
| `maintenance_reports` | Report digests, newest first. Read-only.                                                       |
| `maintenance_plan`    | `stargate maintenance plan` in process; returns its summary. Once per check; not during a run. |
| `maintenance_recover` | The run's leftover recovery in process, under the run lock. Preconditions below.               |

The droid's Pi Durable store has only these four tools installed: no shell,
files, network, systemd or Slack. A call of any other tool name fails, and a
tool call from an earlier, interrupted check does nothing. The droid never
runs `run` or `--accept-current`.

`maintenance_recover` runs only when all of these hold; otherwise Stargate
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
stargate maintenance droid --config pogo.json --print
stargate maintenance install-droid-timer --config pogo.json --print   # review
stargate maintenance install-droid-timer --config pogo.json
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
  commands in each post come from Stargate, not from the model.
- `pi.sqlite` keeps old daily conversations. It grows by a few small
  conversations per day; to reset it, stop the droid timer and delete the
  droid directory.

## Commands

```sh
stargate maintenance plan --config pogo.json [--json]   # read-only; no probes
stargate maintenance run --config pogo.json             # used by the timer
stargate maintenance update --config pogo.json --version X.Y.Z --plan
stargate maintenance update --config pogo.json --version X.Y.Z --now [--retry-failed]
stargate maintenance window --config pogo.json
stargate maintenance instructions --config pogo.json
stargate maintenance install-timer --config pogo.json [--name NAME] [--print]
stargate maintenance adopt --config pogo.json --release DIR [--version X.Y.Z]
stargate maintenance recover --config pogo.json [--after-run]
stargate maintenance recover --config pogo.json --accept-current ENTRY [--yes]
stargate maintenance droid --config pogo.json [--print]
stargate maintenance install-droid-timer --config pogo.json [--name NAME] [--print]
stargate maintenance schema
```

`run` refuses to start outside the window; `--outside-window` runs now with the
window's length, for an operator-attended first run. Only one run holds the
lock in `<dataDirectory>/maintenance/run.sqlite`. Exit status is 1 for a
`failed` outcome and whenever an alert is written (journal left, gateway not
ready, aborted, report not written). `recover` exits 1 when a run holds the
lock, the journal is corrupt or its undo is incomplete. `--after-run` (used by
the timer and the update unit) only finishes the journal of the run that
this systemd invocation started, and writes `ALERT.json` when a journal is
left afterwards. `--accept-current` is described in
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

## Update now

`stargate maintenance update --version X.Y.Z --now` installs one Stargate release
immediately. It is for an operator who accepts the interruption. It is the
nightly run's own path for one named release, with three differences: it does
not wait for the window, it does not check the idle gate and it does not apply
the cool-off to the named version. It changes the Stargate release only;
CLIProxyAPI, the agent CLIs and models stay with the nightly run. It works
also when `maintenance.enabled` is false; `maintenance.pogo` must be
configured.

Run it with the installed Stargate, not from a checkout:

```sh
bun <pogo.root>/current/src/main.ts maintenance update --version X.Y.Z --now --config pogo.json
```

`--now` is refused unless the code that runs the command is a release that
maintenance staged and verified: a real directory in `<pogo.root>/releases`
whose `.pogo-release.json` has `"verification": "verified"`. That code makes
the switch, the rollback and the recovery of the update unit. A development
checkout, a link to one and an adopted release are refused; `--plan` works
from anywhere. There is no override.

The first use therefore needs an installed release that has this command.
The nightly run installs one. On a host whose `current` release is older
than the command, or is an adopted release, wait for the next nightly
update, then use `update` for the releases after it.

What it does, in order:

1. **Checks, read-only.** `current` must be a managed release. The version
   must be a published, non-draft release that is newer than `current`; it
   is looked up by its tag `vX.Y.Z`, so an older release is found too.
   These are refused, and nothing changes:
   - a downgrade (to go back after a failed update, use `recover`);
   - a journal that an earlier run left (run `stargate maintenance recover`
     first; the update never undoes another run);
   - a release that failed here after an earlier switch, unless
     `--retry-failed` is given.
2. **Starts a transient user unit** and returns when its command has
   started (`systemd-run --user --service-type=exec`). The unit is named
   `pogo-update-X-Y-Z-<epoch seconds>`; for version 1.2.3 that is, for
   example, `pogo-update-1-2-3-1794665227`. The update can restart
   OpenCode, which ends the session that asked for it; the unit continues.
   The unit runs the entrypoint of the verified release that started it,
   with the fixed `PATH`
   `<Bun's directory>:/usr/local/bin:/usr/bin:/bin`, the gateway's
   environment file, `UMask=0077` and the same
   `ExecStopPost=... maintenance recover --after-run` as the nightly
   service. If the unit cannot be started, the command says so and nothing
   has changed.
3. **Stages and verifies** the release as the nightly run does: origin,
   checksum, archive checks, tree comparison, install and tests in its own
   directory. A release that cannot be verified is not installed.
4. **Stops the gateway, switches `current`, restarts.** OpenCode restarts
   only when the crew plugin changed or its digest is unknown; see
   [gateway-only update](#gateway-only-update). The switch is journalled.
5. **Checks readiness.** The gateway must write `ready.json` with the new
   version. If it does not, the run records the release as known-bad,
   restores the previous release and restarts what the switch restarted,
   without an idle check. If the unit itself is killed (timeout, `SIGKILL`),
   its `ExecStopPost` makes the same undo, also without an idle check: an
   operator update never leaves the new release switched in because the
   host is busy. A journal stays only when that undo fails; `ALERT.json`
   then exists.
6. **Writes the private report** in `<dataDirectory>/maintenance/reports/`
   and queues the Slack summary. The report has the step `operator-update`
   and the summary says "Operator update of Stargate".
   `ALERT.json` exists when an operator must look.

`--plan` makes the checks of step 1, prints what would happen and which
services would restart as far as is known before staging, and changes
nothing. The unit runs `update --now --foreground`; do not use
`--foreground` in a session that the update can end.

### Runbook: install a release by hand

Never create, copy or edit a directory under `<pogo.root>/releases`, and
never move the `current` link by hand. A directory without a valid
`.pogo-release.json` is not a release: `ready.json` then has `version: null`,
the gateway logs a warning at start, a readiness check for a version never
passes, and maintenance refuses to switch to that directory.

1. Plan: `stargate maintenance update --config pogo.json --version X.Y.Z --plan`.
2. Apply: the same command with `--now`. Note the unit name that it prints
   (`pogo-update-X-Y-Z-<epoch seconds>`).
3. Follow: `journalctl --user -u <unit>.service`.
4. Verify:
   - `<dataDirectory>/ready.json` has `"version": "X.Y.Z"`;
   - `<pogo.root>/current` points to `releases/X.Y.Z`, and that directory
     has `.pogo-release.json` with `"verification": "verified"`;
   - the newest report in `maintenance/reports/` has `pogo: updated` and
     lists the restarts; no `maintenance/ALERT.json` exists.
5. If the update failed: it has normally rolled back by itself. The report
   then has `pogo: rolled-back`, `current` points to the previous release
   and `ready.json` names the previous version. Read the report before you
   try again; `--retry-failed` is required for the same version.
6. If `maintenance/ALERT.json` exists with `"journal": true`, the automatic
   undo did not finish: run `stargate maintenance recover --config pogo.json`.
   It restores the previous release and restarts what that needs. The
   update refuses to start while a journal is left.

What restarts when:

| Change                                            | Gateway | OpenCode |
| ------------------------------------------------- | ------- | -------- |
| Release with the same crew plugin digest          | yes     | no       |
| Release with another or an unknown plugin digest  | yes     | yes      |
| Rollback of a gateway-only update                 | yes     | no       |
| Rollback after OpenCode restarted with the update | yes     | yes      |

To mark an existing, complete release directory as managed once, use
`stargate maintenance adopt`. Use the CLI from the release being adopted. An adopted release has no plugin digest, so the
next update restarts OpenCode.

## Captain and crew instructions

`stargate crew init --maintenance-config pogo.json` renders this paragraph, with
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

`stargate maintenance instructions` prints it for an existing profile.

## Migration of an existing install

Do these steps once, at an idle moment, with backups. Maintenance does not
perform them. The commands use the Galactica paths; adjust them for another
install.

1. **Get a release that contains the maintenance CLI** and verify it by hand:

   ```sh
   VERSION=X.Y.Z   # first release with this feature
   ROOT=$HOME/.local/share/pogo
   CFG=$HOME/.config/pogo/galactica-captain/pogo.json
   cd /tmp/opencode && gh release download "v$VERSION" --repo aiconsultancy/stargate
   sha256sum -c "pogo-v$VERSION.tar.gz.sha256"
   gh release view "v$VERSION" --repo aiconsultancy/stargate --json author --jq .author.login
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
   Stargate's own version layout, and run it through a drop-in:

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
   `git clone --bare git@github.com:aiconsultancy/stargate.git "$ROOT/source.git"`
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
`aiconsultancy/stargate` (Contents: read), store it in `<config>.env`, and set
`pogo.tokenEnv`.

## Limits

- Restarting the shared OpenCode server interrupts every session on it. The
  gate waits only for Stargate-owned sessions: a session that Stargate does not own,
  for example the operator's own, is interrupted by the restart.
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
