import React from 'react';
import { createRoot } from 'react-dom/client';
import { Route } from 'react-router-dom';
import { createApp } from '@backstage/app-defaults';
import { FlatRoutes, OAuth2 } from '@backstage/core-app-api';
import { DogfoodSignIn, oidcAuthApiRef } from './auth';
import {
  createApiFactory,
  discoveryApiRef,
  oauthRequestApiRef,
  configApiRef,
} from '@backstage/core-plugin-api';
import { PlatformPage } from './platform';
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/nunito-sans/latin-700.css';
import '@fontsource/nunito-sans/latin-900.css';
import './style.css';

const local = import.meta.env.VITE_LOCAL_DEVELOPMENT === 'true';
const app = createApp({
  apis: [
    createApiFactory({
      api: oidcAuthApiRef,
      deps: {
        discoveryApi: discoveryApiRef,
        oauthRequestApi: oauthRequestApiRef,
        configApi: configApiRef,
      },
      factory: ({ discoveryApi, oauthRequestApi, configApi }) =>
        OAuth2.create({
          discoveryApi,
          oauthRequestApi,
          configApi,
          provider: { id: 'oidc', title: 'Platform account', icon: () => null },
          defaultScopes: ['openid', 'profile', 'email'],
        }),
    }),
  ],
  configLoader: async () => [
    {
      context: 'platform',
      data: {
        app: { title: 'Dogfood', baseUrl: window.location.origin },
        backend: { baseUrl: import.meta.env.VITE_BACKEND_URL ?? 'http://localhost:7007' },
        auth: { environment: 'development', providers: local ? { guest: {} } : { oidc: {} } },
      },
    },
  ],
  components: {
    SignInPage: (props) => <DogfoodSignIn {...props} local={local} />,
  },
});
const Router = app.getRouter();
const root = app.createRoot(
  <Router>
    <FlatRoutes>
      <Route path="/*" element={<PlatformPage />} />
    </FlatRoutes>
  </Router>,
);
createRoot(document.getElementById('root')!).render(React.createElement(root));
