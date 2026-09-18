import React, { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { Operation, duration, dateTime } from './api';

export function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    grid: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1.5" />
        <rect x="14" y="3" width="7" height="7" rx="1.5" />
        <rect x="3" y="14" width="7" height="7" rx="1.5" />
        <rect x="14" y="14" width="7" height="7" rx="1.5" />
      </>
    ),
    layers: (
      <>
        <path d="m3 7 9-4 9 4-9 4zM3 12l9 4 9-4M3 17l9 4 9-4" />
      </>
    ),
    arrow: <path d="M5 12h14m-6-6 6 6-6 6" />,
    plus: <path d="M12 5v14M5 12h14" />,
    search: (
      <>
        <circle cx="10" cy="10" r="6" />
        <path d="m15 15 5 5" />
      </>
    ),
    release: (
      <>
        <path d="m5 16 3 3 11-11-3-3zM14 7l3 3M5 16l-2 5 5-2M14 3h7v7" />
      </>
    ),
    tools: (
      <>
        <path d="m14 6 4 4M8 12l-5 5 4 4 5-5M14 3a6 6 0 0 0-6 8l5 5a6 6 0 0 0 8-6l-4 2-5-5z" />
      </>
    ),
    shield: (
      <>
        <path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z" />
        <path d="m8 12 3 3 5-6" />
      </>
    ),
    spark: (
      <>
        <path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z" />
      </>
    ),
    sun: (
      <>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1" />
      </>
    ),
    moon: <path d="M20 15A9 9 0 0 1 9 4a9 9 0 1 0 11 11Z" />,
    menu: <path d="M4 6h16M4 12h16M4 18h16" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    external: (
      <>
        <path d="M14 3h7v7m0-7L10 14M10 5H5v14h14v-5" />
      </>
    ),
    clock: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
    user: (
      <>
        <circle cx="12" cy="8" r="4" />
        <path d="M4 21v-2a8 8 0 0 1 16 0v2" />
      </>
    ),
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] ?? paths.layers}
    </svg>
  );
}
export function Brand() {
  return (
    <Link to="/" className="brand" aria-label="Stack home">
      <svg viewBox="0 0 36 36" width="34" height="34" fill="none" aria-hidden="true">
        <path d="m5 10 13-6 13 6-13 6z" fill="currentColor" />
        <path
          d="m5 18 13 6 13-6M5 26l13 6 13-6"
          stroke="currentColor"
          strokeWidth="3.5"
          strokeLinejoin="round"
        />
      </svg>
      <span>stack</span>
    </Link>
  );
}
export function Credit() {
  return (
    <a className="credit" href="https://backstage.io" target="_blank" rel="noreferrer">
      Powered by Backstage <Icon name="external" size={12} />
    </a>
  );
}
export function Heading({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <header className="page-heading">
      <div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action}
    </header>
  );
}
export function Status({ value }: { value: string }) {
  return (
    <span className={`status status-${value}`}>
      <span />
      {value.replaceAll('-', ' ')}
    </span>
  );
}
export function Alert({ error, notice }: { error?: string; notice?: string }) {
  return (
    <>
      {error && (
        <div className="alert error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="alert" role="status">
          {notice}
        </div>
      )}
    </>
  );
}
export function Empty({
  title,
  children,
  action,
}: React.PropsWithChildren<{ title: string; action?: React.ReactNode }>) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon name="layers" size={28} />
      </span>
      <h2>{title}</h2>
      <p>{children}</p>
      {action}
    </div>
  );
}
export function Loading() {
  return (
    <div className="loading" role="status">
      <span className="spinner" />
      Loading workspace data…
    </div>
  );
}
export function Dialog({
  title,
  children,
  onClose,
}: React.PropsWithChildren<{ title: string; onClose: () => void }>) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    ref.current?.showModal();
    return () => {
      ref.current?.close();
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby="dialog-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className="dialog-heading">
        <h2 id="dialog-title">{title}</h2>
        <button className="icon-button" onClick={onClose} aria-label="Close dialog">
          <Icon name="close" />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function Timeline({ operation }: { operation?: Operation }) {
  const stages = [
    { label: 'Queued', at: operation?.requestedAt },
    { label: 'Provisioning', at: operation?.startedAt },
    { label: 'Cluster ready', at: operation?.timings['cluster-ready'] },
    { label: 'Platform ready', at: operation?.timings['platform-ready'] },
    { label: 'Application ready', at: operation?.timings['application-ready'] },
  ];
  const next = stages.findIndex((s) => !s.at);
  return (
    <ol className="timeline">
      {stages.map((stage, i) => (
        <li
          key={stage.label}
          className={stage.at ? 'complete' : i === next && operation ? 'current' : ''}
        >
          <span className="timeline-node">
            {stage.at ? <Icon name="check" size={14} /> : i + 1}
          </span>
          <strong>{stage.label}</strong>
          <small>
            {stage.at
              ? i < 2
                ? dateTime(stage.at)
                : duration(operation?.startedAt, stage.at)
              : i === next && operation?.status === 'running'
                ? 'In progress'
                : 'Awaiting milestone'}
          </small>
        </li>
      ))}
    </ol>
  );
}
export function DeploymentFields({
  image,
  revision,
  setImage,
  setRevision,
}: {
  image: string;
  revision: string;
  setImage: (v: string) => void;
  setRevision: (v: string) => void;
}) {
  return (
    <>
      <label>
        Image digest
        <input
          required
          value={image}
          onChange={(e) => setImage(e.target.value)}
          pattern="[A-Za-z0-9_.\/:\-]+@sha256:[a-f0-9]{64}"
          placeholder="ghcr.io/team/app@sha256:…"
          spellCheck={false}
        />
        <small>Use an immutable sha256 image digest, not a tag.</small>
      </label>
      <label>
        Git revision
        <input
          required
          value={revision}
          onChange={(e) => setRevision(e.target.value)}
          pattern="[a-f0-9]{7,64}"
          placeholder="Commit SHA"
          spellCheck={false}
        />
        <small>The 7–64 character hexadecimal commit SHA.</small>
      </label>
    </>
  );
}
