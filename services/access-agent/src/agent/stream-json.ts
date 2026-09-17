/**
 * Parser for `claude -p --output-format stream-json --verbose --include-partial-messages` output.
 * Pure and line-oriented so it can be unit-tested with fixtures. Shapes observed on Claude Code 2.1.274:
 *   {"type":"system","subtype":"init",...,"mcp_servers":[{name,status}],"tools":[...]}
 *   {"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"..."}}}
 *   {"type":"assistant","message":{"content":[{"type":"text","text":"..."} | {"type":"tool_use",...}]}}
 *   {"type":"user","message":{"content":[{"type":"tool_result",...}]}}
 *   {"type":"result","subtype":"success","is_error":false,"result":"...","session_id":"...","total_cost_usd":0.02,
 *    "num_turns":2,"stop_reason":"end_turn","terminal_reason":"completed"}
 */
export interface StreamSummary {
  text: string;
  sessionId?: string;
  isError: boolean;
  subtype?: string;
  stopReason?: string;
  terminalReason?: string;
  numTurns?: number;
  costUsd?: number;
  toolCalls: string[];
  mcpServers: Array<{ name: string; status: string }>;
  /** true when a result line was seen */
  complete: boolean;
}

export class StreamJsonParser {
  private buffer = "";
  private assistantText: string[] = [];
  readonly summary: StreamSummary = { text: "", isError: false, toolCalls: [], mcpServers: [], complete: false };

  constructor(private readonly onDelta?: (delta: string) => void) {}

  /** Feed raw stdout bytes; complete lines are parsed immediately. */
  feed(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line) this.line(line);
    }
  }

  /** Flush a trailing partial line at EOF. */
  end(): StreamSummary {
    const rest = this.buffer.trim();
    this.buffer = "";
    if (rest) this.line(rest);
    if (!this.summary.complete && !this.summary.text) this.summary.text = this.assistantText.join("\n").trim();
    return this.summary;
  }

  private line(line: string): void {
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      return; // not JSON (banner, warning) — ignore
    }
    switch (d.type) {
      case "system":
        if (d.subtype === "init" && Array.isArray(d.mcp_servers)) this.summary.mcpServers = d.mcp_servers.map((m: any) => ({ name: String(m.name), status: String(m.status) }));
        break;
      case "stream_event": {
        const ev = d.event;
        if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && typeof ev.delta.text === "string") this.onDelta?.(ev.delta.text);
        break;
      }
      case "assistant": {
        const content = d.message?.content;
        if (Array.isArray(content)) {
          for (const b of content) {
            if (b?.type === "text" && typeof b.text === "string") this.assistantText.push(b.text);
            if (b?.type === "tool_use" && typeof b.name === "string") this.summary.toolCalls.push(b.name);
          }
        }
        if (d.is_api_error_message) this.summary.isError = true;
        break;
      }
      case "result":
        this.summary.complete = true;
        this.summary.isError = Boolean(d.is_error);
        this.summary.subtype = d.subtype;
        this.summary.sessionId = d.session_id;
        this.summary.stopReason = d.stop_reason;
        this.summary.terminalReason = d.terminal_reason;
        this.summary.numTurns = d.num_turns;
        this.summary.costUsd = typeof d.total_cost_usd === "number" ? d.total_cost_usd : undefined;
        this.summary.text = typeof d.result === "string" && d.result ? d.result : this.assistantText.join("\n").trim();
        break;
      default:
        break;
    }
  }
}

/** Does a result/stderr text look like an authentication problem (as opposed to a transient error)? */
export function looksLikeAuthFailure(text: string): boolean {
  return /not logged in|please run \/login|authentication|invalid.*(token|api key)|unauthorized|401|oauth token.*(expired|revoked)/i.test(text);
}
