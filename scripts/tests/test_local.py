"""Exercise lifecycle safety and failures without touching Docker or user services."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch, Mock

spec = importlib.util.spec_from_file_location('local', Path(__file__).parents[1] / 'local.py')
local = importlib.util.module_from_spec(spec)
spec.loader.exec_module(local)


class LocalTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.stack = self.root / '.stack'
        self.stack.mkdir()
        self.patches = [patch.object(local, 'ROOT', self.root), patch.object(local, 'STATE', self.stack), patch.object(local, 'LOGS', self.stack / 'logs'), patch.object(local, 'ENV', {'PATH': os.environ['PATH']}), patch.object(local, 'COLOR', False), patch.object(local, 'CHILDREN', {}), patch.object(local, 'container', return_value=None)]
        for item in self.patches:
            item.start()
        self.addCleanup(self.temp.cleanup)
        self.addCleanup(lambda: [item.stop() for item in reversed(self.patches)])

    def test_supported_tool_versions(self):
        (self.root / 'package.json').write_text(json.dumps({'engines': {'node': '>=22 <26'}}))
        for version in ('v22.0.0', 'v23.11.0', 'v24.0.0', 'v25.8.2'):
            with self.subTest(node=version):
                self.assertIsNone(local.tool_version_error('node', version))
        for version in ('v3.18.6', 'v4.2.2+gb05881c'):
            with self.subTest(helm=version):
                self.assertIsNone(local.tool_version_error('helm', version))

    def test_unsupported_tool_versions(self):
        (self.root / 'package.json').write_text(json.dumps({'engines': {'node': '>=22 <26'}}))
        for version in ('v20.19.0', 'v26.0.0', 'unknown', 'v25.0.0-rc.1'):
            with self.subTest(node=version):
                self.assertIsNotNone(local.tool_version_error('node', version))
        for version in ('v2.17.0', 'v5.0.0', 'unknown'):
            with self.subTest(helm=version):
                self.assertIsNotNone(local.tool_version_error('helm', version))

    def test_node_versions_follow_manifest(self):
        (self.root / 'package.json').write_text(json.dumps({'engines': {'node': '>=24 <27'}}))
        self.assertIsNone(local.tool_version_error('node', 'v26.0.0'))
        self.assertIsNotNone(local.tool_version_error('node', 'v22.0.0'))

    def test_help_needs_no_dependencies_or_state(self):
        with patch.object(local, 'capture', side_effect=AssertionError), contextlib.redirect_stdout(io.StringIO()) as out:
            local.help_text(all_commands=True)
        self.assertIn('preview-down', out.getvalue())
        self.assertNotIn('\033', out.getvalue())

    def test_credentials_are_private_and_stable(self):
        local.credentials(create=True)
        first = (self.stack / 'local.env').read_text()
        local.credentials(create=True)
        self.assertEqual(first, (self.stack / 'local.env').read_text())
        self.assertEqual((self.stack / 'local.env').stat().st_mode & 0o777, 0o600)
        self.assertIn('STACK_LOCAL_TOKEN', local.ENV)

    def test_env_is_data_not_shell(self):
        (self.root / '.env').write_text("VALUE='$(touch /tmp/never-execute-stack)'\n")
        local.credentials()
        self.assertEqual(local.ENV['VALUE'], '$(touch /tmp/never-execute-stack)')

    def test_secret_redaction(self):
        local.ENV['STACK_LOCAL_TOKEN'] = 'a-very-secret-token'
        self.assertEqual(local.redact('Bearer a-very-secret-token'), 'Bearer [redacted]')

    def test_checks_run_while_lifecycle_lock_is_held(self):
        for command in ('lint', 'format-check', 'typecheck', 'test-local'):
            with self.subTest(command=command), local.locked(), patch.object(local.sys, 'argv', ['local.py', command]), patch.object(local.os, 'chdir'), patch.object(local.os, 'umask'), patch.object(local, 'credentials'), patch.object(local, 'dispatch') as dispatch, contextlib.redirect_stdout(io.StringIO()):
                local.main()
                dispatch.assert_called_once_with(command)

    def test_startup_still_requires_lifecycle_lock(self):
        with local.locked(), patch.object(local.sys, 'argv', ['local.py', 'up']), patch.object(local.os, 'chdir'), patch.object(local.os, 'umask'), patch.object(local, 'credentials'), patch.object(local, 'dispatch') as dispatch, contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(RuntimeError, 'Another local operation'):
                local.main()
            dispatch.assert_not_called()

    def test_lock_rejects_concurrent_operation(self):
        with local.locked():
            with self.assertRaisesRegex(RuntimeError, 'Another local operation'):
                with local.locked():
                    pass

    def test_stale_identity_is_not_signaled(self):
        local.record_path('api').write_text(json.dumps({'pid': 42, 'identity': 'old process'}))
        with patch.object(local, 'identity', return_value='unrelated process'), patch.object(local.os, 'killpg') as kill:
            local.stop_service('api')
        kill.assert_not_called()

    def test_untracked_port_refuses_start(self):
        with patch.object(local, 'port_busy', return_value=True), patch.object(local.subprocess, 'Popen') as popen:
            with self.assertRaisesRegex(RuntimeError, 'occupied'):
                local.start('api')
        popen.assert_not_called()

    def test_ready_service_reused(self):
        with patch.object(local, 'alive', return_value=True), patch.object(local, 'healthy', return_value=True), patch.object(local.subprocess, 'Popen') as popen:
            self.assertFalse(local.start('api'))
        popen.assert_not_called()

    def test_unmanaged_container_rejected(self):
        with patch.object(local, 'container', return_value={'Config': {'Labels': {}}}):
            with self.assertRaisesRegex(RuntimeError, 'unmanaged'):
                local.owned('stack-registry')

    def test_partial_startup_stops_only_new_services(self):
        with patch.object(local, 'credentials'), patch.object(local, 'build_cli'), patch.object(local, 'database'), patch.object(local, 'start', side_effect=[False, True, RuntimeError('failed')]), patch.object(local, 'stop_service') as stop:
            with self.assertRaises(RuntimeError):
                local.app_start()
        stop.assert_called_once_with('backend')

    def test_preview_name_is_validated(self):
        local.ENV['NAME'] = '../anything'
        with patch.object(local, 'request') as request:
            with self.assertRaisesRegex(RuntimeError, 'DNS label'):
                local.preview('preview-down')
        request.assert_not_called()

    def test_preview_delete_requires_confirmation(self):
        local.ENV['NAME'] = 'demo'
        with patch.object(local, 'request', return_value={'id': 'confirm123'}) as request:
            local.preview('preview-down')
        request.assert_called_once_with('environments/demo/confirm-delete', {})

    def test_preview_extend_preserves_generation(self):
        local.ENV.update(NAME='demo', MINUTES='10')
        with patch.object(local, 'request', side_effect=[{'generation': 7}, {}]) as request:
            local.preview('preview-extend')
        self.assertEqual(request.call_args.args, ('environments/demo/extend', {'mode': 'add', 'minutes': 10, 'generation': 7}))

    def test_cleanup_failure_does_not_delete_cluster(self):
        with patch.object(local, 'local_config'), patch.object(local, 'owned'), patch.object(local, 'capture', return_value='stack-local'), patch.object(local, 'credentials'), patch.object(local, 'alive', return_value=True), patch.object(local, 'request', side_effect=RuntimeError('offline')), patch.object(local, 'run') as run:
            with self.assertRaisesRegex(RuntimeError, 'cluster retained'):
                local.down()
        run.assert_not_called()

    def test_down_order_and_retained_data(self):
        (self.stack / 'local.env').write_text('retained')
        events = []
        def request(path, body=None):
            events.append(path)
            if path == 'environments':
                return [{'id': 'demo', 'status': 'ready'}, {'id': 'old', 'status': 'deleted'}]
            return {'id': 'operation'}
        with patch.object(local, 'local_config'), patch.object(local, 'owned', return_value=True), patch.object(local, 'capture', return_value='stack-local'), patch.object(local, 'credentials'), patch.object(local, 'alive', return_value=True), patch.object(local, 'request', side_effect=request), patch.object(local, 'wait_operation', side_effect=lambda _: events.append('wait')), patch.object(local, 'stop_service', side_effect=lambda s: events.append('stop ' + s)), patch.object(local, 'run', side_effect=lambda label, args: events.append(args)):
            local.down()
        self.assertLess(events.index('wait'), events.index('stop api'))
        self.assertEqual(events[-1], ['kind', 'delete', 'cluster', '--name', 'stack-local'])
        self.assertTrue((self.stack / 'local.env').exists())
        self.assertFalse(any('old' in str(e) for e in events))

    def test_reset_refuses_untracked_process(self):
        local.ENV['CONFIRM'] = 'stack-local'
        with patch.object(local, 'local_config'), patch.object(local, 'port_busy', return_value=True), patch.object(local, 'alive', return_value=False), patch.object(local, 'run') as run:
            with self.assertRaisesRegex(RuntimeError, 'untracked'):
                local.down(reset=True)
        run.assert_not_called()

    def test_reset_requires_exact_confirmation(self):
        with patch.object(local, 'local_config'), patch.object(local, 'owned') as owned:
            with self.assertRaisesRegex(RuntimeError, 'CONFIRM=stack-local'):
                local.down(reset=True)
        owned.assert_not_called()

    def test_foreign_config_rejected(self):
        with patch.object(local, 'build_cli'), patch.object(local, 'capture', return_value=json.dumps({'provider': 'aws'})):
            with self.assertRaisesRegex(RuntimeError, 'default stack-local'):
                local.local_config()

    def test_subprocess_failure_keeps_log_and_exit(self):
        with contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(RuntimeError, 'exit 7'):
                local.run('broken task', ['bash', '-c', 'echo useful-error; exit 7'])
        self.assertIn('useful-error', (local.LOGS / 'broken-task.log').read_text())

    def test_operation_failure_is_not_success(self):
        with patch.object(local, 'request', return_value={'status': 'failed', 'error': 'deployment'}):
            with self.assertRaisesRegex(RuntimeError, 'operation failed'):
                local.wait_operation({'id': 'abc'})

    def test_generation_conflict_surfaces(self):
        local.ENV.update(NAME='demo', MINUTES='10')
        with patch.object(local, 'request', side_effect=[{'generation': 7}, RuntimeError('API 409')]):
            with self.assertRaisesRegex(RuntimeError, '409'):
                local.preview('preview-extend')


    def test_lost_credentials_do_not_replace_database_password(self):
        with patch.object(local, 'container', return_value={'Config': {}}), patch.object(local.shutil, 'which', return_value='/bin/docker'):
            with self.assertRaisesRegex(RuntimeError, 'credentials'):
                local.credentials(create=True)
        self.assertFalse((self.stack / 'local.env').exists())

    def test_real_background_service_start_and_stop(self):
        import socket
        import sys
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        service = [sys.executable, '-c', 'from http.server import BaseHTTPRequestHandler,HTTPServer\nclass Handler(BaseHTTPRequestHandler):\n def do_GET(self): self.send_response(200); self.end_headers()\nHTTPServer(("127.0.0.1", ' + str(port) + '), Handler).serve_forever()']
        scripts = self.root / 'scripts'
        scripts.mkdir()
        source = str(Path(__file__).resolve().parents[1] / 'local.py')
        (scripts / 'local.py').write_text('import runpy\nm=runpy.run_path(' + repr(source) + ')\nm["SERVICES"]["api"] = ' + repr((port, service, str(self.root))) + '\nm["main"]()\n')
        with patch.dict(local.SERVICES, {'api': (port, service, self.root)}):
            try:
                self.assertTrue(local.start('api'))
                self.assertTrue(local.alive('api'))
                self.assertTrue(local.healthy('api'))
                self.assertFalse(local.start('api'))
            finally:
                local.stop_service('api')
            self.assertFalse(local.port_busy(port))
            self.assertFalse(local.record_path('api').exists())

    def test_readiness_timeout_cleans_up_child(self):
        proc = Mock(pid=123)
        proc.poll.return_value = None
        with patch.object(local, 'alive', return_value=False), patch.object(local, 'port_busy', return_value=False), patch.object(local.subprocess, 'Popen', return_value=proc), patch.object(local, 'identity', return_value='owned process'), patch.object(local, 'healthy', return_value=False), patch.object(local.time, 'monotonic', side_effect=[0, 121]), patch.object(local, 'stop_service') as stop:
            with self.assertRaisesRegex(RuntimeError, 'timed out'):
                local.start('api')
        stop.assert_called_once_with('api')

    def test_startup_child_exit_is_reported(self):
        proc = Mock(pid=123)
        proc.poll.return_value = 1
        with patch.object(local, 'alive', return_value=False), patch.object(local, 'port_busy', return_value=False), patch.object(local.subprocess, 'Popen', return_value=proc), patch.object(local, 'identity', return_value='owned process'), patch.object(local, 'stop_service') as stop:
            with self.assertRaisesRegex(RuntimeError, 'exited'):
                local.start('api')
        stop.assert_called_once_with('api')


if __name__ == '__main__':
    unittest.main()
