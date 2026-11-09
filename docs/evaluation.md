# Evaluation and improvement

Run the focused request evaluations before changing conversation coordination:

```sh
make eval
```

`mise.toml` owns the command. The same tests also run in `make check` and CI.
They use Bun, real SQLite and controlled native Effects or fake delivery. They
do not post to Slack, call a provider, create real captain/crew sessions, change
project files or replay failed production requests.

## Score gates

All cases must pass. Do not average a privacy or no-replay failure into a
good score. Native worker completion and observation completion are separate.

| Case                               | Required observation                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------------ |
| Busy observation cancellation      | Observer settles and finalizes while worker stays busy.                              |
| Already cancelled                  | No native observation starts.                                                        |
| Two source requests with busy crew | Both receive their own answer through one captain; crew task/input remain unchanged. |
| Explicit task completion           | Captain wait returns retained result before native worker idle; no interrupt.        |
| Concurrent source admission        | Native captain turns never overlap.                                                  |
| Prior continuation                 | Prior text and current answer retain their proven source.                            |
| Native UI input                    | Unmapped input clears Slack ownership, even without output.                          |
| Unreadable history                 | Delivery stays delayed; no invented answer or extra prompt.                          |
| Delivery retry                     | Exact destination and result survive; no reread or rerun.                            |

Additional crew-origin gates use the production parser: late private results
return to their task's source; crew text cannot enter another turn's preview;
Stop does not interrupt a foreign wake; and a cursor-only wake retains its origin
before its answer arrives.

Controlled completion barriers test progress without machine-dependent latency
scores. The production idle probe still has its 100 ms deadline. Cancellation
tests require the native observer's finalizer, not just a raced Promise that
leaves native observation running.

## First improvement

The installed OpenCode plugin 2.2.5 Promise adapter discards per-call request
options. An idle probe could therefore wait indefinitely despite its abort
signal. Wait cleanup could also outlive an explicitly completed crew result.
The initial cancellation reproduction failed both observer cases.

Pogo now binds only native session wait through the Effect host and forwards its
abort signal to the runner. The rest of the plugin keeps the installed adapter
and its registration/cleanup behavior. No dependency upgrade or HTTP endpoint
configuration is required. Remove this narrow bridge when the upstream Promise
adapter forwards request signals and the same evaluations pass without it.

This fixes an observation boundary, not all concurrent project orchestration.
The model responses in these tests are controlled fixtures. They do not prove
that an actual model will yield promptly or keep task semantics separate. The
crew-origin cases use the production OpenCode parser over local HTTP history,
not a fixture that assumes synthetic ownership. Keep model-level behavior as
distinct remaining work; do not claim full concurrency from this score.

## Small-change procedure

1. Keep a synthetic request and failure oracle for an observed problem. Exclude
   credentials, copied production transcripts and project-specific private data.
2. Record the failing case. Make one minimum correction without changing the
   oracle to accept the old failure.
3. Rerun the affected case and the remaining gates as regression cases. Follow
   the owning project's full checks, review, merge and deployment requirements.
4. Recheck the next relevant real outcome. Record a useful lesson in the existing
   journal/ship log; change instructions only when the evidence supports it.

Live model trials are separate. Use a permitted test destination and an idle
task boundary, bounded read-only requests and retained admission IDs. Do not
interrupt unrelated work, create replacement captains or resend the original
failed assignment to obtain a score. No automatic schedule is implied.

## Automation principles

[Building effective agent automations](https://claude.dev/blog/building-effective-agent-automations/)
provides useful principles without requiring its hosted runtime:

- Keep operator policy separate from agent-written state. Policy changes are
  explicit proposals; memory is evidence, not new authority.
- Use existing per-source cursors and durable delivery progress rather than
  fixed lookback windows or a second ledger. Advance delivery only on confirmation.
- Distinguish unreadable sources from empty results; preserve their cursor and
  report the unavailable source.
- Recheck live evidence before reporting completion. Checks, merge and verified
  deployment are separate outcomes; uncertain posting is not confirmed delivery.
- Bound observations and expose stop causes. A healthy gateway process alone
  does not prove an individual captain request is making progress.

The cancellation and delivery cases cover specific mechanics of these rules.
Policy isolation, source-tool freshness and model decision quality need their own
evidence before changing permissions, storage or prompts. Keep Pogo's durable
captain identity; request boundaries do not require fresh captain sessions.
