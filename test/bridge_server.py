"""테스트용 서버.

실제 서비스는 서버가 없다. 이 서버는 컨테이너 안에서 화면을 검증하려고,
브라우저의 Pyodide 대신 같은 kernel.py를 CPython으로 돌려 주는 대역이다.
"""

import http.server
import json
import pathlib
import socketserver
import sys
import threading

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'assets'))
import kernel  # noqa: E402

lock = threading.Lock()


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, *args):
        pass

    def do_POST(self):
        if self.path == '/__reset':
            with lock:
                kernel.RAW.clear()
                kernel.TABLES.clear()
                kernel.ORDER.clear()
            self.send_response(204)
            self.end_headers()
            return
        if self.path != '/__call':
            self.send_error(404)
            return
        length = int(self.headers.get('Content-Length', 0))
        body = json.loads(self.rfile.read(length).decode('utf-8'))
        with lock:
            text = kernel.handle(body['cmd'], json.dumps(body.get('payload') or {}))
        data = text.encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    with Server(('127.0.0.1', port), Handler) as httpd:
        print(f'serving {ROOT} on {port}', flush=True)
        httpd.serve_forever()
