import React, { useEffect, useState } from 'react';
import { parse, stringify } from 'yaml';
import type { Project } from '../shared';
import { creationBusy, type CreationJob, type ConventionProfile } from '../reference';

const api = window.dogfood;
const statusText: Record<CreationJob['status'], string> = {
  capturing: 'Reading reference',
  'awaiting-scope': 'Choose an application',
  analyzing: 'Analyzing conventions',
  review: 'Review the setup',
  generating: 'Generating application',
  verifying: 'Installing and checking',
  failed: 'Creation needs attention',
  cancelled: 'Creation cancelled',
  interrupted: 'Creation interrupted',
  complete: 'Workspace verified',
};
export function ReferenceProject({ done }: { done: (project: Project) => void }) {
  const [source, setSource] = useState('local'),
    [reference, setReference] = useState(''),
    [branch, setBranch] = useState(''),
    [subdirectory, setSubdirectory] = useState('');
  const [name, setName] = useState(''),
    [destination, setDestination] = useState(''),
    [description, setDescription] = useState('');
  const [harness, setHarness] = useState('codex'),
    [model, setModel] = useState(''),
    [budget, setBudget] = useState('');
  const [projects, setProjects] = useState<Project[]>([]),
    [jobs, setJobs] = useState<CreationJob[]>([]),
    [job, setJob] = useState<CreationJob>();
  const [profile, setProfile] = useState<ConventionProfile>(),
    [commands, setCommands] = useState(''),
    [scope, setScope] = useState('.');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState(''),
    [waiting, setWaiting] = useState(false),
    [paths, setPaths] = useState<string[]>([]),
    [file, setFile] = useState(''),
    [content, setContent] = useState('');
  async function call<T>(method: string, params: Record<string, unknown> = {}) {
    setError('');
    setNotice('');
    setWaiting(true);
    try {
      return await api.call<T>(method, params);
    } catch (error) {
      setError(String(error));
    } finally {
      setWaiting(false);
    }
  }
  const load = (next: CreationJob) => {
    setJob(next);
    setProfile(next.profile);
    setCommands(next.profile ? stringify(next.profile.commands) : '');
    setBudget(next.input.budgetUsd?.toString() ?? '');
    setScope(next.input.subdirectory || next.candidates[0] || '.');
    setFile('');
    setPaths([]);
  };
  useEffect(() => {
    let stopped = false;
    void Promise.all([
      api.call<{ projects: Project[] }>('snapshot'),
      api.call<CreationJob[]>('creation.list'),
    ])
      .then(([state, saved]) => {
        if (!stopped) {
          setProjects(state.projects);
          setJobs(saved);
        }
      })
      .catch((e) => {
        if (!stopped) setError(String(e));
      });
    return () => {
      stopped = true;
    };
  }, []);
  useEffect(() => {
    if (!job || !creationBusy(job.status)) return;
    let stopped = false;
    const timer = setInterval(() => {
      void api
        .call<CreationJob>('creation.get', { id: job.id })
        .then((next) => {
          if (stopped) return;
          setJob(next);
          if (next.status === 'review') {
            setProfile(next.profile);
            setCommands(stringify(next.profile!.commands));
          }
          if (next.status === 'awaiting-scope') setScope(next.candidates[0] || '.');
        })
        .catch((e) => {
          if (!stopped) setError(String(e));
        });
    }, 750);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [job?.id, job?.status]);
  const directory = async (setter: (s: string) => void) => {
    const value = await call<string | null>('dialog.directory');
    if (value) setter(value);
  };
  const openWorkspace = async (projectId: string) => {
    const state = await call<{ projects: Project[] }>('snapshot');
    const project = state?.projects.find((p) => p.id === projectId);
    if (project) done(project);
    else if (state) setError('This workspace was removed. Open its repository to restore it.');
  };
  const retry = async () => {
    const next = await call<CreationJob>('creation.retry', {
      id: job!.id,
      budgetUsd: budget ? Number(budget) : null,
    });
    if (next) setJob(next);
  };
  const submitProfile = async (method: string) => {
    let parsed: unknown;
    try {
      parsed = parse(commands);
    } catch (e) {
      setError(`Check the command YAML: ${String(e)}`);
      return;
    }
    const next = await call<CreationJob>(method, {
      id: job!.id,
      profile: { ...profile, commands: parsed },
    });
    if (next) {
      setJob(next);
      if (method === 'creation.save-profile') setNotice('Proposal saved.');
    }
  };
  if (job)
    return (
      <section className="reference-flow" aria-label="Reference project creation">
        <div className="section-line">
          <h3>{statusText[job.status]}</h3>
          <button
            type="button"
            disabled={waiting}
            onClick={() => {
              setJobs((previous) => [job, ...previous.filter((j) => j.id !== job.id)]);
              setJob(undefined);
            }}
          >
            All creation drafts
          </button>
        </div>
        <p className="muted">
          {job.input.name} · {job.input.destination}
        </p>
        <ol className="reference-steps" aria-label="Creation steps">
          {['Analyze', 'Review', 'Generate', 'Verify'].map((label, index) => (
            <li
              key={label}
              className={
                index ===
                (job.status === 'review' || job.status === 'awaiting-scope'
                  ? 1
                  : job.phase === 'analyze'
                    ? 0
                    : job.phase === 'generate'
                      ? 2
                      : 3)
                  ? 'current'
                  : ''
              }
            >
              {label}
            </li>
          ))}
        </ol>
        {job.status === 'awaiting-scope' && (
          <>
            <p>This reference contains several packages. Choose the application to follow.</p>
            <label>
              Reference application
              <select value={scope} onChange={(e) => setScope(e.target.value)}>
                {[...new Set([...job.candidates, '.'])].map((path) => (
                  <option key={path} value={path}>
                    {path === '.' ? 'Repository root' : path}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="primary"
              disabled={waiting}
              onClick={() =>
                void call<CreationJob>('creation.scope', { id: job.id, subdirectory: scope }).then(
                  (next) => {
                    if (next) setJob(next);
                  },
                )
              }
            >
              Analyze application
            </button>
          </>
        )}
        {job.status === 'review' && profile && (
          <>
            <p>
              Adjust the conventions for your new app. The selected agent will generate a minimal
              scaffold, then Dogfood will run the commands below.
            </p>
            <label>
              Stack and versions
              <textarea
                disabled={!!job.materialized}
                rows={2}
                aria-label="Stack and versions"
                value={profile.stack}
                onChange={(e) => setProfile({ ...profile, stack: e.target.value })}
              />
            </label>
            <label>
              Package manager
              <input
                disabled={!!job.materialized}
                value={profile.packageManager}
                onChange={(e) => setProfile({ ...profile, packageManager: e.target.value })}
              />
            </label>
            <label>
              Folder structure
              <textarea
                disabled={!!job.materialized}
                rows={3}
                aria-label="Folder structure"
                value={profile.structure.join('\n')}
                onChange={(e) => setProfile({ ...profile, structure: e.target.value.split('\n') })}
              />
            </label>
            <label>
              Naming and development conventions
              <textarea
                disabled={!!job.materialized}
                rows={5}
                aria-label="Naming and development conventions"
                value={profile.conventions}
                onChange={(e) => setProfile({ ...profile, conventions: e.target.value })}
              />
            </label>
            <p>
              <strong>Prerequisites:</strong> {profile.prerequisites || 'None identified'}
            </p>
            {profile.uncertainties.length > 0 && (
              <div className="reference-notes">
                <strong>Review these assumptions</strong>
                <ul>
                  {profile.uncertainties.map((item, i) => (
                    <li key={i}>{item}</li>
                  ))}
                </ul>
              </div>
            )}
            <details>
              <summary>Reference evidence</summary>
              <ul>
                {profile.evidence.map((path) => (
                  <li key={path}>
                    <code>{path}</code>
                  </li>
                ))}
              </ul>
            </details>
            <label>
              Setup, checks, and local startup
              <textarea
                className="reference-code"
                aria-label="Setup, checks, and local startup"
                rows={12}
                value={commands}
                onChange={(e) => setCommands(e.target.value)}
                spellCheck={false}
              />
            </label>
            <p className="muted">
              These commands install dependencies and run locally in the new directory. Source files
              and command output may be sent to {job.input.role.harness} for generation and repairs.
            </p>
            <button
              type="button"
              className="primary"
              disabled={waiting}
              onClick={() => void submitProfile('creation.generate')}
            >
              {job.materialized ? 'Verify updated commands' : 'Create and verify'}
            </button>
            {!job.materialized && (
              <button
                type="button"
                disabled={waiting}
                onClick={() => void submitProfile('creation.save-profile')}
              >
                Save proposal
              </button>
            )}
            {notice && <p role="status">{notice}</p>}
          </>
        )}
        {creationBusy(job.status) && (
          <div className="reference-notes" role="status">
            <p>
              {statusText[job.status]}… You can close this dialog and return to this saved draft.
            </p>
            <button
              type="button"
              disabled={waiting}
              onClick={() => void call('creation.cancel', { id: job.id })}
            >
              Cancel creation
            </button>
          </div>
        )}
        {['failed', 'cancelled', 'interrupted'].includes(job.status) && (
          <>
            <p role="alert" className="agent-error">
              {job.error || 'Your draft is saved. Retry when ready.'}
            </p>
            {job.ownedDestination && (
              <p>
                Generated files are kept at <code>{job.input.destination}</code>. Edit them in your
                editor if needed, then retry verification. Your edits will be preserved.
              </p>
            )}
            <label>
              Creation budget (USD, optional)
              <input
                type="number"
                min="0.01"
                step="0.01"
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
              />
            </label>
            <div className="inline-actions">
              <button
                type="button"
                className="primary"
                disabled={waiting}
                onClick={() => void retry()}
              >
                {job.materialized ? 'Retry verification' : 'Retry creation'}
              </button>
              {job.materialized && (
                <button
                  type="button"
                  disabled={waiting}
                  onClick={() =>
                    void call<CreationJob>('creation.review-commands', { id: job.id }).then(
                      (next) => {
                        if (next) load(next);
                      },
                    )
                  }
                >
                  Review commands
                </button>
              )}
              {!job.ownedDestination && job.profile && (
                <button
                  type="button"
                  disabled={waiting}
                  onClick={() => {
                    setProfile(job.profile);
                    setCommands(stringify(job.profile!.commands));
                    setJob({ ...job, status: 'review' });
                  }}
                >
                  Review proposal
                </button>
              )}
            </div>
          </>
        )}
        {job.status === 'complete' && (
          <>
            <p>
              Setup, checks, and configured local startup passed. The project has fresh Git history
              and its own saved conventions.
            </p>
            <button
              type="button"
              className="primary"
              disabled={waiting}
              onClick={() => void openWorkspace(job.projectId!)}
            >
              Open new workspace
            </button>
          </>
        )}
        <CreationEvidence job={job} />
        {job.materialized && !creationBusy(job.status) && (
          <details
            onToggle={(e) => {
              if (e.currentTarget.open)
                void call<string[]>('creation.files', { id: job.id }).then((value) => {
                  if (value) setPaths(value);
                });
            }}
          >
            <summary>Inspect generated files</summary>
            <label>
              Generated file
              <select
                value={file}
                onChange={(e) => {
                  setFile(e.target.value);
                  setContent('');
                  if (e.target.value)
                    void call<string>('creation.read-file', {
                      id: job.id,
                      path: e.target.value,
                    }).then((value) => setContent(value ?? ''));
                }}
              >
                <option value="">Choose a file</option>
                {paths.map((path) => (
                  <option key={path}>{path}</option>
                ))}
              </select>
            </label>
            {file && <pre className="reference-log">{content}</pre>}
          </details>
        )}
        {error && (
          <p role="alert" className="agent-error">
            {error}
          </p>
        )}
      </section>
    );
  return (
    <section className="reference-flow" aria-label="Reference project setup">
      <p className="muted">
        Start fresh with another project’s framework, structure, and conventions.
      </p>
      <fieldset disabled={waiting} className="project-fields">
        <label>
          Reference source
          <select
            value={source}
            onChange={(e) => {
              setSource(e.target.value);
              setReference('');
            }}
          >
            <option value="local">Local project</option>
            <option value="github">GitHub repository</option>
          </select>
        </label>
        {source === 'local' && projects.length > 0 && (
          <label>
            Use an existing workspace
            <select
              value={projects.some((p) => p.path === reference) ? reference : ''}
              onChange={(e) => setReference(e.target.value)}
            >
              <option value="">Choose a workspace or browse below</option>
              {projects.map((p) => (
                <option key={p.id} value={p.path}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          {source === 'local' ? 'Reference directory' : 'Reference GitHub URL'}
          <div className="input-action">
            <input
              aria-label={source === 'local' ? 'Reference directory' : 'Reference GitHub URL'}
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder={
                source === 'local'
                  ? '/Users/you/Projects/reference-app'
                  : 'https://github.com/team/project'
              }
            />
            {source === 'local' && (
              <button type="button" onClick={() => void directory(setReference)}>
                Browse reference
              </button>
            )}
          </div>
        </label>
        {source === 'github' && (
          <label>
            Branch (optional)
            <input
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              placeholder="Repository default branch"
            />
          </label>
        )}
        <label>
          Project subdirectory (optional)
          <input
            value={subdirectory}
            onChange={(e) => setSubdirectory(e.target.value)}
            placeholder="Choose after analysis, or enter apps/web"
          />
        </label>
        <div className="starter-fields">
          <label>
            New project name
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
          </label>
          <label>
            Agent
            <select value={harness} onChange={(e) => setHarness(e.target.value)}>
              <option value="codex">Codex</option>
              <option value="claude">Claude</option>
            </select>
          </label>
        </div>
        <label>
          Empty destination directory
          <div className="input-action">
            <input
              aria-label="New workspace directory"
              value={destination}
              onChange={(e) => setDestination(e.target.value)}
              placeholder="/Users/you/Projects/new-app"
            />
            <button type="button" onClick={() => void directory(setDestination)}>
              Browse destination
            </button>
          </div>
        </label>
        <label>
          What is the new project for? (optional)
          <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <details>
          <summary>Model and budget</summary>
          <label>
            Model (optional)
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="Connected agent default"
            />
          </label>
          <label>
            Creation budget (USD, optional)
            <input
              type="number"
              min="0.01"
              step="0.01"
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
            />
          </label>
          <p className="muted">
            A budget requires matching model prices in Connections. Reported costs can arrive late.
          </p>
        </details>
        <p className="muted">
          Uses your agent connection from Connections. Relevant reference files are sent to the
          selected provider. The reference stays unchanged.
        </p>
        <button
          type="button"
          className="primary"
          disabled={!reference.trim() || !destination.trim() || !name.trim() || waiting}
          onClick={() =>
            void call<CreationJob>('creation.start', {
              input: {
                source:
                  source === 'local'
                    ? { kind: 'local', path: reference }
                    : { kind: 'github', url: reference, branch },
                subdirectory,
                name,
                destination,
                description,
                role: { harness, model, effort: 'high' },
                ...(budget ? { budgetUsd: Number(budget) } : {}),
              },
            }).then((next) => {
              if (next) load(next);
            })
          }
        >
          {waiting ? 'Preparing analysis…' : 'Analyze reference'}
        </button>
      </fieldset>
      {error && (
        <p role="alert" className="agent-error">
          {error}
        </p>
      )}
      {jobs.length > 0 && (
        <details open>
          <summary>Saved creations</summary>
          <div className="reference-saved">
            {jobs.map((saved) => (
              <button
                type="button"
                key={saved.id}
                onClick={() =>
                  void call<CreationJob>('creation.get', { id: saved.id }).then((next) => {
                    if (next) load(next);
                  })
                }
              >
                <strong>{saved.input.name}</strong>
                <span>{statusText[saved.status]}</span>
              </button>
            ))}
          </div>
        </details>
      )}
    </section>
  );
}
function CreationEvidence({ job }: { job: CreationJob }) {
  return (
    <>
      {job.usage.length > 0 && (
        <p className="muted">
          Creation usage: ${job.usage.reduce((n, u) => n + (u.costUsd ?? 0), 0).toFixed(4)}
          {job.usage.some((u) => u.costUsd === null)
            ? ' · Cost incomplete'
            : ' · Reported or estimated'}{' '}
          · {job.runs.length} agent runs
        </p>
      )}
      {job.log && (
        <details open={job.status === 'failed'}>
          <summary>Setup and verification logs</summary>
          <pre className="reference-log">{job.log}</pre>
        </details>
      )}
    </>
  );
}
export function CreationHistory({ projectId }: { projectId: string }) {
  const [jobs, setJobs] = useState<CreationJob[]>([]),
    [error, setError] = useState('');
  useEffect(() => {
    let stopped = false;
    void api
      .call<CreationJob[]>('creation.list')
      .then((jobs) => {
        if (!stopped) setJobs(jobs.filter((j) => j.projectId === projectId));
      })
      .catch((e) => {
        if (!stopped) setError(String(e));
      });
    return () => {
      stopped = true;
    };
  }, [projectId]);
  if (!jobs.length && !error) return null;
  return (
    <div className="surface">
      <h2>Reference setup</h2>
      {error && <p role="alert">{error}</p>}
      {jobs.map((job) => (
        <div key={job.id}>
          <p>
            Created from <strong>{job.provenance?.label}</strong> · {job.provenance?.subdirectory}
          </p>
          <p>
            Verified at creation. Conventions are saved in <code>REFERENCE.md</code> and used in
            task context.
          </p>
          <button
            type="button"
            onClick={() =>
              void api
                .call<CreationJob>('creation.get', { id: job.id })
                .then((next) => setJobs(jobs.map((j) => (j.id === next.id ? next : j))))
                .catch((e) => setError(String(e)))
            }
          >
            View creation evidence
          </button>
          <CreationEvidence job={job} />
        </div>
      ))}
    </div>
  );
}
