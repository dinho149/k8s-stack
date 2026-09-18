import { z } from 'zod';

export const harnessId = z.enum(['codex', 'claude']);
export type Harness = z.infer<typeof harnessId>;
export const commandSchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().default('.'),
  timeoutSeconds: z.number().int().min(1).max(3600).default(300),
});
export type Command = z.infer<typeof commandSchema>;
export const roleSchema = z.object({
  harness: harnessId.default('codex'),
  model: z.string().default(''),
  effort: z.enum(['low', 'medium', 'high']).default('medium'),
});
export type ModelRole = z.infer<typeof roleSchema>;
export const configSchema = z.object({
  version: z.literal(1).default(1),
  setup: z.array(commandSchema).default([]),
  checks: z.array(commandSchema).default([]),
  dev: commandSchema.optional(),
  readinessPath: z
    .string()
    .regex(/^\/(?!\/)[^\\]*$/)
    .default('/'),
  composeFile: z.string().optional(),
  costs: z
    .object({
      policy: z.literal('balanced').default('balanced'),
      approvedHarnesses: z.array(harnessId).min(1).default(['codex', 'claude']),
      primary: roleSchema.default({ harness: 'codex', model: '', effort: 'high' }),
      worker: roleSchema.optional(),
      review: roleSchema.optional(),
      taskBudgetUsd: z.number().positive().optional(),
      dailyBudgetUsd: z.number().positive().optional(),
      bulkReadTokens: z.number().int().min(1000).default(4000),
      workerRouting: z.boolean().default(false),
      maxRepairIterations: z.number().int().min(0).max(10).default(3),
      maxRunMinutes: z.number().int().min(1).max(240).default(30),
    })
    .default({
      policy: 'balanced',
      approvedHarnesses: ['codex', 'claude'],
      primary: { harness: 'codex', model: '', effort: 'high' },
      bulkReadTokens: 4000,
      workerRouting: false,
      maxRepairIterations: 3,
      maxRunMinutes: 30,
    }),
});
export type ProjectConfig = z.infer<typeof configSchema>;
export type Project = {
  id: string;
  name: string;
  path: string;
  baseBranch: string;
  config: ProjectConfig;
  createdAt: string;
  removedAt?: string;
};
export type Idea = {
  id: string;
  projectId: string;
  title: string;
  description: string;
  spec: string;
  createdAt: string;
};
export type TaskStatus =
  | 'idea'
  | 'planning'
  | 'awaiting-plan'
  | 'implementing'
  | 'validating'
  | 'reviewing'
  | 'awaiting-review'
  | 'ready'
  | 'merged'
  | 'published'
  | 'paused'
  | 'failed'
  | 'archived';
export type Task = {
  id: string;
  projectId: string;
  ideaId?: string;
  title: string;
  description: string;
  acceptance: string;
  dependencies: string[];
  status: TaskStatus;
  stage: string;
  plan: string;
  worktree?: string;
  branch?: string;
  baseRevision?: string;
  planHash?: string;
  validatedHash?: string;
  reviewedHash?: string;
  approvedHash?: string;
  review?: string;
  reviewBlocking?: boolean;
  prUrl?: string;
  prNumber?: number;
  createdAt: string;
  updatedAt: string;
  error?: string;
};
export type Run = {
  id: string;
  taskId: string;
  stage: string;
  harness: Harness | 'local';
  model: string;
  status: 'running' | 'succeeded' | 'failed' | 'interrupted';
  startedAt: string;
  finishedAt?: string;
  sessionId?: string;
  error?: string;
};
export type Artifact = {
  id: string;
  taskId: string;
  runId?: string;
  kind: string;
  title: string;
  path: string;
  createdAt: string;
  sourceHash?: string;
};
export type Usage = {
  id: string;
  taskId: string;
  projectId: string;
  runId: string;
  requestId: string;
  provider: string;
  model: string;
  input: number | null;
  cached: number | null;
  cacheWrite: number | null;
  output: number | null;
  reasoning: number | null;
  costUsd: number | null;
  costKind: 'reported' | 'estimated' | 'unknown';
  pricingDate?: string;
  createdAt: string;
};
export type Approval = { id: string; taskId: string; runId: string; title: string; detail: string };
export type Price = {
  model: string;
  provider: Harness;
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
  date: string;
};
export type Settings = {
  codexPath: string;
  claudePath: string;
  claudeProvider: 'api' | 'bedrock' | 'vertex';
  region: string;
  vertexProject: string;
  prices: Price[];
  platformUrl: string;
  hasClaudeKey?: boolean;
  hasPlatformToken?: boolean;
};
export const defaultSettings: Settings = {
  codexPath: 'codex',
  claudePath: 'claude',
  claudeProvider: 'api',
  region: '',
  vertexProject: '',
  prices: [],
  platformUrl: 'http://127.0.0.1:8088',
};
export type Snapshot = {
  projects: Project[];
  ideas: Idea[];
  tasks: Task[];
  runs: Run[];
  artifacts: Artifact[];
  usage: Usage[];
  approvals: Approval[];
  settings: Settings;
};
export type DesktopEvent = {
  type: 'changed' | 'output' | 'terminal' | 'approval';
  taskId?: string;
  runId?: string;
  text?: string;
  terminalId?: string;
};
export type AgentEvent = {
  type: 'text' | 'tool' | 'usage' | 'session';
  text?: string;
  sessionId?: string;
  usage?: Omit<Usage, 'id' | 'taskId' | 'projectId' | 'runId' | 'createdAt'>;
};
export type Request = { method: string; params?: Record<string, unknown> };
export type DesktopApi = {
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  onEvent(fn: (event: DesktopEvent) => void): () => void;
};
declare global {
  interface Window {
    dogfood: DesktopApi;
  }
}
