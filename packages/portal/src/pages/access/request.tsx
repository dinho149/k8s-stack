import React, { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  CreateResult,
  RequestableRole,
  predictionLabel,
  predictionTone,
  useAccess,
} from '../../access-api';
import { useAction, usePlatform } from '../../api';
import { Alert, Icon, Loading, Status } from '../../ui';
import { Command } from './index';

const TTLS = ['30m', '1h', '2h', '4h'];
const minutes = (d: string) => {
  const m = /^(\d+)(m|h)$/.exec(d);
  return m ? Number(m[1]) * (m[2] === 'h' ? 60 : 1) : 0;
};
const capMinutes = (cap?: string) => {
  const m = /^(?:(\d+)h)?(?:(\d+)m)?/.exec(cap ?? '');
  return m && (m[1] || m[2]) ? Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0) : Infinity;
};

export function RequestAccess() {
  const { client } = usePlatform();
  const [params] = useSearchParams();
  const requestable = useAccess<{ requestable_roles: RequestableRole[]; require_reason: boolean }>(
    '/access/requestable-roles',
  );
  const [roles, setRoles] = useState<string[]>(() =>
    (params.get('roles') ?? '').split(',').filter(Boolean),
  );
  const [reason, setReason] = useState('');
  const [ttl, setTtl] = useState('2h');
  const [step, setStep] = useState<'form' | 'review' | 'done'>('form');
  const [preview, setPreview] = useState<CreateResult>();
  const [result, setResult] = useState<CreateResult>();
  const action = useAction();
  const attempt = useRef({ payload: '', key: '' });
  const options = requestable.data?.requestable_roles ?? [];
  const chosen = options.filter((o) => roles.includes(o.role));
  const cap = Math.min(...chosen.map((o) => capMinutes(o.ttl_cap)));
  const trimmed = reason.trim();
  const valid =
    roles.length > 0 && roles.length <= 20 && trimmed.length >= 8 && trimmed.length <= 512;
  useEffect(() => {
    if (step !== 'review') return;
    void action.run(async () => {
      setPreview(
        await client<CreateResult>('/access/requests/preview', 'POST', {
          roles,
          reason: trimmed,
          ttl,
        }),
      );
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);
  const submit = () =>
    void action.run(async () => {
      const body = { roles, reason: trimmed, ttl };
      const payload = JSON.stringify(body);
      if (attempt.current.payload !== payload)
        attempt.current = { payload, key: crypto.randomUUID() };
      setResult(await client<CreateResult>('/access/requests', 'POST', body, attempt.current.key));
      setStep('done');
    });
  if (step === 'done' && result?.request) {
    const r = result.request;
    return (
      <section className="panel form-panel">
        <div className="success-state">
          <Icon name="check" size={32} />
          <h2>
            {r.state === 'APPROVED'
              ? 'Access granted'
              : r.state === 'PENDING'
                ? 'Request submitted'
                : `Request ${r.state.toLowerCase()}`}
          </h2>
          <p>
            <Status value={r.state.toLowerCase()} /> {r.roles.join(', ')} · request{' '}
            <code>{r.id.slice(0, 8)}</code>
            {result.ttl_clamped_from &&
              ` · time box reduced from ${result.ttl_clamped_from} to ${result.ttl}`}
          </p>
          {r.tsh_login_command ? (
            <>
              <p>Load the grant into your tsh session:</p>
              <Command text={r.tsh_login_command} label="tsh login" />
            </>
          ) : (
            <p className="muted">
              {r.state === 'PENDING'
                ? 'An approver has to decide. The tsh login command appears on the request once it is approved.'
                : result.note}
            </p>
          )}
          <div className="form-actions">
            <Link className="button primary" to={`/access/requests/${r.id}`}>
              View request
            </Link>
            <button
              onClick={() => {
                setStep('form');
                setResult(undefined);
                setPreview(undefined);
                setReason('');
              }}
            >
              Request another
            </button>
          </div>
        </div>
      </section>
    );
  }
  return (
    <div className="form-layout">
      <section className="panel form-panel">
        <div className="step-label">
          <span className={step === 'form' ? 'selected' : ''}>1. What and why</span>
          <span className={step === 'review' ? 'selected' : ''}>2. Review & submit</span>
        </div>
        <Alert error={action.error || requestable.error} />
        {requestable.loading && !requestable.data ? (
          <Loading />
        ) : step === 'form' ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (valid) setStep('review');
            }}
          >
            <fieldset>
              <legend>Roles</legend>
              <div className="role-options">
                {options.map((o) => (
                  <label className="role-option" key={o.role}>
                    <input
                      type="checkbox"
                      checked={roles.includes(o.role)}
                      onChange={(e) =>
                        setRoles((r) =>
                          e.target.checked ? [...r, o.role] : r.filter((x) => x !== o.role),
                        )
                      }
                    />
                    <span>
                      {o.role}
                      <small>{o.description}</small>
                    </span>
                    <Status value={predictionTone(o.prediction)} />
                  </label>
                ))}
                {options.length === 0 && (
                  <p className="muted">You cannot request any role right now.</p>
                )}
              </div>
            </fieldset>
            <label>
              Reason
              <textarea
                required
                minLength={8}
                maxLength={512}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="What are you doing and for whom? Approvers and the audit log see this."
                rows={3}
              />
              <small>{trimmed.length}/512 characters, at least 8.</small>
            </label>
            <label>
              How long
              <select value={ttl} onChange={(e) => setTtl(e.target.value)}>
                {TTLS.map((t) => (
                  <option key={t} value={t}>
                    {t}
                    {minutes(t) > cap
                      ? ` (capped to ${chosen.map((o) => o.ttl_cap).find(Boolean)})`
                      : ''}
                  </option>
                ))}
              </select>
              <small>
                Access ends automatically. Low-risk roles are approved on the spot; production roles
                need an approver.
              </small>
            </label>
            <div className="form-actions">
              <Link className="button" to="/access">
                Cancel
              </Link>
              <button className="primary" disabled={!valid}>
                Review request
                <Icon name="arrow" size={17} />
              </button>
            </div>
          </form>
        ) : (
          <>
            <h2>Ready to request {roles.join(', ')}?</h2>
            <dl className="metadata">
              <dt>Roles</dt>
              <dd>{roles.join(', ')}</dd>
              <dt>Reason</dt>
              <dd>{trimmed}</dd>
              <dt>Requested for</dt>
              <dd>
                {ttl}
                {preview?.ttl_clamped_from && ` · will be capped to ${preview.ttl}`}
              </dd>
              <dt>Decision</dt>
              <dd>
                {preview?.prediction ? (
                  <>
                    <Status value={predictionTone(preview.prediction.action)} />{' '}
                    {predictionLabel(preview.prediction.action)}
                    {preview.prediction.approvers?.length
                      ? ` · approvers: ${preview.prediction.approvers.join(', ')}`
                      : ''}
                  </>
                ) : action.busy ? (
                  'Checking policy…'
                ) : (
                  'unknown'
                )}
              </dd>
            </dl>
            {preview?.tsh_command && (
              <Command text={preview.tsh_command} label="equivalent tsh command" />
            )}
            <div className="form-actions">
              <button disabled={action.busy} onClick={() => setStep('form')}>
                Edit request
              </button>
              <button
                className="primary"
                disabled={action.busy || preview?.prediction?.action === 'deny'}
                onClick={submit}
              >
                {action.busy ? 'Working…' : 'Submit request'}
              </button>
            </div>
          </>
        )}
      </section>
      <aside className="form-aside">
        <Icon name="key" size={30} />
        <h2>
          Just in time.
          <br />
          Just enough.
        </h2>
        <p>
          Nobody holds standing privileges. Every grant is time-boxed and recorded with your reason.
        </p>
        <div className="aside-note">
          <Icon name="clock" />
          <p>
            Local and dev roles are approved automatically by policy. Production roles wait for an
            approver.
          </p>
        </div>
        <div className="aside-note">
          <Icon name="shield" />
          <p>Use the grant with tsh: the command appears once the request is approved.</p>
        </div>
      </aside>
    </div>
  );
}
