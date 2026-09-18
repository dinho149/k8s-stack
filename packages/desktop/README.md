# Dogfood desktop

A macOS workspace for the path from idea to reviewed code. It runs independently of the Kubernetes platform: open a Git repository, create a task, approve its plan, implement in a worktree, run acceptance checks, try the application locally, and approve delivery.

## Run

From the repository root, with Git, Node 22.13–25, npm, Python 3.9+, and Xcode Command Line Tools installed:

```sh
npm ci
make desktop
```

`make desktop` builds the app, rebuilds the terminal module for Electron, and opens Dogfood. No Docker, Kubernetes cluster, image, lifecycle credentials, or cloud infrastructure is required. Install Codex or Claude Code separately and select their executable in **Connections**. Use supported harness sign-in or an API/cloud connection; Dogfood never extracts subscription tokens. GitHub delivery also requires an authenticated `gh` CLI.

Use `make desktop-open` to launch the existing macOS app without rebuilding. It checks the repository's packaged build first, then your Applications folders.

1. **Open a project**, clone an HTTPS repository, or create an application by choosing a language and framework. Included starters are React or plain web in TypeScript/JavaScript, Python with FastAPI, and Go with its standard HTTP library. Web starters include unit and browser tests; backend starters include API/handler tests. Python projects require Python 3.10+ with pip and venv; Go projects require Go 1.25+. Creation works offline and installs no dependencies; use task setup afterwards. Each starter includes its own commands, instructions, and ignored build/cache files.
2. Use **Workspaces** in the sidebar to see every saved project. **Open workspace** shows its repository and tasks; **Browse files** lets you view and save repository files before creating a task. These edits affect the base checkout directly; use a task for isolated changes. **Edit workspace** opens its name and project settings. **Remove workspace** hides it from Dogfood while keeping repository files, unfinished worktrees, and history; opening the same folder restores it. Stop active tasks, local applications, and terminals before removal.
3. Review **Project settings**. Configure setup, development, and acceptance commands as executable/argument arrays. Save and optionally commit `dogfood.yaml` from the app. Auto-detected npm commands are suggestions, especially for non-Vite development servers.
4. Capture an idea in **Ideas & specifications**, or create a task directly. Generated specifications produce dependent tasks; each task owns a separate branch and worktree. Commit or update the local base before starting dependent work.
5. Generate and approve a plan. Run setup in the worktree to install its dependencies. Choose **Implement plan** to implement, validate, repair failures within the configured limit, and review the actual diff.
6. Use the source editor, changes view, shell, logs, saved evidence, and local browser. Manual terminal input invalidates evidence conservatively. Pause the agent before manual edits.
7. Approve reviewed changes, then merge into the clean local base or create a GitHub PR. Required GitHub checks and reviews must pass before merging a PR. Root-cause analysis saves a proposal for a regression test and rule; it never silently installs new rules.

Two tasks can run concurrently. Tasks with prerequisites wait for those changes to reach the base. Base advancement requires updating the task branch and repeating validation/review. Dirty or unmerged worktrees are preserved. The engine exposes safe archival; retained worktrees can also be managed with Git.

## Create from a reference project

In **Create new**, choose **From a reference project**. Select a local directory, an existing Dogfood workspace, or a GitHub HTTPS repository URL with an optional branch. Local references include current, non-ignored working files. For a monorepo, select the application directory before analysis. GitHub uses your existing Git authentication; authenticate private repositories before retrying a failed fetch.

Enter the new name and destination, select your connected Codex or Claude agent, and choose **Analyze reference**. Review and edit the detected stack, versions, folder structure, naming conventions, and command YAML. This flow supports agent-generated stacks beyond the built-in starters. It captures development conventions, not product features, CI, or deployment infrastructure. Source evidence is bounded and omits dependency/build directories, known credential files, binary/large files, and escaping symlinks. The selected provider receives the captured evidence; the original project is not changed.

**Create and verify** generates a minimal application in the empty destination, installs dependencies, runs the reviewed checks, and verifies local HTTP startup when a development command is configured. Up to two repairs can change application source; tests and approved commands stay fixed. Failed drafts retain files and logs. Fix the environment or files and choose **Retry verification**, or use **Review commands** when command changes are needed. Closing or restarting Dogfood never automatically resumes paid work; return through **Saved creations**. Cancellation preserves generated files.

Successful creation initializes fresh Git history without a remote and opens the new workspace. **Reference setup** in its overview shows provenance and creation evidence. `REFERENCE.md` and `AGENTS.md` preserve the accepted conventions and are included in later task context. This is an independent snapshot, with no automatic reference refresh. Runtime prerequisites must be installed locally; uncertain dependencies or external services are listed in the proposal for review.

Creation jobs, transcripts, and provider usage are persisted separately from task history. Optional creation budgets require a model with configured pricing; missing usage stays unknown and late provider reports can overshoot a limit. Ordinary starter creation remains offline and requires no agent.

## Local data and boundaries

The packaged application stores its database in `~/Library/Application Support/Dogfood/dogfood.sqlite`, with artifacts, worktrees, and per-task application data alongside it. SQLite uses WAL and a versioned schema. Development/test runs can override this with `DOGFOOD_DESKTOP_DATA`. Unfinished runs recover as interrupted; reopening the app never silently resumes paid work.

Credentials supplied in Connections are encrypted through Electron `safeStorage` and are never returned to the renderer. History backups include a consistent database copy and artifacts; they exclude credentials and repository/worktree files. Restoring history retains a copy of the previous database. Back up repositories and worktrees separately. Backup paths to repositories must still exist on the restored machine.

Records are local, but selecting a cloud model sends the relevant task and code context to that model's provider. External harnesses may also keep their own local session history. Dogfood has no telemetry service.

The renderer and local application browser are sandboxed, have no Node access, and use separate sessions. A typed, validated IPC bridge talks to an Electron utility process that owns Git, SQLite, commands, and agents. Source tools reject traversal, Git internals, and escaping symlinks. A private authenticated Unix socket connects Codex's MCP tools to the active task; Claude uses an SDK MCP server.

Worktrees isolate source changes, not arbitrary processes. User-approved commands and agents run with the local user's filesystem permissions and the harness's own sandbox/approval policies. Application data uses `DOGFOOD_TASK_DATA`; development commands receive an allocated `PORT` and support `{port}` and `{data}` argument substitutions. Applications must use these values to isolate their runtime state. Optional Compose projects use distinct task names; Compose resources require explicit teardown.

## Token and cost controls

The balanced policy uses deterministic local search, targeted file reads, bounded logs, stable instructions, saved artifacts, and source-keyed summary caching. Large reads can route to a cheaper reader; bounded boilerplate can route to a writer using an explicit reference. Workers cannot recursively call Dogfood workers. Main implementation and review still inspect relevant source and run the same acceptance gate.

This applies [Spotify's Portal bulk-read and pattern-writing approach](https://engineering.atspotify.com/2026/9/portal-by-spotify-cut-my-claude-code-token-usage-by-90) as optional tools. It does **not** assume a 90% reduction in total task cost. External Codex tools may choose direct reads; Claude's large-read hook directs the agent to targeted reads or the worker. Routing is disabled initially. Configure exact models, approved harnesses, and dated prices before enabling it.

Every Dogfood agent run—including specification, planning, reader/writer workers, repairs, review, and RCA—gets a usage record. Codex cumulative usage is upserted; cache reads/writes and reasoning are not double-counted. Claude's supplied costs are estimates, not invoices. Missing data remains unknown. Adding a matching price can price historical records with known token counts; it cannot reconstruct unreported tokens.

Task and daily project budgets reserve estimated capacity before scheduling. Capped work pauses when prices/usage are missing or the observed budget is exhausted. External harness reports may arrive late, particularly Claude's final usage; calls already in flight can overshoot. The UI states this explicitly. Subscription prices are not inferred. Provider prompt-cache reuse remains controlled by the provider; Dogfood's local summary cache is separate.

Qualify a worker with representative tasks before enabling it. Repeat the same acceptance task at least three times with routing off and three times with it on, then export each task from History. Compare all-run cost, including failures and reviews:

```sh
cd packages/desktop
node scripts/compare-costs.mjs baseline1.json baseline2.json baseline3.json \
  --optimized optimized1.json optimized2.json optimized3.json
```

The offline comparison rejects missing costs, failed evidence, and different acceptance commands. It writes `cost-comparison.json` with measured cost/token averages and reductions. Review quality still requires inspection. No benchmark or paid model call starts automatically.

## Validation and packaging

```sh
make test-desktop       # deterministic engine tests; no paid calls
make test-desktop-ui    # actual Electron journey using a fixture Codex protocol
make desktop-build
node --import tsx packages/desktop/scripts/smoke-starter.ts
make desktop-package   # macOS arm64 and x64 DMG/ZIP artifacts
```

Reference-creation tests use fixture agents and GitHub fetches, exercise local and remote references, review edits, bounded repairs, restart recovery, and retry without losing user edits. Live model quality requires a separate test with your connected provider.

The Electron test covers the real utility process, authenticated MCP bridge, source editor, terminal, local preview and capture, saved application logs, approval gates, merge, and restart persistence. Set `DOGFOOD_TEST_PACKAGED` to a packaged `Dogfood.app/Contents/MacOS/Dogfood` executable when invoking Playwright to run the same journey against the bundle in a temporary profile. The starter smoke test generates all six starters, runs their configured setup and checks, verifies local preview startup and shutdown, and checks that generated caches/build outputs remain ignored. The macOS CI job runs these checks. Model quality and paid provider behavior require a separate live smoke test with your approved account.

Installers are built in `packages/desktop/release`. Distribution signing/notarization requires your Apple Developer identity and normal electron-builder credentials; local packaging does not manufacture them. DeepSeek and Archon are extension references, not bundled services or claimed integrations. The harness adapter interface supports adding another backend without moving local task ownership into it.

The existing portal, Kubernetes environments, lifecycle API, and release workflows remain available through the optional Platform connection.
