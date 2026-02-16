import { describe, expect, it } from "vitest";
import { parseMattermostTarget } from "./send.js";

describe("parseMattermostTarget", () => {
  it("parses channel: prefix as channel id", () => {
    const target = parseMattermostTarget("channel:abc123");
    expect(target).toEqual({ kind: "channel", id: "abc123" });
  });

  it("parses user: prefix as user id", () => {
    const target = parseMattermostTarget("user:usr456");
    expect(target).toEqual({ kind: "user", id: "usr456" });
  });

  it("parses mattermost: prefix as user id", () => {
    const target = parseMattermostTarget("mattermost:usr789");
    expect(target).toEqual({ kind: "user", id: "usr789" });
  });

  it("parses @ prefix as username", () => {
    const target = parseMattermostTarget("@alice");
    expect(target).toEqual({ kind: "user", username: "alice" });
  });

  it("parses # prefix as channel name", () => {
    const target = parseMattermostTarget("#off-topic");
    expect(target).toEqual({ kind: "channel-name", name: "off-topic" });
  });

  it("parses # prefix with spaces", () => {
    const target = parseMattermostTarget("  #general  ");
    expect(target).toEqual({ kind: "channel-name", name: "general" });
  });

  it("treats bare string as channel id", () => {
    const target = parseMattermostTarget("abc123def");
    expect(target).toEqual({ kind: "channel", id: "abc123def" });
  });

  it("throws on empty string", () => {
    expect(() => parseMattermostTarget("")).toThrow("Recipient is required");
  });

  it("throws on empty # prefix", () => {
    expect(() => parseMattermostTarget("#")).toThrow("Channel name is required");
  });

  it("throws on empty @ prefix", () => {
    expect(() => parseMattermostTarget("@")).toThrow("Username is required");
  });

  it("is case-insensitive for prefixes", () => {
    expect(parseMattermostTarget("CHANNEL:ABC")).toEqual({ kind: "channel", id: "ABC" });
    expect(parseMattermostTarget("User:XYZ")).toEqual({ kind: "user", id: "XYZ" });
    expect(parseMattermostTarget("Mattermost:QRS")).toEqual({ kind: "user", id: "QRS" });
  });
});
