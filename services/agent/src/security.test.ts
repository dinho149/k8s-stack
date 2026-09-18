import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { providerEnvironment, providerSchema } from './config.js';
import { verifySlack, teamsServiceURL } from './channels.js';
test('provider selection removes fallback credentials and action credentials', () => {
  const env = providerEnvironment(
    { provider: 'vertex', region: 'europe-west1', project: 'test', model: 'model' },
    {
      ANTHROPIC_API_KEY: 'secret',
      CLAUDE_CODE_USE_BEDROCK: '1',
      STACK_SERVICE_TOKEN: 'secret',
      SLACK_BOT_TOKEN: 'secret',
    },
  );
  assert.equal(env.CLAUDE_CODE_USE_VERTEX, '1');
  assert.equal(env.CLAUDE_CODE_USE_BEDROCK, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.STACK_SERVICE_TOKEN, undefined);
  assert.equal(env.SLACK_BOT_TOKEN, undefined);
});
test('Vertex requires an explicit project', () =>
  assert.equal(
    providerSchema.safeParse({ provider: 'vertex', region: 'x', model: 'x' }).success,
    false,
  ));
test('Slack verifies exact body and rejects replay', () => {
  const now = Date.now(),
    ts = String(Math.floor(now / 1000)),
    body = Buffer.from('{"text":"extend"}');
  const sig = 'v0=' + createHmac('sha256', 'key').update(`v0:${ts}:`).update(body).digest('hex');
  assert.equal(verifySlack(body, ts, sig, 'key', now), true);
  assert.equal(verifySlack(Buffer.from('{}'), ts, sig, 'key', now), false);
  assert.equal(verifySlack(body, ts, sig, 'key', now + 301000), false);
});
test('Teams rejects credential exfiltration URLs', () => {
  for (const url of [
    'http://smba.trafficmanager.net/',
    'https://evil.example/',
    'https://smba.trafficmanager.net.evil.example/',
    'https://user@smba.trafficmanager.net/',
  ])
    assert.throws(() => teamsServiceURL(url));
  assert.equal(
    teamsServiceURL('https://smba.trafficmanager.net/emea/'),
    'https://smba.trafficmanager.net/emea/',
  );
});

import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import { verifyTeams, verifyGoogle } from './channels.js';
test('Teams verifies issuer and application audience', async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const keys = createLocalJWKSet({
    keys: [{ ...(await exportJWK(publicKey)), kid: 'test', alg: 'RS256' }],
  });
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', kid: 'test' })
    .setIssuer('https://api.botframework.com')
    .setAudience('app')
    .setExpirationTime('5m')
    .sign(privateKey);
  await verifyTeams(token, 'app', keys);
  await assert.rejects(() => verifyTeams(token, 'different-app', keys));
});
test('Google rejects a validly signed token from the wrong service identity', async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const keys = createLocalJWKSet({
    keys: [{ ...(await exportJWK(publicKey)), kid: 'test', alg: 'RS256' }],
  });
  const sign = (email: string) =>
    new SignJWT({ email, email_verified: true })
      .setProtectedHeader({ alg: 'RS256', kid: 'test' })
      .setIssuer('https://accounts.google.com')
      .setAudience('chat-app')
      .setExpirationTime('5m')
      .sign(privateKey);
  await verifyGoogle(await sign('chat@system.gserviceaccount.com'), 'chat-app', keys);
  const bad = await sign('attacker@example.com');
  await assert.rejects(() => verifyGoogle(bad, 'chat-app', keys));
});
