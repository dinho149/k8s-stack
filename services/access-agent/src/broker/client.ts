/**
 * BrokerClient — the access broker's HTTP API (docs/teleport/contracts/broker.openapi.yaml).
 *
 * Every call carries the shared bearer token. Approve/deny additionally carry a signed identity
 * assertion (aud "broker") for the approver; the approver is never named in the JSON body, so a
 * caller holding only the bearer token cannot approve as somebody else.
 */
import { ASSERTION_HEADER, assertSigningKey, mintAssertion, type AssertionPrincipal } from "../identity/assertion.js";

export interface BrokerRequest {
  id: string;
  user: string;
  roles: string[];
  resource_ids: string[];
  reason: string;
  state: "PENDING" | "APPROVED" | "DENIED" | "PROMOTED" | string;
  created: string;
  expires: string;
  access_expiry?: string;
  /** Chat platform the request was created from, when the broker records it. */
  platform?: string;
  decision?: { action: string; rule: string; reason: string; ttl_cap: string; approvers: { teleport_roles: string[]; emails: string[] } };
  resolution?: { by: string; mode: string; reason: string; at: string };
}

export class BrokerError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export class BrokerClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly signingKey: string,
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
  ) {
    assertSigningKey(signingKey);
  }

  private async call<T>(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json", ...extraHeaders },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    if (text) {
      try {
        json = JSON.parse(text) as Record<string, unknown>;
      } catch {
        if (res.ok) throw new BrokerError(res.status, "bad_response", "broker returned a non-JSON body");
      }
    }
    if (!res.ok) throw new BrokerError(res.status, String(json.code ?? "error"), String(json.error ?? res.statusText));
    return json as T;
  }

  private decide(action: "approve" | "deny", id: string, approver: AssertionPrincipal, reason: string): Promise<BrokerRequest> {
    const assertion = mintAssertion(this.signingKey, approver, "broker");
    return this.call("POST", `/v1/requests/${encodeURIComponent(id)}/${action}`, { reason }, { [ASSERTION_HEADER]: assertion });
  }

  health(): Promise<{ status: string }> {
    return this.call("GET", "/healthz");
  }
  listRequests(state = "pending"): Promise<{ requests: BrokerRequest[] }> {
    return this.call("GET", `/v1/requests?state=${encodeURIComponent(state)}`);
  }
  getRequest(id: string): Promise<BrokerRequest> {
    return this.call("GET", `/v1/requests/${encodeURIComponent(id)}`);
  }
  /** Approve as `approver`; identity travels only in the signed assertion header. */
  approve(id: string, approver: AssertionPrincipal, reason: string): Promise<BrokerRequest> {
    return this.decide("approve", id, approver, reason);
  }
  deny(id: string, approver: AssertionPrincipal, reason: string): Promise<BrokerRequest> {
    return this.decide("deny", id, approver, reason);
  }
  async userByEmail(email: string): Promise<string | null> {
    const r = await this.call<{ user?: string }>("GET", `/v1/users/by-email?email=${encodeURIComponent(email)}`);
    return r.user ?? null;
  }
  async userRoles(user: string): Promise<string[]> {
    const r = await this.call<{ roles: string[] }>("GET", `/v1/users/${encodeURIComponent(user)}/roles`);
    return r.roles;
  }
}
