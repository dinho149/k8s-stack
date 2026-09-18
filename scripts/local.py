#!/usr/bin/env python3
"""Make's local development interface. Python standard library only."""
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import time
import textwrap
import threading
import urllib.error
import urllib.request
import webbrowser

ROOT = Path(__file__).resolve().parent.parent
STATE = ROOT / '.dogfood'
LOGS = STATE / 'logs'
ENV = {key: value for key, value in os.environ.items() if value}
COLOR = sys.stdout.isatty() and 'NO_COLOR' not in os.environ and ENV.get('TERM') != 'dumb'
SERVICES = {
    'api': (8088, ['bin/dogfood', 'serve'], ROOT),
    'backend': (7007, ['../../node_modules/.bin/tsx', 'src/index.ts', '--config', '../../app-config.local.yaml'], ROOT / 'packages/backend'),
    'portal': (3000, ['../../node_modules/.bin/vite', '--host', '127.0.0.1', '--strictPort'], ROOT / 'packages/portal'),
    'agent': (8090, ['node_modules/.bin/tsx', 'services/agent/src/server.ts'], ROOT),
}
CHILDREN = {}
GROUPS = {
    'Start here': {'help': 'Show commands and examples', 'setup': 'Install project dependencies and Chromium', 'doctor': 'Check local prerequisites', 'up': 'Start the complete local stack in the background', 'open': 'Open the portal'},
    'Manage services': {'status': 'Show health and URLs', 'logs': 'Follow logs [SERVICE=all|api|backend|portal|agent|database|registry]', 'stop': 'Stop app services, preserving the cluster', 'restart': 'Restart app services', 'down': 'Delete previews and local cluster; retain database/registry data', 'reset': 'Delete all local data CONFIRM=dogfood-local', 'clean': 'Remove build and test artifacts', 'local': 'Bootstrap only the local cluster', 'portal': 'Run the frontend in the foreground', 'agent': 'Start the optional agent', 'agent-stop': 'Stop the agent'},
    'Previews': {'sample-build': 'Build and record the sample image digest', 'preview-up': 'Create preview NAME=demo [IMAGE=… REVISION=…]', 'preview-status': 'List previews or inspect NAME=demo', 'preview-down': 'Request deletion NAME=demo [CONFIRMATION=…]', 'preview-retry': 'Redeploy NAME=demo [IMAGE=… REVISION=…]', 'preview-extend': 'Extend NAME=demo MINUTES=30', 'preview-diagnostics': 'Inspect Kubernetes diagnostics NAME=demo'},
    'Checks': {'build': 'Build Go and npm workspaces', 'typecheck': 'Check TypeScript', 'format': 'Format source and infrastructure', 'format-check': 'Check source and infrastructure formatting', 'lint': 'Check formatting, Go, TypeScript and shell syntax', 'test-fast': 'Run Go, agent, orchestration and portal tests', 'test-scoped': 'Run the test lane', 'test': 'Run lint, tests and Helm checks', 'ship-gate': 'Run all CI checks and builds', 'test-portal': 'Run browser tests', 'test-agent': 'Run agent unit tests', 'test-local': 'Run local orchestration tests', 'browser-install': 'Install Chromium [WITH_DEPS=1]', 'audit': 'Audit npm dependencies', 'infra-validate': 'Validate all OpenTofu modules'},
    'Teleport': {'teleport-up': 'Deploy Teleport into the local cluster (also: make up TELEPORT=1)', 'teleport-deploy': 'pulumi up only [STACK=local PULUMI_ARGS=…]', 'teleport-preview': 'pulumi preview --diff [STACK=… CI_PREVIEW=1]', 'teleport-wait': 'Wait until the Teleport proxy, auth and operator are ready', 'teleport-down': 'Destroy the Teleport stack; keep the cluster', 'teleport-status': 'Teleport dashboard: pods, inventory, requests, your session', 'teleport-doctor': 'Check the Teleport toolchain (pulumi, tsh, expect, mkcert)', 'teleport-urls': 'Every Teleport URL you can open', 'teleport-login': 'tsh login without prompts [USER_NAME=admin|alice|bob TSH_RELOGIN=1]', 'teleport-web-login': 'Open the Teleport web UI and print the credentials [USER_NAME=admin]', 'teleport-tctl': 'Run tctl in the auth pod ARGS="get roles"', 'teleport-requests': 'List access requests', 'teleport-approve': 'Approve a request ID=… [REASON=…]', 'teleport-deny': 'Deny a request ID=… REASON=…', 'teleport-agent-cli': 'Chat with the access agent in the terminal [AS=alice]', 'teleport-logs': 'Follow Teleport logs [SVC=auth|proxy|operator|kube-agent|ssh|postgres|broker|mcp|agent]', 'teleport-port-forward': 'Port-forward an access service SVC=mcp|broker|agent (18380/18381/18382)', 'teleport-tls': 'Browser-trusted certificate for the local proxy via mkcert', 'teleport-github-sso': 'Store GitHub OAuth App credentials for STACK (prompts)', 'teleport-claude-token': 'Store a Claude subscription token for the in-cluster agent', 'teleport-tsh': 'Download tsh/tctl/tbot into ./bin', 'teleport-images': 'Build the Teleport service images and load them into kind [IMAGE_TAG=dev]', 'teleport-bootstrap-users': 'Enrol local users headlessly [USERS=admin,alice,bob]', 'teleport-bootstrap-admin': 'Rotate the local break-glass admin credentials', 'teleport-seed-test-users': 'Headless password+TOTP enrolment for alice/bob', 'teleport-render': 'Render the Teleport CRs offline and validate them with kubeconform', 'teleport-test': 'Teleport integration + tsh end-to-end tests against the live cluster', 'teleport-test-integration': 'Go integration tests against the live cluster', 'teleport-test-e2e': 'tsh end-to-end scenarios', 'teleport-hooks': 'Install the pre-commit + pre-push git hooks', 'teleport-secrets-guard': 'Refuse non-local stacks that still use the file backend / default passphrase'},
    'Optional tools': {'catalog-check': 'Resolve pinned charts', 'catalog-sync': 'Install catalog REPOSITORY=https://…', 'tool-routes': 'Install routes [TOOLS=argocd,grafana,keycloak]', 'benchmark': 'Measure previews [RUNS=30 CONCURRENCY=5]', 'benchmark-report': 'Summarize measurements', 'test-isolation': 'Check isolation between two running previews'},
}


PALETTE = {
    'accent': '38;5;141', 'bright': '1;97', 'muted': '38;5;245',
    'line': '38;5;238', 'green': '38;5;114', 'yellow': '38;5;221',
    'red': '38;5;203', 'blue': '38;5;117',
}


def ink(text, tone='muted'):
    return f'\033[{PALETTE.get(tone, tone)}m{text}\033[0m' if COLOR else text


def width():
    return max(32, min(shutil.get_terminal_size((80, 24)).columns - 4, 100))


def rule():
    print('  ' + ink('─' * width(), 'line'))


def heading(title, subtitle=''):
    print()
    print('  ' + ink('▰', 'accent') + ink(' DOGFOOD', 'bright') + ink('  /  ') + title)
    if subtitle:
        for line in textwrap.wrap(subtitle, width() - 2):
            print('    ' + ink(line))
    rule()
    print()


def section(title):
    print('  ' + ink(title.upper(), 'accent'))


def hint(message):
    for line in textwrap.wrap(message, width()):
        print('  ' + ink(line))


def say(message, style='36'):
    tone = {'36': 'blue', '32': 'green', '31': 'red', '33': 'yellow', '1;32': 'green', '1;36': 'accent', '1': 'bright'}.get(style, style)
    print(ink(message, tone), flush=True)


@contextlib.contextmanager
def progress(label):
    started = time.monotonic()
    animated = COLOR and ENV.get('VERBOSE') != '1'
    done = threading.Event()
    def line(symbol, tone, elapsed):
        available = width() - len(elapsed) - 5
        title = textwrap.shorten(label, width=max(10, available), placeholder='…')
        gap = max(2, width() - len(title) - len(elapsed) - 3)
        return '  ' + ink(symbol, tone) + ' ' + ink(title, 'bright') + ' ' * gap + ink(elapsed)
    def animate():
        frames = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
        i = 0
        while not done.is_set():
            print('\r\033[2K' + line(frames[i % len(frames)], 'accent', f'{time.monotonic() - started:.1f}s'), end='', flush=True)
            i += 1
            done.wait(.1)
    worker = None
    if animated:
        worker = threading.Thread(target=animate, daemon=True)
        worker.start()
    else:
        print('  ' + ink('›', 'accent') + ' ' + label, flush=True)
    success = False
    try:
        yield
        success = True
    finally:
        done.set()
        if worker:
            worker.join()
        prefix = '\r\033[2K' if animated else ''
        print(prefix + line('✓' if success else '×', 'green' if success else 'red', f'{time.monotonic() - started:.1f}s'), flush=True)


def redact(text):
    for key, value in ENV.items():
        if len(value) >= 8 and any(word in key.upper() for word in ('TOKEN', 'PASSWORD', 'SECRET', 'DATABASE_URL')):
            text = text.replace(value, '[redacted]')
    return text


def capture(args, **kwargs):
    kwargs.setdefault('timeout', 30)
    return subprocess.check_output(args, cwd=ROOT, env=ENV, text=True, stderr=subprocess.PIPE, **kwargs).strip()


def run(label, args, cwd=ROOT):
    LOGS.mkdir(parents=True, exist_ok=True)
    path = LOGS / (re.sub(r'[^a-z0-9]+', '-', label.lower()).strip('-') + '.log')
    with progress(label):
        with path.open('w') as log:
            proc = subprocess.Popen(args, cwd=cwd, env=ENV, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            try:
                for line in proc.stdout:
                    line = redact(line)
                    log.write(line)
                    log.flush()
                    if ENV.get('VERBOSE') == '1':
                        print(line, end='', flush=True)
                code = proc.wait()
            except BaseException:
                proc.terminate()
                proc.wait()
                raise
            finally:
                proc.stdout.close()
        if code:
            excerpt = '\n'.join(path.read_text().splitlines()[-20:])
            raise RuntimeError(f'{label} failed (exit {code}).\n{excerpt}\nFull log: {path}\nRetry with VERBOSE=1 after resolving the error.')


def command_row(name, description, column=26):
    if width() < 58:
        print('  ' + ink('make ' + name, 'bright'))
        for line in textwrap.wrap(description, width() - 3):
            print('     ' + ink(line))
    else:
        lines = textwrap.wrap(description, max(16, width() - column - 2)) or ['']
        print('  ' + ink(('make ' + name).ljust(column), 'bright') + '  ' + ink(lines[0]))
        for line in lines[1:]:
            print('  ' + ' ' * (column + 2) + ink(line))


def help_text(all_commands=False):
    heading('local development', 'Your workspace, from first boot to final check.')
    if all_commands:
        for group, commands in GROUPS.items():
            section(group)
            for name, description in commands.items():
                command_row(name, description, 26)
            print()
    else:
        section('Get started')
        for name, description in [('setup', 'Install dependencies'), ('up', 'Launch your local stack'), ('open', 'Open the portal')]:
            command_row(name, description)
        print()
        section('Everyday workflow')
        for name, description in [('status', 'See what’s running'), ('logs', 'Follow service logs'), ('restart', 'Restart application services'), ('test', 'Run the development checks'), ('down', 'Remove cluster · keep database data')]:
            command_row(name, description)
        print()
        section('Explore')
        for name, description in [('help-all', 'Every command and option'), ('doctor', 'Find and fix setup problems'), ('preview-up NAME=demo', 'Create a preview environment')]:
            command_row(name, description, 26)
        print()
    rule()
    hint('README.md  ·  Setup, examples & troubleshooting')
    hint('VERBOSE=1  Show details     NO_COLOR=1  Plain output')
    print()


def error_panel(message):
    print()
    section('Needs attention')
    for paragraph in redact(message).splitlines():
        for line in textwrap.wrap(paragraph, width() - 4) or ['']:
            print('  ' + ink('│', 'red') + ' ' + line)
    print()



@contextlib.contextmanager
def locked():
    STATE.mkdir(exist_ok=True)
    with (STATE / 'local.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('Another local operation is running. Wait for it to finish, then retry.')
        yield


def credentials(create=False):
    path = STATE / 'local.env'
    if create and not path.exists() and shutil.which('docker') and container('dogfood-backstage-db'):
        raise RuntimeError('Database exists but .dogfood/local.env is missing. Restore the credentials or run make reset CONFIRM=dogfood-local.')
    if create and not path.exists():
        STATE.mkdir(exist_ok=True)
        with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as out:
            for key in ('DOGFOOD_LOCAL_TOKEN', 'DOGFOOD_SERVICE_TOKEN', 'BACKSTAGE_DB_PASSWORD'):
                out.write(f'export {key}={secrets.token_hex(32)}\n')
    for file in (ROOT / '.env', path):
        if not file.exists():
            continue
        for line in file.read_text().splitlines():
            tokens = shlex.split(line, comments=True)
            if not tokens:
                continue
            if tokens[0] == 'export':
                tokens = tokens[1:]
            if len(tokens) != 1 or '=' not in tokens[0]:
                raise RuntimeError(f'{file}: use one KEY=value per line; shell expressions are unsupported.')
            key, value = tokens[0].split('=', 1)
            if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', key):
                raise RuntimeError(f'Invalid environment key in {file}')
            ENV[key] = value
    if path.exists():
        path.chmod(0o600)
    ENV.pop('DOGFOOD_TOKEN', None)
    ENV.update(DOGFOOD_API_URL='http://127.0.0.1:8088', DOGFOOD_LOCAL_DEVELOPMENT='1', NODE_ENV='development', VITE_LOCAL_DEVELOPMENT='true', DOGFOOD_CONTEXT='kind-dogfood-local', DOGFOOD_NAME='dogfood-local', DOGFOOD_PROFILE='local')
    if ENV.get('BACKSTAGE_DB_PASSWORD'):
        ENV['BACKSTAGE_DATABASE_URL'] = 'postgresql://dogfood:' + ENV['BACKSTAGE_DB_PASSWORD'] + '@127.0.0.1:15432/backstage'
        ENV['POSTGRES_PASSWORD'] = ENV['BACKSTAGE_DB_PASSWORD']


def build_cli():
    binary = ROOT / 'bin/dogfood'
    sources = list((ROOT / 'cmd').rglob('*.go')) + list((ROOT / 'internal').rglob('*.go')) + [ROOT / 'go.mod', ROOT / 'go.sum']
    if not binary.exists() or any(p.stat().st_mtime > binary.stat().st_mtime for p in sources):
        run('Build lifecycle CLI', ['go', 'build', '-o', 'bin/dogfood', './cmd/dogfood'])


def local_config():
    build_cli()
    config = json.loads(capture(['bin/dogfood', 'config']))
    expected = {'provider': 'kind', 'profile': 'local', 'name': 'dogfood-local', 'context': 'kind-dogfood-local', 'listen': '127.0.0.1:8088', 'statePath': '.dogfood/state.db'}
    if any(config.get(key) != value for key, value in expected.items()):
        raise RuntimeError('Local Make commands require the default dogfood-local configuration. Restore the local settings in platform.yaml; cloud operations use their deployment workflow.')
    return config


def port_busy(port):
    with socket.socket() as sock:
        return sock.connect_ex(('127.0.0.1', port)) == 0


def record_path(service):
    return STATE / (service + '.process.json')


def identity(pid):
    try:
        # macOS's Python launcher changes the executable path after exec.
        # Keep start time and arguments, excluding that unstable first argv item.
        parts = capture(['ps', '-p', str(pid), '-o', 'lstart=', '-o', 'command=']).split(maxsplit=6)
        return ' '.join(parts[:5] + parts[6:])
    except subprocess.CalledProcessError:
        return ''


def alive(service):
    path = record_path(service)
    if not path.exists():
        return False
    try:
        data = json.loads(path.read_text())
        return bool(data['identity']) and identity(data['pid']) == data['identity'] and os.getpgid(data['pid']) == data['pid']
    except (KeyError, ValueError, OSError):
        return False


def healthy(service):
    port = SERVICES[service][0]
    route = '/healthz' if service in ('api', 'agent') else '/.backstage/health/v1/readiness' if service == 'backend' else '/'
    try:
        with urllib.request.urlopen(f'http://127.0.0.1:{port}{route}', timeout=2) as response:
            return response.status == 200
    except (OSError, urllib.error.URLError):
        return False


def tool_version_error(name, version):
    if name == 'go' and not re.search(r'go1\.(?:2[5-9]|[3-9]\d)', version):
        return 'Go 1.25+ required'
    if name == 'node':
        constraint = json.loads((ROOT / 'package.json').read_text())['engines']['node']
        bounds = re.fullmatch(r'>=(\d+) <(\d+)', constraint)
        parsed = re.fullmatch(r'v(\d+)\.\d+\.\d+', version)
        if not bounds:
            return f'Unrecognized Node engine constraint {constraint!r}; update the doctor range parser'
        if not parsed or not int(bounds[1]) <= int(parsed[1]) < int(bounds[2]):
            return f'Node {constraint} required (package.json engines.node)'
    if name == 'helm' and not re.match(r'^v[34]\.\d+\.\d+(?:\+[^\s]+)?$', version):
        return 'Helm 3 or 4 required'
    return None


def doctor():
    failed = []
    checks = {'go': ('go', 'version'), 'node': ('node', '--version'), 'npm': ('npm', '--version'), 'docker': ('docker', '--version'), 'kind': ('kind', 'version'), 'kubectl': ('kubectl', 'version', '--client'), 'helm': ('helm', 'version', '--short'), 'python3': ('python3', '--version'), 'rg': ('rg', '--version'), 'git': ('git', '--version')}
    for name, command in checks.items():
        if not shutil.which(name):
            failed.append(name + ': missing; see README prerequisites')
            status_row(name, 'missing', 'See README prerequisites')
            continue
        version = capture(command).splitlines()[0]
        prior_failures = len(failed)
        error = tool_version_error(name, version)
        if error:
            failed.append(error)
        status_row(name, 'ready' if len(failed) == prior_failures else 'unsupported', version)
    if shutil.which('docker'):
        try:
            capture(['docker', 'info', '--format', '{{.ServerVersion}}'])
        except subprocess.CalledProcessError:
            failed.append('Docker is unavailable; start Docker Desktop or the Docker daemon')
    for name, (port, _, _) in SERVICES.items():
        if port_busy(port) and not alive(name):
            failed.append(f'Port {port} is occupied by an untracked process ({name}); stop it before make up')
    if shutil.which('docker') and not any('Docker is unavailable' in error for error in failed):
        for name, port in (('dogfood-backstage-db', 15432), ('dogfood-registry', 5005)):
            info = owned(name)
            if port_busy(port) and not (info and info['State']['Running']):
                failed.append(f'Port {port} is occupied; free it before make up')
        clusters = capture(['kind', 'get', 'clusters']).splitlines() if shutil.which('kind') else []
        if 'dogfood-local' not in clusters:
            for port in (18080, 18443, 3080):
                if port_busy(port):
                    failed.append(f'Cluster port {port} is occupied; free it before make up')
    if not failed:
        local_config()
    if failed:
        raise RuntimeError('\n'.join(failed))
    say('  ✓ Local prerequisites ready. Optional checks require OpenTofu.', '32')


def setup():
    for tool in ('go', 'node', 'npm'):
        if not shutil.which(tool):
            raise RuntimeError(f'{tool} is required. See README prerequisites, then run make setup.')
    stamp = STATE / 'dependencies.sha256'
    manifests = [ROOT / 'package-lock.json', ROOT / 'package.json'] + sorted((ROOT / 'packages').glob('*/package.json')) + sorted((ROOT / 'services').glob('*/package.json')) + [ROOT / 'infra/teleport/package.json']
    digest = hashlib.sha256(b''.join(path.read_bytes() for path in manifests) + capture(['node', '--version']).encode()).hexdigest()
    if not (ROOT / 'node_modules/.bin/playwright').exists() or not stamp.exists() or stamp.read_text() != digest:
        run('Install npm dependencies', ['npm', 'ci', '--ignore-scripts'])
        stamp.write_text(digest)
    run('Download Go modules', ['go', 'mod', 'download'])
    browser_install()
    credentials(create=True)


def browser_install():
    args = ['node_modules/.bin/playwright', 'install']
    if ENV.get('WITH_DEPS') == '1':
        args.append('--with-deps')
    run('Install Chromium', args + ['chromium'])


def container(name):
    try:
        return json.loads(capture(['docker', 'inspect', name]))[0]
    except subprocess.CalledProcessError:
        return None


def owned(name):
    info = container(name)
    if info and (info['Config'].get('Labels') or {}).get('dogfood.platform/managed') != 'true':
        raise RuntimeError(f'Refusing unmanaged container {name}. Rename it before retrying.')
    return info


def database():
    if owned('dogfood-backstage-db'):
        run('Start database', ['docker', 'start', 'dogfood-backstage-db'])
    else:
        if port_busy(15432):
            raise RuntimeError('Database port 15432 is occupied.')
        run('Create database', ['docker', 'run', '-d', '--name', 'dogfood-backstage-db', '--label', 'dogfood.platform/managed=true', '-p', '127.0.0.1:15432:5432', '-e', 'POSTGRES_USER=dogfood', '-e', 'POSTGRES_DB=backstage', '-e', 'POSTGRES_PASSWORD', 'postgres:16-alpine'])
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        try:
            capture(['docker', 'exec', 'dogfood-backstage-db', 'pg_isready', '-U', 'dogfood'])
            return
        except subprocess.CalledProcessError:
            time.sleep(1)
    raise RuntimeError('Database did not become ready within 60s. Run make logs SERVICE=database.')


def start(service):
    if alive(service):
        if healthy(service):
            say('  ✓ ' + service + ' already ready', '32')
            return False
        raise RuntimeError(f'{service} is running but unhealthy. Run make logs SERVICE={service}, then make restart.')
    port, args, cwd = SERVICES[service]
    if port_busy(port):
        raise RuntimeError(f'Port {port} is occupied; refusing to start {service}. Run make doctor.')
    LOGS.mkdir(parents=True, exist_ok=True)
    with (LOGS / (service + '.log')).open('a') as log:
        proc = subprocess.Popen([sys.executable, str(ROOT / 'scripts/local.py'), '_service', service], cwd=ROOT, env=ENV, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
    CHILDREN[service] = proc
    record_path(service).write_text(json.dumps({'pid': proc.pid, 'identity': identity(proc.pid)}))
    try:
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            if proc.poll() is not None:
                raise RuntimeError(f'{service} exited during startup')
            if healthy(service):
                say(f'  ✓ {service:10} http://localhost:{port}', '32')
                return True
            time.sleep(1)
        raise RuntimeError(f'{service} readiness timed out after 120s')
    except BaseException:
        stop_service(service)
        excerpt = redact('\n'.join((LOGS / (service + '.log')).read_text().splitlines()[-15:]))
        say(excerpt, '31')
        say(f'  Inspect: make logs SERVICE={service}', '31')
        raise


def stop_service(service):
    if alive(service):
        pid = json.loads(record_path(service).read_text())['pid']
        os.killpg(pid, signal.SIGTERM)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline and alive(service):
            time.sleep(.2)
        if alive(service):
            os.killpg(pid, signal.SIGKILL)
        say('  ✓ Stopped ' + service, '32')
    proc = CHILDREN.pop(service, None)
    if proc is not None:
        proc.wait(timeout=10)
    record_path(service).unlink(missing_ok=True)


def app_start():
    credentials(create=True)
    build_cli()
    database()
    started = []
    try:
        for service in ('api', 'backend', 'portal'):
            if start(service):
                started.append(service)
    except BaseException:
        for service in reversed(started):
            stop_service(service)
        raise


def bootstrap():
    local_config()
    run('Bootstrap local cluster', ['bin/dogfood', 'up', '--bootstrap'])


def sample_build():
    local_config()
    # Script stdout is a machine-readable digest; progress stays in its log.
    run('Build sample image', ['bash', '-c', 'bash scripts/build-sample.sh > .dogfood/sample-image.tmp'])
    digest = (STATE / 'sample-image.tmp').read_text().strip()
    if not re.fullmatch(r'\S+@sha256:[a-f0-9]{64}', digest):
        raise RuntimeError('Sample build did not produce an immutable digest; see .dogfood/logs/build-sample-image.log')
    (STATE / 'sample-image.tmp').replace(STATE / 'sample-image.txt')


def request(path, body=None):
    token = ENV.get('DOGFOOD_LOCAL_TOKEN')
    if not token:
        raise RuntimeError('Local credentials missing. Run make up first.')
    headers = {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'Idempotency-Key': secrets.token_hex(16)}
    req = urllib.request.Request(ENV['DOGFOOD_API_URL'] + '/v1/' + path, data=json.dumps(body).encode() if body is not None else None, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            return json.load(response)
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f'API {exc.code}: {redact(exc.read().decode())}') from exc
    except urllib.error.URLError as exc:
        raise RuntimeError('Lifecycle API unavailable. Run make up or make logs SERVICE=api.') from exc


def wait_operation(operation):
    deadline = time.monotonic() + 1200
    previous_phase = None
    while time.monotonic() < deadline:
        result = request('operations/' + operation['id'])
        phase = result.get('phase') or result['status']
        if phase != previous_phase:
            say('  → Preview operation: ' + phase)
            previous_phase = phase
        if result['status'] == 'succeeded':
            return result
        if result['status'] in ('failed', 'superseded'):
            raise RuntimeError('Preview operation failed: ' + json.dumps(result))
        time.sleep(2)
    raise RuntimeError('Preview operation timed out. Run make preview-status and make logs SERVICE=api.')


def preview(command):
    name = ENV.get('NAME', '')
    if name and not re.fullmatch(r'[a-z][a-z0-9-]{0,39}', name):
        raise RuntimeError('NAME must be a lowercase DNS label, at most 40 characters.')
    if command != 'preview-status' and not name:
        raise RuntimeError(f'Usage: make {command} NAME=demo')
    path = 'environments' + ('/' + name if name else '')
    if command == 'preview-status':
        result = request(path)
    elif command == 'preview-diagnostics':
        result = request(path + '/diagnostics')
    elif command == 'preview-down':
        confirmation = ENV.get('CONFIRMATION')
        if not confirmation:
            result = request(path + '/confirm-delete', {})
            say(f"  Review deletion, then run: make preview-down NAME={name} CONFIRMATION={result['id']}")
        else:
            result = wait_operation(request(path + '/destroy', {'confirmation': confirmation}))
    elif command == 'preview-extend':
        minutes = int(ENV.get('MINUTES', '30'))
        if minutes <= 0:
            raise RuntimeError('MINUTES must be positive')
        env = request(path)
        result = request(path + '/extend', {'mode': 'add', 'minutes': minutes, 'generation': env['generation']})
    else:
        image = ENV.get('IMAGE') or (STATE / 'sample-image.txt').read_text().strip()
        revision = ENV.get('REVISION') or capture(['git', 'rev-parse', 'HEAD'])
        body = {'image': image, 'revision': revision}
        if command == 'preview-up':
            body.update(id=name, profile='preview', warm=True)
            result = wait_operation(request('environments', body))
        else:
            body['generation'] = request(path)['generation']
            result = wait_operation(request(path + '/redeploy', body))
    if command == 'preview-status' and isinstance(result, list):
        print(f"  {'NAME':24} {'STATUS':14} {'REVISION':12} EXPIRES")
        for item in sorted(result, key=lambda item: item['id']):
            print(f"  {item['id']:24} {item['status']:14} {item.get('revision', '')[:10]:12} {item.get('expiresAt', '—')}")
        if not result:
            say('  No previews yet. Run make preview-up NAME=demo.')
    elif command == 'preview-diagnostics':
        print(json.dumps(result, indent=2))
    else:
        for key in ('environmentId', 'id', 'status', 'phase', 'url', 'expiresAt', 'revision', 'image'):
            if result.get(key):
                print(f"  {key:16} {result[key]}")


def down(reset=False):
    local_config()
    if reset and ENV.get('CONFIRM') != 'dogfood-local':
        raise RuntimeError('Reset deletes the cluster, database, registry, credentials and local state. Run make reset CONFIRM=dogfood-local.')
    for service, (port, _, _) in SERVICES.items():
        if port_busy(port) and not alive(service):
            raise RuntimeError(f'Port {port} belongs to an untracked {service} process. Stop its original session before make down or make reset.')
    for name in ('dogfood-backstage-db', 'dogfood-registry'):
        owned(name)
    clusters = capture(['kind', 'get', 'clusters']).splitlines()
    if 'dogfood-local' in clusters and not reset:
        credentials(create=False)
        started = False
        if not alive('api'):
            started = start('api')
        try:
            for env in request('environments'):
                if env.get('status') == 'deleted':
                    continue
                say('  → Delete preview ' + env['id'])
                confirmation = request('environments/' + env['id'] + '/confirm-delete', {})
                wait_operation(request('environments/' + env['id'] + '/destroy', {'confirmation': confirmation['id']}))
        except BaseException:
            if started:
                stop_service('api')
            raise RuntimeError('Preview cleanup failed; cluster retained. Run make up, inspect make preview-status, then retry make down. To discard all local data use make reset CONFIRM=dogfood-local.')
    for service in reversed(SERVICES):
        stop_service(service)
    for name in ('dogfood-backstage-db', 'dogfood-registry'):
        if owned(name):
            run(('Remove ' if reset else 'Stop ') + name, ['docker', 'rm', '-f', '-v', name] if reset else ['docker', 'stop', name])
    if 'dogfood-local' in clusters:
        run('Delete local cluster', ['kind', 'delete', 'cluster', '--name', 'dogfood-local'])
        # The Teleport stack lived in that cluster: its Pulumi state and seeded credentials are meaningless now.
        # The mkcert certificate files (.dogfood/teleport/tls) are kept: they are independent of the cluster.
        for name in ('pulumi', 'state'):
            shutil.rmtree(STATE / 'teleport' / name, ignore_errors=True)
    if reset:
        for path in STATE.iterdir():
            if path.name == 'local.lock':
                continue
            if path.is_dir() and not path.is_symlink():
                shutil.rmtree(path)
            else:
                path.unlink()
    say('  ✓ Local stack removed' + (' and data reset.' if reset else '; database and registry data retained.'), '32')


def status_row(name, state, detail=''):
    tones = {'ready': 'green', 'running': 'green', 'present': 'green', 'unhealthy': 'red', 'untracked': 'yellow', 'unsupported': 'red', 'missing': 'red'}
    tone = tones.get(state, 'muted')
    prefix = '  ' + ink('●', tone) + ' ' + ink(name.ljust(12), 'bright') + ' ' + ink(state.ljust(11), tone)
    if width() >= 64:
        available = max(10, width() - 30)
        print(prefix + '  ' + ink(textwrap.shorten(detail, width=available, placeholder='…')))
    else:
        print(prefix)
        if detail:
            hint('  ' + detail)


def status():
    section('Applications')
    untracked = False
    for service, (port, _, _) in SERVICES.items():
        running = alive(service)
        state = 'ready' if running and healthy(service) else 'unhealthy' if running else 'untracked' if port_busy(port) else 'stopped'
        untracked = untracked or state == 'untracked'
        status_row(service, state, f'http://localhost:{port}' if state != 'stopped' else 'make agent' if service == 'agent' else 'make up')
    print()
    section('Infrastructure')
    if shutil.which('docker'):
        for name, label, detail in [('dogfood-backstage-db', 'PostgreSQL', 'localhost:15432'), ('dogfood-registry', 'Registry', 'localhost:5005')]:
            info = container(name)
            status_row(label, info['State']['Status'] if info else 'absent', detail)
    if shutil.which('kind'):
        clusters = capture(['kind', 'get', 'clusters']).splitlines()
        status_row('Kubernetes', 'present' if 'dogfood-local' in clusters else 'absent', 'dogfood-local')
        teleport_up = (STATE / 'teleport' / 'pulumi').exists() and port_busy(3080)
        status_row('Teleport', 'present' if teleport_up else 'absent', 'https://teleport.127.0.0.1.nip.io:3080 · make teleport-status' if teleport_up else 'make teleport-up')
    print()
    rule()
    if untracked:
        hint('Untracked services belong to another session. Stop that session before make up.')
    hint('make logs  Follow activity     make open  Open portal')
    print()


def logs():
    selection = ENV.get('SERVICE', 'all')
    if selection in ('database', 'registry'):
        name = 'dogfood-backstage-db' if selection == 'database' else 'dogfood-registry'
        if not owned(name):
            raise RuntimeError(f'{name} does not exist. Run make up first.')
        ENV['VERBOSE'] = '1'
        run(selection + ' logs', ['docker', 'logs', '--tail', '30', '--follow', name])
        return
    names = list(SERVICES) if selection == 'all' else [selection]
    if any(name not in SERVICES for name in names):
        raise RuntimeError('SERVICE must be all, api, backend, portal, agent, database, or registry')
    streams = {}
    try:
        for name in names:
            path = LOGS / (name + '.log')
            if path.exists():
                stream = path.open()
                for line in stream.readlines()[-20:]:
                    print(redact(f'  [{name}] {line}'), end='')
                streams[name] = stream
        if not streams:
            raise RuntimeError('No service logs yet. Run make up first.')
        say('  Following logs; Ctrl-C exits without stopping services.')
        while True:
            for name, stream in streams.items():
                for line in stream.readlines():
                    print(redact(f'  [{name}] {line}'), end='', flush=True)
            time.sleep(.25)
    finally:
        for stream in streams.values():
            stream.close()


def checks(command):
    direct = {
        'typecheck': ['npm', 'run', 'typecheck'],
        'test-agent': ['npm', 'run', 'test', '--workspace', '@dogfood/agent'],
        'test-portal': ['npm', 'run', 'test', '--workspace', '@dogfood/portal'],
        'test-local': ['python3', '-m', 'unittest', 'discover', '-s', 'scripts/tests', '-v'],
        'test-teleport': ['npm', 'run', 'test', '--workspace', '@dogfood/teleport-infra', '--workspace', '@dogfood/access-agent'],
        'audit': ['npm', 'audit', '--audit-level=high'],
        'catalog-check': ['python3', 'scripts/catalog-check.py'],
        'test-isolation': ['python3', 'scripts/test-isolation.py'],
    }
    if command in direct:
        run(command, direct[command])
    elif command == 'build':
        run('Build lifecycle CLI', ['go', 'build', '-o', 'bin/dogfood', './cmd/dogfood'])
        run('Build teleport-access', ['go', 'build', '-o', 'bin/teleport-access', './cmd/teleport-access'])
        run('Build workspaces', ['npm', 'run', 'build'])
    elif command in ('format', 'format-check'):
        write = command == 'format'
        run('Go formatting', ['gofmt', '-w', 'cmd', 'internal'] if write else ['bash', '-c', 'files=$(gofmt -l cmd internal); test -z "$files" || { printf "%s\\n" "$files"; exit 1; }'])
        run('Source formatting', ['node_modules/.bin/prettier', '--write' if write else '--check', 'packages', 'services', 'README.md', 'package.json'])
        run('Infrastructure formatting', ['tofu', 'fmt'] + ([] if write else ['-check']) + ['-recursive', 'infra'])
    elif command == 'lint':
        checks('format-check')
        run('Go vet', ['go', 'vet', './cmd/...', './internal/...'])
        checks('typecheck')
        for script in sorted((ROOT / 'scripts').glob('*.sh')):
            run('Shell syntax ' + script.name, ['bash', '-n', str(script)])
        run('Access agent lint', ['npm', 'run', 'lint', '--workspace', '@dogfood/access-agent'])
        teleport_scripts = sorted((ROOT / 'deploy/teleport/scripts').glob('*.sh')) + sorted((ROOT / 'deploy/teleport/scripts/lib').glob('*.sh')) + sorted((ROOT / 'tests/teleport/e2e').glob('*.sh'))
        run('Shell syntax (teleport scripts)', ['bash', '-c', 'for f in "$@"; do bash -n "$f" || exit 1; done', '_'] + [str(s) for s in teleport_scripts])
    elif command in ('test-fast', 'test-scoped'):
        run('Go tests', ['go', 'test', '-race', './cmd/...', './internal/...'])
        checks('test-local')
        checks('test-agent')
        checks('test-teleport')
        checks('test-portal')
    elif command == 'test':
        checks('lint')
        checks('test-fast')
        run('Helm checks', ['helm', 'lint', 'deploy/charts/sample', 'deploy/charts/platform'])
        teleport('teleport-render')
    elif command == 'ship-gate':
        for target in ('test', 'build', 'infra-validate', 'audit'):
            checks(target)
    elif command == 'infra-validate':
        for directory in ('infra/aws', 'infra/gcp', 'infra/data/aws', 'infra/data/gcp'):
            run('Initialize ' + directory, ['tofu', '-chdir=' + directory, 'init', '-backend=false', '-input=false', '-lockfile=readonly'])
            run('Validate ' + directory, ['tofu', '-chdir=' + directory, 'validate'])
    else:
        raise RuntimeError('Unknown command: ' + command)


TELEPORT_SCRIPTS = ROOT / 'deploy/teleport/scripts'


def teleport_env():
    """Environment the Teleport scripts expect (deploy/teleport/scripts/_common.sh reads the same names)."""
    ENV.setdefault('STACK', 'local')
    ENV.update(REPO_ROOT=str(ROOT), KIND_CLUSTER='dogfood-local', KUBE_CONTEXT='kind-dogfood-local')
    ENV.setdefault('PROXY_ADDR', 'teleport.127.0.0.1.nip.io:3080')
    ENV.setdefault('PULUMI_BACKEND_URL', 'file://' + str(STATE / 'teleport' / 'pulumi'))
    if ENV['STACK'] == 'local':
        # The well-known passphrase exists ONLY for the throwaway kind stack; other stacks are refused
        # by deploy/teleport/scripts/secrets-guard.sh unless a real backend + secrets provider is configured.
        ENV.setdefault('PULUMI_CONFIG_PASSPHRASE', 'local-dev')
    ENV.setdefault('UI_LOG_DIR', str(LOGS / 'teleport'))
    ENV.setdefault('TELEPORT_MCP_URL', 'http://127.0.0.1:18380/mcp')
    ENV.setdefault('TELEPORT_BROKER_URL', 'http://127.0.0.1:18381')
    ENV.setdefault('TELEPORT_PORTAL_URL', 'http://127.0.0.1:18383')
    if not COLOR:
        ENV['NO_COLOR'] = '1'
    (LOGS / 'teleport').mkdir(parents=True, exist_ok=True)


def foreground(args, cwd=ROOT):
    """Run an interactive Teleport script in the foreground (it draws its own spinners, tables and boxes)."""
    try:
        subprocess.run(args, cwd=cwd, env=ENV, check=True)
    except subprocess.CalledProcessError as exc:
        raise RuntimeError(f'{Path(args[0]).name} failed (exit {exc.returncode}). Logs in .dogfood/logs/teleport/') from exc


def teleport(command):
    teleport_env()
    script = lambda name: str(TELEPORT_SCRIPTS / name)  # noqa: E731
    if command == 'teleport-up':
        local_config()
        if 'dogfood-local' not in capture(['kind', 'get', 'clusters']).splitlines():
            bootstrap()
        foreground([script('up.sh')])
    elif command == 'teleport-deploy':
        foreground([script('stack-init.sh')])
        foreground([script('pulumi-run.sh'), 'up', ENV['STACK']] + shlex.split(ENV.get('PULUMI_ARGS', '')))
    elif command == 'teleport-preview':
        foreground([script('preview.sh')])
    elif command == 'teleport-wait':
        foreground([script('wait-teleport.sh')])
    elif command == 'teleport-down':
        foreground([script('down.sh')])
    elif command in ('teleport-status', 'teleport-doctor', 'teleport-urls', 'teleport-requests', 'teleport-secrets-guard'):
        foreground([script(command[len('teleport-'):] + '.sh')])
    elif command == 'teleport-login':
        foreground([script('login.sh')] + ([ENV['USER_NAME']] if ENV.get('USER_NAME') else []))
    elif command == 'teleport-web-login':
        foreground([script('web-login.sh')] + ([ENV['USER_NAME']] if ENV.get('USER_NAME') else []))
    elif command == 'teleport-tctl':
        foreground([script('tctl.sh')] + shlex.split(ENV.get('ARGS', '')))
    elif command in ('teleport-approve', 'teleport-deny'):
        verb = command[len('teleport-'):]
        if not ENV.get('ID'):
            raise RuntimeError(f'usage: make {command} ID=<request-id>' + (' [REASON=...]' if verb == 'approve' else ' REASON=...'))
        reason = ENV.get('REASON') or f'{verb}d via make'
        foreground([script('tctl.sh'), 'request', verb, '--reason=' + reason, ENV['ID']])
        say(f'  ✓ {verb}d {ENV["ID"]}', '32')
    elif command == 'teleport-agent-cli':
        foreground([script('agent-cli.sh'), ENV.get('AS', 'admin')] + shlex.split(ENV.get('AGENT_ARGS', '')))
    elif command == 'teleport-logs':
        foreground([script('logs.sh'), ENV.get('SVC', 'auth')])
    elif command == 'teleport-port-forward':
        foreground([script('port-forward.sh'), ENV.get('SVC', 'mcp')])
    elif command == 'teleport-tls':
        ENV['LOCAL_TLS'] = '1'
        foreground([script('local-tls.sh')])
    elif command in ('teleport-github-sso', 'teleport-claude-token'):
        foreground([script('stack-init.sh')])
        foreground([script(command[len('teleport-'):] + '.sh')])
    elif command == 'teleport-tsh':
        foreground([script('install-tsh.sh')])
    elif command == 'teleport-images':
        foreground([script('secrets-guard.sh')])
        foreground([script('load-images.sh'), ENV.get('IMAGE_TAG', 'dev')])
    elif command == 'teleport-bootstrap-users':
        foreground([script('bootstrap-users.sh'), ENV.get('USERS', 'admin,alice,bob')])
    elif command == 'teleport-bootstrap-admin':
        foreground([script('bootstrap-admin.sh'), 'admin'])
    elif command == 'teleport-seed-test-users':
        foreground([script('harness-identity.sh')])
        foreground([script('seed-test-users.sh')])
    elif command == 'teleport-render':
        run('Render Teleport CRs', [script('render-crs.sh')])
    elif command == 'teleport-test-integration':
        foreground([script('harness-identity.sh')])
        ENV.update(TELEPORT_PROXY=ENV['PROXY_ADDR'], HARNESS_IDENTITY=str(STATE / 'teleport' / 'state' / 'harness.identity'), TELEPORT_INSECURE='1')
        foreground(['go', 'test', './tests/teleport/integration/...', '-tags=integration', '-count=1', '-timeout', '15m', '-v'])
    elif command == 'teleport-test-e2e':
        for test in sorted((ROOT / 'tests/teleport/e2e').glob('[0-9]*.sh')):
            foreground(['bash', str(test)])
    elif command == 'teleport-test':
        teleport('teleport-test-integration')
        teleport('teleport-test-e2e')
    elif command == 'teleport-hooks':
        if not shutil.which('pre-commit'):
            raise RuntimeError('pre-commit is not installed: pipx install pre-commit  (or brew install pre-commit)')
        run('Install git hooks', ['pre-commit', 'install', '--hook-type', 'pre-commit', '--hook-type', 'pre-push'])
        say('  ✓ hooks installed — run pre-commit run --all-files once to warm the caches', '32')
    else:
        raise RuntimeError('Unknown command: ' + command)


def dispatch(command):
    if command == 'setup':
        setup()
    elif command == 'doctor':
        doctor()
    elif command == 'up':
        doctor()
        setup()
        bootstrap()
        sample_build()
        app_start()
        if ENV.get('TELEPORT') == '1':
            teleport('teleport-up')
        say('\n  Ready → http://localhost:3000\n  make logs · make status · make down', '1;32')
    elif command == 'local':
        bootstrap()
    elif command == 'sample-build':
        sample_build()
    elif command == 'stop':
        for service in reversed(SERVICES):
            stop_service(service)
    elif command == 'restart':
        local_config()
        setup()
        agent_running = alive('agent')
        for service in reversed(SERVICES):
            stop_service(service)
        app_start()
        if agent_running:
            start('agent')
    elif command in ('down', 'reset'):
        down(command == 'reset')
    elif command == 'status':
        status()
    elif command == 'logs':
        logs()
    elif command == 'open':
        webbrowser.open('http://localhost:3000')
    elif command == 'agent':
        if ENV.get('AGENT_PROVIDER') not in ('bedrock', 'vertex'):
            raise RuntimeError('Configure AGENT_PROVIDER and model access in .env; see README optional agent.')
        provider = ENV['AGENT_PROVIDER']
        required = ('AWS_REGION', 'BEDROCK_MODEL') if provider == 'bedrock' else ('ANTHROPIC_VERTEX_PROJECT_ID', 'CLOUD_ML_REGION', 'VERTEX_MODEL')
        if any(not ENV.get(key) for key in required):
            raise RuntimeError('Agent requires ' + ', '.join(required) + ' in .env; see README.')
        if not healthy('api'):
            raise RuntimeError('Run make up before starting the agent.')
        start('agent')
    elif command == 'agent-stop':
        stop_service('agent')
    elif command == 'portal':
        ENV['VERBOSE'] = '1'
        _, args, cwd = SERVICES['portal']
        run('Portal development server', args, cwd=cwd)
    elif command.startswith('preview-'):
        local_config()
        preview(command)
    elif command == 'browser-install':
        browser_install()
    elif command == 'catalog-sync':
        config = local_config()
        repository = ENV.get('REPOSITORY') or config['repository']
        if 'REPLACE_ME' in repository or not repository.startswith(('https://', 'ssh://', 'git@')):
            raise RuntimeError('Set REPOSITORY to a reachable Git repository: make catalog-sync REPOSITORY=https://…')
        ENV['DOGFOOD_REPOSITORY'] = repository
        run('Install catalog', ['bash', 'scripts/catalog-sync.sh'])
    elif command == 'tool-routes':
        config = local_config()
        output = capture(['python3', 'scripts/tool-routes.py', '--domain', config['domain'], '--tools', ENV.get('TOOLS', 'argocd')])
        path = STATE / 'tool-routes.json'
        path.write_text(output)
        run('Install tool routes', ['kubectl', '--context', 'kind-dogfood-local', 'apply', '-f', str(path)])
    elif command in ('benchmark', 'benchmark-report'):
        local_config()
        if command == 'benchmark':
            if int(ENV.get('RUNS', '30')) <= 0 or int(ENV.get('CONCURRENCY', '5')) <= 0:
                raise RuntimeError('RUNS and CONCURRENCY must be positive integers.')
            image = ENV.get('IMAGE') or (STATE / 'sample-image.txt').read_text().strip()
            revision = ENV.get('REVISION') or capture(['git', 'rev-parse', 'HEAD'])
            run('Benchmark previews', ['python3', 'scripts/benchmark.py', '--image', image, '--revision', revision, '--runs', ENV.get('RUNS', '30'), '--concurrency', ENV.get('CONCURRENCY', '5')])
        run('Benchmark report', ['bin/dogfood', 'benchmark', '--file', '.dogfood/benchmark.json'])
        print((LOGS / 'benchmark-report.log').read_text())
    elif command.startswith('teleport-'):
        teleport(command)
    elif command == 'clean':
        if any(alive(s) for s in SERVICES):
            raise RuntimeError('Run make stop before cleaning build artifacts.')
        for path in [ROOT / 'bin', ROOT / 'coverage', ROOT / 'playwright-report', ROOT / 'test-results'] + list((ROOT / 'packages').glob('*/dist')) + list((ROOT / 'services').glob('*/dist')):
            if path.exists():
                shutil.rmtree(path)
        say('  ✓ Build artifacts removed', '32')
    else:
        checks(command)


def main():
    os.chdir(ROOT)
    command = sys.argv[1] if len(sys.argv) > 1 else 'help'
    if command in ('help', 'help-all'):
        help_text(command == 'help-all')
        return
    if command == '_service':
        _, args, cwd = SERVICES[sys.argv[2]]
        # Keep a stable supervisor identity while Node launchers exec/restart.
        signal.signal(signal.SIGTERM, lambda *_: None)
        child = subprocess.Popen(args, cwd=cwd, env=ENV)
        try:
            code = child.wait()
        finally:
            # Launchers may leave descendants after their own exit.
            os.killpg(os.getpgrp(), signal.SIGTERM)
        sys.exit(code)
    os.umask(0o077)
    credentials()
    heading(command)
    # Checks do not mutate cluster/process state and must not block behind
    # long bootstrap operations (including editor and stop-hook lint runs).
    read_only = ('status', 'logs', 'open', 'lint', 'format-check', 'typecheck',
                 'audit', 'catalog-check', 'test-local', 'test-teleport',
                 'teleport-status', 'teleport-doctor', 'teleport-urls', 'teleport-logs', 'teleport-requests',
                 'teleport-tctl', 'teleport-render', 'teleport-port-forward', 'teleport-secrets-guard')
    with contextlib.nullcontext() if command in read_only else locked():
        dispatch(command)
    if command not in ('status', 'logs', 'open'):
        print()
        rule()
        hint('Logs in .dogfood/logs/  ·  make help-all for all commands')
        print()


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        print('\n  Interrupted.', file=sys.stderr)
        sys.exit(130)
    except (RuntimeError, OSError, ValueError, KeyError, subprocess.SubprocessError) as exc:
        error_panel(str(exc))
        sys.exit(1)
