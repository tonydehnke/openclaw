import {
  applyAccountNameToChannelSection,
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  formatPairingApproveHint,
  migrateBaseNameToDefaultAccount,
  normalizeAccountId,
  setAccountEnabledInConfigSection,
  type ChannelPlugin,
  type ChannelMessageActionName,
} from "openclaw/plugin-sdk";
import { MattermostConfigSchema } from "./config-schema.js";
import { resolveMattermostGroupRequireMention } from "./group-mentions.js";
import {
  listEnabledMattermostAccounts,
  listMattermostAccountIds,
  resolveDefaultMattermostAccountId,
  resolveMattermostAccount,
  type ResolvedMattermostAccount,
} from "./mattermost/accounts.js";
import { normalizeMattermostBaseUrl } from "./mattermost/client.js";
import {
  buildButtonAttachments,
  getInteractionCallbackUrl,
  resolveInteractionCallbackUrl,
} from "./mattermost/interactions.js";
import { monitorMattermostProvider } from "./mattermost/monitor.js";
import { probeMattermost } from "./mattermost/probe.js";
import { sendMessageMattermost } from "./mattermost/send.js";
import { looksLikeMattermostTargetId, normalizeMattermostMessagingTarget } from "./normalize.js";
import { mattermostOnboardingAdapter } from "./onboarding.js";
import { getMattermostRuntime } from "./runtime.js";

const meta = {
  id: "mattermost",
  label: "Mattermost",
  selectionLabel: "Mattermost (plugin)",
  detailLabel: "Mattermost Bot",
  docsPath: "/channels/mattermost",
  docsLabel: "mattermost",
  blurb: "self-hosted Slack-style chat; install the plugin to enable.",
  systemImage: "bubble.left.and.bubble.right",
  order: 65,
  quickstartAllowFrom: true,
} as const;

function normalizeAllowEntry(entry: string): string {
  return entry
    .trim()
    .replace(/^(mattermost|user):/i, "")
    .replace(/^@/, "")
    .toLowerCase();
}

function formatAllowEntry(entry: string): string {
  const trimmed = entry.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.startsWith("@")) {
    const username = trimmed.slice(1).trim();
    return username ? `@${username.toLowerCase()}` : "";
  }
  return trimmed.replace(/^(mattermost|user):/i, "").toLowerCase();
}

export const mattermostPlugin: ChannelPlugin<ResolvedMattermostAccount> = {
  id: "mattermost",
  meta: {
    ...meta,
  },
  onboarding: mattermostOnboardingAdapter,
  pairing: {
    idLabel: "mattermostUserId",
    normalizeAllowEntry: (entry) => normalizeAllowEntry(entry),
    notifyApproval: async ({ id }) => {
      console.log(`[mattermost] User ${id} approved for pairing`);
    },
  },
  capabilities: {
    chatTypes: ["direct", "channel", "group", "thread"],
    threads: true,
    media: true,
  },
  streaming: {
    blockStreamingCoalesceDefaults: { minChars: 1500, idleMs: 1000 },
  },
  reload: { configPrefixes: ["channels.mattermost"] },
  configSchema: buildChannelConfigSchema(MattermostConfigSchema),
  config: {
    listAccountIds: (cfg) => listMattermostAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveMattermostAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultMattermostAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: "mattermost",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg,
        sectionKey: "mattermost",
        accountId,
        clearBaseFields: ["botToken", "baseUrl", "name"],
      }),
    isConfigured: (account) => Boolean(account.botToken && account.baseUrl),
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.botToken && account.baseUrl),
      botTokenSource: account.botTokenSource,
      baseUrl: account.baseUrl,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveMattermostAccount({ cfg, accountId }).config.allowFrom ?? []).map((entry) =>
        String(entry),
      ),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom.map((entry) => formatAllowEntry(String(entry))).filter(Boolean),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const useAccountPath = Boolean(cfg.channels?.mattermost?.accounts?.[resolvedAccountId]);
      const basePath = useAccountPath
        ? `channels.mattermost.accounts.${resolvedAccountId}.`
        : "channels.mattermost.";
      return {
        policy: account.config.dmPolicy ?? "pairing",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: basePath,
        approveHint: formatPairingApproveHint("mattermost"),
        normalizeEntry: (raw) => normalizeAllowEntry(raw),
      };
    },
    collectWarnings: ({ account, cfg }) => {
      const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
      const groupPolicy = account.config.groupPolicy ?? defaultGroupPolicy ?? "allowlist";
      if (groupPolicy !== "open") {
        return [];
      }
      return [
        `- Mattermost channels: groupPolicy="open" allows any member to trigger (mention-gated). Set channels.mattermost.groupPolicy="allowlist" + channels.mattermost.groupAllowFrom to restrict senders.`,
      ];
    },
  },
  groups: {
    resolveRequireMention: resolveMattermostGroupRequireMention,
  },
  messaging: {
    normalizeTarget: normalizeMattermostMessagingTarget,
    targetResolver: {
      looksLikeId: looksLikeMattermostTargetId,
      hint: "<channelId|user:ID|channel:ID>",
    },
  },
  actions: {
    listActions: ({ cfg }) => {
      const accounts = listEnabledMattermostAccounts(cfg).filter((a) => a.botToken && a.baseUrl);
      if (accounts.length === 0) {
        return [];
      }
      return ["send"] satisfies ChannelMessageActionName[];
    },
    supportsButtons: ({ cfg }) => {
      const accounts = listEnabledMattermostAccounts(cfg).filter((a) => a.botToken && a.baseUrl);
      return accounts.length > 0;
    },
    handleAction: async ({ action, params, cfg, accountId }) => {
      if (action !== "send") {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Unsupported action: ${action}` }],
        };
      }

      const to =
        typeof params.to === "string"
          ? params.to.trim()
          : typeof params.target === "string"
            ? params.target.trim()
            : "";
      if (!to) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: "Send requires a target (to)." }],
        };
      }

      const message = typeof params.message === "string" ? params.message : "";
      const replyToId = typeof params.replyToId === "string" ? params.replyToId : undefined;
      const resolvedAccountId = accountId ?? undefined;

      // Build props with button attachments if buttons are provided
      let props: Record<string, unknown> | undefined;
      if (params.buttons && Array.isArray(params.buttons)) {
        const account = resolveMattermostAccount({ cfg, accountId: resolvedAccountId });
        const callbackUrl = resolveInteractionCallbackUrl(account.accountId, cfg);

        const buttons = (params.buttons as Array<Record<string, unknown>>).map((btn) => ({
          id: String(btn.id ?? btn.callback_data ?? ""),
          name: String(btn.text ?? btn.name ?? btn.label ?? ""),
          style: (btn.style as "default" | "primary" | "danger") ?? "default",
          context:
            typeof btn.context === "object" && btn.context !== null
              ? (btn.context as Record<string, unknown>)
              : undefined,
        }));

        const attachmentText =
          typeof params.attachmentText === "string" ? params.attachmentText : undefined;
        props = {
          attachments: buildButtonAttachments({
            callbackUrl,
            buttons,
            text: attachmentText,
          }),
        };
      }

      const mediaUrl =
        typeof params.media === "string" ? params.media.trim() || undefined : undefined;

      const result = await sendMessageMattermost(to, message, {
        accountId: resolvedAccountId,
        replyToId,
        props,
        mediaUrl,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              ok: true,
              channel: "mattermost",
              messageId: result.messageId,
              channelId: result.channelId,
            }),
          },
        ],
      };
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => getMattermostRuntime().channel.text.chunkMarkdownText(text, limit),
    chunkerMode: "markdown",
    textChunkLimit: 4000,
    resolveTarget: ({ to }) => {
      const trimmed = to?.trim();
      if (!trimmed) {
        return {
          ok: false,
          error: new Error(
            "Delivering to Mattermost requires --to <channelId|@username|user:ID|channel:ID>",
          ),
        };
      }
      return { ok: true, to: trimmed };
    },
    sendText: async ({ to, text, accountId, replyToId }) => {
      const result = await sendMessageMattermost(to, text, {
        accountId: accountId ?? undefined,
        replyToId: replyToId ?? undefined,
      });
      return { channel: "mattermost", ...result };
    },
    sendMedia: async ({ to, text, mediaUrl, accountId, replyToId }) => {
      const result = await sendMessageMattermost(to, text, {
        accountId: accountId ?? undefined,
        mediaUrl,
        replyToId: replyToId ?? undefined,
      });
      return { channel: "mattermost", ...result };
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      connected: false,
      lastConnectedAt: null,
      lastDisconnect: null,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      botTokenSource: snapshot.botTokenSource ?? "none",
      running: snapshot.running ?? false,
      connected: snapshot.connected ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      baseUrl: snapshot.baseUrl ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ account, timeoutMs }) => {
      const token = account.botToken?.trim();
      const baseUrl = account.baseUrl?.trim();
      if (!token || !baseUrl) {
        return { ok: false, error: "bot token or baseUrl missing" };
      }
      return await probeMattermost(baseUrl, token, timeoutMs);
    },
    buildAccountSnapshot: ({ account, runtime, probe }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.botToken && account.baseUrl),
      botTokenSource: account.botTokenSource,
      baseUrl: account.baseUrl,
      running: runtime?.running ?? false,
      connected: runtime?.connected ?? false,
      lastConnectedAt: runtime?.lastConnectedAt ?? null,
      lastDisconnect: runtime?.lastDisconnect ?? null,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      probe,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
    }),
  },
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg,
        channelKey: "mattermost",
        accountId,
        name,
      }),
    validateInput: ({ accountId, input }) => {
      if (input.useEnv && accountId !== DEFAULT_ACCOUNT_ID) {
        return "Mattermost env vars can only be used for the default account.";
      }
      const token = input.botToken ?? input.token;
      const baseUrl = input.httpUrl;
      if (!input.useEnv && (!token || !baseUrl)) {
        return "Mattermost requires --bot-token and --http-url (or --use-env).";
      }
      if (baseUrl && !normalizeMattermostBaseUrl(baseUrl)) {
        return "Mattermost --http-url must include a valid base URL.";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const token = input.botToken ?? input.token;
      const baseUrl = input.httpUrl?.trim();
      const namedConfig = applyAccountNameToChannelSection({
        cfg,
        channelKey: "mattermost",
        accountId,
        name: input.name,
      });
      const next =
        accountId !== DEFAULT_ACCOUNT_ID
          ? migrateBaseNameToDefaultAccount({
              cfg: namedConfig,
              channelKey: "mattermost",
            })
          : namedConfig;
      if (accountId === DEFAULT_ACCOUNT_ID) {
        return {
          ...next,
          channels: {
            ...next.channels,
            mattermost: {
              ...next.channels?.mattermost,
              enabled: true,
              ...(input.useEnv
                ? {}
                : {
                    ...(token ? { botToken: token } : {}),
                    ...(baseUrl ? { baseUrl } : {}),
                  }),
            },
          },
        };
      }
      return {
        ...next,
        channels: {
          ...next.channels,
          mattermost: {
            ...next.channels?.mattermost,
            enabled: true,
            accounts: {
              ...next.channels?.mattermost?.accounts,
              [accountId]: {
                ...next.channels?.mattermost?.accounts?.[accountId],
                enabled: true,
                ...(token ? { botToken: token } : {}),
                ...(baseUrl ? { baseUrl } : {}),
              },
            },
          },
        },
      };
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      ctx.setStatus({
        accountId: account.accountId,
        baseUrl: account.baseUrl,
        botTokenSource: account.botTokenSource,
      });
      ctx.log?.info(`[${account.accountId}] starting channel`);
      return monitorMattermostProvider({
        botToken: account.botToken ?? undefined,
        baseUrl: account.baseUrl ?? undefined,
        accountId: account.accountId,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        statusSink: (patch) => ctx.setStatus({ accountId: ctx.accountId, ...patch }),
      });
    },
  },
};
