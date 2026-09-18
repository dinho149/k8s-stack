import type { Config } from "../config/schema.js";
import { csv } from "../config/schema.js";
import type { Principal } from "../mcp/client.js";
import type { BrokerClient } from "../broker/client.js";

/** UI hint only — the broker is the authority on who may approve. */
export class ApproverCheck {
  private readonly emails: Set<string>;
  private readonly roles: string[];
  private cache = new Map<string, { at: number; ok: boolean }>();

  constructor(cfg: Config, private readonly broker?: BrokerClient) {
    this.emails = new Set(csv(cfg.APPROVER_EMAILS).map((e) => e.toLowerCase()));
    this.roles = csv(cfg.APPROVER_TELEPORT_ROLES);
  }

  async isApprover(p: Principal): Promise<boolean> {
    if (p.email && this.emails.has(p.email.toLowerCase())) return true;
    const c = this.cache.get(p.teleportUser);
    if (c && Date.now() - c.at < 60_000) return c.ok;
    let ok = false;
    if (this.broker) {
      const roles = await this.broker.userRoles(p.teleportUser).catch(() => [] as string[]);
      ok = roles.some((r) => this.roles.includes(r));
    }
    this.cache.set(p.teleportUser, { at: Date.now(), ok });
    return ok;
  }
}
