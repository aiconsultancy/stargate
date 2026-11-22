# One-time Pogo → Stargate cutover

This release is a breaking rename, not a compatibility period. The CLI is
`stargate`, Slack uses `/stargate`, and tools use `stargate_*`. Old commands,
configuration keys, RPC IDs and release formats are not accepted. Downtime is
required. Do not start a new empty installation to bypass the conversion.

These instructions describe an operator action. The migration program never
stops services, edits a live installation, contacts Slack or changes native
sessions through an API. Do not apply the cutover until the released commit
has passed review and Quality checks on its exact head.

## Persistence map

| Old                                                                    | New                                                       | Conversion                                                                                                                     |
| ---------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `pogo.json`, `pogo.json.env`                                           | `stargate.json`, `stargate.json.env`                      | Rename files. Preserve secret values and file mode `0600`.                                                                     |
| `dataDirectory: ".pogo"` (also the old omitted default)                | `".stargate"`                                             | Move the entire data directory, not just its main database.                                                                    |
| `<data>/pogo.sqlite`                                                   | `<data>/stargate.sqlite`                                  | SQLite backup plus the table/key conversions below.                                                                            |
| `irc_pogo_dm`, `irc_pogo_dm_cursor`                                    | `irc_stargate_dm`, `irc_stargate_dm_cursor`               | `ALTER TABLE ... RENAME TO ...`; preserve rows and cursor sequences.                                                           |
| `<data>/<registration>/<sha256(botKey)>/`                              | Same layout, with the new key hash                        | Move the entire backend directory whenever a key changes. Never open an empty replacement.                                     |
| `.local/pogo-crew/`                                                    | `.local/stargate-crew/`                                   | Move all crew DBs, Pi DBs and Mesij data together.                                                                             |
| `.local/pogo-waiting/<hash(agent)>.json`                               | `.local/stargate-waiting/<same hash>.json`                | Move files unchanged.                                                                                                          |
| `maintenance.pogo`, `maintenance.components.pogo`                      | `maintenance.stargate`, `maintenance.components.stargate` | Rename JSON properties. Preserve all other settings.                                                                           |
| `pogo.service`, `pogo-maintenance.service`, `pogo-maintenance.timer`   | Corresponding `stargate` names                            | Generate new units with the released CLI; disable old units before enabling new ones. Inspect custom instance unit names too.  |
| `POGO_*` product variables                                             | `STARGATE_*`                                              | Rename environment keys and their references, never their secret values. Provider-native variables do not change.              |
| `pogo_*` tools, `pogo.*` plugin/RPC IDs, permissions and extension IDs | `stargate_*`, `stargate.*`                                | Convert generated OpenCode/Pi settings and tool bindings. Remove old bindings; no dual registration.                           |
| Active session `metadata.pogoCrew`                                     | `metadata.stargateCrew`                                   | Rename the active **session** binding only. Preserve its value and unrelated session metadata.                                 |
| OpenCode message `metadata.pogoCrew`                                   | Unchanged `metadata.pogoCrew`                             | Owner-approved stable message protocol. Existing messages/history are never edited; new crew messages use the same single key. |
| Mesij actor `pogo:<namespace hash>:<role>`                             | `stargate:<same hash>:<same role>`                        | Convert actor identity fields/bindings only after checking the installed Mesij schema. See native-store constraints below.     |
| `.pogo-release.json` / `pogo.release.v1`                               | `.stargate-release.json` / `stargate.release.v1`          | New release bootstrap, not relabelling old archives.                                                                           |
| `.pogo-plugin-digest`                                                  | `.stargate-plugin-digest`                                 | Generate a new digest from the new release. Do not copy an old digest.                                                         |
| `pogo-vVERSION.tar.gz` and its archive root/checksum                   | `stargate-vVERSION.tar.gz` and matching root/checksum     | Release workflow emits only the new format. Old published assets remain unchanged.                                             |

There are no renamed SQLite **columns**. Other table names stay unchanged.
In particular, `crew-<sha256(namespace)>.sqlite`, `cron.sqlite`, `pi.sqlite`,
`instance.sqlite`, `irc_dm_outbox`, crew notices, activity tables, journal,
mail routes/cursors/intents, task IDs and native session IDs are retained.
Copy Claude homes/transcripts/run records and Codex homes/thread maps/run
records with their backend directories. Prefer reuse of supported native
sessions. A conditional operator-selected fresh binding is described below;
it must not overwrite old job/session mappings, history or uncertain evidence.

### Keys and path-containing identities

Use the **installed** old release's schema (for example, 0.14.0 or 0.20.x)
to normalize the original config and the new
release's schema to normalize the converted config. Changing only a pathname
can change a backend fingerprint. JSON property order is part of the existing
fingerprint algorithm; use the repository functions, not a reimplementation
that sorts keys.

`cutoverBotKey(storedKey, oldNormalizedBackend, newBackend)` is exported from
the converter. It rejects a mismatch between the supplied old normalization
and the stored fingerprint. It parses the new backend through the released
schema, then returns `{from, to, fromHash, toHash}`. Use `{from,to}` in `botKeys`
and the two hashes for directory moves. Omit unchanged mappings. Normalization
includes `headersEnv` names, permissions and defaults, not just directory paths.
Never normalize the old input with the new schema.

- `backendFingerprint(bot)` is SHA-256 of `JSON.stringify(bot.backend)`, with
  `sessionID` omitted for OpenCode. Read both versions of `src/gateway/routing.ts`.
- Slack `botKey` is JSON of `[registration ID, app ID, team ID, bot user ID,
  fingerprint]`. Keep its first four values exactly unchanged.
- IRC `ircKey` is JSON of `["irc", registration ID, lower-case host, port,
  folded configured network or null, folded account, fingerprint]`.
  Read `src/irc/ship.ts`; keep every value except the fingerprint unchanged.
- Map stored keys in `jobs`, `ignored_events`, `captain_cursors`,
  `irc_cursors`, `irc_stargate_dm_cursor`, `cron_schedules` and
  `cron_daily_reports`. Map the first JSON element of `sessions.conversation`
  and `jobs.conversation`. This covers Slack and IRC conversations.
- Move `<data>/<registration>/<sha256(oldKey)>` to the new hash directory.
  Include both Slack registrations and IRC captain/crew registrations. Do
  not recompute the hash from the bot ID alone.
- Crew `identity.value` is JSON, not a hash. Supply its **exact** original and
  new serialized values. `crewFingerprint` in `src/crew/identity.ts` is the
  new runtime's shared version-2 serializer. Use the normalized new plugin
  options, including worker backend credential-reference names/defaults, to
  construct it. The converter checks the original DB value before changing it.
  Keep namespace, crew IDs, native agent IDs and permissions unchanged.
  The crew filename hash uses the unchanged namespace, so it does not change.
- Convert cron `source` and `cron_runs.snapshot.source`, and the snapshot's
  `botKey`. Keep definition contents/prompts, schedule/run IDs, timestamps,
  statuses, announcement threads, job IDs and request retry keys unchanged.
- Convert stored attachment `path` and `prepared.path` in `jobs.output_files`.
  Preserve file hashes, native file IDs, upload phase and notice flags. Move
  the actual files. Input file IDs/URLs and rendered reply text stay unchanged.

Map every currently reachable configuration identity. Keep archived namespaces
and their backend directories too; an unknown historical key is not permission
to delete it. If a current key cannot be reproduced from its original backend
settings, stop: a guessed fingerprint would disconnect its session and queue.

### Maintenance state and native-store constraints

Complete or recover the old maintenance run **with the old release** before
cutover. A nonempty `maintenance/journal.json`, `gateway-stopped.json`, pending
undo directory or in-progress maintenance command is a blocker. Do not rewrite
undo contents or drop the journal to make recovery pass. A clean recovered
snapshot has no pending undo. Archive completed reports/backups unchanged.

Convert the `schema` values of retained ready/state/report/notice/alert/droid
JSON from `pogo.*` to `stargate.*` only at the schema field. Convert structured
component ID `pogo` to `stargate` where present. Preserve failed release facts,
pending report delivery and droid session IDs. A ready record is historical;
only a fresh record from the new process proves readiness. If `installID` was
implicit, pin its old value before changing the config path to preserve jitter
identity. Check maintenance droid namespace directories when that value changes.

The gateway does not own the OpenCode database schema. Use supported V2 APIs
for native session metadata, permissions and moves; never pass an OpenCode
database to `cells`. The operator driver must enumerate owned roots **and
children with product bindings**, preserving IDs and all unrelated fields:

1. For each OpenCode session, read `session.get` and pass its ID, directory,
   metadata and permissions to exported `cutoverSessionFields`. It produces
   only `SessionUpdateInput` and optional `SessionMoveInput`, not a model,
   agent switch or prompt. Apply with `session.update` and `session.move`, then
   read again and verify the complete result, including removal of `pogoCrew`.
   The helper preserves metadata values, rule order/effects and resource
   semantics; only product action/RPC names and explicit path prefixes change.
   Keep models, parent links, IDs, outcomes, grants and native inboxes intact.
2. Mesij v0.1.0 uses schema 4. The converter checks all six table layouts and
   updates only `events.actor`, `agents.actor`, `mentions.actor`, structured
   `events.payload.mentions` strings, and `events.worktree` paths. Optional
   project-ID mappings cover `events`, `agents`, `idempotency_keys`,
   `active_work` and `projection_errors`. Project IDs must come from the
   installed Mesij project resolver, not an invented hash. If the project did
   not move, omit project mappings. `active_work.projection` contains no actor
   identity field in this version; its opaque `data`/`message` remain intact.
   All primary event/session/receipt IDs, sequences, retry keys and reply links
   remain unchanged. The offline transaction temporarily drops only the named
   immutable-update guards needed for these edits and restores their exact SQL
   before commit. Other guards stay active. Do not use this on another schema.
   Matching crew `mail_intents.fingerprint` values are recomputed from each
   retained event with the new actor. An unsent intent without a message
   preimage is an explicit blocker: resolve it before cutover. No inbox resets.
3. Any path-indexed Claude/Codex/Pi storage required by the installed SDK. Keep
   native IDs and immutable conversation/tool history intact. Convert only
   structured paths or product extension/tool bindings required for resume.
   If a native key or checksum cannot be updated using the verified schema,
   stop that in-place conversion and report the exact limit. The operator may
   evaluate a fresh active binding below without deleting the old store;
   never guess a native edit or add a runtime legacy reader.

An output marker proves completion of the supplied plan, **not** discovery of
all native stores. Missing native schema knowledge or unconverted active session bindings are
an activation blocker. Synthetic fixtures cannot certify an installed provider
store. The operator must validate the converted native snapshots separately.

**Owner-approved message-protocol exception:** OpenCode MESSAGE metadata keeps
the single stable key `pogoCrew`, for both retained and new crew messages.
This preserves input-origin, reconciliation and result evidence without
editing immutable history. Message readers do not try a second `stargateCrew`
key. Active SESSION binding metadata is separate and still uses `stargateCrew`.
The native API's lack of retained-message metadata writes is therefore not an
activation prerequisite. Do not patch native databases/event logs, import
history or replace roots to rename message metadata. Retained task envelopes
with the old `Pogo task envelope:` label are read only as exact historical
evidence; new envelopes use `Stargate task envelope:`. Original text hashes,
task IDs, captain identity and result checks remain mandatory. There are no
old CLI, tool, configuration, path or service aliases.

### Conditional fresh active session

The owner permits a new active OpenCode session when a straightforward,
supported in-place move/binding update is unavailable. Reuse remains preferred
where supported. The converter does not create sessions or select this option;
the operator chooses exact owned bindings during APPLY.

- Keep the old session, its ID, history, native store, jobs and uncertain task
  outcomes intact. Do not redirect old jobs or relabel their task/session IDs
  to a new root. New selection is not proof that old work completed or failed.
- Create the new session only with supported APIs and explicit operator scope.
  Set its configured role/agent, model and exact permission effects/resources;
  do not inherit broader grants or substitute agent model defaults silently.
- Retain an explicit old-session reference in the new binding/session metadata
  and operator inventory, for example `stargatePreviousSessionID`. Preserve the
  old-to-new mapping in the private rollback record. References do not import
  or replay history and do not assign an old uncertain task to the new root.
- Bind future authorized work deliberately. No copied prompts, automatic tool
  replay, blind task resume or deletion/reset of old queue, outbox or evidence.
  Resolve or hold old work explicitly through existing operator controls.

This is a cutover procedure, not a generic runtime migration or auto-resume
feature. Original native IDs need not all remain active, but their data and
references must remain available. All other inventory, backup, validation and
rollback requirements still apply.

## Offline conversion program

`scripts/migrate-stargate-state.ts` is a one-use, operator-run converter. It is
not used by startup or automatic updates. Tests cover synthetic 0.14-style
array identities and 0.20-style object identities with real SQLite queues,
cron snapshots, DM cursors, crew tasks, journal and exact native metadata edits.

1. Stop intake, gateway, maintenance timer and backend writers. Resolve running
   turns without replay. Back up every SQLite database with SQLite's backup
   API, plus native stores, configs, environment companions, profile settings
   and referenced files. Retain untouched, private originals for rollback.
2. Build a private **offline bundle**, not the live directory. Include only
   regular files/directories and closed SQLite backups: no sockets, links,
   WAL/SHM/journal sidecars or running process state. For managed symlinks,
   retain their targets in the operator backup and regenerate links at install.
3. Acknowledge the offline bundle by creating `.stargate-offline-snapshot`
   containing exactly `pogo-to-stargate-v1` followed by a newline. Keep its
   directory `0700`. The acknowledgement is an operator assertion, not a lock
   against a live process. The program cannot verify that services are stopped.
4. Write a private `0600` plan. All file/database names below are relative to
   the bundle. `source` and nonexistent `destination` must be disjoint absolute
   directories. The converter resolves the source and the destination's
   nearest existing ancestor to physical paths before creating output. It
   rejects physical overlap through ancestor links, including missing
   destination parents; the source root and source tree still cannot be links.
   All moves happen **after** edits; database paths name their
   original bundle locations. Example structure:

   ```json
   {
     "schema": "stargate.cutover.v1",
     "source": "/private/cutover/offline",
     "destination": "/private/cutover/converted",
     "gateway": "data/pogo.sqlite",
     "cron": "data/cron.sqlite",
     "crew": [],
     "paths": [{ "from": "/srv/pogo", "to": "/srv/stargate" }],
     "botKeys": [],
     "mesij": [],
     "moves": [{ "from": "data/pogo.sqlite", "to": "data/stargate.sqlite" }],
     "jsonFiles": [],
     "cells": []
   }
   ```

   Populate `botKeys` with exact `{from,to}` serialized keys calculated above;
   add each backend hash-directory move. `paths` uses canonical absolute,
   non-root prefixes with directory boundaries; longest match wins. Include
   separate path mappings for every moved data/profile/worktree/install root.

   `crew` entries are `{database, before, after}` with exact serialized old/new
   identity values. Namespace must stay unchanged. Keep each database basename
   and the namespace-hashed Mesij/Pi subdirectories unchanged.

   `mesij` entries are `{database, crewDatabase, actors:[{from,to}],
   projects:[{from,to}]}`. `crewDatabase` binds the associated mail-intent
   digests. Actors must differ only in the literal product prefix. Enumerate
   every actor for the preserved namespace/roles, including captain roots and
   bound IRC sessions. A preexisting target actor/project is a collision.

   `jsonFiles` entries are `{file, edits:[{path:["field",0,"nested"],
   before:VALUE, after:VALUE}]}`. An edit replaces exactly one existing field
   whose value must match `before`. To rename a JSON key, replace its enclosing
   object, keeping every other property unchanged. Use these for config,
   profile tool/RPC bindings and retained maintenance JSON. The program does
   not convert environment text: the operator driver must rename variable
   keys/references without changing values and preserve `0600` modes.

   `cells` entries are `{database, table, column, keyColumn, key, before,
   after}`. They require exactly one selected row with the exact old string.
   Use only verified non-OpenCode adapter/binding cells, not substring SQL
   over prompts/history. OpenCode changes must use V2 APIs as described above.
   JSON columns need complete old/new serialized values.
   Check unchanged native IDs and payload text before accepting these edits.

5. Run from the verified new source tree:

   ```sh
   mise exec -- bun scripts/migrate-stargate-state.ts /private/cutover/plan.json
   ```

   Source is never modified. Failure leaves an incomplete destination with no
   completion marker; never activate or retry into it. Diagnose using the
   private plan, then use a new destination. No raw plan, config or SQL error
   is logged. Internal DB conversions use transactions and integrity checks.
   Multiple stores are not committed atomically across power loss: the output
   bundle becomes eligible for activation only after all edits and moves pass
   and `.stargate-cutover-complete.json` exists. The operator activates all
   converted roots during the same outage; the program never promotes them.

6. Compare row counts, native IDs, session mappings, unfinished job statuses,
   `sent`, retries, attachment phases, crew uncertain/running tasks, journal,
   mail and DM cursors, cron run snapshots and future deadlines. Validate the
   new configuration with `stargate config check --schema-only`, then the
   operator's provider-store checks. No provider calls are part of unit tests.

Startup rejects an old `pogo.sqlite` in the selected data directory, or an
unmigrated sibling `.pogo` when the default `.stargate` has no gateway DB. This is
an error guard, not a fallback reader. Arbitrary custom paths still require
the complete explicit inventory above; automatic discovery is not claimed.

## Release bootstrap

Old updaters request `pogo-vVERSION.tar.gz` and old metadata. They cannot install
this breaking release. Do not create an old-name release asset or patch the old
updater to accept the new format. Do not rename or retag historical releases.

1. Pin the new release tag and commit after exact-head green CI. Download
   `stargate-vVERSION.tar.gz` and its `.sha256` from
   `aiconsultancy/stargate` (public repository ID `1459142785`). Verify
   checksum and compare the extracted source
   tree against `git archive` of that tag. Retain the independently verified
   previous release archive and its exact commit for rollback. Public v0.20.4
   uses commit `715c85fd2f386719da4f41af386b1708afaf4b52` and old-name assets;
   leave those historical artifacts unchanged.
2. Extract the verified tree into an operator-owned **bootstrap directory
   outside the managed `releases/` root**. Install frozen dependencies and run
   checks there. Prepare the new config, converted stores and service units.
3. For a managed installation, set `maintenance.stargate.repository` explicitly
   to `aiconsultancy/stargate`, and configure `maintenance.stargate.root` to the
   new managed root, with no `current` or `previous` link. Retain the old
   managed root in the rollback snapshot. Set `checkout` to the verified
   local repository and keep `requireTreeCheck: true`. Run this **new-source**
   one-time installer from the bootstrap directory:

   ```sh
   mise exec -- bun scripts/bootstrap-stargate.ts /private/stargate.json VERSION FULL_COMMIT_SHA
   ```

   It checks the operator-pinned commit, release/tag origin, author, assets,
   checksum and archive tree. It uses the existing release installer to build,
   test, write the new metadata/digest and select `current`. It refuses an
   existing `current`/`previous`, and never starts/stops a service. Subsequent
   updates use `stargate maintenance update`; see the
   [manual-install runbook](maintenance.md#runbook-install-a-release-by-hand).
   Do not hand-create a directory under `releases/`, edit `current`, invent
   metadata, or label the old Pogo tree as a Stargate release.

4. Update OpenCode/Pi plugin paths, permissions, instructions and tool bindings
   to the new tree. Restart the native server only after its metadata/store
   conversion is validated. Remove the old `bun link` command registration and
   link only `stargate`. Use the same Slack app registrations/tokens; update
   their slash command to `/stargate` and remove `/pogo`.
5. Start new units against converted state. Verify readiness, chosen active
   captain/worker bindings, retained original IDs/history and any explicit
   old-session references, crew ownership and queue/reply progress without
   dispatching test work to real users. Only then enable the new timer. Never
   run old and new gateways against the same state or Slack registrations.

Rollback requires stopping all new writers and restoring the **whole** private
old snapshot with its old release, config, units, native stores and paths. Do
not feed converted state to the old binary or restore only the main SQLite
file. If new work was accepted, reconcile it explicitly before rollback.

## Deliberate persistence and safety exceptions

OpenCode message metadata intentionally keeps `pogoCrew`; active session
metadata does not. Old published archives, tags, release notes, private backup labels and arbitrary
conversation/cron/journal text retain their historical spelling. Native session,
message, bot, app, workspace, crew and receipt IDs are not renamed. Queued text
can mention an obsolete tool: keep the text and progress; explain the new tool
name on the next authorized turn rather than rewriting or replaying history.
Old config filenames remain in `.gitignore` and the attachment denylist to
protect historical credentials. These are denials, not functioning aliases.
