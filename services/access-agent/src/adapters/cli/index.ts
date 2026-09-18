/**
 * CLI adapter — a terminal REPL that speaks the same ChatAdapter contract as Slack/Teams/Google Chat.
 * Cards render as text; `/approve <id> [reason]` and `/deny <id> [reason]` emulate button clicks.
 */
import * as readline from "node:readline";
import type { ButtonHandler, ChatAdapter, ChatUser, MessageHandler, PostedMessageRef, RequestCard, Replier, StreamHandle } from "../types.js";

export interface CliOptions {
  teleportUser: string;
  email?: string;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  /** non-interactive: run these lines then exit */
  script?: string[];
}

const c = { dim: "\x1b[2m", bold: "\x1b[1m", cyan: "\x1b[36m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", reset: "\x1b[0m" };

export class CliAdapter implements ChatAdapter {
  readonly name = "cli" as const;
  private onMsg?: MessageHandler;
  private onBtn?: ButtonHandler;
  private rl?: readline.Interface;
  private cards = new Map<string, RequestCard>();
  private readonly out: NodeJS.WritableStream;
  readonly user: ChatUser;
  private busy = false;
  readonly done: Promise<void>;
  private resolveDone!: () => void;

  constructor(private readonly opts: CliOptions) {
    this.out = opts.output ?? process.stdout;
    this.user = { platform: "cli", platformUserId: opts.teleportUser, displayName: opts.teleportUser, email: opts.email ?? null, emailVerified: true };
    this.done = new Promise((r) => (this.resolveDone = r));
  }

  onMessage(h: MessageHandler): void {
    this.onMsg = h;
  }
  onButtonClick(h: ButtonHandler): void {
    this.onBtn = h;
  }

  async start(): Promise<void> {
    if (this.opts.script) {
      for (const line of this.opts.script) await this.handleLine(line);
      this.resolveDone();
      return;
    }
    this.rl = readline.createInterface({ input: this.opts.input ?? process.stdin, output: this.out, prompt: `${c.cyan}${this.user.platformUserId}${c.reset}> ` });
    this.rl.prompt();
    this.rl.on("line", async (line) => {
      await this.handleLine(line);
      this.rl?.prompt();
    });
    this.rl.on("close", () => this.resolveDone());
  }

  async stop(): Promise<void> {
    this.rl?.close();
  }

  private async handleLine(raw: string): Promise<void> {
    const line = raw.trim();
    if (!line || this.busy) return;
    if (line === "/help") {
      this.print(`${c.dim}Ask anything about Teleport access. Commands: /requests  /approve <id> [reason]  /deny <id> [reason]  /details <id>  /quit${c.reset}`);
      return;
    }
    if (line === "/quit" || line === "/exit") {
      await this.stop();
      return;
    }
    const [cmd, id, ...rest] = line.split(/\s+/);
    const isButton = (cmd === "/approve" || cmd === "/deny" || cmd === "/details") && !!id;
    if (isButton && this.onBtn) {
      const button = cmd.slice(1);
      const reason = rest.length ? rest.join(" ") : undefined;
      const full = [...this.cards.keys()].find((k) => k.startsWith(id)) ?? id;
      const card = this.cards.get(full);
      await this.onBtn({
        user: this.user,
        button: button as "approve" | "deny" | "details",
        requestId: full,
        nonce: card?.nonce ?? "",
        reason,
        message: { conversation: { platform: "cli", channelId: "terminal" }, messageId: full },
        respond: async (text) => this.print(`${c.yellow}${text}${c.reset}`),
      });
      return;
    }
    if (line === "/requests") {
      // handled by the agent via natural language; keep the shortcut friendly
      return this.dispatch("List the pending access requests I can see.");
    }
    return this.dispatch(line);
  }

  private async dispatch(text: string): Promise<void> {
    if (!this.onMsg) return;
    this.busy = true;
    try {
      await this.onMsg(
        { id: `${Date.now()}`, user: this.user, conversation: { platform: "cli", channelId: "terminal", threadId: "session" }, text, isDirectMessage: true, mentionedBot: true, receivedAt: new Date() },
        this.replier(),
      );
    } catch (e) {
      this.print(`${c.red}error: ${(e as Error).message}${c.reset}`);
    } finally {
      this.busy = false;
    }
  }

  private replier(): Replier {
    return {
      text: async (t) => this.print(`\n${c.green}assistant${c.reset}: ${t}\n`),
      startStream: async (): Promise<StreamHandle> => {
        this.out.write(`\n${c.green}assistant${c.reset}: `);
        return { append: async (d) => void this.out.write(d), finish: async () => void this.out.write("\n\n") };
      },
      card: async (card) => this.postCard({ channel: "terminal" }, card) as Promise<PostedMessageRef>,
    };
  }

  async postCard(_target: { channel: string } | { userEmail: string }, card: RequestCard): Promise<PostedMessageRef> {
    this.cards.set(card.requestId, card);
    this.renderCard(card);
    return { conversation: { platform: "cli", channelId: "terminal" }, messageId: card.requestId };
  }

  async updateCard(_ref: PostedMessageRef, card: RequestCard): Promise<void> {
    this.cards.set(card.requestId, card);
    this.renderCard(card);
  }

  async resolveUser(platformUserId: string): Promise<ChatUser> {
    return { ...this.user, platformUserId };
  }

  private renderCard(card: RequestCard): void {
    const color = card.status === "pending" ? c.yellow : card.status === "approved" ? c.green : c.red;
    const lines = [`${color}${c.bold}▌ ${card.title}${c.reset}`];
    for (const [k, v] of Object.entries(card.fields)) lines.push(`${c.dim}▌ ${k.padEnd(10)}${c.reset} ${v}`);
    if (card.footer) lines.push(`${c.dim}▌ ${card.footer}${c.reset}`);
    if (card.buttons.length) lines.push(`${c.dim}▌ actions: ${card.buttons.map((b) => `/${b.id} ${card.requestId.slice(0, 8)}`).join("   ")}${c.reset}`);
    this.print("\n" + lines.join("\n") + "\n");
  }

  private print(s: string): void {
    this.out.write(s + "\n");
  }
}
