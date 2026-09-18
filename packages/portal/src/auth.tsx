import { Mascot, Wordmark } from './mascot';
import React, { useEffect, useState } from 'react';
import { ProxiedSignInPage, UserIdentity } from '@backstage/core-components';
import {
  createApiRef,
  useApi,
  type OAuthApi,
  type OpenIdConnectApi,
  type ProfileInfoApi,
  type BackstageIdentityApi,
  type SessionApi,
  type SignInPageProps,
} from '@backstage/core-plugin-api';
import { Alert, Credit, Icon } from './ui';
import { errorText } from './api';
export const oidcAuthApiRef = createApiRef<
  OAuthApi & OpenIdConnectApi & ProfileInfoApi & BackstageIdentityApi & SessionApi
>({ id: 'auth.oidc' });
export function SignInLayout({ children }: React.PropsWithChildren) {
  return (
    <div className="signin">
      <section className="signin-story">
        <a href="/" className="brand" aria-label="Dogfood home">
          <Mascot />
          <Wordmark />
        </a>
        <div>
          <div className="signin-mascot">
            <Mascot size={200} mood="greeting" />
          </div>
          <h1>
            Good work.
            <br />
            Great company.
          </h1>
          <p>
            Your environments, releases, and tools.
            <br />
            Your next idea, ready to run.
          </p>
        </div>
        <span className="signin-caption">From first preview to production.</span>
      </section>
      <section className="signin-access">
        <div className="signin-form">
          <span className="section-icon">
            <Icon name="grid" size={26} />
          </span>
          <h2>Welcome to Dogfood.</h2>
          <p>Sign in to create previews, ship releases, and keep building.</p>
          {children}
        </div>
        <Credit />
      </section>
    </div>
  );
}
function LocalError({ error }: { error?: Error }) {
  return (
    <>
      <Alert error={error?.message ?? 'Local sign-in could not connect.'} />
      <button className="primary" onClick={() => window.location.reload()}>
        Retry local sign-in
      </button>
    </>
  );
}
function OidcSignIn(props: SignInPageProps) {
  const auth = useApi(oidcAuthApiRef);
  const [busy, setBusy] = useState(true),
    [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    void auth
      .getBackstageIdentity({ optional: true })
      .then(async (result) => {
        if (result && alive)
          props.onSignInSuccess(
            UserIdentity.create({
              identity: result.identity,
              authApi: auth,
              profile: await auth.getProfile(),
            }),
          );
      })
      .catch((e) => {
        if (alive) setError(errorText(e));
      })
      .finally(() => {
        if (alive) setBusy(false);
      });
    return () => {
      alive = false;
    };
  }, [auth, props.onSignInSuccess]);
  return (
    <>
      <Alert error={error} />
      <button
        className="primary signin-button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError('');
          try {
            const result = await auth.getBackstageIdentity({ instantPopup: true });
            if (!result)
              throw new Error(
                'Your organization sign-in is not configured. Contact your platform administrator.',
              );
            props.onSignInSuccess(
              UserIdentity.create({
                identity: result.identity,
                authApi: auth,
                profile: await auth.getProfile(),
              }),
            );
          } catch (e) {
            setError(errorText(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? 'Connecting…' : 'Continue with your organization'}
        <Icon name="arrow" size={18} />
      </button>
      <small>Use your organization’s platform account.</small>
    </>
  );
}
export function DogfoodSignIn(props: SignInPageProps & { local: boolean }) {
  return (
    <SignInLayout>
      {props.local ? (
        <>
          <p>Connecting to your local development account.</p>
          <ProxiedSignInPage {...props} provider="guest" ErrorComponent={LocalError} />
        </>
      ) : (
        <OidcSignIn {...props} />
      )}
    </SignInLayout>
  );
}
