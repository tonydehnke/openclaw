import type {
  BlockAction,
  ButtonAction,
  SlackActionMiddlewareArgs,
  AllMiddlewareArgs,
} from "@slack/bolt";
import type { SlackMonitorContext } from "../context.js";
import { enqueueSystemEvent } from "../../../infra/system-events.js";

// Prefix for OpenClaw-generated action IDs to scope our handler
const OPENCLAW_ACTION_PREFIX = "openclaw:";

export function registerSlackInteractionEvents(params: { ctx: SlackMonitorContext }) {
  const { ctx } = params;

  // Handle Block Kit button clicks from OpenClaw-generated messages
  // Only matches action_ids that start with our prefix to avoid interfering
  // with other Slack integrations or future features
  ctx.app.action(
    new RegExp(`^${OPENCLAW_ACTION_PREFIX}`),
    async (args: SlackActionMiddlewareArgs<BlockAction<ButtonAction>> & AllMiddlewareArgs) => {
      const { ack, body, action, client } = args;

      // Acknowledge the action immediately to prevent the warning icon
      await ack();

      // Extract action details using proper Bolt types
      const actionId = action.action_id;
      const blockId = action.block_id;
      const value = action.value;
      const userId = body.user.id;
      const channelId = body.channel?.id;
      const messageTs = body.message?.ts;

      // Log the interaction for debugging
      ctx.runtime.log?.(`slack:interaction action=${actionId} user=${userId} channel=${channelId}`);

      // Send a system event to notify the agent about the button click
      // Pass undefined (not "unknown") to allow proper main session fallback
      const sessionKey = ctx.resolveSlackSystemEventSessionKey({
        channelId: channelId,
        channelType: "channel",
      });

      // Build context key - only include defined values to avoid "unknown" noise
      const contextParts = ["slack:interaction", channelId, messageTs, actionId].filter(Boolean);
      const contextKey = contextParts.join(":");

      enqueueSystemEvent(
        `Slack button clicked: actionId=${actionId} value=${value ?? "none"} user=${userId}`,
        {
          sessionKey,
          contextKey,
        },
      );

      // Update the original message: replace only the clicked button row
      // with a confirmation, keeping all other blocks intact
      if (channelId && messageTs && body.message) {
        try {
          const originalBlocks = (body.message as { blocks?: unknown[] }).blocks ?? [];
          const buttonText = action.text?.text ?? actionId;

          // Replace the actions block that contained the clicked button
          // with a context block showing the confirmation
          let updatedBlocks = originalBlocks.map((block: unknown) => {
            const b = block as { type?: string; block_id?: string };
            if (b.type === "actions" && b.block_id === blockId) {
              return {
                type: "context",
                elements: [{ type: "mrkdwn", text: `✓ *${buttonText}* selected` }],
              };
            }
            return block;
          });

          // If no individual action rows remain, remove the bulk buttons too.
          // Bulk action_ids contain "_all_", individual ones don't.
          const remainingActionBlocks = updatedBlocks.filter((block: unknown) => {
            const b = block as { type?: string; elements?: { action_id?: string }[] };
            if (b.type !== "actions") {
              return false;
            }
            // Check if this is a bulk actions block (all elements have "_all_" in action_id)
            const isBulk = b.elements?.every((el) => el.action_id?.includes("_all_"));
            return !isBulk;
          });

          if (remainingActionBlocks.length === 0) {
            // All individual rows resolved — remove bulk buttons and preceding divider
            updatedBlocks = updatedBlocks.filter((block: unknown, i: number) => {
              const b = block as { type?: string; elements?: { action_id?: string }[] };
              if (
                b.type === "actions" &&
                b.elements?.every((el) => el.action_id?.includes("_all_"))
              ) {
                return false;
              }
              // Remove divider directly before the bulk actions block
              if (b.type === "divider") {
                const next = updatedBlocks[i + 1] as
                  | { type?: string; elements?: { action_id?: string }[] }
                  | undefined;
                if (
                  next?.type === "actions" &&
                  next.elements?.every((el) => el.action_id?.includes("_all_"))
                ) {
                  return false;
                }
              }
              return true;
            });
          }

          await client.chat.update({
            channel: channelId,
            ts: messageTs,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            blocks: updatedBlocks as any[],
            text: (body.message as { text?: string }).text ?? "",
          });
        } catch {
          // If update fails, the action was still acknowledged and the system event sent
        }
      }
    },
  );
}
