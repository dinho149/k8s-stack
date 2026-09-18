/**
 * Signed identity assertions: how THIS process tells the MCP server and the access broker who it is
 * acting for. The chat platform's verified identity is resolved here, then bound to every request
 * with a short-lived HMAC so a shared bearer token alone can never impersonate a user.
 *
 * Wire format (shared with services/teleport-access/internal/assertion):
 *   X-Teleport-Assertion: <b64url(payloadJSON)>.<b64url(HMAC-SHA256(key, b64url(payloadJSON)))>
 * base64url without padding; the HMAC input is the base64url payload string, not the raw JSON.
 */
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Platform } from "../adapters/types.js";

export const ASSERTION_HEADER = "X-Teleport-Assertion";
/** Assertions live 45 s (the verifier caps exp - iat at 60 s). */
export const ASSERTION_TTL_SECONDS = 45;
export const ASSERTION_MAX_TTL_SECONDS = 60;
/** Minimum signing-key length in bytes (raw UTF-8). */
export const MIN_SIGNING_KEY_BYTES = 32;

export type AssertionAudience = "mcp" | "broker";

export interface AssertionPrincipal {
  teleportUser: string;
  email: string | null;
  platform: Platform;
  platformUserId: string;
}

export interface AssertionPayload {
  sub: string;
  email: string;
  platform: Platform;
  platform_user_id: string;
  aud: AssertionAudience;
  iat: number;
  exp: number;
  jti: string;
}

export interface MintOptions {
  /** Unix milliseconds; defaults to Date.now(). */
  nowMs?: number;
  /** Fixed jti (tests only); defaults to crypto.randomUUID(). */
  jti?: string;
}

export function b64url(data: Buffer | string): string {
  return Buffer.from(data).toString("base64url");
}

export function assertSigningKey(key: string): void {
  if (Buffer.byteLength(key, "utf8") < MIN_SIGNING_KEY_BYTES) throw new Error(`IDENTITY_SIGNING_KEY must be at least ${MIN_SIGNING_KEY_BYTES} bytes`);
}

/** Maximum header length the verifier accepts. */
export const MAX_ASSERTION_BYTES = 8 * 1024;
const MAX_SUB_LENGTH = 255;
const SUB_FORBIDDEN = /[\s\p{Cc}]/u;

/** `sub` rules shared with the Go verifier: non-empty, ≤ 255 chars, no whitespace or control characters. */
export function validSubject(sub: unknown): sub is string {
  return typeof sub === "string" && sub.length > 0 && sub.length <= MAX_SUB_LENGTH && !SUB_FORBIDDEN.test(sub);
}

export function buildPayload(principal: AssertionPrincipal, aud: AssertionAudience, opts: MintOptions = {}): AssertionPayload {
  if (!validSubject(principal.teleportUser)) throw new Error("cannot mint an assertion: Teleport username must be 1-255 characters without whitespace or control characters");
  const iat = Math.floor((opts.nowMs ?? Date.now()) / 1000);
  return {
    sub: principal.teleportUser,
    email: principal.email ?? "",
    platform: principal.platform,
    platform_user_id: principal.platformUserId,
    aud,
    iat,
    exp: iat + ASSERTION_TTL_SECONDS,
    jti: opts.jti ?? randomUUID(),
  };
}

function sign(key: string, encodedPayload: string): string {
  return createHmac("sha256", Buffer.from(key, "utf8")).update(encodedPayload, "utf8").digest("base64url");
}

/** A fresh, signed assertion for `principal` addressed to `aud`. Call once per HTTP request. */
export function mintAssertion(key: string, principal: AssertionPrincipal, aud: AssertionAudience, opts: MintOptions = {}): string {
  assertSigningKey(key);
  const encoded = b64url(JSON.stringify(buildPayload(principal, aud, opts)));
  return `${encoded}.${sign(key, encoded)}`;
}

export class AssertionError extends Error {}

/**
 * Verifies an assertion the way the Go side does (used by tests and the loopback MCP proxy's self-checks).
 * Throws AssertionError on any problem; never returns a partially trusted payload.
 */
export function verifyAssertion(key: string, header: string, aud: AssertionAudience, nowMs = Date.now()): AssertionPayload {
  if (Buffer.byteLength(header, "utf8") > MAX_ASSERTION_BYTES) throw new AssertionError("assertion too large");
  const parts = header.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new AssertionError("malformed assertion");
  if (/[+/=]/.test(header)) throw new AssertionError("assertion is not base64url without padding");
  const [encoded, sig] = parts;
  const expected = Buffer.from(sign(key, encoded));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw new AssertionError("bad assertion signature");
  let payload: AssertionPayload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as AssertionPayload;
  } catch {
    throw new AssertionError("malformed assertion payload");
  }
  if (!validSubject(payload.sub)) throw new AssertionError("assertion sub is missing or malformed");
  if (payload.aud !== aud) throw new AssertionError(`assertion audience ${String(payload.aud)} is not ${aud}`);
  const now = Math.floor(nowMs / 1000);
  if (!Number.isInteger(payload.iat) || !Number.isInteger(payload.exp)) throw new AssertionError("assertion has no iat/exp");
  if (payload.exp <= payload.iat) throw new AssertionError("assertion exp must be after iat");
  if (payload.exp - payload.iat > ASSERTION_MAX_TTL_SECONDS) throw new AssertionError("assertion lifetime too long");
  if (payload.exp <= now) throw new AssertionError("assertion expired");
  if (payload.iat > now + 30) throw new AssertionError("assertion issued in the future");
  if (typeof payload.jti !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(payload.jti)) throw new AssertionError("assertion jti is not a UUID");
  return payload;
}
