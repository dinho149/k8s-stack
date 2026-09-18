import React from 'react';
import { Link } from 'react-router-dom';
import { usePlatform, dateTime } from '../api';
import { Empty, Heading, Icon, Loading, Status, Timeline } from '../ui';
export function Overview() {
  const { environments, operations, loading, error, updated } = usePlatform();
  const active = environments.filter((e) => e.status !== 'deleted');
  const ready = active.filter((e) => e.status === 'ready');
  const attention = active.filter((e) => e.status === 'failed' || e.status === 'deleting');
  const latest = operations[0];
  return (
    <>
      <Heading
        title="Your work, in motion."
        description="From the first preview to the next release. Make room to build."
        action={
          <Link className="button primary" to="/environments/new">
            <Icon name="plus" />
            Create preview
          </Link>
        }
      />
      <section className="overview-band">
        <div className="overview-intro">
          <span className="workspace-symbol">
            <Icon name="layers" size={32} />
          </span>
          <h2>
            One workspace.
            <br />
            Every environment.
          </h2>
          <p>A clearer path from change to running application.</p>
          <Link to="/environments">
            Explore environments <Icon name="arrow" size={17} />
          </Link>
        </div>
        <div className="overview-metrics">
          <Link to="/environments">
            <span>Active environments</span>
            <strong>{updated ? active.length.toString().padStart(2, '0') : '—'}</strong>
            <small>Across your accessible environments</small>
          </Link>
          <Link to="/environments?status=ready">
            <span>
              <i className="dot green" />
              Ready to use
            </span>
            <strong>{updated ? ready.length.toString().padStart(2, '0') : '—'}</strong>
            <small>Application readiness confirmed</small>
          </Link>
          <Link to="/environments?status=attention">
            <span>
              <i className="dot amber" />
              Need attention
            </span>
            <strong>{updated ? attention.length.toString().padStart(2, '0') : '—'}</strong>
            <small>Failed or awaiting cleanup</small>
          </Link>
        </div>
      </section>
      <div className="overview-grid">
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>Latest deployment</h2>
              <p>The milestones behind your latest operation.</p>
            </div>
            {latest && (
              <Link className="text-link" to={`/environments/${latest.environmentId}`}>
                View environment
                <Icon name="arrow" size={16} />
              </Link>
            )}
          </div>
          {loading ? (
            <Loading />
          ) : latest ? (
            <>
              <div className="deployment-title">
                <span className="entity-icon">
                  <Icon name="layers" />
                </span>
                <div>
                  <Link to={`/environments/${latest.environmentId}`}>{latest.environmentId}</Link>
                  <small>
                    {latest.warm ? 'Warm launch' : 'Cold launch'} · {dateTime(latest.requestedAt)}
                  </small>
                </div>
                <Status value={latest.status} />
              </div>
              <Timeline operation={latest} />
            </>
          ) : (
            !error && (
              <Empty title="Nothing deployed yet">
                Create your first preview and follow its progress here.
              </Empty>
            )
          )}
        </section>
        <aside className="target-panel">
          <Icon name="clock" size={24} />
          <h2>Built for a shorter loop</h2>
          <div className="target-number">
            &lt; 3 <span>min</span>
          </div>
          <p>Warm startup target</p>
          <small>
            A target, not a measured result. Actual launch times appear with each deployment.
          </small>
        </aside>
      </div>
      <div className="overview-grid bottom-grid">
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>Recent activity</h2>
              <p>Deployment requests visible to your account.</p>
            </div>
          </div>
          {operations.slice(0, 5).map((op) => (
            <Link className="activity-row" to={`/environments/${op.environmentId}`} key={op.id}>
              <span className="activity-icon">
                <Icon name="release" />
              </span>
              <div>
                <strong>{op.environmentId}</strong>
                <small>
                  {op.phase || 'Deployment requested'} · {dateTime(op.requestedAt)}
                </small>
              </div>
              <Status value={op.status} />
            </Link>
          ))}
          {!operations.length && (
            <p className="padded muted">
              {loading
                ? 'Loading activity…'
                : error
                  ? 'Activity is currently unavailable.'
                  : 'New deployment activity will appear here.'}
            </p>
          )}
        </section>
        <section className="panel padded">
          <h2>Keep moving</h2>
          <Link className="quick-link" to="/releases">
            <Icon name="release" />
            <div>
              <strong>Ship a release</strong>
              <small>Promote an immutable image</small>
            </div>
            <Icon name="arrow" size={18} />
          </Link>
          <Link className="quick-link" to="/tools">
            <Icon name="tools" />
            <div>
              <strong>Open your tools</strong>
              <small>Your platform, connected</small>
            </div>
            <Icon name="arrow" size={18} />
          </Link>
          <Link className="quick-link" to="/assistant">
            <Icon name="spark" />
            <div>
              <strong>Ask the assistant</strong>
              <small>Get context and take action</small>
            </div>
            <Icon name="arrow" size={18} />
          </Link>
        </section>
      </div>
    </>
  );
}
