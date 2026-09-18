import React, { useEffect, useState } from 'react';
import type { Project, Task } from '../shared';
import { Editor } from './Editor';
import { CreationHistory } from './ReferenceProject';

type Act = <T = unknown>(
  method: string,
  params?: Record<string, unknown>,
) => Promise<T | undefined>;
export type FileDraft = { content: string; original: string; hash: string };
export type WorkspaceDrafts = Record<string, Record<string, FileDraft>>;

export function Workspaces({
  projects,
  tasks,
  act,
  open,
  add,
  drafts,
}: {
  projects: Project[];
  tasks: Task[];
  act: Act;
  open: (project: Project, view: string) => void;
  add: () => void;
  drafts: WorkspaceDrafts;
}) {
  const [removing, setRemoving] = useState(''),
    [waiting, setWaiting] = useState(false);
  return (
    <section className="page workspace-library">
      <div className="page-heading workspace-heading">
        <div>
          <h1>Workspaces</h1>
          <p>Open a project, edit its settings, or remove it from this list.</p>
        </div>
        <button className="primary" onClick={add}>
          Add workspace
        </button>
      </div>
      {!projects.length && (
        <div className="surface">
          <h2>No workspaces yet</h2>
          <p>Create a project or open an existing repository to get started.</p>
        </div>
      )}
      <div className="workspace-list">
        {projects.map((project) => {
          const count = tasks.filter(
            (task) => task.projectId === project.id && task.status !== 'archived',
          ).length;
          const dirty = Object.values(drafts[project.id] ?? {}).some(
            (draft) => draft.content !== draft.original,
          );
          return (
            <article className="workspace-row" key={project.id} aria-label={project.name}>
              <div className="workspace-row-heading">
                <div className="workspace-summary">
                  <h2>{project.name}</h2>
                  <code>{project.path}</code>
                  <p className="muted">
                    {project.baseBranch} · {count} {count === 1 ? 'task' : 'tasks'}
                  </p>
                </div>
                <div className="inline-actions">
                  <button onClick={() => open(project, 'overview')}>Open workspace</button>
                  <button onClick={() => open(project, 'project')}>Edit workspace</button>
                  <button
                    className="danger"
                    disabled={waiting || dirty}
                    title={dirty ? 'Save or discard unsaved file edits first.' : undefined}
                    onClick={() => setRemoving(project.id)}
                  >
                    Remove workspace
                  </button>
                </div>
              </div>
              {removing === project.id && (
                <div
                  className="workspace-removal"
                  role="group"
                  aria-label={`Remove ${project.name}`}
                >
                  <p>
                    Remove <strong>{project.name}</strong> from Dogfood? Repository files,
                    worktrees, and history are kept. Open the same folder again to restore this
                    workspace.
                  </p>
                  <div className="inline-actions">
                    <button
                      className="danger"
                      disabled={waiting || dirty}
                      onClick={() => {
                        setWaiting(true);
                        void act<boolean>('project.remove', { id: project.id })
                          .then((removed) => {
                            if (removed) setRemoving('');
                          })
                          .finally(() => setWaiting(false));
                      }}
                    >
                      {waiting ? 'Removing…' : 'Confirm removal'}
                    </button>
                    <button disabled={waiting} onClick={() => setRemoving('')}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}

export function WorkspaceOverview({
  project,
  tasks,
  edit,
  browse,
  createTask,
  selectTask,
}: {
  project: Project;
  tasks: Task[];
  edit: () => void;
  browse: () => void;
  createTask: () => void;
  selectTask: (task: Task) => void;
}) {
  return (
    <section className="page workspace-overview">
      <div className="page-heading workspace-heading">
        <div>
          <h1>{project.name}</h1>
          <p>{project.path}</p>
        </div>
        <button onClick={edit}>Edit workspace</button>
      </div>
      <div className="surface">
        <h2>Repository</h2>
        <p>
          Base branch: <strong>{project.baseBranch}</strong>
        </p>
        <div className="inline-actions">
          <button onClick={browse}>Browse files</button>
          <button className="primary" onClick={createTask}>
            Create a task
          </button>
        </div>
      </div>
      <CreationHistory projectId={project.id} />
      <div className="surface">
        <h2>Tasks</h2>
        {!tasks.length && (
          <p className="muted">
            No tasks yet. Browse your project files or create a task to work on a change.
          </p>
        )}
        {tasks.map((task) => (
          <button className="workspace-task" key={task.id} onClick={() => selectTask(task)}>
            <strong>{task.title}</strong>
            <span>{task.status.replaceAll('-', ' ')}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

export function WorkspaceName({ project, act }: { project: Project; act: Act }) {
  const [name, setName] = useState(project.name),
    [waiting, setWaiting] = useState(false);
  useEffect(() => setName(project.name), [project.id, project.name]);
  return (
    <form
      className="surface"
      onSubmit={(event) => {
        event.preventDefault();
        if (waiting) return;
        setWaiting(true);
        void act('project.rename', { id: project.id, name }).finally(() => setWaiting(false));
      }}
    >
      <h2>Workspace details</h2>
      <label>
        Workspace name
        <input
          required
          maxLength={120}
          value={name}
          disabled={waiting}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <p className="muted">{project.path}</p>
      <button disabled={waiting || !name.trim() || name.trim() === project.name}>
        Save workspace name
      </button>
    </form>
  );
}

export function WorkspaceFiles({
  project,
  drafts,
  updateDraft,
  dark,
  active,
  settings,
}: {
  project: Project;
  drafts: Record<string, FileDraft>;
  updateDraft: (path: string, draft: FileDraft) => void;
  dark: boolean;
  active: boolean;
  settings: () => void;
}) {
  const [paths, setPaths] = useState<string[]>([]),
    [path, setPath] = useState(''),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(false),
    [saving, setSaving] = useState(false),
    [revision, setRevision] = useState(0);
  const draft = drafts[path],
    dirty = !!draft && draft.content !== draft.original;
  useEffect(() => {
    let cancelled = false;
    setError('');
    void window.dogfood
      .call<string[]>('project.files', { id: project.id })
      .then((files) => {
        if (!cancelled) setPaths(files);
      })
      .catch((error) => {
        if (!cancelled) setError(String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [project.id, revision]);
  useEffect(() => {
    if (!path || drafts[path]) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    void window.dogfood
      .call<{ content: string; hash: string }>('project.read-file', { id: project.id, path })
      .then((file) => {
        if (!cancelled) updateDraft(path, { ...file, original: file.content });
      })
      .catch((error) => {
        if (!cancelled) setError(String(error));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [project.id, path]);
  const readOnly = active || saving || path === 'dogfood.yaml';
  return (
    <section className="page workspace-files">
      <div className="page-heading workspace-heading">
        <div>
          <div className="breadcrumb">{project.name}</div>
          <h1>Workspace files</h1>
          <p>
            Save edits directly to this repository. Use a task for changes in an isolated worktree.
          </p>
        </div>
        <button onClick={() => setRevision((value) => value + 1)}>Refresh files</button>
      </div>
      {error && (
        <p role="alert" className="agent-error">
          {error}
        </p>
      )}
      {active && (
        <p className="muted">
          Stop active tasks and local applications before saving repository edits.
        </p>
      )}
      <div className="workspace-editor surface">
        <div className="file-tree" aria-label="Workspace file list">
          {paths.map((file) => (
            <button
              className={path === file ? 'selected' : ''}
              title={file}
              key={file}
              onClick={() => {
                setLoading(false);
                setPath(file);
              }}
            >
              {file}
              {drafts[file] && drafts[file].content !== drafts[file].original ? ' *' : ''}
            </button>
          ))}
          {!paths.length && <p className="muted">No files to display.</p>}
        </div>
        <div className="file-content">
          {path && (
            <div className="file-bar">
              <code>
                {path}
                {dirty ? ' · Unsaved changes' : ''}
              </code>
              <div className="inline-actions">
                {path === 'dogfood.yaml' ? (
                  <button onClick={settings}>Edit in Project settings</button>
                ) : (
                  <button
                    disabled={!dirty || readOnly}
                    onClick={() => {
                      setSaving(true);
                      setError('');
                      void window.dogfood
                        .call<{ content: string; hash: string }>('project.write-file', {
                          id: project.id,
                          path,
                          content: draft.content,
                          hash: draft.hash,
                        })
                        .then((file) => updateDraft(path, { ...file, original: file.content }))
                        .catch((error) => setError(String(error)))
                        .finally(() => setSaving(false));
                    }}
                  >
                    {saving ? 'Saving…' : 'Save file'}
                  </button>
                )}
                <button
                  disabled={saving || loading}
                  onClick={() => {
                    setLoading(true);
                    setError('');
                    void window.dogfood
                      .call<{ content: string; hash: string }>('project.read-file', {
                        id: project.id,
                        path,
                      })
                      .then((file) => updateDraft(path, { ...file, original: file.content }))
                      .catch((error) => setError(String(error)))
                      .finally(() => setLoading(false));
                  }}
                >
                  {dirty ? 'Discard edits and reload' : 'Reload file'}
                </button>
              </div>
            </div>
          )}
          {loading ? (
            <p className="inner-empty">Loading file…</p>
          ) : draft ? (
            <Editor
              key={path}
              path={path}
              value={draft.content}
              dark={dark}
              readOnly={readOnly}
              onChange={(content) => updateDraft(path, { ...draft, content })}
            />
          ) : (
            <p className="inner-empty">Choose a file to view or edit.</p>
          )}
        </div>
      </div>
    </section>
  );
}
