/**
 * ApiKeyBackend — one chat message through the Anthropic API (tool runner) with the user's MCP tools.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { BetaToolRunner } from "@anthropic-ai/sdk/lib/tools/BetaToolRunner";
import type { BetaMessageParam, BetaTextBlock } from "@anthropic-ai/sdk/resources/beta";
import type { Config } from "../config/schema.js";
import type { McpSessionPool } from "../mcp/client.js";
import { bridgeTools } from "../mcp/bridge.js";
import type { Logger } from "../observability/logger.js";
import type { SessionStore } from "./session-store.js";
import { STABLE_SYSTEM, perTurnContext, type TurnContext } from "./system-prompt.js";
import type { ClaudeBackend, ProbeResult, TurnInput, TurnResult } from "./backend.js";

export class ApiKeyBackend implements ClaudeBackend {
  readonly name = "api-key" as const;
  stale = false;
  private readonly client: Anthropic;

  constructor(
    private readonly cfg: Config,
    private readonly pool: McpSessionPool,
    private readonly sessions: SessionStore,
    private readonly log: Logger,
    client?: Anthropic,
  ) {
    this.client = client ?? new Anthropic({ apiKey: cfg.ANTHROPIC_API_KEY });
  }

  /** Free authentication check: count_tokens authenticates without generating. */
  async probe(): Promise<ProbeResult> {
    try {
      await this.client.messages.countTokens({ model: this.cfg.CLAUDE_MODEL, messages: [{ role: "user", content: "ping" }] });
      this.stale = false;
      return { ok: true, detail: `api key accepted for ${this.cfg.CLAUDE_MODEL}` };
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
        this.stale = true;
        return { ok: false, detail: `api key rejected: ${e.message}` };
      }
      return { ok: true, detail: `probe inconclusive (${(e as Error).message})` }; // never accuse on network errors
    }
  }

  async run(input: TurnInput): Promise<TurnResult> {
    const mcp = await this.pool.for(input.principal);
    const tools = bridgeTools(await this.pool.tools(input.principal), mcp);
    const history = await this.sessions.get(input.sessionKey);
    const ctx: TurnContext = { teleportUser: input.principal.teleportUser, email: input.principal.email, platform: input.platform, isApprover: input.isApprover, nowIso: new Date().toISOString() };

    const userMsg: BetaMessageParam = { role: "user", content: input.text };
    const messages: BetaMessageParam[] = [...history, userMsg, { role: "system", content: perTurnContext(ctx) } as unknown as BetaMessageParam];

    const runner = this.client.beta.messages.toolRunner({
      model: this.cfg.CLAUDE_MODEL,
      max_tokens: 64000,
      stream: true,
      thinking: { type: "adaptive" },
      output_config: { effort: this.cfg.CLAUDE_EFFORT },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: [{ type: "text", text: STABLE_SYSTEM, cache_control: { type: "ephemeral" } }],
      tools,
      messages,
      max_iterations: 12,
    } as any) as unknown as BetaToolRunner<true>;

    const newTurns: BetaMessageParam[] = [userMsg];
    let final: Awaited<ReturnType<typeof runner.done>> | undefined;
    let text = "";
    for await (const stream of runner) {
      stream.on("text", (delta: string) => input.onDelta?.(delta));
      const msg = await stream.finalMessage();
      final = msg;
      newTurns.push({ role: "assistant", content: msg.content as any });
      if (msg.stop_reason === "refusal" || msg.stop_reason === "max_tokens") break;
    }
    final = (await runner.done().catch(() => final)) ?? final;
    if (final) {
      text = final.content.filter((b): b is BetaTextBlock => b.type === "text").map((b) => b.text).join("\n").trim();
    }
    if (!text) text = final?.stop_reason === "refusal" ? "I can't help with that request." : "(no response)";

    // Persist the exchange (assistant turns + the tool results the runner appended are reflected in the final params).
    const params = (runner as any).params?.messages as BetaMessageParam[] | undefined;
    if (params) {
      const fresh = params.slice(history.length).filter((m) => (m as any).role !== "system");
      await this.sessions.append(input.sessionKey, ...fresh);
    } else {
      await this.sessions.append(input.sessionKey, ...newTurns);
    }
    const usage = final?.usage ? { input: final.usage.input_tokens, output: final.usage.output_tokens, cacheRead: (final.usage as any).cache_read_input_tokens ?? 0 } : undefined;
    this.log.info({ teleportUser: input.principal.teleportUser, stop: final?.stop_reason, usage }, "turn complete");
    this.stale = false;
    return { text, stopReason: final?.stop_reason ?? null, usage };
  }
}
