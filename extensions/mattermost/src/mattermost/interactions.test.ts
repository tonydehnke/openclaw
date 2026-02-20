import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setMattermostRuntime } from "../runtime.js";
import {
  createMattermostInteractionHandler,
  generateInteractionToken,
  resolveInteractionCallbackUrl,
  setInteractionSecret,
  verifyInteractionToken,
  type MattermostInteractionPayload,
} from "./interactions.js";

function createFakeRequest(payload: unknown): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage & {
    method: string;
    socket: { remoteAddress?: string };
    destroy: () => void;
  };
  req.method = "POST";
  req.socket = { remoteAddress: "127.0.0.1" };
  req.destroy = () => {};
  queueMicrotask(() => {
    req.emit("data", Buffer.from(JSON.stringify(payload)));
    req.emit("end");
  });
  return req;
}

function createFakeResponse() {
  let body = "";
  const headers = new Map<string, string>();
  const res = {
    statusCode: 200,
    setHeader: (name: string, value: string) => {
      headers.set(name.toLowerCase(), value);
    },
    end: (chunk?: string) => {
      if (chunk) {
        body += chunk;
      }
    },
  } as unknown as ServerResponse;
  return {
    res,
    getBody: () => body,
    getHeader: (name: string) => headers.get(name.toLowerCase()),
  };
}

describe("mattermost interactions", () => {
  beforeEach(() => {
    setInteractionSecret("test-bot-token");
  });

  it("resolves callback URL from channels.mattermost.interactions.callbackBaseUrl", () => {
    const url = resolveInteractionCallbackUrl("acct-callback-base", {
      channels: {
        mattermost: {
          interactions: {
            callbackBaseUrl: "https://gateway.example.com/openclaw/",
          },
        },
      },
      gateway: { port: 9999 },
    });
    expect(url).toBe(
      "https://gateway.example.com/openclaw/mattermost/interactions/acct-callback-base",
    );
  });

  it("falls back to localhost callback URL when callbackBaseUrl is invalid", () => {
    const url = resolveInteractionCallbackUrl("acct-invalid-base", {
      channels: {
        mattermost: {
          interactions: {
            callbackBaseUrl: "gateway.example.com/no-scheme",
          },
        },
      },
      gateway: { port: 4321 },
    });
    expect(url).toBe("http://localhost:4321/mattermost/interactions/acct-invalid-base");
  });

  it("signs nested context fields and rejects nested tampering", () => {
    const context = {
      action_id: "do_it",
      nested: {
        enabled: true,
        mode: "fast",
      },
    };
    const token = generateInteractionToken(context);

    const reordered = {
      nested: {
        mode: "fast",
        enabled: true,
      },
      action_id: "do_it",
    };
    expect(verifyInteractionToken(reordered, token)).toBe(true);

    const tampered = {
      action_id: "do_it",
      nested: {
        enabled: false,
        mode: "fast",
      },
    };
    expect(verifyInteractionToken(tampered, token)).toBe(false);
  });

  it("uses resolveSessionKey callback when dispatching interaction events", async () => {
    const enqueueSystemEvent = vi.fn();
    setMattermostRuntime({
      system: { enqueueSystemEvent },
    } as any);

    const client = {
      request: vi.fn(async (_path: string, init?: RequestInit) => {
        if (init?.method === "PUT") {
          return { id: "post-1" };
        }
        return {
          id: "post-1",
          message: "Original",
          props: {
            attachments: [{ text: "Pick", actions: [{ id: "approve", name: "Approve" }] }],
          },
        };
      }),
    } as any;

    const payloadBase: MattermostInteractionPayload = {
      user_id: "user-1",
      user_name: "alice",
      channel_id: "channel-1",
      post_id: "post-1",
      context: {
        action_id: "approve",
      },
    };
    const token = generateInteractionToken(payloadBase.context!);
    const payload = {
      ...payloadBase,
      context: {
        ...payloadBase.context,
        _token: token,
      },
    };

    const resolveSessionKey = vi.fn(async () => "session:from-callback");
    const handler = createMattermostInteractionHandler({
      client,
      botUserId: "bot-user",
      accountId: "default",
      callbackUrl: "http://localhost:18789/mattermost/interactions/default",
      resolveSessionKey,
    });
    const req = createFakeRequest(payload);
    const response = createFakeResponse();

    await handler(req, response.res);

    expect(resolveSessionKey).toHaveBeenCalledWith(
      expect.objectContaining({
        channel_id: "channel-1",
        user_id: "user-1",
      }),
    );
    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      expect.stringContaining('action="approve"'),
      expect.objectContaining({
        sessionKey: "session:from-callback",
      }),
    );
    expect(response.res.statusCode).toBe(200);
    expect(response.getHeader("content-type")).toBe("application/json");
    expect(response.getBody().length).toBeGreaterThan(0);
  });

  it("falls back to channel-based session key when resolveSessionKey throws", async () => {
    const enqueueSystemEvent = vi.fn();
    setMattermostRuntime({
      system: { enqueueSystemEvent },
    } as any);

    const client = {
      request: vi.fn(async (_path: string, init?: RequestInit) => {
        if (init?.method === "PUT") {
          return { id: "post-1" };
        }
        return {
          id: "post-1",
          message: "Original",
          props: {
            attachments: [{ text: "Pick", actions: [{ id: "approve", name: "Approve" }] }],
          },
        };
      }),
    } as any;

    const payloadBase: MattermostInteractionPayload = {
      user_id: "user-1",
      user_name: "alice",
      channel_id: "channel-1",
      post_id: "post-1",
      context: {
        action_id: "approve",
      },
    };
    const token = generateInteractionToken(payloadBase.context!);
    const payload = {
      ...payloadBase,
      context: {
        ...payloadBase.context,
        _token: token,
      },
    };

    const resolveSessionKey = vi.fn(async () => {
      throw new Error("channel lookup failed");
    });
    const handler = createMattermostInteractionHandler({
      client,
      botUserId: "bot-user",
      accountId: "default",
      callbackUrl: "http://localhost:18789/mattermost/interactions/default",
      resolveSessionKey,
    });
    const req = createFakeRequest(payload);
    const response = createFakeResponse();

    await handler(req, response.res);

    expect(resolveSessionKey).toHaveBeenCalled();
    expect(enqueueSystemEvent).toHaveBeenCalledWith(
      expect.stringContaining('action="approve"'),
      expect.objectContaining({
        sessionKey: "mattermost:default:channel:channel-1",
      }),
    );
    expect(response.res.statusCode).toBe(200);
  });
});
