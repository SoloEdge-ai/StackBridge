// THROWAWAY: offline host for the archived Codex prototype. No API or PTY access.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

const fragment = readFileSync(new URL('./ai-workspace.html', import.meta.url), 'utf8');
createServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>StackBridge — throwaway prototype</title><style>:root{color-scheme:dark}body{margin:20px;background:#111319}svg{width:18px;height:18px}</style><body>${fragment}</body></html>`);
}).listen(8773, '127.0.0.1', () => console.log('Prototype: http://127.0.0.1:8773/?variant=A'));
