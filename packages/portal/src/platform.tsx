import React, { useEffect, useMemo, useState } from 'react';
import { Link, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { discoveryApiRef, fetchApiRef, identityApiRef, useApi } from '@backstage/core-plugin-api';
import { Client, PlatformProvider, createClient, useAction, usePlatform } from './api';
import { Alert, Brand, Credit, Dialog, Empty, Icon } from './ui';
import { Overview } from './pages/overview';
import { CreateEnvironment, EnvironmentDetail, EnvironmentList } from './pages/environments';
import { Assistant, Policies, Releases, Tools } from './pages/workflows';

const navigation = [
  { to: '/', label: 'Overview', icon: 'grid' },
  { to: '/environments', label: 'Environments', icon: 'layers' },
  { to: '/releases', label: 'Releases', icon: 'release' },
  { to: '/tools', label: 'Tools', icon: 'tools' },
  { to: '/policies', label: 'Policies', icon: 'shield' },
  { to: '/assistant', label: 'Assistant', icon: 'spark' },
];
export function Workspace({
  client,
  onSignOut,
  account = 'Platform account',
}: {
  client: Client;
  onSignOut?: () => Promise<void>;
  account?: string;
}) {
  return (
    <PlatformProvider client={client}>
      <Shell onSignOut={onSignOut} account={account} />
    </PlatformProvider>
  );
}
function Shell({ onSignOut, account }: { onSignOut?: () => Promise<void>; account: string }) {
  const location = useLocation();
  const { client, error, updated, refresh } = usePlatform();
  const action = useAction();
  const [menu, setMenu] = useState(false),
    [accountOpen, setAccountOpen] = useState(false),
    [linkCode, setLinkCode] = useState('');
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem('stack.theme') === 'dark' ? 'dark' : 'light';
    } catch {
      return 'light';
    }
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('stack.theme', theme);
    } catch {}
  }, [theme]);
  useEffect(() => {
    setMenu(false);
    const page =
      navigation.find((n) => n.to !== '/' && location.pathname.startsWith(n.to))?.label ??
      (location.pathname === '/' ? 'Overview' : 'Page not found');
    document.title = `${location.pathname === '/environments/new' ? 'Create preview' : page} · Stack`;
    window.scrollTo(0, 0);
  }, [location.pathname]);
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="masthead">
        <div className="masthead-inner">
          <Brand />
          <span className="brand-divider" />
          <span className="product-label">Developer workspace</span>
          <nav className={menu ? 'primary-nav open' : 'primary-nav'} aria-label="Main navigation">
            {navigation.map((n) => (
              <NavLink end={n.to === '/'} to={n.to} key={n.to}>
                <Icon name={n.icon} size={18} />
                {n.label}
              </NavLink>
            ))}
          </nav>
          <div className="masthead-actions">
            <button
              className="icon-button"
              onClick={() => setTheme((t) => (t === 'light' ? 'dark' : 'light'))}
              aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`}
            >
              <Icon name={theme === 'light' ? 'moon' : 'sun'} />
            </button>
            <button
              className="account-button"
              aria-label="Open account settings"
              onClick={() => setAccountOpen(true)}
            >
              <Icon name="user" size={18} />
            </button>
            <button
              className="icon-button mobile-menu"
              aria-label="Toggle navigation"
              aria-expanded={menu}
              onClick={() => setMenu((v) => !v)}
            >
              <Icon name={menu ? 'close' : 'menu'} />
            </button>
          </div>
        </div>
      </header>
      <div className="workspace-bar">
        <div>
          <span className="workspace-dot" />
          Stack workspace
        </div>
        <span>
          {error
            ? 'Connection interrupted'
            : updated
              ? `Updated ${updated.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
              : 'Connecting…'}
        </span>
      </div>
      <main id="main" tabIndex={-1}>
        {error && (
          <div className="connection-error">
            <Alert error={`${updated ? 'Showing previously loaded data. ' : ''}${error}`} />
            <button onClick={() => void refresh()}>Retry connection</button>
          </div>
        )}
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/environments" element={<EnvironmentList />} />
          <Route path="/environments/new" element={<CreateEnvironment />} />
          <Route path="/environments/:id" element={<EnvironmentDetail />} />
          <Route path="/releases" element={<Releases />} />
          <Route path="/tools" element={<Tools />} />
          <Route path="/policies" element={<Policies />} />
          <Route path="/assistant" element={<Assistant />} />
          <Route
            path="*"
            element={
              <Empty
                title="This page isn’t here"
                action={
                  <Link className="button primary" to="/">
                    Back to overview
                  </Link>
                }
              >
                Check the address, or head back to your workspace.
              </Empty>
            }
          />
        </Routes>
      </main>
      <footer className="app-footer">
        <span>Stack · Space to build.</span>
        <Credit />
      </footer>
      {accountOpen && (
        <Dialog
          title="Your account"
          onClose={() => {
            if (!action.busy) setAccountOpen(false);
          }}
        >
          <p className="account-name">{account}</p>
          <h3>Connect your chat account</h3>
          <p>Generate a one-time code to link your personal chat with the platform bot.</p>
          <Alert error={action.error} />
          {linkCode && (
            <div className="link-code" role="status">
              <code>/link {linkCode}</code>
              <p>Send this command in a personal chat with the bot within five minutes.</p>
            </div>
          )}
          <div className="form-actions">
            <button
              disabled={action.busy}
              onClick={() =>
                void action.run(async () => {
                  const result = await client<{ code: string }>('/link-code', 'POST', {});
                  setLinkCode(result.code);
                })
              }
            >
              {action.busy ? 'Working…' : 'Generate link code'}
            </button>
            {onSignOut && (
              <button
                onClick={() =>
                  void action.run(async () => {
                    try {
                      sessionStorage.removeItem('stack.conversation');
                    } catch {}
                    await onSignOut();
                  })
                }
                disabled={action.busy}
              >
                Sign out
              </button>
            )}
          </div>
        </Dialog>
      )}
    </div>
  );
}
export function PlatformPage() {
  const discovery = useApi(discoveryApiRef),
    fetchApi = useApi(fetchApiRef),
    identity = useApi(identityApiRef);
  const [account, setAccount] = useState('Platform account');
  useEffect(() => {
    void identity
      .getProfileInfo()
      .then((p) => setAccount(p.displayName || p.email || 'Platform account'))
      .catch(() => {});
  }, [identity]);
  const client = useMemo(
    () => createClient(() => discovery.getBaseUrl('platform'), fetchApi.fetch.bind(fetchApi)),
    [discovery, fetchApi],
  );
  return <Workspace client={client} account={account} onSignOut={() => identity.signOut()} />;
}
