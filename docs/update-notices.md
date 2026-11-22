# Session update notices

The [restart drain](maintenance.md#restart-drain) also uses these local context
queues for advance and completion notices. It has its own opt-in flag,
`maintenance.drain.enabled`, and does not require `notifications.updateNotice`.
Drain notices are deduplicated by run, phase and session; completion replaces
unread advance context. They never create a synthetic native inbox input.

`notifications.updateNotice` defaults to **false**. After a separately approved
installation, an operator can enable it in the gateway configuration:

```json
{
  "notifications": {
    "updateNotice": true
  }
}
```

On readiness, a changed release version or effective configuration queues a
short context notice for each pinned OpenCode captain and provisioned OpenCode
crew session. Pi crew receive plain Mesij mail in their existing inbox. No
worker is created or woken. Unpinned Slack sessions receive the notice just
before their next normal turn, not during startup. Existing transport intake,
permissions and task ownership remain authoritative.

OpenCode sessions use a local context queue in the existing crew store.
The existing session context hook consumes it at the next model request
that normal work already started. It creates no native inbox input or
transcript boundary: a passive notice cannot block uncertain-task
reconciliation or invalidate result lineage.
A busy turn is not interrupted. An idle session does not start a model turn
because of the notice. The notice is information, not an assignment: it asks
for no acknowledgement and grants no permission to repeat work or change
settings. Pi mail uses the existing mail routes, without a direct notification.

## Content and receipts

The gateway reuses the installed release metadata and `CHANGELOG.md`. Versioned
bullet summaries newer than the last confirmed notice are included, with a link
to the target release notes. `Unreleased` bullets belong to the installed
version. A checkout has no release version and cannot provide a release link.
Older changes absent from the shipped changelog are not invented.

The crew plugin's registered tool listing supplies Stargate tool names and
hashes of their descriptions and schemas. Added, removed and changed names are
listed, not tool results, descriptions or schemas. Current meta-command syntax
comes from the existing command table. A failed tool-list read preserves the
previous known list instead of claiming that tools were removed.

The source-owned flag list in `src/maintenance/update-notice.ts` supplies current on/off
states. Add future notice-worthy flags there and document their defaults in
the changelog. Access rules, model selections and native permissions contribute
to a configuration digest but are not copied into prose. Environment values,
credential references, resource paths, prompts and transcripts are not sent.
Changelog summaries are credential-redacted before persistence and delivery.

Each session has a receipt in its existing gateway or crew SQLite owner.
The last confirmed version and digest prevent duplicates after an unchanged
restart. The intent is persisted before native admission. A lost or failed
admission receipt is `uncertain`, not proof the session was told. Such an
admission is not automatically replayed; a later version/configuration notice
still summarises from the last confirmed baseline. Queued means stored for
future consumption, not read by the model.

Readiness records include `updateNotices` with `queued`, `mail`, `unchanged` or
`uncertain` status. Maintenance copies receipts from readiness records written
during that run into its private report and summary. It does not repeat old
receipts in a later no-op run. Gateway startup bounds notice processing and
continues if notices are unavailable. Next-turn preparation is separately
bounded so a failed notice service does not block normal work indefinitely.

This feature does not install a release, restart services, enable another flag
or change live OpenCode configuration. Enabling it requires a gateway restart;
it is not part of the live configuration reload allow-list.
