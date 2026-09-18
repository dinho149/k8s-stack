import React, { createContext, useContext, useState } from 'react';
import { Link, NavLink, Route, Routes } from 'react-router-dom';
import { Whoami, useAccess } from '../../access-api';
import { Alert, Empty, Heading, Icon, Loading } from '../../ui';
import { MyAccess } from './my-access';
import { RoleDetail, Roles } from './roles';
import { RequestAccess } from './request';
import { RequestDetail, Requests } from './requests';
import { Approvals } from './approvals';

const MeContext = createContext<{ me?: Whoami; reload: () => Promise<void> }>({
  reload: async () => {},
});
export const useMe = () => useContext(MeContext);

export function Command({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="command">
      <code aria-label={label ?? 'Command'}>{text}</code>
      <button
        className="icon-button"
        aria-label={`Copy ${label ?? 'command'}`}
        onClick={() => {
          void navigator.clipboard?.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          });
        }}
      >
        <Icon name={copied ? 'check' : 'copy'} size={16} />
      </button>
    </div>
  );
}

export function AccessLayout() {
  const me = useAccess<Whoami>('/access/me', 15000);
  const tabs = [
    { to: '', label: 'My access' },
    { to: 'roles', label: 'Roles' },
    { to: 'request', label: 'Request' },
    { to: 'requests', label: 'My requests' },
    ...(me.data?.is_approver ? [{ to: 'approvals', label: 'Approvals' }] : []),
  ];
  const unavailable = me.status === 503 || me.status === 403;
  return (
    <MeContext.Provider value={{ me: me.data, reload: me.reload }}>
      <Heading
        title="Access"
        description="Zero standing access. Elevate when you need it, for as long as you need it."
        action={
          me.data && (
            <Link className="button primary" to="/access/request">
              <Icon name="plus" />
              Request access
            </Link>
          )
        }
      />
      {me.loading && !me.data ? (
        <Loading />
      ) : unavailable ? (
        <Empty
          title={me.status === 503 ? 'Teleport access is not set up here' : 'No Teleport identity'}
        >
          {me.status === 503
            ? 'The access portal API is not configured for this workspace. Run make teleport-up and make teleport-portal-forward, then restart the backend.'
            : 'Your account is not mapped to a Teleport user. Ask a platform administrator to add the mapping.'}
        </Empty>
      ) : (
        <>
          {me.error && !me.data && <Alert error={me.error} />}
          <nav className="subnav" aria-label="Access sections">
            {tabs.map((t) => (
              <NavLink key={t.to} to={t.to} end={t.to === ''}>
                {t.label}
              </NavLink>
            ))}
          </nav>
          <Routes>
            <Route index element={<MyAccess />} />
            <Route path="roles" element={<Roles />} />
            <Route path="roles/:name" element={<RoleDetail />} />
            <Route path="request" element={<RequestAccess />} />
            <Route path="requests" element={<Requests />} />
            <Route path="requests/:id" element={<RequestDetail />} />
            <Route path="approvals" element={<Approvals />} />
            <Route
              path="*"
              element={
                <Empty
                  title="This access page isn’t here"
                  action={
                    <Link className="button primary" to="/access">
                      Back to my access
                    </Link>
                  }
                >
                  Check the address, or head back to your access overview.
                </Empty>
              }
            />
          </Routes>
        </>
      )}
    </MeContext.Provider>
  );
}
