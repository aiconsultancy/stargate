```yaml
from: delivery.md
status: ready
readiness: actual-predecessor-merges-and-interface-handoffs-verified
actual-base: b51cc8c9f06ab566be9beb2f56fc19199ffb7532
actual-host-merge: f402c692ee9106676cbafa95edd5fc2f92eddea4
actual-core-merge: b51cc8c9f06ab566be9beb2f56fc19199ffb7532
created: "2026-11-19"
approval:
  by: "Independent Astra High"
  date: "2026-11-19"
  evidence: plan-review.md
  reviewed-sha256: e6d525323c5233770c92606ac7ed524e5541d6aee8b515940735cf19cb3c3e69
depends-on:
  - task-01-private-api-host.md
  - task-02-durable-notification-core.md
work-items: [NET-1733]
tracker-document-id: e8c3d40e-293b-41d8-a110-9db9a8f86e3b
tracker-document-url: https://linear.app/nettworks/document/approved-delivery-plan-private-notification-http-host-durable-core-and-9ed01fe8b367
existing-issue: NET-1733
role: L4-implementation-with-independent-L3-review
```

# Task 03: Wire the default-off HTTP and Slack POC

Readiness metadata updated on 20 November 2026. Captain verified actual HOST
PR86 and CORE PR87 merges, their exact reviewed trees, required checks and
concrete interface handoffs. This clears the dependency gate, not the task's
implementation, verification, review or publication gates. Approved technical
requirements and the original reviewed SHA remain unchanged.

## Start evidence and coverage

Start only after tasks 01/02 merge with their direct evidence and current main
is reconciled. Read delivery, `source-integration-check.md` sections 4-6 and
its verification seams, and both final interface handoffs. Record actual
base SHA, independent plan approval, ready status and tracker publication.
Admitted source is b9 in delivery. PR #77 is merged; use current Effect
Schema helpers, `.Type`/Result contracts and caller mutability. Do not restore
Zod to runtime/routing/store consumers or repeat migration evidence.
This is the sole runtime/config integration owner. It completes REQ-01 through
REQ-10 at the real process boundary, with local fixtures only.

Load change-readiness, TypeScript engineering/testing, model-boundary,
boundary-discipline, idempotence and verification guidance. Read the installed
Effect guide before wiring its scopes. L4 owns integration and lifetime work;
an independent L3 reviewer checks the exact resulting diff and evidence.

## One-writer files

New:

- `src/notifications/ingest/config.ts`, `binding.ts`, `http.ts`, `slack.ts`.
- `tests/notify-config.test.ts`, `tests/notify-http.test.ts`,
  `tests/notify-slack.test.ts`, `tests/notify-runtime.test.ts`,
  `tests/notify-runtime-fixture.ts`.
- `docs/notification-ingestion.md` and approved change artifacts under
  `docs/changes/notification-ingestion/`.

Existing bounded integration:

- `src/config.ts`, `src/app/setup.ts`, `src/app/config-reload.ts`, `src/app/cli.ts`.
- `src/app/runtime.ts`, `src/slack/slack.ts`; task-01 route composition signature only
  if its actual consumer needs a small correction.
- Existing runtime, reload, config, CLI, setup and Slack tests as needed;
  their exact paths are in the regression command below.
- `README.md`, `docs/{api,configuration,operations,design}.md`, `CHANGELOG.md`.
- `stargate.example.json`, disabled example only.

Do not change gateway/crew admission, existing mute behavior, backend models,
drain/steer/version algorithms, dependency pins or deployment/service files.
Do not use a separate PR to wire unsafe producers before binding checks exist.

## Work

1. Add optional strict `notify` config. Each HTTP adapter has `enabled: false`
   by default, canonical namespace path, stable source IDs, token environment
   references, topic grants, audience and rate. Only built-in `http` exists.
   Destinations accept explicit C/G Slack channel IDs and registered bots;
   reject wildcard/DM/IRC targets and unknown poller types. Check subscription
   references, finite counts and bounds even on disabled entries.
2. Require API Unix mode for enabled HTTP input. Reuse `settingsStruct` and
   existing effective-environment resolution. Extend `checkCredentials` and
   its CLI/reload callers to check enabled producer references without
   displaying values or altering `process.env`. Disabled entries need no
   live secret values. Keep all `notify` changes restart-only.
3. Reject ambiguous resolved producer credentials, reused operator credentials
   and credentials shared across source scopes. Use constant-time comparison
   with length-safe handling. Fail with fixed errors. Runtime checks the loaded
   operator token before exposing routes. Config-check must not create or
   rotate it.
4. Add delivery's conservative offline echo validation. Startup resolves all
   registration identities before enabling producer admission or send workers.
   Freeze registration/app/workspace/bot-user/channel and both audiences.
   Check current access, physical binding and echo exclusion immediately before
   send using the runtime's atomically updated settings views. No directory or
   network call is added to `config check`.
5. Mount authenticated HTTP adapters through the existing API owner. Enforce
   source rate, JSON content type and strict envelope after header auth and
   body bound. Call `publish` through the installed Effect/Promise signal
   boundary. Return signature/duplicate at `202` only after commit. Map bad
   input to 400/413/415, missing credential to 401, topic denial to 403, source
   rate to 429, and full queue/store/concurrency/shutdown to 503. Supply
   Retry-After on 429/503 and fixed code/correlation errors without input echo.
6. Add the request-scoped notification send on `SlackConnection`, using the
   same credentials/options and `historyWeb(signal)` pattern. Render separate
   plain sections plus escaped fallback in one call, no mentions/Markdown/
   attachment/unfurl. Distinguish confirmed success, proven unsent refusal and
   unknown delivery conservatively. SDK abort/network/5xx ambiguity is unknown;
   honor provider Retry-After when positively rate limited. Never use the old
   `announce` as if it cancelled its shared client request.
7. Acquire notify.sqlite under the existing runtime lock only when needed.
   Start core/sends only after all transport connections and binding checks
   succeed, like existing worker startup. Pass current binding readers to the
   sink. Disabled feature creates no notify store, worker, route or Slack call.
8. Integrate early producer/admission close with `closeIntake`, before worker
   interruption. Stop claims, settle waiters and abort/settle sends, then close
   SQLite. Keep Fleet shutdown, backend shutdown and instance-lock order.
   Arm a referenced 25-second timer at early notification shutdown, before
   awaiting worker interruption. Clear it only after local users settle.
   The runtime's production termination callback calls `process.exit(1)`;
   inject a `never`-return callback for isolated tests. Keep store and instance
   lock owned until settlement or process death. Cover startup failure too.
   Never time out the store finalizer and continue while a send can write.
9. Document flags, response meanings, exact retry identity, private modes,
   conservative echo checks, limits, config changes and rollback. Use R7's
   glossary terms locally in `docs/notification-ingestion.md`. List new flags
   with off defaults in Unreleased Feature flags. Include a local fixture
   recipe and a clearly gated future operator live-proof procedure.

## Acceptance and focused checks

Use real temporary Unix HTTP and SQLite, fake Slack endpoints, injected
runtime connections/backends and shortened test deadlines.

- Omitted/disabled feature creates no notify.sqlite or route; Fleet still
  answers. Invalid disabled config still fails decoding. New enabled config
  without Unix API, unknown types, invalid destinations and duplicate mounts
  fail before startup completes.
- No network config-check calls. Missing enabled secret fails safely; two
  source secrets resolving to one value fail. Same-principal secret rotation
  does not change signatures or frozen destination identity.
- Producer credentials fail on every Fleet route. Operator bearer cannot
  publish. Cross-source grants and JSON source/destination/signature claims
  fail. Producer Origin/preflight receives no CORS. Logs contain no bodies,
  tokens, raw headers, URLs or raw provider errors.
- HTTP 202 is observed after real commit. Lose the response, restart, resend
  the identical event: duplicate and no extra admission. 503 rollback creates
  neither partial fanout nor lost old rows. Another destination continues when
  one Slack request stalls or rate limits.
- Actual fake HTTP request observes abort. No SDK hidden retries occur.
  Unknown delivery consumes persisted attempts and replays within limits.
  Maximum title/body/URL and multibyte characters fit valid bounded blocks in
  one call. `<@U...>`, `<!channel>`, Markdown, `/cron`, agent names, CR/LF/NUL
  remain inert text; no structured mentions or executable instructions.
- Alias rebound, changed app/workspace/user, removed destination, denied
  channel, audience widening or new receiver echo conflict drops the old row.
  Backend/model changes alone do not redefine its sending principal.
- Conflicting destination config/startup fails. Inject current access change
  between claim and send: no unsafe post. Ordinary peer chat tests still pass.
  Integration spies observe zero notification-origin Gateway/backend calls.
- New notify config is restart-only. Current access revocation takes effect
  without waiting for restart; failed reload does not advance binding state.
- Startup connection failure starts no notification sends. Shutdown rejects
  new requests, resolves queued callers, stops underlying sends and closes
  store last. Child process with never-settling sink exits nonzero at grace;
  reopening retained rows obeys attempts/age. No write after close is possible.
- Existing maintenance drain, follow-up steering, ready behavior, installed
  release version and checkout version regressions pass.

New focused suites:

```sh
mise exec -- bun test tests/notify-config.test.ts tests/notify-http.test.ts tests/notify-slack.test.ts tests/notify-runtime.test.ts
```

Existing regressions:

```sh
mise exec -- bun test tests/runtime.test.ts tests/runtime-reload.test.ts tests/config-reload.test.ts tests/cli.test.ts tests/setup.test.ts tests/slack.test.ts tests/peers.test.ts tests/routing.test.ts tests/maintenance-drain-runtime.test.ts tests/thread-followups.test.ts tests/irc-followups.test.ts tests/opencode-steer.test.ts tests/api-v1-server.test.ts tests/api-v1-gateway-version.test.ts tests/release-version.test.ts
```

Run delivery's full gates after focused checks. A passing fake endpoint does
not claim live channel rights, credentials or deployed service behavior.

## Finish evidence and release limits

Record the end-to-end HTTP/commit/fake-Slack result, restart state, auth matrix,
shutdown child result, full gate exits and independent code review at exact
head. Report NET-1733's local implementation acceptance separately from any
future live proof. No poller/IRC/cloud prerequisite remains. Preserve the
normal authorization boundary for commit/push/PR, release and live activation.
