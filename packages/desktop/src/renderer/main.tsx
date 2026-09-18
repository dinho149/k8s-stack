import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Snapshot, Task, Project, ProjectConfig, Settings, Artifact, Idea } from '../shared';
import { defaultSettings } from '../shared';
import { Editor } from './Editor';
import { Terminal } from './Terminal';
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import './style.css';

type State = Snapshot & { apps: { taskId: string; url: string }[]; activeTasks: string[] };
const initial: State = {
  projects: [],
  ideas: [],
  tasks: [],
  runs: [],
  artifacts: [],
  usage: [],
  approvals: [],
  settings: defaultSettings,
  apps: [],
  activeTasks: [],
};
const money = (value: number) => `$${value.toFixed(value < 1 ? 4 : 2)}`;
const label = (value: string) => value.replaceAll('-', ' ').replace(/^./, (s) => s.toUpperCase());
const time = (value: string) =>
  new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const api = window.dogfood;
function Icon({ name }: { name: string }) {
  return (
    <span aria-hidden="true" className="icon">
      {{
        work: '▱',
        ideas: '◇',
        connections: '⌘',
        platform: '▥',
        plus: '+',
        arrow: '↗',
        check: '✓',
        play: '▷',
        code: '‹›',
        search: '⌕',
        cost: '$',
      }[name] ?? '·'}
    </span>
  );
}
function App() {
  const [state, setState] = useState(initial),
    [projectId, setProjectId] = useState(localStorage.getItem('dogfood-project') ?? ''),
    [taskId, setTaskId] = useState(localStorage.getItem('dogfood-task') ?? ''),
    [view, setView] = useState('work'),
    [tab, setTab] = useState('plan'),
    [dock, setDock] = useState('logs');
  const [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [dialog, setDialog] = useState(''),
    [logs, setLogs] = useState<Record<string, string>>({}),
    [dark, setDark] = useState(localStorage.getItem('dogfood-theme') === 'dark');
  const [plan, setPlan] = useState(''),
    [fileList, setFileList] = useState<string[]>([]),
    [file, setFile] = useState(''),
    [content, setContent] = useState(''),
    [fileHash, setFileHash] = useState(''),
    [changes, setChanges] = useState(''),
    [artifact, setArtifact] = useState<{ meta: Artifact; content: string }>(),
    [guidance, setGuidance] = useState(''),
    [previewUrl, setPreviewUrl] = useState('');
  const [query, setQuery] = useState(''),
    [palette, setPalette] = useState(false),
    [pr, setPr] = useState<any>();
  const previewHost = useRef<HTMLDivElement>(null);
  const project = state.projects.find((p) => p.id === projectId),
    task = state.tasks.find((t) => t.id === taskId);
  const active = state.activeTasks.includes(taskId);
  const refresh = useCallback(async () => setState(await api.call<State>('snapshot')), []);
  const act = useCallback(
    async <T,>(method: string, params: Record<string, unknown> = {}): Promise<T | undefined> => {
      setError('');
      setNotice('');
      setBusy(true);
      try {
        const result = await api.call<T>(method, params);
        await refresh();
        return result;
      } catch (error) {
        setError(error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );
  useEffect(() => {
    void refresh();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = api.onEvent((event) => {
      if (event.type === 'changed' || event.type === 'approval') {
        clearTimeout(timer);
        timer = setTimeout(() => void refresh(), 100);
      }
      if (event.type === 'output' && event.taskId)
        setLogs((previous) => ({
          ...previous,
          [event.taskId!]: ((previous[event.taskId!] ?? '') + (event.text ?? '')).slice(-60000),
        }));
    });
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [refresh]);
  useEffect(() => {
    if (!projectId && state.projects[0]) setProjectId(state.projects[0].id);
  }, [state.projects, projectId]);
  useEffect(() => {
    localStorage.setItem('dogfood-project', projectId);
  }, [projectId]);
  useEffect(() => {
    localStorage.setItem('dogfood-task', taskId);
    setFile('');
    setContent('');
    setPr(undefined);
    setArtifact(undefined);
  }, [taskId]);
  useEffect(() => {
    setPlan(task?.plan ?? '');
  }, [taskId, task?.plan]);
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    localStorage.setItem('dogfood-theme', dark ? 'dark' : 'light');
  }, [dark]);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'k') {
        event.preventDefault();
        setPalette((v) => !v);
      }
      if (event.key === 'Escape') {
        setDialog('');
        setPalette(false);
      }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);
  useEffect(() => {
    if (task && tab === 'files')
      void api
        .call<string[]>('file.list', { id: task.id })
        .then(setFileList)
        .catch((e) => setError(String(e)));
    if (task && tab === 'changes')
      void api
        .call<string>('git.diff', { id: task.id })
        .then(setChanges)
        .catch((e) => setError(String(e)));
  }, [taskId, tab, state.runs.length, task?.updatedAt]);
  useEffect(() => {
    if (dock !== 'preview' || view !== 'work' || !task || dialog || palette || artifact) {
      void api.call('preview.hide');
      return;
    }
    let cancelled = false;
    const rect = () => {
      const r = previewHost.current?.getBoundingClientRect();
      return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
    };
    const r = rect();
    if (!r) return;
    void api
      .call<string>('preview.show', { id: task.id, rect: r })
      .then((url) => {
        if (cancelled) {
          void api.call('preview.hide');
          return;
        }
        setPreviewUrl(url);
      })
      .catch((error) => {
        setError(String(error));
        setDock('logs');
      });
    const observer = new ResizeObserver(() => {
      const r = rect();
      if (r) void api.call('preview.bounds', { rect: r });
    });
    observer.observe(previewHost.current!);
    return () => {
      cancelled = true;
      observer.disconnect();
      void api.call('preview.hide');
    };
  }, [dock, view, taskId, dialog, palette, artifact]);
  const tasks = state.tasks.filter(
    (t) =>
      t.projectId === projectId &&
      t.status !== 'archived' &&
      (!query || `${t.title} ${t.description}`.toLowerCase().includes(query.toLowerCase())),
  );
  const taskAction = (action: string) => void act('task.action', { id: taskId, action });
  const selectTask = (t: Task) => {
    setProjectId(t.projectId);
    setTaskId(t.id);
    setView('work');
    setTab('plan');
  };
  const taskUsage = state.usage.filter((u) => u.taskId === taskId),
    total = taskUsage.reduce((n, u) => n + (u.costUsd ?? 0), 0),
    unknown = taskUsage.some((u) => u.costUsd === null),
    limit = project?.config.costs.taskBudgetUsd;
  const loadArtifact = async (meta: Artifact) => {
    const text = await act<string>('artifact.read', { id: meta.id });
    if (text !== undefined) setArtifact({ meta, content: text });
  };
  return (
    <div className="desktop">
      <header className="titlebar">
        <div className="brand">
          <img src="./dogfood.svg" alt="" />
          <strong>dogfood</strong>
          <span>Build something worth shipping.</span>
        </div>
        <button className="command-key" onClick={() => setPalette(true)}>
          Jump to a task <kbd>⌘ K</kbd>
        </button>
        <button className="theme-toggle" aria-label="Toggle theme" onClick={() => setDark(!dark)}>
          {dark ? '☀' : '☾'}
        </button>
      </header>
      <aside className="sidebar">
        <div className="project-picker">
          <label>
            Project
            <select
              aria-label="Project"
              value={projectId}
              onChange={(e) => {
                setProjectId(e.target.value);
                setTaskId('');
              }}
            >
              <option value="">Choose a project</option>
              {state.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <button title="Add project" aria-label="Add project" onClick={() => setDialog('project')}>
            +
          </button>
        </div>
        <nav>
          {[
            ['work', 'Workspace'],
            ['ideas', 'Ideas & specifications'],
            ['platform', 'Platform'],
            ['connections', 'Connections'],
          ].map(([key, title]) => (
            <button
              key={key}
              className={view === key ? 'selected' : ''}
              onClick={() => setView(key)}
            >
              <Icon name={key} />
              {title}
              {key === 'work' && <small>{tasks.length}</small>}
            </button>
          ))}
        </nav>
        <div className="sidebar-heading">
          <span>Tasks</span>
          <button aria-label="New task" disabled={!project} onClick={() => setDialog('task')}>
            +
          </button>
        </div>
        <input
          className="task-search"
          aria-label="Filter tasks"
          placeholder="Find a task…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="task-list">
          {tasks.map((t) => (
            <button
              key={t.id}
              className={`task-link ${t.id === taskId ? 'selected' : ''}`}
              onClick={() => selectTask(t)}
            >
              <span className={`status-dot ${t.status}`} />
              <span>
                {t.title}
                <small>{label(t.status)}</small>
              </span>
              {state.activeTasks.includes(t.id) && <span className="running-ring" />}
            </button>
          ))}
          {!tasks.length && (
            <p className="sidebar-empty">
              Ideas become tasks.
              <br />
              Each task gets its own space.
            </p>
          )}
        </div>
        <div className="sidebar-bottom">
          <button disabled={!project} onClick={() => setView('project')}>
            Project settings <span>⚙</span>
          </button>
          <span className="local-label">
            <i /> Saved on this Mac
          </span>
        </div>
      </aside>
      <main className="main">
        {(error || notice) && (
          <div role={error ? 'alert' : 'status'} className={`banner ${error ? 'error' : 'notice'}`}>
            <span>{error || notice}</span>
            <button
              onClick={() => {
                setError('');
                setNotice('');
              }}
              aria-label="Dismiss message"
            >
              ×
            </button>
          </div>
        )}
        {view === 'connections' ? (
          <Connections settings={state.settings} act={act} onNotice={setNotice} />
        ) : view === 'platform' ? (
          <Platform act={act} />
        ) : view === 'project' && project ? (
          <ProjectSettings project={project} act={act} />
        ) : view === 'ideas' && project ? (
          <Ideas
            project={project}
            ideas={state.ideas.filter((i) => i.projectId === project.id)}
            act={act}
          />
        ) : !task || !project ? (
          <section className="welcome">
            <div className="welcome-mark">
              <img src="./dogfood.svg" alt="Dogfood" />
            </div>
            <p className="quiet">Your local development workspace</p>
            <h1>
              From the first idea
              <br />
              to “it works.”
            </h1>
            <p>
              Plan the change. Give it a worktree. Build, test, and try it here.
              <br />
              Your code, decisions, and history stay together.
            </p>
            <div className="welcome-actions">
              <button className="primary" onClick={() => setDialog(project ? 'task' : 'project')}>
                <Icon name="plus" />
                {project ? 'Create a task' : 'Open your first project'}
              </button>
              {project && <button onClick={() => setView('ideas')}>Start with an idea</button>}
            </div>
            <div className="journey">
              {['Describe', 'Plan', 'Build', 'Test', 'Review', 'Ship'].map((stage, index) => (
                <React.Fragment key={stage}>
                  <span>
                    <b>{index + 1}</b>
                    {stage}
                  </span>
                  {index < 5 && <i />}
                </React.Fragment>
              ))}
            </div>
            <p className="welcome-note">
              No cluster required. Choose Codex or Claude when you’re ready.
            </p>
          </section>
        ) : (
          <>
            <div className="task-header">
              <div>
                <div className="breadcrumb">
                  {project.name}
                  <span>/</span>
                  {task.branch ?? 'New task'}
                </div>
                <h1>{task.title}</h1>
                <div className="task-meta">
                  <span className={`status-pill ${task.status}`}>{label(task.status)}</span>
                  <span>
                    {project.config.costs.primary.harness} ·{' '}
                    {project.config.costs.primary.model || 'default model'}
                  </span>
                </div>
              </div>
              <div className="header-actions">
                {active ? (
                  <button className="danger" onClick={() => taskAction('pause')}>
                    Pause task
                  </button>
                ) : (
                  <>
                    <button
                      onClick={() => {
                        setDock('preview');
                        setView('work');
                      }}
                      disabled={busy}
                    >
                      <Icon name="play" />
                      Run locally
                    </button>
                    {task.status === 'ready' ? (
                      <button className="primary" onClick={() => setDialog('deliver')}>
                        Deliver change <Icon name="arrow" />
                      </button>
                    ) : task.status === 'awaiting-review' ? (
                      <button className="primary" onClick={() => setTab('checks')}>
                        Review results
                      </button>
                    ) : task.planHash ? (
                      <button
                        className="primary"
                        disabled={busy}
                        onClick={() => taskAction('implement')}
                      >
                        Implement plan
                      </button>
                    ) : task.plan ? (
                      <button
                        className="primary"
                        disabled={busy || plan !== task.plan}
                        onClick={() => taskAction('approve-plan')}
                      >
                        Approve plan
                      </button>
                    ) : (
                      <button
                        className="primary"
                        disabled={busy}
                        onClick={() => taskAction('plan')}
                      >
                        Generate plan
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
            <div className="task-body">
              <div className="work-area">
                <div className="tabs">
                  {[
                    ['plan', 'Plan'],
                    ['files', 'Files'],
                    ['changes', 'Changes'],
                    ['checks', 'Checks & review'],
                    ['history', 'History'],
                    ['costs', 'Usage'],
                  ].map(([key, title]) => (
                    <button
                      key={key}
                      className={tab === key ? 'active' : ''}
                      onClick={() => setTab(key)}
                    >
                      {title}
                    </button>
                  ))}
                </div>
                <section className="work-content">
                  {tab === 'plan' && (
                    <div className="plan-view">
                      <div className="section-line">
                        <h2>Implementation plan</h2>
                        <button
                          disabled={active || busy || plan === task.plan}
                          onClick={() => void act('task.update', { id: taskId, plan })}
                        >
                          Save plan
                        </button>
                      </div>
                      <p className="task-description">{task.description}</p>
                      {task.acceptance && (
                        <div className="acceptance">
                          <strong>Acceptance criteria</strong>
                          <p>{task.acceptance}</p>
                        </div>
                      )}
                      <textarea
                        aria-label="Implementation plan"
                        className="plan-editor"
                        value={plan}
                        onChange={(e) => setPlan(e.target.value)}
                        disabled={active}
                        placeholder="Generate a plan with your agent, or write your own. Include the change, relevant files, and how you will prove it works."
                      />
                      <div className="plan-footnote">
                        {task.planHash
                          ? '✓ Plan approved. Changes require a new approval.'
                          : 'Review the plan before giving the agent permission to implement.'}
                      </div>
                      <div className="utility-actions">
                        <button disabled={active} onClick={() => taskAction('prepare')}>
                          Prepare worktree
                        </button>
                        <button disabled={active} onClick={() => taskAction('setup')}>
                          Run setup
                        </button>
                        <button disabled={active} onClick={() => taskAction('plan')}>
                          Regenerate plan
                        </button>
                      </div>
                    </div>
                  )}
                  {tab === 'files' && (
                    <div className="files-view">
                      <div className="file-tree">
                        {fileList.map((path) => (
                          <button
                            className={file === path ? 'selected' : ''}
                            key={path}
                            onClick={() =>
                              void act<{ content: string; hash: string }>('file.read', {
                                id: taskId,
                                path,
                              }).then((result) => {
                                if (result) {
                                  setFile(path);
                                  setContent(result.content);
                                  setFileHash(result.hash);
                                }
                              })
                            }
                            title={path}
                          >
                            {path}
                          </button>
                        ))}
                      </div>
                      <div className="file-content">
                        {file ? (
                          <>
                            <div className="file-bar">
                              <code>{file}</code>
                              <button
                                disabled={active || !task.worktree}
                                onClick={() =>
                                  void act('file.write', {
                                    id: taskId,
                                    path: file,
                                    content,
                                    hash: fileHash,
                                  }).then(async (result) => {
                                    if (result) {
                                      const next = await api.call<{ hash: string }>('file.read', {
                                        id: taskId,
                                        path: file,
                                      });
                                      setFileHash(next.hash);
                                      setNotice(
                                        'File saved. Validation evidence must be refreshed.',
                                      );
                                    }
                                  })
                                }
                              >
                                Save file
                              </button>
                            </div>
                            <Editor
                              path={file}
                              value={content}
                              onChange={setContent}
                              readOnly={active || !task.worktree}
                              dark={dark}
                            />
                          </>
                        ) : (
                          <div className="inner-empty">
                            Choose a source file.
                            <small>
                              {task.worktree
                                ? 'Edits stay in this task’s worktree.'
                                : 'Prepare a worktree to enable editing.'}
                            </small>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                  {tab === 'changes' && (
                    <div className="diff-view">
                      <div className="section-line">
                        <h2>Changes from base</h2>
                        <button disabled={active} onClick={() => taskAction('rebase')}>
                          Update from base
                        </button>
                      </div>
                      {changes ? (
                        <pre>
                          {changes.split('\n').map((line, index) => (
                            <div
                              className={
                                line.startsWith('+')
                                  ? 'added'
                                  : line.startsWith('-')
                                    ? 'removed'
                                    : ''
                              }
                              key={index}
                            >
                              {line || ' '}
                            </div>
                          ))}
                        </pre>
                      ) : (
                        <div className="inner-empty">No source changes yet.</div>
                      )}
                    </div>
                  )}
                  {tab === 'checks' && (
                    <div className="checks-view">
                      <div className="section-line">
                        <h2>Evidence before delivery</h2>
                        <div className="inline-actions">
                          <button
                            disabled={active || !task.worktree}
                            onClick={() => taskAction('validate')}
                          >
                            Run checks
                          </button>
                          <button
                            disabled={active || !task.validatedHash}
                            onClick={() => taskAction('review')}
                          >
                            Review code
                          </button>
                        </div>
                      </div>
                      <div className="gate-strip">
                        <span className={task.validatedHash ? 'passed' : ''}>
                          {task.validatedHash ? '✓' : '○'} Validation
                        </span>
                        <span className={task.reviewedHash && !task.reviewBlocking ? 'passed' : ''}>
                          {task.reviewedHash && !task.reviewBlocking ? '✓' : '○'} Code review
                        </span>
                        <span className={task.approvedHash ? 'passed' : ''}>
                          {task.approvedHash ? '✓' : '○'} Your approval
                        </span>
                      </div>
                      {state.runs
                        .filter((r) => r.taskId === taskId && r.harness === 'local')
                        .slice(-12)
                        .map((run) => (
                          <div className="check-row" key={run.id}>
                            <span className={`status-dot ${run.status}`} />
                            <strong>{run.stage}</strong>
                            <span>{label(run.status)}</span>
                            <small>{time(run.startedAt)}</small>
                          </div>
                        ))}
                      {task.review && (
                        <>
                          <h3>Agent review</h3>
                          <pre className="review-text">{task.review}</pre>
                        </>
                      )}
                      {task.reviewBlocking && (
                        <p className="warning-text">
                          Blocking findings remain. Fix them, then validate and review again.
                        </p>
                      )}
                      <div className="utility-actions">
                        <button
                          className="primary"
                          disabled={
                            active ||
                            !task.reviewedHash ||
                            task.reviewBlocking ||
                            !!task.approvedHash
                          }
                          onClick={() => taskAction('approve-review')}
                        >
                          Approve reviewed changes
                        </button>
                        <button disabled={active} onClick={() => taskAction('rca')}>
                          Investigate root cause
                        </button>
                      </div>
                      {task.prNumber && (
                        <>
                          <h3>GitHub pull request</h3>
                          <div className="inline-actions">
                            <button
                              onClick={() => void act('github.status', { id: taskId }).then(setPr)}
                            >
                              Refresh PR #{task.prNumber}
                            </button>
                            <button onClick={() => setDialog('pr-comment')}>Add comment</button>
                            <button onClick={() => setDialog('pr-merge')}>
                              Merge pull request
                            </button>
                          </div>
                          {pr && <pre>{JSON.stringify(pr, null, 2)}</pre>}
                        </>
                      )}
                    </div>
                  )}
                  {tab === 'history' && (
                    <div className="history-view">
                      <div className="section-line">
                        <h2>Task history</h2>
                        <button onClick={() => void act('export.choose', { id: taskId })}>
                          Export task
                        </button>
                      </div>
                      {state.artifacts
                        .filter((a) => a.taskId === taskId)
                        .slice()
                        .reverse()
                        .map((meta) => (
                          <button
                            className="artifact-row"
                            key={meta.id}
                            onClick={() => void loadArtifact(meta)}
                          >
                            <span className="artifact-icon">
                              <Icon name={meta.kind === 'test' ? 'check' : 'code'} />
                            </span>
                            <span>
                              <strong>{meta.title}</strong>
                              <small>{label(meta.kind)}</small>
                            </span>
                            <time>{time(meta.createdAt)}</time>
                          </button>
                        ))}
                    </div>
                  )}
                  {tab === 'costs' && <UsageView usage={taskUsage} project={project} />}
                </section>
                <div className="dock">
                  <div className="dock-tabs">
                    {['logs', 'terminal', 'preview'].map((key) => (
                      <button
                        className={dock === key ? 'active' : ''}
                        key={key}
                        onClick={() => setDock(key)}
                      >
                        {label(key)}
                      </button>
                    ))}
                    <span />
                    {dock === 'preview' && (
                      <>
                        <small>{previewUrl}</small>
                        <button onClick={() => void act('preview.capture')}>Capture</button>
                        <button
                          onClick={() => {
                            void act('run.stop', { id: taskId });
                            setDock('logs');
                          }}
                        >
                          Stop app
                        </button>
                      </>
                    )}
                  </div>
                  {dock === 'logs' ? (
                    <pre className="log-output">
                      {logs[taskId] ||
                        'Command and agent output appears here. Full run evidence is saved in History.'}
                    </pre>
                  ) : dock === 'terminal' ? (
                    <Terminal taskId={taskId} onError={setError} />
                  ) : (
                    <div ref={previewHost} className="preview-host">
                      <span>Starting local application…</span>
                    </div>
                  )}
                </div>
              </div>
              <aside className="agent-panel">
                <div className="agent-heading">
                  <div className="agent-avatar">
                    <Icon name="code" />
                  </div>
                  <div>
                    <strong>Task companion</strong>
                    <small>{active ? 'Working in your worktree' : 'Ready when you are'}</small>
                  </div>
                  {active && <span className="running-ring" />}
                </div>
                <div className="agent-scroll">
                  {task.error && <div className="agent-error">{task.error}</div>}
                  {state.approvals
                    .filter((a) => a.taskId === taskId)
                    .map((approval) => (
                      <div className="approval-card" key={approval.id}>
                        <strong>{approval.title}</strong>
                        <pre>{approval.detail}</pre>
                        <div className="inline-actions">
                          <button
                            onClick={() =>
                              void act('approval.respond', { id: approval.id, accept: false })
                            }
                          >
                            Decline
                          </button>
                          <button
                            className="primary"
                            onClick={() =>
                              void act('approval.respond', { id: approval.id, accept: true })
                            }
                          >
                            Allow
                          </button>
                        </div>
                      </div>
                    ))}
                  {logs[taskId] ? (
                    <pre className="conversation-output">{logs[taskId]}</pre>
                  ) : (
                    <div className="agent-empty">
                      <Icon name="ideas" />
                      <h3>A little context goes a long way.</h3>
                      <p>
                        Your agent works from this task’s plan, acceptance criteria, and repository
                        instructions.
                      </p>
                      <p>Start with a plan, then follow the changes here.</p>
                    </div>
                  )}
                </div>
                <form
                  className="guidance"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void act('agent.input', { id: taskId, text: guidance }).then(() =>
                      setGuidance(''),
                    );
                  }}
                >
                  <textarea
                    aria-label="Message agent"
                    placeholder={
                      active
                        ? 'Add guidance or answer a question…'
                        : 'Guidance is saved with this task…'
                    }
                    value={guidance}
                    onChange={(e) => setGuidance(e.target.value)}
                  />
                  <button disabled={!guidance.trim() || busy} aria-label="Send guidance">
                    ↑
                  </button>
                </form>
                <div className="cost-footer">
                  <span>
                    Balanced <i>·</i>{' '}
                    {unknown ? 'Cost incomplete' : taskUsage.length ? money(total) : 'No usage yet'}
                  </span>
                  <button onClick={() => setTab('costs')}>
                    {limit ? `${money(total)} / ${money(limit)}` : 'No $ cap'}
                  </button>
                </div>
              </aside>
            </div>
          </>
        )}
      </main>
      {dialog && (
        <Modal
          title={
            {
              project: 'Bring a project to Dogfood',
              task: 'Give your change a task',
              deliver: 'Deliver reviewed changes',
              'pr-comment': 'Add a pull request comment',
              'pr-merge': 'Merge this pull request',
            }[dialog] ?? 'Dogfood'
          }
          close={() => setDialog('')}
        >
          {dialog === 'project' ? (
            <ProjectDialog
              act={act}
              done={(p) => {
                setProjectId(p.id);
                setDialog('');
                setView('project');
              }}
            />
          ) : dialog === 'task' ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const data = new FormData(event.currentTarget);
                void act<Task>('task.create', {
                  projectId,
                  title: data.get('title'),
                  description: data.get('description'),
                  acceptance: data.get('acceptance'),
                }).then((t) => {
                  if (t) {
                    selectTask(t);
                    setDialog('');
                  }
                });
              }}
            >
              <label>
                Task name
                <input name="title" autoFocus required placeholder="Add a search field" />
              </label>
              <label>
                What should change?
                <textarea name="description" required rows={4} />
              </label>
              <label>
                How will you know it works?
                <textarea
                  name="acceptance"
                  rows={3}
                  placeholder="Acceptance criteria and important edge cases"
                />
              </label>
              <button className="primary" disabled={busy}>
                Create task
              </button>
            </form>
          ) : dialog === 'deliver' ? (
            <>
              <p>Deliver the exact source snapshot that passed checks and review.</p>
              <div className="dialog-choice">
                <button
                  onClick={() => {
                    taskAction('merge');
                    setDialog('');
                  }}
                >
                  <strong>Merge locally</strong>
                  <span>Fast-forward the clean base branch.</span>
                </button>
                <button
                  onClick={() => {
                    taskAction('publish');
                    setDialog('');
                  }}
                >
                  <strong>Create GitHub PR</strong>
                  <span>Push the task branch and publish review evidence.</span>
                </button>
              </div>
            </>
          ) : dialog === 'pr-comment' ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const data = new FormData(e.currentTarget);
                void act('github.comment', { id: taskId, text: data.get('text') }).then(() =>
                  setDialog(''),
                );
              }}
            >
              <label>
                Comment
                <textarea name="text" required rows={6} />
              </label>
              <button className="primary">Post comment</button>
            </form>
          ) : (
            <>
              <p>
                Merge PR #{task?.prNumber} using GitHub’s required checks and branch protections.
              </p>
              <button
                className="primary"
                onClick={() => void act('github.merge', { id: taskId }).then(() => setDialog(''))}
              >
                Merge pull request
              </button>
            </>
          )}
        </Modal>
      )}
      {artifact && (
        <Modal title={artifact.meta.title} close={() => setArtifact(undefined)}>
          {artifact.meta.kind === 'screenshot' ? (
            <img
              className="evidence-image"
              src={artifact.content}
              alt="Saved local application preview"
            />
          ) : (
            <pre className="artifact-content">{artifact.content}</pre>
          )}
        </Modal>
      )}
      {palette && (
        <Modal title="Jump to a task" close={() => setPalette(false)}>
          <input
            autoFocus
            placeholder="Search all tasks"
            aria-label="Search all tasks"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="palette-results">
            {state.tasks
              .filter((t) => t.title.toLowerCase().includes(query.toLowerCase()))
              .map((t) => (
                <button
                  key={t.id}
                  onClick={() => {
                    selectTask(t);
                    setPalette(false);
                    setQuery('');
                  }}
                >
                  {t.title}
                  <small>{label(t.status)}</small>
                </button>
              ))}
          </div>
        </Modal>
      )}
    </div>
  );
}
function Modal({
  title,
  close,
  children,
}: {
  title: string;
  close: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
    return () => ref.current?.close();
  }, []);
  return (
    <dialog ref={ref} className="modal" onCancel={close}>
      <div className="modal-heading">
        <h2>{title}</h2>
        <button aria-label="Close dialog" onClick={close}>
          ×
        </button>
      </div>
      {children}
    </dialog>
  );
}
type Act = <T = unknown>(
  method: string,
  params?: Record<string, unknown>,
) => Promise<T | undefined>;
function ProjectDialog({ act, done }: { act: Act; done: (project: Project) => void }) {
  const [mode, setMode] = useState('open'),
    [path, setPath] = useState(''),
    [url, setUrl] = useState(''),
    [waiting, setWaiting] = useState(false);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setWaiting(true);
        void act<Project>(`project.${mode === 'open' ? 'add' : mode}`, { path, url })
          .then((p) => {
            if (p) done(p);
          })
          .finally(() => setWaiting(false));
      }}
    >
      <div className="segmented">
        {[
          ['open', 'Open existing'],
          ['create', 'Create new'],
          ['clone', 'Clone GitHub'],
        ].map(([key, text]) => (
          <button
            type="button"
            key={key}
            className={mode === key ? 'active' : ''}
            onClick={() => setMode(key)}
          >
            {text}
          </button>
        ))}
      </div>
      <p className="muted">
        {mode === 'create'
          ? 'Start with a TypeScript and React application, with unit and browser tests.'
          : 'Your repository stays on disk. Task changes live in separate worktrees.'}
      </p>
      {mode === 'clone' && (
        <label>
          Repository URL
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            type="url"
            required
            placeholder="https://github.com/team/project"
          />
        </label>
      )}
      <label>
        {mode === 'open' ? 'Repository directory' : 'Empty destination directory'}
        <div className="input-action">
          <input
            aria-label="Repository directory"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            required
            placeholder="/Users/you/Projects/my-app"
          />
          <button
            type="button"
            onClick={() =>
              void api.call<string | null>('dialog.directory').then((p) => {
                if (p) setPath(p);
              })
            }
          >
            Browse
          </button>
        </div>
      </label>
      <button className="primary" disabled={waiting}>
        {waiting
          ? 'Preparing project…'
          : mode === 'create'
            ? 'Create application'
            : mode === 'clone'
              ? 'Clone repository'
              : 'Open project'}
      </button>
    </form>
  );
}
function Ideas({ project, ideas, act }: { project: Project; ideas: Idea[]; act: Act }) {
  const [selected, setSelected] = useState(''),
    [spec, setSpec] = useState('');
  const idea = ideas.find((i) => i.id === selected);
  useEffect(() => setSpec(idea?.spec ?? ''), [idea?.id, idea?.spec]);
  return (
    <section className="page">
      <div className="page-heading">
        <div className="breadcrumb">{project.name}</div>
        <h1>Start with an idea.</h1>
        <p>Capture the outcome. Shape the specification. Break it into work.</p>
      </div>
      <div className="ideas-layout">
        <div>
          <form
            className="surface"
            onSubmit={(e) => {
              e.preventDefault();
              const form = e.currentTarget,
                data = new FormData(form);
              void act<Idea>('idea.create', {
                projectId: project.id,
                title: data.get('title'),
                description: data.get('description'),
              }).then((i) => {
                if (i) {
                  setSelected(i.id);
                  form.reset();
                }
              });
            }}
          >
            <h2>New idea</h2>
            <label>
              Title
              <input name="title" required placeholder="Make reporting easier" />
            </label>
            <label>
              Describe the outcome
              <textarea
                name="description"
                rows={6}
                required
                placeholder="Who is this for? What should improve? Include constraints and references."
              />
            </label>
            <button className="primary">Save idea</button>
          </form>
          <div className="idea-list">
            {ideas.map((i) => (
              <button
                key={i.id}
                className={selected === i.id ? 'selected' : ''}
                onClick={() => setSelected(i.id)}
              >
                <Icon name="ideas" />
                <span>
                  {i.title}
                  <small>{i.spec ? 'Specification drafted' : 'Ready to explore'}</small>
                </span>
              </button>
            ))}
          </div>
        </div>
        <div className="surface spec-surface">
          {idea ? (
            <>
              <div className="section-line">
                <h2>{idea.title}</h2>
                <button className="primary" onClick={() => void act('idea.spec', { id: idea.id })}>
                  Generate specification & tasks
                </button>
              </div>
              <p>{idea.description}</p>
              <textarea
                aria-label="Specification"
                value={spec}
                onChange={(e) => setSpec(e.target.value)}
                placeholder="Your editable specification will appear here."
              />
              <button onClick={() => void act('idea.update', { id: idea.id, spec })}>
                Save specification
              </button>
            </>
          ) : (
            <div className="inner-empty">
              Choose an idea to develop it.
              <small>Specifications and generated tasks are stored locally.</small>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
function ProjectSettings({ project, act }: { project: Project; act: Act }) {
  const [config, setConfig] = useState(JSON.stringify(project.config, null, 2)),
    [localError, setLocalError] = useState('');
  useEffect(() => setConfig(JSON.stringify(project.config, null, 2)), [project.id, project.config]);
  return (
    <section className="page narrow">
      <div className="page-heading">
        <div className="breadcrumb">{project.name}</div>
        <h1>Project settings</h1>
        <p>
          Review commands before executing them. This configuration is saved as dogfood.yaml in the
          repository.
        </p>
      </div>
      <div className="surface">
        <h2>Commands, agents, and spending</h2>
        <p className="muted">
          Use argument arrays. Development commands can use <code>{'{port}'}</code> and{' '}
          <code>{'{data}'}</code>. Choose explicit models before setting dollar budgets.
        </p>
        <div className="policy-summary">
          <span>Balanced routing</span>
          <span>Plan + final approval</span>
          <span>2 concurrent tasks</span>
        </div>
        {(() => {
          let parsed: ProjectConfig;
          try {
            parsed = JSON.parse(config);
          } catch {
            return null;
          }
          const update = (costs: Partial<ProjectConfig['costs']>) =>
            setConfig(JSON.stringify({ ...parsed, costs: { ...parsed.costs, ...costs } }, null, 2));
          return (
            <>
              <div className="two-columns">
                <label>
                  Main harness
                  <select
                    value={parsed.costs.primary.harness}
                    onChange={(e) =>
                      update({
                        primary: {
                          ...parsed.costs.primary,
                          harness: e.target.value as 'codex' | 'claude',
                        },
                      })
                    }
                  >
                    <option value="codex">Codex</option>
                    <option value="claude">Claude Code</option>
                  </select>
                </label>
                <label>
                  Main model
                  <input
                    value={parsed.costs.primary.model}
                    placeholder="Harness default"
                    onChange={(e) =>
                      update({ primary: { ...parsed.costs.primary, model: e.target.value } })
                    }
                  />
                </label>
              </div>
              <div className="two-columns">
                <label>
                  Task budget (USD)
                  <input
                    type="number"
                    min="0.01"
                    step="0.01"
                    placeholder="No dollar cap"
                    value={parsed.costs.taskBudgetUsd ?? ''}
                    onChange={(e) =>
                      update({ taskBudgetUsd: e.target.value ? Number(e.target.value) : undefined })
                    }
                  />
                </label>
                <label>
                  Daily project budget (USD)
                  <input
                    type="number"
                    min="0.01"
                    step="0.01"
                    placeholder="No dollar cap"
                    value={parsed.costs.dailyBudgetUsd ?? ''}
                    onChange={(e) =>
                      update({
                        dailyBudgetUsd: e.target.value ? Number(e.target.value) : undefined,
                      })
                    }
                  />
                </label>
              </div>
              <label>
                Worker model
                <input
                  value={parsed.costs.worker?.model ?? ''}
                  placeholder="Optional cheaper model; same harness"
                  onChange={(e) =>
                    update({
                      worker: e.target.value
                        ? {
                            harness: parsed.costs.primary.harness,
                            model: e.target.value,
                            effort: 'low',
                          }
                        : undefined,
                    })
                  }
                />
              </label>
              <label>
                Worker routing
                <select
                  value={String(parsed.costs.workerRouting)}
                  onChange={(e) => update({ workerRouting: e.target.value === 'true' })}
                >
                  <option value="false">Disabled — qualify with representative tasks first</option>
                  <option value="true" disabled={!parsed.costs.worker}>
                    Enable qualified worker
                  </option>
                </select>
              </label>
              <h3>Local commands</h3>
              <p className="muted">
                {parsed.setup.length} setup steps · {parsed.checks.length} acceptance checks ·{' '}
                {parsed.dev?.name ?? 'No development server'}. Edit commands and argument arrays
                below.
              </p>
            </>
          );
        })()}
        <details>
          <summary>Advanced project configuration</summary>
          <label>
            Project configuration
            <textarea
              className="config-editor"
              aria-label="Project configuration"
              value={config}
              onChange={(e) => setConfig(e.target.value)}
              spellCheck={false}
            />
          </label>
        </details>
        {localError && <p role="alert">{localError}</p>}
        <button
          className="primary"
          onClick={() => {
            try {
              setLocalError('');
              void act('project.configure', { id: project.id, config: JSON.parse(config) });
            } catch (error) {
              setLocalError(String(error));
            }
          }}
        >
          Save project settings
        </button>{' '}
        <button onClick={() => void act('project.commit-config', { id: project.id })}>
          Commit saved configuration
        </button>
        <p className="fine-print">
          Worker routing is initially disabled. Enable it only after comparing the chosen worker
          against your acceptance tests. Missing cost data is never counted as zero.
        </p>
      </div>
      <div className="surface">
        <h2>Repository</h2>
        <code>{project.path}</code>
        <p>
          Base branch: {project.baseBranch}. Worktrees separate source changes; they do not sandbox
          local processes.
        </p>
      </div>
    </section>
  );
}
function Connections({
  settings,
  act,
  onNotice,
}: {
  settings: Settings;
  act: Act;
  onNotice: (message: string) => void;
}) {
  const [value, setValue] = useState(settings),
    [key, setKey] = useState(''),
    [token, setToken] = useState(''),
    [prices, setPrices] = useState(JSON.stringify(settings.prices, null, 2)),
    [diagnostics, setDiagnostics] = useState(''),
    [localError, setLocalError] = useState('');
  useEffect(() => setValue(settings), [settings]);
  const field = (name: keyof Settings) => (
    <input
      value={String(value[name] ?? '')}
      onChange={(e) => setValue({ ...value, [name]: e.target.value })}
    />
  );
  return (
    <section className="page narrow">
      <div className="page-heading">
        <h1>Connections</h1>
        <p>Your tools. Your accounts. Project context goes only to providers you approve.</p>
      </div>
      <form
        className="surface"
        onSubmit={(e) => {
          e.preventDefault();
          try {
            setLocalError('');
            void act('settings.save', {
              settings: { ...value, prices: JSON.parse(prices) },
              secrets: {
                ...(key ? { claudeKey: key } : {}),
                ...(token ? { platformToken: token } : {}),
              },
            }).then((result) => {
              if (result) {
                setKey('');
                setToken('');
                onNotice('Connections saved securely on this Mac.');
              }
            });
          } catch (error) {
            setLocalError(String(error));
          }
        }}
      >
        <h2>Coding harnesses</h2>
        <div className="two-columns">
          <label>Codex executable{field('codexPath')}</label>
          <label>Claude executable{field('claudePath')}</label>
        </div>
        <label>
          Claude connection
          <select
            value={value.claudeProvider}
            onChange={(e) =>
              setValue({ ...value, claudeProvider: e.target.value as Settings['claudeProvider'] })
            }
          >
            <option value="api">Supported local authentication / API key</option>
            <option value="bedrock">Amazon Bedrock</option>
            <option value="vertex">Google Vertex AI</option>
          </select>
        </label>
        {value.claudeProvider === 'api' ? (
          <label>
            Claude API key
            <input
              type="password"
              autoComplete="off"
              value={key}
              placeholder={
                settings.hasClaudeKey
                  ? 'Saved securely; leave blank to keep'
                  : 'Optional when supported local authentication is configured'
              }
              onChange={(e) => setKey(e.target.value)}
            />
          </label>
        ) : (
          <div className="two-columns">
            <label>Region{field('region')}</label>
            {value.claudeProvider === 'vertex' && (
              <label>Google Cloud project{field('vertexProject')}</label>
            )}
          </div>
        )}
        <p className="fine-print">
          Dogfood uses supported harness authentication and cloud credential chains. It does not
          extract subscription tokens. Sign-in can open your system browser or run in the task
          terminal.
        </p>
        <h2>Model pricing</h2>
        <p className="muted">
          Optional USD rates per million tokens. Enter exact model identifiers and a pricing date.
          Dollar-capped tasks require matching rates. Subscription charges are not inferred.
        </p>
        <label>
          Pricing records
          <textarea
            className="pricing-editor"
            aria-label="Pricing records"
            value={prices}
            onChange={(e) => setPrices(e.target.value)}
            spellCheck={false}
          />
        </label>
        <details>
          <summary>Pricing record format</summary>
          <pre>
            {JSON.stringify(
              [
                {
                  provider: 'codex',
                  model: 'your-model-id',
                  input: 0,
                  cached: 0,
                  cacheWrite: 0,
                  output: 0,
                  date: new Date().toISOString().slice(0, 10),
                },
              ],
              null,
              2,
            )}
          </pre>
          <p>Replace zeroes with the provider’s verified rates before saving.</p>
        </details>
        <h2>Optional platform</h2>
        <label>Lifecycle API URL{field('platformUrl')}</label>
        <label>
          Platform token
          <input
            type="password"
            value={token}
            autoComplete="off"
            placeholder={
              settings.hasPlatformToken
                ? 'Saved securely'
                : 'Local or configured service credential'
            }
            onChange={(e) => setToken(e.target.value)}
          />
        </label>
        {localError && <p role="alert">{localError}</p>}
        <div className="inline-actions">
          <button className="primary">Save connections</button>
          <button
            type="button"
            onClick={() =>
              void act('connections.check').then((r) => setDiagnostics(JSON.stringify(r, null, 2)))
            }
          >
            Check installed tools
          </button>
        </div>
        {diagnostics && <pre className="diagnostics">{diagnostics}</pre>}
      </form>
      <div className="surface">
        <h2>Your local data</h2>
        <p>
          Back up task history, usage, and evidence. Repository files and worktrees should be backed
          up separately. Credentials are excluded.
        </p>
        <div className="inline-actions">
          <button
            onClick={() =>
              void act<string>('backup.choose').then((path) => {
                if (path) onNotice(`Backup saved: ${path}`);
              })
            }
          >
            Back up history
          </button>
          <button onClick={() => void act('backup.restore.choose')}>Restore history</button>
        </div>
      </div>
    </section>
  );
}
function UsageView({ usage, project }: { usage: State['usage']; project: Project }) {
  const sum = (key: 'input' | 'cached' | 'cacheWrite' | 'output') =>
      usage.reduce((n, u) => n + (u[key] ?? 0), 0),
    cost = usage.reduce((n, u) => n + (u.costUsd ?? 0), 0),
    unknown = usage.some((u) => u.costUsd === null);
  return (
    <div className="usage-view">
      <div className="section-line">
        <h2>Every call counts.</h2>
        <span className="badge">Balanced</span>
      </div>
      <p className="muted">
        Includes workers, retries, review, and context preparation. No savings percentage is shown
        without a measured baseline.
      </p>
      <div className="usage-total">
        <strong>{money(cost)}</strong>
        <span>
          {unknown
            ? 'Known cost subtotal · some usage is unpriced'
            : usage.length
              ? 'Reported or estimated usage cost'
              : 'No paid calls recorded'}
          <small>
            {project.config.costs.taskBudgetUsd
              ? `Task limit ${money(project.config.costs.taskBudgetUsd)} · pause on exhaustion`
              : 'No dollar cap configured'}
          </small>
        </span>
      </div>
      <div className="usage-metrics">
        {[
          ['input', 'Uncached input'],
          ['cached', 'Cache reads'],
          ['cacheWrite', 'Cache writes'],
          ['output', 'Output'],
        ].map(([key, name]) => (
          <div key={key}>
            <strong>{sum(key as any).toLocaleString()}</strong>
            <span>{name}</span>
          </div>
        ))}
      </div>
      <table>
        <thead>
          <tr>
            <th>Model</th>
            <th>Input / output</th>
            <th>Cost</th>
            <th>Basis</th>
          </tr>
        </thead>
        <tbody>
          {usage.map((u) => (
            <tr key={u.id}>
              <td>{u.model || `${u.provider} default`}</td>
              <td>
                {u.input ?? '?'} / {u.output ?? '?'}
              </td>
              <td>{u.costUsd === null ? 'Unknown' : money(u.costUsd)}</td>
              <td>
                {u.costKind}
                {u.pricingDate && <small>{u.pricingDate}</small>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="cost-note">
        <strong>Budget enforcement</strong>
        <p>
          Dogfood stops scheduling paid work at your limit. External harness usage can arrive late;
          in-flight calls can exceed the threshold. Unknown cost pauses dollar-capped tasks.
        </p>
      </div>
      <div className="cost-note">
        <strong>Current optimization policy</strong>
        <p>
          Targeted retrieval, bounded tool results, local execution, reusable source summaries, and
          stable context.{' '}
          {project.config.costs.workerRouting
            ? 'Approved worker routing is enabled.'
            : 'Worker routing awaits project qualification.'}
        </p>
      </div>
    </div>
  );
}
function Platform({ act }: { act: Act }) {
  const [data, setData] = useState<any>(),
    [path, setPath] = useState('/environments');
  return (
    <section className="page">
      <div className="page-heading">
        <h1>Platform</h1>
        <p>
          Connect existing deployment services when you need them. The desktop workspace runs
          independently.
        </p>
      </div>
      <div className="surface">
        <div className="inline-actions">
          <select
            aria-label="Platform resource"
            value={path}
            onChange={(e) => setPath(e.target.value)}
          >
            {['/environments', '/operations', '/policies', '/tools'].map((p) => (
              <option key={p} value={p}>
                {label(p.slice(1))}
              </option>
            ))}
          </select>
          <button
            className="primary"
            onClick={() => void act('platform.request', { path }).then(setData)}
          >
            Load platform data
          </button>
          <button onClick={() => void api.call('external.open', { url: 'http://localhost:3000' })}>
            Open browser portal
          </button>
        </div>
        {data ? (
          <pre className="platform-data">{JSON.stringify(data, null, 2)}</pre>
        ) : (
          <div className="inner-empty">
            Configure the lifecycle API in Connections.
            <small>Existing preview and release controls remain in the optional portal.</small>
          </div>
        )}
      </div>
    </section>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
