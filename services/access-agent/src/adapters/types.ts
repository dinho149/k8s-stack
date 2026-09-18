/**
 * The chat-platform abstraction. Everything platform specific lives behind ChatAdapter; the agent
 * and the notification service only see these types.
 */
export type Platform = "slack" | "teams" | "gchat" | "cli";

export interface ChatUser {
  platform: Platform;
  platformUserId: string;
  displayName: string;
  /** Verified by the platform (Slack profile email, AAD UPN, Google Workspace email). */
  email: string | null;
  emailVerified: boolean;
  tenantId?: string;
}

export interface ConversationRef {
  platform: Platform;
  channelId: string;
  threadId?: string;
  /** Opaque platform data needed to reply later (e.g. Teams ConversationReference). */
  raw?: unknown;
}

export interface IncomingMessage {
  id: string;
  user: ChatUser;
  conversation: ConversationRef;
  text: string;
  isDirectMessage: boolean;
  mentionedBot: boolean;
  receivedAt: Date;
}

export type ButtonId = "approve" | "deny" | "details";

export interface CardButton {
  id: ButtonId;
  label: string;
  style?: "primary" | "danger";
}

export type RequestStatus = "pending" | "approved" | "denied" | "expired";

export interface RequestCard {
  requestId: string;
  title: string;
  fields: Record<string, string>;
  buttons: CardButton[];
  status: RequestStatus;
  footer?: string;
  /** One-time token bound to requestId; replayed clicks are rejected. */
  nonce: string;
}

export interface PostedMessageRef {
  conversation: ConversationRef;
  messageId: string;
}

export interface ButtonClick {
  user: ChatUser;
  button: ButtonId;
  requestId: string;
  nonce: string;
  message: PostedMessageRef;
  /** Free text the approver typed (reason); adapters that support modals fill this in. */
  reason?: string;
  /**
   * Platform context of the verified event that carried the click (Teams TurnContext, the
   * Google Chat event's verified sender, Slack's cache-bypass flag). Passed back to
   * `resolveUser` so the clicker is re-verified against the platform, never the payload.
   */
  ctx?: unknown;
  respond(text: string, ephemeral?: boolean): Promise<void>;
}

export interface StreamHandle {
  append(delta: string): Promise<void>;
  finish(finalText: string): Promise<void>;
}

export interface Replier {
  text(t: string): Promise<void>;
  startStream(): Promise<StreamHandle>;
  card(c: RequestCard): Promise<PostedMessageRef>;
}

export type MessageHandler = (m: IncomingMessage, reply: Replier) => Promise<void>;
export type ButtonHandler = (c: ButtonClick) => Promise<void>;

export interface HttpRoute {
  method: "GET" | "POST";
  path: string;
  handler: (req: { headers: Record<string, string | string[] | undefined>; body: unknown; rawBody: string; query: Record<string, unknown> }) => Promise<{ status: number; body?: unknown; headers?: Record<string, string> }>;
}

export interface ChatAdapter {
  readonly name: Platform;
  start(): Promise<void>;
  stop(): Promise<void>;
  onMessage(handler: MessageHandler): void;
  onButtonClick(handler: ButtonHandler): void;
  /** Post a request card to a channel (by adapter target string) or to a user (by email). */
  postCard(target: { channel: string } | { userEmail: string }, card: RequestCard): Promise<PostedMessageRef | null>;
  updateCard(ref: PostedMessageRef, card: RequestCard): Promise<void>;
  /** Fresh, platform-verified lookup; never trust identities carried in payloads. */
  resolveUser(platformUserId: string, ctx?: unknown): Promise<ChatUser>;
  httpRoutes?(): HttpRoute[];
}

/** Convert plain markdown-ish text into the adapter's flavour. Adapters override as needed. */
export function toPlainText(md: string): string {
  return md.replace(/\*\*(.*?)\*\*/g, "$1").replace(/`([^`]*)`/g, "$1");
}
