"""The readiness endpoint proves both the deployed revision and a live database connection."""
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import psycopg

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        code, message = 200, 'ok'
        if self.path == '/readyz':
            try:
                with psycopg.connect(connect_timeout=2) as conn:
                    with conn.cursor() as cursor:
                        cursor.execute('SELECT 1')
                        assert cursor.fetchone() == (1,)
                message = os.environ['REVISION']
            except Exception:
                code, message = 503, 'database unavailable'
        elif self.path != '/healthz':
            message = 'Stack sample / revision ' + os.environ.get('REVISION', 'unknown')
        self.send_response(code)
        self.send_header('Content-Type', 'text/plain')
        self.end_headers()
        self.wfile.write(message.encode())

ThreadingHTTPServer(('0.0.0.0', 8080), Handler).serve_forever()
