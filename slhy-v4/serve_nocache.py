"""
serve_nocache.py — 工作台专用静态服务器
与 python -m http.server 等价，但所有响应强制 no-cache，
防止浏览器磁盘缓存导致访问 ngrok/GitHub Pages 时拿到旧 JS。
"""
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        # 强制禁用缓存
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def log_message(self, fmt, *args):
        pass  # 静默日志（与 python -m http.server 一致，不污染输出）


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5010
    print(f'[serve_nocache] http://localhost:{port}/  (no-cache)', flush=True)
    ThreadingHTTPServer(('0.0.0.0', port), NoCacheHandler).serve_forever()