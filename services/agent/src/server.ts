import express from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Agent } from './agent.js';
import { PlatformClient } from './client.js';
import { providersFromEnv, required } from './config.js';
import { send, verifyGoogle, verifySlack, verifyTeams, teamsServiceURL } from './channels.js';

const base = required('DOGFOOD_API_URL'),
  token = required('DOGFOOD_SERVICE_TOKEN');
const stateDir = process.env.AGENT_STATE_DIR ?? '.dogfood/agent';
await mkdir(join(stateDir, 'receipts'), { recursive: true, mode: 0o700 });
const providers = providersFromEnv();
const defaultProvider = required('AGENT_PROVIDER');
if (!providers[defaultProvider]) throw new Error('Default provider is not configured');
const platform = new PlatformClient(base, token);
const agent = new Agent(providers, base, token, stateDir);
const app = express();
app.disable('x-powered-by');
app.use(express.raw({ type: 'application/json', limit: '64kb' }));
const tenants = (name: string) => new Set((process.env[name] ?? '').split(',').filter(Boolean));
const errorText = (e: unknown) => (e instanceof Error ? e.message : 'Request failed');
const bearer = (header: string | undefined) =>
  header?.startsWith('Bearer ') ? header.slice(7) : '';
function serviceAuth(value: string) {
  const a = createHash('sha256').update(value).digest(),
    b = createHash('sha256').update(token).digest();
  return timingSafeEqual(a, b);
}
let active = 0;
const maxActive = Number(process.env.AGENT_CONCURRENCY ?? '4');
interface ChatMessage {
  channel: string;
  tenant: string;
  user: string;
  conversation: string;
  eventId: string;
  destination: string;
  text: string;
  personal: boolean;
}
async function processMessage(m: ChatMessage) {
  const receipt = join(
    stateDir,
    'receipts',
    createHash('sha256').update(`${m.channel}:${m.tenant}:${m.eventId}`).digest('hex'),
  );
  try {
    await writeFile(receipt, JSON.stringify({ status: 'received', at: new Date().toISOString() }), {
      flag: 'wx',
      mode: 0o600,
    });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return;
    throw e;
  }
  try {
    if (!m.personal) {
      await send(
        m.channel,
        m.destination,
        'Please send me a direct message to access environment details or perform actions.',
      );
      return;
    }
    if (m.text.startsWith('/link ')) {
      await platform.request('/internal/link', 'POST', {
        code: m.text.slice(6).trim(),
        channel: m.channel,
        tenant: m.tenant,
        user: m.user,
        destination: m.destination,
      });
      await send(
        m.channel,
        m.destination,
        'Account linked. You can now ask about your environments and policies.',
      );
      return;
    }
    const identity = await platform.request(
      `/internal/identity?${new URLSearchParams({ channel: m.channel, tenant: m.tenant, user: m.user })}`,
    );
    if (active >= maxActive) {
      await send(
        m.channel,
        m.destination,
        'The agent is busy. Please retry shortly; your request has not executed.',
      );
      return;
    }
    active++;
    try {
      const answer = await agent.ask({
        subject: identity.subject,
        conversation: `${m.channel}:${m.tenant}:${m.conversation}`,
        provider: defaultProvider,
        text: m.text,
      });
      await send(m.channel, m.destination, answer);
    } finally {
      active--;
    }
  } catch (e) {
    console.error('Chat request failed', {
      channel: m.channel,
      eventId: m.eventId,
      error: errorText(e),
    });
    await send(
      m.channel,
      m.destination,
      'I could not complete that request. Check the portal for authoritative operation status. If your account is not linked, generate a link code in the portal first.',
    ).catch(() => {});
  } finally {
    await writeFile(receipt, JSON.stringify({ status: 'handled', at: new Date().toISOString() }), {
      mode: 0o600,
    });
  }
}
app.get('/healthz', (_req, res) => res.json({ status: 'ok', providers: Object.keys(providers) }));
app.post('/chat/slack', (req, res) => {
  if (
    !process.env.SLACK_SIGNING_SECRET ||
    !verifySlack(
      req.body,
      req.header('x-slack-request-timestamp') ?? '',
      req.header('x-slack-signature') ?? '',
      process.env.SLACK_SIGNING_SECRET,
    )
  ) {
    res.sendStatus(403);
    return;
  }
  const event = JSON.parse(req.body.toString());
  if (event.type === 'url_verification') {
    res.json({ challenge: event.challenge });
    return;
  }
  if (!tenants('SLACK_ALLOWED_TEAMS').has(event.team_id)) {
    res.sendStatus(403);
    return;
  }
  const e = event.event;
  res.sendStatus(200);
  if (!e || e.bot_id || e.subtype || !['message', 'app_mention'].includes(e.type)) return;
  void processMessage({
    channel: 'slack',
    tenant: event.team_id,
    user: e.user,
    conversation: e.channel + ':' + (e.thread_ts ?? e.ts),
    eventId: event.event_id,
    destination: JSON.stringify({ channel: e.channel, thread: e.thread_ts ?? e.ts }),
    text: e.text,
    personal: e.channel_type === 'im',
  });
});
app.post('/chat/teams', async (req, res) => {
  try {
    await verifyTeams(bearer(req.header('authorization')), required('TEAMS_APP_ID'));
    const e = JSON.parse(req.body.toString());
    const tenant = e.channelData?.tenant?.id;
    if (!tenants('TEAMS_ALLOWED_TENANTS').has(tenant)) throw new Error('Tenant denied');
    const serviceUrl = teamsServiceURL(e.serviceUrl);
    res.sendStatus(200);
    if (e.type !== 'message') return;
    void processMessage({
      channel: 'teams',
      tenant,
      user: e.from.aadObjectId ?? e.from.id,
      conversation: e.conversation.id,
      eventId: e.id,
      destination: JSON.stringify({ serviceUrl, conversation: e.conversation.id }),
      text: e.text ?? '',
      personal: e.conversation.conversationType === 'personal',
    });
  } catch {
    res.sendStatus(403);
  }
});
app.post('/chat/google', async (req, res) => {
  try {
    await verifyGoogle(bearer(req.header('authorization')), required('GOOGLE_CHAT_AUDIENCE'));
    const e = JSON.parse(req.body.toString());
    const tenant = e.user?.domainId;
    if (!tenants('GOOGLE_CHAT_ALLOWED_DOMAINS').has(tenant)) throw new Error('Domain denied');
    res.json({});
    if (e.type !== 'MESSAGE') return;
    void processMessage({
      channel: 'google',
      tenant,
      user: e.user.name,
      conversation: e.message.thread?.name ?? e.space.name,
      eventId: e.message.name,
      destination: JSON.stringify({ space: e.space.name, thread: e.message.thread?.name }),
      text: e.message.argumentText ?? e.message.text ?? '',
      personal: e.space.type === 'DM' || e.space.spaceType === 'DIRECT_MESSAGE',
    });
  } catch {
    res.sendStatus(403);
  }
});
app.post('/internal/ask', async (req, res) => {
  if (!serviceAuth(bearer(req.header('authorization')))) {
    res.sendStatus(403);
    return;
  }
  if (active >= maxActive) {
    res.status(429).json({ error: 'Agent busy' });
    return;
  }
  const body = JSON.parse(req.body.toString());
  if (
    typeof body.subject !== 'string' ||
    typeof body.conversation !== 'string' ||
    typeof body.text !== 'string'
  ) {
    res.sendStatus(400);
    return;
  }
  active++;
  try {
    await new PlatformClient(base, token, body.subject).request('/v1/me');
    const answer = await agent.ask({ ...body, provider: body.provider ?? defaultProvider });
    res.json({ answer });
  } catch (e) {
    res.status(400).json({ error: errorText(e) });
  } finally {
    active--;
  }
});
let notifying = false;
const timer = setInterval(async () => {
  if (notifying) return;
  notifying = true;
  try {
    const items = await platform.request('/internal/notifications', 'POST', {});
    for (const item of items) {
      const n = item.notification,
        e = item.environment;
      const messages: Record<string, string> = {
        ready: `Environment ${e.id} is ready: ${e.url}`,
        expiring: `Environment ${e.id} expires at ${e.expiresAt} (within five minutes). Ask me to add five minutes, or extend it in the portal.`,
        late: `Environment ${e.id} is taking longer than the warm-start target. Check operation ${e.operationId} for the current phase.`,
        failed: `Environment ${e.id} failed. Ask me to diagnose it.`,
        'cleanup-failed': `Cleanup failed for ${e.id}; platform operator attention is needed.`,
        deleted: `Environment ${e.id} has been deleted.`,
      };
      const validity = await platform.request(
        '/internal/notifications/valid?' + new URLSearchParams({ id: n.id }),
      );
      if (validity.valid)
        for (const d of item.destinations)
          await send(
            d.channel,
            d.destination,
            messages[n.kind] ?? `Environment ${e.id}: ${n.kind}`,
          );
      await platform.request('/internal/notifications/ack', 'POST', { id: n.id });
    }
  } catch (e) {
    console.error('Notification delivery deferred:', errorText(e));
  } finally {
    notifying = false;
  }
}, 15000);
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err.message);
  res.status(400).json({ error: 'Invalid request' });
});
const server = app.listen(Number(process.env.PORT ?? 8090), '0.0.0.0', () =>
  console.log('Agent service listening'),
);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    clearInterval(timer);
    server.close();
  });
