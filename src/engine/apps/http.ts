// HTTP/1.x server (serves an editable docroot) and client (fetches a page + its embedded resources).
import { u32ToIp } from '@/shared/bytes';
import { term } from '../devices/host';
import { tcpSocket, tcpListen, tcpConnect, tcpAccept, tcpSend, tcpRecv, tcpClose } from '../stack/tcp';
import { resolve, firstA } from './dns';
import { parseRequest, parseResponse, encodeResponse, encodeRequest, extractResources, contentType, statusReason, type HttpResponse } from './http-msg';
import { SEC, log } from '../core';
import type { ProcEvent } from './procs';
import type { EngineState, HostState, HttpProc, TcpSocket } from '../types';

const enc = new TextEncoder(); const dec = new TextDecoder();

// ---------------- server ----------------
export function startHttpServer(st: EngineState, h: HostState, port = 80): HttpProc | string {
  const pid = h.nextPid++; const s = tcpSocket(st, h, pid); const e = tcpListen(st, h, s, port); if (e) { delete h.sockets[s.id]; return e; }
  const p: HttpProc = { kind: 'http', pid, role: 'server', port, sock: s.id, conns: {}, done: false, target: null, host: '', path: '', mode: 'persistent', pending: [], fetched: [], startedAt: 0, pipeline: false, method: 'GET' };
  h.procs[pid] = p; term(h, `HTTP server listening on port ${port}, docroot ${Object.keys(h.httpDocroot).length} file(s)`); return p;
}
function serveConn(st: EngineState, h: HostState, p: HttpProc, sockId: number) {
  const c = h.sockets[sockId]; if (c?.proto !== 'tcp') return; const conn = p.conns[sockId] ?? (p.conns[sockId] = { buf: new Uint8Array(0), keepAlive: true, served: 0 });
  const d = tcpRecv(st, h, c); if (d.length) { const nb = new Uint8Array(conn.buf.length + d.length); nb.set(conn.buf); nb.set(d, conn.buf.length); conn.buf = nb; }
  for (;;) {
    const r = parseRequest(conn.buf); if (!r) break; const [req, used] = r; conn.buf = conn.buf.slice(used); conn.served++;
    const httpVer = req.version; conn.keepAlive = httpVer === 'HTTP/1.1' ? (req.headers['connection']?.toLowerCase() !== 'close') : (req.headers['connection']?.toLowerCase() === 'keep-alive');
    let path = req.target.split('?')[0]!; if (path === '/' ) path = '/index.html'; const key = path.replace(/^\//, '');
    log(st, `${h.name}: HTTP ${req.method} ${req.target} from ${u32ToIp(c.remoteIp!)}:${c.remotePort}`);
    let resp: HttpResponse;
    const file = h.httpDocroot[key];
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'POST' && req.method !== 'PUT' && req.method !== 'DELETE') resp = mkResp(405, 'Method Not Allowed', enc.encode('405'), conn.keepAlive);
    else if (file === undefined) resp = mkResp(404, 'Not Found', enc.encode(`<html><body><h1>404 Not Found</h1><p>${path}</p></body></html>`), conn.keepAlive, 'text/html');
    else { const body = req.method === 'HEAD' ? new Uint8Array(0) : enc.encode(file); resp = mkResp(200, 'OK', body, conn.keepAlive, contentType(key)); if (req.method === 'HEAD') resp.headers['Content-Length'] = String(enc.encode(file).length); }
    tcpSend(st, h, c, encodeResponse(resp));
    if (!conn.keepAlive) { tcpClose(st, h, c); break; }
  }
}
function mkResp(status: number, reason: string, body: Uint8Array, keepAlive: boolean, ct = 'text/html'): HttpResponse {
  return { version: 'HTTP/1.1', status, reason: reason || statusReason(status), headers: { 'Content-Type': ct, 'Content-Length': String(body.length), 'Connection': keepAlive ? 'keep-alive' : 'close', 'Server': 'NetSim/1.0' }, body };
}

// ---------------- client (curl / wget) ----------------
export function startHttpClient(st: EngineState, h: HostState, url: string, opts: { method?: string; persistent?: boolean; pipeline?: boolean; recurse?: boolean } = {}): HttpProc | string {
  const m = /^(?:http:\/\/)?([^/:]+)(?::(\d+))?(\/\S*)?$/.exec(url); if (!m) return `could not parse URL "${url}"`;
  const host = m[1]!; const port = Number(m[2] ?? 80); const path = m[3] ?? '/';
  const pid = h.nextPid++;
  const p: HttpProc = { kind: 'http', pid, role: 'client', port, sock: -1, conns: {}, done: false, target: null, host, path, mode: opts.persistent === false ? 'nonpersistent' : 'persistent', pending: opts.recurse === false ? [] : [], fetched: [], startedAt: st.time, pipeline: !!opts.pipeline, method: opts.method ?? 'GET' };
  (p as HttpProc & { recurse: boolean }).recurse = opts.recurse !== false;
  h.procs[pid] = p; term(h, `* Resolving ${host}...`);
  resolve(st, h, host, 1, { kind: 'http', pid, path, host, port });
  return p;
}
function httpConnect(st: EngineState, h: HostState, p: HttpProc, path: string) {
  const s = tcpSocket(st, h, p.pid); p.sock = s.id; const conn = p.conns[s.id] = { buf: new Uint8Array(0), keepAlive: p.mode === 'persistent', served: 0, requests: [path], sentAt: {} as Record<string, number> };
  const e = tcpConnect(st, h, s, p.target!, p.port); if (e) { term(h, `curl: (7) ${e}`); delete h.procs[p.pid]; }
  void conn;
}
function sendRequest(st: EngineState, h: HostState, p: HttpProc, sockId: number, path: string, last: boolean) {
  const c = h.sockets[sockId]; if (c?.proto !== 'tcp') return; const conn = p.conns[sockId]!;
  const req = encodeRequest({ method: p.method, target: path, version: 'HTTP/1.1', headers: { 'Host': p.host, 'User-Agent': 'NetSim-curl/1.0', 'Connection': (p.mode === 'persistent' && !last) || p.pipeline ? 'keep-alive' : (p.mode === 'persistent' ? 'keep-alive' : 'close'), 'Accept': '*/*' }, body: new Uint8Array(0) });
  conn.sentAt![path] = st.time; if (!conn.requests!.includes(path)) conn.requests!.push(path);
  term(h, `> ${p.method} ${path} HTTP/1.1  (Host: ${p.host})`); tcpSend(st, h, c, req);
}
function clientRx(st: EngineState, h: HostState, p: HttpProc, sockId: number) {
  const c = h.sockets[sockId]; if (c?.proto !== 'tcp') return; const conn = p.conns[sockId]; if (!conn) return;
  const d = tcpRecv(st, h, c); if (d.length) { const nb = new Uint8Array(conn.buf.length + d.length); nb.set(conn.buf); nb.set(d, conn.buf.length); conn.buf = nb; }
  for (;;) {
    const r = parseResponse(conn.buf, p.method === 'HEAD'); if (!r) break; const [resp, used] = r; conn.buf = conn.buf.slice(used);
    const path = conn.requests!.shift() ?? p.path; const rtt = ((st.time - (conn.sentAt![path] ?? p.startedAt)) / 1000);
    const bodyText = dec.decode(resp.body);
    term(h, `< HTTP/1.1 ${resp.status} ${resp.reason}  (${resp.body.length} bytes, ${rtt.toFixed(1)} ms)  ${path}`);
    p.fetched.push({ path, status: resp.status, bytes: resp.body.length, ms: rtt, start: (conn.sentAt![path] ?? p.startedAt) });
    if (p.method === 'GET' && (p as HttpProc & { recurse: boolean }).recurse && resp.headers['content-type']?.includes('text/html') && p.fetched.length === 1) {
      const res = extractResources(bodyText).map(x => x.startsWith('/') ? x : '/' + x); p.pending.push(...res);
      if (res.length) term(h, `* page references ${res.length} resource(s): ${res.join(', ')}`);
    }
    // fetch next
    if (p.pending.length) {
      const next = p.pending.shift()!;
      if (p.mode === 'nonpersistent') { tcpClose(st, h, c); const s2 = tcpSocket(st, h, p.pid); p.conns[s2.id] = { buf: new Uint8Array(0), keepAlive: false, served: 0, requests: [next], sentAt: {} }; const e = tcpConnect(st, h, s2, p.target!, p.port); if (e) term(h, `curl: ${e}`); return; }
      else if (p.pipeline) { /* already pipelined below */ }
      else sendRequest(st, h, p, sockId, next, p.pending.length === 0);
    } else if (conn.requests!.length === 0 && p.pending.length === 0) { finishClient(st, h, p, c); return; }
  }
}
function finishClient(st: EngineState, h: HostState, p: HttpProc, c: TcpSocket) {
  if (p.mode === 'persistent') tcpClose(st, h, c);
  const total = (st.time - p.startedAt) / 1000; const bytes = p.fetched.reduce((a, f) => a + f.bytes, 0);
  term(h, `* Fetched ${p.fetched.length} resource(s), ${bytes} bytes in ${total.toFixed(1)} ms (${p.mode}${p.pipeline ? ', pipelined' : ''})`);
  p.done = true;
}
export function httpNotify(st: EngineState, h: HostState, p: HttpProc, ev: ProcEvent) {
  if (p.role === 'server') {
    if (ev.type === 'tcpAccept') { const ls = h.sockets[p.sock]; if (ls?.proto === 'tcp') { const c = tcpAccept(h, ls); if (c) p.conns[c.id] = { buf: new Uint8Array(0), keepAlive: true, served: 0 }; } }
    else if (ev.type === 'tcpReadable') serveConn(st, h, p, ev.sock);
    else if (ev.type === 'tcpEof') { const c = h.sockets[ev.sock]; if (c?.proto === 'tcp') { serveConn(st, h, p, ev.sock); tcpClose(st, h, c); } delete p.conns[ev.sock]; }
    else if (ev.type === 'tcpClosed') delete p.conns[ev.sock];
    return;
  }
  // client
  if (ev.type === 'tcpConnected') { const conn = p.conns[ev.sock]!; const reqs = [...conn.requests!]; conn.requests = []; if (p.pipeline && p.method === 'GET') { for (let i = 0; i < reqs.length; i++) sendRequest(st, h, p, ev.sock, reqs[i]!, i === reqs.length - 1); } else sendRequest(st, h, p, ev.sock, reqs[0]!, p.mode === 'nonpersistent'); }
  else if (ev.type === 'tcpReadable') clientRx(st, h, p, ev.sock);
  else if (ev.type === 'tcpEof') { const c = h.sockets[ev.sock]; clientRx(st, h, p, ev.sock); if (c?.proto === 'tcp') tcpClose(st, h, c); }
  else if (ev.type === 'tcpError') { term(h, `curl: (7) ${ev.err}`); p.done = true; delete h.procs[p.pid]; }
  else if (ev.type === 'tcpClosed') { if (!p.done && p.pending.length === 0 && Object.values(p.conns).every(cn => cn.requests!.length === 0)) { const total = (st.time - p.startedAt) / 1000; if (p.fetched.length) term(h, `* Fetched ${p.fetched.length} resource(s) in ${total.toFixed(1)} ms`); p.done = true; delete h.procs[p.pid]; } }
  // pipeline: kick off remaining resources once first response identified them
  if (p.pipeline && p.pending.length && p.role === 'client') { const sockId = p.sock; const conn = p.conns[sockId]; if (conn && ev.type === 'tcpReadable') { for (const path of p.pending.splice(0)) sendRequest(st, h, p, sockId, path, true); } }
  void SEC; void log;
}
export function httpResolved(st: EngineState, h: HostState, pid: number, path: string, host: string, port: number, ip: number | null) {
  const p = h.procs[pid]; if (!p || p.kind !== 'http') return;
  if (ip === null) { term(h, `curl: (6) Could not resolve host: ${host}`); delete h.procs[pid]; return; }
  p.target = ip; term(h, `* Connected to ${host} (${u32ToIp(ip)}) port ${port}`); p.startedAt = st.time; httpConnect(st, h, p, path);
}
export function httpTimer() { /* none */ }
export function decodeHttpLayer(b: Uint8Array, start: number, end: number) {
  const text = dec.decode(b.subarray(start, end)); const firstLine = text.split('\r\n')[0] ?? '';
  const isResp = /^HTTP\//.test(firstLine); const isReq = /^(GET|HEAD|POST|PUT|DELETE|OPTIONS|PATCH) /.test(firstLine);
  if (!isResp && !isReq) return [{ proto: 'data', name: 'TCP segment data', start, end, summary: `${end - start} bytes`, warnings: [], fields: [] }];
  const heEnd = text.indexOf('\r\n\r\n'); const headerText = heEnd < 0 ? text : text.slice(0, heEnd); const lines = headerText.split('\r\n');
  const fields = lines.filter(Boolean).map((l, i) => ({ key: i === 0 ? (isResp ? 'response.line' : 'request.line') : 'header', name: i === 0 ? (isResp ? 'Status line' : 'Request line') : l.split(':')[0] ?? 'Header', value: l, start, end } as import('../codecs/types').Field));
  return [{ proto: 'http', name: 'Hypertext Transfer Protocol', start, end, summary: firstLine, warnings: [], fields }];
}
export function httpKill(st: EngineState, h: HostState, p: HttpProc) { for (const id of Object.keys(p.conns).map(Number)) { const c = h.sockets[id]; if (c?.proto === 'tcp' && c.state !== 'LISTEN') tcpClose(st, h, c); else if (c) delete h.sockets[id]; } const ls = h.sockets[p.sock]; if (ls?.proto === 'tcp' && ls.state === 'LISTEN') delete h.sockets[ls.id]; p.done = true; delete h.procs[p.pid]; }
