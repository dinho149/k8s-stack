import { createBackend } from '@backstage/backend-defaults';
import {
  coreServices,
  createBackendModule,
  createBackendPlugin,
} from '@backstage/backend-plugin-api';
import express from 'express';
import {
  createTemplateAction,
  scaffolderActionsExtensionPoint,
} from '@backstage/plugin-scaffolder-node';

const platformPlugin = createBackendPlugin({
  pluginId: 'platform',
  register(env) {
    env.registerInit({
      deps: {
        httpRouter: coreServices.httpRouter,
        httpAuth: coreServices.httpAuth,
        userInfo: coreServices.userInfo,
        config: coreServices.rootConfig,
      },
      async init({ httpRouter, httpAuth, userInfo, config }) {
        const router = express.Router();
        router.use(express.json({ limit: '64kb' }));
        router.use(async (req, res) => {
          try {
            const credentials = await httpAuth.credentials(req, { allow: ['user'] });
            const info = await userInfo.getUserInfo(credentials);
            const mappings = config.getConfigArray('platform.identities');
            const match = mappings.find((m) => m.getString('entityRef') === info.userEntityRef);
            if (!match) {
              res.status(403).json({ error: 'No platform identity mapping' });
              return;
            }
            const subject = match.getString('subject');
            const serviceToken = config.getString('platform.serviceToken');
            let target = new URL('/v1' + req.path, config.getString('platform.apiUrl'));
            let body = req.body;
            let method = req.method;
            if (req.path === '/agent') {
              if (req.method !== 'POST') {
                res.sendStatus(405);
                return;
              }
              target = new URL('/internal/ask', config.getString('platform.agentUrl'));
              body = {
                text: req.body.text,
                conversation: req.body.conversation,
                provider: req.body.provider,
                subject,
              };
            } else if (
              !/^\/(me|environments(?:\/[a-z0-9-]+(?:\/(extend|confirm-delete|destroy|redeploy|diagnostics))?)?|operations(?:\/[a-f0-9]+)?|tools|promotions|policies|link-code|audit)$/.test(
                req.path,
              )
            ) {
              res.sendStatus(404);
              return;
            }
            const response = await fetch(target, {
              method,
              headers: {
                Authorization: `Bearer ${serviceToken}`,
                'X-Dogfood-Subject': subject,
                'Content-Type': 'application/json',
                'Idempotency-Key': req.header('Idempotency-Key') ?? '',
              },
              body: ['GET', 'HEAD'].includes(method) ? undefined : JSON.stringify(body),
              signal: AbortSignal.timeout(req.path === '/agent' ? 125000 : 30000),
            });
            res
              .status(response.status)
              .type('application/json')
              .send(await response.text());
          } catch (e) {
            res.status(403).json({ error: e instanceof Error ? e.message : 'Unauthorized' });
          }
        });
        httpRouter.use(router);
      },
    });
  },
});
const scaffoldModule = createBackendModule({
  pluginId: 'scaffolder',
  moduleId: 'platform-environments',
  register(env) {
    env.registerInit({
      deps: {
        actions: scaffolderActionsExtensionPoint,
        config: coreServices.rootConfig,
        userInfo: coreServices.userInfo,
      },
      async init({ actions, config, userInfo }) {
        actions.addActions(
          createTemplateAction({
            id: 'platform:createPreview',
            description: 'Create an owned preview through the lifecycle API',
            schema: {
              input: {
                name: (z) => z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
                image: (z) => z.string().regex(/^[\w./:-]+@sha256:[a-f0-9]{64}$/),
                revision: (z) => z.string().regex(/^[a-f0-9]{7,64}$/),
              },
              output: { operationId: (z) => z.string() },
            },
            async handler(ctx) {
              const credentials = await ctx.getInitiatorCredentials();
              const info = await userInfo.getUserInfo(credentials);
              const mapping = config
                .getConfigArray('platform.identities')
                .find((m) => m.getString('entityRef') === info.userEntityRef);
              if (!mapping) throw new Error('Platform identity is not mapped');
              const result = await fetch(
                new URL('/v1/environments', config.getString('platform.apiUrl')),
                {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    Authorization: 'Bearer ' + config.getString('platform.serviceToken'),
                    'X-Dogfood-Subject': mapping.getString('subject'),
                    'Idempotency-Key': ctx.task.id,
                  },
                  body: JSON.stringify({
                    id: ctx.input.name,
                    image: ctx.input.image,
                    revision: ctx.input.revision,
                    profile: 'preview',
                    warm: true,
                  }),
                  signal: AbortSignal.timeout(30000),
                },
              );
              if (!result.ok) throw new Error('Preview request rejected: ' + (await result.text()));
              const op = (await result.json()) as { id: string };
              ctx.output('operationId', op.id);
            },
          }),
        );
      },
    });
  },
});
const backend = createBackend();
backend.add(import('@backstage/plugin-auth-backend'));
backend.add(import('@backstage/plugin-auth-backend-module-oidc-provider'));
if (process.env.DOGFOOD_LOCAL_DEVELOPMENT === '1')
  backend.add(import('@backstage/plugin-auth-backend-module-guest-provider'));
backend.add(import('@backstage/plugin-catalog-backend'));
backend.add(import('@backstage/plugin-scaffolder-backend'));
backend.add(scaffoldModule);
backend.add(platformPlugin);
backend.start();
