// iperf-lite: TCP or UDP bandwidth measurement. Server: `iperf -s [-u] [-p port] [-R bytes/s]`.
// Client: `iperf -c host [-u] [-p port] [-t secs] [-n bytes] [-b bits/s] [-l len]`.
import { u32ToIp } from '@/shared/bytes';
import { term } from '../devices/host';
import { tcpSocket, tcpListen, tcpConnect, tcpAccept, tcpSend, tcpRecv, tcpClose, tcpSendSpace } from '../stack/tcp';
import { udpSocket, udpSend } from '../stack/udp';
import { timer, SEC, MS } from '../core';
import type { ProcEvent } from './procs';
import type { EngineState, HostState, IperfProc, TcpSocket, UdpSocket } from '../types';

const fmtBytes = (b: number) => b >= 1e6 ? `${(b / 1e6).toFixed(2)} MBytes` : b >= 1e3 ? `${(b / 1e3).toFixed(1)} KBytes` : `${b} Bytes`;
const fmtRate = (bps: number) => bps >= 1e6 ? `${(bps / 1e6).toFixed(2)} Mbits/sec` : `${(bps / 1e3).toFixed(1)} Kbits/sec`;

export function startIperfServer(st: EngineState, h: HostState, opts: { port?: number; udp?: boolean; readRate?: number }): IperfProc | string {
  const pid = h.nextPid++; const port = opts.port ?? 5001;
  const p: IperfProc = { kind: 'iperf', pid, role: 'server', udp: !!opts.udp, port, sock: -1, target: null, durationUs: 0, bytesTarget: null, started: 0, lastReport: 0, bytes: 0, bytesInterval: 0, done: false, rateBps: 0, udpSeq: 0, udpLost: 0, udpRx: 0, udpLastSeq: -1, clientSock: null, readRateBps: opts.readRate ?? null, pendingRead: 0, sendBlock: 0, finishedAt: null, label: '' };
  if (p.udp) { const s = udpSocket(h, pid, port); if (typeof s === 'string') return s; p.sock = s.id; }
  else { const s = tcpSocket(st, h, pid); const e = tcpListen(st, h, s, port); if (e) { delete h.sockets[s.id]; return e; } p.sock = s.id; }
  h.procs[pid] = p;
  term(h, `------------------------------------------------------------`); term(h, `Server listening on ${p.udp ? 'UDP' : 'TCP'} port ${port}${p.readRateBps ? ` (slow reader: ${fmtRate(p.readRateBps * 8)})` : ''}`); term(h, `------------------------------------------------------------`);
  return p;
}
export function startIperfClient(st: EngineState, h: HostState, target: number, opts: { port?: number; udp?: boolean; seconds?: number; bytes?: number; bps?: number; len?: number }): IperfProc | string {
  const pid = h.nextPid++; const port = opts.port ?? 5001;
  const p: IperfProc = { kind: 'iperf', pid, role: 'client', udp: !!opts.udp, port, sock: -1, target, durationUs: (opts.seconds ?? 10) * SEC, bytesTarget: opts.bytes ?? null, started: st.time, lastReport: st.time, bytes: 0, bytesInterval: 0, done: false, rateBps: opts.bps ?? 1e6, udpSeq: 0, udpLost: 0, udpRx: 0, udpLastSeq: -1, clientSock: null, readRateBps: null, pendingRead: 0, sendBlock: opts.len ?? (opts.udp ? 1470 : 8192), finishedAt: null, label: '' };
  h.procs[pid] = p;
  if (p.udp) { const s = udpSocket(h, pid); if (typeof s === 'string') { delete h.procs[pid]; return s; } p.sock = s.id; term(h, `------------------------------------------------------------`); term(h, `Client connecting to ${u32ToIp(target)}, UDP port ${port}, sending ${p.sendBlock} byte datagrams at ${fmtRate(p.rateBps)}`); term(h, `------------------------------------------------------------`); udpTick(st, h, p); timer(st, h.id, 1 * SEC, `proc:${pid}:report`); return p; }
  const s = tcpSocket(st, h, pid); p.sock = s.id;
  term(h, `------------------------------------------------------------`); term(h, `Client connecting to ${u32ToIp(target)}, TCP port ${port} (${h.tcp.cc})`); term(h, `------------------------------------------------------------`);
  const e = tcpConnect(st, h, s, target, port); if (e) { term(h, `connect failed: ${e}`); delete h.sockets[s.id]; delete h.procs[pid]; return e; }
  return p;
}
function fill(st: EngineState, h: HostState, p: IperfProc, s: TcpSocket) {
  if (p.done || p.finishedAt !== null) return;
  const elapsed = st.time - p.started;
  if (elapsed >= p.durationUs || (p.bytesTarget !== null && p.bytes >= p.bytesTarget)) { p.finishedAt = st.time; tcpClose(st, h, s); return; }
  let space = tcpSendSpace(s);
  while (space >= p.sendBlock) { const want = p.bytesTarget !== null ? Math.min(p.sendBlock, p.bytesTarget - p.bytes) : p.sendBlock; if (want <= 0) break; const blk = new Uint8Array(want); for (let i = 0; i < want; i++) blk[i] = (p.bytes + i) & 0xff; const n = tcpSend(st, h, s, blk); if (n <= 0) break; p.bytes += n; p.bytesInterval += n; space -= n; if (p.bytesTarget !== null && p.bytes >= p.bytesTarget) { p.finishedAt = st.time; tcpClose(st, h, s); return; } }
}
function udpTick(st: EngineState, h: HostState, p: IperfProc) {
  if (p.done) return; const s = h.sockets[p.sock] as UdpSocket | undefined; if (!s) return;
  const elapsed = st.time - p.started;
  if (elapsed >= p.durationUs || (p.bytesTarget !== null && p.bytes >= p.bytesTarget)) { const fin = new Uint8Array(16); fin[0] = 0xff; udpSend(st, h, s, p.target!, p.port, fin); report(st, h, p, true); return; }
  const d = new Uint8Array(p.sendBlock); d[0] = (p.udpSeq >>> 24) & 255; d[1] = (p.udpSeq >>> 16) & 255; d[2] = (p.udpSeq >>> 8) & 255; d[3] = p.udpSeq & 255; p.udpSeq++;
  const r = udpSend(st, h, s, p.target!, p.port, d); if (r.status === 'ok') { p.bytes += d.length; p.bytesInterval += d.length; }
  const gap = (p.sendBlock * 8 * 1e6) / p.rateBps; timer(st, h.id, Math.max(1, gap), `proc:${p.pid}:udptick`);
}
function report(st: EngineState, h: HostState, p: IperfProc, final: boolean) {
  const now = st.time; const t0 = (p.lastReport - p.started) / 1e6, t1 = (now - p.started) / 1e6;
  if (final) { const dur = Math.max(1e-6, (now - p.started) / 1e6); term(h, `[${p.role === 'server' ? 'SRV' : 'CLI'}]  0.0-${dur.toFixed(1)} sec  ${fmtBytes(p.bytes)}  ${fmtRate((p.bytes * 8) / dur)}${p.udp && p.role === 'server' ? `  lost ${p.udpLost}/${p.udpRx + p.udpLost} (${p.udpRx + p.udpLost ? ((100 * p.udpLost) / (p.udpRx + p.udpLost)).toFixed(1) : '0'}%)` : ''}`); if (p.role === 'client') finishClient(st, h, p); return; }
  const dt = Math.max(1e-6, (now - p.lastReport) / 1e6); term(h, `[${p.role === 'server' ? 'SRV' : 'CLI'}] ${t0.toFixed(1)}-${t1.toFixed(1)} sec  ${fmtBytes(p.bytesInterval)}  ${fmtRate((p.bytesInterval * 8) / dt)}`); p.lastReport = now; p.bytesInterval = 0;
}
function finishClient(st: EngineState, h: HostState, p: IperfProc) { void st; if (p.done) return; p.done = true; if (p.udp) delete h.sockets[p.sock]; delete h.procs[p.pid]; }
export function iperfNotify(st: EngineState, h: HostState, p: IperfProc, ev: ProcEvent) {
  if (p.role === 'client') {
    const s = h.sockets[p.sock];
    if (ev.type === 'tcpConnected' && s?.proto === 'tcp') { p.started = st.time; p.lastReport = st.time; term(h, `[CLI] local ${u32ToIp(s.localIp!)} port ${s.localPort} connected with ${u32ToIp(s.remoteIp!)} port ${s.remotePort} (MSS ${Math.min(s.mss, s.peerMss)})`); fill(st, h, p, s); timer(st, h.id, 1 * SEC, `proc:${p.pid}:report`); timer(st, h.id, 100 * MS, `proc:${p.pid}:check`); }
    else if (ev.type === 'tcpWritable' && s?.proto === 'tcp') fill(st, h, p, s);
    else if (ev.type === 'tcpError') { term(h, `[CLI] error: ${ev.err}`); finishClient(st, h, p); }
    else if (ev.type === 'tcpFinAcked' || ev.type === 'tcpClosed') { if (p.finishedAt !== null && !p.done) report(st, h, p, true); }
    else if (ev.type === 'icmpError' && p.udp) { term(h, `[CLI] ICMP error from ${u32ToIp(ev.from)} type ${ev.icmpType} code ${ev.code}`); }
    return;
  }
  // server
  if (ev.type === 'tcpAccept') { const ls = h.sockets[p.sock]; if (ls?.proto !== 'tcp') return; const c = tcpAccept(h, ls); if (!c) return; p.clientSock = c.id; p.bytes = 0; p.bytesInterval = 0; p.started = st.time; p.lastReport = st.time; term(h, `[SRV] connection from ${u32ToIp(c.remoteIp!)} port ${c.remotePort}`); timer(st, h.id, 1 * SEC, `proc:${p.pid}:report`); if (p.readRateBps) timer(st, h.id, 50 * MS, `proc:${p.pid}:slowread`); }
  else if (ev.type === 'tcpReadable' && ev.sock === p.clientSock) { const c = h.sockets[ev.sock]; if (c?.proto !== 'tcp') return; if (p.readRateBps) return; const d = tcpRecv(st, h, c); p.bytes += d.length; p.bytesInterval += d.length; }
  else if (ev.type === 'tcpEof' && ev.sock === p.clientSock) { const c = h.sockets[ev.sock]; if (c?.proto === 'tcp') { const d = tcpRecv(st, h, c); p.bytes += d.length; p.bytesInterval += d.length; tcpClose(st, h, c); } const dur = Math.max(1e-6, (st.time - p.started) / 1e6); term(h, `[SRV]  0.0-${dur.toFixed(1)} sec  ${fmtBytes(p.bytes)}  ${fmtRate((p.bytes * 8) / dur)}`); p.clientSock = null; }
  else if (ev.type === 'udpRx') { const s = h.sockets[p.sock] as UdpSocket | undefined; if (!s) return; for (const dg of s.rx.splice(0)) { if (dg.data[0] === 0xff && dg.data.length === 16) { report(st, h, p, true); p.udpLastSeq = -1; p.bytes = 0; p.udpLost = 0; p.udpRx = 0; continue; } const seq = ((dg.data[0]! << 24) | (dg.data[1]! << 16) | (dg.data[2]! << 8) | dg.data[3]!) >>> 0; if (p.udpLastSeq < 0) { p.started = dg.t; p.lastReport = dg.t; term(h, `[SRV] datagrams from ${u32ToIp(dg.src)} port ${dg.sport}`); } if (seq > p.udpLastSeq + 1 && p.udpLastSeq >= 0) p.udpLost += seq - p.udpLastSeq - 1; p.udpLastSeq = Math.max(p.udpLastSeq, seq); p.udpRx++; p.bytes += dg.data.length; p.bytesInterval += dg.data.length; } }
}
export function iperfTimer(st: EngineState, h: HostState, p: IperfProc, what: string, _data?: unknown) {
  if (what === 'report') { if (p.done) return; if (p.role === 'client' && p.finishedAt !== null) return; if (p.role === 'server' && p.clientSock === null && !p.udp) return; report(st, h, p, false); timer(st, h.id, 1 * SEC, `proc:${p.pid}:report`); }
  else if (what === 'check') { const s = h.sockets[p.sock]; if (s?.proto === 'tcp' && !p.done) { fill(st, h, p, s); if (p.finishedAt === null) timer(st, h.id, 100 * MS, `proc:${p.pid}:check`); } }
  else if (what === 'udptick') udpTick(st, h, p);
  else if (what === 'slowread') { if (p.clientSock === null || !p.readRateBps) return; const c = h.sockets[p.clientSock]; if (c?.proto !== 'tcp') return; const n = Math.floor(p.readRateBps * 0.05); const d = tcpRecv(st, h, c, n); p.bytes += d.length; p.bytesInterval += d.length; timer(st, h.id, 50 * MS, `proc:${p.pid}:slowread`); }
}
export function iperfKill(st: EngineState, h: HostState, p: IperfProc) {
  p.done = true; const s = h.sockets[p.sock]; if (s?.proto === 'tcp') { if (s.state === 'LISTEN') delete h.sockets[s.id]; else tcpClose(st, h, s); } else if (s) delete h.sockets[s.id];
  if (p.clientSock !== null) { const c = h.sockets[p.clientSock]; if (c?.proto === 'tcp') tcpClose(st, h, c); }
  delete h.procs[p.pid];
}
