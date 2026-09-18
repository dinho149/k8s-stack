/**
 * Slack adapter (Bolt, Socket Mode only: outbound connection, no public endpoint, no signing secret).
 * Identity: users.info -> profile.email (verified by Slack), restricted to SLACK_ALLOWED_TEAM_IDS and to
 * full members (no guests, no Slack Connect strangers, no bots, no deactivated accounts).
 * Cards: Block Kit with approve/deny buttons; approve/deny open a modal asking for a reason before
 * calling the broker. Button clicks always re-verify the clicker with a fresh users.info call.
 */
import { App, LogLevel, type BlockAction, type ButtonAction, type ViewSubmitAction } from "@slack/bolt";
import type { Config } from "../../config/schema.js";
import { csv } from "../../config/schema.js";
import type { Logger } from "../../observability/logger.js";
import type { ButtonHandler, ButtonId, ChatAdapter, ChatUser, MessageHandler, PostedMessageRef, RequestCard, StreamHandle } from "../types.js";

export class SlackIdentityError extends Error {}

/** The subset of users.info we rely on. */
export interface SlackUserInfo {
  id?: string;
  team_id?: string;
  name?: string;
  real_name?: string;
  deleted?: boolean;
  is_bot?: boolean;
  is_app_user?: boolean;
  is_restricted?: boolean;
  is_ultra_restricted?: boolean;
  is_stranger?: boolean;
  profile?: { email?: string };
}

/** Context passed with button clicks: bypass the user cache so a click is always freshly verified. */
export interface SlackResolveContext {
  fresh?: boolean;
}

interface ButtonValue {
  requestId: string;
  nonce: string;
}
interface ReasonModalMeta extends ButtonValue {
  button: "approve" | "deny";
  channel?: string;
  ts?: string;
}

const USER_CACHE_MS = 5 * 60_000;

/**
 * Maps a users.info result to a ChatUser, or throws SlackIdentityError. Pure, exported for tests.
 * Fails closed: no team id, wrong team, guest, stranger, bot or deleted user all refuse.
 */
export function vetSlackUser(u: SlackUserInfo | undefined, platformUserId: string, allowedTeams: string[]): ChatUser {
  if (!u) throw new SlackIdentityError("Slack does not know this user");
  if (!allowedTeams.length) throw new SlackIdentityError("no Slack workspace is allowed (SLACK_ALLOWED_TEAM_IDS)");
  if (!u.team_id || !allowedTeams.includes(u.team_id)) throw new SlackIdentityError("your Slack workspace is not allowed to use this assistant");
  if (u.deleted) throw new SlackIdentityError("this Slack account is deactivated");
  if (u.is_bot || u.is_app_user || u.id === "USLACKBOT") throw new SlackIdentityError("bots cannot use this assistant");
  if (u.is_stranger) throw new SlackIdentityError("Slack Connect users cannot use this assistant");
  if (u.is_restricted || u.is_ultra_restricted) throw new SlackIdentityError("guest accounts cannot use this assistant");
  const email = u.profile?.email ?? null;
  return { platform: "slack", platformUserId, displayName: u.real_name ?? u.name ?? platformUserId, email, emailVerified: !!email, tenantId: u.team_id };
}

export function parseJsonObject<T extends object>(raw: string | undefined, shape: (v: Record<string, unknown>) => v is Record<string, unknown> & T): T | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    return shape(v as Record<string, unknown>) ? (v as T) : null;
  } catch {
    return null;
  }
}

const isButtonValue = (v: Record<string, unknown>): v is Record<string, unknown> & ButtonValue => typeof v.requestId === "string" && typeof v.nonce === "string";
const isReasonMeta = (v: Record<string, unknown>): v is Record<string, unknown> & ReasonModalMeta =>
  isButtonValue(v) && (v.button === "approve" || v.button === "deny") && (v.channel === undefined || typeof v.channel === "string") && (v.ts === undefined || typeof v.ts === "string");

export class SlackAdapter implements ChatAdapter {
  readonly name = "slack" as const;
  private app: App;
  private onMsg?: MessageHandler;
  private onBtn?: ButtonHandler;
  private botUserId = "";
  private readonly allowedTeams: string[];
  private userCache = new Map<string, { at: number; user: ChatUser }>();

  constructor(cfg: Config, private readonly log: Logger) {
    this.allowedTeams = csv(cfg.SLACK_ALLOWED_TEAM_IDS);
    this.app = new App({ token: cfg.SLACK_BOT_TOKEN, logLevel: LogLevel.WARN, socketMode: true, appToken: cfg.SLACK_APP_TOKEN });
    this.wire();
  }

  onMessage(h: MessageHandler): void {
    this.onMsg = h;
  }
  onButtonClick(h: ButtonHandler): void {
    this.onBtn = h;
  }

  async start(): Promise<void> {
    const auth = await this.app.client.auth.test();
    this.botUserId = (auth.user_id as string) ?? "";
    await this.app.start();
    this.log.info({ botUserId: this.botUserId, mode: "socket", allowedTeams: this.allowedTeams }, "slack adapter started");
  }
  async stop(): Promise<void> {
    await this.app.stop().catch(() => undefined);
  }

  private wire(): void {
    const handle = async (ev: { user?: string; text?: string; channel: string; ts: string; thread_ts?: string; channel_type?: string; team?: string; bot_id?: string; subtype?: string }, say: (msg: any) => Promise<any>) => {
      if (!ev.user || ev.bot_id || ev.subtype || !this.onMsg) return;
      const threadTs = ev.thread_ts ?? ev.ts;
      const post = (t: string) => say({ text: t, thread_ts: threadTs, mrkdwn: true });
      if (ev.team && !this.allowedTeams.includes(ev.team)) {
        this.log.warn({ team: ev.team, user: ev.user }, "slack message from a workspace that is not allowed");
        return;
      }
      let user: ChatUser;
      try {
        user = await this.resolveUser(ev.user);
      } catch (e) {
        if (e instanceof SlackIdentityError) {
          this.log.warn({ user: ev.user, reason: e.message }, "slack user refused");
          await post(`I can't act for you: ${e.message}.`).catch(() => undefined);
          return;
        }
        throw e;
      }
      const text = (ev.text ?? "").replaceAll(`<@${this.botUserId}>`, "").trim();
      let streamed: { ts: string; text: string } | null = null;
      await this.onMsg(
        { id: ev.ts, user, conversation: { platform: "slack", channelId: ev.channel, threadId: threadTs }, text, isDirectMessage: ev.channel_type === "im", mentionedBot: (ev.text ?? "").includes(`<@${this.botUserId}>`), receivedAt: new Date() },
        {
          text: async (t) => void (await post(toMrkdwn(t))),
          startStream: async (): Promise<StreamHandle> => {
            let buffer = "";
            let lastEdit = 0;
            const flush = async (final = false) => {
              if (!buffer.trim()) return;
              if (!streamed) {
                const r = await post(toMrkdwn(buffer) + (final ? "" : " …"));
                streamed = { ts: r.ts as string, text: buffer };
              } else {
                await this.app.client.chat.update({ channel: ev.channel, ts: streamed.ts, text: toMrkdwn(buffer) + (final ? "" : " …") });
              }
            };
            return {
              append: async (d) => {
                buffer += d;
                if (Date.now() - lastEdit > 1200) {
                  lastEdit = Date.now();
                  await flush().catch(() => undefined);
                }
              },
              finish: async (finalText) => {
                buffer = finalText;
                await flush(true);
              },
            };
          },
          card: async (card) => (await this.postCard({ channel: ev.channel }, card)) as PostedMessageRef,
        },
      );
    };
    this.app.event("app_mention", async ({ event, say }) => handle(event as any, say));
    this.app.message(async ({ message, say }) => {
      const m = message as any;
      if (m.channel_type === "im") await handle(m, say);
    });

    this.app.action(/^access\.(approve|deny|details)$/, async ({ ack, body, action, client, respond }) => {
      await ack();
      const b = body as BlockAction<ButtonAction>;
      const a = action as ButtonAction;
      const ephemeral = (t: string) => respond({ text: t, response_type: "ephemeral" }).then(() => undefined);
      const value = parseJsonObject<ButtonValue>(a.value, isButtonValue);
      if (!value) {
        this.log.warn({ user: b.user?.id, action: a.action_id }, "ignoring slack button with malformed value");
        await ephemeral("This button is malformed; ask the assistant for the current state.").catch(() => undefined);
        return;
      }
      const { requestId, nonce } = value;
      const button = a.action_id.split(".")[1] as ButtonId;
      if (button === "details") {
        await this.click(b.user.id, button, requestId, nonce, { channel: b.channel?.id ?? "", ts: b.message?.ts ?? "" }, undefined, ephemeral);
        return;
      }
      await client.views.open({
        trigger_id: b.trigger_id,
        view: {
          type: "modal",
          callback_id: "access.reason",
          private_metadata: JSON.stringify({ requestId, nonce, button, channel: b.channel?.id, ts: b.message?.ts } satisfies ReasonModalMeta),
          title: { type: "plain_text", text: button === "approve" ? "Approve request" : "Deny request" },
          submit: { type: "plain_text", text: button === "approve" ? "Approve" : "Deny" },
          blocks: [{ type: "input", block_id: "reason", label: { type: "plain_text", text: "Reason" }, element: { type: "plain_text_input", action_id: "value", multiline: true } }],
        },
      });
    });

    this.app.view("access.reason", async ({ ack, body, view, client }) => {
      await ack();
      const v = body as ViewSubmitAction;
      const meta = parseJsonObject<ReasonModalMeta>(view.private_metadata, isReasonMeta);
      if (!meta) {
        this.log.warn({ user: v.user?.id }, "ignoring slack modal submission with malformed private_metadata");
        return;
      }
      const reason = view.state.values.reason?.value?.value ?? "";
      await this.click(v.user.id, meta.button, meta.requestId, meta.nonce, { channel: meta.channel ?? "", ts: meta.ts ?? "" }, reason, async (t) => {
        if (meta.channel) await client.chat.postEphemeral({ channel: meta.channel, user: v.user.id, text: t }).catch(() => undefined);
      });
    });
  }

  private async click(userId: string, button: ButtonId, requestId: string, nonce: string, msg: { channel: string; ts: string }, reason: string | undefined, respond: (t: string) => Promise<void>): Promise<void> {
    if (!this.onBtn) return;
    const ctx: SlackResolveContext = { fresh: true };
    let user: ChatUser;
    try {
      user = await this.resolveUser(userId, ctx);
    } catch (e) {
      if (e instanceof SlackIdentityError) {
        this.log.warn({ user: userId, reason: e.message, button }, "slack click refused");
        await respond(`I can't act for you: ${e.message}.`).catch(() => undefined);
        return;
      }
      throw e;
    }
    await this.onBtn({ user, button, requestId, nonce, reason, ctx, message: { conversation: { platform: "slack", channelId: msg.channel }, messageId: msg.ts }, respond: async (t) => respond(t) });
  }

  /** Fresh users.info (cached 5 min for messages; never cached when ctx.fresh, i.e. button clicks). */
  async resolveUser(platformUserId: string, ctx?: unknown): Promise<ChatUser> {
    const fresh = !!(ctx as SlackResolveContext | undefined)?.fresh;
    const c = this.userCache.get(platformUserId);
    if (!fresh && c && Date.now() - c.at < USER_CACHE_MS) return c.user;
    const r = await this.app.client.users.info({ user: platformUserId });
    const user = vetSlackUser(r.user as SlackUserInfo | undefined, platformUserId, this.allowedTeams);
    this.userCache.set(platformUserId, { at: Date.now(), user });
    return user;
  }

  async postCard(target: { channel: string } | { userEmail: string }, card: RequestCard): Promise<PostedMessageRef | null> {
    let channel: string;
    if ("channel" in target) channel = target.channel.startsWith("#") ? await this.channelId(target.channel.slice(1)) : target.channel;
    else {
      const u = await this.app.client.users.lookupByEmail({ email: target.userEmail }).catch(() => null);
      if (!u?.user?.id) return null;
      channel = u.user.id; // DM
    }
    const r = await this.app.client.chat.postMessage({ channel, text: card.title, blocks: renderBlocks(card) });
    return { conversation: { platform: "slack", channelId: r.channel as string }, messageId: r.ts as string };
  }

  async updateCard(ref: PostedMessageRef, card: RequestCard): Promise<void> {
    await this.app.client.chat.update({ channel: ref.conversation.channelId, ts: ref.messageId, text: card.title, blocks: renderBlocks(card) });
  }

  private channelIds = new Map<string, string>();
  private async channelId(name: string): Promise<string> {
    const cached = this.channelIds.get(name);
    if (cached) return cached;
    let cursor: string | undefined;
    do {
      const r = await this.app.client.conversations.list({ types: "public_channel,private_channel", limit: 200, cursor });
      for (const ch of r.channels ?? []) if (ch.name === name && ch.id) this.channelIds.set(name, ch.id);
      cursor = r.response_metadata?.next_cursor || undefined;
    } while (cursor && !this.channelIds.has(name));
    const id = this.channelIds.get(name);
    if (!id) throw new Error(`slack channel #${name} not found (is the bot invited?)`);
    return id;
  }
}

export function renderBlocks(card: RequestCard): any[] {
  const status = card.status === "pending" ? ":hourglass_flowing_sand:" : card.status === "approved" ? ":white_check_mark:" : card.status === "denied" ? ":no_entry:" : ":alarm_clock:";
  const blocks: any[] = [
    { type: "header", text: { type: "plain_text", text: `${status} ${card.title}`.slice(0, 150) } },
    { type: "section", fields: Object.entries(card.fields).slice(0, 10).map(([k, v]) => ({ type: "mrkdwn", text: `*${k}*\n${v}` })) },
  ];
  if (card.buttons.length) {
    blocks.push({
      type: "actions",
      elements: card.buttons.map((b) => ({ type: "button", text: { type: "plain_text", text: b.label }, action_id: `access.${b.id}`, value: JSON.stringify({ requestId: card.requestId, nonce: card.nonce }), ...(b.style ? { style: b.style } : {}) })),
    });
  }
  if (card.footer) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: card.footer }] });
  return blocks;
}

/** Minimal Markdown -> Slack mrkdwn. */
export function toMrkdwn(md: string): string {
  return md
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/^#{1,6}\s+(.*)$/gm, "*$1*")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, "<$2|$1>")
    .replace(/^(\s*)[-*]\s+/gm, "$1• ");
}
