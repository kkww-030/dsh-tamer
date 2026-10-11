#!/usr/bin/env python3
"""dsh-tamer · 马鞍验证用的假后端（测试替身，不属于产品代码）

它扮演一匹"马"（OpenAI 兼容上游），做两件事：
  1. 把收到的每个请求完整记进 JSONL —— 这样才能断言马鞍**真的**把协议注入进去了、
     以及打回重做时**真的**追加了校验指令，而不是只看日志里有没有字。
  2. 故意返回不带来源的回复，用来触发马鞍的来源校验。

约定：
  · 最后一条 user 消息里出现 SOURCED_MARK 时，返回一段**带来源**的回复（用于验证"已列来源不打回"）。
  · 否则返回不含任何来源字样的回复（用于验证"缺来源会打回"）。

用法：python fake-backend.py <请求日志路径> [端口]
"""
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOG_PATH = sys.argv[1] if len(sys.argv) > 1 else 'requests.jsonl'
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 12321

# 请求里出现这个标记 → 返回带来源的回复
SOURCED_MARK = '[SOURCED]'

_lock = threading.Lock()
_calls = {'n': 0}


def last_user_text(messages):
    for message in reversed(messages or []):
        if message.get('role') == 'user':
            return str(message.get('content', ''))
    return ''


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # 静默：日志靠 JSONL，不靠 stdout
        pass

    def _json(self, obj, code=200):
        data = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.startswith('/health'):
            self._json({'ok': True, 'calls': _calls['n']})
            return
        self._json({'error': 'unknown path'}, 404)

    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0) or 0)
        raw = self.rfile.read(length).decode('utf-8') if length else '{}'
        try:
            body = json.loads(raw)
        except ValueError:
            body = {}

        messages = body.get('messages', [])
        with _lock:
            _calls['n'] += 1
            record = {
                'n': _calls['n'],
                'model': body.get('model'),
                'stream': bool(body.get('stream')),
                'system': next((str(m.get('content', '')) for m in messages if m.get('role') == 'system'), ''),
                'last_user': last_user_text(messages),
                'roles': [m.get('role') for m in messages],
            }
            with open(LOG_PATH, 'a', encoding='utf-8') as handle:
                handle.write(json.dumps(record, ensure_ascii=False) + '\n')

        if SOURCED_MARK in record['last_user']:
            reply = '按官方手册，该引脚可用。\n\n信息来源：ST 官方数据手册 https://www.st.com/x.pdf'
        else:
            reply = '这是演示回复，仅提供个人经验建议。'

        self._json({
            'choices': [{'index': 0, 'message': {'role': 'assistant', 'content': reply}, 'finish_reason': 'stop'}],
            'usage': {'prompt_tokens': 100, 'completion_tokens': 20, 'total_tokens': 120},
        })


if __name__ == '__main__':
    server = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    print('fake backend ready on %d, log=%s' % (PORT, LOG_PATH), flush=True)
    server.serve_forever()
