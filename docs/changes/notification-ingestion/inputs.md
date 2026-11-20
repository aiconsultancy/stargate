# Approved notification change provenance

These are the current approved delivery and task definitions for NET-1733,
under tracker NET-1731. This copy excludes private prompts, transcripts, local
execution logs, absolute host paths and publication receipts. The linked
source assessment and review describe their original source epoch, not new
implementation results. Later approval, readiness and tracker metadata do not
change the reviewed technical requirements.

## Design and selected policy

The owner approved the corrected 840-line R7 design on 19 November 2026.
Original source SHA-256:
`ab6025b4656308da672eb50ba8bdedced4a981dc4b1ae8f3a9c5c9da33889d50`.
The original draft-status language is historical and superseded by approval.
The owner selected bounded replay for unknown sends and stale leases, accepting
possible duplicates. Same-source identical events at the same instant merge
by signature. No optional occurrence marker is included.

The technical requirements are carried by [delivery.md](delivery.md), its
three task definitions and the implementation-facing
[notification guide](../../notification-ingestion.md). The R7 empty-host sketch
is superseded by delivery's compatible extension of the existing Fleet host.
Poller NET-1734 and IRC sink NET-1735 remain separate work.

## Independent approval

An independent Astra High reviewer approved the delivery and all three tasks
on 19 November 2026 with no blocking findings. The author and reviewer were
separate sessions. [plan-review.md](plan-review.md) preserves the review.

| Reviewed source                      | SHA-256                                                            |
| ------------------------------------ | ------------------------------------------------------------------ |
| delivery.md                          | `30932eab7b881d011a4cbb9853903fa38aa1fddca33b6eaa497267771203bc77` |
| task-01-private-api-host.md          | `ccf63ad698ea379fe1ee9114b6fbd8a7edf5a714f8c9d0893f27bbdb62345617` |
| task-02-durable-notification-core.md | `3b7bbb4c6fa2d840bb9c6021a660bc7ab008440f7050666e66f2873ff9acaecd` |
| task-03-http-slack-poc.md            | `e6d525323c5233770c92606ac7ed524e5541d6aee8b515940735cf19cb3c3e69` |
| plan-review.md                       | `52570385e03287d0ea5093f0f2bf8826ffa9a3ec2c7a027402f18fcff1f96784` |
| source-integration-check.md          | `80cee1b91e2842d07f57e04356adefbaf0c386811ae43b62cbbae8decf55a450` |

These identify the reviewed originals, not hashes of this public copy.
Public-copy differences are provenance metadata, removal of private locations,
replacement of the private archive reference and Markdown formatting. Approval
metadata uses fenced YAML so formatting preserves its nested structure.
These presentation changes grant no new scope.

## Source and dependency admission

Planning inspected `71fc14dc070bc88135e104c3e16742e8a92c28cf` and admitted
merged schema migration `b9e8999a9dc0c892e00732edb74541e855a3b266`.
The later verified predecessors are:

| Unit         | Actual merge                               | Parent                                     | Tree                                       |
| ------------ | ------------------------------------------ | ------------------------------------------ | ------------------------------------------ |
| HOST01, PR86 | `f402c692ee9106676cbafa95edd5fc2f92eddea4` | `d19ede18e4d10033b3a3e959670ed0a887ec1fea` | `6e4852124156903ed35f8f6c7a833a04f57ccd8b` |
| CORE02, PR87 | `b51cc8c9f06ab566be9beb2f56fc19199ffb7532` | `f402c692ee9106676cbafa95edd5fc2f92eddea4` | `b0c94021c7f2b5eb3854c6aa3f850130cb2878d2` |

Task03 is admitted at the actual CORE02 base. The host provides trusted routes,
early `closeAdmission()` and settlement-aware `stop()`. The core provides
`publish`, `closeAdmission()`, `shutdown()` and supervised `failure`.
`closeAdmission()` also stops claims; there is no `stopClaims()` export.
An unresolved shutdown retains ownership and requires runtime process exit.

Plan approval is not implementation proof, merge readiness, release approval,
deployment authority or approval for live credentials, audiences and channels.
See [publication.md](publication.md) for the retained publication boundary.
