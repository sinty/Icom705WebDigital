#!/usr/bin/env python3
"""Локальный сервер для разработки.

Штатный http.server отдаёт .mjs как text/plain, а браузер отказывается
исполнять модуль с неверным типом содержимого — и делает это молча, без
внятной записи в консоли воркера. Здесь типы поправлены.

Заодно выключено кеширование: правки подхватываются без Ctrl+F5.

    python tools/serve.py [порт]

Флаг --coi добавляет заголовки COOP/COEP (нужны только если когда-нибудь
понадобится SharedArrayBuffer; сейчас декодер однопоточный и обходится без него).
"""
import functools
import http.server
import socketserver
import sys

TYPES = {
    '.js':   'text/javascript',
    '.mjs':  'text/javascript',
    '.wasm': 'application/wasm',
    '.json': 'application/json',
    '.html': 'text/html; charset=utf-8',
    '.css':  'text/css; charset=utf-8',
    '.wav':  'audio/wav',
}


class Handler(http.server.SimpleHTTPRequestHandler):
    coi = False

    def guess_type(self, path):
        for ext, mime in TYPES.items():
            if str(path).endswith(ext):
                return mime
        return super().guess_type(path)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        if self.coi:
            self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
            self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        super().end_headers()

    def log_message(self, fmt, *args):
        # тихо про успешные запросы, шумно про всё остальное
        if args and str(args[1]).startswith('2'):
            return
        super().log_message(fmt, *args)


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('-')]
    port = int(args[0]) if args else 8000
    Handler.coi = '--coi' in sys.argv

    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(('127.0.0.1', port), Handler) as srv:
        print(f'http://localhost:{port}/web/index.html'
              f'{"  (COOP/COEP включены)" if Handler.coi else ""}')
        srv.serve_forever()


if __name__ == '__main__':
    main()
