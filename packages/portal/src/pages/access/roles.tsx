import React from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import {
  ApproverInfo,
  RequestableRole,
  RoleSummary,
  grantsOf,
  predictionLabel,
  predictionTone,
  useAccess,
} from '../../access-api';
import { Alert, Empty, Icon, Loading, Status } from '../../ui';

type RequestableList = { requestable_roles: RequestableRole[] };

export function Roles() {
  const [params, setParams] = useSearchParams();
  const query = params.get('q') ?? '',
    only = params.get('requestable') === '1';
  const roles = useAccess<{ roles: RoleSummary[] }>('/access/roles');
  const requestable = useAccess<RequestableList>('/access/requestable-roles');
  const byName = new Map((requestable.data?.requestable_roles ?? []).map((r) => [r.role, r]));
  const list = (roles.data?.roles ?? []).filter(
    (r) =>
      (!only || byName.has(r.name)) &&
      `${r.name} ${r.description ?? ''}`.toLowerCase().includes(query.toLowerCase()),
  );
  const filter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };
  return (
    <section className="panel">
      <div className="list-toolbar">
        <label className="search">
          <Icon name="search" />
          <input
            aria-label="Search roles"
            value={query}
            onChange={(e) => filter('q', e.target.value)}
            placeholder="Search roles"
          />
        </label>
        <label className="inline-label">
          <input
            type="checkbox"
            checked={only}
            onChange={(e) => filter('requestable', e.target.checked ? '1' : '')}
          />{' '}
          Requestable only
        </label>
        <span className="muted result-count">{list.length} roles</span>
      </div>
      <Alert error={roles.error || requestable.error} />
      {roles.loading && !roles.data ? (
        <Loading />
      ) : list.length ? (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Role</th>
                <th>Grants</th>
                <th>Decision</th>
                <th>Time box</th>
                <th>
                  <span className="sr-only">Request</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.map((r) => {
                const rr = byName.get(r.name);
                return (
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
                        {grantsOf(r).map((g) => (
                          <span className="chip" key={g}>
                            {g}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td data-label="Decision">
                      <Status value={predictionTone(rr?.prediction)} />
                      <small>{predictionLabel(rr?.prediction)}</small>
                    </td>
                    <td data-label="Time box">{rr?.ttl_cap ?? r.max_session_ttl ?? '—'}</td>
                    <td>
                      {rr && (
                        <Link
                          className="button"
                          to={`/access/request?roles=${encodeURIComponent(r.name)}`}
                        >
                          Request
                        </Link>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty
          title="No matching roles"
          action={<button onClick={() => setParams({})}>Clear filters</button>}
        >
          Try a different name, or include roles you cannot request.
        </Empty>
      )}
    </section>
  );
}

export function RoleDetail() {
  const { name = '' } = useParams();
  const role = useAccess<{
    role: RoleSummary;
    deny: Record<string, unknown>;
    requestable: boolean;
    prediction?: RequestableRole;
  }>(`/access/roles/${encodeURIComponent(name)}`);
  const approvers = useAccess<ApproverInfo>(`/access/approvers?role=${encodeURIComponent(name)}`);
  if (role.loading && !role.data) return <Loading />;
  if (!role.data)
    return (
      <Empty
        title="Role not found"
        action={
          <Link className="button" to="/access/roles">
            Back to roles
          </Link>
        }
      >
        {role.error || 'This role does not exist or is internal.'}
      </Empty>
    );
  const r = role.data.role;
  const labels = (l?: Record<string, string[]>) =>
    l
      ? Object.entries(l)
          .map(([k, v]) => `${k}: ${v.join(', ')}`)
          .join(' · ')
      : '—';
  return (
    <>
      <Link className="back-link" to="/access/roles">
        ‹ Roles
      </Link>
      <div className="detail-grid">
        <section className="panel padded">
          <h2>{r.name}</h2>
          <p className="muted">{r.description}</p>
          <dl className="metadata">
            <dt>Decision</dt>
            <dd>
              <Status value={predictionTone(role.data.prediction?.prediction)} />{' '}
              {predictionLabel(role.data.prediction?.prediction)}
              {role.data.prediction?.rule && (
                <small> · policy rule {role.data.prediction.rule}</small>
              )}
            </dd>
            <dt>Time box</dt>
            <dd>{role.data.prediction?.ttl_cap ?? r.max_session_ttl ?? '—'}</dd>
            <dt>Servers</dt>
            <dd>{labels(r.node_labels)}</dd>
            <dt>Databases</dt>
            <dd>{labels(r.db_labels)}</dd>
            <dt>Kubernetes</dt>
            <dd>{labels(r.kubernetes_labels)}</dd>
            <dt>Apps</dt>
            <dd>{labels(r.app_labels)}</dd>
            <dt>Logins</dt>
            <dd>{r.logins?.join(', ') || '—'}</dd>
            <dt>Database users</dt>
            <dd>
              {[...(r.db_users ?? []), ...(r.db_names ?? []).map((n) => `db ${n}`)].join(', ') ||
                '—'}
            </dd>
            <dt>Kubernetes groups</dt>
            <dd>{r.kubernetes_groups?.join(', ') || '—'}</dd>
            <dt>Rules</dt>
            <dd>{r.rules?.join('; ') || '—'}</dd>
            {Object.keys(role.data.deny ?? {}).length > 0 && (
              <>
                <dt>Deny</dt>
                <dd>
                  <code>{JSON.stringify(role.data.deny)}</code>
                </dd>
              </>
            )}
          </dl>
          {role.data.requestable && (
            <Link
              className="button primary"
              to={`/access/request?roles=${encodeURIComponent(r.name)}`}
            >
              Request this role
            </Link>
          )}
        </section>
        <section className="panel padded">
          <h2>Approval</h2>
          <Alert error={approvers.error} />
          {approvers.data ? (
            <dl className="metadata">
              <dt>Policy</dt>
              <dd>
                {approvers.data.policy_action || 'unknown'}
                {approvers.data.policy_rule && ` (${approvers.data.policy_rule})`}
              </dd>
              <dt>Approver roles</dt>
              <dd>{approvers.data.approver_roles?.join(', ') || '—'}</dd>
              <dt>Approvers</dt>
              <dd>{approvers.data.approvers?.join(', ') || 'nobody holds an approver role yet'}</dd>
              <dt>How</dt>
              <dd>Approvers decide from the Approvals tab, chat, or tctl.</dd>
            </dl>
          ) : (
            !approvers.error && <Loading />
          )}
        </section>
      </div>
    </>
  );
}
