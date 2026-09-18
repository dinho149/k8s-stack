import { describe, expect, it } from "vitest";
import { SlackIdentityError, parseJsonObject, vetSlackUser, type SlackUserInfo } from "../src/adapters/slack/index.js";

const member: SlackUserInfo = { id: "U1", team_id: "T1", name: "alice", real_name: "Alice", profile: { email: "alice@example.com" } };

describe("slack user vetting", () => {
  it("accepts a full member of an allowed workspace", () => {
    expect(vetSlackUser(member, "U1", ["T1"])).toEqual({ platform: "slack", platformUserId: "U1", displayName: "Alice", email: "alice@example.com", emailVerified: true, tenantId: "T1" });
    expect(vetSlackUser({ ...member, profile: {} }, "U1", ["T1"]).emailVerified).toBe(false);
  });
  it("rejects foreign workspaces, missing team ids and an empty allow-list", () => {
    expect(() => vetSlackUser({ ...member, team_id: "T2" }, "U1", ["T1"])).toThrow(/workspace is not allowed/);
    expect(() => vetSlackUser({ ...member, team_id: undefined }, "U1", ["T1"])).toThrow(/workspace is not allowed/);
    expect(() => vetSlackUser(member, "U1", [])).toThrow(/SLACK_ALLOWED_TEAM_IDS/);
    expect(() => vetSlackUser(undefined, "U1", ["T1"])).toThrow(SlackIdentityError);
  });
  it("rejects guests, Slack Connect strangers, bots and deactivated accounts", () => {
    expect(() => vetSlackUser({ ...member, is_restricted: true }, "U1", ["T1"])).toThrow(/guest/);
    expect(() => vetSlackUser({ ...member, is_ultra_restricted: true }, "U1", ["T1"])).toThrow(/guest/);
    expect(() => vetSlackUser({ ...member, is_stranger: true }, "U1", ["T1"])).toThrow(/Slack Connect/);
    expect(() => vetSlackUser({ ...member, is_bot: true }, "U1", ["T1"])).toThrow(/bots/);
    expect(() => vetSlackUser({ ...member, id: "USLACKBOT" }, "USLACKBOT", ["T1"])).toThrow(/bots/);
    expect(() => vetSlackUser({ ...member, deleted: true }, "U1", ["T1"])).toThrow(/deactivated/);
  });
});

describe("slack payload parsing", () => {
  const isButton = (v: Record<string, unknown>): v is Record<string, unknown> & { requestId: string; nonce: string } => typeof v.requestId === "string" && typeof v.nonce === "string";
  it("returns null for malformed JSON or wrong shapes instead of throwing", () => {
    expect(parseJsonObject("{not json", isButton)).toBeNull();
    expect(parseJsonObject(undefined, isButton)).toBeNull();
    expect(parseJsonObject("[1,2]", isButton)).toBeNull();
    expect(parseJsonObject('"str"', isButton)).toBeNull();
    expect(parseJsonObject('{"requestId":1,"nonce":"n"}', isButton)).toBeNull();
    expect(parseJsonObject('{"requestId":"r","nonce":"n"}', isButton)).toEqual({ requestId: "r", nonce: "n" });
  });
});
