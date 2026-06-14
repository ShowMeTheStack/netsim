// netcat-lite. Server: `nc -l PORT [-u] [-k]` prints what it receives. Client: `nc HOST PORT [-u] MESSAGE...`.
import { u32ToIp } from '@/shared/bytes';
import { term } from '../devices/host';
import { tcpSocket, tcpListen, tcpConnect, tcpAccept, tcpSend, tcpRecv, tcpClose } from '../stack/tcp';
import { udpSocket, udpSend } from '../stack/udp';
import type { ProcEvent } from './procs';
import type { EngineState, HostState, NcProc, UdpSocket } from '../types';

const txt = (b: Uint8Array) => new TextDecoder().decode(b).replace(/\n$/, '');
export function startNcListen(st: EngineState, h: HostState, port: number, udp: boolean, keep: boolean): NcProc | string {
  const pid = h.nextPid++; const p: NcProc = { kind: 'nc', pid, role: 'listen', udp, sock: -1, port, target: null, message: null, done: false, acceptedSock: null, keep };
  if (udp) { const s = udpSocket(h, pid, port); if (typeof s === 'string') return s; p.sock = s.id; }
  else { const s = tcpSocket(st, h, pid); const e = tcpListen(st, h, s, port); if (e) { delete h.sockets[s.id]; return e; } p.sock = s.id; }
  h.procs[pid] = p; term(h, `Listening on 0.0.0.0 ${port} (${udp ? 'udp' : 'tcp'})`); return p;
}
export function startNcConnect(st: EngineState, h: HostState, target: number, port: number, udp: boolean, message: string): NcProc | string {
  const pid = h.nextPid++; const p: NcProc = { kind: 'nc', pid, role: 'connect', udp, sock: -1, port, target, message, done: false, acceptedSock: null, keep: false };
  h.procs[pid] = p;
  if (udp) { const s = udpSocket(h, pid); if (typeof s === 'string') { delete h.procs[pid]; return s; } p.sock = s.id; udpSend(st, h, s, target, port, new TextEncoder().encode(message + '\n')); term(h, `sent ${message.length + 1} bytes to ${u32ToIp(target)}:${port} (udp)`); return p; }
  const s = tcpSocket(st, h, pid); p.sock = s.id; const e = tcpConnect(st, h, s, target, port); if (e) { term(h, `nc: ${e}`); delete h.sockets[s.id]; delete h.procs[pid]; return e; }
  return p;
}
export function ncNotify(st: EngineState, h: HostState, p: NcProc, ev: ProcEvent) {
  if (p.role === 'connect') {
    const s = h.sockets[p.sock];
    if (ev.type === 'tcpConnected' && s?.proto === 'tcp') { term(h, `Connection to ${u32ToIp(p.target!)} ${p.port} port [tcp/*] succeeded!`); if (p.message) tcpSend(st, h, s, new TextEncoder().encode(p.message + '\n')); tcpClose(st, h, s); }
    else if (ev.type === 'tcpReadable' && s?.proto === 'tcp') { const d = tcpRecv(st, h, s); if (d.length) term(h, txt(d)); }
    else if (ev.type === 'tcpEof' && s?.proto === 'tcp') { const d = tcpRecv(st, h, s); if (d.length) term(h, txt(d)); if (s.state === 'CLOSE_WAIT') tcpClose(st, h, s); }
    else if (ev.type === 'tcpError') { term(h, `nc: connect to ${u32ToIp(p.target!)} port ${p.port} (tcp) failed: ${ev.err}`); finish(h, p); }
    else if (ev.type === 'tcpClosed') finish(h, p);
    else if (ev.type === 'udpRx' && s?.proto === 'udp') { for (const dg of s.rx.splice(0)) term(h, txt(dg.data)); }
    else if (ev.type === 'icmpError') { term(h, `nc: ${u32ToIp(p.target!)} port ${p.port} (udp): ${ev.icmpType === 3 && ev.code === 3 ? 'Connection refused' : `ICMP ${ev.icmpType}/${ev.code}`}`); finish(h, p); }
    return;
  }
  if (ev.type === 'tcpAccept') { const ls = h.sockets[p.sock]; if (ls?.proto !== 'tcp') return; const c = tcpAccept(h, ls); if (!c) return; p.acceptedSock = c.id; term(h, `Connection received from ${u32ToIp(c.remoteIp!)} ${c.remotePort}`); }
  else if (ev.type === 'tcpReadable') { const c = h.sockets[ev.sock]; if (c?.proto === 'tcp') { const d = tcpRecv(st, h, c); if (d.length) term(h, txt(d)); } }
  else if (ev.type === 'tcpEof') { const c = h.sockets[ev.sock]; if (c?.proto === 'tcp') { const d = tcpRecv(st, h, c); if (d.length) term(h, txt(d)); tcpClose(st, h, c); } }
  else if (ev.type === 'tcpClosed' && ev.sock === p.acceptedSock) { p.acceptedSock = null; if (!p.keep) { const ls = h.sockets[p.sock]; if (ls) delete h.sockets[ls.id]; finish(h, p); } }
  else if (ev.type === 'udpRx') { const s = h.sockets[p.sock] as UdpSocket | undefined; if (!s) return; for (const dg of s.rx.splice(0)) term(h, `${txt(dg.data)}  [from ${u32ToIp(dg.src)}:${dg.sport}]`); if (!p.keep) { delete h.sockets[s.id]; finish(h, p); } }
}
export function ncTimer(_st: EngineState, _h: HostState, _p: NcProc, _what: string, _data?: unknown) { /* no timers */ }
function finish(h: HostState, p: NcProc) { p.done = true; delete h.procs[p.pid]; }
export function ncKill(st: EngineState, h: HostState, p: NcProc) { const s = h.sockets[p.sock]; if (s?.proto === 'tcp' && s.state !== 'LISTEN') tcpClose(st, h, s); else if (s) delete h.sockets[s.id]; if (p.acceptedSock !== null) { const c = h.sockets[p.acceptedSock]; if (c?.proto === 'tcp') tcpClose(st, h, c); } finish(h, p); }
