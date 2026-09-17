/**
 * BrokerClient — the access broker's HTTP API (services/contracts/broker.openapi.yaml).
 */
export interface ApproverIdentity {
  teleport_user: string;
  email: string | null;
  adapter: string;
  platform_user_id: string;
}

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
  decision?: { action: string; rule: string; reason: string; ttl_cap: string; approvers: { teleport_roles: string[]; emails: string[] } };
  resolution?: { by: string; mode: string; reason: string; at: string };
}

export class BrokerError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export class BrokerClient {
  constructor(private readonly baseUrl: string, private readonly token: string, private readonly fetchImpl: typeof fetch = fetch) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) throw new BrokerError(res.status, json.code ?? "error", json.error ?? res.statusText);
    return json as T;
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
  approve(id: string, approver: ApproverIdentity, reason: string): Promise<BrokerRequest> {
    return this.call("POST", `/v1/requests/${encodeURIComponent(id)}/approve`, { approver, reason });
  }
  deny(id: string, approver: ApproverIdentity, reason: string): Promise<BrokerRequest> {
    return this.call("POST", `/v1/requests/${encodeURIComponent(id)}/deny`, { approver, reason });
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
