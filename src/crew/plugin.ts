import { Plugin } from "@opencode/plugin";
import { Error as ToolError } from "@opencode/plugin/promise/tool";
import { CrewEngine, crewInputSchema, mailInputSchema } from "./engine";
import { CrewError } from "./state";

// greybeard: four shared workers, one task each; no captain wakeups.
// Autonomous continuations require correlated Slack delivery first.
// Host tools and the general HTTP API are not an OS sandbox.
export default Plugin.define({
  id: "pogo.crew",
  async setup(ctx) {
    let engine: CrewEngine;
    try {
      engine = await CrewEngine.open(
        ctx.options,
        ctx.session,
        undefined,
        ctx.agent,
      );
    } catch (error) {
      throw new Error(
        error instanceof CrewError
          ? error.message
          : "Pogo crew setup failed; check private state access and options.",
      );
    }
    try {
      await ctx.tool.transform((editor) => {
        editor.add({
          name: "pogo_crew",
          description:
            "Manage Pogo's four persistent crew slots. Bowser may ensure, dispatch, wait, status and compact. Assigned workers complete tasks or send task-scoped urgency. Busy dispatches do not queue. Never auto-wake captains.",
          input: crewInputSchema,
          options: { codemode: false, permission: "pogo_crew" },
          async execute(input, context) {
            await ctx.permission.assert({
              sessionID: context.sessionID,
              agent: context.agent,
              source: {
                type: "tool",
                messageID: context.messageID,
                id: context.id,
              },
              action: "pogo_crew",
              resources: [input.op],
              save: [input.op],
            });
            try {
              const result = await engine.run(input, context);
              return { content: JSON.stringify(result) };
            } catch (error) {
              throw new ToolError({
                message:
                  error instanceof CrewError
                    ? error.message
                    : "Crew operation failed; raw details withheld.",
              });
            }
          },
        });
        editor.add({
          name: "pogo_mail",
          description:
            "Send or read Mesij mail for an owned task. Recipients are fixed crew slots or that task's captain. Never wakes agents. Inbox filters sent messages and unrelated task mail; pass nextAfter as after to acknowledge a page.",
          input: mailInputSchema,
          options: { codemode: false, permission: "pogo_mail" },
          async execute(input, context) {
            await ctx.permission.assert({
              sessionID: context.sessionID,
              agent: context.agent,
              source: {
                type: "tool",
                messageID: context.messageID,
                id: context.id,
              },
              action: "pogo_mail",
              resources: [input.op],
              save: [input.op],
            });
            try {
              return {
                content: JSON.stringify(await engine.mail(input, context)),
              };
            } catch (error) {
              throw new ToolError({
                message:
                  error instanceof CrewError
                    ? error.message
                    : "Mail operation failed; raw details withheld.",
              });
            }
          },
        });
      });
    } catch {
      engine.close();
      throw new Error(
        "Pogo crew tool registration failed; check plugin compatibility.",
      );
    }
    return () => engine.close();
  },
});
