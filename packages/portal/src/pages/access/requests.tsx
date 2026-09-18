import React, { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { AccessRequest, stateTone, useAccess } from '../../access-api';
import { dateTime, useAction, usePlatform } from '../../api';
import { Alert, Dialog, Empty, Loading, Status } from '../../ui';
import { Command, useMe } from './index';

export function Requests() {
  const [params, setParams] = useSearchParams();
  const state = params.get('state') ?? '';
  const list = useAccess<{ requests: AccessRequest[] }>(
    `/access/requests${state ? `?state=${state}` : ''}`,
    5000,
  );
  const requests = [...(list.data?.requests ?? [])].sort((a, b) =>
    b.created.localeCompare(a.created),
  );
  return (
    <section className="panel">
      <div className="list-toolbar">
        <label className="inline-label">
          State
          <select
            value={state}
            onChange={(e) => {
              const next = new URLSearchParams(params);
              if (e.target.value) next.set('state', e.target.value);
              else next.delete('state');
              setParams(next, { replace: true });
            }}
          >
            <option value="">All states</option>
            {['pending', 'approved', 'denied'].map((s) => (
              <option key={s} value={s}>
                {s[0].toUpperCase() + s.slice(1)}
              </option>
            ))}
          </select>
        </label>
        <span className="muted result-count">{requests.length} requests</span>
      </div>
      <Alert error={list.error} />
      {list.loading && !list.data ? (
        <Loading />
      ) : requests.length ? (
        <RequestTable requests={requests} />
      ) : (
        <Empty
          title="No requests yet"
          action={
            <Link className="button primary" to="/access/request">
              Request access
            </Link>
          }
        >
          Requests you make appear here with their decision and expiry.
        </Empty>
      )}
    </section>
  );
}

export function RequestTable({
  requests,
  showUser = false,
}: {
  requests: AccessRequest[];
  showUser?: boolean;
}) {
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Request</th>
            {showUser && <th>Requester</th>}
            <th>State</th>
            <th>Requested</th>
            <th>Expires</th>
          </tr>
        </thead>
        <tbody>
          {requests.map((r) => (
            <tr key={r.id}>
              <td>
                <Link className="entity-title" to={`/access/requests/${r.id}`}>
                  {r.roles.join(', ')}
                </Link>
                <small>
                  <code>{r.id.slice(0, 8)}</code> ·{' '}
                  {r.reason.length > 60 ? r.reason.slice(0, 60) + '…' : r.reason}
                </small>
              </td>
              {showUser && <td data-label="Requester">{r.user}</td>}
              <td data-label="State">
                <Status value={stateTone(r.state)} />
              </td>
              <td data-label="Requested">{dateTime(r.created)}</td>
              <td data-label="Expires">{dateTime(r.expires)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function RequestDetail() {
  const { id = '' } = useParams();
  const { me } = useMe();
  const req = useAccess<AccessRequest>(`/access/requests/${id}`, 5000);
  if (req.loading && !req.data) return <Loading />;
  if (!req.data)
    return (
      <Empty
        title="Request not found"
        action={
          <Link className="button" to="/access/requests">
            Back to my requests
          </Link>
        }
      >
        {req.error || 'This request may have expired, or you may not have access to it.'}
      </Empty>
    );
  const r = req.data;
  const canDecide = me?.is_approver && r.state === 'PENDING' && r.user !== me.user;
  return (
    <>
      <Link
        className="back-link"
        to={r.user === me?.user ? '/access/requests' : '/access/approvals'}
      >
        ‹ {r.user === me?.user ? 'My requests' : 'Approvals'}
      </Link>
      <div className="detail-grid">
        <section className="panel padded">
          <h2>
            {r.roles.join(', ')} <Status value={stateTone(r.state)} />
          </h2>
          <dl className="metadata">
            <dt>Request</dt>
            <dd>
              <code>{r.id}</code>
            </dd>
            <dt>Requester</dt>
            <dd>{r.user}</dd>
            <dt>Reason</dt>
            <dd>{r.reason}</dd>
            {r.resource_ids?.length ? (
              <>
                <dt>Resources</dt>
                <dd>{r.resource_ids.join(', ')}</dd>
              </>
            ) : null}
            <dt>Requested</dt>
            <dd>{dateTime(r.created)}</dd>
            <dt>Expires</dt>
            <dd>{dateTime(r.expires)}</dd>
            {r.resolve_reason && (
              <>
                <dt>Decision</dt>
                <dd>{r.resolve_reason}</dd>
              </>
            )}
            {r.annotations && Object.keys(r.annotations).length > 0 && (
              <>
                <dt>Decided via</dt>
                <dd>
                  {(r.annotations['access-broker/mode'] ?? []).join(', ') || '—'}
                  {r.annotations['access-broker/approver'] &&
                    ` by ${r.annotations['access-broker/approver'].join(', ')}`}
                  {r.annotations['access-broker/rule'] &&
                    ` · rule ${r.annotations['access-broker/rule'].join(', ')}`}
                </dd>
              </>
            )}
          </dl>
          {r.tsh_login_command && (
            <>
              <h3>Use it</h3>
              <Command text={r.tsh_login_command} label="tsh login" />
            </>
          )}
          {r.reviews_detail?.length ? (
            <>
              <h3>Reviews</h3>
              <ul className="review-list">
                {r.reviews_detail.map((rev, i) => (
                  <li key={i}>
                    <Status value={stateTone(rev.state)} /> {rev.author}
                    {rev.reason && ` — ${rev.reason}`}
                    <small>{dateTime(rev.created)}</small>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          <details>
            <summary>Request evidence</summary>
            <pre>{JSON.stringify(r, null, 2)}</pre>
          </details>
        </section>
        {canDecide && (
          <section className="panel padded">
            <h2>Decide</h2>
            <p className="muted">
              The access broker verifies your approver role and records the decision in Teleport.
            </p>
            <DecisionControls
              request={r}
              onDone={() => {
                void req.reload();
                setTimeout(() => void req.reload(), 2000);
              }}
            />
          </section>
        )}
      </div>
    </>
  );
}

export function DecisionControls({
  request,
  onDone,
}: {
  request: AccessRequest;
  onDone: (message: string) => void;
}) {
  const { client } = usePlatform();
  const action = useAction();
  const [verb, setVerb] = useState<'approve' | 'deny'>();
  const [reason, setReason] = useState('');
  const decide = () =>
    void action.run(async () => {
      await client(`/access/requests/${request.id}/${verb}`, 'POST', { reason: reason.trim() });
      const message = `Request ${verb === 'approve' ? 'approved' : 'denied'}.`;
      action.setNotice(message);
      setVerb(undefined);
      setReason('');
      onDone(message);
    });
  return (
    <>
      <Alert error={action.error} notice={action.notice} />
      <div className="form-actions">
        <button className="primary" onClick={() => setVerb('approve')} disabled={action.busy}>
          Approve
        </button>
        <button className="danger-outline" onClick={() => setVerb('deny')} disabled={action.busy}>
          Deny
        </button>
      </div>
      {verb && (
        <Dialog
          title={`${verb === 'approve' ? 'Approve' : 'Deny'} ${request.user}’s request for ${request.roles.join(', ')}?`}
          onClose={() => {
            if (!action.busy) setVerb(undefined);
          }}
        >
          <dl className="metadata">
            <dt>Reason given</dt>
            <dd>{request.reason}</dd>
            <dt>Access until</dt>
            <dd>{dateTime(request.expires)}</dd>
          </dl>
          <label>
            {verb === 'approve' ? 'Note (optional)' : 'Reason (required)'}
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={1024}
              rows={3}
              required={verb === 'deny'}
              placeholder={
                verb === 'approve' ? 'Recorded on the request' : 'Tell the requester why'
              }
            />
          </label>
          <Alert error={action.error} />
          <div className="form-actions">
            <button disabled={action.busy} onClick={() => setVerb(undefined)}>
              Cancel
            </button>
            <button
              className={verb === 'approve' ? 'primary' : 'danger'}
              disabled={action.busy || (verb === 'deny' && !reason.trim())}
              onClick={decide}
            >
              {action.busy
                ? 'Working…'
                : verb === 'approve'
                  ? 'Confirm approval'
                  : 'Confirm denial'}
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}
