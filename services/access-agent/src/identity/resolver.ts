/**
 * Chat identity -> Teleport username. Fails closed: unverified emails or unmapped users get nothing.
 */
import * as fs from "node:fs";
import type { ChatUser } from "../adapters/types.js";
import type { Config } from "../config/schema.js";
import { csv } from "../config/schema.js";
import type { Principal } from "../mcp/client.js";
import type { BrokerClient } from "../broker/client.js";

export class IdentityError extends Error {}

export class IdentityResolver {
  private readonly allowedDomains: string[];
  private readonly map: Record<string, string>;

  constructor(private readonly cfg: Config, private readonly broker?: BrokerClient) {
    this.allowedDomains = csv(cfg.ALLOWED_EMAIL_DOMAINS).map((d) => d.toLowerCase());
    this.map = cfg.IDENTITY_MAP_FILE && fs.existsSync(cfg.IDENTITY_MAP_FILE) ? JSON.parse(fs.readFileSync(cfg.IDENTITY_MAP_FILE, "utf8")) : {};
  }

  async resolve(user: ChatUser): Promise<Principal> {
    if (user.platform === "cli") return { teleportUser: user.platformUserId, email: user.email };
    if (!user.email || !user.emailVerified) throw new IdentityError("your chat account has no verified email address, so I cannot map you to a Teleport user");
    const email = user.email.toLowerCase();
    const domain = email.split("@")[1] ?? "";
    if (this.allowedDomains.length && !this.allowedDomains.includes(domain)) throw new IdentityError(`email domain ${domain} is not allowed to use this assistant`);
    const mapped = this.map[email];
    if (mapped) return { teleportUser: mapped, email };
    switch (this.cfg.IDENTITY_STRATEGY) {
      case "email-as-username":
        return { teleportUser: email, email };
      case "email-local-part":
        return { teleportUser: email.split("@")[0], email };
      case "github-login":
        throw new IdentityError(`no GitHub login mapped for ${email}; ask an administrator to add you to the identity map`);
      case "trait-lookup": {
        if (!this.broker) throw new IdentityError("identity lookup is not configured");
        const u = await this.broker.userByEmail(email);
        if (!u) throw new IdentityError(`no Teleport user carries the email trait ${email}`);
        return { teleportUser: u, email };
      }
    }
  }
}
