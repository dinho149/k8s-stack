import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import {
  query,
  createSdkMcpServer,
  tool,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { AgentEvent, ModelRole, Settings } from '../shared';
import { safePath, readSource } from './repository';

export type ToolCall = (name: string, args: Record<string, unknown>) => Promise<unknown>;
export type HarnessInput = {
  role: ModelRole;
  prompt: string;
  cwd: string;
  readOnly: boolean;
  signal: AbortSignal;
  settings: Settings;
  secrets: Record<string, string>;
  sessionId?: string;
  maxBudgetUsd?: number;
  approve: (title: string, detail: string) => Promise<boolean>;
  steer: (fn: (text: string) => void) => void;
  callTool?: ToolCall;
  mcp?: { command: string; args: string[]; env: Record<string, string> };
  bulkThreshold: number;
};
export type HarnessResult = { text: string; sessionId?: string };
export interface HarnessAdapter {
  run(input: HarnessInput, emit: (event: AgentEvent) => void): Promise<HarnessResult>;
}

export const toolDefinitions = [
  {
    name: 'search_source',
    description: 'Search repository text and return bounded source references.',
    schema: z.object({ query: z.string() }),
  },
  {
    name: 'read_source',
    description: 'Read a targeted section of a source file.',
    schema: z.object({
      path: z.string(),
      offset: z.number().int().min(1).default(1),
      limit: z.number().int().min(1).max(300).default(100),
    }),
  },
  {
    name: 'bulk_read',
    description:
      'Ask a cheaper read-only worker a specific question about large files. Prefer targeted reads for small sections and difficult debugging.',
    schema: z.object({ paths: z.array(z.string()).min(1).max(8), question: z.string() }),
  },
  {
    name: 'pattern_write',
    description:
      'Draft bounded boilerplate from a reference file using the approved worker. Writes only named targets after checking source hashes. All changes still require tests and review.',
    schema: z.object({
      reference: z.string(),
      targets: z.array(z.string()).min(1).max(4),
      spec: z.string(),
    }),
  },
  {
    name: 'read_artifact',
    description: 'Read a bounded section of a saved task artifact or log.',
    schema: z.object({ id: z.string(), offset: z.number().int().min(0).default(0) }),
  },
];

export class CodexConnection {
  proc: ChildProcessWithoutNullStreams;
  pending = new Map<
    number,
    {
      resolve: (result: any) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  serial = 0;
  onMessage: (message: any) => void = () => {};
  onExit: (error: Error) => void = () => {};
  constructor(path: string, cwd: string) {
    this.proc = spawn(path, ['app-server'], {
      cwd,
      env: { ...process.env },
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    createInterface({ input: this.proc.stdout }).on('line', (line) => {
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.id !== undefined && !message.method) {
        const p = this.pending.get(message.id);
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(message.id);
          message.error ? p.reject(new Error(message.error.message)) : p.resolve(message.result);
        }
      } else this.onMessage(message);
    });
    let err = '';
    this.proc.stderr.on('data', (data) => {
      err = (err + data).slice(-4000);
    });
    const fail = (error: Error) => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(error);
      }
      this.pending.clear();
      this.onExit(error);
    };
    this.proc.on('error', fail);
    this.proc.on('exit', (code) => fail(new Error(`Codex exited (${code}). ${err}`)));
  }
  send(message: unknown) {
    if (this.proc.stdin.writable) this.proc.stdin.write(JSON.stringify(message) + '\n');
  }
  request(method: string, params: unknown): Promise<any> {
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} timed out`));
      }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }
  async initialize() {
    await this.request('initialize', {
      clientInfo: { name: 'dogfood', title: 'Dogfood', version: '0.1.0' },
    });
    this.send({ method: 'initialized', params: {} });
  }
  close() {
    this.proc.stdin.end();
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (process.platform === 'win32') this.proc.kill(signal);
        else if (this.proc.pid) process.kill(-this.proc.pid, signal);
      } catch {}
    };
    kill('SIGTERM');
    const timer = setTimeout(() => kill('SIGKILL'), 1500);
    timer.unref();
  }
}
export class CodexAdapter implements HarnessAdapter {
  async run(input: HarnessInput, emit: (event: AgentEvent) => void): Promise<HarnessResult> {
    const connection = new CodexConnection(input.settings.codexPath, input.cwd);
    let threadId = '',
      turnId = '',
      finalText = '',
      actualModel = input.role.model;
    let finish: (value: HarnessResult) => void = () => {},
      fail: (error: Error) => void = () => {};
    const done = new Promise<HarnessResult>((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
    // Attach a rejection observer before the asynchronous handshake.
    void done.catch(() => {});
    connection.onExit = fail;
    connection.onMessage = (message) => {
      const p = message.params ?? {};
      if (message.id !== undefined) {
        void (async () => {
          if (message.method.endsWith('/requestApproval')) {
            const accepted =
              !input.readOnly &&
              (await input.approve('Codex requests permission', JSON.stringify(p, null, 2)));
            connection.send({
              id: message.id,
              result: { decision: accepted ? 'accept' : 'decline' },
            });
          } else
            connection.send({
              id: message.id,
              error: {
                code: -32601,
                message: 'Unsupported interactive capability. Ask the user in the conversation.',
              },
            });
        })().catch((error) => fail(error));
        return;
      }
      if (message.method === 'item/agentMessage/delta') emit({ type: 'text', text: p.delta });
      if (message.method === 'item/completed') {
        if (p.item?.type === 'agentMessage') finalText = p.item.text;
        else if (p.item?.type === 'commandExecution')
          emit({
            type: 'tool',
            text: `${p.item.command}\n${String(p.item.aggregatedOutput ?? '').slice(-2000)}`,
          });
        else if (p.item?.type === 'fileChange')
          emit({ type: 'tool', text: `Changed: ${JSON.stringify(p.item.changes).slice(0, 2000)}` });
      }
      if (message.method === 'thread/tokenUsage/updated') {
        const u = p.tokenUsage?.total;
        if (u)
          emit({
            type: 'usage',
            usage: {
              requestId: 'thread-total',
              provider: 'codex',
              model: actualModel,
              input: Math.max(
                0,
                u.inputTokens - (u.cachedInputTokens ?? 0) - (u.cacheWriteInputTokens ?? 0),
              ),
              cached: u.cachedInputTokens ?? 0,
              cacheWrite: u.cacheWriteInputTokens ?? 0,
              output: u.outputTokens,
              reasoning: u.reasoningOutputTokens ?? 0,
              costUsd: null,
              costKind: 'unknown',
            },
          });
      }
      if (message.method === 'turn/started') turnId = p.turn.id;
      if (message.method === 'turn/completed')
        p.turn.status === 'completed'
          ? finish({ text: finalText, sessionId: threadId })
          : fail(new Error(p.turn.error?.message ?? `Codex turn ${p.turn.status}`));
    };
    const stop = () => {
      if (threadId && turnId)
        void connection.request('turn/interrupt', { threadId, turnId }).catch(() => {});
      fail(new Error('Run interrupted'));
      connection.close();
    };
    input.signal.addEventListener('abort', stop, { once: true });
    try {
      if (input.signal.aborted) throw new Error('Run interrupted');
      await connection.initialize();
      const config: Record<string, unknown> = {};
      if (input.mcp) config.mcp_servers = { dogfood: { ...input.mcp, enabled: true } };
      const params = {
        cwd: input.cwd,
        ...(input.role.model ? { model: input.role.model } : {}),
        approvalPolicy: 'on-request',
        sandbox: input.readOnly ? 'read-only' : 'workspace-write',
        config,
      };
      // New stage sessions avoid passing cumulative usage from unrelated runs as current spend.
      const thread = await connection.request('thread/start', params);
      threadId = thread.thread.id;
      actualModel = thread.model ?? input.role.model;
      emit({ type: 'session', sessionId: threadId });
      input.steer((text) => {
        if (turnId)
          void connection
            .request('turn/steer', {
              threadId,
              expectedTurnId: turnId,
              input: [{ type: 'text', text }],
            })
            .catch((error) => emit({ type: 'tool', text: String(error) }));
      });
      await connection.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: input.prompt }],
        effort: input.role.effort,
      });
      return await done;
    } finally {
      input.signal.removeEventListener('abort', stop);
      connection.close();
    }
  }
}

export class ClaudeAdapter implements HarnessAdapter {
  async run(input: HarnessInput, emit: (event: AgentEvent) => void): Promise<HarnessResult> {
    const env: Record<string, string | undefined> = {
      ...process.env,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    };
    for (const key of Object.keys(env))
      if (
        /^(DOGFOOD_|GITHUB_|SLACK_|TEAMS_)|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_USE_/.test(
          key,
        )
      )
        delete env[key];
    if (input.settings.claudeProvider === 'api') {
      if (input.secrets.claudeKey) env.ANTHROPIC_API_KEY = input.secrets.claudeKey;
    } else if (input.settings.claudeProvider === 'bedrock')
      Object.assign(env, { CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: input.settings.region });
    else
      Object.assign(env, {
        CLAUDE_CODE_USE_VERTEX: '1',
        CLOUD_ML_REGION: input.settings.region,
        ANTHROPIC_VERTEX_PROJECT_ID: input.settings.vertexProject,
      });
    const server = input.callTool
      ? createSdkMcpServer({
          name: 'dogfood',
          version: '1.0.0',
          tools: toolDefinitions.map((def) =>
            tool(def.name, def.description, def.schema.shape, async (args) => {
              try {
                return {
                  content: [
                    {
                      type: 'text' as const,
                      text: JSON.stringify(await input.callTool!(def.name, args)),
                    },
                  ],
                };
              } catch (error) {
                return { isError: true, content: [{ type: 'text' as const, text: String(error) }] };
              }
            }),
          ),
        })
      : undefined;
    const queue: string[] = [input.prompt];
    let wake: (() => void) | undefined,
      closed = false;
    const messages = async function* (): AsyncGenerator<SDKUserMessage> {
      while (!closed) {
        if (!queue.length)
          await new Promise<void>((r) => {
            wake = r;
          });
        const text = queue.shift();
        if (text)
          yield {
            type: 'user',
            session_id: '',
            parent_tool_use_id: null,
            message: { role: 'user', content: text },
          };
      }
    };
    input.steer((text) => {
      queue.push(text);
      wake?.();
    });
    const stream = query({
      prompt: messages(),
      options: {
        cwd: input.cwd,
        env,
        pathToClaudeCodeExecutable: input.settings.claudePath,
        ...(input.role.model ? { model: input.role.model } : {}),
        effort: input.role.effort,
        settingSources: ['project'],
        persistSession: true,
        includePartialMessages: true,
        tools: input.readOnly
          ? ['Read', 'Glob', 'Grep']
          : ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'],
        permissionMode: input.readOnly ? 'plan' : 'acceptEdits',
        ...(server ? { mcpServers: { dogfood: server }, allowedTools: ['mcp__dogfood__*'] } : {}),
        maxTurns: 24,
        ...(input.maxBudgetUsd ? { maxBudgetUsd: input.maxBudgetUsd } : {}),
        canUseTool: async (name, args) => {
          if (input.readOnly) return { behavior: 'deny', message: 'Read-only workflow stage.' };
          const accepted = await input.approve(`Allow ${name}?`, JSON.stringify(args, null, 2));
          return accepted
            ? { behavior: 'allow', updatedInput: args }
            : { behavior: 'deny', message: 'Declined in Dogfood.' };
        },
        hooks: {
          PreToolUse: [
            {
              hooks: [
                async (hook) => {
                  if (hook.hook_event_name !== 'PreToolUse') return {};
                  const args = hook.tool_input as Record<string, unknown>;
                  const name = hook.tool_name;
                  if (
                    ['Read', 'Write', 'Edit'].includes(name) &&
                    typeof args.file_path === 'string'
                  ) {
                    try {
                      await safePath(input.cwd, args.file_path, name !== 'Read');
                    } catch (error) {
                      return {
                        hookSpecificOutput: {
                          hookEventName: 'PreToolUse',
                          permissionDecision: 'deny',
                          permissionDecisionReason: String(error),
                        },
                      };
                    }
                    if (name === 'Read' && input.callTool && !args.limit && !args.offset) {
                      try {
                        const content = await readSource(input.cwd, args.file_path);
                        if (content.length / 4 > input.bulkThreshold)
                          return {
                            hookSpecificOutput: {
                              hookEventName: 'PreToolUse',
                              permissionDecision: 'deny',
                              permissionDecisionReason:
                                'Large source: use dogfood bulk_read for orientation, or a targeted Read with offset/limit for direct inspection.',
                            },
                          };
                      } catch {}
                    }
                  }
                  return {};
                },
              ],
            },
          ],
        },
      },
    });
    const stop = () => {
      closed = true;
      wake?.();
      stream.close();
    };
    input.signal.addEventListener('abort', stop, { once: true });
    let finalText = '',
      sessionId: string | undefined;
    try {
      if (input.signal.aborted) throw new Error('Run interrupted');
      for await (const message of stream) {
        if (message.type === 'system' && message.subtype === 'init') {
          sessionId = message.session_id;
          emit({ type: 'session', sessionId });
        }
        if (
          message.type === 'stream_event' &&
          message.event.type === 'content_block_delta' &&
          message.event.delta.type === 'text_delta'
        )
          emit({ type: 'text', text: message.event.delta.text });
        if (message.type === 'assistant')
          for (const block of message.message.content) {
            if (block.type === 'tool_use')
              emit({
                type: 'tool',
                text: `${block.name}: ${JSON.stringify(block.input).slice(0, 1000)}`,
              });
          }
        if (message.type === 'result') {
          for (const [model, u] of Object.entries(message.modelUsage ?? {}))
            emit({
              type: 'usage',
              usage: {
                requestId: model,
                provider: 'claude',
                model,
                input: u.inputTokens,
                cached: u.cacheReadInputTokens,
                cacheWrite: u.cacheCreationInputTokens,
                output: u.outputTokens,
                reasoning: null,
                costUsd: u.costBasis === 'unknown' ? null : u.costUSD,
                costKind: u.costBasis === 'unknown' ? 'unknown' : 'estimated',
              },
            });
          if (message.subtype !== 'success')
            throw new Error(message.errors?.join('\n') ?? `Claude ${message.subtype}`);
          finalText = message.result;
          break;
        }
      }
      if (input.signal.aborted) throw new Error('Run interrupted');
      if (!finalText) throw new Error('Claude returned no completed response.');
      return { text: finalText, sessionId };
    } finally {
      closed = true;
      wake?.();
      input.signal.removeEventListener('abort', stop);
      stream.close();
    }
  }
}
