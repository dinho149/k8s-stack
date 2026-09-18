import { createHmac, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { GoogleAuth } from 'google-auth-library';

export function verifySlack(
  raw: Buffer,
  timestamp: string,
  signature: string,
  secret: string,
  now = Date.now(),
): boolean {
  if (!/^\d+$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  const expected =
    'v0=' + createHmac('sha256', secret).update(`v0:${timestamp}:`).update(raw).digest('hex');
  const a = Buffer.from(expected),
    b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}
const teamsKeys = createRemoteJWKSet(new URL('https://login.botframework.com/v1/.well-known/keys'));
const googleKeys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
export async function verifyTeams(token: string, appId: string, keys: JWTVerifyGetKey = teamsKeys) {
  return jwtVerify(token, keys, {
    issuer: 'https://api.botframework.com',
    audience: appId,
    algorithms: ['RS256'],
  });
}
export async function verifyGoogle(
  token: string,
  audience: string,
  keys: JWTVerifyGetKey = googleKeys,
) {
  const result = await jwtVerify(token, keys, {
    issuer: ['https://accounts.google.com', 'accounts.google.com'],
    audience,
    algorithms: ['RS256'],
  });
  if (
    result.payload.email !== 'chat@system.gserviceaccount.com' ||
    result.payload.email_verified !== true
  )
    throw new Error('Unexpected Google Chat service identity');
  return result;
}
export function teamsServiceURL(value: string): string {
  const u = new URL(value);
  if (u.protocol !== 'https:' || u.username || u.password || u.port)
    throw new Error('Invalid Teams service URL');
  if (
    u.hostname !== 'smba.trafficmanager.net' &&
    !u.hostname.endsWith('.botframework.com') &&
    u.hostname !== 'api.botframework.com'
  )
    throw new Error('Untrusted Teams service URL');
  return u.href;
}
async function checked(response: Response): Promise<any> {
  if (!response.ok) throw new Error(`Chat delivery failed (${response.status})`);
  const result = (await response.json()) as any;
  if (result.ok === false) throw new Error(`Slack delivery failed: ${result.error}`);
  return result;
}
export async function send(channel: string, destination: string, text: string): Promise<void> {
  if (channel === 'slack') {
    const d = JSON.parse(destination);
    await checked(
      await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          channel: d.channel,
          thread_ts: d.thread,
          text,
          unfurl_links: false,
          unfurl_media: false,
        }),
        signal: AbortSignal.timeout(15000),
      }),
    );
  } else if (channel === 'teams') {
    const d = JSON.parse(destination);
    const service = teamsServiceURL(d.serviceUrl);
    const tenant = process.env.TEAMS_APP_TENANT_ID ?? 'botframework.com';
    const auth = await checked(
      await fetch(
        `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`,
        {
          method: 'POST',
          body: new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: process.env.TEAMS_APP_ID!,
            client_secret: process.env.TEAMS_APP_SECRET!,
            scope: 'https://api.botframework.com/.default',
          }),
          signal: AbortSignal.timeout(15000),
        },
      ),
    );
    await checked(
      await fetch(
        new URL(`v3/conversations/${encodeURIComponent(d.conversation)}/activities`, service),
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${auth.access_token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ type: 'message', text }),
          signal: AbortSignal.timeout(15000),
        },
      ),
    );
  } else if (channel === 'google') {
    const d = JSON.parse(destination);
    if (!/^spaces\/[A-Za-z0-9_-]+$/.test(d.space)) throw new Error('Invalid Google Chat space');
    const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/chat.bot'] });
    const client = await auth.getClient();
    await client.request({
      url: `https://chat.googleapis.com/v1/${d.space}/messages`,
      method: 'POST',
      data: { text, ...(d.thread ? { thread: { name: d.thread } } : {}) },
      params: { messageReplyOption: 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD' },
    });
  } else throw new Error('Unsupported channel');
}
