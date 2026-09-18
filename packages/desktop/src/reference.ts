import { z } from 'zod';
import { commandSchema, roleSchema, type AgentEvent } from './shared';

export const referenceSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local'), path: z.string().trim().min(1) }),
  z.object({
    kind: z.literal('github'),
    url: z.string().url(),
    branch: z.string().trim().default(''),
  }),
]);
export const referenceCommandsSchema = z.object({
  setup: z.array(commandSchema).max(12),
  checks: z.array(commandSchema).min(1).max(12),
  dev: commandSchema.optional(),
  readinessPath: z
    .string()
    .regex(/^\/(?!\/)[^\\]*$/)
    .default('/'),
});
export const conventionProfileSchema = z.object({
  stack: z.string().min(1).max(2000),
  packageManager: z.string().max(1000),
  structure: z.array(z.string().max(500)).max(100),
  conventions: z.string().min(1).max(16000),
  prerequisites: z.string().max(4000),
  uncertainties: z.array(z.string().max(1000)).max(30),
  evidence: z.array(z.string().max(500)).max(100),
  commands: referenceCommandsSchema,
});
export const creationInputSchema = z.object({
  source: referenceSourceSchema,
  subdirectory: z.string().default(''),
  name: z.string().trim().min(1).max(120),
  destination: z.string().trim().min(1),
  description: z.string().max(4000).default(''),
  role: roleSchema,
  budgetUsd: z.number().positive().optional(),
});
export type ConventionProfile = z.infer<typeof conventionProfileSchema>;
export type CreationInput = z.infer<typeof creationInputSchema>;
export type CreationStatus =
  | 'capturing'
  | 'awaiting-scope'
  | 'analyzing'
  | 'review'
  | 'generating'
  | 'verifying'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'complete';
export const creationBusy = (status: CreationStatus) =>
  ['capturing', 'analyzing', 'generating', 'verifying'].includes(status);
export type CreationUsage = NonNullable<AgentEvent['usage']> & { runId: string };
export type CreationJob = {
  id: string;
  input: CreationInput;
  status: CreationStatus;
  phase: 'analyze' | 'generate' | 'verify';
  createdAt: string;
  updatedAt: string;
  candidates: string[];
  profile?: ConventionProfile;
  provenance?: { label: string; revision?: string; hash: string; subdirectory: string };
  error?: string;
  log: string;
  usage: CreationUsage[];
  runs: { id: string; stage: string; startedAt: string; finishedAt?: string; error?: string }[];
  materialized?: boolean;
  repairs?: number;
  reviewedConfigHash?: string;
  ownedDestination?: string;
  projectId?: string;
  verified?: boolean;
};
