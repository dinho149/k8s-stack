/**
 * Slack adapter (Bolt). Socket Mode by default (outbound only, works anywhere), HTTP receiver optional.
 * Identity: users.info -> profile.email (verified by Slack). Cards: Block Kit with approve/deny buttons;
 * approve/deny open a modal asking for a reason before calling the broker.
 */
import { App, LogLevel, type BlockAction, type ButtonAction, type ViewSubmitAction } from "@slack/bolt";
import type { Config } from "../../config/schema.js";
import { csv } from "../../config/schema.js";
import type { Logger } from "../../observability/logger.js";
import type { ButtonHandler, ButtonId, ChatAdapter, ChatUser, MessageHandler, PostedMessageRef, RequestCard, StreamHandle } from "../types.js";

export class SlackAdapter implements ChatAdapter {
  readonly name = "slack" as const;
  private app: App;
  private onMsg?: MessageHandler;
  private onBtn?: ButtonHandler;
  private botUserId = "";
  private readonly allowedTeams: string[];
  private userCache = new Map<string, { at: number; user: ChatUser }>();

  constructor(private readonly cfg: Config, private readonly log: Logger) {
    this.allowedTeams = csv(cfg.SLACK_ALLOWED_TEAM_IDS);
    this.app = new App({
      token: cfg.SLACK_BOT_TOKEN,
      logLevel: LogLevel.WARN,
      ...(cfg.SLACK_MODE === "socket" ? { socketMode: true, appToken: cfg.SLACK_APP_TOKEN } : { signingSecret: cfg.SLACK_SIGNING_SECRET }),
    });
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
    if (this.cfg.SLACK_MODE === "socket") await this.app.start();
    this.log.info({ botUserId: this.botUserId, mode: this.cfg.SLACK_MODE }, "slack adapter started");
  }
  async stop(): Promise<void> {
    await this.app.stop().catch(() => undefined);
  }

  private wire(): void {
    const handle = async (ev: { user?: string; text?: string; channel: string; ts: string; thread_ts?: string; channel_type?: string; team?: string; bot_id?: string; subtype?: string }, say: (msg: any) => Promise<any>) => {
      if (!ev.user || ev.bot_id || ev.subtype || !this.onMsg) return;
      if (this.allowedTeams.length && ev.team && !this.allowedTeams.includes(ev.team)) return;
      const user = await this.resolveUser(ev.user);
      const text = (ev.text ?? "").replace(new RegExp(`<@${this.botUserId}>`, "g"), "").trim();
      const threadTs = ev.thread_ts ?? ev.ts;
      let streamed: { ts: string; text: string } | null = null;
      const post = (t: string) => say({ text: t, thread_ts: threadTs, mrkdwn: true });
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
      const { requestId, nonce } = JSON.parse(a.value ?? "{}") as { requestId: string; nonce: string };
      const button = a.action_id.split(".")[1] as ButtonId;
      if (button === "details") {
        await this.click(b.user.id, button, requestId, nonce, { channel: b.channel?.id ?? "", ts: b.message?.ts ?? "" }, undefined, (t) => respond({ text: t, response_type: "ephemeral" }).then(() => undefined));
        return;
      }
      await client.views.open({
        trigger_id: b.trigger_id,
        view: {
          type: "modal",
          callback_id: "access.reason",
          private_metadata: JSON.stringify({ requestId, nonce, button, channel: b.channel?.id, ts: b.message?.ts }),
          title: { type: "plain_text", text: button === "approve" ? "Approve request" : "Deny request" },
          submit: { type: "plain_text", text: button === "approve" ? "Approve" : "Deny" },
          blocks: [{ type: "input", block_id: "reason", label: { type: "plain_text", text: "Reason" }, element: { type: "plain_text_input", action_id: "value", multiline: true } }],
        },
      });
    });

    this.app.view("access.reason", async ({ ack, body, view, client }) => {
      await ack();
      const v = body as ViewSubmitAction;
      const meta = JSON.parse(view.private_metadata) as { requestId: string; nonce: string; button: ButtonId; channel?: string; ts?: string };
      const reason = view.state.values.reason?.value?.value ?? "";
      await this.click(v.user.id, meta.button, meta.requestId, meta.nonce, { channel: meta.channel ?? "", ts: meta.ts ?? "" }, reason, async (t) => {
        if (meta.channel) await client.chat.postEphemeral({ channel: meta.channel, user: v.user.id, text: t }).catch(() => undefined);
      });
    });
  }

  private async click(userId: string, button: ButtonId, requestId: string, nonce: string, msg: { channel: string; ts: string }, reason: string | undefined, respond: (t: string) => Promise<void>): Promise<void> {
    if (!this.onBtn) return;
    const user = await this.resolveUser(userId);
    await this.onBtn({ user, button, requestId, nonce, reason, message: { conversation: { platform: "slack", channelId: msg.channel }, messageId: msg.ts }, respond: async (t) => respond(t) });
  }

  async resolveUser(platformUserId: string): Promise<ChatUser> {
    const c = this.userCache.get(platformUserId);
    if (c && Date.now() - c.at < 5 * 60_000) return c.user;
    const r = await this.app.client.users.info({ user: platformUserId });
    const u = r.user;
    const email = u?.profile?.email ?? null;
    const user: ChatUser = { platform: "slack", platformUserId, displayName: u?.real_name ?? u?.name ?? platformUserId, email, emailVerified: !!email && !u?.is_bot && !u?.deleted, tenantId: (u as any)?.team_id };
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
