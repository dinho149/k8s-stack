import React, { useEffect, useRef, useState } from 'react';
import {
  Policies as PolicyData,
  Tool,
  dateTime,
  safeUrl,
  useAction,
  usePlatform,
  useResource,
} from '../api';
import { Alert, DeploymentFields, Empty, Heading, Icon, Loading, Status } from '../ui';
export function Releases() {
  const { client } = usePlatform();
  const action = useAction();
  const [target, setTarget] = useState('dev'),
    [image, setImage] = useState(''),
    [revision, setRevision] = useState(''),
    [review, setReview] = useState(false);
  const [result, setResult] = useState<{ note: string; url: string }>();
  return (
    <>
      <Heading title="Releases" description="A considered step from preview to production." />
      <div className="form-layout">
        <section className="panel form-panel">
          <div className="section-icon">
            <Icon name="release" />
          </div>
          <h2>Promote an image</h2>
          <p className="muted">Deploy a specific version to a persistent environment.</p>
          <Alert error={action.error} />
          {result ? (
            <div className="success-state">
              <Icon name="check" size={32} />
              <h2>Promotion requested</h2>
              <p>{result.note}</p>
              {safeUrl(result.url) && (
                <a
                  className="button primary"
                  href={safeUrl(result.url)}
                  target="_blank"
                  rel="noreferrer"
                >
                  Follow workflow
                  <Icon name="external" size={16} />
                </a>
              )}
              <button
                onClick={() => {
                  setResult(undefined);
                  setReview(false);
                }}
              >
                Request another promotion
              </button>
            </div>
          ) : !review ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                setReview(true);
              }}
            >
              <label>
                Target environment
                <select value={target} onChange={(e) => setTarget(e.target.value)}>
                  <option value="dev">Development</option>
                  <option value="staging">Staging</option>
                  <option value="prod">Production</option>
                </select>
              </label>
              <DeploymentFields {...{ image, revision, setImage, setRevision }} />
              <div className="form-actions">
                <button className="primary">
                  Review promotion
                  <Icon name="arrow" size={16} />
                </button>
              </div>
            </form>
          ) : (
            <>
              <h3>Review promotion</h3>
              <dl className="metadata">
                <dt>Target</dt>
                <dd>{target}</dd>
                <dt>Image</dt>
                <dd>
                  <code>{image}</code>
                </dd>
                <dt>Revision</dt>
                <dd>
                  <code>{revision}</code>
                </dd>
              </dl>
              <p>GitHub environment approval rules apply before the deployment is promoted.</p>
              <div className="form-actions">
                <button disabled={action.busy} onClick={() => setReview(false)}>
                  Edit details
                </button>
                <button
                  className="primary"
                  disabled={action.busy}
                  onClick={() =>
                    void action.run(async () =>
                      setResult(await client('/promotions', 'POST', { target, image, revision })),
                    )
                  }
                >
                  {action.busy ? 'Requesting…' : 'Request promotion'}
                </button>
              </div>
            </>
          )}
        </section>
        <aside className="form-aside">
          <Icon name="shield" size={30} />
          <h2>Ship with context.</h2>
          <p>
            Choose the destination and exact image you want to promote. Review both before
            requesting deployment.
          </p>
          <div className="aside-note">
            <Icon name="release" />
            <p>Track approval and deployment in the linked GitHub workflow.</p>
          </div>
        </aside>
      </div>
    </>
  );
}
export function Tools() {
  const { data, loading, error, reload } = useResource<Tool[]>('/tools');
  const [query, setQuery] = useState('');
  const filtered = data?.filter((t) =>
    `${t.name} ${t.description}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <>
      <Heading
        title="Your platform toolkit"
        description="The right tool, already in reach."
        action={
          <button onClick={() => void reload()} disabled={loading}>
            Refresh tools
          </button>
        }
      />
      <Alert error={error} />
      <div className="tool-search">
        <label className="search">
          <Icon name="search" />
          <input
            aria-label="Search tools"
            placeholder="Find a tool"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      </div>
      {loading && !data ? (
        <Loading />
      ) : (
        <div className="tools-grid">
          {filtered?.map((tool) => (
            <article className="panel tool-card" key={tool.name}>
              <div className="tool-card-top">
                <span className="tool-monogram">{tool.name.slice(0, 2)}</span>
                <Status value={tool.status} />
              </div>
              <h2>{tool.name}</h2>
              <p>{tool.description}</p>
              <div className="tool-card-bottom">
                {tool.status === 'installed' && safeUrl(tool.url) ? (
                  <a href={safeUrl(tool.url)} target="_blank" rel="noreferrer">
                    Open {tool.name}
                    <Icon name="external" size={16} />
                  </a>
                ) : (
                  <span className="muted">
                    {tool.status === 'not-installed'
                      ? 'Not installed in this cluster'
                      : 'Destination unavailable'}
                  </span>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
      {!loading && !error && !filtered?.length && (
        <Empty title={query ? 'No tools match your search' : 'No tools configured'}>
          {query ? 'Try another name or keyword.' : 'Configured platform tools will appear here.'}
        </Empty>
      )}
    </>
  );
}
const minutes = (nanoseconds: number) =>
  `${(nanoseconds / 60_000_000_000).toLocaleString(undefined, { maximumFractionDigits: 1 })} min`;
export function Policies() {
  const { data, loading, error, reload } = useResource<PolicyData>('/policies');
  return (
    <>
      <Heading
        title="Policies & access"
        description="Know the boundaries. Build with confidence."
        action={
          <button disabled={loading} onClick={() => void reload()}>
            Refresh policies
          </button>
        }
      />
      <Alert error={error} />
      {loading && !data ? (
        <Loading />
      ) : (
        data && (
          <>
            <section className="policy-banner">
              <span className="section-icon">
                <Icon name="shield" size={28} />
              </span>
              <div>
                <h2>Your access is {data.role}</h2>
                <p>{data.notes}</p>
              </div>
              <Status value={data.enforcement} />
            </section>
            <div className="policy-grid">
              {[
                {
                  label: 'Default preview lifetime',
                  value: minutes(data.lifecycle.ttl),
                  text: 'How long a new preview stays available.',
                },
                {
                  label: 'Maximum preview lifetime',
                  value: minutes(data.lifecycle.maxTTL),
                  text: 'The upper limit enforced on preview expiry.',
                },
                {
                  label: 'Preview capacity',
                  value: `${data.lifecycle.maxPreviews}`,
                  text: 'The configured limit on active previews.',
                },
                {
                  label: 'Warm startup target',
                  value: minutes(data.lifecycle.warmTarget),
                  text: 'A configured target, not a measured result.',
                },
                {
                  label: 'Operation timeout',
                  value: minutes(data.lifecycle.operationTimeout),
                  text: 'How long an operation may run.',
                },
              ].map((item) => (
                <section className="panel policy-card" key={item.label}>
                  <h2>{item.label}</h2>
                  <strong>{item.value}</strong>
                  <p>{item.text}</p>
                </section>
              ))}
            </div>
            <section className="panel padded">
              <h2>Policy evidence</h2>
              <p className="muted">
                Source: {data.source} · Retrieved {dateTime(data.retrievedAt)}
              </p>
              <Alert error={data.clusterError} />
              <details>
                <summary>Inspect raw policy evidence</summary>
                <pre>{JSON.stringify(data, null, 2)}</pre>
              </details>
            </section>
          </>
        )
      )}
    </>
  );
}
type Message = { role: 'user' | 'assistant'; text: string };
type Conversation = { provider: string; id: string; messages: Message[] };
const initialConversation = (): Conversation => {
  try {
    const saved = JSON.parse(sessionStorage.getItem('stack.conversation') ?? 'null');
    if (
      saved &&
      ['bedrock', 'vertex'].includes(saved.provider) &&
      typeof saved.id === 'string' &&
      Array.isArray(saved.messages) &&
      saved.messages.every(
        (m: Message) => ['user', 'assistant'].includes(m.role) && typeof m.text === 'string',
      )
    )
      return saved;
  } catch {}
  return { provider: 'bedrock', id: crypto.randomUUID(), messages: [] };
};
export function Assistant() {
  const { client } = usePlatform();
  const action = useAction();
  const [chat, setChat] = useState(initialConversation);
  const [draft, setDraft] = useState('');
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => {
    try {
      sessionStorage.setItem('stack.conversation', JSON.stringify(chat));
    } catch {}
  }, [chat]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'nearest' });
  }, [chat.messages, action.busy]);
  const reset = (provider = chat.provider) => {
    action.clear();
    setChat({ provider, id: crypto.randomUUID(), messages: [] });
    setDraft('');
  };
  return (
    <>
      <Heading
        title="A little context goes a long way."
        description="Ask your platform assistant. Keep your work moving."
      />
      <section className="panel chat-panel">
        <div className="chat-toolbar">
          <div className="assistant-identity">
            <span className="section-icon">
              <Icon name="spark" />
            </span>
            <div>
              <strong>Stack assistant</strong>
              <small>Actions use your platform permissions</small>
            </div>
          </div>
          <label className="sr-only" htmlFor="provider">
            Inference provider
          </label>
          <select
            id="provider"
            value={chat.provider}
            disabled={action.busy}
            onChange={(e) => reset(e.target.value)}
          >
            <option value="bedrock">Amazon Bedrock</option>
            <option value="vertex">Google Vertex AI</option>
          </select>
          <button disabled={action.busy} onClick={() => reset()}>
            New conversation
          </button>
        </div>
        <div className="chat-messages" role="log" aria-label="Conversation" aria-live="polite">
          {!chat.messages.length && (
            <div className="chat-welcome">
              <Icon name="spark" size={42} />
              <h2>What can we help move forward?</h2>
              <p>Understand an environment, explain a policy, or extend a preview.</p>
              <div className="suggestions">
                {[
                  'What environments need my attention?',
                  'Explain the policies for my previews.',
                  'How do I extend a preview?',
                ].map((prompt) => (
                  <button key={prompt} onClick={() => setDraft(prompt)}>
                    {prompt}
                    <Icon name="arrow" size={16} />
                  </button>
                ))}
              </div>
            </div>
          )}
          {chat.messages.map((m, i) => (
            <article className={`message ${m.role}`} key={i}>
              <span className="message-avatar">
                <Icon name={m.role === 'user' ? 'user' : 'spark'} size={18} />
              </span>
              <div>
                <strong>{m.role === 'user' ? 'You' : 'Stack assistant'}</strong>
                <p>{m.text}</p>
              </div>
            </article>
          ))}
          {action.busy && (
            <div className="assistant-working" role="status">
              <span className="spinner" />
              Working on your request…
            </div>
          )}
          <div ref={bottom} />
        </div>
        <form
          className="chat-composer"
          onSubmit={(e) => {
            e.preventDefault();
            if (!draft.trim()) return;
            const text = draft.trim();
            void action.run(async () => {
              const response = await client<{ answer: string }>('/agent', 'POST', {
                text,
                conversation: chat.id,
                provider: chat.provider,
              });
              setChat((c) => ({
                ...c,
                messages: [
                  ...c.messages,
                  { role: 'user', text },
                  { role: 'assistant', text: response.answer },
                ],
              }));
              setDraft('');
            });
          }}
        >
          <Alert error={action.error} />
          <label className="sr-only" htmlFor="assistant-request">
            Your request
          </label>
          <textarea
            id="assistant-request"
            placeholder="Ask about your platform…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={action.busy}
            required
          />
          <div>
            <small>
              Switching provider starts a new conversation. History stays in this browser tab.
            </small>
            <button className="primary" disabled={action.busy || !draft.trim()}>
              {action.busy ? 'Working…' : 'Send request'}
              <Icon name="arrow" size={17} />
            </button>
          </div>
        </form>
      </section>
    </>
  );
}
