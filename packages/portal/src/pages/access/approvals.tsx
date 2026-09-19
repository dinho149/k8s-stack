import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { AccessRequest, useAccess } from '../../access-api';
import { dateTime } from '../../api';
import { Alert, Empty, Loading } from '../../ui';
import { DecisionControls } from './requests';
import { useMe } from './index';

export function Approvals() {
  const { me } = useMe();
  const queue = useAccess<{ requests: AccessRequest[] }>('/access/approvals', 5000);
  const [open, setOpen] = useState<string>();
  const [notice, setNotice] = useState('');
  if (me && !me.is_approver)
    return (
      <Empty title="Approvals are for approvers">
        You do not hold an approver role. Requests you make yourself are under My requests.
      </Empty>
    );
  if (queue.status === 403)
    return (
      <Empty title="Approvals are for approvers">
        Your account cannot review other people’s requests.
      </Empty>
    );
  if (queue.status === 501)
    return (
      <Empty title="Approvals are handled in Teleport">
        This cluster decides requests natively; use the Teleport web UI or chat.
      </Empty>
    );
  const requests = [...(queue.data?.requests ?? [])].sort((a, b) =>
    a.created.localeCompare(b.created),
  );
  return (
    <section className="panel">
      <div className="list-toolbar">
        <h2>Waiting for a decision</h2>
        <span className="muted result-count">{requests.length} pending</span>
      </div>
      <Alert error={queue.error} notice={notice} />
      {queue.loading && !queue.data ? (
        <Loading />
      ) : requests.length ? (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Requester</th>
                <th>Roles</th>
                <th>Reason</th>
                <th>Requested</th>
                <th>Access until</th>
                <th>
                  <span className="sr-only">Decide</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {requests.map((r) => (
                <React.Fragment key={r.id}>
                  <tr>
                    <td data-label="Requester">{r.user}</td>
                    <td data-label="Roles">
                      <Link className="entity-title" to={`/access/requests/${r.id}`}>
                        {r.roles.join(', ')}
                      </Link>
                      <small>
                        <code>{r.id.slice(0, 8)}</code>
                      </small>
                    </td>
                    <td data-label="Reason">{r.reason}</td>
                    <td data-label="Requested">{dateTime(r.created)}</td>
                    <td data-label="Access until">{dateTime(r.expires)}</td>
                    <td>
                      <button
                        onClick={() => setOpen(open === r.id ? undefined : r.id)}
                        aria-expanded={open === r.id}
                      >
                        {open === r.id ? 'Close' : 'Decide'}
                      </button>
                    </td>
                  </tr>
                  {open === r.id && (
                    <tr>
                      <td colSpan={6}>
                        <DecisionControls
                          request={r}
                          onDone={(message) => {
                            setNotice(message);
                            setOpen(undefined);
                            // Teleport's read cache can lag the write by a moment: reload now and once more shortly after.
                            void queue.reload();
                            setTimeout(() => void queue.reload(), 2000);
                          }}
                        />
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty title="Nothing to approve">
          Production requests from your team land here, and you get to say yes.
        </Empty>
      )}
    </section>
  );
}
