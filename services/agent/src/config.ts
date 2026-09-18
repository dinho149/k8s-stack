import { z } from 'zod';
export const providerSchema = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('bedrock'), region: z.string().min(1), model: z.string().min(1) }),
  z.object({
    provider: z.literal('vertex'),
    region: z.string().min(1),
    model: z.string().min(1),
    project: z.string().min(1),
  }),
]);
export type Provider = z.infer<typeof providerSchema>;
export function providerEnvironment(
  p: Provider,
  inherited: NodeJS.ProcessEnv = process.env,
): Record<string, string | undefined> {
  const env = { ...inherited };
  for (const key of [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
    'CLAUDE_CODE_USE_ANTHROPIC_AWS',
    'ANTHROPIC_MODEL',
  ])
    delete env[key];
  if (p.provider === 'bedrock')
    Object.assign(env, { CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: p.region });
  else
    Object.assign(env, {
      CLAUDE_CODE_USE_VERTEX: '1',
      CLOUD_ML_REGION: p.region,
      ANTHROPIC_VERTEX_PROJECT_ID: p.project,
    });
  // Only the trusted application possesses lifecycle and channel credentials.
  for (const key of Object.keys(env))
    if (/^(DOGFOOD_|STACK_|SLACK_|TEAMS_|GOOGLE_CHAT_|GITHUB_)/.test(key)) delete env[key];
  return env;
}
export function providersFromEnv(): Record<string, Provider> {
  const result: Record<string, Provider> = {};
  if (process.env.BEDROCK_MODEL)
    result.bedrock = providerSchema.parse({
      provider: 'bedrock',
      model: process.env.BEDROCK_MODEL,
      region: process.env.AWS_REGION,
    });
  if (process.env.VERTEX_MODEL)
    result.vertex = providerSchema.parse({
      provider: 'vertex',
      model: process.env.VERTEX_MODEL,
      region: process.env.CLOUD_ML_REGION,
      project: process.env.ANTHROPIC_VERTEX_PROJECT_ID,
    });
  return result;
}
export function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}
