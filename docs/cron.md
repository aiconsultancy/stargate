# Recurring prompts

Use `/cron` in an allowed channel or DM to manage recurring prompts.
Each schedule repeatedly sends its prompt to the current bot's backend.
Selecting **Add** authorizes recurring execution, not only prompt storage.
Scheduled work uses the bot's existing tools and access. Results are posted
in a new thread in the channel where you created the schedule.

## Commands

| Command                 | Result                                        |
| ----------------------- | --------------------------------------------- |
| `/cron` or `/cron list` | Open your schedules for this bot and channel. |
| `/cron add`             | Open the Add form.                            |
| `/cron remove`          | Open your list with Remove buttons.           |

Lists show 10 schedules per page. Use **Next**, **Previous**, or **Refresh**.
The list is private to you; it does not list other users' schedules.
Use **Add** in the list to create a schedule. A successful submission saves
the schedule and closes the modal. Run `/cron` again to inspect it.

The form requires:

- **Name:** a short task label, up to 80 characters.
- **Cron expression:** five fields: minute, hour, day-of-month, month,
  day-of-week. For example, `0 9 * * 1-5` runs at 09:00 on weekdays.
- **IANA timezone:** explicit scheduling timezone, default `UTC`.
  Examples: `Europe/London`, `America/New_York`.
- **Recurring prompt:** the task to run, up to 3000 characters in this form.

Use **Remove**, then confirm, to stop future runs. An already queued or
running request may still finish. Removal does not undo tool actions.

## Access and setup

The Slack app must register `/cron`, grant the `commands` bot scope, and
enable interactivity with Socket Mode. Existing installations need the
updated manifest and may need reinstallation. Follow [setup](setup.md).
Changing a local manifest does not update an installed Slack app.

Custom slash commands cannot run inside message threads. Invoke `/cron` from
the channel or DM composer. Slack command names are workspace-wide: if another
app registers `/cron`, Slack routes that name to the most recently installed
app. Do not register the same command on multiple Pogo apps in one workspace.

Each command, button, and form submission checks the configured app and
workspace, current user/channel access, and schedule ownership. Denies
override allows. You can manage only schedules you created for the current
bot/backend identity and channel. Changing backend settings selects another
schedule namespace; old schedules are not executed with the new backend.

## Limits

- Pogo must be running for scheduled work to start.
- Missed intervals are skipped, not replayed as a backlog.
- A schedule does not start overlapping runs while prior work is active.
- Access is checked again before scheduled work and reply delivery.
- Retried form submissions do not create duplicate schedules.
- Interrupted or uncertain Slack announcements are not automatically reposted.
- Missing gateway queue history holds the schedule until you remove it;
  Pogo does not guess whether its tools ran.
- No exactly-once guarantee applies to external tool actions or Slack delivery.
- Prompts are stored in the private SQLite state. Keep backups private.

The UI uses Slack's [modal lifecycle](https://docs.slack.dev/surfaces/modals)
and [confirmation dialogs](https://docs.slack.dev/reference/block-kit/composition-objects/confirmation-dialog-object).
