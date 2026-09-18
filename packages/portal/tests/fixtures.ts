import { Page } from '@playwright/test';
export const digest = 'ghcr.io/team/app@sha256:' + 'a'.repeat(64);
export const environment = {
  id: 'pr-checkout-42',
  owner: 'dinho',
  provider: 'kind',
  profile: 'preview',
  status: 'ready',
  revision: 'abcdef1234567',
  image: digest,
  url: 'https://preview.example.test',
  expiresAt: '2030-09-17T23:40:00Z',
  generation: 1,
  operationId: 'operation-42',
};
export async function mockPlatform(page: Page, empty = false) {
  const state = {
    environments: empty
      ? []
      : [
          structuredClone(environment),
          { ...environment, id: 'pr-payments-38', status: 'failed', operationId: 'operation-38' },
          { ...environment, id: 'pr-profile-41', status: 'pending', operationId: 'operation-41' },
        ],
    operations: empty
      ? []
      : [
          {
            id: 'operation-42',
            environmentId: environment.id,
            status: 'succeeded',
            phase: 'application-ready',
            warm: true,
            requestedAt: '2026-09-17T22:00:00Z',
            startedAt: '2026-09-17T22:00:01Z',
            timings: {
              'cluster-ready': '2026-09-17T22:00:12Z',
              'platform-ready': '2026-09-17T22:00:28Z',
              'application-ready': '2026-09-17T22:00:44Z',
            },
          },
          {
            id: 'operation-38',
            environmentId: 'pr-payments-38',
            status: 'failed',
            phase: 'provisioning',
            warm: true,
            requestedAt: '2026-09-17T21:55:00Z',
            startedAt: '2026-09-17T21:55:01Z',
            timings: {},
          },
        ],
    requests: [] as { path: string; method: string; body: any; key?: string }[],
    failReads: false,
    failCreate: false,
    failAgent: false,
    failDestroy: false,
  };
  await page.route('http://127.0.0.1:4707/**', async (route) => {
    const req = route.request(),
      path = new URL(req.url()).pathname.replace('/api/platform', '');
    const method = req.method();
    const body = req.postDataJSON();
    const respond = (json: unknown, status = 200) =>
      route.fulfill({
        status,
        json,
        headers: {
          'Access-Control-Allow-Origin': 'http://127.0.0.1:4173',
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Allow-Credentials': 'true',
        },
      });
    if (method === 'OPTIONS') return respond({});
    if (req.url().includes('/auth/guest/refresh')) {
      const token =
        'header.' +
        Buffer.from(
          JSON.stringify({ sub: 'user:default/guest', exp: Math.floor(Date.now() / 1000) + 3600 }),
        ).toString('base64url') +
        '.signature';
      return respond({
        profile: { displayName: 'Dinho', email: 'dinho@example.test' },
        backstageIdentity: {
          token,
          identity: {
            type: 'user',
            userEntityRef: 'user:default/guest',
            ownershipEntityRefs: ['user:default/guest'],
          },
        },
      });
    }
    state.requests.push({ path, method, body, key: req.headers()['idempotency-key'] });
    if (state.failReads && method === 'GET')
      return respond({ error: 'Platform connection unavailable' }, 503);
    if (path === '/environments' && method === 'GET') return respond(state.environments);
    if (path === '/operations') return respond(state.operations);
    if (path === '/environments' && method === 'POST') {
      if (state.failCreate) return respond({ error: 'Preview capacity reached' }, 409);
      state.environments.push({ ...environment, ...body, status: 'pending' });
      return respond({ id: 'new-operation' }, 201);
    }
    if (path.endsWith('/extend')) {
      const env = state.environments.find((e) => path.includes(e.id))!;
      env.generation++;
      env.expiresAt = '2030-09-17T23:45:00Z';
      return respond(env);
    }
    if (path.endsWith('/redeploy')) return respond({ id: 'retry-operation' });
    if (path.endsWith('/confirm-delete')) return respond({ id: 'server-confirmation' });
    if (path.endsWith('/destroy')) {
      if (state.failDestroy) return respond({ error: 'Confirmation expired' }, 409);
      state.environments.find((e) => path.includes(e.id))!.status = 'deleting';
      return respond({ id: 'delete-operation' });
    }
    if (path === '/promotions')
      return respond({
        note: 'Approval is required before production deployment.',
        url: 'https://github.com/example/platform/actions/runs/42',
      });
    if (path === '/link-code') return respond({ code: 'test-code' });
    if (path === '/agent')
      return state.failAgent
        ? respond({ error: 'Inference provider unavailable' }, 503)
        : respond({
            answer: 'Your preview is ready. The platform applies owner-scoped lifecycle policies.',
          });
    if (path === '/tools')
      return respond([
        {
          name: 'Argo CD',
          description: 'Follow deployments from Git to your Kubernetes environments.',
          url: 'https://argocd.example.test',
          status: 'installed',
        },
        {
          name: 'Grafana',
          description: 'Explore metrics and understand what your workloads are doing.',
          url: '',
          status: 'not-installed',
        },
        {
          name: 'Cilium',
          description: 'Observe network connectivity and workload policy.',
          url: 'https://cilium.example.test',
          status: 'installed',
        },
      ]);
    if (path === '/policies')
      return respond({
        role: 'developer',
        enforcement: 'enforced',
        source: 'platform.yaml',
        retrievedAt: '2026-09-17T22:00:00Z',
        notes:
          'Preview operations are owner-scoped. Cluster policy evidence is available to administrators.',
        lifecycle: {
          ttl: 3600000000000,
          maxTTL: 14400000000000,
          warmTarget: 180000000000,
          operationTimeout: 600000000000,
          maxPreviews: 10,
        },
      });
    return respond({ error: `Unmocked endpoint: ${path}` }, 404);
  });
  return state;
}
