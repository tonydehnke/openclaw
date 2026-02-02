import type { SlackActionMiddlewareArgs } from "@slack/bolt";
import type { SlackMonitorContext } from "../context.js";
import { enqueueSystemEvent } from "../../../infra/system-events.js";

export function registerSlackInteractionEvents(params: { ctx: SlackMonitorContext }) {
  const { ctx } = params;

  // Handle Block Kit button clicks and other interactions
  // Using a regex that matches all action_ids
  ctx.app.action(/^.*/, async (args: SlackActionMiddlewareArgs) => {
    const { ack, body, action, respond } = args;

    // Acknowledge the action immediately to prevent the warning icon
    await ack();

    // Extract action details from the payload
    const actionId = (action as { action_id?: string })?.action_id;
    const blockId = (action as { block_id?: string })?.block_id;
    const value = (action as { value?: string })?.value;
    const userId = body.user?.id;
    const channelId = body.channel?.id;
    const messageTs = (body as { message?: { ts?: string } }).message?.ts;

    // Log the interaction for debugging
    ctx.runtime.log?.(`slack:interaction action=${actionId} user=${userId} channel=${channelId}`);

    // Send a system event to notify the agent about the button click
    // This allows agents to respond to interactions
    const sessionKey = ctx.resolveSlackSystemEventSessionKey({
      channelId: channelId ?? "unknown",
      channelType: "channel",
    });

    enqueueSystemEvent(
      `Slack button clicked: actionId=${actionId ?? "unknown"} value=${value ?? "none"} user=${userId ?? "unknown"}`,
      {
        sessionKey,
        contextKey: `slack:interaction:${channelId ?? "unknown"}:${messageTs ?? "unknown"}:${actionId ?? "unknown"}`,
      },
    );

    // Send an ephemeral confirmation to the user
    // This gives immediate feedback that the click was received
    if (respond) {
      try {
        await respond({
          text: `Button "${actionId}" clicked!`,
          response_type: "ephemeral",
        });
      } catch {
        // If respond fails, the action was still acknowledged
        // The system event will notify the agent
      }
    }
  });
}
