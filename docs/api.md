# Fleet API v1

Subspace Fleet Console uses the Fleet API to read registrations, crew activity,
and host metrics. The API can start independently of the
[Unix-socket dashboard](dashboard.md). It does not start agent work or change
sessions, queues, or schedules.

## Enable

Add the top-level `api` object to your existing `stargate.json`, alongside your
transport registrations.

```json
{
  "api": {
    "listen": "127.0.0.1:8484",
    "allowedNetworks": ["127.0.0.0/8"],
    "fleetName": "Example fleet"
  }
}
```

Run `stargate config check` and restart Stargate. A bind failure prevents
startup. Omit `api` to turn the listener off. A fleet's
[officers](#officers) read the API on their own sockets, with or without it. Use `:8484` to select the default
loopback host, or `[::1]:8484` for IPv6 loopback. See the
[configuration reference](configuration.md#fleet-api) for all settings and
defaults. Every API setting requires a restart.

The listener is private-network only because fleet and host metadata are
operator data. It accepts literal loopback, RFC 1918, CGNAT (including
Tailscale IPv4), and IPv6 loopback and ULA addresses. Public addresses and
wildcard binds such as `0.0.0.0` and `::` are rejected. The CIDR allowlist checks
the TCP peer address. With a local proxy or tunnel, allow its loopback
address and enforce remote-client access at the proxy or tunnel.

### Private Unix mode

Set `"api": { "listen": "unix" }` to serve the same Fleet routes on
`<dataDirectory>/api.sock` instead of TCP. This selects one listener, not an
additional endpoint. Existing private TCP settings keep their meaning.
The Unix mode requires an owner-controlled mode-0700 data directory and creates
the socket with mode 0600. It refuses occupied live sockets, symlinks, foreign
sockets and regular files. Shutdown removes only the socket it published.

The operator bearer is still required. `allowedNetworks` applies only to TCP;
Unix access uses filesystem ownership. Fleet browser-origin rules are unchanged.
Optional [notification inputs](notification-ingestion.md) use separate producer
credentials and exact POST mounts on this Unix owner. Each defaults to off.
Health and configuration routes are not implemented.

To roll back to a version without Unix mode, restore the prior private TCP
`listen` setting, or omit `api` if no Fleet listener is needed. Keep `api-token`
and other private state. Do not remove an existing TCP configuration blindly.

## Officers

A fleet's own officers (its rear admiral and captains) and their crew read
the same Fleet API, the whole fleet and read-only, without the token. Agents
never hold the token. Each officer reads through a Unix socket that only its
own processes can reach: the socket's file permissions are its identity.
Officers get crew task text as the crew plugin shows ordinary readers:
redacted and bounded, never the [raw task text](#routes) the operator
listener serves.

The socket is `fleet-api.sock` in the officer's Subspace socket directory,
beside its signing proxy socket (see [Subspace API agent identity](subspace-agents.md)).
The name is not `fleet.sock`, which is [Fleet Control](fleet-tools.md)'s
socket and may share the directory. There is no separate switch: the gateway
that has `subspaceAgents` enabled opens one for every officer with a
`socketPath`, at `<directory of socketPath>/fleet-api.sock`. It does so
whether or not the `api` listener is configured. Without `api`, Stargate
opens no TCP listener and creates no token; the officers' sockets serve the
gateway's fleet under its host name. With `api`, both serve the same fleet,
name and pull request lookups.

| Path                    | Owner, group and mode                                                                                    |
| ----------------------- | -------------------------------------------------------------------------------------------------------- |
| The officer's directory | The gateway user and the officer's engine group, mode `2750` (or `0700`), made before the gateway starts |
| `fleet-api.sock`        | The gateway user and the directory's group (by setgid), mode `0660`; removed when the gateway stops      |

The directory follows the rules of the officer's Subspace socket
([how the caller is identified](subspace-agents.md#how-the-caller-is-identified)):
owned by the gateway user and writable by it alone, under parents only root
or the gateway user can write. Start-up stops, with a log line naming the
officer, when an officer's directory is missing, gives others any access, or
admits a group that another officer's directory also admits, or when the
socket did not get the directory's group. It also stops, naming both
sockets, when the configuration puts another socket (a Fleet Control, Teams
or dashboard socket) at an officer's `fleet-api.sock`. So only the gateway
user, root and members of the officer's engine group can connect. Crew run
as their captain's user and reach their captain's socket; no officer
reaches another officer's.

On the socket:

- only `GET` and `HEAD` are served; every other method gets 405 with
  `Allow: GET, HEAD`, and a request body is never read;
- only the four routes above answer, at exactly normalised targets: no dot
  segment, doubled slash, encoded slash or dot, NUL, backslash or fragment.
  Anything else gets 404, including the crew activity route. A query is
  ignored, except that `/api/v1/events` with an `agent`, `crew` or `turn`
  parameter gets 404: officers never receive `agent-activity`;
- no token is needed and an `Authorization` header is ignored; no browser
  origin is granted CORS;
- answers have the same shape as on the operator listener, without officer
  turn activity. Crew task text is the crew plugin's ordinary view:
  credentials redacted, control characters stripped and progress masked
  before the cut, within 180, 80 and 400 code points in ship detail, the
  `ship` event and the crew member route alike.

Officers' reads and event streams have their own eight HTTP read slots and
eight stream slots, shared by all officers, so officers can never use up the
slots people's consoles need. The host limits below apply to each socket.

Read it with the command, as the officer's user or a crew member's:

```sh
stargate fleet request --socket /run/stargate/subspace/example-captain/fleet-api.sock /api/v1/fleet
STARGATE_FLEET_API_SOCKET=/run/stargate/subspace/example-captain/fleet-api.sock \
  stargate fleet request /api/v1/ships/example-ship/crew/example-member
```

`--socket` defaults to `$STARGATE_FLEET_API_SOCKET`. The command reads no
configuration. The answer goes to standard output; the exit status is 0 for
a 2xx answer, 1 otherwise (the status goes to standard error), and 2,
without connecting, for any path but the four routes above.
`/api/v1/events` streams until the gateway closes it or the command is
stopped. `curl --unix-socket` works too:

```sh
curl --fail --silent --show-error \
  --unix-socket /run/stargate/subspace/example-captain/fleet-api.sock \
  http://localhost/api/v1/fleet
```

## Token

Run `stargate api token [--config PATH]` as the service user. It prints the
bearer token to stdout, creating it if needed. Startup also creates it if
missing. The token is stored in `<dataDirectory>/api-token` with mode
`0600`. Keep it private and enter it in Fleet Console.

Run `stargate api token --rotate [--config PATH]` to replace the token. Restart
Stargate to load the new value and reconnect clients with it. A running
listener continues using the token it loaded at startup.

## Private access from another machine

Keep the bind on loopback for these setups. Stargate serves HTTP. The
tunnel or proxy provides the encrypted client connection, and the bearer
token is still required.

- **Tailscale Serve.** On the gateway host, run
  `tailscale serve --bg http://127.0.0.1:8484`. Point Fleet Console at the
  HTTPS URL Serve reports and use tailnet access rules to limit who can
  connect. Use Serve for tailnet-only access. [Tailscale Serve documentation](https://tailscale.com/docs/reference/tailscale-cli/serve)
- **Cloudflare Tunnel and Access.** Create an Access application for an
  HTTPS hostname such as `fleet.example.com` with an explicit allow policy.
  Route it through a Tunnel to `http://127.0.0.1:8484` and enable Protect with
  Access so the connector verifies the Access token. Keep the Stargate bearer
  in the `Authorization` header. For clients using Access session cookies,
  let Access handle preflight for the exact Space origin and allow
  credentialed CORS on the proxy response. This requires a WebView that
  can send the Access cookie with cross-origin requests.
  [Access-protected applications](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)
  [Access CORS](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/cors/)
- **SSH local forwarding.** From the client machine, run
  `ssh -N -L 127.0.0.1:8484:127.0.0.1:8484 operator@fleet.example.com`
  and connect to `http://127.0.0.1:8484`.

## Browser origins

By default the API allows `subspace://*` for macOS Spaces. On Windows,
add the exact WebView2 Space origin to `corsOrigins`, for example
`["subspace://*", "https://subspace.fleet-console"]`. Use your Space's ID
in the Windows hostname. The `https://subspace.*` pattern also matches
public domains.

Each `*` matches one nonempty label using lowercase ASCII letters, digits,
or hyphens. Include the port when the serialized origin has a port. Matching
origins receive CORS headers on responses, including event streams. An
`OPTIONS` preflight for a matching origin allows `GET`, `Authorization`,
and `Last-Event-ID` without a token.

## Routes

| Route                                        | GET response                                                                          |
| -------------------------------------------- | ------------------------------------------------------------------------------------- |
| `/api/v1/fleet`                              | Fleet overview with captain summaries, host metrics, and gateway version and features |
| `/api/v1/ships/{id}`                         | Ship detail, including crew members                                                   |
| `/api/v1/ships/{id}/crew/{member}`           | One member's detail                                                                   |
| `/api/v1/ships/{id}/crew/{member}/diff`      | A crew member's [diff](#crew-diffs), one page of files                                |
| `/api/v1/ships/{id}/crew/{member}/diff/file` | One changed file's patch or bytes, one page                                           |
| `/api/v1/agents/{id}/activity`               | An officer's recent turns, a turn by IRC request, or one page of one item             |
| `/api/v1/ships/{id}/crew/{member}/activity`  | A crew member's recent worker turns, or one page of one item                          |
| `/api/v1/events`                             | Server-sent events                                                                    |

`{member}` is a crew member's configured ID. Each of a ship's `crewMembers`
has that `id`, its configured `name` (which may differ from the ID; the ID
when no name is set), `role` and `model`.

On the operator listener, crew task text (`summary`, `phase` and
`progress`) and Git branch and base names appear exactly as the crew wrote
them: the API neither redacts credential-shaped text nor replaces checkout
paths, in every route and event. Ship detail and the sample that feeds the
`ship` event request task text without a member filter. They show it
unredacted, up to 180, 80 and 400 code points (the start of the summary and
phase, the end of the progress); the fleet overview carries no task text.
The crew member route applies no limit of its own: it returns the task text
the crew plugin stores, up to 64,000 code points per field. The
`unredacted` and `full` views are for the operator listener only.

[Officers' sockets](#officers) ask the crew plugin for its ordinary view
instead, in every route and event, from a crew sample of their own: the
fleet overview and the `ship` event read one fleet status sample per backend
for the operator listener and another for officers. While only one listener
has clients, each poll reads fleet status once per backend; while both do,
twice. The two lanes never queue behind each other. Each allows one current
probe plus at most one abandoned read that ignores abort and is still
draining: two RPCs in flight per backend in steady state, four at worst.
If another probe times out while its lane's abandoned read is still draining,
that lane starts nothing until the abandoned read drains. Neither listener's
sample falls back to the other's, even when the other is fresher. Git branch
and base names, subagent titles and pull request titles are the same on both.

The store makes the final storage cut for progress; Pi members buffer up to
twice that limit first. For over-limit progress, the store saves the raw
tail and masks the ordinary view from the uncut text before storage. Short
progress and legacy rows are masked on read. Ordinary readers (the Slack
crew command, health, the operator dashboard and the crew status tool) get
masked and bounded text.

On the operator listener, ship and crew detail fall back to redacted
180/80/400 text only when the initial request reports the fleet status method
missing, or when the plugin rejects `taskText` and the re-ask without it
succeeds. A failed re-ask or a current plugin that cannot answer by the crew
deadline leaves crew status unavailable; the member route returns `503`
rather than redacted text.

On both listeners, ship and member routes return `503` if the whole HTTP
read times out.

Subagent titles and pull request titles are also shown as written, cut to
180 characters. Each stream's activity events quote its own task text view,
with whitespace collapsed: officers' sockets the ordinary view, the operator
listener the unredacted one. Branch names are unredacted on both.

These text fields (task text on the operator listener, branch and base
names, subagent titles and pull request titles) can hold any Unicode
character, including control characters such as ESC and BEL, C1 controls,
and bidirectional formatting characters such as U+202E. The API does not
strip them; only the length limits above apply. A client that prints them,
to a terminal or a page, must escape them, for example by showing each as a
visible marker.

`HEAD` returns headers without a body. Unknown ships, members, and routes
return 404. Missing or invalid tokens receive 401 (officers' sockets need
none). Repeated authentication
failures from a peer receive 429 with `Retry-After`. Responses include
`Cache-Control: no-store`. Times are epoch milliseconds. Host uptime is in
seconds, and CPU usage is a fraction that becomes available after the first
five-second sample interval. The gateway caches the OpenCode V2 server version
for ten minutes. If the probe fails or no OpenCode server is configured, the
value is null.

`host.disks[].path` labels the filesystem. `/` represents the root
filesystem, and `data` represents the filesystem holding the data directory
when it is on a separate device.
`GET /api/v1/fleet` gives the overview and enrichment a shared deadline that
ends one second before the HTTP request deadline (19 seconds by default). If
enrichment times out after the overview is ready, the response uses the latest
host and gateway metrics. Before the first host sample, the
fallback omits disk usage.

The captain's crew plugin reads Git state for the captain's project checkout
and each configured crew worktree, as the Linux user that owns them, and
reports it over its internal `crewGit` RPC. The gateway can run as a user
that cannot read the captain's home, so it uses that report whenever the
captain answers. A captain whose plugin is older than this method is asked
again after a minute. Each ship detail read makes one captain Git request for
both the project and crew checkouts. If that request fails or reaches its
six-second timeout, the gateway reads the checkouts itself without asking the
captain again. A fleet summary requests only the project checkout. The
plugin uses the same status setup as the gateway, without its index snapshot:
repository hooks, fsmonitor, optional locks and lazy fetches are off. For
status it uses the checkout's objects and live index, but runs in a
private Git directory without checkout filter configuration or
`info/attributes`. Both readers use the same status configuration allow-list
and discard multiline values. A failed configuration read, including an
output limit, makes the Git state unavailable. Both readers recheck the
branch and commit after status and do not cache a result if either changed.
After a good sample, a branch and commit that can no longer be read count as
changed, so that result is not cached either. A failed sample keeps its own
error even when the recheck also fails.
The captain reads the configured `core.excludesFile` as live ignore data,
like the live repository's other ignore files. The gateway can run as a
different Linux user, so it copies that file under the snapshot limits below,
and only if it resolves inside the checkout or its Git directories; otherwise
it is skipped.
Only the repository's own configuration counts. Both readers skip the user's
global configuration (`GIT_CONFIG_GLOBAL=/dev/null`) and the system file
(`GIT_CONFIG_NOSYSTEM=1`), so a `core.excludesFile` set in `~/.gitconfig` or
the XDG Git config does not apply. Without a repository `core.excludesFile`,
status runs with `-c core.excludesFile=/dev/null`, so Git's default
`$XDG_CONFIG_HOME/git/ignore` (`~/.config/git/ignore`) does not apply either.
Files ignored only there count in `changedFiles`, although `git status` in a
terminal hides them. This is deliberate: the read stays isolated from
the user's configuration. To have the count honour such a file, set
`core.excludesFile` in the repository's configuration or use `.gitignore` or
`.git/info/exclude`.
Git versions that support
`GIT_ATTR_SOURCE` also ignore worktree `.gitattributes`. The captain caches
each checkout's result for 15 seconds, with a five-second read limit.
The temporary directory (`TMPDIR`, or the system default) must resolve outside
the checkout. It and its ancestors must be owned by root or the captain's
Linux user and must have the sticky bit if group- or world-writable. If those
safety checks fail, `git.error` is `Git status requires a safe temporary directory.`

Each `git` object may carry these optional fields, added without changing the
existing ones:

| Field         | Meaning                                                                     |
| ------------- | --------------------------------------------------------------------------- |
| `worktree`    | Absolute path of the checkout on the fleet VM                               |
| `commit`      | Full object ID of `HEAD`; null when unborn or unknown                       |
| `dirty`       | `changedFiles > 0`; absent when the count is unknown                        |
| `source`      | `captain` (the crew plugin) or `gateway` (the Fleet API process itself)     |
| `fingerprint` | Crew members only: the [crew diff](#crew-diffs) `fingerprint` of this state |

Without a captain report, the gateway's own reader below applies.
Checkout Git status counts changed gitlinks and skips worktree dirt inside
submodules. Status runs in a private Git directory with snapshots of the
primary and shared indexes and access to the checkout's objects. The SHA and
upstream come from the captured branch when attached. Stargate rechecks the
branch and commit after comparing ahead and behind counts and rejects the
snapshot if either changed.

Git status requires the safe metadata opens supported on Linux and macOS.
Other platforms report `Git state unavailable.` The reader checks the size of
each index before snapshotting it. On Linux, it tries a copy-on-write clone
of the open index and streams a bounded copy if cloning is unavailable.
On macOS, it streams a bounded copy.
The primary and shared indexes each have a 128 MiB limit, and all snapshot
metadata has a 192 MiB aggregate limit. Snapshot preparation, including
split-index inspection in a separate process, has a two-second budget before
the two-second Git status and comparison budget starts. A read, including
time waiting for a slot, has a four-second ceiling. A checkout's own timeout
is cached for 15 seconds. Timeouts spent mostly waiting for a read slot are
cached for one read deadline (two seconds). Cleanup runs in the background
within the same concurrency limit. Snapshots use a private
`stargate-git-status` folder in the data directory when the data directory is
outside the worktree, writable and owned by the service user. Every directory
on its path must be owned by root or the service user, and any that other
users can write to must have the sticky bit. Startup removes snapshots there
that are older than 24 hours. Otherwise each process uses its own private
folder in the system temporary directory, which must pass the same path checks
but may be owned by root. That folder is removed when the gateway stops; one
left by a crash is not swept and is cleared with the temporary directory. If
neither directory passes, Git status is reported unavailable.

Copied ignore files, including `core.excludesFile`, must resolve inside
the checkout or the Git directories Git reports for it. Those directories come
from the checkout itself, so this limits which files are copied rather than
forming a hard boundary: a checkout pointed at another repository on the host
can affect its own changed-file count, which can reveal to Fleet viewers
whether that repository's ignore rules match files in the checkout.
The 1 MiB limit applies to each copied pattern file.
Unreadable ignore files are skipped, and `info/exclude` retains its usual
precedence. Git reads worktree `.gitignore` files directly. Status reads
disable filters for safety. Git versions that support `GIT_ATTR_SOURCE`
read attributes from the empty tree and ignore worktree `.gitattributes`.
The private Git directory also has no replacement refs, so a checkout that
relies on `git replace` can show different status counts.
When Git rehashes a racily clean file because its timestamp is too close to
the index timestamp, `text` or `eol` attributes or Git LFS can occasionally
cause an unchanged file to count as changed.

To enable pull request lookups, set `api.pullRequestRepositories` in
`stargate.json` and restart Stargate. Each key is the exact absolute,
normalized path of a crew worktree as the crew plugin reports it in
`git.worktree`: the crew project registry's `worktrees` entry for that member
and project. Each value is the GitHub `owner/repository` whose PR metadata
you want to share with Fleet API viewers. The Fleet API process runs `gh`
from its `PATH`; `gh auth status --hostname github.com` must succeed for its
user, with read access to each bound repository.

```json
{
  "api": {
    "listen": ":8484",
    "pullRequestRepositories": {
      "/srv/crew/example-worktree": "example/project"
    }
  }
}
```

Stargate looks up a branch only in its bound repository and requires the PR
head to belong to that same repository. Checkout remotes supply display
metadata in `git.repository`. The optional legacy fields
`git.pushRepository` and `git.pushRepositoryAmbiguous` are deprecated and
omitted. With no binding or no readable branch and commit, `pullRequest` is
null and `pullRequestKnown` is absent. A context with `pullRequestKnown: true`
and `pullRequest: null` has a settled lookup with no matching PR. A failed
or incomplete refresh retains the last successful lookup result.

A crew member's `git` also carries `fingerprint`, the checkout state its
[diff](#crew-diffs) belongs to; the project checkout's does not. It is the
diff's `fingerprint` for the same state in every mode, and the `ship` event
carries each new value. The captain computes it in the poll that reads the
rest of the crew member's Git state. That poll reads `origin/HEAD` with one
`git for-each-ref`, which also names the base when the branch has no
upstream, so the fingerprint costs one Git process for a branch with an
upstream and none without. It also reads the size and modification time of
the index and of each path status names.

### Crew diffs

`GET /api/v1/ships/{id}/crew/{member}/diff` lists what a crew member changed
in its worktree, and `GET /api/v1/ships/{id}/crew/{member}/diff/file` serves
one changed file. The routes are on whenever the Fleet API is, behind the
same token, network check and `Cache-Control: no-store`; the gateway feature
`api.crewDiffs` reports them. There is no configuration flag, by the owner's
decision. Officers' [sockets](#officers) return 404 for both.

Patches and file bytes are served exactly as they are in the worktree,
without redaction, including any credential a crew member wrote into a
changed file. Large content is paged, never hidden. Treat the API token
accordingly. Files that Git ignores (`.gitignore`, `.git/info/exclude` and
the user's excludes file) are never listed or served, and neither is
anything under `.git/` or any unchanged file. Diff content is never logged
or stored, except in the gateway's 30-second memory cache.

The captain's crew plugin computes the diff as the captain's user, over its
internal `checkoutDiff` RPC, in the member's configured worktree. Captains
whose plugins predate the method are asked again after a minute; until then
the routes return 404. Rear admirals, unknown ships, unknown members, members
without a worktree and directories that are not a checkout's top level
return 404.

| Query parameter | Routes | Meaning                                                   |
| --------------- | ------ | --------------------------------------------------------- |
| `mode`          | both   | `branch` (default), `committed` or `working`              |
| `project`       | both   | A configured project key; omitted for the default project |
| `page`          | both   | An opaque cursor from `nextPage` or `patchNextPage`       |
| `path`          | file   | Required: the repository-relative path of a listed file   |
| `at`            | file   | The `fingerprint` of the list the path came from          |
| `side`          | file   | `old` or `new`: that side's bytes instead of the patch    |

Unknown, repeated or malformed parameters return 400, and so does a path
that is empty, absolute, or has an empty, `.` or `..` component, a NUL, a
backslash or a control character. Without `project` the default project is
used and the answer carries `project: null`.

The three modes compare against `refs/remotes/origin/HEAD` and never fetch:

- `branch`: the merge base of `origin/HEAD` and HEAD against the working
  tree, including untracked files;
- `committed`: the merge base against HEAD;
- `working`: HEAD against the working tree, including untracked files.

The answer is `V1Diff`: `ship`, `member`, `project`, `mode`, `fingerprint`,
`unstable`, `branch`, `base`, `head`, `total` (files in the whole diff),
`additions`, `deletions`, `files` and, while more files follow, `nextPage`.
`head` is null on an unborn branch. `base` is `{ ref, commit }`, with
`ref` such as `origin/main` and `commit` the merge base; it is null when
`origin/HEAD` cannot be resolved or shares no history with HEAD, including
on an unborn branch, and the diff then starts from the empty tree. An empty
`files` means no changes.

Files are sorted by path, in byte order. Each `V1DiffFile` has `path`,
`previousPath` (the old path of a rename, else null), `status` (`added`,
`removed`, `modified` or `renamed`), `additions` and `deletions` (null when
binary), `patch` and, when set, `untracked: true`, `binary: true`, `size`
(the new side's bytes, or the old side's for a removed file), `kind`
(`submodule` or `symlink`) and `patchNextPage`. A patch holds only hunks,
starting at `@@`, as GitHub's per-file patches do; it is null for binary
files and changes without hunks, such as a pure rename. Renames are found
with Git's default similarity; a change of file type is one `modified`
entry. A symbolic link is shown as its link text, never its target's
content. A submodule shows its commit change and has no content. An
untracked nested repository, with or without commits, is listed as a
`submodule`: `added` and `untracked`, with zero line counts, no patch and no
content. It is never indexed and Git never runs inside it, on every Git
version. An untracked path that Git will not index, such as a file under
`.GIT/`, or an untracked file that the captain's user may not read, such as
one with mode 000, is listed the same way, without `kind` or `size`.

`path` is decoded as UTF-8, with U+FFFD for each byte that is not valid
UTF-8. Such a file is still read, sized and fingerprinted by the bytes of
its name. Two names that decode alike are listed as two entries, but the
file route's `path` reaches only one of them: an entry with a Git diff
before an untracked path outside Git's index (a nested repository, a
file Git refused or a file it could not read), then the first in byte order. So with a nested
repository `n\xE8` and a file `n\xE9`, a request for `n\uFFFD` returns the
file.

Paging limits:

- A list page holds at most 1,000 files and at most 4 MiB of inline patch
  text, counted in UTF-8 bytes. It ends before the file that would pass
  4 MiB, but always holds at least one file.
- Each inline patch holds at most 64 KiB, cut between characters. When it
  continues, `patchNextPage` is a cursor for the file route.
- The file route with `path` and no `page` returns the patch from its first
  byte. Each patch page holds at most 1 MiB; `file.patchNextPage` continues
  it.
- A content page holds at most 1 MiB of raw bytes.

Cursors are opaque: pass them back unchanged, with the same ship, member,
`mode`, `project` and, on the file route, `path`. A cursor used elsewhere,
or with an `at` or `side` that disagrees with it, returns 400.

The file route answers `V1DiffFilePage`: `{ fingerprint, file, content? }`.
`file` is the listed entry. Without `side` it carries the patch page; a file
with no hunks, such as a binary or empty file, answers with `content`
instead, and a submodule answers with neither. With `side`, `file.patch` is
null and `content` is `{ side, encoding: "base64", offset, size, data,
nextPage? }`: `size` is the side's whole size and `data` holds the bytes
from `offset`. `nextPage` appears only while `offset` plus the page's bytes
is less than `size`; an empty file is one page of size 0. The default side
is `new`, or `old` for a removed file. A side the file does not have (the
old side of an added file, the new side of a removed one) returns 404. File
pages carry no `unstable`.

`fingerprint` identifies the checkout state: it changes with HEAD, the
`origin/HEAD` commit, the index, or the size or modification time of any
changed or untracked file. It is the same in every mode and equals the
crew member's `git.fingerprint` in ship detail, the crew member route and
the `ship` event, so a console can refresh its diff when the event shows a
new value. The file route serves only a path in the same mode's diff at the
current fingerprint. With `at`, or with a cursor, a different current
fingerprint returns 409: start again from the list. A list whose fingerprint
moves while it is computed is computed once more; if it moves again, the
answer carries `unstable: true`. A file page is computed once more too,
including when a file shrinks while it is read, and returns 409 if the
fingerprint moves again.

| Status | Meaning                                                                        |
| ------ | ------------------------------------------------------------------------------ |
| 200    | The diff or file page                                                          |
| 400    | Malformed query, mode, path or cursor                                          |
| 404    | Unknown ship, member or project, no checkout, or a path the diff does not have |
| 409    | The fingerprint of `at` or the cursor moved, or the file kept changing         |
| 503    | Both diff slots are busy, or the computation passed 10 seconds                 |
| 500    | Git or the captain's plugin failed                                             |

Error answers have empty bodies. Each gateway runs at most two diff
computations at once, apart from the eight shared Fleet read slots; identical
requests in flight share one computation, which stops, with Git, when its
last request leaves. A computation has 10 seconds. Answers for a request
with `at` or a cursor are kept in memory for 30 seconds, at most 16 answers
or 16 MiB. The plugin runs Git without hooks, optional locks, external diff
or text conversion drivers, repository attributes, or submodule worktree
reads, and in a private Git directory, so a read never changes the
checkout's index.

### Officer activity

`GET /api/v1/agents/{id}/activity` serves what an officer's agent is doing
in its turns: model steps with settled tokens and cost, tool calls with their
streamed and parsed input, progress metadata, results and errors, reply text
and reasoning text. `{id}` is a registration ID from `bots`, `irc` or
`teams`, so it covers the rear admiral and every captain. An unknown ID
returns 404. The route is on whenever the Fleet API is, behind the same
token, network check and `Cache-Control: no-store`; the gateway feature
`api.agentActivity` reports it.

This route serves tool input and output, provider errors, reply and reasoning
text without redaction or truncation, exactly as the agent saw them, including
any secret a tool printed. Treat the API token accordingly. Officers'
[sockets](#officers) return 404 for this route, so no officer reads another
officer's turns.

The response is `V1AgentActivity`: `{ agent, turns, cursor }`. Turns are
oldest first. Turn IDs are unique across restarts, and item IDs (`i1`, `i2`,
...) are stable within their turn. Every change takes the next value of a
per-agent sequence: each turn and item carries the `seq` of its latest
change, and `cursor.seq` is the latest change included. An agent with no
retained turn and no viewer is not kept; when it reappears, its sequence
continues above every such agent's, so a `seq` never goes back within a
generation. `cursor.generation` changes when the gateway restarts.
`turn.reconnects` counts times the live provider stream reattached during
the turn, when changes can be missing.
`agent.collected` is false for backends this gateway does not collect yet;
OpenCode and Claude Agent SDK officers are collected.

For Claude, `agent.unavailable` lists `step.cost` and
`step.tokens.reasoning`, and each step has `unavailable: ["cost",
"tokens.reasoning"]`. The SDK reports cost on the query's result, not per
step: `step.cost` is `null`, and the SDK's reported cost is on the root
turn's `usage`. Its result token counters cover the main agent loop, not the
child turns; the reported cost can include subagents and other calls. The SDK
does not split reasoning tokens out of the output total, so the reasoning
counter is `0`.

The query's result adds to the root turn. If the reply came only as the
result's text, because no main-thread assistant message completed with
text, that text is a `text` item; otherwise nothing is repeated. A stream
preview alone does not count as the reply. A failed result is a `failed`
step with `model: null` and `finish` set to the result's subtype. Its
`error.type` is that subtype, or `is_error` for a result marked as an error,
`error.message` is the result's errors, one per line, or its text, and
`error.status` is the result's API error status, if any.

An item with `unavailable: ["text"]` is a reasoning block whose text the
provider encrypted. The item is present with `text: ""`; the gateway never
received its plaintext. `session.id` is the session ID in the SDK envelope,
which may be shared with the root. Child turns carry `session.parent` with
the spawning `turnId` and `callId`, and are linked only when the call was
observed during the same query. The SDK can send complete blocks instead of
partial deltas for children. A resumed subagent run gets its own child turn.
For a superseded run or a background child that outlives the query,
`cancelled` with `lost: true` means observation ended without a confirmed
native outcome. A foreground tool result can confirm the child's outcome;
a background tool result only acknowledges the launch. Task status and
progress are on the spawning tool's `metadata.task`; the prompt and
description carry forward unless replaced. Only subagents become child
turns; background shells, monitors and workflows stay on the tool. The
spawning tool has `unavailable: ["after-turn"]` if a background task
outlives the query. This route does not follow task output files or
reconstruct missed frames.

| Query parameter | Meaning                                             |
| --------------- | --------------------------------------------------- |
| `turn`          | Only that turn; 404 once it is gone                 |
| `item`          | With `turn`: one page of that item's JSON           |
| `page`          | With `item`: the zero-based page number (default 0) |
| `request`       | All retained families for this IRC message ID       |
| `channel`       | With `request`: filter by IRC channel or DM account |

To open a turn from an IRC request, URL-encode its IRCv3 message ID and use
`?request=<msgid>`, optionally with `&channel=<channel>`. The selector cannot
be combined with `turn`, `item` or `page`. The message ID must contain 1–128
printable non-space ASCII characters, and `channel` must be 1–512 UTF-8 bytes
if supplied. Message IDs match exactly; channel matching folds only ASCII
letters A–Z. The snapshot contains every matching retained root turn of the
officer in the path, including retries, and all their descendants in snapshot
order. If no root matches, the response is an empty 404.

Every turn includes `requests: [{ channel, msgid }, …]` from its accepted
IRC job, in intake order for a burst. Channel names and IDs are returned as
received; a direct message uses the sender's IRC account as `channel`. The
array is empty for other transports or when the original IRC message ID is
unknown. Requests queued before link data was recorded are not backfilled.
A follow-up steered into an already-running input is not a new turn and is
not included in these links.
Claude child turns have `requests: []`: the IRC message started the root,
not the subagent. `session.parent.turnId` names each child's immediate
parent. A child admitted unlinked, below, is the exception.

Unknown, repeated or malformed parameters return 400. An item whose JSON
exceeds 64 KiB appears in the turn as a stub with identity, kind, status,
any `unavailable` entries, and `paged: { pages, bytes }`. Fetch every page
with `?turn=&item=&page=`; each `V1ActivityItemPage.data` holds at most
64 KiB of UTF-8 and the pages join into the complete item JSON. Pages with
different `seq` values belong to different versions of a changing item;
start again from page 0.

The gateway keeps the last 16 root turns and their children per officer, in
memory only, however long the officer stays idle. Across all officers and
[crew members](#crew-activity), settled families are evicted oldest first
beyond 256 settled turns (including children) or 64 MiB of settled turn
JSON, which includes changes proven after a turn ended. Such late changes
are measured once per 150 ms batch, and before any turn begins or ends, so
eviction never uses a stale size: a turn they push over the budget is
evicted at the end of that batch, or sooner. A pending batch is evicted
against the turns as they were before the turn began or ended, and only then
does that turn count. If that drain evicts the parent of a child about to
begin, the child is admitted unlinked: it is a root of its own, keeps its
`session.id`, has `session.parent: null` and copies its family's
`requests`, so the snapshot and the request lookup still show it. A child
of a retained parent links to it as usual. A family is evicted together;
running families do not count toward those global limits. A settled family
that exceeds either global limit on its own is evicted first, before any
older family. Eviction does not limit a running family's child turns: they
are bounded only by the query's own turns and tool calls. No content is cut.
OpenCode turns appear when the input is submitted and include output only
once transcript placement proves it belongs to that turn. Claude recording
starts at query submission, after stopping orphans, probing the CLI version,
and creating the private temporary directory with `mkdtemp`.

#### Live activity events

`GET /api/v1/events?agent=<id>` adds `agent-activity` events for that
officer to everything the [event stream](#events) sends. Repeat `agent` for
up to eight distinct officers. `turn=<id>` with exactly one `agent` follows
the whole family for a root ID, or only the selected turn for a child ID.
While a root's watch stays open, it also follows children admitted unlinked
after that family was evicted, including their families and further unlinked
descendants. An unlinked child's events still carry its own root and
`session.parent: null`.
The snapshot's `turn` and `item` selectors still address exact IDs. With
either stream parameter present, the query is checked before the stream
takes one of the eight viewer places: an unknown, repeated or malformed
parameter, a ninth agent, or `turn` without exactly one `agent` returns 400;
an ID that is not a registration, or a turn the gateway no longer keeps,
returns 404. Officers' [sockets](#officers) answer 404 to any `agent` or
`turn` and never send `agent-activity`. Without either parameter the stream
is unchanged and ignores its query, as before. These 400 and 404 answers
come even when all eight places are taken; only a valid subscription that
finds no free place gets 503.

```text
event: agent-activity
data: {"agentId":"captain-a","turnId":"…","generation":"…","seq":42,"at":1730000000000,"change":{"type":"item","item":{"id":"i3","seq":42,…}}}

```

`V1AgentActivityEvent` is `{ agentId, turnId, generation, seq, at, change }`.
`generation` and `seq` are the values of the snapshot's `cursor`, and `at` is
when the change happened. `change` is an upsert by ID in the snapshot route's
shapes:

| `change.type`  | Payload                                                 |
| -------------- | ------------------------------------------------------- |
| `turn-started` | `turn`: the turn without `items`                        |
| `turn-updated` | `turn`: after a reattachment, usage or crew task update |
| `turn-ended`   | `turn`: with its outcome, `endedAt` and settled `usage` |
| `item`         | `item`: the item, or its identity and `paged`           |

All turn upserts include `requests`, starting with `turn-started`. Claude
root and child events share the officer's `agentId`, sequence and generation;
their turn upserts include `session` exactly as in the snapshot.

Changes are coalesced per officer over 150 ms: a burst of changes to one
item sends its latest value once, with the `seq` of its latest change.
`seq` therefore rises with every event but can skip values, and a
`turn`-scoped stream also skips other turns' values. Each turn event's `turn`
is the turn as it was at that event's own `seq`: a turn that starts and ends
within one window sends a `turn-started` that shows it running, then a
`turn-ended`. A turn's `seq`, `updatedAt` and `usage` are as of its latest
turn event: `item` events do not repeat them, and `turn-ended` carries the
settled values. OpenCode and Claude tool items may remain `input` or
`running` after `turn-ended` if no terminal tool status was observed. Steps
in a Claude turn with `lost: true` keep their last observed state; an
unsettled step can remain `running` with `endedAt: null`. The turn's `lost`
flag is authoritative: a running step is not evidence of ongoing work. An
item whose JSON exceeds 64 KiB arrives as the same paged stub as in the
snapshot, including any `unavailable` entries. Read its pages through the
snapshot route, as above. Nothing is cut. Publishing never waits for a
viewer. Each `agent-activity` event is queued on its own and must fit the
stream's 256 KiB queue, even an empty one; a stream that backs up is closed,
as for every other event, and its connection is freed at once.

The snapshot keeps only the last 16 root turns and their children per
officer, and the global limits above can evict a family sooner, even as it
ends. Eviction is never announced: pending events are still sent for every
evicted turn, root and children alike, in sequence order. A snapshot after
eviction contains none of the family and its cursor already covers those
pending events. A client keeping turns from events alone keeps its own cap
and should discard a root and its children together.

To follow an officer without a gap:

1. Open `/api/v1/events?agent=<id>` and wait for its response (headers or
   the first frame) before fetching the snapshot. The subscription starts
   when the stream opens, so a snapshot fetched earlier can miss changes.
   Keep the stream's `agent-activity` events.
2. Fetch `/api/v1/agents/<id>/activity`.
3. Apply each kept or later event whose `seq` is above that agent's snapshot
   `cursor.seq`, replacing the turn or item with the same ID. Drop the rest:
   the snapshot already holds them. `seq` and the cursor are per agent: with
   several `agent` values, events from different officers interleave, and
   each is compared only with its own agent's cursor and events.
4. Refetch that agent's snapshot and apply again from step 3 when an event's
   `generation` differs from its cursor's (the gateway restarted) or its `seq`
   is not above the same agent's previous event. When the stream closes,
   start again from step 1. The server never drops an event from an open
   stream; it closes the stream instead.

### Crew activity

`GET /api/v1/ships/{id}/crew/{member}/activity` serves a crew member's
worker turns the same way: the same items, the same `turn`, `item`, `page`,
`request` and `channel` parameters, the same 400 and 404 answers, and the
same unredacted, untruncated content, control characters included. `{id}`
is the captain's registration ID. Crew turns answer no IRC request, so
`request` always finds nothing. Officers' [sockets](#officers) answer 404,
and so does a rear admiral, which has no crew of its own, on this route and
for `crew=` events; its officer feed is unchanged.
The gateway feature `api.crewActivity` reports the route and its events; it
is on whenever the Fleet API is.

The gateway follows each OpenCode captain's crew through one event
subscription and the crew plugin's read-only `crewTurns` RPC, which names
each member's current worker session and the input IDs of the crew's tasks.
Its answer is bounded by the crew's load-time limit of 50 member contexts:
at most 50 members, 50 peer sessions (one per member and project) and
50 × 17 tasks (each context's active task and its latest 16 settled ones);
a larger answer is refused as malformed.
Only root worker sessions of configured OpenCode members with a ready peer
session are collected: not Pi workers, removed members or pending
reservations, and sub-sessions not yet. A session that changes member,
project or crew namespace is no longer collected. A task's resume inputs
are attributed for each member's latest 64 tasks; an older task's
assignment input still is.

The response is `V1AgentActivity` with `agent.member` set to the member and
`agent.id` to the captain. `agent.collected` is false until the captain's
crew plugin answers `crewTurns`, and for a plugin too old to have it, a Pi
or other non-OpenCode captain: the route then answers 200 with no turns for
any well-formed member, never an error. While the plugin answers,
`agent.collected` follows the member's current configured backend: a
configured OpenCode member is collected, even before it has a worker
session or a turn, and a member configured for Pi or another backend is
not, though turns retained from an earlier OpenCode configuration stay
readable. Only a member that is neither configured nor holding a worker
session or a retained turn returns 404.

A crew turn covers one execution of the worker session, as an officer's
turn does, and ends when the execution settles, with its outcome. A DM,
notice or callback steered into the running execution never ends a turn.
If a settle is missed, the session's next native execution start ends its
open turns `cancelled`, and so do messages of that execution still waiting
to be placed. Starts and settlements apply in their session's durable
order: a replayed or late one, of any age, changes nothing. One without a
durable sequence for its session is applied as it comes.

An execution's messages are placed in the order their first frames arrived.
Output whose owning input is not known yet appears after up to 2 seconds,
and after at most 4 while it waits behind an earlier message. The
execution's earliest message opens its first turn, whose `startedAt` is
that message's first observed frame. A message whose input proves a task
joins the execution's latest turn with the same input or task, or else
opens a turn of its own; while the latest turn's opener is still being
resolved, it waits up to 2 more seconds first. Output proven to answer a
task before it is placed therefore never appears under another task; at
worst, one task is split into two turns of the same execution, both naming
it. Every other message, a steer or one whose owner is unproven or cannot
be proven, joins the execution's latest turn, which can be a task's. Turns
are listed in the order they opened.

Some cases stay approximate. An unproven message joins the execution's
latest turn, whichever task that turn names. A message placed before its
owner is proven, because it waited past 2 seconds, passed a hold limit
below or found all 8 owner lookups busy, joins the execution's latest turn;
if it later proves to answer another task, it stays in that turn, whose
`task` does not change: a shown message never moves. A message first seen
after its execution settled joins that execution, with its outcome, only
when its first frame's durable sequence (a step, or the start of text,
reasoning or a tool input) lies between that execution's start and its
settlement, within the session's last 16 settled executions whose start
and settlement both carried a durable sequence; when no start of its own
was seen, the previous settlement stands for it. Otherwise it is placed
with the current execution and takes no earlier outcome: when it is first
seen through a delta, when its execution is older than those 16, or when
either bound of its execution was not seen with a durable sequence, for
example a start without one, after a reconnect or when the session became
a peer mid-execution. A settle missed and inferred from the next start
bounds nothing either, since unseen executions may lie between. A turn opened by a message whose owner cannot
be proven keeps `task: null`, and a later task message of the execution
opens its own turn.

Output waiting for its owner is held up to 256 KiB per message and 4 MiB in
total, counted as each frame's serialized data without its small envelope;
beyond either, it is placed at once without waiting for its owner. A turn
it opens is attributed once its owner is proven; a turn it joins keeps its
own task. Once placed, its frames are released, even while its owner is
still being resolved. A crew turn evicted by the global limits, on any
path, is forgotten at once, and later output of its messages is dropped
while an eviction marker for each message is retained.
At most 64 messages per worker session wait for placement; past that, the
oldest is placed at once. A placed message is remembered apart from them
for as long as it is still known, that is while its execution runs or its
turn is retained, so its later output, including a retry's repeated step
start, continues in its turn. Only messages no longer known, those of an
evicted turn or let go by a hold limit, keep such a marker and count
against a bound of 1,024 per worker session, which forgets the oldest of
them first; a message whose marker is forgotten opens again, as an unknown
one, if more of its output arrives. As a safety
ceiling, a worker session keeps at most 16,384 known messages; past that,
the oldest is forgotten and counted in the collector's `forgotten`
diagnostic, and its later output opens a new message. An unknown message's
first frame always opens it, so no output is dropped for lack of a step
start, for example one lost in a reconnect.

Each crew turn adds:

- `task`: `{ id, inputId, project }` when the input that opened the turn is
  one of the task's inputs (its assignment or a resume), answered in the
  task's own worker session and member, otherwise `null`: crew mail,
  notices, compaction or an input that could not be proven. A turn whose
  task lookup was slow starts with `null` and is updated once, with a
  `turn-updated` event, also when the turn has already ended: that event
  then shows the ended turn, and an end in the same window still arrives as
  `turn-ended`. `project` is the crew
  project key, `null` for the captain's default project.
- `session`: `{ id, parent }`, the worker session; `parent` is `null`.

Each member keeps its own last 16 root turns and their children, apart from
the officer's. Its settled families count towards the same global 256-turn
and 64 MiB limits, and are evicted the same way: a family together, and
running families do not count toward those global limits.

`/api/v1/events?crew=<id>/<member>` subscribes to a member's turns. `crew`
is repeatable and mixes with `agent`; together they allow at most eight
distinct subjects, and `turn` needs exactly one subject; it follows the
whole family for a root ID, as for an officer. The rules for 400,
404 and 503 are the agent subscription's, with the route's 404 for an
unknown member. Crew events are `agent-activity` events with
`agentId` set to the captain and `member` set to the member. Each member has
its own `seq` and cursor: key cursors and the last applied `seq` by
`(agentId, member)`, and follow the recipe above with the crew route as the
snapshot.

## Events

Use a streaming browser `fetch` with an `Authorization` header. A connection
gets a `fleet` event with host and gateway information, followed by the
initial `ship` details. One shared poller reads the overview every three
seconds while clients are connected and publishes a `fleet` event when the
overview or gateway metadata changes, independently of ship details.
In the event stream, overview reads have a 25-second deadline,
and host and gateway enrichment and individual ship details each have a
20-second deadline. Over HTTP, every read ends one second before the request
deadline, so a fallback or an error can still be sent. Within that, `GET
/api/v1/fleet` stops waiting for crew reads 5 seconds before its own deadline
(14 seconds by default) and reports any captain that hasn't answered as
unavailable. The fleet overview, ship detail, and crew detail routes share
eight HTTP read slots. These routes answer 503 when all eight slots are occupied.
An event stream request holds a read slot only while it is checked, and
moves to a stream place once it opens.
When an overview read fails or times out, the poller can republish the last
successful overview with `overviewStale: true` and its original `generatedAt`.
That fallback expires 75 seconds after the successful read and is discarded
when the configured ship roster or a ship's backend identity changes. The
poller also discards in-flight overviews from before the change. On expiry,
the server closes the streams so clients can reconnect for a fresh
snapshot. Once a stream has received a `fleet` frame, a change to the ship
roster or to a ship's backend identity also closes it, and the client
reconnects for a fresh snapshot. Host and
heartbeat events continue while the poller waits for a stalled overview.
At three times a read's deadline, another attempt can start. Each overview,
enrichment, host metrics, crew sample, ship detail and OpenCode `fleetStatus`
probe slot allows one outstanding abandoned read alongside the current
attempt. If the first
overview stalls, host and heartbeat events can arrive before the initial
fleet frame. The host timer waits up to one second for a fresh sample and
uses the latest snapshot if the read is still pending. The snapshot omits
disk usage until the first successful host sample. Changed details emit a
full `ship` event with `detailUpdatedAt`. Reused crew data retains its
observation time, even when other detail changes. Timestamp-only refreshes emit
`ship-sampled` with `id` and `detailUpdatedAt`. Clients can use this event
to update the timestamp on the cached detail. If a refresh fails,
`detailStale` is set to `true` on the last successful detail, which keeps
its original sample time, including across reconnects. When the captain is
unavailable, retained detail reports `available: false` and includes the
current error if supplied. A detail failure
before the first successful detail emits an unavailable `ship` with an
`error` field. A successful refresh clears `detailStale`. An overview
availability transition supersedes in-flight detail reads for that ship.
When a ship becomes available and has no successful detail cached, the
poller waits for a new detail read as the superseded read drains. Removal or a
change of backend identity discards cached detail for that ship. A replacement
backend has its own detail read slot. Availability activity follows the
overview. The stream sends `host` every ten seconds and `heartbeat` every
fifteen seconds.

The overview and ship details share one crew read per ship. When availability
is unknown, the caller waits for that result for up to 20 seconds. During a
refresh, a caller can use a recent sample after one second. A sample up to
23 seconds old at the start of a refresh remains usable until the shared read
completes. A failed sample can also be served with its `error` field set.
A disconnected caller cancels its own wait.
Fleet API shutdown cancels shared crew reads. A committed configuration
reload invalidates cached crew samples and cancels reads for retired backends.
Unchanged backends keep their in-flight reads, including reads shared with
HTTP requests.
After a shared read fails or reaches its deadline, the overview marks the
ship unavailable and retains its last successful crew counts if available.
Ordinary OpenCode `fleetStatus` probes, which ask for no task text, start
with a 400 ms budget that doubles after a timeout, up to 6.4 seconds, leaving
time for ordinary crew status. Timeouts count toward the pause below at the
maximum budget. Task text reads have no probe budget, and their timeouts
never double it: they wait for the caller's crew deadline. Ordinary and task
text probes run separately, each with its own drain bound and pause, and
neither waits behind the other. Concurrent callers with the same filter share
one probe. Three consecutive failures of one kind pause that kind of probe
for one minute; an explicit missing-method response to the initial request
pauses both.
A failed re-ask counts as one task text failure, and so does a task text probe
ended by its last caller's crew deadline, in either request. A disconnect
counts nothing, even if the plugin ignores the abort and Stargate later
abandons the probe. A caller leaving while another waits does not end the
probe. A re-ask answered after the deadline caches nothing. A member ID the
crew plugin would reject is never sent to it: the crew member route answers
`404` when admitted, or `503` when every HTTP read slot is busy.

Activity includes newly observed task outcomes, even if the task also
started between polls. Discovering an existing PR after startup or Git
recovery does not generate activity.

A frame contains an `event:` line, one `data:` line with JSON, and a blank line.

```text
event: heartbeat
data: {"at":1730000000000}

```

Up to eight clients can stream at once, with or without
[`agent-activity`](#live-activity-events) subscriptions. Further connections
receive 503, and streams that fall behind are closed; a closed stream's
place is free at once, even if its reader stopped reading. Reconnect for a
new snapshot. There is no event replay.

## Host limits

The shared HTTP host accepts at most 64 connections. Parsed headers are limited
to 16 KiB and must complete within ten seconds of connection acceptance.
Each connection serves one request and closes after the response. Rejected
requests do not read their bodies. Ordinary Fleet reads have a twenty-second
deadline and eight reserved work slots. Event streams have eight separate
slots, bounded output buffering and a sixty-second idle timeout. Stream
heartbeats continue every fifteen seconds.

Enabled notification routes use separate authorization, no browser
Origin or CORS, at most 64 KiB per body, a twenty-second absolute request
deadline, four work slots per route and eight in total. A timeout aborts the
request but does not release its slot until the handler settles. These slots
cannot consume the Fleet read or stream reservations. Connection limits cannot
guarantee availability against a process-wide pre-header flood.

## Curl

On the gateway host or through the SSH example:

```sh
token=$(stargate api token --config stargate.json)

printf 'Authorization: Bearer %s\n' "$token" |
  curl --fail --silent --show-error --header @- http://127.0.0.1:8484/api/v1/fleet

printf 'Authorization: Bearer %s\n' "$token" |
  curl --fail --no-buffer --header @- http://127.0.0.1:8484/api/v1/events

unset token
```

For Unix mode, replace the URL and add `--unix-socket`:

```sh
token=$(stargate api token --config stargate.json)
printf 'Authorization: Bearer %s\n' "$token" |
  curl --fail --silent --show-error --header @- \
    --unix-socket /absolute/dataDirectory/api.sock http://localhost/api/v1/fleet
unset token
```

### IRC request progress

The IRC captain projection includes up to 16 recent `requests` by default.
Set `irc[].features.liveProgress: false` to omit this field. Entries come from
turns with live status observations. Each entry has the gateway request ID,
a fixed lifecycle stage, observation timestamp, job status, a fixed failure code when applicable, and flags for stale
observations and a disconnected OpenCode event stream. Staleness describes an
active request whose last observation is over a minute old. The Fleet heartbeat
describes the API connection. Request entries exclude question text, private
reasoning, tool arguments, tool results and provider errors.
