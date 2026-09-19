import React from 'react';
import { Link } from 'react-router-dom';
import { AccessRequest, expiresIn, grantsOf, tshLogin, useAccess } from '../../access-api';
import { dateTime } from '../../api';
import { Icon, Loading, Status } from '../../ui';
import { Command, useMe } from './index';

export function MyAccess() {
  const { me } = useMe();
  const approved = useAccess<{ requests: AccessRequest[] }>(
    '/access/requests?state=approved',
    15000,
  );
  if (!me) return <Loading />;
  const grants = Object.entries(me.active_elevated_roles).sort(([a], [b]) => a.localeCompare(b));
  const live = (approved.data?.requests ?? []).filter((r) => r.tsh_login_command);
  return (
    <>
      <section className="policy-banner">
        <span className="section-icon">
          <Icon name="key" size={28} />
        </span>
        <div>
          <h2>
            You are {me.user}
            {me.email ? ` · ${me.email}` : ''}
          </h2>
          <p>
            Standing roles: {me.roles.join(', ') || 'none'}. {me.note}
          </p>
        </div>
        <Status value={me.is_approver ? 'approver' : 'requester'} />
      </section>
      <h2 className="panel-heading">Active elevated access</h2>
      {grants.length ? (
        <div className="grant-list">
          {grants.map(([role, until]) => (
            <section className="panel grant-card" key={role}>
              <h2>{role}</h2>
              <p>
                Expires in {expiresIn(until)} · {dateTime(until)}
              </p>
              <Status value="active" />
            </section>
          ))}
        </div>
      ) : (
        <section className="panel padded">
          <h2>No elevated access right now</h2>
          <p className="muted">
            Everything you reach is time-boxed. Request a role when you need one.
          </p>
          <p>
            <Link className="button primary" to="/access/request">
              Request access
            </Link>
          </p>
        </section>
      )}
      {live.length > 0 && (
        <section className="panel padded">
          <h2>Using elevated access</h2>
          <p className="muted">
            A grant lives in your tsh session. Load it, then tsh ls, tsh db ls, tsh kube ls and tsh
            apps ls show what it opens.
          </p>
          {live.map((r) => (
            <div key={r.id}>
              <p className="muted">
                {r.roles.join(', ')} · until {dateTime(r.expires)}
              </p>
              <Command
                text={r.tsh_login_command ?? tshLogin(r.id)}
                label={`tsh login for ${r.roles.join(', ')}`}
              />
            </div>
          ))}
        </section>
      )}
      <section className="panel">
        <div className="list-toolbar">
          <h2>Effective access</h2>
          <span className="muted result-count">{me.effective_access.length} roles</span>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Role</th>
                <th>Grants</th>
                <th>Logins · users · groups</th>
                <th>Max session</th>
              </tr>
            </thead>
            <tbody>
              {me.effective_access.map((r) => (
                <tr key={r.name}>
                  <td>
                    <Link
                      className="entity-title"
                      to={`/access/roles/${encodeURIComponent(r.name)}`}
                    >
                      {r.name}
                    </Link>
                    <small>{r.description}</small>
                  </td>
                  <td data-label="Grants">
                    <div className="chips">
                      {grantsOf(r).length ? (
                        grantsOf(r).map((g) => (
                          <span className="chip" key={g}>
                            {g}
                          </span>
                        ))
                      ) : (
                        <span className="muted">no infrastructure access</span>
                      )}
                    </div>
                  </td>
                  <td data-label="Logins">
                    {[
                      ...(r.logins ?? []),
                      ...(r.db_users ?? []),
                      ...(r.kubernetes_groups ?? []),
                    ].join(', ') || '—'}
                  </td>
                  <td data-label="Max session">{r.max_session_ttl ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
