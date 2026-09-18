import { Page } from '@playwright/test';
export const digest = 'ghcr.io/team/app@sha256:' + 'a'.repeat(64);

// ---- Teleport access fixtures
export type AccessRequestFixture = {
  id: string;
  user: string;
  roles: string[];
  reason: string;
  state: string;
  created: string;
  expires: string;
  reviews_detail?: { author: string; state: string; reason: string; created: string }[];
  annotations?: Record<string, string[]>;
  tsh_login_command?: string;
  tsh_status_command?: string;
};
export const roleCatalog = [
  {
    name: 'requester',
    description: 'Request catalog roles',
    can_request_roles: ['dev-ssh', 'prod-ssh'],
  },
  {
    name: 'dev-ssh',
    description: "SSH as 'dev' on local/dev servers",
    node_labels: { env: ['local', 'dev'] },
    logins: ['dev'],
    max_session_ttl: '4h0m0s',
  },
  {
    name: 'prod-ssh',
    description: "SSH as 'dev' on production servers",
    node_labels: { env: ['prod'] },
    logins: ['dev'],
    max_session_ttl: '2h0m0s',
  },
  { name: 'editor', description: 'Teleport editor' },
];
export const requestableRoles = [
  {
    role: 'dev-ssh',
    description: "SSH as 'dev' on local/dev servers",
    prediction: 'auto_approve',
    rule: 'auto-approve-low-risk',
    approver_roles: [],
    ttl_cap: '4h0m0s',
  },
  {
    role: 'prod-ssh',
    description: "SSH as 'dev' on production servers",
    prediction: 'require_approval',
    rule: 'high-risk-needs-approval',
    approver_roles: ['approver'],
    ttl_cap: '1h0m0s',
  },
];
export const alice = {
  user: 'alice',
  email: 'alice@example.test',
  roles: ['requester'],
  traits: { email: ['alice@example.test'] },
  active_elevated_roles: { 'dev-ssh': '2030-09-18T22:00:00Z' },
  is_approver: false,
  effective_access: [roleCatalog[0], roleCatalog[1]],
  note: 'Roles without label selectors grant no infrastructure access.',
};
export const bob = {
  ...alice,
  user: 'bob',
  email: 'bob@example.test',
  roles: ['requester', 'approver'],
  is_approver: true,
  active_elevated_roles: {},
};
export const approvedRequest: AccessRequestFixture = {
  id: 'a11ce000-1111-2222-3333-444444444444',
  user: 'alice',
  roles: ['dev-ssh'],
  reason: 'poking around the dev boxes',
  state: 'APPROVED',
  created: '2026-09-18T18:00:00Z',
  expires: '2030-09-18T22:00:00Z',
  annotations: { 'access-broker/mode': ['auto'], 'access-broker/rule': ['auto-approve-low-risk'] },
  tsh_login_command: 'tsh login --request-id=a11ce000-1111-2222-3333-444444444444',
  tsh_status_command: 'tsh request show a11ce000-1111-2222-3333-444444444444',
};
export const pendingRequest: AccessRequestFixture = {
  id: 'b0b00000-1111-2222-3333-444444444444',
  user: 'alice',
  roles: ['prod-ssh'],
  reason: 'incident 123 needs a look at prod',
  state: 'PENDING',
  created: '2026-09-18T19:00:00Z',
  expires: '2030-09-18T21:00:00Z',
};
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
    // Teleport access pages (proxied to the access portal API as /access/*)
    access: {
      configured: true,
      me: structuredClone(alice),
      failApprove: '' as '' | 'self_approval' | 'not_pending',
      requests: [
        structuredClone(approvedRequest),
        structuredClone(pendingRequest),
      ] as AccessRequestFixture[],
    },
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
    if (path.startsWith('/access/')) {
      const rest = path.slice('/access'.length);
      const access = state.access;
      if (!access.configured)
        return respond({ error: 'Teleport access is not configured', code: 'not_configured' }, 503);
      if (rest === '/me') return respond(access.me);
      if (rest === '/cluster')
        return respond({
          cluster_name: 'teleport.example.test',
          teleport_version: '18.11.1',
          edition: 'community',
          approval_model: 'Community Edition: the access broker decides.',
        });
      if (rest === '/roles') return respond({ roles: roleCatalog });
      if (rest.startsWith('/roles/')) {
        const name = decodeURIComponent(rest.slice('/roles/'.length));
        const role = roleCatalog.find((r) => r.name === name);
        if (!role) return respond({ error: `role ${name} not found`, code: 'not_found' }, 404);
        const rr = requestableRoles.find((r) => r.role === name);
        return respond({
          role,
          deny: {},
          kubernetes_resources: [],
          requestable: Boolean(rr),
          prediction: rr,
        });
      }
      if (rest === '/requestable-roles')
        return respond({
          requestable_roles: requestableRoles,
          suggested_reviewers: [],
          require_reason: true,
        });
      if (rest === '/approvers')
        return respond({
          role: 'prod-ssh',
          policy_action: 'require_approval',
          policy_rule: 'high-risk-needs-approval',
          approver_roles: ['approver'],
          approvers: ['bob'],
          suggested_reviewers: [],
          how: 'Approvers click Approve.',
        });
      if (rest === '/requests/preview' && method === 'POST') {
        const deny = body.roles.includes('editor');
        return respond({
          created: false,
          dry_run: true,
          request: { ...pendingRequest, roles: body.roles, reason: body.reason },
          prediction: {
            action: deny
              ? 'deny'
              : body.roles.some((r: string) => r.startsWith('prod-'))
                ? 'require_approval'
                : 'auto_approve',
            rule: 'rule',
            reason: '',
            ttl_cap: '1h0m0s',
            approvers: ['approver'],
          },
          tsh_command: `tsh request create --roles ${body.roles.join(',')} --max-duration 1h --reason "${body.reason}"`,
          ...(body.ttl === '4h' ? { ttl_clamped_from: '4h0m0s', ttl: '1h0m0s' } : {}),
        });
      }
      if (rest === '/requests' && method === 'POST') {
        if (state.failCreate)
          return respond(
            {
              error: 'too many access requests created recently; try again later',
              code: 'rate_limited',
            },
            429,
          );
        const auto = !body.roles.some((r: string) => r.startsWith('prod-'));
        const created: AccessRequestFixture = {
          ...pendingRequest,
          id: 'c0ffee00-1111-2222-3333-444444444444',
          roles: body.roles,
          reason: body.reason,
          state: auto ? 'APPROVED' : 'PENDING',
          ...(auto
            ? { tsh_login_command: 'tsh login --request-id=c0ffee00-1111-2222-3333-444444444444' }
            : {}),
        };
        access.requests.push(created);
        return respond(
          {
            created: true,
            request: created,
            prediction: {
              action: auto ? 'auto_approve' : 'require_approval',
              rule: 'rule',
              reason: '',
              ttl_cap: '1h0m0s',
              approvers: [],
            },
            tsh_command: 'tsh request create ...',
            note: 'pending',
          },
          201,
        );
      }
      if (rest === '/requests' && method === 'GET') {
        const want = new URL(req.url()).searchParams.get('state');
        return respond({
          requests: access.requests.filter(
            (r) => r.user === access.me.user && (!want || r.state.toLowerCase() === want),
          ),
        });
      }
      if (rest === '/approvals')
        return access.me.is_approver
          ? respond({
              requests: access.requests.filter(
                (r) => r.state === 'PENDING' && r.user !== access.me.user,
              ),
            })
          : respond(
              {
                error: "only approvers can list other users' pending requests",
                code: 'teleport_denied',
              },
              403,
            );
      const decide = /^\/requests\/([^/]+)\/(approve|deny)$/.exec(rest);
      if (decide && method === 'POST') {
        if (access.failApprove)
          return respond(
            {
              error:
                access.failApprove === 'self_approval'
                  ? 'requester cannot decide their own request'
                  : 'request is not pending',
              code: access.failApprove,
            },
            access.failApprove === 'self_approval' ? 403 : 409,
          );
        const r = access.requests.find((x) => x.id === decide[1])!;
        r.state = decide[2] === 'approve' ? 'APPROVED' : 'DENIED';
        r.reviews_detail = [
          {
            author: access.me.user,
            state: r.state,
            reason: body.reason,
            created: '2026-09-18T20:00:00Z',
          },
        ];
        if (r.state === 'APPROVED') r.tsh_login_command = `tsh login --request-id=${r.id}`;
        return respond(r);
      }
      const one = /^\/requests\/([^/]+)$/.exec(rest);
      if (one) {
        const r = access.requests.find(
          (x) => x.id === one[1] && (x.user === access.me.user || access.me.is_approver),
        );
        return r
          ? respond(r)
          : respond({ error: `no access request ${one[1]}`, code: 'not_found' }, 404);
      }
      return respond({ error: `Unmocked access endpoint: ${rest}`, code: 'not_found' }, 404);
    }
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
