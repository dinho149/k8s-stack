import React, { useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  Environment,
  Operation,
  usePlatform,
  useAction,
  duration,
  dateTime,
  safeUrl,
} from '../api';
import {
  Alert,
  DeploymentFields,
  Dialog,
  Empty,
  Heading,
  Icon,
  Loading,
  Status,
  Timeline,
} from '../ui';

export function EnvironmentList() {
  const { environments, operations, loading, error } = usePlatform();
  const [params, setParams] = useSearchParams();
  const query = params.get('q') ?? '',
    status = params.get('status') ?? 'all';
  const filtered = environments.filter(
    (e) =>
      (status === 'all' ||
        (status === 'attention'
          ? ['failed', 'deleting'].includes(e.status)
          : e.status === status)) &&
      `${e.id} ${e.owner} ${e.provider} ${e.revision}`.toLowerCase().includes(query.toLowerCase()),
  );
  const filter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value && value !== 'all') next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };
  return (
    <>
      <Heading
        title="Environments"
        description="A workspace for every branch. A clear view of every deployment."
        action={
          <Link className="button primary" to="/environments/new">
            <Icon name="plus" />
            Create preview
          </Link>
        }
      />
      <div className="panel">
        <div className="list-toolbar">
          <label className="search">
            <Icon name="search" />
            <input
              aria-label="Search environments"
              value={query}
              onChange={(e) => filter('q', e.target.value)}
              placeholder="Search name, owner or revision"
            />
          </label>
          <label className="inline-label">
            Status
            <select value={status} onChange={(e) => filter('status', e.target.value)}>
              <option value="all">All statuses</option>
              <option value="attention">Needs attention</option>
              {['pending', 'ready', 'failed', 'deleting', 'deleted'].map((s) => (
                <option key={s} value={s}>
                  {s[0].toUpperCase() + s.slice(1)}
                </option>
              ))}
            </select>
          </label>
          <span className="muted result-count">{filtered.length} environments</span>
        </div>
        {loading ? (
          <Loading />
        ) : filtered.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Environment</th>
                  <th>Status</th>
                  <th>Launch time</th>
                  <th>Expires</th>
                  <th>
                    <span className="sr-only">Open application</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((env) => {
                  const op = operations.find((o) => o.id === env.operationId);
                  return (
                    <tr key={env.id}>
                      <td>
                        <div className="entity">
                          <span className="entity-icon">
                            <Icon name="layers" />
                          </span>
                          <div>
                            <Link className="entity-title" to={`/environments/${env.id}`}>
                              {env.id}
                            </Link>
                            <small>
                              {env.provider} / {env.profile} · {env.owner}
                            </small>
                          </div>
                        </div>
                      </td>
                      <td data-label="Status">
                        <Status value={env.status} />
                        <small>{op?.phase}</small>
                      </td>
                      <td data-label="Launch time">
                        <span className="metric-inline">
                          {duration(op?.startedAt, op?.timings['application-ready'])}
                        </span>
                        <small>
                          {op ? (op.warm ? 'Warm launch' : 'Cold launch') : 'No operation yet'}
                        </small>
                      </td>
                      <td data-label="Expires">
                        {env.expiresAt ? dateTime(env.expiresAt) : 'Persistent'}
                      </td>
                      <td>
                        {env.status === 'ready' && safeUrl(env.url) && (
                          <a
                            className="icon-link"
                            href={safeUrl(env.url)}
                            target="_blank"
                            rel="noreferrer"
                            aria-label={`Open ${env.id}`}
                          >
                            <Icon name="external" />
                          </a>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          !error && (
            <Empty
              title={
                environments.length ? 'No matching environments' : 'Your next idea starts here'
              }
              action={
                environments.length ? (
                  <button onClick={() => setParams({})}>Clear filters</button>
                ) : (
                  <Link className="button primary" to="/environments/new">
                    Create your first preview
                  </Link>
                )
              }
            >
              {environments.length
                ? 'Try a different name or status.'
                : 'Create an isolated preview to see your changes running before they ship.'}
            </Empty>
          )
        )}
      </div>
    </>
  );
}
export function CreateEnvironment() {
  const { client, refresh } = usePlatform();
  const navigate = useNavigate();
  const action = useAction();
  const [name, setName] = useState(''),
    [image, setImage] = useState(''),
    [revision, setRevision] = useState(''),
    [review, setReview] = useState(false);
  const attempt = useRef({ payload: '', key: '' });
  const submit = () =>
    void action.run(async () => {
      const body = { id: name, image, revision, profile: 'preview', warm: true };
      const payload = JSON.stringify(body);
      if (attempt.current.payload !== payload)
        attempt.current = { payload, key: crypto.randomUUID() };
      await client<Operation>('/environments', 'POST', body, attempt.current.key);
      await refresh();
      navigate(`/environments/${name}`);
    });
  return (
    <>
      <Link className="back-link" to="/environments">
        ‹ Environments
      </Link>
      <Heading title="Create a preview" description="Give your change a space of its own." />
      <div className="form-layout">
        <section className="panel form-panel">
          <div className="step-label">
            <span className={!review ? 'selected' : ''}>1. Preview details</span>
            <span className={review ? 'selected' : ''}>2. Review & create</span>
          </div>
          <Alert error={action.error} />
          {!review ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                setReview(true);
              }}
            >
              <label>
                Environment name
                <input
                  autoFocus
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="pr-42"
                  pattern="[a-z][a-z0-9\-]{0,39}"
                  maxLength={40}
                />
                <small>
                  Start with a lowercase letter. Use up to 40 letters, numbers or hyphens.
                </small>
              </label>
              <DeploymentFields {...{ image, revision, setImage, setRevision }} />
              <div className="form-actions">
                <Link className="button" to="/environments">
                  Cancel
                </Link>
                <button className="primary">
                  Review preview
                  <Icon name="arrow" size={17} />
                </button>
              </div>
            </form>
          ) : (
            <>
              <h2>Ready to create {name}?</h2>
              <dl className="metadata">
                <dt>Name</dt>
                <dd>{name}</dd>
                <dt>Image digest</dt>
                <dd>
                  <code>{image}</code>
                </dd>
                <dt>Revision</dt>
                <dd>
                  <code>{revision}</code>
                </dd>
                <dt>Profile</dt>
                <dd>Preview · warm startup requested</dd>
              </dl>
              <div className="form-actions">
                <button disabled={action.busy} onClick={() => setReview(false)}>
                  Edit details
                </button>
                <button className="primary" disabled={action.busy} onClick={submit}>
                  {action.busy ? 'Creating…' : 'Create preview'}
                </button>
              </div>
            </>
          )}
        </section>
        <aside className="form-aside">
          <Icon name="layers" size={30} />
          <h2>
            Small change.
            <br />
            Real environment.
          </h2>
          <p>Each preview gets an isolated workspace with its own application URL.</p>
          <div className="aside-note">
            <Icon name="clock" />
            <p>
              Previews expire automatically. You can extend their lifetime from the environment
              page.
            </p>
          </div>
          <div className="aside-note">
            <Icon name="shield" />
            <p>Your platform’s ownership and lifecycle policies apply.</p>
          </div>
        </aside>
      </div>
    </>
  );
}
export function EnvironmentDetail() {
  const { id } = useParams();
  const { environments, operations, loading, error, client, refresh } = usePlatform();
  const env = environments.find((e) => e.id === id);
  const op = operations.find((o) => o.id === env?.operationId);
  const action = useAction();
  const deletion = useAction();
  const [confirmation, setConfirmation] = useState<{ id: string; generation: number }>();
  const [showDelete, setShowDelete] = useState(false);
  const mutate = (path: string, body: unknown, message: string) =>
    void action.run(async () => {
      await client(`/environments/${id}/${path}`, 'POST', body);
      await refresh();
      action.setNotice(message);
    });
  if (loading) return <Loading />;
  if (!env)
    return (
      <Empty
        title={error ? 'Environment unavailable' : 'Environment not found'}
        action={
          <Link className="button" to="/environments">
            Back to environments
          </Link>
        }
      >
        {error
          ? 'Restore the connection and try again.'
          : 'This environment may have been removed, or you may not have access.'}
      </Empty>
    );
  return (
    <>
      <Link className="back-link" to="/environments">
        ‹ Environments
      </Link>
      <Heading
        title={env.id}
        description={`${env.provider} / ${env.profile} · Owned by ${env.owner}`}
        action={
          env.status === 'ready' && safeUrl(env.url) ? (
            <a className="button primary" href={safeUrl(env.url)} target="_blank" rel="noreferrer">
              Open application
              <Icon name="external" size={17} />
            </a>
          ) : undefined
        }
      />
      <Alert error={action.error} notice={action.notice} />
      <section className="panel lifecycle">
        <div className="panel-heading">
          <div>
            <h2>Deployment progress</h2>
            <p>
              {op
                ? `${op.warm ? 'Warm' : 'Cold'} launch · Requested ${dateTime(op.requestedAt)}`
                : 'Waiting for operation data'}
            </p>
          </div>
          <Status value={env.status} />
        </div>
        <Timeline operation={op} />
        {op?.error && <Alert error={op.error} />}
        <div className="lifecycle-summary">
          <span>
            Cluster launch <strong>{duration(op?.startedAt, op?.timings['cluster-ready'])}</strong>
          </span>
          <span>
            Application launch{' '}
            <strong>{duration(op?.startedAt, op?.timings['application-ready'])}</strong>
          </span>
          <span>
            Expires <strong>{env.expiresAt ? dateTime(env.expiresAt) : 'Persistent'}</strong>
          </span>
        </div>
      </section>
      <div className="detail-grid">
        <section className="panel padded">
          <h2>Deployment details</h2>
          <dl className="metadata">
            <dt>Git revision</dt>
            <dd>
              <code>{env.revision}</code>
            </dd>
            <dt>Image digest</dt>
            <dd>
              <code>{env.image}</code>
            </dd>
            <dt>Owner</dt>
            <dd>{env.owner}</dd>
            <dt>Generation</dt>
            <dd>{env.generation}</dd>
            <dt>Operation</dt>
            <dd>
              <code>{env.operationId || '—'}</code>
            </dd>
          </dl>
          <details>
            <summary>Operation evidence</summary>
            <pre>{JSON.stringify(op ?? {}, null, 2)}</pre>
          </details>
        </section>
        <section className="panel padded">
          <h2>Manage environment</h2>
          <div className="management-action">
            <div>
              <strong>Need a little longer?</strong>
              <p>Add five minutes to this preview.</p>
            </div>
            <button
              disabled={
                action.busy || ['deleted', 'deleting'].includes(env.status) || !env.expiresAt
              }
              onClick={() =>
                mutate(
                  'extend',
                  { mode: 'add', minutes: 5, generation: env.generation },
                  'Preview expiry extended by five minutes.',
                )
              }
            >
              Extend expiry
            </button>
          </div>
          <div className="management-action">
            <div>
              <strong>Run this deployment again</strong>
              <p>Retry the current image and revision.</p>
            </div>
            <button
              disabled={action.busy || ['deleted', 'deleting'].includes(env.status)}
              onClick={() =>
                mutate(
                  'redeploy',
                  { revision: env.revision, image: env.image, generation: env.generation },
                  'Deployment retry requested.',
                )
              }
            >
              Retry deployment
            </button>
          </div>
          <div className="management-action">
            <div>
              <strong>Remove this preview</strong>
              <p>Delete the environment and its synthetic data.</p>
            </div>
            <button
              className="danger-outline"
              disabled={action.busy || ['deleted', 'deleting'].includes(env.status)}
              onClick={() => {
                setConfirmation(undefined);
                setShowDelete(true);
              }}
            >
              Delete preview
            </button>
          </div>
        </section>
      </div>
      {showDelete && (
        <Dialog
          title={`Delete ${env.id}?`}
          onClose={() => {
            if (!deletion.busy) {
              setShowDelete(false);
              setConfirmation(undefined);
            }
          }}
        >
          <p>
            This removes the preview and its synthetic data. Request a confirmation, then confirm
            deletion within five minutes.
          </p>
          <Alert error={deletion.error} />
          {confirmation && confirmation.generation !== env.generation && (
            <Alert error="This environment changed. Request a new confirmation before deleting." />
          )}
          <div className="form-actions">
            <button
              disabled={deletion.busy}
              onClick={() => {
                setShowDelete(false);
                setConfirmation(undefined);
              }}
            >
              Cancel
            </button>
            <button
              className="danger"
              disabled={deletion.busy}
              onClick={() =>
                void deletion.run(async () => {
                  if (!confirmation || confirmation.generation !== env.generation) {
                    const result = await client<{ id: string }>(
                      `/environments/${env.id}/confirm-delete`,
                      'POST',
                      {},
                    );
                    setConfirmation({ id: result.id, generation: env.generation });
                  } else {
                    try {
                      await client(`/environments/${env.id}/destroy`, 'POST', {
                        confirmation: confirmation.id,
                      });
                    } catch (e) {
                      setConfirmation(undefined);
                      throw e;
                    }
                    setShowDelete(false);
                    setConfirmation(undefined);
                    await refresh();
                    action.setNotice(
                      'Preview deletion requested. Cleanup progress will appear here.',
                    );
                  }
                })
              }
            >
              {deletion.busy
                ? 'Working…'
                : confirmation && confirmation.generation === env.generation
                  ? 'Confirm deletion'
                  : 'Request deletion confirmation'}
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}
